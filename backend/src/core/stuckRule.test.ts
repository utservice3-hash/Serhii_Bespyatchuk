import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AVTO_STATUSES, SCOPE_STATUSES, STUCK_MIN_DAYS, stuckBaseConds, callTargetConds,
  stuckSignals, stuckClock, stuckWorked, STAGE_MOVE, stageMoveCte,
} from "./stuckRule.js";

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
 * 🔁 МОДЕЛЬ 14.08.2026: активність = чат + дзвінок (≥10 c) + **рух етапу**; скоуп —
 * до «Виставлення рахунку» ВКЛЮЧНО; поріг ЄДИНИЙ (поділу 7/21 більше немає).
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
// ⚠️ ДЖЕРЕЛО, а не `dist`: тест біжить із `dist`, а перевіряє те, що написано в `src`.
// Та сама пастка вже спрацювала в `#69b` — шлях вів у `dist` і гейт падав з ENOENT.
const SRC = path.join(import.meta.dirname, "..", "..", "src");
const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

const FC = [8921932, 155304];
const AVTO = AVTO_STATUSES[0];      // «Авто працює» — ПОЗА скоупом
const EARLY = 69693668;             // «Взято на прорахунок»
const INVOICE = 100274340;          // «Виставлення рахунку» — МЕЖА скоупу, включно
const NOT_FC = 7777777;
const MD = 14;

/**
 * Фікстура: кожен рядок навантажує РІВНО ОДНУ умову правила. Прибери умову — і
 * відповідний рядок переїде з однієї множини в іншу, тобто саботаж почервоніє.
 * `move` — скільки днів тому востаннє переїжджала стадія (null = подій немає).
 */
const DEALS: { id: number; why: string; pipeline: number; status: number;
  act: number | null; move: number | null; created: number; stuck: boolean; call: boolean }[] = [
  { id: 201, why: "рання стадія, 40 днів без сигналів → застрягла", pipeline: 8921932, status: EARLY, act: 40, move: null, created: 60, stuck: true, call: true },
  { id: 202, why: "рання стадія, активність учора → НЕ застрягла", pipeline: 8921932, status: EARLY, act: 1, move: null, created: 60, stuck: false, call: true },
  { id: 203, why: "угоду не вели ЖОДНИМ сигналом → не «застрягла», а не почата", pipeline: 8921932, status: EARLY, act: null, move: null, created: 60, stuck: false, call: true },
  { id: 204, why: "paid → поза обома множинами", pipeline: 8921932, status: 142, act: 100, move: null, created: 60, stuck: false, call: false },
  { id: 205, why: "НЕ-FC воронка → поза обома (навантажує фільтр пайплайнів)", pipeline: NOT_FC, status: EARLY, act: 100, move: null, created: 60, stuck: false, call: false },
  { id: 206, why: "«Виставлення рахунку» — МЕЖА скоупу, 40 днів → застрягла", pipeline: 8921932, status: INVOICE, act: 40, move: null, created: 60, stuck: true, call: true },
  { id: 207, why: "рання стадія, 20 днів ≥ 14 → застрягла (на старому ×3 була б поза)", pipeline: 155304, status: 11804491, act: 20, move: null, created: 60, stuck: true, call: true },
  { id: 208, why: "рання стадія, 10 днів < 14 → ще НЕ застрягла", pipeline: 8921932, status: EARLY, act: 10, move: null, created: 60, stuck: false, call: true },
  { id: 209, why: "створена 200 днів тому → покинута, не «застрягла» (вікно 180)", pipeline: 8921932, status: EARLY, act: 100, move: null, created: 200, stuck: false, call: true },
  // ── 🔁 РУХ ЕТАПУ. Без нього 210 і 212 читались би зовсім інакше.
  { id: 210, why: "нотатка 40 днів тому, АЛЕ стадія переїхала 3 дні тому → рух є, не застрягла", pipeline: 8921932, status: EARLY, act: 40, move: 3, created: 60, stuck: false, call: true },
  { id: 211, why: "жодної нотатки, стадія переїхала 40 днів тому → вели й покинули → застрягла", pipeline: 8921932, status: EARLY, act: null, move: 40, created: 60, stuck: true, call: true },
  { id: 212, why: "нотатка вчора, старий переїзд 90 днів → рух етапу НЕ ЗНИЖУЄ годинник", pipeline: 8921932, status: EARLY, act: 1, move: 90, created: 100, stuck: false, call: true },
  // ── 🎯 СКОУП: те, що вже їде, — не наша тривога.
  { id: 213, why: "«Авто працює», 60 днів тиші → ПОЗА скоупом (після рахунку)", pipeline: 8921932, status: AVTO, act: 60, move: null, created: 90, stuck: false, call: true },
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
      [8921932, AVTO, "approved"], [8921932, EARLY, "lead_taken"], [8921932, INVOICE, "approved"],
      [8921932, 142, "paid"], [155304, 11804491, "lead_taken"], [NOT_FC, EARLY, "lead_taken"],
    ] as [number, number, string][])
      await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage)
                     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [p, s, stage]);
    for (const d of DEALS) {
      await c.query(
        `INSERT INTO deals (kommo_id,name,pipeline_id,status_id,price,created_at_kommo,last_activity_at)
         VALUES ($1,$2,$3,$4,1000,$5,$6)`,
        [d.id, d.why, d.pipeline, d.status, daysAgo(d.created), d.act == null ? null : daysAgo(d.act)]);
      if (d.move != null)
        await c.query(
          `INSERT INTO deal_stage_events (kommo_id,status_id,pipeline_id,changed_at)
           VALUES ($1,$2,$3,$4)`, [d.id, d.status, d.pipeline, daysAgo(d.move)]);
    }
    await fn(c);
  } finally { await c.end(); }
}

