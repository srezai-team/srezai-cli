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
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  // Представляемся серверу: по X-Srezai-Skill в журнале видно, что запрос пришёл
  // из CLI, а не из чужой обёртки (колонку client пишет MCP-транспорт; для REST
  // заголовок безвреден и понадобится, когда её начнут писать и REST-роуты).
  const headers = {
    accept: "application/json",
    "user-agent": `srezai-cli/${VERSION} (node ${process.version}; ${process.platform} ${process.arch})`,
    "x-srezai-skill": `srezai-cli/${VERSION}`,
  };
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
  "list",
  "remove",
  "undo",
  "dry-run",
  "force",
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

// ---------- setup: навык для агента и переключение веб-провайдера ----------
//
// Исключение из правила «CLI не читает локальные файлы»: эти две команды по
// явному запросу человека правят ЕГО ЖЕ конфиги агентов (~/.claude, ~/.codex) и
// каталог навыков (~/.agents). Пути фиксированы, содержимое наружу не уходит,
// любая правка делается с резервной копией, а при сомнении отменяется целиком.

const SETUP_AGENT_TARGETS = [
  { name: "claude-code", label: "Claude Code", skillsDir: ".claude/skills", detectDir: ".claude" },
  { name: "codex", label: "Codex", skillsDir: ".codex/skills", detectDir: ".codex" },
  { name: "cursor", label: "Cursor", skillsDir: ".cursor/skills", detectDir: ".cursor" },
  { name: "windsurf", label: "Windsurf", skillsDir: ".codeium/windsurf/skills", detectDir: ".codeium/windsurf" },
  { name: "opencode", label: "OpenCode", skillsDir: ".config/opencode/skills", detectDir: ".config/opencode" },
  { name: "gemini-cli", label: "Gemini CLI", skillsDir: ".gemini/skills", detectDir: ".gemini" },
];
const SETUP_CANONICAL = ".agents/skills";
const SETUP_LOCK = ".agents/.skill-lock.json";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_TOOLS = ["WebSearch", "WebFetch"];
const CODEX_LINE = 'web_search = "disabled"';

function setupHome(flags) {
  const override = flags.home ? String(flags.home) : process.env.SREZAI_CLI_HOME;
  return override && override.trim() ? resolve(override) : homedir();
}

// JSONC: комментарии заменяем пробелами, длина строки не меняется — позиции из
// «очищенной» строки годятся для исходной, комментарии в файле остаются.
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += text[i + 1] ?? ""; i += 1; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue; }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") { out += " "; i += 1; }
      i -= 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < text.length) { out += "  "; i += 1; }
      continue;
    }
    out += ch;
  }
  return out;
}

function jsonFindKeyValueStart(stripped, key) {
  const needle = `"${key}"`;
  let from = 0;
  for (;;) {
    const keyPos = stripped.indexOf(needle, from);
    if (keyPos === -1) return -1;
    let i = keyPos + needle.length;
    while (i < stripped.length && /\s/.test(stripped[i])) i += 1;
    if (stripped[i] === ":") {
      i += 1;
      while (i < stripped.length && /\s/.test(stripped[i])) i += 1;
      return i;
    }
    from = keyPos + needle.length;
  }
}

function jsonMatchBracket(text, openIndex) {
  const open = text[openIndex];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function jsonValueEnd(text, start) {
  const ch = text[start];
  if (ch === "{" || ch === "[") return jsonMatchBracket(text, start) + 1;
  if (ch === '"') {
    for (let i = start + 1; i < text.length; i += 1) {
      if (text[i] === "\\") { i += 1; continue; }
      if (text[i] === '"') return i + 1;
    }
    return -1;
  }
  let i = start;
  while (i < text.length && !/[,}\]\n]/.test(text[i])) i += 1;
  return i;
}

function jsonInsertAfterBrace(text, braceIndex, key, valueJson) {
  return `${text.slice(0, braceIndex + 1)}\n    "${key}": ${valueJson},${text.slice(braceIndex + 1)}`;
}

