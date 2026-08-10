import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AVTO_STATUSES, stuckBaseConds, callTargetConds } from "./stuckRule.js";

/**
 * #72 — ПРАВИЛО «ЗАСТРЯГЛОЇ УГОДИ» ОДНЕ, І ВОНО ЗБІГАЄТЬСЯ З ТИМ, ЯКИМ УГОДАМ
 * ПИШЕТЬСЯ `last_call_at`.
 *
 * 🔴 ПРИВІД. Критерій жив у трьох місцях: легасі-роут `/stuck-deals`, екран Звіту
 * (`stuckDealsGrouped`) і — ПРИХОВАНО — джоба `syncDealActivity`, що вирішує, кому
 * взагалі записати `last_call_at`. Третя копія найнебезпечніша: вона не ламає екран,
 * а тихо не записує дані. Розійдись вона зі списком — колонка «остання розмова» була б
 * порожня саме на тих угодах, заради яких її й заводили, і жоден тест би не почервонів.
 *
 * 🔴 ГЕЙТ НА ПРАВИЛІ, А НЕ НА ЖИВІЙ ВИБІРЦІ (той самий принцип, що `#66`). Живий
 * прод дає 147 угод сьогодні й 245 учора — гейт на цих числах червонів би від роботи
 * менеджерів, а не від регресії. Тому: фікстура, що навантажує КОЖНУ умову правила,
 * і перевірка ВКЛАДЕНОСТІ двох множин.
 *
 * 🪞 ДЗЕРКАЛО ОБОВʼЯЗКОВЕ (`#72c`). «Застряглі ⊆ ті, кому пишемо дзвінок» зеленіє
 * і тоді, коли застряглих НУЛЬ, і тоді, коли обидві множини — та сама вироджена
 * вибірка. Тому поруч стоїть вимога: множина `last_call_at` СТРОГО ширша, а склад
 * застряглих — рівно очікуваний.
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
// ⚠️ ДЖЕРЕЛО, а не `dist`: тест біжить із `dist`, а перевіряє те, що написано в `src`.
// Та сама пастка вже спрацювала в `#69b` — шлях вів у `dist` і гейт падав з ENOENT.
const SRC = path.join(import.meta.dirname, "..", "..", "src");
const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

const FC = [8921932, 155304];
const AVTO = AVTO_STATUSES[0];      // «Авто працює» — грошовий поріг (minDays)
const EARLY = 69693668;             // «Взято в роботу» — рання стадія (minDays × 3)
const NOT_FC = 7777777;

/**
 * Фікстура: кожен рядок навантажує РІВНО ОДНУ умову правила. Прибери умову — і
 * відповідний рядок переїде з однієї множини в іншу, тобто саботаж почервоніє.
 */
const DEALS: { id: number; why: string; pipeline: number; status: number; act: number | null; created: number; stuck: boolean; call: boolean }[] = [
  { id: 201, why: "авто працює, 40 днів без активності → поріг minDays", pipeline: 8921932, status: AVTO, act: 40, created: 60, stuck: true, call: true },
  { id: 202, why: "авто працює, активність учора → активна, але НЕ застрягла", pipeline: 8921932, status: AVTO, act: 1, created: 60, stuck: false, call: true },
  { id: 203, why: "рання стадія, угоду ще НЕ вели (act=NULL) → не застрягла", pipeline: 8921932, status: EARLY, act: null, created: 60, stuck: false, call: true },
  { id: 204, why: "paid → поза обома множинами", pipeline: 8921932, status: 142, act: 100, created: 60, stuck: false, call: false },
  { id: 205, why: "НЕ-FC воронка → поза обома (навантажує фільтр пайплайнів)", pipeline: NOT_FC, status: AVTO, act: 100, created: 60, stuck: false, call: false },
  { id: 206, why: "рання стадія, 40 днів ≥ minDays×3 → застрягла", pipeline: 155304, status: EARLY, act: 40, created: 60, stuck: true, call: true },
  { id: 207, why: "рання стадія, 15 днів < minDays×3 → ще НЕ застрягла", pipeline: 8921932, status: EARLY, act: 15, created: 60, stuck: false, call: true },
  { id: 208, why: "створена 200 днів тому → покинута, не «застрягла» (вікно 180)", pipeline: 8921932, status: AVTO, act: 100, created: 200, stuck: false, call: true },
];

