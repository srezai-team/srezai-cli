# Установка и проверка srezai-cli

```bash
npm install -g srezai-cli        # или npx srezai-cli --help без установки
srezai whoami                    # версия, хост API, есть ли ключ (ключ маскируется)
srezai search "тест" --num 3     # пробный вызов: работает без ключа
```

Ключ: `srezai register --email you@example.com` — вернёт ключ (показывается один
раз) и ссылку на пополнение; либо `export SREZAI_API_KEY=srz_live_…`, либо файл
`~/.config/srezai/config.json` с правами 600.

`npx srezai-cli setup skills` кладёт этот навык в `~/.agents/skills` и связывает
с найденными агентами, `npx srezai-cli setup defaults` направляет веб-работу
агента в srezai. Откат: `setup defaults --undo`, `setup skills --remove`.
