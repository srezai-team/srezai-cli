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
| `extract` | `POST /api/v1/extract` | urls[], schema (объект, не строка), instruction, engine |
| `fetch` | `POST /api/v1/fetch` | url, maxChars |
| `verify` | `POST /api/v1/verify` | claim, language, maxSources, query, timeRange |
| `answer` | `POST /api/v1/answer` | query, depth, language |
| `deep` | `POST /api/v1/deep` | query, depth, language, async (асинхронно → талон 202) |
| `deep status` | `GET /api/v1/deep?ticket=N` | только талон; `?id=` не принимается |
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

## Фактические формы ответов (проверено на проде 24.10.2026)

Пробный режим без ключа, по одному вызову на команду:

- `search` → `{ query, results[], infoboxes, answers, suggestions, enginesQueried,
  producedBy, attempts, relaxedQuery, degraded, freshness }`.
  Элемент `results[]`: `title, url, content, engine, category, source, score,
  publishedDate, excerpt, chunks, rawContent, relevance`.
- `read` → `{ pages[], meta }`, где `pages[]`: `url, title, markdown, truncated,
  engine, meta: { tookMs, totalChars, offset, nextOffset, hasMore, tokensApprox,
  cached, attempts, httpStatus }`.
  🔴 Продолжение чтения: брать `pages[0].meta.nextOffset` (не считать самому) и
  передавать в `--offset`. В MCP это правило уже описано; в CLI работает так же.
- `whoami` — локально, сети не касается.

Остальные команды проверяются в R4 тем же способом (дешёвые вызовы, лимит
пробного режима 25/сутки на IP).

## Проверено на проде 24.10.2026 (QA-аккаунт, ключ)

| Команда | Форма ответа (верхний уровень) |
|---|---|
| `search` | `query, results[], infoboxes, answers, suggestions, enginesQueried, producedBy` |
| `read` | `pages[] (url, title, markdown, truncated, engine, meta.nextOffset), meta` |
| `transcript` | `results[], errors, skipped, credits, meta` |
| `map` | `url, origin, total, returned, pages[], sections, source, sitemaps` |
| `crawl` | `url, origin, map, pages[], skipped, credits, meta` |
| `extract` | `pages[] (url, title, data, missing[], truncated, meta), meta` |
| `fetch` | `url, title, screenshotUrl, degraded, markdown, truncated, meta` |
| `media` | `query, images[], unresponsiveEngines, meta` |
| `answer` | `answer, sources[], confidence, pagesRead, tookMs` |
| `verify` | `claim, verdict, confidence, incomplete, agreeing, disagreeing, evidence, caveats` |
| `deep` (async) | `202` + талон; опрос `GET ?ticket=N` → `stage, status, progress, result, error, id` |

Найденные при проверке правки (вошли в 0.1.0):
- `extract` сначала отправлял `schema` строкой — сервер отвечал `bad_request`;
  теперь отправляется разобранный объект (`validateSchema` принимает и
  сокращённую форму, и полный JSON Schema).
- `deep status` ходил на `?id=` — сервер принимает только `?ticket=N`.
- коды ошибок с верхнего уровня (`payload.code`) теперь попадают в маску ошибки,
  а не превращаются в `http_400`.
