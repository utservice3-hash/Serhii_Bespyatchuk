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
- Ролі «Менеджер» (657568) і «Тимлид» (657564) мають гранульовані status_rights; їм додано права edit/view на робочі етапи воронки 8921932 (щоб вести повернуті AI угоди). Створюєш новий етап — не забудь додати права ролям, інакше рухати зможе лише адмін.
- Тестові ліди на видалення вручну (Kommo API без DELETE): 62436429, 62436457, 62436479, 62444415, 62444751

## Детальна бізнес-логіка
Повна логіка передачі лідогена, статуси обох пайплайнів, структура листа
"Реєстр" у Google Sheets, логіка сповіщень про нерозібрані/застряглі
ліди, логіка звіту по рекламі і відомі підводні камені Kommo API —
дивись **LOGIC.md** у корені репозиторію. Оновлюй LOGIC.md разом з
кодом, коли змінюється будь-яка з цих логік.

**Підрахунок «Нова заявка від лідогенератора»:** одна подія = один рядок
в аркуші «Реєстр» (кол. 5 «Час передачі» — дата, кол. 3/4 — менеджер/команда).
Рахуй по цьому аркушу, а НЕ по in-memory `_stats_log`/денному snapshot (вони
гинуть при деплої). Деталі й правила — розділ «Як рахувати» в LOGIC.md.

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

## Kommo token
Токен НЕ зберігається в репо (репозиторій публічний — секрети сюди не пишемо).
Живе значення — лише в **Render env `KOMMO_TOKEN`**. Локально/у скриптах бери
його звідти. Якщо старий токен колись був у цьому файлі — його треба вважати
скомпрометованим і ротувати в Kommo.
