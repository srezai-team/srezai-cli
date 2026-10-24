#!/usr/bin/env node
// CLI srezai — веб-доступ для агентов без раздувания контекста.
//
// Зачем он есть: MCP-сервер отдаёт 13 описаний инструментов (≈10,8 тыс. токенов
// с инструкциями) в каждом запросе. Скилл с CLI держит в контексте только короткое
// описание, а этот файл агент запускает как обычную команду.
//
// Правила безопасности (см. deploy/security/CLI-THREAT-MODEL-2026-10-24.md):
//   1. Хост API зашит: в релизной сборке его нельзя переопределить.
//   2. Ключ берётся только из SREZAI_API_KEY или ~/.config/srezai/config.json (0600)
//      и НИКОГДА не печатается целиком — только маска srz_…abcd.
//   3. CLI не читает локальные файлы и не исполняет ничего из аргументов:
//      всё уходит на сервер, где уже работают SSRF-защита, права и лимиты.
//   4. Ретраи только на 429/503, максимум 3 попытки, с уважением Retry-After.
//   5. Ноль зависимостей: подпроцессов, eval и сетевых хостов, кроме API, нет.

import process from "node:process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.1.0";

// 🔴 В релизной сборке фиксирован. Переопределение — только для тестов самого CLI,
// и только при явном SREZAI_CLI_DEV=1: без него переменная игнорируется.
const BASE_URL = "https://srezai.ru";
const DEV_MODE = process.env.SREZAI_CLI_DEV === "1";
const API_BASE =
  DEV_MODE && process.env.SREZAI_DEV_BASE_URL
    ? process.env.SREZAI_DEV_BASE_URL.replace(/\/+$/, "")
    : BASE_URL;

const EXIT = { ok: 0, usage: 2, auth: 3, api: 4, net: 5 };
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

class CliError extends Error {
  constructor(message, { code = "error", exit = EXIT.api } = {}) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function maskKey(key) {
  if (!key) return "(нет)";
  const tail = key.slice(-4);
  return key.length <= 8 ? "srz_…" : `srz_…${tail}`;
}

function configPath() {
  if (process.env.SREZAI_CONFIG) return process.env.SREZAI_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "srezai", "config.json");
}

function readConfig() {
  const path = configPath();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { path, config: null };
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      process.stderr.write(
        `[srezai] предупреждение: ${path} доступен не только владельцу (${mode.toString(8)}). Сделайте chmod 600.\n`,
      );
    }
    return { path, config: JSON.parse(raw) };
  } catch {
    throw new CliError(`Не удалось прочитать конфиг ${path}: повреждённый JSON.`, {
      code: "bad_config",
      exit: EXIT.usage,
    });
  }
}

function resolveKey() {
  const envKey = (process.env.SREZAI_API_KEY || "").trim();
  if (envKey) return { key: envKey, source: "env" };
  const { path, config } = readConfig();
  const key = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  return key ? { key, source: path } : { key: null, source: null };
}

function verboseLog(flags, message) {
  if (flags.verbose) process.stderr.write(`[srezai] ${message}\n`);
}

function describeApiError(status, payload) {
  const err = payload?.error ?? payload;
  const code = err?.code ?? payload?.code ?? `http_${status}`;
  const ru = err?.detail?.ru ?? payload?.detail?.ru ?? err?.message ?? "";
  const hint = {
    400: "Проверьте параметры команды.",
    401: "Ключ отсутствует, отозван или неверен. Получите новый: srezai register --email …",
    402: "Не хватает средств на балансе. Пополните на https://srezai.ru/dashboard.",
    403: "Доступ запрещён для этого ключа (лимит тарифа или закрытый инструмент).",
    404: "Маршрут API не найден — возможно, версия CLI устарела.",
    429: "Исчерпан лимит запросов. Подождите и повторите: CLI не обходит лимиты.",
    503: "Сервис временно недоступен. Повторите позже.",
  }[status];
  return { code, message: [hint, ru].filter(Boolean).join(" ") || `HTTP ${status}` };
}