function jsonVerify(text, expected) {
  try {
    return JSON.stringify(JSON.parse(stripJsonComments(text))) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function setupBackup(file) {
  if (!existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(file, `${file}.srezai-backup-${stamp}`);
}

function planClaudeDefaults(home, undo) {
  const file = join(home, ".claude", "settings.json");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  const text = existing ?? "{\n}\n";
  const stripped = stripJsonComments(text);
  let config;
  try {
    config = JSON.parse(stripped);
  } catch {
    return { file, skipped: true, reason: "settings.json не разбирается как JSON — не трогаем" };
  }
  const permissions = config.permissions && typeof config.permissions === "object" ? config.permissions : {};
  const deny = Array.isArray(permissions.deny) ? permissions.deny.filter((x) => typeof x === "string") : [];
  const denySet = new Set(deny);
  const nextDeny = undo
    ? deny.filter((tool) => !CLAUDE_TOOLS.includes(tool))
    : [...deny, ...CLAUDE_TOOLS.filter((tool) => !denySet.has(tool))];
  const changed = JSON.stringify(nextDeny) !== JSON.stringify(deny);
  if (!changed) return { file, changed: false, message: undo ? "уже включено" : "уже выключено" };

  const nextConfig = { ...config, permissions: { ...permissions, deny: nextDeny } };
  let nextText;
  if (!(stripJsonComments(text) !== text)) {
    nextText = `${JSON.stringify(nextConfig, null, 2)}\n`;
  } else {
    const permissionsStart = jsonFindKeyValueStart(stripped, "permissions");
    if (permissionsStart === -1) {
      const rootBrace = stripped.search(/\{/);
      nextText = jsonInsertAfterBrace(text, rootBrace, "permissions", JSON.stringify({ deny: nextDeny }));
    } else {
      const permissionsClose = jsonMatchBracket(stripped, permissionsStart);
      const denyStart = jsonFindKeyValueStart(stripped, "deny");
      const denyInside = denyStart > permissionsStart && denyStart < permissionsClose;
      if (denyInside) {
        const denyEnd = jsonValueEnd(stripped, denyStart);
        nextText = text.slice(0, denyStart) + JSON.stringify(nextDeny) + text.slice(denyEnd);
      } else {
        nextText = jsonInsertAfterBrace(text, permissionsStart, "deny", JSON.stringify(nextDeny));
      }
    }
    if (!jsonVerify(nextText, nextConfig)) {
      return { file, skipped: true, reason: "не удалось аккуратно поправить JSON с комментариями — правка отменена" };
    }
  }
  return { file, changed: true, text: nextText, message: undo ? "включим встроенный поиск" : "выключим встроенный поиск" };
}

function planCodexDefaults(home, undo) {
  const file = join(home, ".codex", "config.toml");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const nextLines = [...lines];
  let lineIndex = -1;
  for (let i = 0; i < rootEnd; i += 1) {
    if (/^\s*web_search\s*=/.test(lines[i])) { lineIndex = i; break; }
  }
  let changed = false;
  if (undo) {
    if (lineIndex !== -1 && /^web_search\s*=\s*["']disabled["']\s*(#.*)?$/.test(lines[lineIndex].trim())) {
      nextLines.splice(lineIndex, 1);
      changed = true;
    }
  } else if (lineIndex === -1) {
    nextLines.splice(rootEnd, 0, CODEX_LINE);
    changed = true;
  } else if (lines[lineIndex].trim() !== CODEX_LINE) {
    nextLines[lineIndex] = CODEX_LINE;
    changed = true;
  }
  return { file, changed, text: nextLines.join("\n"), message: changed ? (undo ? "включим встроенный поиск" : "выключим встроенный поиск") : undo ? "уже включено" : "уже выключено" };
}

function applySetupPlan(plan, dryRun) {
  if (plan.skipped || !plan.changed) return plan;
  if (!dryRun) {
    mkdirSync(dirname(plan.file), { recursive: true });
    setupBackup(plan.file);
    writeFileSync(plan.file, plan.text, "utf8");
  }
  return plan;
}

function setupAgents(home, name) {
  const wanted = String(name || "all").toLowerCase();
  if (wanted === "all") {
    return SETUP_AGENT_TARGETS.filter((agent) => existsSync(join(home, agent.detectDir)));
  }
  const found = SETUP_AGENT_TARGETS.find((agent) => agent.name === wanted);
  if (!found) {
    throw new CliError(`Неизвестный агент «${name}». Известны: ${SETUP_AGENT_TARGETS.map((a) => a.name).join(", ")}, all.`, { exit: EXIT.usage });
  }
  return [found];
}

function setupReadLock(home) {
  const file = join(home, SETUP_LOCK);
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return { version: data.version ?? 1, skills: data.skills ?? {} };
  } catch {
    return { version: 1, skills: {} };
  }
}

function setupDiscoverSkills(sourceDir) {
  if (!existsSync(sourceDir)) throw new CliError(`Каталог навыков не найден: ${sourceDir}`, { exit: EXIT.usage });
  return readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(sourceDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function setupCopyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) setupCopyDir(src, dst);
    else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
    else copyFileSync(src, dst);
  }
}

function setupLinkSkill(home, agent, skillName, canonicalDir, dryRun, force) {
  const linkPath = join(home, agent.skillsDir, skillName);
  const target = relative(dirname(linkPath), join(canonicalDir, skillName));
  let existing = null;
  try {
    existing = lstatSync(linkPath);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      if (readlinkSync(linkPath) === target) return { agent: agent.name, status: "already" };
      if (!force) return { agent: agent.name, status: "skipped", reason: "на месте ссылки чужой файл" };
      if (!dryRun) unlinkSync(linkPath);
    } else if (!force) {
      return { agent: agent.name, status: "skipped", reason: "на месте ссылки настоящий файл (--force перезапишет)" };
    } else if (!dryRun) {
      rmSync(linkPath, { recursive: true, force: true });
    }
  }
  if (!dryRun) {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath);
  }
  return { agent: agent.name, status: "linked" };
}

function setupSkills(home, flags, dryRun) {
  const canonicalDir = join(home, SETUP_CANONICAL);
  const lock = setupReadLock(home);

  if (flags.list) {
    return {
      canonicalDir,
      detectedAgents: setupAgents(home, "all").map((agent) => agent.name),
      skills: Object.entries(lock.skills).map(([name, info]) => ({ name, source: info.source, agents: info.agents ?? [] })),
      text: Object.keys(lock.skills).length
        ? Object.entries(lock.skills).map(([name, info]) => `${name} — ${info.source} → ${(info.agents ?? []).join(", ") || "без ссылок"}`).join("\n")
        : `Навыков srezai нет (канон: ${canonicalDir}).`,
    };
  }

  if (flags.remove) {
    const removed = [];
    for (const [name, info] of Object.entries(lock.skills)) {
      for (const agentName of info.agents ?? []) {
        const agent = SETUP_AGENT_TARGETS.find((item) => item.name === agentName);
        if (!agent) continue;
        const linkPath = join(home, agent.skillsDir, name);
        try {
          if (lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath).includes(".agents")) {
            if (!dryRun) unlinkSync(linkPath);
            removed.push(`${agentName}/${name}`);
          }
        } catch {
          // ссылки уже нет — норм
        }
      }
      const skillDir = join(canonicalDir, name);
      if (existsSync(skillDir)) {
        if (!dryRun) rmSync(skillDir, { recursive: true, force: true });
        removed.push(name);
      }
    }
    if (!dryRun) rmSync(join(home, SETUP_LOCK), { force: true });
    return { removed, text: removed.length ? `Убрано: ${removed.join(", ")}` : "Убирать нечего." };
  }

  const source = flags.source ? resolve(String(flags.source)) : join(PACKAGE_ROOT, "skills");
  const skills = setupDiscoverSkills(source);
  if (!skills.length) throw new CliError(`В ${source} нет каталогов с SKILL.md.`, { exit: EXIT.usage });
  if (!dryRun) mkdirSync(canonicalDir, { recursive: true });
  const agents = setupAgents(home, flags.agent);
  const installed = [];
  for (const name of skills) {
    const dest = join(canonicalDir, name);
    const known = Boolean(lock.skills[name]);
    if (existsSync(dest) && !known && !flags.force) {
      installed.push({ name, status: "skipped", reason: "уже есть, но поставлен не нами (--force перезапишет)" });
      continue;
    }
    if (!dryRun) {
      rmSync(dest, { recursive: true, force: true });
      setupCopyDir(join(source, name), dest);
    }
    const links = agents.map((agent) => setupLinkSkill(home, agent, name, canonicalDir, dryRun, flags.force));
    lock.skills[name] = { source: join(source, name), installedAt: new Date().toISOString(), agents: agents.map((agent) => agent.name) };
    installed.push({ name, status: "installed", links });
  }
  if (!dryRun) {
    mkdirSync(dirname(join(home, SETUP_LOCK)), { recursive: true });
    writeFileSync(join(home, SETUP_LOCK), `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), skills: lock.skills }, null, 2)}\n`, "utf8");
  }
  return {
    canonicalDir,
    agents: agents.map((agent) => agent.name),
    installed,
    text: installed.map((item) => item.status === "skipped" ? `${item.name}: пропущен — ${item.reason}` : `${item.name}: ${dryRun ? "будет поставлен" : "поставлен"} в ${canonicalDir}`).join("\n"),
  };
}

