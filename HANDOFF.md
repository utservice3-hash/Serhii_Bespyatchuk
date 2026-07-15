# HANDOFF — шар сповіщень та AI-Telegram

Путівник для нового розробника/оператора (в т.ч. через Claude Code) саме по
**сповіщеннях** і **AI**. Це індекс поверх коду; повна бізнес-логіка — у
`LOGIC.md`.

## Start here (свіжа сесія Claude)

1. Прочитай **`CLAUDE.md`** (авто-завантажується) — ключові ID, доступи, деплой.
2. Потрібні деталі логіки — відповідний розділ **`LOGIC.md`**.
3. Цей файл — карта шару сповіщень+AI (куди що шлеться, хто тригерить).
4. **Робоча гілка:** `claude/uts-bot-logic-review-gir8c8`. **Деплой-гілка:**
   `claude/magical-gates-qt9749` (Render автодеплоїть звідси).
5. Перед пушем завжди: `python3 -c "import app"` (ловить forward-reference —
   пастка, через яку Render мовчки лишає стару версію).

## 1. Доступи / секрети (що має бути)

Рантайм-секрети живуть у **Render env** (сервіс `my-bot-8nib`), НЕ в репо:

| Env | Призначення |
|---|---|
| `TG_TOKEN` | Telegram-бот (@utsuser01_bot) |
| `ANTHROPIC_API_KEY` | Claude (AI-аналіз) |
| `GROQ_API_KEY` | Groq Whisper (транскрибація дзвінків) |
| `KOMMO_TOKEN` / `KOMMO_BASE` | Kommo CRM API |
| `GOOGLE_SHEETS_ID` (або `SPREADSHEET_ID`) | основна таблиця (Реєстр і ін.) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | креди сервіс-акаунта Google Sheets |
| `TG_API_ID` / `TG_API_HASH` / `TG_SESSION` / `ELOGIST_SOURCE_CHAT_ID` | userbot eLogist (Pyrogram) |
| `MANAGER_MAP` | (опц.) JSON-оверрайд мапи менеджер→@telegram |
| `KOMMO_MAX_RPS` / `KOMMO_MAX_BACKOFF` / `KOMMO_LEAD_CACHE_TTL` / `KOMMO_SYNC_PAUSED` | тюнінг throttle/кешу/паузи Kommo |

Доступи для передачі: **GitHub** (колаборатор у `utservice3-hash/Serhii_Bespyatchuk`,
push), **Render** (команда сервісу — там усі env вище), **Google Sheets**
(поділитися таблицями за потреби).

⚠️ **Безпека:** `CLAUDE.md` містить живий `KOMMO_TOKEN` відкритим — після
передачі варто лишити токен лише в Render env (прибрати з доку) або ротувати.

## 2. Шар Telegram — `notifier.py`

Хардкод-роути (константи модуля):
- `TG_CHAT_ID_RNK` спільна РНК-група; `TG_THREAD_ID_RNK="51"` трекінг;
  `..._RNK_CLOSED="294"`, `..._QUALITY="1571"`, `..._NONTARGET="310"`.
- `TG_CHAT_ID_RPK` / `..._RPK="3"` — РПК нові ліди.
- `TG_CHAT_ID_ADMIN_STATS` / `"6"` — денне адмін-зведення першого дотику.
- `TG_CHAT_ID_ADS` — група звітів по рекламі.
- **`_RNK_TEAM_ROUTES`** — per-team РНК: Михальчевська `-1002925017503`
  (closed `2`, nontarget `1550`, tracking `6892`); Безпам'ятний
  `-1002258732695` (closed `5341`, nontarget `13446`, tracking `13459`).
- **`_RPK_TEAM_ROUTES`** — Шаврова `-1003239776842/688`, Дмитрук
  `-1002370766882/6825`, Яцик `-1002363672295/2354`.
- **`_FIRST_TOUCH_ROUTES`** — Михальчевська `.../7689`, Безпам'ятний `.../14232`.
- **`_DEFAULT_MANAGER_MAP`** — ~45 kommo_id → @telegram (для тегів; env
  `MANAGER_MAP` оверрайдить). Хелпер `get_manager_tag(id)`.

