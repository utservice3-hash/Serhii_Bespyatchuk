import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { takeOf, inTakeAt, kyivAt, TAKE_IN_MIN_TALK_SEC, TAKE_EVENT_LABEL } from "./leadTakeRules.js";
import { parseQuoteRating, ratingStats, ratingView, FIELD_QUOTE_RATING, type RatingRow } from "./leadgenRatings.js";
import { ownLeadgenStatsBody } from "./leadgenHandoffRules.js";
import { MONITORED_JOBS } from "../jobs/monitoredJobs.js";

/**
 * 📦 ПАЧКА 12.11.2026 — задачі 8705/8706 (прийнятий вхідний дзвінок = «взято») і 7537 (оцінки прорахунків лідгенів).
 *
 * 8705: правило «взято в роботу» отримало четверту подію. Найтонше місце — дзвінок, що САМ створив угоду: він
 * починається РАНІШЕ за її створення, і старе «подія не раніше створення» його відкидало (заміряно на #62834779).
 * Тому гейти стоять по обидва боки двох меж: «тривав у мить створення / скінчився до» і «розмова 10 с / 9 с».
 *
 * 7537: оцінка — поле Kommo, тож гейти стережуть не число, а знаменник: які передачі взагалі можна оцінити.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const MIN = 60_000;
/** Вівторок 13.10.2026 10:00 за Києвом — робочий час. */
const T0 = kyivAt(2026, 10, 13, 10, 0);

test("#3900 🪞 ВХІДНИЙ ДЗВІНОК = «ВЗЯТО»: тривав у мить створення — 0 хв; скінчився до створення — не подія; пізніший — за своїм часом", () => {
  // Дзвінок створив угоду: почався за 16 с до неї, тривав 68 с — як #62834779.
  const made = takeOf({ createdAt: T0, stageAt: null, callAt: T0 + MIN, fieldAt: null, inAt: T0 - 16_000, inEndAt: T0 + 52_000 });
  assert.deepEqual([made.event, made.minutes, made.bucket], ["callIn", 0, "m1"], "🔴 прийнятий дзвінок, що створив угоду, не «взято за 0 хв»");
  // Дзеркало: та сама розмова, що СКІНЧИЛАСЬ до створення угоди, — минула розмова, не взяття цієї заявки.
  const past = takeOf({ createdAt: T0, stageAt: null, callAt: null, fieldAt: null, inAt: T0 - 10 * MIN, inEndAt: T0 - 9 * MIN });
  assert.equal(past.bucket, "none", "🔴 розмова, що скінчилась до створення угоди, зарахована як взяття");
  assert.equal(inTakeAt(T0, T0 - 16_000, null), null, "🔴 дзвінок до створення з невідомим кінцем зараховано навмання");
  const later = takeOf({ createdAt: T0, stageAt: T0 + 20 * MIN, callAt: null, fieldAt: null, inAt: T0 + 3 * MIN, inEndAt: T0 + 4 * MIN });
  assert.deepEqual([later.event, later.minutes, later.bucket], ["callIn", 3, "m5"], "🔴 вхідний дзвінок після створення не найраніша подія");
  const stageFirst = takeOf({ createdAt: T0, stageAt: T0 + MIN, callAt: null, fieldAt: null, inAt: T0 + 3 * MIN, inEndAt: T0 + 4 * MIN });
  assert.equal(stageFirst.event, "stage", "🔴 вхідний дзвінок перебив ранішу подію");
  // «Дубль»: зміна етапу не рахується, а прийнятий дзвінок — так (це дзвінок, а не автоматика).
  const dup = takeOf({ createdAt: T0, stageAt: T0 + 11_000, callAt: null, fieldAt: null, inAt: T0 + 2 * MIN, inEndAt: T0 + 3 * MIN, duplicate: true });
  assert.deepEqual([dup.event, dup.bucket], ["callIn", "m5"], "🔴 у «Дубля» прийнятий вхідний дзвінок не рахується");
  assert.equal(TAKE_IN_MIN_TALK_SEC, 10, "🔴 поріг розмови на вхідному — не 10 с із ТЗ");
  assert.equal(TAKE_EVENT_LABEL.callIn, "прийнятий вхідний дзвінок");
});

