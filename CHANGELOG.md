# Changelog

## Не выпущено

- `setup skills` — навык `srezai-cli` ставится в `~/.agents/skills` и связывается
  симлинками с Claude Code, Codex, Cursor, Windsurf, OpenCode, Gemini CLI;
  lock-файл `~/.agents/.skill-lock.json`, `--list` и `--remove`.
- `setup defaults` / `--undo` — выключает встроенный веб-поиск Claude Code
  (`permissions.deny`) и Codex (`web_search = "disabled"`) и возвращает как было.
  Резервная копия перед правкой, сохранение комментариев в JSONC, правка только
  установленных агентов.
- Навык `skills/srezai-cli/` (SKILL.md + rules) входит в пакет.
- 6 новых тестов (всего 20): dry-run, идемпотентность, откат, JSONC-комментарии,
  Codex-секции, установка/удаление навыка.

## 0.1.0 — 2026-10-24

Первый релиз.

- 12 команд: `search`, `read`, `map`, `crawl`, `extract`, `fetch`, `verify`,
  `answer`, `deep`, `transcript`, `media`, `register` + `whoami`.
- Ноль зависимостей, Node ≥18.
- Ключ из `SREZAI_API_KEY` или `~/.config/srezai/config.json` (0600), маска в выводе.
- Фиксированный хост API; переопределение только для тестов при `SREZAI_CLI_DEV=1`.
- Ретраи 429/503 с `Retry-After`, лимит ответа 20 МБ.
- Публикация по тегу через npm trusted publishing (OIDC, provenance); повторный
  запуск через `workflow_dispatch`, npm на раннере поднимается до ^11.5.1.
- Каждая команда представляется серверу заголовками `X-Srezai-Skill: srezai-cli/<версия>`
  и `User-Agent` — по ним видно, что запрос пришёл из CLI (для замера воронки).
- `register` помечает аккаунт каналом `srezai-cli` (`agent` + `integration` в
  quick-register), поэтому регистрации из CLI видны в отчётах отдельно.
- Справка синхронизирована с обработчиками: `--depth flash|auto`, флаги map/crawl/
  extract/fetch/verify/transcript; 12 тестов, включая статические проверки
  безопасности и точность справки.
