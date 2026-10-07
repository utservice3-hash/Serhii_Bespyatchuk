import { test } from "node:test";
import assert from "node:assert/strict";
import { weekPlanOf, weekWorkingDays, shouldFreezeWeek } from "./weekPlanMath.js";
import { fixedWeekBlocks, workingDaysBetween, monthEndOf } from "./dates.js";
import { needsDb, needsDbWritable, needsBackendEnv, planGraceSkip } from "../testMode.js";

/** Серпень 2026 — місяць власника з прикладу: 1-ше субота, 31-ше понеділок-одинак. */
const AUG = "2026-08-01";
const AUG_END = monthEndOf(AUG);

/**
 * #48 — АРИФМЕТИКА ТИЖНЕВОГО ПЛАНУ ЗБІГАЄТЬСЯ З ПРИКЛАДОМ ВЛАСНИКА.
 * Числа взяті з постановки дослівно, а не перераховані «як має бути»: якщо
 * формула поїде, тест покаже саме те число, яке людина назвала.
 */
test("#48 план тижня рахується від РОБОЧИХ ДНІВ (приклад власника, серпень 2026)", () => {
  const wd = workingDaysBetween(AUG, AUG_END);
  assert.equal(wd, 21, `🔴 у серпні 2026 має бути 21 робочий день, а не ${wd}`);

  // Т1 03–07: 100 000 × 5/21
  assert.equal(weekPlanOf({ monthPlan: 100_000, factBefore: 0, wdWeek: 5, wdRest: 21 }).plan, 23_810);
  // Т2 10–14: залишок 80 000 × 5/16
  assert.equal(weekPlanOf({ monthPlan: 100_000, factBefore: 20_000, wdWeek: 5, wdRest: 16 }).plan, 25_000);
  // Т3 17–21: залишок 55 000 × 5/11
  assert.equal(weekPlanOf({ monthPlan: 100_000, factBefore: 45_000, wdWeek: 5, wdRest: 11 }).plan, 25_000);
  // Т5 31.08: один робочий день — рівно своя одноденна частка, не тижнева норма
  assert.equal(weekPlanOf({ monthPlan: 100_000, factBefore: 95_000, wdWeek: 1, wdRest: 1 }).plan, 5_000);
});

/**
 * #48b — 🧨 САБОТАЖ, ЯКИЙ ПРОСИВ ВЛАСНИК: підміна робочих днів календарними
 * тижнями має ЧЕРВОНІТИ на обрізаному тижні місяця.
 *
 * Перевіряється не сама формула, а її НАСЛІДОК, який тільки й можна спостерігати:
 * за робочими днями ДЕННИЙ ТЕМП цілі однаковий у всіх тижнях (залишок ÷ робочі
 * дні, що лишились), за тижнями — ні. Обрізаний тиждень (31.08 — ОДИН день)
 * отримав би повну тижневу норму, тобто свідомо недосяжну ціль.
 */
test("#48b саботаж: базис «тижні, що лишились» ламає обрізаний тиждень", () => {
  const weeks = fixedWeekBlocks(AUG).filter((w) => weekWorkingDays(w) > 0);
  const last = weeks[weeks.length - 1];
  assert.equal(weekWorkingDays(last), 1,
    `🔴 останній тиждень серпня 2026 має бути ОДНОДЕННИЙ (${last.from}–${last.to}) — інакше саботаж нічого не доводить`);

  const MONTH_PLAN = 100_000;
  // Сценарій «усе йде рівно за планом»: денний темп цілі має бути СТАЛИЙ.
  const paces: number[] = [];
  let fact = 0;
  for (const w of weeks) {
    const wdWeek = weekWorkingDays(w);
    const wdRest = workingDaysBetween(w.from, AUG_END);
    const { plan } = weekPlanOf({ monthPlan: MONTH_PLAN, factBefore: fact, wdWeek, wdRest });
    paces.push(plan / wdWeek);
    fact += plan;
  }
  const spread = Math.max(...paces) - Math.min(...paces);
  assert.ok(spread < 1,
    `🔴 денний темп цілі гуляє на ${spread.toFixed(1)} ₴ — базис робочих днів має давати СТАЛИЙ темп`);

  // ── а тепер САМЕ ТЕ, ЩО ЗАБОРОНЕНО: ділимо на «тижні, що лишились»
  const sabPaces: number[] = [];
  let sabFact = 0;
  weeks.forEach((w, ix) => {
    const weeksLeft = weeks.length - ix;
    const plan = Math.round(Math.max(0, MONTH_PLAN - sabFact) / weeksLeft);
    sabPaces.push(plan / weekWorkingDays(w));
    sabFact += plan;
  });
  const sabSpread = Math.max(...sabPaces) - Math.min(...sabPaces);
  assert.ok(sabSpread > 1_000,
    "🔴 підміна базису НЕ зламала денний темп — тоді гейт #48b нічого не стереже");
  // і головне: однодневному тижню дісталась би тижнева норма
  assert.ok(sabPaces[sabPaces.length - 1] > paces[paces.length - 1] * 3,
    `🔴 обрізаний тиждень мав отримати НЕДОСЯЖНУ ціль (${Math.round(sabPaces[sabPaces.length - 1])} проти ${Math.round(paces[paces.length - 1])} ₴/день)`);
});