function setupDefaults(home, flags, dryRun) {
  const undo = Boolean(flags.undo);
  const wanted = String(flags.agent || "all");
  // «all» — только установленные агенты: создавать настройки тому, кого нет на
  // машине, бессмысленно. Явный --agent действует всегда.
  const detected = [
    { name: "claude-code", dir: ".claude" },
    { name: "codex", dir: ".codex" },
  ].filter((target) => existsSync(join(home, target.dir)));
  const names = wanted === "all" ? detected.map((target) => target.name) : [wanted];
  if (wanted === "all" && !names.length) {
    return { undo, dryRun, results: [], text: "Не нашли установленных Claude Code или Codex (нет каталогов ~/.claude и ~/.codex). Если агент в нестандартном месте: srezai setup defaults --agent claude-code" };
  }
  const results = [];
  for (const name of names) {
    const normalized = name === "claude" ? "claude-code" : name;
    if (normalized === "claude-code") {
      const plan = planClaudeDefaults(home, undo);
      const applied = applySetupPlan(plan, dryRun);
      results.push({ agent: "Claude Code", file: plan.file, changed: Boolean(applied.changed), skipped: Boolean(plan.skipped), reason: plan.reason, message: plan.message });
    } else if (normalized === "codex") {
      const plan = planCodexDefaults(home, undo);
      const applied = applySetupPlan(plan, dryRun);
      results.push({ agent: "Codex", file: plan.file, changed: Boolean(applied.changed), skipped: Boolean(plan.skipped), reason: plan.reason, message: plan.message });
    } else {
      throw new CliError(`setup defaults умеет claude-code, codex и all; получено «${name}».`, { exit: EXIT.usage });
    }
  }
  return {
    undo,
    dryRun,
    results,
    text: results.map((item) => item.skipped
      ? `${item.agent}: пропущено (${item.reason})`
      : `${item.agent}: ${item.changed ? (dryRun ? "будет изменено" : "готово") : "без изменений"} — ${item.file}`).join("\n"),
  };
}

