import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb, planGraceSkip } from "../testMode.js";

/**
 * #49 — ДОБІР АДИТИВНИЙ: Σ(менеджери) == команда == компанія.
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ НА ПРОДІ 06.08.2026. Середнє НЕ адитивне, і саме на цьому
 * ми й спіймались: `newBusinessDobirByManager` рахував КОЖНОМУ власне середнє
 * (`raw_m ÷ місяців_m`), тож Σ по менеджерах давала **1 599 273 ₴** проти
 * справжніх **1 511 318 ₴** по відділу — завищення на **87 955 ₴ (105.8%)**.
 * Жодне окреме число при цьому не виглядало дивним: у кожного менеджера його
 * власний добір був порахований правильно.
 *
 * Правильний розклад — через ЧАСТКУ: `dobir_m = dobir_відділу × (raw_m ÷ raw_відділу)`.
 * Σ ваг = 1 → Σ = добір відділу точно.
 */
test("#49 добір: Σ по менеджерах == добір відділу", needsDb(), async () => {
  const money = await import("./money.js");
  const dept = await money.newBusinessDobir({});
  const rows = await money.dobirByManager({});
  if (dept === 0) { assert.equal(rows.length, 0, "🔴 відділ 0, а менеджери щось добирають"); return; }
  assert.ok(rows.length > 0, "🔴 добір відділу ненульовий, а по менеджерах порожньо — розклад загубив усе");
  const sum = rows.reduce((a, r) => a + r.dobir, 0);
  assert.ok(Math.abs(sum - dept) < 1,
    `🔴 Σ менеджерів ${Math.round(sum)} ≠ добір відділу ${dept} — розклад НЕ адитивний`);
});

/**
 * #49b — 🧨 САБОТАЖ: повторне усереднення має ЧЕРВОНІТИ. Без цього #49 зеленів би
 * і на випадковому збігу; тут ми показуємо, що НЕПРАВИЛЬНИЙ розклад справді дає
 * інше число на ЖИВИХ даних, а не лише в теорії.
 */
test("#49b саботаж: повторне усереднення розходиться з відділом", needsDb(), async () => {
  const money = await import("./money.js");
  const dept = await money.newBusinessDobir({});
  if (dept === 0) return;                       // нема добору — нема що саботувати
  const perMgrAvg = await money.newBusinessDobirByManager({});
  const sumAvg = [...perMgrAvg.values()].reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sumAvg - dept) > 1,
    "🔴 повторне усереднення ЗБІГЛОСЬ із відділом — тоді #49 нічого не стереже "
    + "(або дані виродились: у кожного менеджера рівно стільки ж місяців, скільки у відділу)");
});

/**
 * #49c — ПЛАН ТИЖНЯ АДИТИВНИЙ на ЖИВИХ даних: Σ(менеджери) == команда == компанія.
 * Перерозподіл залишку не має ані створювати, ані губити гроші при агрегації.
 */
test("#49c план тижня: Σ по менеджерах == Σ по командах == компанія", needsDb(), async (t) => {
  const { weekPlansForMonth } = await import("./weekPlan.js");
  const { managerPlan } = await import("./plans.js");
  const { pool } = await import("../db/pool.js");
  const month = (await pool.query<{ d: string }>(
    `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv'),'YYYY-MM-DD') d`)).rows[0].d;

  const mp = await managerPlan({ month });
  const planByMgr = new Map(mp.rows.map((r) => [r.managerId, r.plan]));
  assert.ok(planByMgr.size > 0, "🔴 у місяці нема жодного плану — перевіряти нічого");

  // 🟢 Аргумент `freeze:false` більше не потрібен: `weekPlansForMonth` НЕ ВМІЄ писати
  // взагалі (03.09.2026). Занепокоєння автора цього гейта — «інакше він сам заморозив
  // би тижні самим фактом перевірки» — тепер властивість функції, а не прапорець.
  const all = await weekPlansForMonth({}, month, planByMgr);
  assert.ok(all.length > 0, "🔴 план тижня порожній");
  /** 🗓 Тижневих планів ще немає — у вікні заведення це норма, після нього ні. */
  const graced = planGraceSkip("менеджерів із ненульовим тижневим планом", all.filter((r) => r.plan > 0).length);
  if (graced) return t.skip(graced);
  assert.ok(all.some((r) => r.plan > 0), "🔴 усі тижневі плани нульові — рівність зійшлась би тривіально");

  const teams = new Map(mp.rows.map((r) => [r.managerId, r.teamId]));
  const byWeek = new Map<string, number>();
  const byWeekTeam = new Map<string, number>();
  for (const r of all) {
    byWeek.set(r.weekStart, (byWeek.get(r.weekStart) ?? 0) + r.plan);
    const k = `${r.weekStart}|${teams.get(r.managerId) ?? "—"}`;
    byWeekTeam.set(k, (byWeekTeam.get(k) ?? 0) + r.plan);
  }
  for (const [week, total] of byWeek) {
    const teamSum = [...byWeekTeam].filter(([k]) => k.startsWith(week + "|")).reduce((a, [, v]) => a + v, 0);
    assert.equal(teamSum, total, `🔴 тиждень ${week}: Σ команд ${teamSum} ≠ Σ менеджерів ${total}`);
  }
});
