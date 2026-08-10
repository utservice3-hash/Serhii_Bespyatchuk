import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AVTO_STATUSES, CALL_MIN_SEC, callCountsAsActivity, stuckBaseConds,
  ASOF_SQL, CLOCK_WITH_TALK, ringostatTalkCte,
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
const AVTO = AVTO_STATUSES[0];
const EARLY = 69693668;

/**
 * 15 годин — тривалість аварії №2 (09-10.08.2026, синк стояв 15 год 13 хв). Вік угод
 * підібрано так, щоб цей зсув ПЕРЕТИНАВ поріг: інакше «лічильник не росте» зеленіло б
 * саме тому, що рости нікуди.
 */
const OUTAGE_H = 15;
const MIN_DAYS = 7;

type D = { id: number; why: string; status: number; actH: number; ck: string | null };
/** Кожна угода названа тим, що саме вона доводить. `actH` — годин від «зараз». */
const DEALS: D[] = [
  // ── ТРОЄ НА МЕЖІ: вік між порогом і порогом+15 год. Саме вони показують роздування:
  //    «зараз» вони застряглі, «на момент синку 15 год тому» — ще ні.
  { id: 301, why: "авто, 7 діб + 3 год: перетнула поріг ЗА останні 15 год", status: AVTO, actH: 7 * 24 + 3, ck: "клієнта" },
  { id: 311, why: "авто, 7 діб + 10 год: те саме, друга на межі", status: AVTO, actH: 7 * 24 + 10, ck: "клієнте" },
  { id: 312, why: "рання, 21 доба + 5 год: перетнула поріг ×3 за останні 15 год", status: EARLY, actH: 21 * 24 + 5, ck: "клієнтж" },
  // ── СТАБІЛЬНІ: застряглі за будь-якого анкера.
  { id: 302, why: "авто, 7 діб + 30 год: застрягла за будь-якого анкера", status: AVTO, actH: 7 * 24 + 30, ck: "клієнтб" },
  { id: 305, why: "рання, 22 доби: застрягла за будь-якого анкера", status: EARLY, actH: 22 * 24, ck: "клієнтд" },
  // ── СВІЖІ: не застряглі за будь-якого анкера.
  { id: 303, why: "авто, активність 2 год тому: свіжа за будь-якого анкера", status: AVTO, actH: 2, ck: "клієнтв" },
  { id: 304, why: "рання, 20 діб < 21 → не застрягла", status: EARLY, actH: 20 * 24, ck: "клієнтг" },
  { id: 313, why: "авто, 7 діб − 40 год: 15 год простою його НЕ дотягують", status: AVTO, actH: 7 * 24 - 40, ck: "клієнтз" },
  // ── RINGOSTAT: чотири випадки привʼязки розмови.
  { id: 306, why: "застрягла, клієнт з ОДНІЄЮ угодою і свіжою розмовою → гаситься", status: AVTO, actH: 30 * 24, ck: "розмоводин" },
  { id: 307, why: "застрягла, клієнт з ДВОМА угодами і свіжою розмовою → НЕ гаситься", status: AVTO, actH: 30 * 24, ck: "розмовдва" },
  { id: 308, why: "друга угода того самого клієнта — вона й робить привʼязку неоднозначною", status: AVTO, actH: 31 * 24, ck: "розмовдва" },
  { id: 309, why: "застрягла, розмова СТАРІША за анкер → не гасить", status: AVTO, actH: 30 * 24, ck: "розмовстар" },
  { id: 310, why: "застрягла без client_key → Ringostat до неї не дотягнеться", status: AVTO, actH: 30 * 24, ck: null },
];
/** Розмови Ringostat: клієнт → скільки годин тому, скільки секунд. */
const TALKS: [string, number, number][] = [
  ["розмоводин", 3, 120],   // свіжа й однозначна
  ["розмовдва", 3, 120],    // свіжа, але клієнт має дві відкриті угоди
  ["розмовстар", 60 * 24, 120], // давня — анкер не зрушить
  ["клієнта", 90 * 24, 0],  // 0 c: не розмова, у CTE не потрапляє взагалі
];

async function withScratch(t: { skip: (m: string) => void },
  fn: (c: import("pg").Client, now: number) => Promise<void>): Promise<void> {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(scratch.unavailable);
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  const now = Date.now();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РНК-тест') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'М',1,true) ON CONFLICT DO NOTHING`);
    for (const [p, st, stage] of [[8921932, AVTO, "approved"], [8921932, EARLY, "lead_taken"], [8921932, 142, "paid"]] as [number, number, string][])
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

/** Список за правилом екрана: анкер `asOf`, годинник із однозначною розмовою. */
async function screen(c: import("pg").Client, asOf: string, params: unknown[] = []): Promise<number[]> {
  const conds = stuckBaseConds({ pipelines: "$1", avtoStatuses: "$2", minDays: "$3", asOf, clock: CLOCK_WITH_TALK });
  const r = await c.query<{ kommo_id: string }>(
    `WITH ${ringostatTalkCte({ pipelines: "$1" })}
     SELECT d.kommo_id FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       LEFT JOIN talk tk ON tk.client_key = d.client_key
       LEFT JOIN open_cnt oc ON oc.client_key = d.client_key
      WHERE ${conds.join(" AND ")} ORDER BY d.kommo_id`,
    [FC, AVTO_STATUSES, MIN_DAYS, ...params]);
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
      `INSERT INTO job_runs (name,last_success_at) VALUES ('syncKommo',$1),('syncDealActivity',$1)
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
    await c.query(`INSERT INTO job_runs (name,last_success_at) VALUES ('syncKommo',$1),('syncDealActivity',$1)
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
    await c.query(`INSERT INTO job_runs (name,last_success_at) VALUES ('syncKommo',$1),('syncDealActivity',$1)
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
