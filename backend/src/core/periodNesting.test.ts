import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #46 — ВКЛАДЕНИЙ ПЕРІОД НЕ МОЖЕ ПЕРЕВИЩУВАТИ ТОЙ, ЩО ЙОГО МІСТИТЬ.
 *
 * 🔴 ПРИВІД — КАРТКА АНТИПЕНКА (серпень 2026): факт МІСЯЦЯ **0 ₴** при факті
 * ТИЖНЯ **23 632 ₴**. Арифметично неможливо — тиждень лежить усередині місяця.
 * Причина була не в даних: місячний блок рахував ① `successMoney` (лише 142),
 * тижневий — ② `receivedMoney` (142 ∪ «оплата отримана»). Незавершена міграція
 * коміту `989644f` лишила на одному екрані дві різні метрики під однаковими
 * підписами, і кожна ОКРЕМО була правильна — тому нічого не червоніло.
 *
 * Цей гейт не питає «яка формула правильна». Він питає лише те, що не залежить
 * від рішення власника: **чи це взагалі ОДНА метрика**. Дві різні метрики під
 * одним підписом ловляться саме тут і більше ніде.
 *
 * 🪞 ДЗЕРКАЛО ВСЕРЕДИНІ ТЕСТУ: самої нерівності мало — вона зелена й тоді, коли
 * обидва числа нулі (тобто коли ендпоінт мертвий). Тому окремо вимагаємо, щоб
 * у вибірці був хоч один менеджер із НЕНУЛЬОВИМ фактом: порожній результат — це
 * ПРОВАЛ, а не успіх.
 */
test("#46 факт тижня ≤ факт місяця на картці менеджера", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });

  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const body = await r.json() as { managers: { name: string; fact: number; factSuccess: number; factPaid: number; week: { fact: number } }[] };
  const mgrs = body.managers ?? [];
  assert.ok(mgrs.length > 0, "🔴 у звіті нема жодного менеджера — перевіряти нічого");

  // Дзеркало: вибірка має бути ЗМІСТОВНОЮ, інакше нерівність нічого не доводить.
  const nonZero = mgrs.filter((m) => m.fact !== 0 || m.week.fact !== 0);
  assert.ok(nonZero.length > 0,
    "🔴 у ВСІХ менеджерів факт місяця І тижня = 0 — нерівність зелена, але порожня");

  const broken = mgrs
    .filter((m) => m.week.fact > m.fact)
    .map((m) => `${m.name}: тиждень ${m.week.fact} > місяць ${m.fact}`);
  assert.deepEqual(broken, [],
    "🔴 ТИЖДЕНЬ БІЛЬШИЙ ЗА МІСЯЦЬ — блоки рахують РІЗНИМИ метриками під однаковими підписами");
});

/**
 * #46b — РОЗКЛАД ФАКТУ СХОДИТЬСЯ: факт = успішно(142) + оплачено(етап 9).
 * Без цього #46 зеленів би й тоді, коли `fact` віддає щось третє: нерівність
 * «тиждень ≤ місяць» тримається для будь-якої достатньо великої величини.
 * Саме ця рівність і є твердженням «місяць рахує ② », а не просто «щось велике».
 */
test("#46b факт місяця == успішно + оплачено (розклад ②)", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const body = await r.json() as { managers: { name: string; fact: number; factSuccess: number; factPaid: number }[] };
  const mgrs = body.managers ?? [];
  assert.ok(mgrs.length > 0, "🔴 у звіті нема жодного менеджера — перевіряти нічого");
  assert.ok(mgrs.some((m) => m.factPaid !== 0),
    "🔴 у ЖОДНОГО менеджера немає оплачених (етап 9) — рівність зійшлась би й на ①, "
    + "тобто саме той випадок, який ми ловимо, лишився б непоміченим");
  const off = mgrs
    .filter((m) => Math.abs(m.fact - (m.factSuccess + m.factPaid)) > 1)
    .map((m) => `${m.name}: ${m.fact} ≠ ${m.factSuccess} + ${m.factPaid}`);
  assert.deepEqual(off, [], "🔴 факт не дорівнює розкладу — місяць рахує НЕ ②");
});