async function withScratch(t: { skip: (m: string) => void },
  fn: (c: import("pg").Client) => Promise<void>): Promise<void> {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(scratch.unavailable);
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    for (const [p, s, stage] of [
      [8921932, AVTO, "approved"], [8921932, EARLY, "lead_taken"], [8921932, 142, "paid"],
      [155304, EARLY, "lead_taken"], [NOT_FC, AVTO, "approved"],
    ] as [number, number, string][])
      await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage)
                     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [p, s, stage]);
    for (const d of DEALS)
      await c.query(
        `INSERT INTO deals (kommo_id,name,pipeline_id,status_id,price,created_at_kommo,last_activity_at)
         VALUES ($1,$2,$3,$4,1000,$5,$6)`,
        [d.id, d.why, d.pipeline, d.status, daysAgo(d.created), d.act == null ? null : daysAgo(d.act)]);
    await fn(c);
  } finally { await c.end(); }
}

const ids = (r: { rows: { kommo_id: string }[] }) => r.rows.map((x) => Number(x.kommo_id)).sort((a, b) => a - b);

test("#72 СКЛАД ЗАСТРЯГЛИХ — рівно той, що дає правило на кожній умові", async (t) => {
  await withScratch(t, async (c) => {
    const conds = stuckBaseConds({ pipelines: "$1", avtoStatuses: "$2", minDays: "$3" });
    const r = await c.query<{ kommo_id: string }>(
      `SELECT d.kommo_id FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${conds.join(" AND ")} ORDER BY d.kommo_id`,
      [FC, AVTO_STATUSES, 7]);
    const want = DEALS.filter((d) => d.stuck).map((d) => d.id);
    assert.deepEqual(ids(r), want,
      "🔴 склад застряглих розійшовся з очікуваним — котрась із умов правила зникла або зайва.\n"
      + DEALS.map((d) => `   ${d.id}: ${d.why}`).join("\n"));
    // ⚠️ Порожній результат — ПРОВАЛ: гейт мусить мати що знаходити.
    assert.ok(want.length >= 2, "🔴 фікстура не навантажує обидва пороги (minDays і minDays×3)");
  });
});

test("#72b ЗАСТРЯГЛІ ⊆ ТІ, КОМУ ДЖОБА ПИШЕ last_call_at", async (t) => {
  await withScratch(t, async (c) => {
    const stuck = await c.query<{ kommo_id: string }>(
      `SELECT d.kommo_id FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${stuckBaseConds({ pipelines: "$1", avtoStatuses: "$2", minDays: "$3" }).join(" AND ")}
        ORDER BY d.kommo_id`,
      [FC, AVTO_STATUSES, 7]);
    const target = await c.query<{ kommo_id: string }>(
      `SELECT d.kommo_id FROM deals d, pipeline_stage_map psm
        WHERE ${callTargetConds({ deal: "d", psm: "psm", pipelines: "$1" }).join(" AND ")}
        ORDER BY d.kommo_id`,
      [FC]);
    const targetSet = new Set(ids(target));
    assert.deepEqual(ids(target), DEALS.filter((d) => d.call).map((d) => d.id),
      "🔴 множина, якій пишеться last_call_at, розійшлась з очікуваною");
    for (const id of ids(stuck))
      assert.ok(targetSet.has(id),
        `🔴 угода ${id} показується як застрягла, але last_call_at їй НЕ пишеться — `
        + "колонка «остання розмова» буде порожня саме там, де потрібна");
    // 🪞 Строга ширшість: інакше вкладеність доводила б лише те, що множини рівні.
    assert.ok(targetSet.size > ids(stuck).length,
      "🔴 множини збіглися повністю — фікстура вироджена, вкладеність нічого не доводить");
  });
});

