---
name: duty-khomik-team
description: Чергування — тімлід команди Хомік (36284) ставить своїх; DUTY_TEAM_IDS = RNK + 36284, на проді 982fe92 з 06.11
metadata:
  type: project
---

06.11.2026 Роман: «треба зробити Віці Хомік доступ до цього» (ставити на чергування). На проді `982fe92` (гілка fix/duty-khomik-team): `routes/duty.ts` — окремий `DUTY_TEAM_IDS = [...RNK_TEAM_IDS, KHOMIK_TEAM_ID]`; `RNK_TEAM_IDS` свідомо не чіпали (Звіт, номінації, канали лідів). Гейт #3353 (routes/dutyTeams.test.ts), #3300 стереже DUTY_TEAM.

Хто ставить чергових: адмін-рівень (admin, ceo, opdir, kvp, financier, «Бухгалтерія» ____________) — будь-кого; тімліди — лише свою команду з DUTY_TEAM_IDS (Безпамятний 13, Михальчевська 15, Хомік 36284). Віка: role manager + role_override team_lead → перелогін після викату.

Приймання 982fe92: #11 червоний — leadgen-pool 403 від викату 7360 (ff31580, чужий, сесія зупинила свій ланцюг до матриці); #3342/#1307 — теж чужі.