// ---------- команды ----------

const COMMANDS = {
  search: {
    usage: 'srezai search "запрос" [--num 10] [--depth flash|auto] [--time-range week] [--category general|news|it|science] [--excerpts]',
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
    usage: "srezai read <url> [<url> …] [--max-chars 4000] [--offset 0] [--fresh] [--engine dynamic|stealth]",
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
    usage: "srezai map <url> [--limit 50] [--search подстрока] [--select-paths a,b] [--intent «цель»]",
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
    usage: "srezai crawl <url> [--limit 5] [--search слово] [--select-paths a,b] [--exclude-paths a,b] [--intent «цель»]",
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
    usage: 'srezai extract <url> [<url> …] [--schema \'{"title":"string"}\'] [--instruction "…"] [--engine dynamic|stealth]',
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
    usage: 'srezai verify "утверждение" [--language ru] [--max-sources 4] [--query «поиск»] [--time-range year]',
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
    usage: "srezai transcript <video-id|url> [<…>] [--languages ru,en] [--from 0] [--to 600] [--timestamps] [--speakers]",
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
      // agent/integration — для воронки: аккаунт помечается как созданный из CLI,
      // поэтому в отчётах видно, сколько регистраций дал именно этот канал.
      return request(
        "POST",
        "/api/v1/auth/quick-register",
        { email, agent: "srezai-cli", integration: "cli" },
        flags,
      );
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
COMMANDS.setup = {
  usage: "srezai setup skills|defaults [--agent <имя>] [--dry-run] [--undo|--remove|--list]",
  summary:
    "Установить навык srezai в ~/.agents/skills и связать с агентами (skills) или направить веб-работу агента в srezai, выключив встроенный поиск (defaults). Правки конфигов — только по этой команде, с резервной копией и откатом.",
  run(positionals, flags) {
    const sub = positionals[0];
    if (!sub || sub === "help") {
      return Promise.resolve({ text: "srezai setup skills|defaults [--agent <имя>] [--dry-run] [--undo|--remove|--list]" });
    }
    const home = setupHome(flags);
    const dryRun = Boolean(flags["dry-run"]);
    if (sub === "skills") return Promise.resolve(setupSkills(home, flags, dryRun));
    if (sub === "defaults") return Promise.resolve(setupDefaults(home, flags, dryRun));
    throw new CliError(`setup ${sub}: неизвестно. Доступно: skills, defaults.`, { exit: EXIT.usage });
  },
};

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