test("#3901 ПРОВОДКА 8705: SQL бере вхідні типи з порогом розмови й кінцем дзвінка; підказка ⓘ називає правило", () => {
  const core = src("backend/src/core/leadTake.ts");
  assert.match(core, /rc\.call_type IN \(\$\{INBOUND_TYPES\.map/, "🔴 вхідні типи — не зі спільного переліку INBOUND_TYPES");
  assert.match(core, /rc\.billsec >= \$\{String\(TAKE_IN_MIN_TALK_SEC\)\}/, "🔴 поріг розмови в SQL — не константа правила");
  assert.match(core, />= d\.created_at_kommo\s+ORDER BY rc\.calldate LIMIT 1\) inc ON true/, "🔴 дзвінок не відсікається за КІНЦЕМ проти створення угоди");
  assert.match(core, /inAt: ms\(x\.in_at\), inEndAt: ms\(x\.in_end_at\)/, "🔴 вхідний дзвінок не доходить до takeOf");
  assert.match(src("frontend/src/pages/dashboard/sections/LeadTakeCard.tsx"), /прийнятий вхідний дзвінок клієнта з розмовою від 10 с/,
    "🔴 підказка вікна не каже про вхідний дзвінок — правило змінилось мовчки");
});

// ── Живий SQL на scratch-кластері ───────────────────────────────────────────────────────────────
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });
const iso = (ms: number) => new Date(ms).toISOString();