async function request(method, path, body, flags = {}) {
  const url = API_BASE + path;
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const { key } = resolveKey();
  if (key) headers.authorization = `Bearer ${key}`;

  const timeoutMs = Number(flags.timeout) > 0 ? Number(flags.timeout) * 1000 : DEFAULT_TIMEOUT_MS;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const reason = e?.name === "TimeoutError" ? "истёк таймаут" : e?.message || "сеть недоступна";
      throw new CliError(`Не удалось связаться с ${API_BASE}: ${reason}.`, {
        code: "network",
        exit: EXIT.net,
      });
    }

    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new CliError("Ответ больше допустимого предела (20 МБ). Уменьшите объём запроса.", {
        code: "response_too_large",
        exit: EXIT.api,
      });
    }
    const json = tryParse(text);

    if (res.ok) {
      verboseLog(flags, `${method} ${path} → ${res.status}`);
      return json ?? { text };
    }

    if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after")) || attempt * 2;
      const waitSec = Math.min(Math.max(retryAfter, 1), 30);
      verboseLog(flags, `HTTP ${res.status}, повтор через ${waitSec} с (попытка ${attempt + 1}/${maxAttempts})`);
      await sleep(waitSec * 1000);
      continue;
    }

    const described = describeApiError(res.status, json);
    verboseLog(flags, `${method} ${path} → ${res.status} ${described.code}`);
    throw new CliError(described.message, {
      code: described.code,
      exit: res.status === 401 || res.status === 403 ? EXIT.auth : EXIT.api,
    });
  }
  throw new CliError("Не удалось выполнить запрос после 3 попыток.", { code: "retries_exhausted" });
}

// ---------- разбор аргументов ----------

function parseArgv(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const eq = raw.indexOf("=");
      if (eq >= 0) {
        setFlag(flags, raw.slice(0, eq), raw.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        setFlag(flags, raw, argv[i + 1]);
        i += 1;
      } else {
        setFlag(flags, raw, true);
      }
    } else if (token.startsWith("-") && token !== "-") {
      if (token === "-h") flags.help = true;
      else if (token === "-v") flags.version = true;
      else throw new CliError(`Неизвестный флаг ${token}. Справка: srezai --help`, { exit: EXIT.usage });
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "verbose",
  "pretty",
  "human",
  "fresh",
  "excerpts",
  "include-raw-content",
  "include-subdomains",
  "speakers",
  "timestamps",
  "safe",
  "webmcp",
  "async",
]);

function setFlag(flags, name, value) {
  if (BOOLEAN_FLAGS.has(name)) {
    flags[name] = value === true || value === "true" || value === "1";
    return;
  }
  flags[name] = value;
}

// ---------- сборка тел запросов ----------

function normalizeUrl(value, flagName = "url") {
  const raw = String(value).trim();
  if (!/^https?:\/\//i.test(raw)) {
    throw new CliError(`${flagName}: нужен адрес http(s), получено «${raw.slice(0, 60)}».`, {
      code: "bad_url",
      exit: EXIT.usage,
    });
  }
  return raw;
}

function numberFlag(flags, name) {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) {
    throw new CliError(`--${name}: ожидается число.`, { code: "bad_flag", exit: EXIT.usage });
  }
  return value;
}