const ids = (r: { rows: { kommo_id: string }[] }) => r.rows.map((x) => Number(x.kommo_id)).sort((a, b) => a - b);

/** Список за спільним правилом (без Ringostat — його додає лише екран). */
async function listStuck(c: import("pg").Client): Promise<number[]> {
  const conds = stuckBaseConds({ pipelines: "$1", scopeStatuses: "$2", minDays: "$3", stageMove: STAGE_MOVE });
  const r = await c.query<{ kommo_id: string }>(
    `WITH ${stageMoveCte()}
     SELECT d.kommo_id FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       LEFT JOIN stage_move sm ON sm.kommo_id = d.kommo_id
      WHERE ${conds.join(" AND ")} ORDER BY d.kommo_id`,
    [FC, SCOPE_STATUSES, MD]);
  return ids(r);
}

test("#72 СКЛАД ЗАСТРЯГЛИХ — рівно той, що дає правило на кожній умові", async (t) => {
  await withScratch(t, async (c) => {
    const want = DEALS.filter((d) => d.stuck).map((d) => d.id);
    assert.deepEqual(await listStuck(c), want,
      "🔴 склад застряглих розійшовся з очікуваним — котрась із умов правила зникла або зайва.\n"
      + DEALS.map((d) => `   ${d.id}: ${d.why}`).join("\n"));
    // ⚠️ Порожній результат — ПРОВАЛ: гейт мусить мати що знаходити.
    assert.ok(want.length >= 3, "🔴 фікстура вироджена — доводити нема на чому");
  });
});

/**
 * #72e — 🔁 РУХ ЕТАПУ Є СИГНАЛОМ, І ВІН ГОДИННИК НЕ ЗНИЖУЄ.
 *
 * Два боки одного механізму, і кожен окремо зеленів би на зламаному другому:
 * прибереш сигнал зовсім — 210 (нотатка стара, стадія переїхала вчора) впаде в список;
 * зробиш його ЄДИНИМ (замість `GREATEST`) — 212 (нотатка вчора, переїзд 90 днів тому)
 * теж впаде, хоча менеджер працює з нею щодня.
 */
test("#72e РУХ ЕТАПУ ГАСИТЬ ТРИВОГУ, але не знижує годинник", async (t) => {
  await withScratch(t, async (c) => {
    const got = await listStuck(c);
    assert.ok(!got.includes(210),
      "🔴 угода 210 у списку: стадія переїхала 3 дні тому — рух етапу не зараховується активністю");
    assert.ok(got.includes(211),
      "🔴 угода 211 зникла: рух етапу 40 днів тому мусить ВІДКРИВАТИ гейт «угоду вели», "
      + "а не гасити тривогу — інакше угода без нотаток невидима назавжди");
    assert.ok(!got.includes(212),
      "🔴 угода 212 у списку: старий переїзд (90 днів) ЗНИЗИВ годинник попри вчорашню нотатку — "
      + "GREATEST замінено на щось, що бере не найсвіжіше");
    // 🪞 Дзеркало: приберемо подію в 210 — і вона мусить зʼявитись у списку. Без цього
    //    перевірка вище зеленіла б і тоді, коли 210 не потрапляє в список з іншої причини.
    await c.query(`DELETE FROM deal_stage_events WHERE kommo_id = 210`);
    assert.ok((await listStuck(c)).includes(210),
      "🔴 без події 210 усе одно поза списком — отже вище доводилось не те");
  });
});

