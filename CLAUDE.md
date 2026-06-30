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

- **Отримані кошти = Успішно реалізовано (статус 142, за датою закриття `closed_at_kommo` в періоді) + Оплата отримана (статуси `69716460`/`60412544`, ЗНІМОК поточного етапу, без фільтра дати).** Це ОДНА логіка скрізь: картка «Отримані кошти», byTeam, topManagers, Факт, рейтинг команд.
  - Чому різні бази: «Успішна угода» — фінальний статус (накопичується назавжди, ~37млн за весь час), тому рахуємо лише закриті в періоді. «Оплата отримана» — транзитний етап (угоди проходять далі), тому це знімок «скільки зараз там».
  - Звірка з CRM (червень 2026): успішно за місяць ≈ 670 угод/1.81млн; оплата отримана знімок ≈ 127/0.52млн; разом ≈ 2.33млн. Збігається з колонками CRM.
- **Угоди (KPI «рахунок→реалізовано»)** = `funnel_stage IN ('invoiced','paid')`, за датою створення.
- **Воронка продажів** = лише пайплайни «Перевозки повний цикл»: `8921932` (New) + `155304` (старий).
- **Конверсія** розділена: реклама (`lead_channel='ad'`, тільки google utm) і лідоген (`lead_channel='leadgen'`) — оплачені/ліди по каналу.
- **Нові клієнти** = перша оплата за всю історію припадає на період. **Постійні клієнти** = 2+ оплачених перевезень (lifetime).
- **Лідогенерація**: пайплайни Продзвін `8921936`/`7337048` + Реактивація `8921948`. Команда лідогенів — назва містить «лідоген».
- **Деактивований у CRM менеджер** → зникає з усіх списків (`m.is_active`).
- **Дебіторка ↔ Реактивація**: клієнт у `receivables` (активний боржник) НЕ потрапляє в реактивацію (ні в loyalty sleeping/lost, ні в `reactivateLeads`).
- **План/Факт** — period-aware: План пропорційно ділиться по днях обраного періоду; Факт = отримані кошти за період.
- **funnel_stage values**: `lead_taken`, `quote_requested`, `approved`, `invoiced`, `paid` (`backend/src/db/seedKommoMapping.sql`).

## Kommo

- Воронка «Реактивація» = `8921948`; етап «Автододані (UTSAI)» = `108224932`.
- Custom-поля лідів: utm_source `481993`, «Лидогенератор» `2098037`, «Источник клиента» `2098035`.
- API лише читання + точкові write (`kommoWrite`). DELETE лідів = 405 (недоступно) → нейтралізувати статусом 143.
- Фетч історії: тягнути по id (`fetchLeadsByIds`/`fetchCompaniesByIds`/`fetchContactsByIds`), НЕ всі записи (обриває з'єднання, OOM).

## Джоби (backend/src/jobs)

- `syncKommo` — **кожні 5хв** (угоди, менеджери). ⚠️ Тягне контакти/компанії ЛИШЕ по id угод вікна (`fetchContactsByIds`/`fetchCompaniesByIds`, батчі по 250) — `fetchAllContacts/fetchAllCompanies` OOM-вбивали job (заморозка даних). НЕ повертати fetchAll*.
- `syncReceivables` — кожні 30хв (Google Sheet дебіторки, `TRUNCATE receivables` + insert).
- `syncNews` — щодня 08:00.
- `evaluateKpiTasks` — щодня 07:00: тягне факт із CRM і автозакриває KPI-задачі (план тімліда).
- `reactivateLeads --write --limit=N` — створення лідів реактивації (компанії з телефоном, 3+ перевезень, лапсуючі >3міс, НЕ боржники, round-robin лідогенам).
- Фронт **автооновлюється кожні 5хв** (`refreshNonce` у Dashboard.tsx) — без перезавантаження.

## Реактивація — критерії

Компанія (не фізособа) + є телефон + 3+ оплачених перевезень + остання оплата >3 міс тому + немає відкритої угоди в Реактивації/Продзвіні. Дедуп — по живому Kommo (наша БД лагає свіжі ліди).

## Розділи дашборду (frontend/src/pages/Dashboard.tsx, секції по `section`)

overview · statistics · teams · managers · loyalty · receivables · leadgen · tasks · messenger · news · training · settings.
Нав-групи в `components/Layout.tsx` (`NAV_GROUPS`). Період-фільтр спільний (`dateRange`/`datePreset` + `QuickPeriods`).

## Огляд продажів (картки) — `/dashboard/overview`

Угоди (рахунок→реалізовано) · Отримані кошти (оплата+успішно) · Конверсія реклами · Конверсія лідогену · Середній чек · Нові клієнти (вперше) · Постійні клієнти (2+) · Шкала План/Факт (hover = вклад по командах) · Очікувані оплати (етап invoiced, snapshot, hover = по командах) · Створені угоди (Повний цикл) · Виручка від нових клієнтів · Дебіторка · Виручка від постійних %.
- Кожна картка клікабельна → модалка з 3-міс історією (`monthlyHistory`) + поточний/попередній період + byTeam (для грошей).
- **Попередній період**: для місяця = те саме число поперед. місяця (1–29 червня → 1–29 травня); для тижня/дня — зсув на довжину (`previousRange`).

## Задачник KPI (тиждень/місяць)

Тімлід ставить план менеджеру (`POST /tasks/plan`): метрики `ads_count` (реклама google), `leadgen_count` (РПК), `avg_check`, `conversion`. Реклама/лідоген декомпозуються на денні підзадачі по обраних робочих днях; чек/конверсія — підсумок за період. `evaluateKpiTasks` автозакриває за фактом. Колонки в `tasks`: `task_type, metric, target_value, actual_value, plan_date, period_start/end, parent_id, auto`. Пошук задач — поле зверху фільтрує таблицю.

## Дебіторка-нотатки

`receivable_notes (client_key PK, comment, due_date, ...)` — окремо від `receivables` (бо TRUNCATE при sync). Тімлід/адмін редагує коментар і дату оплати; `PUT /dashboard/receivables/note`.

## Рейтинг команд — `/dashboard/teams`

Виручка (успішно+оплата), угоди, сер.чек, конверсія, дебіторка по командах з місцями. Фільтр періоду.

## Налаштування

Таблиця `app_settings` (JSON), admin-only API `/api/settings`. Пороги лояльності, вікна, попередження дебіторки.
Керування користувачами: `/api/settings/users` (provision з CRM, reset пароля, тімлід-роль). Ручне створення логіна: `POST /api/settings/users`.

## Брендинг

Лого UTS = `frontend/public/favicon.svg` + `components/Logo.tsx` (filled SVG, червоний `#c8102e`). Заголовок вкладки «UTS Dashboard». Папку `frontend` НЕ перейменовувати (на неї завʼязаний деплой).

## Оптимізація витрат (для майбутніх сесій)

Кожне повідомлення ре-обробляє весь діалог. Тому: нова сесія під кожен блок робіт; групувати правки в один меседж; менше скріншотів де досить тексту; тримати цей файл актуальним.
