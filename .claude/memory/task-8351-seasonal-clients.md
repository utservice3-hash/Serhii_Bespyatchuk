---
name: task-8351-seasonal-clients
description: "Задача 8351 сезонні клієнти з місяцями — на проді 9f48b11 з 10.11, «на затвердженні»; ставить лише КВП/ОД/адмін; 5 старих позначок без місяців не діють"
metadata:
  type: project
---

10.11.2026 на проді `9f48b11` (гілка feat/seasonal-8351), новина id 489, задача 8351 → ready_for_approval, коментар від акаунта 50.

loyalty_overrides.seasonal_months (SMALLINT[], міграція застосована). Правило `reactivationRules.offSeason(seasonal, months, monthNum)`: без місяців — не діє. Ядро clientSegments: не в сезоні → state «active» для всіх читачів (екран клієнтів, реактивація, LTV лідогенерації, джоба). /client-plans: inReactNow виключає offSeason; leadOf: зелений, works.by="season". POST /client-seasonal — isAdminScope (тімлід 403, ACCEPTED_MATRIX_SHIFTS SEASON_KVP), місяці обовʼязкові, 12 місяців — 400. Кнопка — ClientSeasonBlock у ClientCardPanel (canSeason).

Гейти #3453/#3454, #3451 знято → #3452. Рішення Романа 10.11: 5 старих позначок (гуматрест, борисов…, мхп, сашабрсм, метла…) без місяців лишити без дії. Кумком = ключ «кумком», позначає Юля (угоди є й у січ/жов/гру).

Див. [[task-8333-nowork-segment]], [[task-7360-client-lead-screen]].