function commaList(flags, name) {
  if (flags[name] === undefined) return undefined;
  const parts = String(flags[name])
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function compact(object) {
  const out = {};
  for (const [k, v] of Object.entries(object)) if (v !== undefined) out[k] = v;
  return out;
}

// ---------- команды ----------

const COMMANDS = {
  search: {
    usage: 'srezai search "запрос" [--num 10] [--depth basic|advanced] [--category general|news|it|science]',
    summary: "Поиск в вебе. Возвращает ссылки, сниппеты и оценки релевантности.",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError('Нужен запрос: srezai search "…"', { exit: EXIT.usage });
      const body = compact({
        query: positionals.join(" "),
        num: numberFlag(flags, "num"),
        depth: flags.depth,
        category: flags.category,
        language: flags.language,
        timeRange: flags["time-range"],
        includeDomains: commaList(flags, "include-domains"),
        excludeDomains: commaList(flags, "exclude-domains"),
        excerpts: flags.excerpts,
        includeRawContent: flags["include-raw-content"],
        chunksPerSource: numberFlag(flags, "chunks-per-source"),
        publishedAfter: flags["published-after"],
        publishedBefore: flags["published-before"],
        engines: commaList(flags, "engines"),
        safesearch: flags.safesearch,
        pageno: numberFlag(flags, "pageno"),
      });
      return request("POST", "/api/v1/search", body, flags);
    },
  },

  read: {
    usage: "srezai read <url> [<url> …] [--max-chars 4000] [--offset 0] [--fresh]",
    summary: "Текст страницы чистым Markdown. Поддерживает PDF/Office, окна через --offset.",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError("Нужен адрес: srezai read https://…", { exit: EXIT.usage });
      const body = compact({
        urls: positionals.map((u) => normalizeUrl(u)),
        maxChars: numberFlag(flags, "max-chars"),
        offset: numberFlag(flags, "offset"),
        engine: flags.engine,
        fresh: flags.fresh,
        webmcp: flags.webmcp,
      });
      return request("POST", "/api/v1/read", body, flags);
    },
  },

  map: {
    usage: "srezai map <url> [--limit 50] [--search подстрока] [--intent «цель»]",
    summary: "Карта адресов сайта (только URL, без чтения страниц).",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError("Нужен адрес: srezai map https://…", { exit: EXIT.usage });
      const body = compact({
        url: normalizeUrl(positionals[0]),
        limit: numberFlag(flags, "limit"),
        search: flags.search,
        selectPaths: commaList(flags, "select-paths"),
        excludePaths: commaList(flags, "exclude-paths"),
        intent: flags.intent,
        includeSubdomains: flags["include-subdomains"],
      });
      return request("POST", "/api/v1/map", body, flags);
    },
  },

  crawl: {
    usage: "srezai crawl <url> [--limit 5] [--search слово] [--select-paths a,b]",
    summary: "Карта плюс чтение страниц раздела; 1 кредит за страницу.",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError("Нужен адрес: srezai crawl https://…", { exit: EXIT.usage });
      const body = compact({
        url: normalizeUrl(positionals[0]),
        limit: numberFlag(flags, "limit"),
        search: flags.search,
        selectPaths: commaList(flags, "select-paths"),
        excludePaths: commaList(flags, "exclude-paths"),
        intent: flags.intent,
        includeSubdomains: flags["include-subdomains"],
      });
      return request("POST", "/api/v1/crawl", body, flags);
    },
  },

  extract: {
    usage: 'srezai extract <url> [<url> …] [--schema \'{"title":"string"}\'] [--instruction "…"]',
    summary: "Извлечение по JSON-схеме: в контекст приходят только запрошенные поля.",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError("Нужен адрес: srezai extract https://…", { exit: EXIT.usage });
      let schema;
      if (flags.schema !== undefined) {
        schema = typeof flags.schema === "string" ? tryParse(flags.schema) : flags.schema;
        if (!schema || typeof schema !== "object") {
          throw new CliError("--schema: ожидается JSON-объект в кавычках.", {
            code: "bad_flag",
            exit: EXIT.usage,
          });
        }
      }
      const body = compact({
        urls: positionals.map((u) => normalizeUrl(u)),
        schema,
        instruction: flags.instruction,
        engine: flags.engine,
      });
      return request("POST", "/api/v1/extract", body, flags);
    },
  },

  fetch: {
    usage: "srezai fetch <url> [--max-chars 4000]",
    summary: "Скриншот страницы в браузере (для вёрстки), текст прикладывается.",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError("Нужен адрес: srezai fetch https://…", { exit: EXIT.usage });
      const body = compact({
        url: normalizeUrl(positionals[0]),
        maxChars: numberFlag(flags, "max-chars"),
      });
      return request("POST", "/api/v1/fetch", body, flags);
    },
  },

  verify: {
    usage: 'srezai verify "утверждение" [--language ru] [--max-sources 4]',
    summary: "Проверка утверждения: вердикт и дословные цитаты с источниками.",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError('Нужно утверждение: srezai verify "…"', { exit: EXIT.usage });
      const body = compact({
        claim: positionals.join(" "),
        language: flags.language,
        maxSources: numberFlag(flags, "max-sources"),
        query: flags.query,
        timeRange: flags["time-range"],
      });
      return request("POST", "/api/v1/verify", body, flags);
    },
  },

  answer: {
    usage: 'srezai answer "вопрос" [--depth fast|balanced|deep] [--language ru]',
    summary: "Готовый ответ по источникам (RAG-цикл), с оценками релевантности.",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError('Нужен вопрос: srezai answer "…"', { exit: EXIT.usage });
      const body = compact({
        query: positionals.join(" "),
        depth: flags.depth,
        language: flags.language,
      });
      return request("POST", "/api/v1/answer", body, flags);
    },
  },

  deep: {
    usage: 'srezai deep "тема" [--async] | srezai deep status <ticket>',
    summary: "Глубокое исследование: синхронно (до ~150 с) или с талоном и опросом.",
    run(positionals, flags) {
      if (positionals[0] === "status") {
        if (!positionals[1]) throw new CliError("Нужен талон: srezai deep status <ticket>", { exit: EXIT.usage });
        return request("GET", `/api/v1/deep?ticket=${encodeURIComponent(positionals[1])}`, undefined, {
          ...flags,
          timeout: flags.timeout || 120,
        });
      }
      if (!positionals.length) throw new CliError('Нужна тема: srezai deep "…"', { exit: EXIT.usage });
      const body = compact({
        query: positionals.join(" "),
        depth: flags.depth,
        language: flags.language,
        async: flags.async || undefined,
      });
      return request("POST", "/api/v1/deep", body, {
        ...flags,
        timeout: flags.timeout || 600,
      });
    },
  },

  transcript: {
    usage: "srezai transcript <video-id|url> [<…>] [--languages ru,en] [--from 0] [--to 600]",
    summary: "Субтитры YouTube: текст с таймкодами, до 200 тыс. символов в версии 0.4+.",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError("Нужен id или адрес видео: srezai transcript …", { exit: EXIT.usage });
      const body = compact({
        videos: positionals,
        languages: commaList(flags, "languages"),
        from: numberFlag(flags, "from"),
        to: numberFlag(flags, "to"),
        maxChars: numberFlag(flags, "max-chars"),
        speakers: flags.speakers,
        timestamps: flags.timestamps,
      });
      return request("POST", "/api/v1/transcript", body, flags);
    },
  },

  media: {
    usage: 'srezai media "запрос" [--num 12] [--safe] [--time-range week]',
    summary: "Поиск картинок: прямые ссылки и метаданные.",
    run(positionals, flags) {
      if (!positionals.length) throw new CliError('Нужен запрос: srezai media "…"', { exit: EXIT.usage });
      const body = compact({
        query: positionals.join(" "),
        num: numberFlag(flags, "num"),
        safe: flags.safe,
        timeRange: flags["time-range"],
      });
      return request("POST", "/api/v1/media", body, flags);
    },
  },

  register: {
    usage: "srezai register --email you@example.com",
    summary: "Быстрая регистрация агентского аккаунта: ключ и ссылка на оплату без входа.",
    run(positionals, flags) {
      const email = flags.email;
      if (!email) throw new CliError("Нужен --email: srezai register --email …", { exit: EXIT.usage });
      return request("POST", "/api/v1/auth/quick-register", { email }, flags);
    },
  },

  whoami: {
    usage: "srezai whoami",
    summary: "Локальная проверка: есть ли ключ, откуда он взят, какой хост API.",
    run(_positionals, flags) {
      const { key, source } = resolveKey();
      const payload = {
        version: VERSION,
        baseUrl: API_BASE,
        key: { present: Boolean(key), masked: maskKey(key), source },
        configPath: configPath(),
      };
      return Promise.resolve(payload);
    },
  },
};
COMMANDS["auth"] = COMMANDS.whoami;

