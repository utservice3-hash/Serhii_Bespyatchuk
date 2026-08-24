import { test, after } from "node:test";
import assert from "node:assert/strict";
import { skipReason, type Unavailable } from "../db/scratchDb.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SCOPE_STATUSES, STUCK_MIN_DAYS, CALL_MIN_SEC, callCountsAsActivity, stuckBaseConds,
  ASOF_SQL, ringostatTalkCte, ASOF_JOBS, asOfStaleAfterMin,
  stageMoveCte, STAGE_MOVE, TALK_ATTRIBUTED, stuckClock, stuckSignals,
} from "./stuckRule.js";

/**
 * #73 — ФАЗА 3, ДРУГИЙ КОМІТ: РОЗМОВА ВІД 10 c · ВІК ВІД СИНКУ · RINGOSTAT.
 *
 * 🔴 ФІКСТУРА РОЗМІРУ РЕАЛЬНОСТІ — вимога власника, і вона з крові. Сьогодні замала
 * фікстура двічі сховала баг: у `#70` вісім каталогів при `KEEP = 14` робили
 * `N − KEEP = 0`, тож саботаж не червонів. Тому тут не «дві угоди на випадок», а
 * набір, у якому КОЖНА умова має і того, хто її проходить, і того, хто ні, а вік
 * заданий так, щоб зсув анкера на 15 годин ПЕРЕТИНАВ поріг, а не лишався в його межах.
 *
 * Що доводиться (кожен пункт названий власником):
 *   #73  — дзвінок 0 c більше не активність (і не є нею на 9 c, а на 10 c — є);
 *   #73b — вік від часу СИНКУ: при штучно застарілому синку лічильник НЕ росте;
 *   #73c — Ringostat гасить лише при ОДНІЙ відкритій угоді;
 *   #73d — гасіння на клієнті з кількома угодами не спрацьовує (позначка замість тиші).
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
const SRC = path.join(import.meta.dirname, "..", "..", "src");
const H = 3600_000, DAY = 24 * H;
const FC = [8921932, 155304];
// 🎯 Обидва — У СКОУПІ (до «Виставлення рахунку» включно). «Авто працює» більше не
//    в критерії, тож фікстура на ньому доводила б поведінку, якої немає.
const INVOICE = 100274340;          // «Виставлення рахунку» — межа скоупу
const EARLY = 69693668;             // «Взято на прорахунок»

/**
 * 15 годин — тривалість аварії №2 (09-10.08.2026, синк стояв 15 год 13 хв). Вік угод
 * підібрано так, щоб цей зсув ПЕРЕТИНАВ поріг: інакше «лічильник не росте» зеленіло б
 * саме тому, що рости нікуди.
 */
const OUTAGE_H = 15;
const MIN_DAYS = STUCK_MIN_DAYS;   // 21 — ЄДИНИЙ поріг, поділу 7/21 більше немає
/**
 * 🔴 ВІК УГОД ФІКСТУРИ ВІДЛІЧУЄТЬСЯ ВІД ПОРОГА, А НЕ ВІД ЧИСЛА 14.
 *
 * Було: `actH: 14 * 24 + 3`. Поки дефолт дорівнював 14, це виглядало бездоганно — і
 * розсипалось у той самий день, коли власник обрав 21: «на межі» опинилось на 165 год
 * НИЖЧЕ порога, тобто гейт червонів би не через регрес, а через фікстуру. Той самий
 * клас, що зашите «4 години» в підписі (#74c) і зашитий поріг у роуті (#72g): число
 * скопійоване туди, де мусило бути посилання.
 *
 * `T` — поріг У ГОДИНАХ. Усі «межові» випадки живуть у вікні `T … T + OUTAGE_H`, бо
 * саме це вікно й доводить #73b: за 15 год простою синку вони перетинають поріг.
 */
const T = MIN_DAYS * 24;

