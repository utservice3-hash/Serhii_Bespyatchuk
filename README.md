# Serhii_Bespyatchuk

Веб-дешборд компанії з даними з Kommo CRM (заміна ручних звітів у Google Таблицях).

## Структура

- `backend/` — Node.js/TypeScript/Express API, синхронізація з Kommo CRM, PostgreSQL
- `frontend/` — React/TypeScript/Vite дешборд з графіками (Recharts)

## Запуск backend

```bash
cd backend
cp .env.example .env   # заповнити DATABASE_URL, JWT_SECRET, KOMMO_API_TOKEN
npm install
npm run migrate        # створити таблиці
SEED_ADMIN_PASSWORD=... npm run db:seed  # створити команди + admin-користувача (опційно)
npm run sync            # одноразова синхронізація з Kommo
npm run dev
```

## Запуск frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

## Що зроблено

- Аутентифікація через JWT з ролями `admin` / `team_lead` / `manager`
- Синхронізація лідів/угод і користувачів з Kommo CRM (cron кожні 15 хв)
- Таблиця `pipeline_stage_map` для маппінгу статусів воронки Kommo на етапи звіту
  (ліди в роботі → запит КП → погоджено → рахунок → оплата) — потребує заповнення
  під конкретні воронки/статуси компанії
- Ручне введення планових показників (`/api/plans`)
- Дешборд воронки продажів (графік за етапами)

## Що залишилось

- Заповнити `pipeline_stage_map` реальними `pipeline_id`/`status_id` з Kommo
- Дешборди по командах (РНК, РПК, Лідогенератори) і окремих менеджерах
- UI для введення планів, план/факт по днях/тижнях, середній чек
- Деплой (Docker/CI)
