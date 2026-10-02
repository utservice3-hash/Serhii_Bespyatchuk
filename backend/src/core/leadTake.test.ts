import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import {
  takeOf, bucketOf, statsOf, clockStart, kyivAt, weekRange, inColumn, NORM,
  type DealTake, type TakeRowInput,
} from "./leadTakeRules.js";
import { buildXlsx } from "./xlsxWrite.js";
import { parseXlsx } from "./officeParse.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const MIN = 60_000;
/** Вівторок 15.09.2026 10:00 за Києвом — робочий час. */
const T0 = kyivAt(2026, 9, 15, 10, 0);

/**
 * ⏱ ВІКНО «ЧАС ОПРАЦЮВАННЯ ЗАЯВКИ» (ТЗ Юлії 24.09.2026). Гейти стережуть Юлині критерії приймання там, де їх
 * можна стерегти кодом: «Дубль» без дзвінка — «не взято» (3), пороги підсвічування (4), «Цей тиждень» = Пн–Нд (5),
 * межі кошиків, неробочий час, і що список угод клітинки — ті самі угоди, що дали число.
 */
test("#1312 «ВЗЯТО В РОБОТУ»: перша з трьох подій; «Дубль», закритий без жодної події, — «не взято», навіть за 2 хв", () => {
  assert.equal(takeOf({ createdAt: T0, stageAt: null, callAt: null, fieldAt: null }).bucket, "none",
    "🔴 заявка без жодної події не в «не взято» — так і ховаються «Дублі» без дзвінка");
  const t = takeOf({ createdAt: T0, stageAt: T0 + 20 * MIN, callAt: T0 + 3 * MIN, fieldAt: T0 + 10 * MIN });
  assert.deepEqual([t.event, t.minutes, t.bucket], ["call", 3, "m5"], "🔴 узято не найранішу з трьох подій");
  assert.equal(takeOf({ createdAt: T0, stageAt: null, callAt: T0 - 5 * MIN, fieldAt: null }).bucket, "none",
    "🔴 дзвінок ДО створення заявки (по старій угоді клієнта) зарахований як взяття нової");
  assert.equal(takeOf({ createdAt: T0, stageAt: null, callAt: null, fieldAt: T0 + 30_000 }).event, "field", "🔴 поле «Взято в работу» не рахується подією");
});

test("#1312b КОШИКИ: «до 1 хв» включає рівно 60 с, «до 5 хв» — рівно 300 с; секундою пізніше — наступний кошик", () => {
  assert.deepEqual([1, 1 + 1 / 60, 5, 5 + 1 / 60, 30, 30 + 1 / 60, 60, 60 + 1 / 60].map(bucketOf),
    ["m1", "m5", "m5", "m30", "m30", "m60", "m60", "h1"], "🔴 межа кошика не там, де в ТЗ");
  assert.equal(bucketOf(null), "none");
});

test("#1312c ПІДСВІЧУВАННЯ — РІВНО НА ПОРОГАХ НОРМАТИВУ: 90% до 1 хв — норма, 89.x — червоне; 100% до 5 хв; «не взято» > 0", () => {
  const mk = (b: DealTake["bucket"]): TakeRowInput => ({ lost: false, take: { takenAt: 1, event: "stage", minutes: b === "m1" ? 0 : b === "m5" ? 3 : 20, bucket: b, offHours: false } });
  const rows = (m1: number, m5: number, m30: number, none = 0) =>
    [...Array(m1).fill(0).map(() => mk("m1")), ...Array(m5).fill(0).map(() => mk("m5")), ...Array(m30).fill(0).map(() => mk("m30")),
     ...Array(none).fill(0).map((): TakeRowInput => ({ lost: false, take: { takenAt: null, event: null, minutes: null, bucket: "none", offHours: false } }))];
  const atNorm = statsOf(rows(9, 1, 0), null);
  assert.deepEqual([atNorm.m1Pct, atNorm.m5Pct, atNorm.red], [90, 100, { m1: false, m5: false, notTaken: false }], "🔴 рівно на нормативі — червоне");
  const below = statsOf(rows(89, 10, 1), null);
  assert.deepEqual(below.red, { m1: true, m5: true, notTaken: false }, "🔴 89% до 1 хв і 99% до 5 хв не червоні");
  assert.equal(statsOf(rows(10, 0, 0, 1), null).red.notTaken, true, "🔴 одна не взята заявка не червона");
  assert.deepEqual([NORM.m1Pct, NORM.m5Pct, NORM.notTaken], [90, 100, 0], "🔴 норматив не той, що в ТЗ");
});

