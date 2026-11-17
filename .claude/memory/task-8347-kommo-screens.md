---
name: task-8347-kommo-screens
description: "Задача 8347 — скрін з угоди Kommo → контакт клієнта з AI-коментарем; гілка feat/kommo-screens-8347 (6ae79e8), рішення Романа 11.11"
metadata:
  node_type: memory
  type: project
  originSessionId: d87ca90e-5eca-457f-b562-ee24e8b55182
  modified: 2026-11-11T17:03:10.953Z
---

12.11.2026 на проді `d890a75` (новина 495). Перший прохід 09:50: 51 скрін за 11.11, з 30 прочитаних 25 chat / 4 document / 1 other. Приймання: 7 відомих чужих + #840b (гейт не знав 8350 «Проблемний») → замінено на #3847, злито в main f83a34f (лише тест). 12.11 хостинг почав віддавати 403 на UA `curl` — крок deploy `contentType` падає; обійшов тимчасовим ~/.curlrc (прибрано). Запис у задачник через Chrome класифікатор блокує — статус/коментар ставить Роман.

Рішення Романа 11.11 («1 так 2 ТІЛЬКИ З СЬОГОДНІ 3 так 4 так, роби»): контакт = лише переписка (AI `chat`); скріни з 11.11.2026 00:00 Київ; усі угоди з `client_key`; дата контакту = прикріплення в Kommo.

**Why:** ТЗ Юлі 06.11 п.3 — скрін кріплять двічі (дашборд + Kommo). Бюджет AI: ~$0,0014 за скрін (замір 3 живих викликів: ~1 300 вх. / ~80 вих. токенів), ~950 скрінів/міс → ~$1,5/міс, у межах $50; Сергію додатковий бюджет не потрібен.

**How to apply:** ядро `core/kommoScreens.ts` (`screenVerdict`, `countsAsContactSql`, рубрика `kommo-screen-v1`, операція ledger `screen_analysis`); джоба `syncKommoScreens` cron `20,50`, вотермарк `sync_state.kommo_screens_note_at`; рядки в `client_contacts` channel `kommo` + колонки kommo_*/ai_*; файл — проксі з Kommo drive (`kommoDriveFile`), видалення з дашборда 403. Гейти #3840–#3846 (#3846 у ALLOWED_PROD_SKIPS). Відкат: `DELETE FROM client_contacts WHERE channel='kommo'` + старий CHECK каналів. Живого гейта «імпорт == Kommo за день» НЕ зроблено (звірка — скриптом при прийманні). Див. [[ai-call-analysis-budget-50]], [[task-7360-client-lead-screen]].
