# MEMORY — динамічне резюме сесій

> Оновлюється після кожної важливої зміни. Старі записи очищуй регулярно.

---

## Сесія 2026-05-20

### Зроблено
- ✅ Створено репо `utservice3-hash/my-bot` (приватне)
- ✅ Розгорнуто Telegram-бот на VPS DigitalOcean (Amsterdam, `/root/my-bot/`)
- ✅ Налаштовано Git Relay (`cmdrunner.service`) — перевірено командою `echo ready && hostname && uptime`
- ✅ Оновлено system prompt → AI бізнес-асистент для підприємців (українська)
- ✅ Створено `agent_bot.py` з Tool Use: calculate, save_note, list_notes, delete_note, get_datetime, read_url, Vision
- ✅ Нотатки зберігаються окремо на користувача: `notes/{user_id}.json`
- ✅ Додано команду `/notes` в бот
- ✅ `mybot.service` оновлено → запускає `agent_bot.py`
- ✅ Лог підтвердив: `Agent bot started with tools`
- ✅ Встановлено 91 Claude Code Skill (8 пакетів)
- ✅ Налаштовано пам'ять між сесіями (цей файл + CLAUDE.md)

### Стан сервісів на VPS
```
mybot.service      — RUNNING (agent_bot.py)
cmdrunner.service  — RUNNING (Git Relay)
autodeploy.timer   — RUNNING (git pull щохвилини)
```

### Як змінити бота
```python
# 1. Оновити файл через GitHub API (utservice3-hash/my-bot)
# 2. Надіслати через Relay:
{"id": "deploy-X", "cmd": "cd /root/my-bot && git pull && systemctl restart mybot.service"}
# 3. Прочитати cmds/result.json — перевірити логи
```

### Незавершені задачі
- [ ] Підключити репо `my-bot` до Claude.ai → Settings → Connectors → GitHub

---

## Як читати цей файл нової сесії
1. Прочитай `CLAUDE.md` — хто я і мої проєкти
2. Прочитай `MEMORY.md` — що вже зроблено, що в процесі
3. Спитай мене: "Що хочеш зробити сьогодні?"
