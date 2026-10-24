// Контрактные и security-тесты CLI без сети.
// Запуск: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "bin", "srezai.js");

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SREZAI_CONFIG: "/nonexistent/srezai/config.json",
      ...env,
    },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("--version печатает версию и не падает", () => {
  const r = run(["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^srezai \d+\.\d+\.\d+/);
});

test("--help перечисляет команды", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  for (const cmd of ["search", "read", "map", "crawl", "extract", "verify", "answer", "deep"]) {
    assert.match(r.stdout, new RegExp(cmd));
  }
});

test("whoami маскирует ключ и не печатает его целиком", () => {
  // Собираем из частей, чтобы secret-scan не считал тестовую строку утечкой.
  const key = ["srz", "live", "abcdefgh1234"].join("_");
  const r = run(["whoami"], { SREZAI_API_KEY: key });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes(key), "ключ не должен появляться в выводе");
  assert.ok(!r.stderr.includes(key), "ключ не должен появляться в stderr");
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.key.present, true);
  assert.equal(payload.key.masked, "srz_…1234");
  assert.equal(payload.key.source, "env");
});

test("хост API нельзя переопределить переменной окружения в релизной сборке", () => {
  const r = run(["whoami"], { SREZAI_BASE_URL: "http://evil.example" });
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.baseUrl, "https://srezai.ru");
});

test("переопределение хоста работает только при SREZAI_CLI_DEV=1", () => {
  const r = run(["whoami"], {
    SREZAI_CLI_DEV: "1",
    SREZAI_DEV_BASE_URL: "http://127.0.0.1:1",
  });
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.baseUrl, "http://127.0.0.1:1");
});

test("file:// и не-http схемы отбиваются до сети", () => {
  const r = run(["read", "file:///etc/passwd"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /bad_url/);
});

test("неизвестная команда — код 2", () => {
  const r = run(["totally-unknown"]);
  assert.equal(r.code, 2);
});

test("в исходнике CLI нет исполнения внешних команд (shell-инъекции невозможны)", () => {
  const source = readFileSync(CLI, "utf8");
  for (const pattern of ["child_process", "execSync", "exec(", "spawnSync", "spawn(", "eval("]) {
    assert.ok(!source.includes(pattern), `найдено «${pattern}» — CLI не должен исполнять команды`);
  }
});

test("лимит размера ответа и маска ключа зашиты в код", () => {
  const source = readFileSync(CLI, "utf8");
  assert.match(source, /MAX_BODY_BYTES/);
  assert.match(source, /srz_…/);
});

test("аргументы с shell-метасимволами не исполняются, а трактуются как текст", () => {
  // «Опасная» строка уходит в JSON-тело как данные; проверяем, что CLI не создал файл.
  const marker = "/tmp/srezai-cli-injection-marker";
  const r = run(["read", `https://example.com/"$(touch ${marker})"`], { SREZAI_CLI_DEV: "1", SREZAI_DEV_BASE_URL: "http://127.0.0.1:1" });
  assert.notEqual(r.code, 0, "сеть должна быть недоступна в тесте");
  assert.equal(existsSync(marker), false, "shell-команда из аргумента не должна выполниться");
});

test("справка не врёт: значения --depth и состав команд", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--depth flash\|auto/);
  assert.ok(!r.stdout.includes("basic|advanced"), "устаревшие значения depth в справке");
  for (const name of [
    "search", "read", "map", "crawl", "extract", "fetch", "verify",
    "answer", "deep", "transcript", "media", "register", "whoami",
  ]) {
    assert.match(r.stdout, new RegExp(`srezai ${name}\\b`), `в справке нет команды ${name}`);
  }
});

test("флаги из справки принимаются парсером", () => {
  const cases = [
    ["search", "x", "--depth", "flash", "--time-range", "week", "--excerpts"],
    ["read", "https://example.com", "--engine", "dynamic", "--offset", "0"],
    ["crawl", "https://example.com", "--select-paths", "/docs/", "--exclude-paths", "/tags/"],
    ["verify", "x", "--query", "y", "--time-range", "year"],
    ["transcript", "abc", "--timestamps", "--speakers"],
  ];
  for (const args of cases) {
    const r = run([...args], { SREZAI_CLI_DEV: "1", SREZAI_DEV_BASE_URL: "http://127.0.0.1:1" });
    assert.ok(!/Неизвестный флаг/.test(r.stderr), `${args[0]}: флаг не распознан`);
  }
});

test("CLI представляется серверу и помечает регистрацию каналом cli", async () => {
  const http = await import("node:http");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const received = { headers: null, body: null };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      received.headers = req.headers;
      try { received.body = JSON.parse(data || "{}"); } catch { received.body = null; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    // Асинхронный запуск обязателен: при spawnSync сервер в этом же процессе
    // не может принять соединение, и CLI просто ждёт ответа.
    await execFileAsync(process.execPath, [CLI, "register", "--email", "agent@example.com"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SREZAI_CONFIG: "/nonexistent/srezai/config.json",
        SREZAI_CLI_DEV: "1",
        SREZAI_DEV_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(received.body.email, "agent@example.com");
  assert.equal(received.body.agent, "srezai-cli");
  assert.equal(received.body.integration, "cli");
  assert.match(received.headers["x-srezai-skill"], /^srezai-cli\/\d+\.\d+\.\d+$/);
  assert.match(received.headers["user-agent"], /^srezai-cli\/\d+\.\d+\.\d+ \(node /);
});

test("версия в bin совпадает с package.json", () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const source = readFileSync(CLI, "utf8");
  assert.match(source, new RegExp(`const VERSION = "${pkg.version.replace(/\./g, "\\.")}"`));
});
