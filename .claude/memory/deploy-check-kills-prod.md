---
name: deploy-check-kills-prod
description: "Аварія прода за 0–2 хв до викату = фаза check (крок test, 47 процесів) — не регресія; фікс у гілці claude/tests-audit-cdb6ca, не викочено"
metadata:
  node_type: memory
  type: project
  originSessionId: 45c8a90b-53ef-4ba3-b0b0-0768f03ce181
  modified: 2026-11-11T17:17:45.730Z
---

11.11.2026 заміряно (app_boot × журнал замка, 45 днів): з 52 аварій прода під замком 48 — у перші 300 с фази `check`
чийогось викату (~107 с від take = крок `test`: `npm test` без `--test-concurrency`, на хостингу 47 процесів).
Ядро LVE вбиває найбільший процес — прод; на `tscFront` найбільший сам `tsc`, тому там гине збірка.
Роман 11.11: «ні ліміт ми не підіймаємо … оптимізуй» — лист хостингу НЕ готувати.

Фікс — гілка `claude/tests-audit-cdb6ca` (bb2950d+, злито з main ba74f4d), гейти #3880–#3891:
`backend/scripts/testRun.mjs` (стеля 4 на /proc/lve), `frontend/scripts/typecheckParts.mjs` (частини зі стелею хіпа
600 МБ і самоподілом), без npm/npx, крок `quietHost`, curl з власним UA (#3892: з 12.11 nginx дає 403 дефолтному curl).
**На проді `718d1a3` з 12.11.2026 10:10 Київ:** app_boot без crash; check 2 хв 05 с, крок test ~1 хв, пік акаунта 1,4 ГБ PSS;
найважчий тепер — typecheck бекенда (793 МБ). Accept/матриця: 8 відомих чужих (#124 #125 #181 #274e #444c #840b #873 еталон РПК).

**Why:** до викату фіксу кожна сесія бачитиме «crash» у app_boot перед своїм/чужим викатом і шукатиме регресію.
**How to apply:** аварію прода за ~2 хв до `kill` викату не діагностувати як дефект коду; після викату фіксу —
приймання: нуль таких аварій (скрипт `docs/audit-2026-11-11/crashes.py`). Див. [[stand-build-oom-node-options]].