function printHelp() {
  const lines = [
    `srezai ${VERSION} — веб-доступ для агентов (${BASE_URL})`,
    "",
    "Команды:",
    ...Object.values(COMMANDS)
      .filter((c) => c.usage && c.usage !== "srezai whoami")
      .map((c) => `  ${c.usage}\n      ${c.summary}`),
    "  srezai whoami",
    "      Локальная проверка ключа и адреса API.",
    "",
    "Общие флаги: --pretty (JSON с отступами), --human (текст вместо JSON),",
    "             --verbose (диагностика в stderr), --timeout <сек>",
    "",
    "Ключ: SREZAI_API_KEY или ~/.config/srezai/config.json (chmod 600).",
    "Без ключа работает пробный режим — лимит на IP, без регистрации.",
    "CLI никогда не печатает ключ целиком и ходит только на " + BASE_URL + ".",
    "",
    "Справка по команде: srezai <команда> --help",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

function printCommandHelp(name) {
  const command = COMMANDS[name];
  if (!command) return false;
  process.stdout.write(`${command.usage}\n\n${command.summary}\n`);
  return true;
}

function outputResult(result, flags) {
  if (flags.human) {
    const text = result?.answer ?? result?.text ?? result?.content ?? result?.summary;
    if (typeof text === "string" && text.trim()) {
      process.stdout.write(text.trim() + "\n");
      return;
    }
  }
  process.stdout.write((flags.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)) + "\n");
}

async function main(argv) {
  const [commandName, ...rest] = argv;
  const { flags, positionals } = parseArgv(rest);

  if (!commandName || commandName === "--help" || commandName === "help" || flags.help) {
    if (commandName && commandName !== "help" && commandName !== "--help" && printCommandHelp(commandName)) return EXIT.ok;
    printHelp();
    return EXIT.ok;
  }
  if (commandName === "--version" || commandName === "version" || flags.version) {
    process.stdout.write(`srezai ${VERSION}\n`);
    return EXIT.ok;
  }

  const command = COMMANDS[commandName];
  if (!command) {
    process.stderr.write(`Неизвестная команда «${commandName}». Справка: srezai --help\n`);
    return EXIT.usage;
  }
  if (flags.help) {
    printCommandHelp(commandName);
    return EXIT.ok;
  }

  const result = await command.run(positionals, flags);
  outputResult(result, flags);
  return EXIT.ok;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    const exit = error instanceof CliError ? error.exit : EXIT.api;
    const code = error instanceof CliError ? error.code : "internal";
    process.stderr.write(`srezai: ошибка [${code}]: ${error.message}\n`);
    process.exit(exit);
  });
