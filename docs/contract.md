# Контракт CLI ↔ REST API (черновик, 24.10.2026)

Источник: обработчики `src/app/api/v1/*/route.ts` в репозитории srezai.ru.
Поля тела — camelCase, как в REST. В R4 контракт закрепляется тестами против
прода (дешёвые read-only вызовы), после чего таблица становится обязательной.

| Команда | Метод и путь | Поля тела |
|---|---|---|
| `search` | `POST /api/v1/search` | query, num, depth, category, language, timeRange, includeDomains, excludeDomains, excerpts, includeRawContent, chunksPerSource, publishedAfter, publishedBefore, engines, safesearch, pageno |
| `read` | `POST /api/v1/read` | urls[] (или url), maxChars, offset, engine, fresh, webmcp |
| `map` | `POST /api/v1/map` | url, limit, search, selectPaths[], excludePaths[], intent, includeSubdomains |
| `crawl` | `POST /api/v1/crawl` | url, limit, search, selectPaths[], excludePaths[], intent, includeSubdomains |
| `extract` | `POST /api/v1/extract` | urls[], schema, instruction, engine |
| `fetch` | `POST /api/v1/fetch` | url, maxChars |
| `verify` | `POST /api/v1/verify` | claim, language, maxSources, query, timeRange |
| `answer` | `POST /api/v1/answer` | query, depth, language |
| `deep` | `POST /api/v1/deep` | query, depth, language |
| `deep status` | `GET /api/v1/deep?id=` | — |
| `transcript` | `POST /api/v1/transcript` | videos[], languages[], from, to, maxChars, speakers, timestamps |
| `media` | `POST /api/v1/media` | query, num, safe, timeRange |
| `register` | `POST /api/v1/auth/quick-register` | email |
| `whoami` | — (локально) | — |

## Коды ошибок и exit codes

| HTTP | Код в теле | Exit | Что делает CLI |
|---|---|---|---|
| 200 | — | 0 | печатает JSON в stdout |
| 400 | `bad_request` | 4 | текст ошибки с подсказкой |
| 401 | `unauthorized` | 3 | «получите/проверьте ключ» |
| 402 | `insufficient_funds` | 4 | «пополните баланс», ссылка |
| 403 | `forbidden` / лимит | 3 | «доступ запрещён/лимит тарифа» |
| 429 | `rate_limited` | 4 | 3 попытки с Retry-After, затем ошибка |
| 503 | `service_unavailable` | 4 | 3 попытки, затем ошибка |
| сеть/таймаут | `network` | 5 | без ретраев, если это не 429/503 |

Ошибки печатаются в stderr в формате `srezai: ошибка [код]: текст`, чтобы агент
видел и код, и человеческое объяснение.