Публічні функції надсилання:
| Функція | Куди |
|---|---|
| `send_to_rnk(text)` | спільна РНК, тред 51 |
| `send_to_rpk(text)` | РПК, тред 3 |
| `send_to_rnk_closed(text, team)` | closed-not-realized → team closed-тред (fallback 294) |
| `send_to_nontarget(text, team)` | не-цільові → team nontarget (fallback 310) |
| `send_to_quality(text)` | тривожний ризик → тред 1571 |
| `send_to_first_touch(text, team)` | перший дотик → team тред |
| `send_to_admin_stats(text)` | денне адмін-зведення |
| `send_to_rnk_tracking / send_to_all_rnk_tracking / send_to_team_tracking(text, team)` | робочий трекінг (РНК/РПК) |
| `send_unassigned_tracked(text)` → refs | нерозібрані: шле в 51 + усі team-треки, **повертає refs** |
| `edit_tracked(refs, text)` / `delete_tracked(refs)` | редагувати/видалити раніше надіслане (без спаму) |
| `send_message(text, with_stats_buttons)` | основний чат (`TG_CHAT_ID/THREAD_ID`) |
| `send_ad_report(text)` / `send_ad_report_file(name, bytes, caption)` | звіти по рекламі |
| `send_raw(text, chat_id, thread_id)` | довільний чат/тред |
Хелпери: `get_manager_tag`, `get_kommo_id_by_username`, `set_webhook`, `test_bot`.

## 3. Бізнес-логіка сповіщень — `app.py`

| Потік | Функція | Тригер | Шле через |
|---|---|---|---|
| Нова заявка лідогена | `_handle_new_lead` | webhook статус→`NEW_FROM_LIDOGEN` (дедуп 300с) | `send_to_team_tracking` |
| Взято в роботу | `_handle_taken`, `_mark_lead_taken` | webhook | `edit_tracked` + `send_to_team_group` |
| Нерозібрані (скан) | `_scan_unassigned_leads`, `_check_unassigned_leads` | scheduler 15хв | `send_unassigned_tracked` + `edit_tracked` (15/30/45хв) |
| Нерозібрані (вебхук) | `_handle_unassigned` | webhook | `send_unassigned_tracked` |
| Застряглі | `_check_stale_qualification_leads` | scheduler 1год | `send_to_team_group` |
| Перший дотик | `_handle_first_touch` | webhook (дзвінок, РНК, ≥40с) | `send_to_first_touch` |
| Зведення 1-го дотику | `_send_first_touch_admin_report` | scheduler 18:00 | `send_to_admin_stats` |
| Закрито-не-реалізовано (QC) | `_handle_closed_not_realized` | webhook статус→143 (**лише РНК**, ігнор «По місту» / вже-повернуто) | `send_to_rnk_closed` (лише на поверненні) |
| Не-цільові | `_check_non_target_lead` | webhook статус→143 | `send_to_nontarget` (лише на поверненні) |
| Дубль без ID | `_check_duplicate_reference` | webhook (дубль) | `send_to_team_group` |
| RNK-дзвінки | `_handle_call`, `_process_rnk_deal_call` | webhook note | `send_to_rnk` + `send_to_quality` (RISK) |
| RNK-звіти | `_send_rnk_ai_report` (16:50), `_send_rnk_daily_reminder` (17:00) | scheduler | `send_to_rnk` |
| План-звіти | `_send_daily_plan_report` (18:00), `_send_month_end_report`, `_check_plan_completion`, `_check_overdue_leads` (5хв) | scheduler/webhook | `send_message` / plan-тред `175862` |
| Ad-звіт | `_send_weekly_ad_report` | scheduler Пт 17:00 | `send_ad_report` + `..._file` |
| Ringostat | `ringostat_webhook` | POST | `send_to_team_tracking` (SIP→менеджер: `_sip_to_manager_id`, мапа `SIP_MAP`) |

Диспетчер: `webhook` (`/webhook`) → `_parse_statuses/_parse_responsible_changes/_parse_notes`
→ `_process_status_change` → хендлери вище. Здоров'я вебхука:
`_check_webhook_health` (scheduler 20хв).

## 4. AI-шар

