---
name: tracker-url-domain
description: 05.10.2026 прод TRACKER_URL переведено на https://timetracker.uts.ua (було sslip.io); копія .env.bak-tracker; рестарт — markDeploy + kill за PID, а не pkill з ТЗ
metadata:
  type: project
---

05.10.2026 23:49: на проді `/home/evraziat/uts.ua/dashboard/backend/.env` змінено лише `TRACKER_URL` → `https://timetracker.uts.ua` (стара `https://65.108.255.154.sslip.io` ще працює; блокується деякими роутерами/антивірусами). Копія — `.env.bak-tracker`. Рестарт: `markDeploy` + `kill -TERM` за PID `node dist/index.js` → старт `deploy-intent` (без банера аварії), health 200; ключ SSO на новому домені приймається (порожнє тіло → 400, без ключа → 401).

**Why:** `pkill -f 'node.*dashboard/backend/dist/index'` з ТЗ процес прода НЕ знаходить (він запущений як `node dist/index.js`) і матчив сторонні процеси. Змінні процес бере лише з `.env` через dotenv (панель нічого не підставляє).
**How to apply:** відкат — `cp .env.bak-tracker .env` + той самий рестарт. Перевірку кнопки «Тайм-трекер» у браузері (керівник і менеджер) робить Роман.