/**
 * #48c — Σ-ІНВАРІАНТ (синтетичний): якщо кожен тиждень закрито рівно в план,
 * Σ планів тижнів == план місяця. Без цього перерозподіл міг би тихо створювати
 * або губити гроші — і жодне окреме число не виглядало б дивним.
 */
test("#48c Σ тижневих планів == план місяця, коли кожен тиждень закрито в план", () => {
  const weeks = fixedWeekBlocks(AUG).filter((w) => weekWorkingDays(w) > 0);
  const MONTH_PLAN = 470_000;
  let fact = 0, sum = 0;
  for (const w of weeks) {
    const { plan } = weekPlanOf({
      monthPlan: MONTH_PLAN, factBefore: fact,
      wdWeek: weekWorkingDays(w), wdRest: workingDaysBetween(w.from, AUG_END),
    });
    sum += plan; fact += plan;
  }
  assert.ok(Math.abs(sum - MONTH_PLAN) <= weeks.length,
    `🔴 Σ тижнів ${sum} ≠ план місяця ${MONTH_PLAN} (допуск — округлення по тижню)`);
});

/** #48d — ПЕРЕВИКОНАННЯ: залишок ≤ 0 → план 0 і «понад план», без ділення на нуль. */
test("#48d перевиконання: план тижня 0 і названий надлишок", () => {
  const r = weekPlanOf({ monthPlan: 100_000, factBefore: 130_000, wdWeek: 5, wdRest: 11 });
  assert.equal(r.plan, 0, "🔴 план тижня має бути 0, а не відʼємний");
  assert.equal(r.overPlan, 30_000, "🔴 надлишок має бути НАЗВАНИЙ числом, а не зникнути");
  // дзеркало: рівно в план — це ще не перевиконання
  assert.deepEqual(weekPlanOf({ monthPlan: 100_000, factBefore: 100_000, wdWeek: 5, wdRest: 11 }), { plan: 0, overPlan: 0 });
  // і межа: нуль робочих днів не роняє в NaN/Infinity
  assert.deepEqual(weekPlanOf({ monthPlan: 100_000, factBefore: 0, wdWeek: 0, wdRest: 0 }), { plan: 0, overPlan: 0 });
});

/**
 * #48e — ЗАМОРОЖЕННЯ РЕАЛЬНО ТРИМАЄ. Знімок, що вже є, НЕ перезаписується навіть
 * тоді, коли перерахунок дав би інше число. Без цього таблиця була б просто
 * кешем, а ціль і далі повзла б усередині тижня.
 */
test("#48e знімок плану тижня не переписується", needsDbWritable(), async () => {
  const { freezeWeekPlans } = await import("./weekPlan.js");
  const { pool } = await import("../db/pool.js");
  const mgr = (await pool.query<{ id: number }>(`SELECT id FROM managers ORDER BY id LIMIT 1`)).rows[0];
  assert.ok(mgr, "🔴 у базі нема жодного менеджера — перевіряти нічого");

  const WEEK = "1999-01-04", MONTH = "1999-01-01";   // навмисно поза будь-якими живими даними
  await pool.query(`DELETE FROM weekly_plan_snapshots WHERE month_start = $1`, [MONTH]);
  try {
    const base = { managerId: mgr.id, weekStart: WEEK, overPlan: 0, monthPlan: 100, factBefore: 0, wdWeek: 5, wdRest: 21, source: null, reconstructed: false } as const;
    const n1 = await freezeWeekPlans(MONTH, [{ ...base, plan: 111 }], "live");
    assert.equal(n1, 1, "🔴 перший запис не вставився");
    const n2 = await freezeWeekPlans(MONTH, [{ ...base, plan: 999 }], "live");
    assert.equal(n2, 0, "🔴 повторний запис ПРОЙШОВ — заморожування не тримає");
    const got = (await pool.query<{ plan: string }>(
      `SELECT plan FROM weekly_plan_snapshots WHERE month_start=$1 AND manager_id=$2`, [MONTH, mgr.id])).rows[0];
    assert.equal(Number(got.plan), 111, "🔴 знімок змінився — минулі тижні переписуються заднім числом");
  } finally {
    await pool.query(`DELETE FROM weekly_plan_snapshots WHERE month_start = $1`, [MONTH]);
  }
});

