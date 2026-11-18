---
name: task-5779-pdf-stamp
description: Задача 5779 «Печатка на PDF» у конструкторі — pdf-lib у vendor (qpdf на проді 7.1.1 без --overlay); гілка batch/2026-10-20-ctor
metadata:
  type: project
---

Задача **5779** (створена 14.10 руками з акаунта 50; просив **Сергій**). Роман 20.10: лише печатка, робити можуть **усі**, окрема вкладка поруч «Конструктор | Пул заявок», кнопка «Додати печатку», печаток кілька, список, поворот.
- Код: `StampView.tsx` (pdf.js прев'ю), `services/pdfStamp.ts` (`parseStamps`, `placeOnPage` — видимі координати CropBox+/Rotate → простір сторінки, поворот за годинниковою довкола центру), роути `POST /constructor/stamp`, `GET /stamp-image/:ent`, журнал `constructor_stamp_log` (REVOKE ai_readonly).
- **pdf-lib 1.17.1 UMD у `constructor/vendor/pdf-lib.min.cjs`** — не npm (ланцюг не робить npm ci), не qpdf (на проді **7.1.1**, `--overlay` лише з 8.4 — заміряно 20.10). `EncryptedPDFError` в UMD не ловиться `instanceof` — ловимо за текстом.
- Гейти #1820/#1820b (по пікселях через pdftoppm), #1821, #1822; саботажі 6/6.
- Коміт `efd79987`, задача in_progress. Чекає слова на викат. Печатки PNG — лише на сервері (`constructor-assets`), у git їх немає.

Повʼязане: [[task-5887-uts-no-cash]], [[constructor-dir-genitive-5461]].

**20.10 НА ПРОДІ `1a15833`** (приймання 1783/1783, 4 очікувані; матриця зелена), задача «Готово на затвердження» (статус поставили з акаунта 50 о 14:40, не я). Перевірено на сервері справжніми печатками.
