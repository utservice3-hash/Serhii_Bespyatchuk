# UTS Dashboard — довідка проєкту

Аналітичний дашборд для відділу продажів логістичних послуг (CRM = Kommo).
Стек: Node/Express + Postgres (backend), React + Vite + recharts (frontend).

## Деплой (продакшн)

Relay PHP: `POST https://dashboard.uts.ua/relay-d7bb7c59.php`
header `X-Relay-Token: d7bb7c59...` (див. нижче), form `cmd=<shell>`.
Cwd: `/home/evraziat/uts.ua/dashboard`. Завжди префікс `export PATH=/usr/local/node26/bin:$PATH`.
⚠️ Токен світився в скріншотах — варто ротувати.

Стандартний цикл:
```
git pull origin claude/friendly-galileo-8pijhl
cd backend && npm run build && npm run migrate   # migrate лише якщо змінювалась schema.sql
cd ../frontend && npm run build && cp -r dist/* ../
pkill -f 'node.*dashboard/backend/dist/index'    # рестарт лише при зміні backend; exit 15 норм
curl https://dashboard.uts.ua/api/health          # {"ok":true}
```
Гілка розробки: `claude/friendly-galileo-8pijhl`. При застряглому білді на проді: `git reset --hard origin/<branch>`.
Bash-tool падає по таймауту на `git pull && npm run build` (>2хв) — серверна команда все одно доходить; перевіряй результат окремо.

## Ключові бізнес-правила

- **Фінанси (отримані кошти) = `funnel_stage='paid'`** = «Оплата отримана» + «Успішно реалізовано». Скрізь однаково.
- **Завершене перевезення** (для реактивації) історично = лише статус 142, але УЗГОДЖЕНО: теж рахуємо як `paid` (обидва статуси).
- **Воронка продажів** = лише пайплайни «Перевозки повний цикл»: `8921932` (New) + `155304` (старий). Кваліфікацію/Реактивацію у воронку НЕ додаємо.
- **Лідогенерація**: пайплайни Продзвін `8921936`/`7337048` + Реактивація `8921948`. Команда лідогенів — назва містить «лідоген».
- **Деактивований у CRM менеджер** → зникає з усіх списків дашборду (`m.is_active`), логін деактивується автоматично.

## Kommo

- Воронка «Реактивація» = `8921948`; етап «Автододані (UTSAI)» = `108224932`.
- Custom-поля лідів: utm_source `481993`, «Лидогенератор» `2098037`, «Источник клиента» `2098035`.
- API лише читання + точкові write (`kommoWrite`). DELETE лідів = 405 (недоступно) → нейтралізувати статусом 143.
- Фетч історії: тягнути по id (`fetchLeadsByIds`/`fetchCompaniesByIds`/`fetchContactsByIds`), НЕ всі записи (обриває з'єднання, OOM).

## Джоби (backend/src/jobs)

- `syncKommo` — кожні 15хв (угоди, менеджери, провіжн юзерів).
- `syncReceivables` — кожні 30хв (Google Sheet дебіторки).
- `syncNews` — щодня 08:00 (RSS logistics-ukraine.com + usm.media → 3 новини).
- `backfillClientKeys --client-by-id` / `--source-only` — бекфіл історії по id.
- `reactivateLeads --write --limit=N` — створення лідів реактивації (ідемпотентний, тільки компанії з телефоном, 3+ перевезень, лапсуючі >3міс, round-robin).

## Реактивація — критерії

Компанія (не фізособа) + є телефон + 3+ оплачених перевезень + остання оплата >3 міс тому + немає відкритої угоди в Реактивації/Продзвіні. Дедуп — по живому Kommo (наша БД лагає свіжі ліди).

## Розділи дашборду (frontend/src/pages/Dashboard.tsx, секції по `section`)

overview · statistics · teams · managers · loyalty · receivables · leadgen · tasks · messenger · news · training · settings.
Нав-групи в `components/Layout.tsx` (`NAV_GROUPS`). Період-фільтр спільний (`dateRange`/`datePreset` + `QuickPeriods`).

## Налаштування

Таблиця `app_settings` (JSON), admin-only API `/api/settings`. Пороги лояльності, вікна, попередження дебіторки.
Керування користувачами: `/api/settings/users` (provision з CRM, reset пароля, тімлід-роль).