test("#1312d НЕРОБОЧИЙ ЧАС: годинник стартує о 08:15 найближчого робочого дня (пт 19:00 → пн; будень 07:00 → того ж дня)", () => {
  const at = (ms: number) => new Date(ms).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", weekday: "short", hour: "2-digit", minute: "2-digit" });
  assert.equal(at(clockStart(kyivAt(2026, 9, 18, 19, 0))), at(kyivAt(2026, 9, 21, 8, 15)), "🔴 пʼятниця 19:00 — не понеділок 08:15");
  assert.equal(at(clockStart(kyivAt(2026, 9, 19, 12, 0))), at(kyivAt(2026, 9, 21, 8, 15)), "🔴 субота — не понеділок 08:15");
  assert.equal(at(clockStart(kyivAt(2026, 9, 15, 7, 0))), at(kyivAt(2026, 9, 15, 8, 15)), "🔴 будень 07:00 — не того ж дня 08:15");
  assert.equal(clockStart(T0), T0, "🔴 заявка в робочий час — годинник не з моменту створення");
  // Нічна заявка, взята о 08:10, — у нормі («до 1 хв»), а не «понад годину».
  const night = kyivAt(2026, 9, 15, 23, 0);
  assert.equal(takeOf({ createdAt: night, stageAt: kyivAt(2026, 9, 16, 8, 10), callAt: null, fieldAt: null }).bucket, "m1",
    "🔴 нічна заявка, взята до 08:15, не «до 1 хв»");
  // Перехід на зимовий час (25.10.2026): 08:15 мусить лишитись 08:15 за Києвом.
  assert.equal(at(clockStart(kyivAt(2026, 10, 24, 20, 0))), at(kyivAt(2026, 10, 26, 8, 15)), "🔴 після переходу на зимовий час старт зсунувся на годину");
});

test("#1312e «ЦЕЙ ТИЖДЕНЬ» = Пн–Нд поточного тижня, «Минулий» — попередні Пн–Нд", () => {
  assert.deepEqual(weekRange("2026-10-02"), { from: "2026-09-28", to: "2026-10-04" }, "🔴 «цей тиждень» не Пн–Нд");
  assert.deepEqual(weekRange("2026-10-04"), { from: "2026-09-28", to: "2026-10-04" }, "🔴 неділя віднесена до наступного тижня");
  assert.deepEqual(weekRange("2026-10-02", -1), { from: "2026-09-21", to: "2026-09-27" }, "🔴 «минулий тиждень» не той");
});

test("#1312f EXCEL: файл читається назад нашим же розбором — ті самі клітинки, кирилиця й числа на місці", () => {
  const rows = [["Менеджер", "Заявок", "до 1 хв, %"], ["Хомік <тест> & «лапки»", 12, 91.7], ["ВІДДІЛ", 100, null]];
  const sheets = parseXlsx(buildXlsx([{ name: "Час опрацювання", rows }, { name: "Угоди", rows: [["Угода"], ["#1"]] }]));
  assert.equal(sheets.length, 2, "🔴 у файлі не два аркуші");
  assert.deepEqual(sheets[0].rows.slice(0, 3).map((r) => r.slice(0, 3)),
    [["Менеджер", "Заявок", "до 1 хв, %"], ["Хомік <тест> & «лапки»", "12", "91.7"], ["ВІДДІЛ", "100"]], // порожня клітинка в .xlsx не пишеться — це норма формату
    "🔴 Excel-файл не відкривається або клітинки пошкоджені");
});

test("#1312g СПИСОК УГОД КЛІТИНКИ = УГОДИ, ЩО ДАЛИ ЧИСЛО: «до 5 хв» включає «до 1 хв», «повільні без результату» — >5 хв або не взято, і закрито", () => {
  const r = (bucket: DealTake["bucket"], minutes: number | null, lost: boolean): TakeRowInput =>
    ({ lost, take: { takenAt: minutes == null ? null : 1, event: minutes == null ? null : "stage", minutes, bucket, offHours: false } });
  const rows = [r("m1", 0.5, false), r("m5", 4, true), r("m30", 12, true), r("none", null, true), r("none", null, false)];
  const s = statsOf(rows, 1000);
  assert.equal(rows.filter((x) => inColumn("m5", x)).length, Math.round((s.m5Pct! / 100) * s.n), "🔴 «до 5 хв» у списку ≠ у клітинці");
  assert.equal(rows.filter((x) => inColumn("slowLost", x)).length, s.slowLost, "🔴 «повільні без результату» у списку ≠ у клітинці");
  assert.deepEqual([s.slowLost, s.loss], [2, 2000], "🔴 повільні без результату або втрати рахуються не так, як у ТЗ");
  assert.equal(statsOf(rows, null).loss, null, "🔴 без середнього чека втрати показано нулем, а не «—»");
});