/**
 * #1494 — ТИЖДЕНЬ БЕЗ МІСЯЧНОГО ПЛАНУ НЕ ФІКСУЄТЬСЯ (задача 5202, 07.10.2026).
 *
 * Знімок незмінний, тож нуль, зафіксований до заведення планів, жив цілий тиждень: T2 команди Дмитрука
 * показував 21 тис при місячному 900 тис. Фікстура по ОБИДВА боки кожної межі: план 0 / план > 0,
 * тиждень почався / ще ні / починається сьогодні.
 *
 * 🧨 Червоніє, якщо: прибрати умову `monthPlan > 0` (нуль знову фіксується) або умову дати (фіксується
 * майбутній тиждень).
 */
test("#1494 тиждень фіксується лише коли він почався І місячний план уже заведено", () => {
  const today = "2026-10-05";
  assert.equal(shouldFreezeWeek({ weekStart: "2026-10-05", today, monthPlan: 0 }), false,
    "🔴 тиждень без місячного плану заморожено — нуль стане ціллю на весь тиждень");
  assert.equal(shouldFreezeWeek({ weekStart: "2026-10-01", today, monthPlan: 0 }), false,
    "🔴 минулий тиждень без плану заморожено нулем");
  assert.equal(shouldFreezeWeek({ weekStart: "2026-10-05", today, monthPlan: 900_000 }), true,
    "🔴 тиждень, що почався сьогодні, з планом — не фіксується (ціль повзтиме)");
  assert.equal(shouldFreezeWeek({ weekStart: "2026-10-01", today, monthPlan: 1 }), true,
    "🔴 минулий тиждень із планом не фіксується");
  assert.equal(shouldFreezeWeek({ weekStart: "2026-10-12", today, monthPlan: 900_000 }), false,
    "🔴 заморожено майбутній тиждень — ціль за даними, яких ще немає");
});

/**
 * #1494b — ЖИВА БАЗА: у поточному місяці немає знімка з місячним планом 0 у менеджера, чий план заведено.
 *
 * Це саме той стан, який бачила людина (5202). Нуль порушників рахується ЛИШЕ разом із числом менеджерів
 * із планом: якщо планів ще немає, перевіряти нічого — і це вікно заведення планів, а не «зелено».
 *
 * 🧨 Червоніє, якщо: знову фіксувати нуль до заведення планів (на проді 07.10.2026 до чистки — 39 рядків).
 */
test("#1494b ЖИВА БАЗА: жодного знімка тижня з планом 0 у менеджера з місячним планом", needsBackendEnv(), async (t) => {
  const { pool } = await import("../db/pool.js");
  const { dynamicTarget } = await import("./plans.js");
  const ym = (await pool.query<{ m: string }>(`SELECT to_char((now() AT TIME ZONE 'Europe/Kyiv')::date,'YYYY-MM') AS m`)).rows[0].m;
  const monthStart = `${ym}-01`;
  const withPlan = new Map((await dynamicTarget({ month: monthStart }, "month"))
    .filter((d) => d.monthPlan > 0).map((d) => [d.managerId, d.monthPlan]));
  const skip = planGraceSkip("менеджерів із місячним планом", withPlan.size);
  if (skip) return t.skip(skip);
  assert.ok(withPlan.size > 0, `🔴 жодного менеджера з планом на ${ym} — перевіряти нічого, це не «зелено»`);
  const zero = (await pool.query<{ manager_id: number; week_start: string }>(
    `SELECT manager_id, to_char(week_start,'YYYY-MM-DD') AS week_start
       FROM weekly_plan_snapshots WHERE month_start = $1 AND month_plan = 0`, [monthStart])).rows;
  const bad = zero.filter((r) => withPlan.has(r.manager_id));
  assert.equal(bad.length, 0,
    `🔴 ${bad.length} знімк(ів) тижня з місячним планом 0 при заведеному плані (із ${withPlan.size} менеджерів із планом): `
    + bad.slice(0, 8).map((r) => `#${r.manager_id}@${r.week_start}`).join(", "));
});
