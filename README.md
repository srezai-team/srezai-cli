# srezai-cli — веб-доступ для агентов без раздувания контекста

Одна команда `srezai` для поиска, чтения страниц, карт сайтов, краулинга,
извлечения по JSON-схеме, проверки утверждений, готовых ответов и глубоких
исследований — через API [srezai.ru](https://srezai.ru). Сильное покрытие
русскоязычного веба, PDF и Office, субтитры YouTube.

**Зачем CLI, если есть MCP.** MCP-сервер отдаёт модели описания всех инструментов
в каждом запросе — у srezai это ≈10,8 тыс. токенов. Скилл с CLI держит в контексте
только короткое описание и вызывает команду: типичная задача стоит 0,3–1,5 тыс.
токенов вместо 10,8 тыс. MCP остаётся для клиентов без доступа к консоли
(Claude Desktop, ChatGPT-коннекторы, n8n).

## Установка

```bash
npx srezai-cli --help          # без установки, если пакет уже в npm
npm install -g srezai-cli      # глобально
```

До публикации в npm работает вариант из git:

```bash
npx -y github:srezai-team/srezai-cli search "ИИ в России законы"
```

## Ключ

```bash
export SREZAI_API_KEY=srz_live_…     # рекомендую: ключ не попадает в файлы
```

или файл `~/.config/srezai/config.json` (права 600):

```json
{ "apiKey": "srz_live_…" }
```

Без ключа работает **пробный режим** — лимит на IP, без регистрации. Если лимит
кончился, `srezai register --email you@example.com` создаст агентский аккаунт и
вернёт ключ (показывается один раз) и ссылку на оплату без входа и пароля.

## Быстрые примеры

```bash
srezai search "изменения в законах об ИИ 2026" --num 5
srezai read https://example.com/article --max-chars 4000
srezai read https://example.com/long --offset 4000            # продолжение окна
srezai map https://docs.example.com --search api --limit 30
srezai crawl https://docs.example.com --select-paths /api/ --limit 10
srezai extract https://example.com/card --schema '{"title":"string","price":"number?"}'
srezai verify "Node.js 22 — LTS" --language ru
srezai answer "чем отличается SSE от WebSocket" --depth balanced
srezai deep "сравни Exa и Tavily"            # вернёт id
srezai deep status <id>
srezai transcript https://youtu.be/… --languages ru --timestamps
srezai media "схема метро Москвы" --num 3
```

Формат вывода — компактный JSON (агентам удобно парсить). Флаги `--pretty` —
JSON с отступами, `--human` — текст, если инструмент его возвращает.

## Команды

| Команда | Что делает | Цена |
|---|---|---|
| `search` | поиск в вебе | 1 кредит |
| `read` | текст страницы в Markdown, PDF/Office | 1 кредит за окно |
| `read_urls`-режим | `read` принимает несколько адресов | 1 кредит за страницу |
| `map` | карта адресов сайта | 1 кредит / 10 адресов |
| `crawl` | карта + чтение раздела | 1 кредит за страницу |
| `extract` | извлечение по JSON-схеме | 2 кредита за ссылку |
| `fetch` | скриншот страницы | 3 кредита |
| `verify` | проверка утверждения с цитатами | 8 кредитов |
| `answer` | готовый ответ по источникам | 3 / 5 / 10 |
| `deep` | глубокое исследование | 20 + токены |
| `transcript` | субтитры YouTube | 1 кредит |
| `media` | поиск картинок | 1 кредит |
| `whoami` | локальная проверка ключа и хоста | бесплатно |

1 кредит = 0,10 ₽. Актуальные цены — <https://srezai.ru/pricing>.

## Безопасность

- CLI ходит **только** на `https://srezai.ru`: адрес API зашит в сборке и не
  переопределяется переменными окружения.
- Ключ берётся из `SREZAI_API_KEY` или файла с правами 600 и **никогда** не
  печатается целиком — только маска `srz_…abcd`, в том числе в `--verbose`.
- CLI **не читает локальные файлы** и не исполняет ничего из аргументов:
  страницы скачивает сервер, где работают SSRF-защита, права и лимиты.
- Ретраи только на 429/503, максимум 3 попытки, с учётом `Retry-After`.
- Телеметрии нет; в логи по умолчанию не пишется ничего.
- Ключ украли? Отзовите его в кабинете <https://srezai.ru/dashboard> — это
  действует быстрее минуты.

Подробнее — [SECURITY.md](SECURITY.md).

## Для авторов скиллов

Репозиторий рядом: [srezai-web-search-pro-skill](https://github.com/srezai-team/srezai-web-search-pro-skill) —
набор узких скиллов, которые вызывают этот CLI, и `SKILL.md` с процедурой
«какой инструмент под какую задачу».

## Разработка

```bash
node --test          # тесты без сети
sh scripts/secret-scan.sh
npm pack --dry-run   # проверить состав пакета
```

Публикация — по тегу `v*` через GitHub Actions и npm trusted publishing (OIDC),
без токенов. См. `.github/workflows/release.yml`.

## Лицензия

Apache-2.0.
