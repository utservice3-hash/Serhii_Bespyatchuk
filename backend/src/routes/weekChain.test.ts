import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #62 — ЛАНЦЮГ «ГРОШІ ТИЖНЯ» СХОДИТЬСЯ: ОЧІКУЄ + ОПЛАЧЕНО == ВІДПРАВЛЕНО.
 *
 * 🔴 ЦЕ Й Є СЕНС БЛОКУ. Три числа в ряд обіцяють, що друге й третє РОЗБИВАЮТЬ перше.
 * Щойно Σ розійдеться, блок перестає бути ланцюгом і стає трьома незалежними
 * цифрами, які випадково стоять поруч, — а виглядає так само.
 *
 * Другий рівень тієї самої обіцянки: очікування розкладається на «з плановою датою»
 * і «без дати», і ці двоє теж мусять дати рівно `awaitSum`. Саме на цьому поділі
 * стоїть прогноз: гроші без дати в нього НЕ входять.
 *
 * 🧨 САБОТАЖ: змінити фільтр «очікує оплати» так, щоб він втратив частину машин →
 * гейт червоніє, називаючи менеджера й обидва числа.
 */
interface Mgr {
  managerId: number; name: string;
  cohort: { deals: number; sum: number; paidDeals: number; paidSum: number;
    awaitDeals: number; awaitSum: number; awaitDatedSum: number; awaitNoDateSum: number };
}

async function weekManagers(): Promise<{ H: Record<string, string>; from: string; to: string; mgrs: Mgr[] }> {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { Authorization: `Bearer ${token}` };
  // Поточний місяць цілком — щоб напевно застати період із рухом.
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, { headers: H });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  return { H, from, to, mgrs: ((await r.json()) as { managers: Mgr[] }).managers ?? [] };
}

test("#62 ланцюг сходиться: очікує + оплачено == відправлено", needsApi(), async () => {
  const { mgrs } = await weekManagers();
  const live = mgrs.filter((m) => m.cohort && m.cohort.deals > 0);

  // ⚠️ Дзеркало-вимога з промту: якщо руху немає — сказати це ВГОЛОС, а не зеленіти.
  assert.ok(live.length >= 3,
    `🔴 лише ${live.length} менеджерів мають відправлені авто в періоді — ланцюг нема на чому `
    + "перевірити. Це не «зелено», це «не перевірено».");

  const bad: string[] = [];
  for (const m of live) {
    const c = m.cohort;
    if (c.paidDeals + c.awaitDeals !== c.deals) {
      bad.push(`${m.name}: ${c.paidDeals} оплачено + ${c.awaitDeals} чекає ≠ ${c.deals} відправлено (шт)`);
    }
    if (Math.abs(c.paidSum + c.awaitSum - c.sum) > 1) {
      bad.push(`${m.name}: ${c.paidSum} + ${c.awaitSum} ≠ ${c.sum} ₴`);
    }
    // Другий рівень: розклад очікування має дати рівно `awaitSum`.
    if (Math.abs(c.awaitDatedSum + c.awaitNoDateSum - c.awaitSum) > 1) {
      bad.push(`${m.name}: очікування ${c.awaitDatedSum} з датою + ${c.awaitNoDateSum} без ≠ ${c.awaitSum} ₴`);
    }
  }
  assert.deepEqual(bad, [], "🔴 ЛАНЦЮГ НЕ СХОДИТЬСЯ:\n  " + bad.join("\n  "));
});

/**
 * #62b — РОЗКРИТТЯ ЛАНЦЮГА ЙДЕ ЧЕРЕЗ ТОЙ САМИЙ `day-items`, І ЙОГО Σ ЗБІГАЄТЬСЯ
 * З ЧИСЛОМ У ЛАНЦЮГУ.
 *
 * Вимога власника була не «зроби ще один список», а «не заводь другий механізм».
 * Гейт це й перевіряє: той самий роут із періодом замість дня віддає рівно ті суми,
 * що показує блок. Якщо колись зʼявиться окремий ендпоінт «на тиждень», ці числа
 * розійдуться першими.
 */
test("#62b розкриття ланцюга == числам ланцюга", needsApi(), async () => {
  const { H, from, to, mgrs } = await weekManagers();
  const live = mgrs.filter((m) => m.cohort && m.cohort.deals > 0).slice(0, 3);
  assert.ok(live.length >= 1, "🔴 нема кого перевіряти");

  const bad: string[] = [];
  for (const m of live) {
    for (const [kind, wantN, wantS] of [
      ["dispatched", m.cohort.deals, m.cohort.sum],
      ["dispatched_paid", m.cohort.paidDeals, m.cohort.paidSum],
      ["dispatched_awaiting", m.cohort.awaitDeals, m.cohort.awaitSum],
    ] as const) {
      const r = await fetch(
        `${API_BASE}/api/dashboard/report-plan/day-items?managerId=${m.managerId}&date=${from}&to=${to}&kind=${kind}`,
        { headers: H });
      if (r.status !== 200) { bad.push(`${m.name} ${kind}: HTTP ${r.status}`); continue; }
      const g = await r.json() as { total: { count: number; sum: number } };
      if (g.total.count !== wantN) bad.push(`${m.name} ${kind}: у ланцюгу ${wantN} шт, у розкритті ${g.total.count}`);
      if (Math.abs(g.total.sum - wantS) > 1) bad.push(`${m.name} ${kind}: у ланцюгу ${wantS} ₴, у розкритті ${g.total.sum}`);
    }
  }
  assert.deepEqual(bad, [], "🔴 РОЗКРИТТЯ РОЗІЙШЛОСЬ ІЗ ЛАНЦЮГОМ:\n  " + bad.join("\n  "));
});
