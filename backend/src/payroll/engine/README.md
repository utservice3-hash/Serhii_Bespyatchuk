# Рушій «Зарплата» — як підключити

ES-модуль без залежностей. Працює в Node ≥ 18 і в браузері.

## Що він робить

- **Вхід** — знімок даних на зараз (`State`). Поля описано в JSDoc у `zarplata-engine.mjs`, а як бекенд їх збирає — в ТЗ, розділ 10.
- **Вихід** — готові суми, статуси й тексти.
- Мережі, БД і дати сервера рушій не чіпає. «Зараз» — це `state.now`.

```js
import { createPayroll, nextStatus, DEFAULT_SETTINGS } from './zarplata-engine.mjs';
import { createNotifier } from './notify.mjs';

const zp = createPayroll(state);                 // state зібрав бекенд (ТЗ, розділ 10)

zp.calc(userId, '2026-11');                      // { kind, level, margin, plan, kpi, birthdays, now:{…,total}, atPlan:{…,total} }
zp.settlement(userId, '2026-11');                // { total, advance, officialDeducted, ttnLines, pay, values, auto, … }
zp.advanceLimit(userId, '2026-11');              // { byRule, cap, amount, capped }
zp.checkPayoutForm(userId, '2026-11', form);     // { ok, due, got, rest, badCards, negative, duplicate }
zp.payoutLines(userId, '2026-11');               // фактичні суми виплати за формою (ТТН закрили після форми)
zp.clearanceState(userId);                       // { done, total: 8, ok, final }
zp.clearanceCanSign(userId, 'trucks', viewerId); // чи цей користувач відповідальний за пункт
zp.clearanceReady(userId, 'trucks', [true]);     // чи можна підписати з такими позначками
zp.payBlocked(userId, mk); zp.payNeedsOd(userId, mk);
zp.autoProfi(userId, closedMonth);               // офер Лілії: { from, level:'profi', m1, m2 } або null — при закритті місяця
zp.forecast('2026-11'); zp.deptStats('2026-11', false);
zp.goalDefaults(userId, mk); zp.goalRun(userId, mk, { level, conv, target, calls, regular, avgCheck });
nextStatus('verified', 'agree');                 // 'agreed' (або null — дія недоступна)

const nt = createNotifier(zp, state);
nt.build.clearanceCreated(userId, at);           // масив сповіщень: { type, at, to:[ids], act, cta, title, text, go, done }
nt.notificationDoneAt(notification);             // ISO-дата / true — дію виконано; null — ще чекає
```

Публічні функції приймають працівника як id або як об’єкт.

## Тести

```bash
npm test                 # 63 тести: 40 звірок з макетом v6 + 23 правила
npm run fixtures         # перегенерувати test/fixtures/maket-v6.json з ../maket/src/parts (якщо змінили макет)
```

**Бекенд не на Node.** `test/fixtures/maket-v6.json` містить вхід (`state`) і очікуваний вихід (`expected`) для трьох дат. Портуйте рушій і перевірте на тих самих JSON.
