# srezai-cli 0.1.0

Консольная обёртка для веб-доступа srezai: 12 команд, **ноль зависимостей**,
один файл, работает на Node 18+.

```bash
npm install -g srezai-cli
srezai search "запрос" --num 5
srezai read https://example.com
srezai deep "вопрос" --async
```

- Пробный режим без ключа: `search`, `read`, `transcript` — 25 запросов в сутки
  с одного адреса (burst 5 за 10 секунд).
- Регистрация прямо из консоли: `srezai register` выдаёт 20 стартовых кредитов и
  ссылку на оплату.
- Понятные коды выхода и повторные попытки на 429/503, ограничение ответа 20 МБ,
  фиксированный адрес API.
- Атрибуция запросов: `X-Srezai-Skill: srezai-cli/<версия>`, чтобы в статистике
  было видно, что запрос пришёл из консоли.
- Публикация через npm trusted publishing (OIDC), с provenance.

Документация: README.md, docs/contract.md. Компаньон — скиллы `srezai-*`
(см. репозиторий `srezai-team/srezai-web-search-pro-skill`).
