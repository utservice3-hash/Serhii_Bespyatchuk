---
name: deploy-check-env-leak
description: "deploy:check у тому ж SSH-shell, де раніше робили `. ./.env`, дає хибне червоне на кроці test"
metadata: 
  node_type: memory
  type: project
  originSessionId: c265a6e1-2f90-4a16-ab36-f6699b533a93
  modified: 2026-09-08T10:31:56.876Z
---

Крок `test` у `deploy.ts` запускає `npm test` для бази й дерева через `sh(...)`, який **успадковує середовище процесу** — окремого очищення немає. Тож якщо в тому ж SSH-shell раніше виконали `set -a && . ./.env && set +a` (наприклад, вручну публікуючи новину `publishReleaseNews`), то `DATABASE_URL` протікає в прогони тестів, і БД-гейти замість чистого скіпу починають то падати, то зникати. Симптом: `test` червоніє з «нетотожні середовища» — база напр. 138 падінь, дерево 6, і 8 файлів `money/conversion/rbac/oracle/alerts/jobs/plans/metricTools` «перестали виконуватись».

**Why:** заміряно 08.09.2026 під час викату `abd15a0`. Той самий `deploy:check` був чистий ДО ручного `. ./.env` і зламаний ПІСЛЯ. Прод при цьому справний — це артефакт прогону, не регресія коду.

**How to apply:** `deploy:check`/`deploy:run` завжди ганяти у **свіжому SSH-shell** (`exit` → reconnect), НЕ в тому, де вручну сорсили `.env`. Крок `accept` сам підтягує `.env` у власному підпроцесі — на нього це не впливає. Повʼязано з [[merge-and-deploy-need-explicit-approval]].