**`ai_analyzer.py`** (модель `claude-haiku-4-5-20251001`, Anthropic API):
- `analyze_closed_deal(deal, notes, calls, contact_summary)` — QC-вердикт
  (CLOSURE/RULE/CATEGORY/NEXTSTEP) по повній картині. Викл.: `_handle_closed_not_realized`.
- `analyze_deal_calls(calls, manager, lead_name)` — уся історія дзвінків, RISK.
- `analyze_first_touch(transcript, ...)` → dict (about_transport / price_voiced /
  objections_handled / weakness / reco). Викл.: `_handle_first_touch`.
- `check_target_lead(transcripts, ...)` — валідація «не цільового». Викл.: `_check_non_target_lead`.
- `analyze_team_deals(team, deals)` — денний тімлід-розбір. Викл.: `_send_rnk_ai_report`.

**`transcriber.py`** — `transcribe_call(record_url)`: Groq Whisper
`whisper-large-v3-turbo`, мова `uk`. Викл.: `_gather_deal_context`,
`_check_non_target_lead`, `_process_rnk_deal_call`, `_handle_first_touch`.

## 5. Планувальник (`app.py`, `scheduler.add_job`)

`_check_webhook_health` 20хв · `_check_overdue_leads` 5хв ·
`_check_unassigned_leads` 15хв · `_check_stale_qualification_leads` 1год ·
`_write_daily_snapshot` 23:55 · `_send_daily_plan_report` 18:00 ·
`_send_month_end_report` 1год (лише ост. день) · `_send_rnk_ai_report` 16:50 ·
`_send_rnk_daily_reminder` 17:00 · `_send_weekly_ad_report` Пт 17:00 ·
`_refresh_plans_from_sheet` 06:00 (+старт) · `_send_first_touch_admin_report` 18:00.
Усі — таймзона `Europe/Kyiv`. Джоба МАЄ бути додана ПІСЛЯ визначення функції.

## 6. Діагностичні ендпоінти (read-only/тести)

`/health`, `/recent-webhooks`, `/recent-tg-updates`, `/sheet-link`,
`/first-touch-report?days=N`, `/debug-first-touch?lead_id=`,
`/debug-closed-verdict?lead_id=`, `/test-first-touch-threads`,
`/test-admin-stats`, `/test-ai`, `/test-non-target`, `/test-call-analysis`,
`/scan-now`, `/send-ad-report`, `/refresh-plans`, `/check-webhook-health`,
`/debug-ad-campaign-fields`, `/debug-ad-spend-sheet`. Повний перелік — у коді
(`@app.route`).

## 7. Деплой і пастки

- Деплой = **push у `claude/magical-gates-qt9749`** → Render автодеплой.
  Робота — в `claude/uts-bot-logic-review-gir8c8`, потім fast-forward у деплой.
- **Перед пушем:** `python3 -c "import app"` (forward-reference пастка).
- **Kommo API:** тверда стеля **2 req/s** + адаптивний backoff на 429/403;
  кеш `get_lead`; kill-switch `KOMMO_SYNC_PAUSED=1` (миттєва пауза без деплою).
  Ліміт Kommo ~7 req/s спільний з UI/іншими інтеграціями — не сканувати масово.
- `Procfile`: gunicorn `--workers 1` (throttle глобальний саме тому).

## 8. Відкриті питання (де зупинились)

- **`ad_leads`**: «Реклама Кількість лідів» історично бралась із **рекламного
  кабінету** (`ad_budget_daily.conversions`), не CRM (CRM недораховує через
  utm-атрибуцію, див. `has_utm_campaign`, поля `481997/2098331/2098327`).
  Потрібно підключити `conversions` з рекламного листа (авто).
- **Ретро-конверсія першого дотику** (ціну озвучено vs ні): методологія готова
  (1 батч-запит по статусах), але потрібна ДОЗРІЛА когорта (перший дотик
  1-2 міс тому); аркуш «Перший дотик» накопичує це сам.
- **Дубль-нагадування** (`_check_duplicate_reference`) — вирішити, чи лишати
  для РПК (зараз лишається).
- **Скріншоти переписок** (vision, Claude Haiku підтримує) — Фаза 2: навчити
  бота тягнути файли з Kommo Files API → у vision-запит.
