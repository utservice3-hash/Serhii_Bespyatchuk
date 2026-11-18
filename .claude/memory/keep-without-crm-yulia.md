---
name: keep-without-crm-yulia
description: "КВП Левентова Юлія відвʼязана від CRM — managers.keep_without_crm (id 9), синк не вимикає; на проді 899a4d2 з 22.10, задача 6678"
metadata:
  node_type: memory
  type: project
  originSessionId: 4c5a6587-c7fc-4f8b-b4cc-6d7524859d82
  modified: 2026-10-22T12:31:00.020Z
---

22.10.2026 Роман: акаунт Юлі Сергіївни (КВП, users 47 → managers 9, Kommo 3549691) видаляють у Kommo, у дашборді має лишитись усе.
Зроблено НЕ відвʼязкою (179 задач на assignee_id=9 лишились), а позначкою `managers.keep_without_crm`: `DEACTIVATE_MISSING_MANAGERS_SQL` (core/managerKeep.ts) її поважає; позначка Юлі разова в schema.sql (з is_active=true). Гейт #1880. На проді 899a4d2, звірено запитом. Задача 6678 «Готово на затвердження».

**Why:** без цього синк вимкнув би запис і вона зникла б з виконавців, чергувань, відпусток, 1×1, команди.
**How to apply:** після видалення в Kommo — повторний замір (is_active=true). Не створювати в Kommo користувача з ranutservice@gmail.com — provisionUsers перевʼяже акаунт. Наступну таку людину — рядком у schema.sql.