/**
 * #72c — ЛІЧИЛЬНИК ВІДРАХОВУЄТЬСЯ ВІД `asOf`, А НЕ ВІД ЗАШИТОГО `now()`.
 *
 * Це гейт НА МАЙБУТНЄ, і саме тому він тут: другий коміт міняє анкер віку з `now()`
 * на час останнього успішного синку, щоб під час простою лічильник не роздувався.
 * Зміна мусить бути ОДНИМ рядком в одному місці — а не полюванням по трьох копіях,
 * де одну забудеш і вона тихо лишиться на `now()`.
 */
test("#72c ВІК РАХУЄТЬСЯ ВІД ПЕРЕДАНОГО АНКЕРА, а не від зашитого now()", () => {
  const sql = stuckBaseConds({ pipelines: "$1", avtoStatuses: "$2", minDays: "$3", asOf: "$4" }).join(" AND ");
  assert.ok(!/\bnow\(\)/.test(sql),
    `🔴 у правилі лишився зашитий now() попри переданий anchor — під час простою синку `
    + `лічильник ростиме сам собою:\n${sql}`);
  assert.equal((sql.match(/\$4/g) ?? []).length, 2,
    "🔴 анкер підставився не в усі умови віку (їх дві: поріг активності і вікно 180 днів)");
  // Дзеркало: без анкера правило лишається на now() — щоб перша умова не зеленіла тривіально.
  assert.ok(/\bnow\(\)/.test(stuckBaseConds({ pipelines: "$1", avtoStatuses: "$2", minDays: "$3" }).join(" AND ")),
    "🔴 без asOf правило не спирається на now() — тоді перевірка вище нічого не доводить");
});

/**
 * #72d — ЖОДНА ПОВЕРХНЯ НЕ ПИШЕ ПРАВИЛО ЗАНОВО.
 * Перевірка по ДЖЕРЕЛУ, а не по поведінці: копію, що зʼявиться завтра, поведінковий
 * тест зловить лише тоді, коли вона вже розійдеться. Тут — одразу.
 */
test("#72d ПРАВИЛО НЕ ДУБЛЮЄТЬСЯ: поверхні кличуть stuckRule, а не пишуть SQL", () => {
  const rule = readFileSync(path.join(SRC, "core", "stuckRule.ts"), "utf8");
  // ⚠️ Спершу доводимо, що ШУКАТИ БУЛО ЩО: літерали живуть у правилі.
  for (const lit of ["funnel_stage <> 'paid'", "180 days", "69716300"])
    assert.ok(rule.includes(lit), `🔴 «${lit}» зник із core/stuckRule.ts — перевірка нижче порожня`);

  const metrics = readFileSync(path.join(SRC, "core", "metrics.ts"), "utf8");
  const job = readFileSync(path.join(SRC, "jobs", "syncDealActivity.ts"), "utf8");
  assert.equal((metrics.match(/stuckBaseConds\(/g) ?? []).length, 2,
    "🔴 не обидві поверхні списку кличуть stuckBaseConds (легасі + екран)");
  assert.ok(job.includes("callTargetConds("),
    "🔴 джоба не кличе callTargetConds — предикат знову свій");
  assert.ok(!/interval '180 days'/.test(metrics),
    "🔴 у metrics.ts зʼявилось власне вікно 180 днів — це знову копія правила");
  assert.ok(!/funnel_stage <> 'paid'/.test(job),
    "🔴 у syncDealActivity.ts зʼявився власний предикат — саме ця копія тихо не пише дані");
  assert.ok(!/const FC_PIPELINES\s*=/.test(job),
    "🔴 у джобі знову власний список FC-воронок — розійдеться з ядром мовчки");
});