type D = { id: number; why: string; status: number; actH: number; ck: string | null };
/** Кожна угода названа тим, що саме вона доводить. `actH` — годин від «зараз». */
const DEALS: D[] = [
  // ── ТРОЄ НА МЕЖІ: вік між порогом і порогом+15 год. Саме вони показують роздування:
  //    «зараз» вони застряглі, «на момент синку 15 год тому» — ще ні.
  { id: 301, why: "рахунок, поріг + 3 год: перетнула поріг ЗА останні 15 год", status: INVOICE, actH: T + 3, ck: "клієнта" },
  { id: 311, why: "рахунок, поріг + 10 год: те саме, друга на межі", status: INVOICE, actH: T + 10, ck: "клієнте" },
  { id: 312, why: "рання, поріг + 5 год: ТОЙ САМИЙ поріг (поділу ×3 більше немає)", status: EARLY, actH: T + 5, ck: "клієнтж" },
  // ── СТАБІЛЬНІ: застряглі за будь-якого анкера.
  { id: 302, why: "рахунок, поріг + 30 год: застрягла за будь-якого анкера", status: INVOICE, actH: T + 30, ck: "клієнтб" },
  { id: 305, why: "рання, поріг + 8 діб: застрягла за будь-якого анкера", status: EARLY, actH: T + 8 * 24, ck: "клієнтд" },
  // ── СВІЖІ: не застряглі за будь-якого анкера.
  { id: 303, why: "рахунок, активність 2 год тому: свіжа за будь-якого анкера", status: INVOICE, actH: 2, ck: "клієнтв" },
  { id: 304, why: "рання, поріг − 1 доба → не застрягла", status: EARLY, actH: T - 24, ck: "клієнтг" },
  { id: 313, why: "рахунок, поріг − 40 год: 15 год простою його НЕ дотягують", status: INVOICE, actH: T - 40, ck: "клієнтз" },
  // ── RINGOSTAT: чотири випадки привʼязки розмови.
  { id: 306, why: "застрягла, клієнт з ОДНІЄЮ угодою і свіжою розмовою → гаситься", status: INVOICE, actH: T + 16 * 24, ck: "розмоводин" },
  { id: 307, why: "застрягла, клієнт з ДВОМА угодами і свіжою розмовою → НЕ гаситься", status: INVOICE, actH: T + 16 * 24, ck: "розмовдва" },
  { id: 308, why: "друга угода того самого клієнта — вона й робить привʼязку неоднозначною", status: INVOICE, actH: T + 17 * 24, ck: "розмовдва" },
  { id: 309, why: "застрягла, розмова СТАРІША за анкер → не гасить", status: INVOICE, actH: T + 16 * 24, ck: "розмовстар" },
  { id: 310, why: "застрягла без client_key → Ringostat до неї не дотягнеться", status: INVOICE, actH: T + 16 * 24, ck: null },
];
/** Розмови Ringostat: клієнт → скільки годин тому, скільки секунд. */
const TALKS: [string, number, number][] = [
  ["розмоводин", 3, 120],   // свіжа й однозначна
  ["розмовдва", 3, 120],    // свіжа, але клієнт має дві відкриті угоди
  // 🔴 «Давня» — теж ВІД ПОРОГА, а не 60 діб константою: вона мусить лишатись старішою
  //    за угоду 309 (`T + 16 діб`) при БУДЬ-ЯКОМУ порозі, інакше замість «не гасить»
  //    фікстура почала б доводити протилежне — і мовчки.
  ["розмовстар", T + 30 * 24, 120], // давня — анкер не зрушить
  ["клієнта", 90 * 24, 0],  // 0 c: не розмова, у CTE не потрапляє взагалі
];