test("#3902 🪞 ЖИВИЙ SQL 8705: дзвінок-творець — «до 1 хв»; скінчився раніше — «не взято»; 9 с — ні, 10 с — так; обмежена схемою оцінка", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  dispose = async () => { const { pool } = await import("../db/pool.js"); await pool.end(); await c.end(); scratch.dispose(); };
  await c.query(src("backend/src/db/schema.sql"));
  await c.query(`INSERT INTO teams (id, name) VALUES (13, 'РНК - Андрія') ON CONFLICT (id) DO NOTHING`);
  await c.query(`INSERT INTO managers (id, name, team_id, is_active) VALUES (1, 'Андріїв', 13, true) ON CONFLICT (id) DO NOTHING`);
  const deal = (id: number, created: number, ck: string) =>
    c.query(`INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, price, created_at_kommo, client_source, lead_channel, client_key)
             VALUES ($1, $2, 1, 8921932, 69693668, 0, $3, 'Дзвінок з uts.ua', 'ad', $4)`, [id, `заявка ${String(id)}`, iso(created), ck]);
  const call = (uid: string, at: number, type: string, billsec: number, duration: number, ck: string) =>
    c.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, duration, client_key) VALUES ($1, $2, $3, $4, $5, $6)`,
      [uid, iso(at), type, billsec, duration, ck]);
  await deal(201, T0, "k201"); await call("in201", T0 - 16_000, "in", 55, 68, "k201");           // дзвінок створив угоду
  await deal(202, T0 + 10 * MIN, "k202"); await call("in202", T0, "in", 60, 70, "k202");          // скінчився за 8+ хв до угоди
  await deal(203, T0 + 20 * MIN, "k203"); await call("in203", T0 + 23 * MIN, "in", 9, 30, "k203"); // 9 с — не розмова
  await deal(204, T0 + 30 * MIN, "k204"); await call("in204", T0 + 33 * MIN, "transitin", 10, 30, "k204"); // рівно 10 с
  const tm = await import("./teamAt.js");
  await tm.refreshTeamMoves(c);
  const lt = await import("./leadTake.js");
  const deals = await lt.leadTakeDeals({ from: "2026-10-13", to: "2026-10-13", time: "all", source: "all" }, "dept", "all");
  const by = new Map(deals.map((d) => [d.kommoId, d]));
  assert.equal(deals.length, 4, "🔴 у вибірці не всі заявки фікстури — порожньо означає ПРОВАЛ");
  assert.deepEqual([by.get(201)?.event, by.get(201)?.minutes, by.get(201)?.bucket], ["прийнятий вхідний дзвінок", 0, "m1"],
    "🔴 дзвінок, що створив угоду, не «до 1 хв»");
  assert.equal(by.get(202)?.bucket, "none", "🔴 розмова, що скінчилась до створення угоди, зарахована");
  assert.equal(by.get(203)?.bucket, "none", "🔴 вхідний із розмовою 9 с зарахований як «взято»");
  assert.deepEqual([by.get(204)?.event, by.get(204)?.bucket], ["прийнятий вхідний дзвінок", "m5"], "🔴 вхідний із розмовою рівно 10 с не зарахований");
  // 7537: колонка оцінки приймає 1–5 і NULL, решту відхиляє сама база.
  await c.query(`UPDATE deals SET quote_rating = 5 WHERE kommo_id = 201`);
  await assert.rejects(c.query(`UPDATE deals SET quote_rating = 6 WHERE kommo_id = 202`), /deals_quote_rating_check/, "🔴 база прийняла оцінку 6");
  await assert.rejects(c.query(`UPDATE deals SET quote_rating = 0 WHERE kommo_id = 202`), /deals_quote_rating_check/, "🔴 база прийняла оцінку 0");
});

const row = (lgId: number, dealId: number | null, x: Partial<RatingRow> = {}): RatingRow =>
  ({ lgId, dealId, inPeriod: true, cls: "work", rating: null, loadDay: null, ...x });

test("#3903 🪞 ОЦІНКА З KOMMO: «1»…«5» — оцінка; порожнє, «0», «6», «4.5», текст — не оцінка", () => {
  assert.deepEqual(["1", "5", " 3 ", 4].map(parseQuoteRating), [1, 5, 3, 4], "🔴 справжня оцінка не розпізнана");
  assert.deepEqual([null, undefined, "", "0", "6", "4.5", "п'ять", "55"].map(parseQuoteRating), [null, null, null, null, null, null, null, null],
    "🔴 не-оцінка прочитана як оцінка");
  assert.equal(FIELD_QUOTE_RATING, 2100177, "🔴 поле «Оцінка прорахунку» — не те, що в Kommo");
});

test("#3904 🪞 ЗНАМЕННИК ОЦІНОК: лише передачі періоду з угодою; «та сама угода» й повтор не двоять; без оцінок середня — «немає», не нуль", () => {
  const rows: RatingRow[] = [
    row(1, 10, { rating: 5, loadDay: "2026-11-03" }), row(1, 11, { rating: 2 }), row(1, 12),
    row(1, 10, { rating: 5 }),                                  // та сама угода вдруге — не двоїть
    row(1, 13, { rating: 1, cls: "same" }),                     // привела в уже пораховану угоду
    row(1, 14, { rating: 1, inPeriod: false }),                 // гроші з давнішої передачі — не прорахунок періоду
    row(1, null),                                               // угоди менеджера немає — оцінити нема де
  ];
  const s = ratingStats(rows);
  assert.deepEqual([s.deals, s.rated, s.unrated, s.noDeal], [3, 2, 1, 1], "🔴 знаменник оцінок рахує не ті передачі");
  assert.equal(s.avg, 3.5, "🔴 середня не з оцінених угод періоду");
  assert.deepEqual(s.dist, [0, 1, 0, 0, 1]);
  assert.deepEqual([s.machines, s.machinesPct], [1, 33.3], "🔴 «поїхало» рахується не з тих самих передач");
  const empty = ratingStats([row(2, 20), row(2, 21)]);
  assert.deepEqual([empty.avg, empty.rated, empty.unrated], [null, 0, 2], "🔴 без жодної оцінки середня не «немає» — нуль читався б як оцінка");
  assert.equal(ratingStats([]).machinesPct, null);
  const v = ratingView([...rows, row(2, 20, { rating: 4 })]);
  assert.deepEqual(v.byPerson.map((p) => [p.managerId, p.rated]), [[1, 2], [2, 1]], "🔴 оцінки не розкладено по лідгенах");
  assert.equal(v.totals.avg, 3.67, "🔴 відділ — не середня з усіх оцінених угод");
});

test("#3905 ПРОВОДКА 7537: блок — з тих самих передач, що гроші; лідгену — лише свій рядок; джоба під наглядом і пише лише свою колонку", () => {
  const routes = src("backend/src/routes/dashboard.ts");
  assert.match(routes, /quoteRatings: ratingView\(hm\.deals\)/, "🔴 оцінки рахуються не з `hm.deals` — можуть розійтись зі списком передач");
  const body = { quoteRatings: { totals: { rated: 3 }, byPerson: [{ managerId: 7, rated: 1 }, { managerId: 8, rated: 2 }] } };
  const own = ownLeadgenStatsBody(body, 7) as { quoteRatings?: { totals: unknown; byPerson: { managerId: number }[] } };
  assert.deepEqual(own.quoteRatings?.byPerson.map((p) => p.managerId), [7], "🔴 лідген бачить оцінки колег поіменно");
  assert.deepEqual(own.quoteRatings?.totals, { rated: 3 }, "🔴 лідгену не віддано підсумок команди");
  const job = src("backend/src/jobs/syncQuoteRatings.ts");
  assert.match(job, /UPDATE deals d SET quote_rating = v\.rating\s+FROM unnest/, "🔴 джоба оцінок пише не лише свою колонку");
  assert.match(job, /if \(leads\.length === 0\) throw new Error/, "🔴 порожня відповідь Kommo на непорожній запит проходить як успіх");
  const idx = src("backend/src/index.ts");
  assert.match(idx, /cron\.schedule\("40 \* \* \* \*", \(\) => \{\s+if \(isKommoPaused\(\)\) return;\s+void runJob\("syncQuoteRatings"/, "🔴 джоба оцінок не в розкладі");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "syncQuoteRatings")?.everyMin, 60, "🔴 нагляд за джобою оцінок не збігається з кроном");
  assert.match(src("frontend/src/pages/dashboard/sections/LeadgenSection.tsx"), /<LeadgenRatingsBlock d=\{d\} who=\{who\}/, "🔴 блок оцінок не на екрані");
});
