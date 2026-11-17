---
name: no-direct-push-to-main
description: "Ніяких комітів чи пушів напряму в main, навіть docs — тільки гілка й мерж за словом користувача"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4c5a6587-c7fc-4f8b-b4cc-6d7524859d82
  modified: 2026-09-09T04:10:27.801Z
---

Жодних комітів у `main` напряму, включно з документами («Де ми зараз», ТЗ, списки задач).
Усе йде на гілку `feature/<name>`, у `main` потрапляє лише мержем за явним словом.

**Why:** 09.09.2026 запушив docs-коміт у `main` (звичка інших сесій так робити) — користувач
попросив відкотити: «чому ти комітеш це в main, відміни». Довелось робити revert і виносити
зміст на гілку.

**How to apply:** `git push origin HEAD:main` заборонено; docs-правки після викату — на
гілці викату або окремій docs-гілці, і питати «злити?». Див. [[merge-and-deploy-need-explicit-approval]].
