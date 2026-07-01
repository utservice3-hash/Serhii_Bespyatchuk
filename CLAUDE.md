# UTS Logistics — Bot Project

## Kommo CRM
- URL: https://utsercice.kommo.com
- API token (env: KOMMO_TOKEN): stored in Render environment variables
- Fresh token example (expires ~2027): see Render env var KOMMO_TOKEN

## Key IDs
- Кваліфікація pipeline: 8921928
- НОВА ЗАЯВКА ВІД ЛІДОГЕНЕРАТОРА status: 69716164
- Лід взятий у роботу status: 69693652
- Перевозки pipeline: 8921932 (тут "ВЗЯТО НА ПРОРАХУНОК" = 69693668, "АВТО ПРАЦЮЄ" = 69716300, "Повернуто АІ Відділ якості (на допрацювання)" = 108361876)
- Дзвінки на мобільні (70419108) — виключений з усіх сповіщень про нерозібрану/застряглу кваліфікацію

## Детальна бізнес-логіка
Повна логіка передачі лідогена, статуси обох пайплайнів, структура листа
"Реєстр" у Google Sheets, логіка сповіщень про нерозібрані/застряглі
ліди, логіка звіту по рекламі і відомі підводні камені Kommo API —
дивись **LOGIC.md** у корені репозиторію. Оновлюй LOGIC.md разом з
кодом, коли змінюється будь-яка з цих логік.

## Render service
- URL: https://my-bot-8nib.onrender.com
- Repo: utservice3-hash/Serhii_Bespyatchuk
- Branch: claude/magical-gates-qt9749

## Telegram
- Chat ID: -1002136093208
- Test topic thread ID: 175180
- Bot: @utsuser01_bot

## Webhooks (Kommo → Render)
- URL: https://my-bot-8nib.onrender.com/webhook
- Events: Статус сделки изменен, Отв-й сделки изменен, Примечание добавлено

## Making Kommo API calls
```python
import requests
TOKEN = "see Render env KOMMO_TOKEN"
headers = {"Authorization": f"Bearer {TOKEN}"}
r = requests.get("https://utsercice.kommo.com/api/v4/leads", headers=headers, params={...})
```

## Current Kommo token (valid until ~2027)
eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6ImVlZWY3NTZjNjg1M2M1NjllOWVkM2I5ZDQ3YmYxYjI5M2RlYzE1YWE3Njk4ZDA0YmMxYzM3YTVhYWMyN2FiNTNiZjExYjcwMDVlOWNkNmY1In0.eyJhdWQiOiIxNzM2ZGE4My1jY2Y1LTRiNjgtOWRmZC1kM2I5OTgyYjc4ODciLCJqdGkiOiJlZWVmNzU2YzY4NTNjNTY5ZTllZDNiOWQ0N2JmMWIyOTNkZWMxNWFhNzY5OGQwNGJjMWMzN2E1YWFjMjdhYjUzYmYxMWI3MDA1ZTljZDZmNSIsImlhdCI6MTc4MTE5MjI2NCwibmJmIjoxNzgxMTkyMjY0LCJleHAiOjE4MDkwNDMyMDAsInN1YiI6IjkwNDkyMyIsImdyYW50X3R5cGUiOiIiLCJhY2NvdW50X2lkIjoxMDg0Nzc5MSwiYmFzZV9kb21haW4iOiJrb21tby5jb20iLCJ2ZXJzaW9uIjoyLCJzY29wZXMiOlsicHVzaF9ub3RpZmljYXRpb25zIiwiZmlsZXMiLCJjcm0iLCJmaWxlc19kZWxldGUiLCJub3RpZmljYXRpb25zIl0sImhhc2hfdXVpZCI6Ijc3OTUyZGU0LTI3NzYtNDA1MS04ZmIyLTFhOTBhYTUyNjFhZSIsImFwaV9kb21haW4iOiJhcGktZy5rb21tby5jb20ifQ.f41nJr3z4rbGk_kXm2Z6bSfQGdVn8gB03SEeu-f0Eiko4gnVMtAKACcJo0-u4TnQBdjgLnGcgzrF-iL29GdflDeOXsUKdIeqbwArGzTve2yq9v3OCLeNJEaBisxdySOajgWVglJq4GZ_6X9JIuzsic1iwXCPR81euSDsd3k6dnv6nIgpLHpBA6T7U6hF7WmURDXKQjm3N9tlE7yMqGyc7O2sCa3MIsqBDYXkFZ9gRRLDmjvLS6S5x-EOf2Q2BF-KxfIvFp-ZHhqu0zUaBAYuMvgBnqQC6EjTNO9OdRRcKZduqNMvjSaH9zGSX-6Kvw--dYxEGu-bjONQVmuYHU1pHw