test("#72b ЗАСТРЯГЛІ ⊆ ТІ, КОМУ ДЖОБА ПИШЕ last_call_at", async (t) => {
  await withScratch(t, async (c) => {
    const stuck = await listStuck(c);
    const target = await c.query<{ kommo_id: string }>(
      `SELECT d.kommo_id FROM deals d, pipeline_stage_map psm
        WHERE ${callTargetConds({ deal: "d", psm: "psm", pipelines: "$1" }).join(" AND ")}
        ORDER BY d.kommo_id`,
      [FC]);
    const targetSet = new Set(ids(target));
    assert.deepEqual(ids(target), DEALS.filter((d) => d.call).map((d) => d.id),
      "🔴 множина, якій пишеться last_call_at, розійшлась з очікуваною");
    for (const id of stuck)
      assert.ok(targetSet.has(id),
        `🔴 угода ${id} показується як застрягла, але last_call_at їй НЕ пишеться — `
        + "колонка «остання розмова» буде порожня саме там, де потрібна");
    // 🪞 Строга ширшість: інакше вкладеність доводила б лише те, що множини рівні.
    // Вона тепер і за побудовою більша — скоуп списку вужчий за «кому пишемо дзвінок»
    // («Авто працює» дзвінок отримує, у списку не зʼявляється), і це СВІДОМО.
    assert.ok(targetSet.size > stuck.length,
      "🔴 множини збіглися повністю — фікстура вироджена, вкладеність нічого не доводить");
  });
});

/**
 * #72c — ЛІЧИЛЬНИК ВІДРАХОВУЄТЬСЯ ВІД `asOf`, А НЕ ВІД ЗАШИТОГО `now()`.
 * Під час простою синку годинник іде, а дані — ні; без анкера список роздувався б.
 */
