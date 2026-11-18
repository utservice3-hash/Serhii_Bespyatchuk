---
name: constructor-dir-genitive-5461
description: Задача 5461 (ПІБ директора в родовому, «який/яка діє») — на проді 446d072 з 13.10, закрита; як влаштовано
metadata:
  type: project
---

На проді `446d072` з 13.10.2026, задача 5461 — «Готово». Гейти #1680–#1684.

- Відмінювання — shevchenko.js 3.2.2 (MIT) як самодостатній UMD-бандл `backend/src/constructor/vendor/shevchenko.min.cjs`; збірка (`package.json` build) копіює vendor у dist. npm-пакет НЕ ставити — тягне TensorFlow на 293 МБ.
- `names.resolveDirector(s)` кличеться на вході `/preview` і `POST /documents`, пише `cp.dirGen`/`cp.dirFem` у стан → в архів. Старі записи без них рендеряться в називному (архів не переписується).
- Наші директори — статичні `dirGen`/`dirFem` у `data/entities.ts`; #1680 звіряє їх із бібліотекою.
- Фронт: `DirectorHint` під полем «Директор» (Ч/Ж при невизначеному роді, «виправити» → `dirGenHand`).
- Замір: рід визначається у 85% реальних ПІБ; 9 із 237 записів уже в родовому → 🟡.
- Знімок екрана підказки на проді не знімався (вхід під паролем — не мій); серверний текст звірено прямо на проді.

Повʼязане: [[constructor-quick-fixes-1012]], [[constructor-nonresident-tasks]].