/**
 * 🔴 ОДИН КЛАСТЕР НА ФАЙЛ, А НЕ НА ТЕСТ.
 *
 * `db/pool.js` — модульний синглтон: він прибивається до того `DATABASE_URL`, який
 * діяв на ПЕРШОМУ імпорті. Поки кожен тест піднімав власну пісочницю, через `pool`
 * міг ходити рівно один із них — решта читала б чужу (уже знесену) базу й зеленіла
 * б на порожньому. Тепер кластер один, тож `pool` вказує туди ж, куди й прямий
 * клієнт `c`, і БД-тестів у файлі може бути скільки треба.
 *
 * Побічно це вп'ятеро дешевше: було пʼять `initdb` на файл, стало один.
 */
let shared: { url: string; dispose: () => void } | Unavailable | null = null;
/**
 * ⚠️ ПУЛ ЗАКРИВАЄМО ПЕРШИМ, кластер — другим. Знесений кластер обриває зʼєднання,
 * що лишились у пулі, і `Connection terminated unexpectedly` прилітає ПІСЛЯ
 * завершення тесту — тобто як uncaughtException, який валить весь файл при восьми
 * зелених тестах. Спіймано одразу після переходу на спільний кластер.
 */
let poolUsed = false;
after(async () => {
  if (poolUsed) await (await import("../db/pool.js")).pool.end();
  if (shared && !("unavailable" in shared)) shared.dispose();
});

