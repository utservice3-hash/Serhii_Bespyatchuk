# UTS Logistics — Bot Project

## Kommo CRM
- URL: https://utsercice.kommo.com
- API token (env: KOMMO_TOKEN): stored in Render environment variables
- Fresh token example (expires ~2027): see Render env var KOMMO_TOKEN

## Key IDs
- Кваліфікація pipeline: 8921928
- НОВА ЗАЯВКА ВІД ЛІДОГЕНЕРАТОРА status: 69716164
- Лід взятий у роботу status: 69693652

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
Ask the user to provide the token from Render environment or from Kommo API settings.
