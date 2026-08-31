---
paths:
  - "backend/src/statistics/**"
  - "backend/src/routes/statistics.ts"
  - "backend/src/routes/statisticsSeries.ts"
  - "frontend/src/pages/dashboard/sections/Statistics*"
---

## Статистики (відділи) — `depstats`

Заміна ручної таблиці «UTS Показники для статистик». 6 відділів. Гібрид: sales-метрики з CRM (auto), решта — imported/manual. Специфікація — `docs/STATISTICS_SPEC.md`, звірка — `docs/STATISTICS_RECONCILIATION.md`.
- **`statistics_values`** (EAV): `department, period_type(month|week), period_start, team_lead, metric_key, value, source(auto|manual|imported)`. **R1**: тиждень→понеділок (лист=неділя, −6 днів). **R2**: «самостійні»+«Шевчук»→`team_lead='Шевчук Назар'`.
- **`backend/src/statistics/catalog.ts`** — ЄДИНЕ джерело правди структури. Фронт і бекенд беруть перелік ЛИШЕ звідси. Планів тут НЕМА (план із `plans`).
- **Межа довіри `STATS_AUTO_FROM='2026-01-01'`**: до неї лист рахував машини вручну → непорівнянно, лишаємо imported.
- **API `/api/statistics`**: `GET /catalog`, `GET /?department&period_type&from&to`, `PUT /manual` (лише admin; auto/derived→400).

