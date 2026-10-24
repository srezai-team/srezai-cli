# Changelog

## 0.1.0 — 2026-10-24

Первый релиз.

- 12 команд: `search`, `read`, `map`, `crawl`, `extract`, `fetch`, `verify`,
  `answer`, `deep`, `transcript`, `media`, `register` + `whoami`.
- Ноль зависимостей, Node ≥18.
- Ключ из `SREZAI_API_KEY` или `~/.config/srezai/config.json` (0600), маска в выводе.
- Фиксированный хост API; переопределение только для тестов при `SREZAI_CLI_DEV=1`.
- Ретраи 429/503 с `Retry-After`, лимит ответа 20 МБ.
- Публикация по тегу через npm trusted publishing (OIDC, provenance).
