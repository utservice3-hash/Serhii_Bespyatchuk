---
name: sabotage-restore-not-git-checkout
description: "Після саботажу відновлювати лише `sabotage.js <файл> --restore`; `git checkout` файла стирає незакомічені правки"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4c5a6587-c7fc-4f8b-b4cc-6d7524859d82
  modified: 2026-09-29T09:57:42.572Z
---

Відновлення після саботажу — тільки `node dist/tools/sabotage.js <той самий файл> --restore`
(з аргументом файла; без нього інструмент відмовляє). Перед першим саботажем — закомітити
свої правки.

**Why:** 08.09.2026 запасний `git checkout src/…` після невдалого `--restore` відкотив файл
до origin і стер мої незакомічені зміни ключа; довелось переписувати. Хук
`no-commit-with-sabotage` блокує коміт, поки лежить `.sabotage-backup`, і блокує ВСЮ
команду, тож restore і commit — окремими викликами.

⚠️ Копія `.sabotage-backup` ПЕРЕЗАПИСУЄТЬСЯ кожним саботажем. 29.09.2026 скриптовий драйвер
кликав `--restore` без файла (rc≠0, не перевіряв) — 15 саботажів наклались, копія тримала
проміжний стан. У драйвері: restore з файлом + `git diff --quiet HEAD -- <файл>` після
кожного, інакше стоп. Якщо вже наклалось і все закомічено — `git checkout HEAD -- <файли>`.

**How to apply:** порядок: коміт → саботаж → `rm -rf dist && npm run build` → прогін →
`--restore <файл>` → чиста збірка → контрольний прогін. Див. [[merge-and-deploy-need-explicit-approval]].