async function withScratch(t: { skip: (m: string) => void },
  fn: (c: import("pg").Client, now: number) => Promise<void>): Promise<void> {
  if (shared == null) {
    const { provisionScratch } = await import("../db/scratchDb.js");
    shared = provisionScratch();
  }
  const scratch = shared;
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  // ⚠️ `metrics.js` тягне `db/pool.js` → `config.js`, який кидає на відсутньому
  // DATABASE_URL ще НА ІМПОРТІ (пастка спрацювала за сесію вже пʼятий раз).
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  const now = Date.now();
  try {
    // Кластер спільний, тож кожен тест починає з чистого аркуша сам.
    await c.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await c.query(readFileSync(SCHEMA, "utf8"));
    // ⚠️ Команда 13 — РНК за `RNK_TEAM_IDS`, і це не декорація: `stuckDealsGrouped`
    //    показує НЕ-РНК лише лідоген-угоди, тож на довільному team_id список був би
    //    порожній, а гейт зеленів би «бо нічого не знайшлось».
    await c.query(`INSERT INTO teams (id,name) VALUES (13,'РНК-тест') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'М',13,true) ON CONFLICT DO NOTHING`);
    for (const [p, st, stage] of [[8921932, INVOICE, "approved"], [8921932, EARLY, "lead_taken"], [8921932, 142, "paid"]] as [number, number, string][])
      await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [p, st, stage]);
    for (const d of DEALS)
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,
                            created_at_kommo,last_activity_at)
         VALUES ($1,$2,10,8921932,$3,1000,$4,$5,$6)`,
        [d.id, d.why, d.status, d.ck, new Date(now - 100 * DAY), new Date(now - d.actH * H)]);
    let i = 0;
    for (const [ck, hoursAgo, sec] of TALKS)
      await c.query(
        `INSERT INTO ringostat_calls (uniqueid,calldate,call_type,billsec,duration,client_key)
         VALUES ($1,$2,'in',$3,$3,$4)`,
        [`u${i++}`, new Date(now - hoursAgo * H), sec, ck]);
    await fn(c, now);
  } finally { await c.end(); }
}

/** Список за правилом екрана: анкер `asOf`, сигнали з рухом етапу й однозначною розмовою. */
async function screen(c: import("pg").Client, asOf: string, params: unknown[] = []): Promise<number[]> {
  const conds = stuckBaseConds({ pipelines: "$1", scopeStatuses: "$2", minDays: "$3", asOf,
    stageMove: STAGE_MOVE, talk: TALK_ATTRIBUTED });
  const r = await c.query<{ kommo_id: string }>(
    `WITH ${ringostatTalkCte({ pipelines: "$1" })}, ${stageMoveCte()}
     SELECT d.kommo_id FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       LEFT JOIN talk tk ON tk.client_key = d.client_key
       LEFT JOIN open_cnt oc ON oc.client_key = d.client_key
       LEFT JOIN stage_move sm ON sm.kommo_id = d.kommo_id
      WHERE ${conds.join(" AND ")} ORDER BY d.kommo_id`,
    [FC, SCOPE_STATUSES, MIN_DAYS, ...params]);
  return r.rows.map((x) => Number(x.kommo_id));
}

test("#73 ДЗВІНОК КОРОТШИЙ ЗА 10 c НЕ Є АКТИВНІСТЮ", () => {
  assert.equal(CALL_MIN_SEC, 10);
  assert.equal(callCountsAsActivity(0), false, "🔴 недодзвон 0 c зарахований активністю — саме він ховав 83 угоди");
  assert.equal(callCountsAsActivity(9), false, "🔴 9 c не є розмовою");
  assert.equal(callCountsAsActivity(10), true, "🔴 рівно поріг МУСИТЬ рахуватись, інакше межа зсунута");
  assert.equal(callCountsAsActivity(600), true);
  // ⚠️ Невідома тривалість — НЕ недодзвон. Інакше прогалина в даних читалась би як
  // «не дзвонив», і ми б вигадали застій там, де його не знаємо.
  assert.equal(callCountsAsActivity(null), true, "🔴 невідома тривалість прирівняна до недодзвону");
  assert.equal(callCountsAsActivity(undefined), true);

  // ДЖЕРЕЛО: джоба мусить кликати правило, а не тримати власне число.
  const job = readFileSync(path.join(SRC, "jobs", "syncDealActivity.ts"), "utf8");
  assert.ok(job.includes("callCountsAsActivity("), "🔴 джоба не кличе правило порогу");
  assert.ok(!/[^_A-Za-z]10\s*\)|>=\s*10\b/.test(job.replace(/CALL_MIN_SEC/g, "")),
    "🔴 у джобі зʼявилось власне число порогу — розійдеться з правилом мовчки");
});

test("#73b ВІК РАХУЄТЬСЯ ВІД СИНКУ: застарілий синк НЕ роздуває лічильник", async (t) => {
  await withScratch(t, async (c, now) => {
    const setSync = (d: Date) => c.query(
      `INSERT INTO job_runs (name,last_success_at)
       VALUES ('syncKommo',$1),('syncDealActivity',$1),('syncStageEvents',$1)
       ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`, [d]);

    // Контроль: синк «щойно» — анкер і годинник мусять давати ОДНЕ Й ТЕ САМЕ.
    await setSync(new Date(now));
    const byClock = await screen(c, "now()");
    assert.deepEqual(await screen(c, ASOF_SQL), byClock,
      "🔴 при свіжому синку asOf дав не те, що now() — анкер читається неправильно");

    /**
     * 🔴 АВАРІЯ: синк стоїть 15 годин, а годинник іде далі.
     * Правильна поведінка — НЕ «список не змінився взагалі», а «список ЗАМЕРЗ на
     * моменті останнього синку». Тому звіряємо з тим, яким він був ТОДІ, і окремо
     * доводимо, що годинник тим часом його роздуває.
     */
    await setSync(new Date(now - OUTAGE_H * H));
    const frozen = await screen(c, `now() - interval '${OUTAGE_H} hours'`);
    const byAsOf = await screen(c, ASOF_SQL);
    assert.deepEqual(byAsOf, frozen,
      `🔴 при синку, що стоїть ${OUTAGE_H} год, список НЕ замерз на моменті синку: `
      + `${byAsOf.length} проти ${frozen.length} — лічильник живиться годинником`);

    // 🔴 ГЕЙТ ВЛАСНИКА: рахувати від now() замість часу синку — це роздування.
    assert.notDeepEqual(byAsOf, byClock,
      "🔴 anchor нічого не змінив: asOf дорівнює now()-варіанту, тобто підміна пройшла б непоміченою");
    assert.ok(byClock.length - byAsOf.length >= 3,
      `🔴 годинник роздув список лише на ${byClock.length - byAsOf.length} угод — фікстура нечутлива, `
      + "гейт зеленів би й на зламаному анкері");
  });
});

test("#73c RINGOSTAT ГАСИТЬ, КОЛИ У КЛІЄНТА ОДНА ВІДКРИТА УГОДА", async (t) => {
  await withScratch(t, async (c, now) => {
    await c.query(`INSERT INTO job_runs (name,last_success_at)
                   VALUES ('syncKommo',$1),('syncDealActivity',$1),('syncStageEvents',$1)
                   ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`, [new Date(now)]);
    const got = await screen(c, ASOF_SQL);
    assert.ok(!got.includes(306),
      "🔴 угода 306 лишилась у списку: у клієнта ОДНА відкрита угода і розмова 3 год тому — "
      + "менеджера послали б до клієнта, з яким він щойно говорив");
    assert.ok(got.includes(309), "🔴 давня розмова (60 днів) погасила угоду — гасить будь-що, а не свіже");
    assert.ok(got.includes(310), "🔴 угода без client_key зникла — Ringostat дотягнувся туди, куди не може");
    assert.ok(!got.includes(303) && !got.includes(304) && !got.includes(313) && got.includes(302),
      "🔴 базовий поріг зламано: свіжі (303/304/313) не мали б бути в списку, 302 мала б");
    assert.ok(got.length >= 4, `🔴 у списку ${got.length} угод — фікстура вироджена, гасити нема чого`);
  });
});

test("#73d КІЛЬКА ВІДКРИТИХ УГОД — РОЗМОВА НЕ ГАСИТЬ ЖОДНОЇ", async (t) => {
  await withScratch(t, async (c, now) => {
    await c.query(`INSERT INTO job_runs (name,last_success_at)
                   VALUES ('syncKommo',$1),('syncDealActivity',$1),('syncStageEvents',$1)
                   ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`, [new Date(now)]);
    const got = await screen(c, ASOF_SQL);
    for (const id of [307, 308])
      assert.ok(got.includes(id),
        `🔴 угода ${id} погашена розмовою, хоча у клієнта ДВІ відкриті угоди — ми не знаємо, `
        + "про яку з них говорили, і тихо прибрали обидві");
    // 🪞 Дзеркало: щойно друга угода закривається, розмова стає однозначною і ГАСИТЬ.
    await c.query(`UPDATE deals SET status_id = 142 WHERE kommo_id = 308`);
    const after = await screen(c, ASOF_SQL);
    assert.ok(!after.includes(307),
      "🔴 угода 307 лишилась навіть коли стала єдиною відкритою — гасіння не працює взагалі, "
      + "і перевірка вище зеленіла б із тієї ж причини");
  });
});

/**
 * #74 — ПОРІГ МОВЧАННЯ ПІДПИСУ БЕРЕТЬСЯ З РОЗКЛАДУ ДЖОБИ, А НЕ З КОНСТАНТИ.
 *
 * 🔴 ПРИВІД — СКРІНШОТ (11.08.2026). Підпис показував «дані станом на 12:40 (2 год
 * тому)» у цілком нормальному стані: `syncDealActivity` ходить раз на 3 год, тож
 * відставання до трьох годин — це штатна робота, а не подія. Хвіст щодня лякав би
 * тим, що є нормою, і за тиждень його перестали б читати — так і вмирає сигналізація.
 *
 * 🔴 І НЕ «4 ГОДИНИ» ЗАШИТИМ ЧИСЛОМ (рішення власника): поріг = ПОДВІЙНИЙ інтервал
 * тієї джоби, що відстає, обчислений із її розкладу. Зміниться cron — поріг поїде за
 * ним сам. Зашите число розійшлося б із розкладом мовчки, як три копії правила
 * застрягання розходились між собою.
 */
test("#74 ПОРІГ = 2× ІНТЕРВАЛ ВІДСТАЛІШОЇ ДЖОБИ, з реєстру розкладу", async () => {
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  const reg = (n: string) => MONITORED_JOBS.find((j) => j.name === n)!;
  for (const name of ASOF_JOBS) {
    assert.ok(reg(name), `🔴 анкерна джоба «${name}» відсутня в реєстрі розкладу — поріг нема з чого рахувати`);
    assert.equal(asOfStaleAfterMin(name), reg(name).everyMin * 2,
      `🔴 поріг для «${name}» не дорівнює 2× її штатному інтервалу`);
  }
  // Пороги РІЗНІ — інакше «береться з розкладу» неможливо відрізнити від константи.
  assert.notEqual(asOfStaleAfterMin("syncKommo"), asOfStaleAfterMin("syncDealActivity"),
    "🔴 обидві анкерні джоби дали однаковий поріг — гейт не відрізнив би його від зашитого числа");
  // Невідома джоба → найбільший інтервал: помилятись у бік мовчазності, не лякати дарма.
  const maxEvery = Math.max(...ASOF_JOBS.map((n) => reg(n).everyMin));
  assert.equal(asOfStaleAfterMin(null), maxEvery * 2);
  assert.equal(asOfStaleAfterMin("нема-такої"), maxEvery * 2);
  // ДЖЕРЕЛО: у ядрі немає власного числа годин.
  const src = readFileSync(path.join(SRC, "core", "stuckRule.ts"), "utf8");
  assert.ok(src.includes("MONITORED_JOBS"), "🔴 поріг рахується не з реєстру розкладу");
  assert.ok(!/\b(4|6|8)\s*\*\s*60\b|\b240\b|\b360\b/.test(src),
    "🔴 у правилі зʼявилось зашите число годин — воно розійдеться з cron мовчки");
});

/** #74b — МЕЖА: норма → хвоста немає; удвічі більше за норму → хвіст є. */
test("#74b МЕЖА ХВОСТА: норма мовчить, подвійна норма говорить", async (t) => {
  await withScratch(t, async (c, now) => {
    poolUsed = true;
    const { stuckDealsGrouped } = await import("./metrics.js");
    const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
    const every = MONITORED_JOBS.find((j) => j.name === "syncDealActivity")!.everyMin;
    const setSync = (lagMin: number) => c.query(
      `INSERT INTO job_runs (name,last_success_at)
       VALUES ('syncKommo',$1),('syncStageEvents',$1),('syncDealActivity',$2)
       ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`,
      [new Date(now), new Date(now - lagMin * 60_000)]);

    for (const [lagMin, want, why] of [
      [Math.floor(every / 2), false, "половина інтервалу — джоба навіть не мусила ще ходити"],
      [every, false, "рівно інтервал — це штатний ритм, а не подія"],
      [every * 2 - 1, false, "на хвилину менше за поріг — ще мовчимо"],
      [every * 2, true, "удвічі більше за норму — хвіст МУСИТЬ зʼявитись"],
      [every * 5, true, "простій у пʼять інтервалів — тим паче"],
    ] as [number, boolean, string][]) {
      await setSync(lagMin);
      const g = await stuckDealsGrouped({}, MIN_DAYS);
      assert.ok(g.total > 0, "🔴 список порожній — фікстура не засіялась, гейт нічого не доводить");
      assert.equal(g.asOfStale, want, `🔴 відставання ${lagMin} хв (норма ${every}): ${why}`);
      assert.equal(g.asOfJob, "syncDealActivity", "🔴 відсталішою названо не ту джобу");
      assert.equal(g.asOfStaleAfterMin, every * 2, "🔴 поріг у відповіді не дорівнює 2× інтервалу");
    }
  });
});

/**
 * #74d — 🔗 КОЖНЕ ДЖЕРЕЛО СИГНАЛУ МУСИТЬ БУТИ В АНКЕРІ «СТАНОМ НА».
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМИЙ ГЕЙТ, А НЕ РЯДОК У СПИСКУ. Додати сигнал у критерій — одна
 * правка; додати його синк в анкер — інша, у сусідньому файлі. Забудеш другу, і
 * поламається НАЙТИХІШЕ з можливого: угода, яку менеджер учора зрушив, висітиме як
 * «без руху N днів», бо про рух ми не дізнались, а підпис «дані станом на» бадьоро
 * скаже, що все свіже. Це рівно той клас, що прибрана інваріанта, на яку хтось
 * спирався.
 *
 * Доводимо ПОВЕДІНКОЮ, а не переліком: застарілий `syncStageEvents` мусить ЗАМОРОЗИТИ
 * список так само, як застарілий `syncDealActivity`.
 */
test("#74d ЗАСТАРІЛИЙ syncStageEvents ЗАМОРОЖУЄ СПИСОК, як і решта анкерних", async (t) => {
  await withScratch(t, async (c, now) => {
    // Сигнал «рух етапу» тут єдиний, що тримає 302 поза списком: подія свіжа.
    await c.query(`INSERT INTO deal_stage_events (kommo_id,status_id,pipeline_id,changed_at)
                   VALUES (302,$1,8921932,$2)`, [INVOICE, new Date(now - 2 * H)]);
    const fresh = (d: Date) => c.query(
      `INSERT INTO job_runs (name,last_success_at) VALUES ('syncKommo',$1),('syncDealActivity',$1),('syncStageEvents',$2)
       ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`, [new Date(now), d]);

    await fresh(new Date(now));
    const ok = await screen(c, ASOF_SQL);
    assert.ok(!ok.includes(302),
      "🔴 свіжий переїзд стадії не погасив 302 — сигнал «рух етапу» не працює, і все нижче порожнє");

    // 🔴 syncStageEvents стоїть 15 годин. Якби він НЕ був анкерним, `asOf` лишився б
    //    «зараз», і список поїхав би вперед на подіях, яких ми ще не бачили.
    await fresh(new Date(now - OUTAGE_H * H));
    const frozen = await screen(c, `now() - interval '${OUTAGE_H} hours'`);
    assert.deepEqual(await screen(c, ASOF_SQL), frozen,
      `🔴 при syncStageEvents, що стоїть ${OUTAGE_H} год, список НЕ замерз на моменті синку — `
      + "джоба не входить в ASOF_JOBS, і підпис «станом на» бреше про свіжість");
    assert.ok(ASOF_JOBS.includes("syncStageEvents"),
      "🔴 syncStageEvents немає в ASOF_JOBS — сигнал у критерії є, а нагляду за його свіжістю немає");
    // 🪞 Дзеркало: заморозка мусить бути ВИДИМОЮ, а не збігом порожніх списків.
    assert.ok(frozen.length > 0, "🔴 замерзлий список порожній — рівність нічого не доводить");
  });
});

/** 🪞 #74c — фронт малює хвіст ЛИШЕ за прапорцем сервера і свого числа годин не має. */
test("#74c ФРОНТ НЕ МАЄ ВЛАСНОГО ЧИСЛА ГОДИН", () => {
  const fe = readFileSync(path.join(SRC, "..", "..", "frontend", "src", "pages",
    "dashboard", "sections", "ReportPlanSection.tsx"), "utf8");
  const fn = fe.slice(fe.indexOf("function asOfLabel"), fe.indexOf("const STUCK_COLS"));
  assert.ok(fn.length > 100, "🔴 підпис asOfLabel зник — перевіряти нема чого");
  assert.ok(/if \(!stale\) return hhmm;/.test(fn),
    "🔴 підпис не питає прапорець сервера — отже вирішує сам");
  assert.ok(!/\b120\b|\b240\b|ageMin >= \d/.test(fn),
    "🔴 у підписі зʼявився власний поріг у хвилинах — правило знову у двох копіях");
  assert.ok(fe.includes("data?.asOfStale"), "🔴 компонент не передає прапорець у підпис");
});

/**
 * #77 — 🔬 ІНСТРУМЕНТ ЗАМІРУ ПРАЦЮЄ ПРОТИ СПРАВЖНЬОЇ БАЗИ, А НЕ «МАЄ ПРАЦЮВАТИ».
 *
 * 🔴 ПРИВІД, І ВІН ЦЬОГО ТИЖНЯ. `core/dayItems.ts` джойнив `d.id = e.deal_id` —
 * колонок, яких НЕ ІСНУЄ. Це пройшло `tsc` (SQL у шаблонному рядку не типізується),
 * пройшло весь набір (гейт чесно скіпався без живого API) і впало б на першому кліку.
 * Інструмент, яким власник обиратиме поріг, не має права зустріти прод уперше: він
 * мусить хоч раз виконатись проти справжнього Postgres із справжньою схемою.
 *
 * Заодно доводиться сам ДЕТЕКТОР інструмента: три числа зняті двома шляхами
 * (прямий виклик і розподіл), і розбіжність між ними мусить ПАДАТИ, а не друкуватись.
 */
test("#77 ІНСТРУМЕНТ ЗАМІРУ: три пороги, і його власний детектор працює", async (t) => {
  await withScratch(t, async (c, now) => {
    poolUsed = true;
    await c.query(`INSERT INTO job_runs (name,last_success_at)
                   VALUES ('syncKommo',$1),('syncDealActivity',$1),('syncStageEvents',$1)
                   ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`, [new Date(now)]);
    const { measureStuck } = await import("../tools/measureStuck.js");
    const r = await measureStuck([14, 21, 30]);

    assert.equal(r.measures.length, 3, "🔴 інструмент віддав не три пороги");
    assert.ok(r.population > 0, "🔴 популяція порожня — інструмент не має що міряти");
    // Монотонність: вищий поріг НЕ може дати більший список. Це властивість самого
    // означення, тож її порушення означало б, що пороги рахуються різними правилами.
    for (let i = 1; i < r.measures.length; i++)
      assert.ok(r.measures[i].total <= r.measures[i - 1].total,
        `🔴 поріг ${r.measures[i].minDays} дав БІЛЬШЕ угод, ніж ${r.measures[i - 1].minDays} — `
        + "пороги міряються не одним правилом");
    // Фікстура має розрізняти пороги, інакше «три числа» нічого не показують.
    assert.ok(r.measures[0].total > r.measures[2].total,
      `🔴 14 і 30 дали однаково (${r.measures[0].total}) — фікстура нечутлива до порога`);
    // Розподіл покриває всю популяцію: якби відро загубилось, крива брехала б у бік меншого.
    assert.equal(r.histogram.reduce((s, b) => s + b.count, 0), r.population,
      "🔴 сума відер розподілу ≠ популяції — частина угод не потрапила в жодне відро");
    assert.equal(r.asOfStale, false, "🔴 на свіжих синках замір позначив дані застарілими");

    // 🧨 ДЕТЕКТОР ІНСТРУМЕНТА: підмінюємо число, здобуте другим шляхом, і вимагаємо ПАДІННЯ.
    //    Без цього «два шляхи збіглись» доводило б лише те, що ми їх порівнюємо.
    const { stuckDealsGrouped } = await import("./metrics.js");
    let first = true;
    const lying: typeof stuckDealsGrouped = async (s, md) => {
      const g = await stuckDealsGrouped(s, md);
      if (first) { first = false; return g; }   // популяція — як є
      return { ...g, total: g.total + 1 };      // а поріг бреше рівно на одиницю
    };
    await assert.rejects(() => measureStuck([14], lying), /розійшлись/,
      "🔴 інструмент прийняв розбіжність двох шляхів — його детектор не працює, "
      + "і хибне число поїхало б власникові як підстава для вибору порога");
  });
});
