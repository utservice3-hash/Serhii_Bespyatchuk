---
name: task-7424-client-limits-owner-inactive
description: "Задача 7424 (ліміти: зміна власника/директора → призупинення; 3 міс. без угод → скидання) — на проді 4e4f409 з 03.11, ready_for_approval; 04.11 перевірити перший ранковий прогін"
metadata:
  node_type: memory
  type: project
  originSessionId: cb56b2a3-852e-4f6a-91e9-c65cad29f131
  modified: 2026-11-03T21:30:09.357Z
---

03.11.2026 на проді `4e4f409` (гілка feature/client-limits-owner-inactive, злита в main ланцюгом). Задача №7424 → `ready_for_approval`, опис у полі comments. Гейти `#3370`–`#3375` (перенумеровано з `#336x` — зіткнення з callAiScreen).

Того ж вечора в прод `.env` додано `CP_BACKGROUND_CHECKS=1` (копія `.env.bak-cpbackground-20261103`), рестарт markDeploy+kill, старт `deploy-intent`. Відкат — `cp .env.bak-cpbackground-20261103 .env` + той самий рестарт.

Приймання викату: 5 відомих падінь (#124 #125 #181 #274e #444c), матриця вручну — ті самі 5. #181 — розбіжність днів аркуш/наше, не від дзеркала.

**04.11 перевірено:** перший прогін 06:15/06:30 без помилок. Планова перевірка — 10 клієнтів, змін власника 0; суди зупинили 2 ліміти (id 3 АВТОСТРАДА ВК, id 26 ФІРМА ДІСНА); скинуто 1 (id 28). Діє 46, зупинено 2. Короткий опис — артефакт https://claude.ai/artifact/CwG45ZQn5TMbvcG2syf2sX, посилання в стрічці задачі (task_comments id 562).

**Why:** справжнього випадку зміни власника ще не було — перший такий варто показати Сергію.
**How to apply:** наступна сесія — спершу цей замір, потім звіт Роману. Пов'язане: [[registries-cp-limits-state]], [[youcontrol-edr-state]].
