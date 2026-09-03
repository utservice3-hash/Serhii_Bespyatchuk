import { test } from "node:test";
import assert from "node:assert/strict";
import { weekPlanOf, weekWorkingDays } from "./weekPlanMath.js";
import { fixedWeekBlocks, workingDaysBetween, monthEndOf } from "./dates.js";
import { needsDb, needsDbWritable } from "../testMode.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), "utf8");
const noComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/**
 * 🧊 #331–#331b — ЧИТАННЯ НЕ ПИШЕ, І ПИСАР ЛИШИВСЯ РІВНО ОДИН.
 *
 * 📐 Привід заміряно на проді 03.09.2026: `GET /kvp-report` за липень під роллю
 * `test_readonly` давав `permission denied for table weekly_plan_snapshots` зі стеку
 * `freezeWeekPlans <- weekPlansForMonth <- effectiveWeekTargets`. Тобто ВІДКРИТТЯ
 * ЕКРАНА писало в базу; під повними правами воно тихо добивало рядки, і червоне
 * зникало само — одноразове, тобто нерозрізненне з флаком.
 *
 * 🔴 ЧОМУ ГЕЙТ ЧИТАЄ ДЖЕРЕЛО, А НЕ ПОВЕДІНКУ. Довести «функція НЕ пише» поведінкою
 * можна лише проти живої БД під read-only — тобто гейт існував би тільки в `test:prod`
 * і мовчав у звичайному прогоні. Тут перевіряється СТРУКТУРНА властивість: у тілі
 * читача немає виклику писаря. Це не проксі на форматування — це відсутність РЕБРА
 * у графі викликів, і саме воно було дефектом.
 */
test("#331 читач тижневих планів НЕ кличе писаря і не має прапорця freeze", () => {
  const wp = noComments(src("core/weekPlan.ts"));
  const body = wp.slice(wp.indexOf("export async function weekPlansForMonth("),
    wp.indexOf("export async function freezeWeekPlans("));
  assert.ok(body.length > 200, "🔴 тіло читача не знайдено — гейт втратив предмет");
  assert.doesNotMatch(body, /\bfreezeWeekPlans\s*\(/,
    "🔴 читач знову кличе писаря: відкриття екрана пише в базу, і під read-only це "
    + "permission denied, а під повними правами — тихий запис, якого ніхто не просив");
  assert.doesNotMatch(body, /\bfreeze\b\s*[?:]/,
    "🔴 повернувся прапорець `freeze` — дефект лікується ВІДСУТНІСТЮ можливості, а не "
    + "дефолтом: наступний виклик просто не передасть його знову");
});

test("#331b 🪞 ДЗЕРКАЛО: писар ЖИВИЙ, стоїть у розкладі й позначає день старту як live", () => {
  // Без цієї половини «читання не пише» задовольнялось би й тим, що знімки не
  // зʼявляються ВЗАГАЛІ — тобто ми прибрали б побічний ефект і не поставили нічого.
  const wp = noComments(src("core/weekPlan.ts"));
  const writer = wp.slice(wp.indexOf("export async function backfillWeekPlans("));
  assert.match(writer, /\bfreezeWeekPlans\s*\(/,
    "🔴 єдиний писар більше не пише — знімки не зʼявляться ніколи");
  assert.match(writer, /weekStart === today \? "live" : "backfill"/,
    "🔴 ярлик перестав розрізняти «спіймано в день старту» і «відновлено заднім числом» — "
    + "це тиха брехня про історію в обидва боки");

  // І писар мусить бути В РОЗКЛАДІ: джоба, яку ніхто не запускає, — це гудок,
  // відʼєднаний від сигналізації.
  const idx = noComments(src("index.ts"));
  assert.match(idx, /cron\.schedule\([^)]*\)[\s\S]{0,200}?freezeWeekPlanSnapshots\(/,
    "🔴 джоба знімків не стоїть у розкладі — читання вже не пише, а писати нікому");
  assert.match(idx, /freezeWeekPlanSnapshots\(\s*[2-9]\d*\s*\)/,
    "🔴 джоба закриває менше двох місяців: дірку створює НОВИЙ менеджер, і вона лежить "
    + "у місяцях ДО його найму — саме на них падав #211f");
});