// ── Живий SQL на scratch-кластері ───────────────────────────────────────────────────────────────
type Ctx = { c: import("pg").Client; lt: typeof import("./leadTake.js"); act: typeof import("../jobs/syncDealActivity.js") };
let ctxP: Promise<Ctx | { skip: string }> | null = null;
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });
const FC = 8921932, QUAL = 8921928;
const iso = (ms: number) => new Date(ms).toISOString();

async function db(): Promise<Ctx | { skip: string }> {
  ctxP ??= (async () => {
    const { provisionScratch } = await import("../db/scratchDb.js");
    const scratch = provisionScratch();
    if ("unavailable" in scratch) return { skip: skipReason(scratch) };
    process.env.DATABASE_URL = scratch.url;
    process.env.JWT_SECRET ??= "test";
    process.env.KOMMO_BASE_URL ??= "https://x.invalid";
    process.env.KOMMO_API_TOKEN ??= "x";
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: scratch.url });
    await c.connect();
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id, name) VALUES (13, 'РНК - Андрія'), (15, 'РНК - Дарини'), (5, 'РПК-Яцика') ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id, is_active) VALUES (1, 'Андріїв', 13, true), (2, 'Даринин', 15, true), (3, 'Яциків', 5, true)
                   ON CONFLICT (id) DO NOTHING`);
    const deal = (id: number, mgr: number, pipe: number, status: number, created: number, extra: Record<string, unknown> = {}) =>
      c.query(`INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, price, created_at_kommo, client_source, lead_channel, utm_campaign,
                                  reject_reason, taken_field_at, first_call_out_at, client_key)
               VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, `заявка ${id}`, mgr, pipe, status, iso(created), extra.src ?? "uts.ua", extra.ch ?? "ad", extra.camp ?? null,
         extra.reason ?? null, extra.field ?? null, extra.call ?? null, extra.ck ?? null]);
    // 101: взята зміною етапу за 30 с · 102: «Дубль», закритий за 2 хв БЕЗ подій — «не взято» · 103: подія лише вхід у 143
    // 104: вихідний дзвінок за 3 хв · 105: поле за 40 хв · 106: сайт · 107: лідген · 108: нічна (неробоча), етап о 08:10
    await deal(101, 1, QUAL, 69693652, T0, { camp: "brand" });
    await deal(102, 1, QUAL, 143, T0 + 10 * MIN, { reason: "Дубль" });
    await deal(103, 2, QUAL, 143, T0 + 20 * MIN, { reason: "Немає зв'язку" });
    await deal(104, 2, FC, 69693668, T0 + 30 * MIN, { call: iso(T0 + 33 * MIN) });
    await deal(105, 3, FC, 69693668, T0 + 40 * MIN, { field: iso(T0 + 80 * MIN) });
    await deal(106, 3, FC, 69693668, T0 + 50 * MIN, { src: "yalogist.com.ua", ch: "other", call: iso(T0 + 50 * MIN + 30_000) });
    await deal(107, 1, FC, 69693668, T0 + 60 * MIN, { src: "Холодна база", ch: "leadgen", ck: "k107" });
    await deal(108, 1, QUAL, 69693652, kyivAt(2026, 9, 15, 23, 0));
    const ev = (id: number, pipe: number, status: number, at: number) =>
      c.query(`INSERT INTO deal_stage_events (kommo_id, pipeline_id, status_id, changed_at) VALUES ($1, $2, $3, $4)`, [id, pipe, status, iso(at)]);
    await ev(101, QUAL, 69693652, T0 + 30_000);
    await ev(102, QUAL, 143, T0 + 12 * MIN);
    await ev(103, QUAL, 143, T0 + 21 * MIN);
    await ev(108, QUAL, 69693652, kyivAt(2026, 9, 16, 8, 10));
    // Дзвінок Ringostat тому самому клієнту (ключ) — друга дорога знайти вихідний дзвінок.
    await c.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, client_key) VALUES ('rc107', $1, 'out', 0, 'k107')`, [iso(T0 + 61 * MIN)]);
    const [lt, act] = await Promise.all([import("./leadTake.js"), import("../jobs/syncDealActivity.js")]);
    const tm = await import("./teamAt.js");
    await tm.refreshTeamMoves(c);
    dispose = async () => {
      const { pool } = await import("../db/pool.js");
      await pool.end(); await c.end(); scratch.dispose();
    };
    return { c, lt, act };
  })();
  return ctxP;
}
const Q = { from: "2026-09-15", to: "2026-09-16", time: "all" as const };

test("#1313 ЖИВИЙ SQL: подія — перша зміна етапу НЕ в закриття, дзвінок (нотатка або Ringostat), поле; «Дубль» без події — «не взято»", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const deals = await x.lt.leadTakeDeals({ ...Q, source: "all" }, "dept", "all");
  const by = new Map(deals.map((d) => [d.kommoId, d]));
  assert.equal(deals.length, 8, "🔴 у вибірці не всі заявки фікстури — порожньо означає ПРОВАЛ");
  assert.deepEqual([by.get(101)?.event, by.get(101)?.bucket], ["зміна етапу", "m1"], "🔴 зміна етапу за 30 с не «до 1 хв»");
  assert.equal(by.get(102)?.bucket, "none", "🔴 «Дубль», закритий за 2 хв без дзвінка, не в «не взято»");
  assert.equal(by.get(103)?.bucket, "none", "🔴 перехід у закриття зарахований як взяття");
  assert.deepEqual([by.get(104)?.event, by.get(104)?.bucket], ["вихідний дзвінок", "m5"], "🔴 вихідний дзвінок не подія");
  assert.deepEqual([by.get(105)?.event, by.get(105)?.bucket], ["поле «Взято в работу»", "m60"], "🔴 поле «Взято в работу» не подія");
  assert.equal(by.get(107)?.event, "вихідний дзвінок", "🔴 дзвінок Ringostat того самого клієнта не знайдено");
  assert.deepEqual([by.get(108)?.offHours, by.get(108)?.bucket], [true, "m1"], "🔴 нічна заявка, взята о 08:10, не в нормі");
});

test("#1313b ЖИВИЙ SQL: кожне джерело й кампанія виконуються; група = Σ менеджерів, відділ = Σ груп; робочий + неробочий = все", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const n = async (q: Parameters<typeof x.lt.leadTakeTable>[0]) => (await x.lt.leadTakeTable(q)).rows.find((r) => r.kind === "dept")!.n;
  // Кожне джерело окремо — саме тут прогін на проді спіймав зайві параметри (запит падав для «Реклами»).
  assert.deepEqual([await n({ ...Q, source: "ad" }), await n({ ...Q, source: "site" }), await n({ ...Q, source: "leadgen" }), await n({ ...Q, source: "all" })],
    [6, 1, 1, 8], "🔴 розподіл за джерелами не той");
  assert.equal(await n({ ...Q, source: "ad", campaign: "brand" }), 1, "🔴 фільтр кампанії не працює");
  assert.equal(await n({ ...Q, source: "ad", campaign: x.lt.NO_CAMPAIGN }), 5, "🔴 «кампанія не вказана» не ловить порожні");
  const all = await x.lt.leadTakeTable({ ...Q, source: "all" });
  const groups = all.rows.filter((r) => r.kind === "group");
  for (const g of groups) assert.equal(all.rows.filter((r) => r.kind === "manager" && r.group === g.label).reduce((a, r) => a + r.n, 0), g.n, `🔴 група ${g.label} ≠ Σ менеджерів`);
  assert.equal(groups.reduce((a, r) => a + r.n, 0), 8, "🔴 відділ ≠ Σ груп");
  assert.deepEqual(groups.map((g) => g.label), ["РНК - Андрія", "РНК - Дарини", "РПК"], "🔴 групування не «команди РНК окремо, РПК разом»");
  assert.equal(await n({ ...Q, source: "all", time: "work" }) + await n({ ...Q, source: "all", time: "off" }), 8, "🔴 робочий + неробочий ≠ все");
  const dl = await x.lt.leadTakeDeals({ ...Q, source: "all" }, "dept", "none");
  assert.equal(dl.length, all.rows.find((r) => r.kind === "dept")!.notTaken, "🔴 список «не взято» ≠ числу в клітинці");
});

test("#1314 ДЖОБА АКТИВНОСТІ: перший вихідний дзвінок пишеться лише НЕ РАНІШЕ створення угоди й лише назад у часі", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const s = (ms: number) => Math.floor(ms / 1000);
  await x.act.applyNotes([{ entityId: 101, createdBy: 7, createdAt: s(T0 - 10 * MIN), noteType: "call_out", durationSec: 0 } as never]);
  const read = async () => (await x.c.query<{ v: Date | null }>(`SELECT first_call_out_at AS v FROM deals WHERE kommo_id = 101`)).rows[0].v;
  assert.equal(await read(), null, "🔴 дзвінок по старій угоді (до створення) записаний як взяття нової");
  await x.act.applyNotes([{ entityId: 101, createdBy: 0, createdAt: s(T0 + 5 * MIN), noteType: "call_out", durationSec: 0 } as never]);
  assert.equal((await read())?.getTime(), s(T0 + 5 * MIN) * 1000, "🔴 недодзвон від системного автора не рахується вихідним дзвінком");
  await x.act.applyNotes([{ entityId: 101, createdBy: 7, createdAt: s(T0 + 9 * MIN), noteType: "call_out", durationSec: 30 } as never]);
  assert.equal((await read())?.getTime(), s(T0 + 5 * MIN) * 1000, "🔴 пізніший дзвінок затер перший");
  await x.c.query(`UPDATE deals SET first_call_out_at = NULL WHERE kommo_id = 101`);
});