test("#72c ВІК РАХУЄТЬСЯ ВІД ПЕРЕДАНОГО АНКЕРА, а не від зашитого now()", () => {
  const base = { pipelines: "$1", scopeStatuses: "$2", minDays: "$3", stageMove: STAGE_MOVE };
  const sql = stuckBaseConds({ ...base, asOf: "$4" }).join(" AND ");
  // ⚠️ `now()` у CTE руху етапу — ІНША річ (межа сканування, не вік), і сюди вона не
  //    потрапляє: CTE будується окремою функцією.
  assert.ok(!/\bnow\(\)/.test(sql),
    `🔴 у правилі лишився зашитий now() попри переданий anchor — під час простою синку `
    + `лічильник ростиме сам собою:\n${sql}`);
  assert.equal((sql.match(/\$4/g) ?? []).length, 2,
    "🔴 анкер підставився не в усі умови віку (їх дві: поріг активності і вікно 180 днів)");
  // Дзеркало: без анкера правило лишається на now() — щоб перша умова не зеленіла тривіально.
  assert.ok(/\bnow\(\)/.test(stuckBaseConds(base).join(" AND ")),
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
  for (const lit of ["funnel_stage <> 'paid'", "180 days", "deal_stage_events", "100274340"])
    assert.ok(rule.includes(lit), `🔴 «${lit}» зник із core/stuckRule.ts — перевірка нижче порожня`);

  const metrics = readFileSync(path.join(SRC, "core", "metrics.ts"), "utf8");
  const job = readFileSync(path.join(SRC, "jobs", "syncDealActivity.ts"), "utf8");
  assert.equal((metrics.match(/stuckBaseConds\(/g) ?? []).length, 2,
    "🔴 не обидві поверхні списку кличуть stuckBaseConds (легасі + екран)");
  assert.equal((metrics.match(/stageMoveCte\(\)/g) ?? []).length, 2,
    "🔴 не обидві поверхні беруть рух етапу зі спільного CTE — сигнал розійдеться між ними мовчки");
  assert.ok(!/stage_move AS \(/.test(metrics),
    "🔴 у metrics.ts зʼявився власний CTE руху етапу — це знову копія правила");
  assert.ok(job.includes("callTargetConds("),
    "🔴 джоба не кличе callTargetConds — предикат знову свій");
  assert.ok(!/interval '180 days'/.test(metrics),
    "🔴 у metrics.ts зʼявилось власне вікно 180 днів — це знову копія правила");
  assert.ok(!/funnel_stage <> 'paid'/.test(job),
    "🔴 у syncDealActivity.ts зʼявився власний предикат — саме ця копія тихо не пише дані");
  assert.ok(!/const FC_PIPELINES\s*=/.test(job),
    "🔴 у джобі знову власний список FC-воронок — розійдеться з ядром мовчки");
});

/**
 * #72f — 🎯 СКОУП ЗАМКНЕНО НА МАПІНГУ, А НЕ НА ДОВІРІ ДО ПЕРЕЛІКУ.
 *
 * 🔴 НАВІЩО. Скоуп — це список статусів, який редагують руками, а поруч у правилі
 * стоїть `funnel_stage <> 'paid'`. Якби в перелік випадково потрапив оплачений статус,
 * цей сусід тихо його погасив би — і рубіж, поставлений як ДРУГИЙ, мовчки почав би
 * працювати як ПЕРШИЙ, приховуючи помилку в переліку. Тому перелік звіряється з
 * реальним мапінгом, а не з наміром.
 *
 * ⚠️ Читаємо `seedKommoMapping.sql` — те саме джерело, з якого мапінг їде в БД.
 */
test("#72f СКОУП: до «Виставлення рахунку» включно, операційні — поза", () => {
  const seed = readFileSync(path.join(SRC, "db", "seedKommoMapping.sql"), "utf8");
  const rows = [...seed.matchAll(/\((\d+),\s*(\d+),\s*'(\w+)'\)/g)]
    .map((m) => ({ pipeline: Number(m[1]), status: Number(m[2]), stage: m[3] }));
  assert.ok(rows.length > 20, "🔴 мапінг не розібрався — гейт порожній");
  const byStatus = new Map(rows.filter((r) => FC.includes(r.pipeline)).map((r) => [r.status, r]));

  for (const st of SCOPE_STATUSES) {
    const row = byStatus.get(st);
    assert.ok(row, `🔴 статус ${st} зі скоупу відсутній у мапінгу FC-воронок — його «стадія» невідома`);
    assert.notEqual(row!.stage, "paid",
      `🔴 у скоуп потрапив ОПЛАЧЕНИЙ статус ${st} — його мовчки гасить сусідній «<> 'paid'», `
      + "тобто помилка переліку не була б видна");
    assert.notEqual(row!.stage, "invoiced",
      `🔴 у скоуп потрапив статус ${st} стадії «invoiced» — це вже ПІСЛЯ розвантаження, `
      + "межа проходить по «Виставлення рахунку» ДО відправки");
  }
  // 🎯 Операційні («Авто працює», «Перевезення завершено») — строго поза.
  for (const st of AVTO_STATUSES)
    assert.ok(!SCOPE_STATUSES.includes(st),
      `🔴 операційний статус ${st} заліз у скоуп — список знову показує те, що вже їде`);
  // Межа В СКОУПІ, і саме вона робить його «включно».
  assert.ok(SCOPE_STATUSES.includes(100274340),
    "🔴 «Виставлення рахунку» (100274340) випало зі скоупу — межа стала «до», а не «включно»");
  // ⚠️ Обидві воронки представлені: список лише з нової тихо загубив би стару.
  for (const p of FC)
    assert.ok(rows.some((r) => r.pipeline === p && SCOPE_STATUSES.includes(r.status)),
      `🔴 у скоупі немає жодного статусу воронки ${p}`);
});

/**
 * #72g — ⏳ ПОРІГ ЄДИНИЙ І Є ПАРАМЕТРОМ.
 *
 * 🔴 Вимога власника 14.08.2026: не хардкодити поріг під замір «383», зроблений БЕЗ
 * сигналу «рух етапу». Число обирається проти ЖИВОГО списку (14/21/30) до мержу, тож
 * воно мусить лишатись параметром, а не осісти в SQL.
 */
test("#72g ПОРІГ ЄДИНИЙ, ПАРАМЕТРОМ, поділу 7/21 більше немає", () => {
  const sql = stuckBaseConds({ pipelines: "$1", scopeStatuses: "$2", minDays: "$3", stageMove: STAGE_MOVE }).join(" AND ");
  assert.ok(!/CASE WHEN/.test(sql),
    `🔴 у правилі знову розгалуження порогу — «до рахунку» це один етап роботи менеджера:\n${sql}`);
  assert.ok(!/\* 3\b|\* *3 END/.test(sql), "🔴 у правилі лишився множник ×3 старого поділу");
  assert.equal((sql.match(/\$3/g) ?? []).length, 1, "🔴 поріг підставляється не рівно один раз");
  // Дефолт — названа константа, а не число в сигнатурі роутів.
  assert.equal(STUCK_MIN_DAYS, 14);
  const routes = readFileSync(path.join(SRC, "routes", "dashboard.ts"), "utf8");
  assert.ok(!/Number\(req\.query\.minDays\) \|\| \d/.test(routes),
    "🔴 у роуті лишилось зашите число порогу — воно розійдеться з ядром мовчки");
  assert.equal((routes.match(/STUCK_MIN_DAYS/g) ?? []).length, 2,
    "🔴 не обидва роути беруть дефолт із ядра");

  // 🪞 І ЕКРАН ТЕЖ. Підпис, що називає поріг своїм числом, брехатиме мовчки з першої ж
  //    зміни `?minDays=` — рівно як хвіст «(2 год тому)» із зашитими 4 годинами (#74c).
  const fe = readFileSync(path.join(SRC, "..", "..", "frontend", "src", "pages",
    "dashboard", "sections", "ReportPlanSection.tsx"), "utf8");
  const block = fe.slice(fe.indexOf("🕐 Застряглі угоди"), fe.indexOf("дані станом на"));
  assert.ok(block.length > 200, "🔴 блок підпису критерію зник — перевіряти нема чого");
  assert.ok(/data\?\.minDays/.test(block),
    "🔴 підпис не бере поріг із відповіді сервера — отже називає своє число");
  assert.ok(!/≥\s*\d+\s*дн|\b21 дн\b/.test(block),
    `🔴 у підписі лишилось зашите число днів — воно розійдеться з ядром при першій зміні порога:\n${block}`);
});

/**
 * #72h — 🧩 ГОДИННИК І «ЧИ ВЕЛИ» РОСТУТЬ З ОДНОГО ПЕРЕЛІКУ СИГНАЛІВ.
 *
 * 🔴 Це той самий клас, що чипи «новий/постійний»: два вирази, що відповідають на одне
 * питання, розходяться мовчки. Тут вони обидва беруться з `stuckSignals`, і гейт
 * доводить саме це — додав сигнал у перелік, і він зʼявився в ОБОХ.
 */
test("#72h СИГНАЛИ — ОДИН ПЕРЕЛІК на годинник і на «угоду вели»", () => {
  const sig = stuckSignals({ stageMove: STAGE_MOVE, talk: "TALK" });
  assert.deepEqual(sig, ["d.last_activity_at", STAGE_MOVE, "TALK"]);
  // Без розмови (легасі-поверхня) перелік коротший рівно на неї.
  assert.deepEqual(stuckSignals({ stageMove: STAGE_MOVE }), ["d.last_activity_at", STAGE_MOVE]);
  for (const s of sig) {
    assert.ok(stuckClock(sig).includes(s), `🔴 сигнал ${s} не входить у годинник`);
    assert.ok(stuckWorked(sig).includes(s), `🔴 сигнал ${s} не входить у гейт «угоду вели»`);
  }
  // Годинник падає на створення, лише коли сигналів НЕМА ЖОДНОГО.
  assert.match(stuckClock(sig), /^COALESCE\(GREATEST\(.*\), d\.created_at_kommo\)$/,
    "🔴 форма годинника змінилась: `created_at_kommo` мусить бути ФОЛБЕКОМ, а не операндом "
    + "GREATEST — інакше угода, створена пізніше за свій останній сигнал, виглядала б свіжою");
  assert.match(stuckWorked(sig), /IS NOT NULL$/);
});
