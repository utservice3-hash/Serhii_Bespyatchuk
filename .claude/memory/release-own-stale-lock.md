---
name: release-own-stale-lock
description: Свій замок стенда, що лишився після зупинки ланцюга (матриця тощо), відпускати самому — Роман 26.10.2026 «відпускай замок якщо він тобі не треба»
metadata:
  type: feedback
---

Коли мій викат (`UTS_ACTOR=claude-finance`) зупинився на `acceptMatrix` чи іншому кроці після `pushBranch` і лишив замок, а моїх процесів `deploy.js` уже немає — відпускати СВІЙ замок самому: `UTS_ACTOR=claude-finance node dist/tools/checkoutLock.js --release` у `/home/evraziat/fwt/backend`, потім `--status`.

**Why:** Роман 26.10.2026 тричі за день мусив відпускати мій замок руками; інші сесії стояли в черзі. Явний дозвіл: «відпускай замок якщо він тобі не треба».
**How to apply:** лише СВІЙ замок (тримач `claude-finance`) і лише коли мій ланцюг закінчився (0 процесів deploy.js, код уже на проді чи викат свідомо зупинено). Чужий замок — не чіпати, див. [[lock-busy-is-not-abandoned]], [[deploy-lock-and-sha-form]].
