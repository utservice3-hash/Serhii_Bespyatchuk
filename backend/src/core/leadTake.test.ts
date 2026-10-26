import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import {
  takeOf, bucketOf, statsOf, clockStart, kyivAt, weekRange, inColumn, NORM, isDuplicateLost, targetOf, kyivBucket, statsByBucket,
  type DealTake, type TakeRowInput,
} from "./leadTakeRules.js";
import { buildXlsx } from "./xlsxWrite.js";
import { parseXlsx, readZip } from "./officeParse.js";

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
  const buf = buildXlsx([{ name: "Час опрацювання", rows }, { name: "Угоди", rows: [["Угода"], ["#1"]] }]);
  // Наш `parseXlsx` поблажливий і ковтає неекранований `&`, який справжній Excel відкидає цілим файлом
  // (спіймано саботажем 02.10.2026: гейт лишався зеленим). Тому XML кожної частини звіряємо окремо.
  for (const [name, get] of readZip(buf)) {
    const xml = get().toString("utf8");
    assert.doesNotMatch(xml, /&(?!(amp|lt|gt|quot|apos);)/, `🔴 ${name}: неекранований & — Excel не відкриє файл`);
    for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      assert.doesNotMatch(m[1], /[<>]/, `🔴 ${name}: неекранована кутова дужка в тексті клітинки`);
  }
  const sheets = parseXlsx(buf);
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

/**
 * #1490 — ВИГЛЯД ВІКНА (06.10.2026, Роман: «це погано виглядає, пофікси»). Червоний ФОН — лише в рядках команди й
 * відділу; у менеджера порушення — червоним ТЕКСТОМ (інакше «до 1 хв» майже в усіх злипається в рожеві стовпці). Число
 * клікабельне без постійного підкреслення; норматив — у шапці колонок, а не окремим рядком.
 * 🧨 Червоніє, якщо повернути фон на всіх рядках, постійний пунктир чи окремий рядок «Норматив».
 */
test("#1490 ВИГЛЯД ВІКНА: червоний фон лише в рядках команди й відділу, норматив у шапці, без постійного пунктиру", () => {
  const src = readFileSync(path.join(ROOT, "frontend", "src", "pages", "dashboard", "sections", "LeadTakeCard.tsx"), "utf8");
  assert.match(src, /\.lt-tbl tr\.lt-team td\.lt-badbg,\.lt-tbl tr\.lt-dept td\.lt-badbg\{background:\$\{RED_BG\}\}/,
    "🔴 червоний фон не обмежено рядками команди й відділу");
  assert.doesNotMatch(src, /background: red \? RED_BG/, "🔴 червоний фон знову на кожній клітинці");
  assert.doesNotMatch(src, /underline dotted/, "🔴 повернувся постійний пунктир під числами");
  assert.doesNotMatch(src, /<td>Норматив<\/td>/, "🔴 норматив знову окремим рядком унизу");
  for (const norm of ["data.norm.m1Pct", "data.norm.m5Pct", "data.norm.notTaken"])
    assert.ok(src.slice(src.indexOf("<thead>"), src.indexOf("</thead>")).includes(norm), `🔴 у шапці немає ${norm}`);
  assert.match(src, /className=\{r\.kind === "manager" \? "lt-mgr" : r\.kind === "dept" \? "lt-dept" : "lt-team"\}/, "🔴 рядки не розрізняються за рівнем");
});

/**
 * #1491 — «ДУБЛЬ» — ЛИШЕ ДЗВІНОК АБО ПОЛЕ (рішення 07.10.2026, варіант «Б»). Закрита з причиною «Дубль» угода, у якої
 * етап змінився за 11 с і дзвінка не було, — «не взято», а не «до 1 хв». Дзеркала: «Дубль» із дзвінком — «взято» за
 * дзвінком; ЗВИЧАЙНА угода зі зміною етапу — «взято» за етапом, як у ТЗ; «Дубль» — лише точна причина й лише закрита (143).
 * 🧨 Червоніє, якщо правило зачепить не-«Дублі» або «Дубль» знову візьметься за зміною етапу.
 */
test("#1491 «ДУБЛЬ» ЛИШЕ ДЗВІНОК АБО ПОЛЕ: етап за 11 с — «не взято»; звичайна угода — за етапом, як і раніше", () => {
  const c = kyivAt(2026, 9, 2, 11, 55);
  const stage = c + 11_000, call = c + 40 * 60_000;
  assert.equal(takeOf({ createdAt: c, stageAt: stage, callAt: null, fieldAt: null, duplicate: true }).bucket, "none",
    "🔴 «Дубль» без дзвінка й поля взявся за автоматичною зміною етапу");
  const withCall = takeOf({ createdAt: c, stageAt: stage, callAt: call, fieldAt: null, duplicate: true });
  assert.equal(withCall.event, "call"); assert.equal(withCall.bucket, "m60", "«Дубль» із дзвінком — за дзвінком");
  const normal = takeOf({ createdAt: c, stageAt: stage, callAt: call, fieldAt: null });
  assert.equal(normal.event, "stage"); assert.equal(normal.bucket, "m1", "🔴 правило «Дубля» зачепило звичайну угоду");
  assert.equal(isDuplicateLost("143", "Дубль"), true);
  assert.equal(isDuplicateLost(143, " Дубль "), true);
  assert.equal(isDuplicateLost("142", "Дубль"), false, "успішна угода не «Дубль»-відмова");
  assert.equal(isDuplicateLost("143", "Немає зв'язку"), false, "🔴 правило зачепило іншу причину відмови");
  assert.equal(isDuplicateLost("143", null), false);
  const core = readFileSync(path.join(ROOT, "backend", "src", "core", "leadTake.ts"), "utf8");
  assert.match(core, /duplicate: isDuplicateLost\(x\.status_id, x\.reject_reason\)/, "🔴 вікно не передає ознаку «Дубля» в ядро");
});

// ── 🎯 ЦІЛЬ ПРОТИ ФАКТУ (Роман 26.10.2026) ─────────────────────────────────────────────────────────
/** 100 рядків: `k5` взято до 5 хв (із них `k1` — до 1 хв), `none` не взято, решта — за 20 хв. */
const shareRows = (k1: number, k5: number, none = 0): TakeRowInput[] => {
  const mk = (bucket: DealTake["bucket"], minutes: number | null): TakeRowInput =>
    ({ lost: false, take: { takenAt: minutes == null ? null : 1, event: minutes == null ? null : "stage", minutes, bucket, offHours: false } });
  return [...Array(k1).fill(0).map(() => mk("m1", 0.5)), ...Array(k5 - k1).fill(0).map(() => mk("m5", 3)),
    ...Array(100 - k5 - none).fill(0).map(() => mk("m30", 20)), ...Array(none).fill(0).map(() => mk("none", null))];
};
const CARD = () => readFileSync(path.join(ROOT, "frontend", "src", "pages", "dashboard", "sections", "LeadTakeCard.tsx"), "utf8");
const CORE = () => readFileSync(path.join(ROOT, "backend", "src", "core", "leadTake.ts"), "utf8");
const RULES = () => readFileSync(path.join(ROOT, "backend", "src", "core", "leadTakeRules.ts"), "utf8");
/** Тіло функції від заголовка до першого `}` на початку рядка — змістова межа, а не вікно в N символів. */
const fnBody = (src: string, head: string) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `🔴 не знайдено ${head}`);
  return src.slice(i, src.indexOf("\n}", i));
};

/**
 * #2440 — ЦІЛЬ БЕРЕТЬСЯ З `NORM`, А НЕ З ЛІТЕРАЛІВ. Ціль на екрані — те саме число, що підсвічує клітинки; літерал
 * «100» у рядку цілі збігся б із нормативом сьогодні й тихо розійшовся б із ним першої ж зміни нормативу.
 * 🧨 Червоніє, якщо в `targetOf` підставити число замість `NORM.*`, або в рядок цілі на екрані — «90» / «100» / «0».
 */
test("#2440 ЦІЛЬ = NORM: targetOf бере ціль із NORM, рядок цілі на екрані — лише з відповіді сервера, без літералів", () => {
  const body = fnBody(RULES(), "export function targetOf(");
  for (const k of ["NORM.m1Pct", "NORM.m5Pct", "NORM.notTaken"]) assert.ok(body.includes(k), `🔴 targetOf не бере ціль із ${k}`);
  assert.doesNotMatch(body, /share\(\s*\d/, "🔴 ціль частки в targetOf задана літералом");
  assert.doesNotMatch(body, /norm:\s*\d/, "🔴 ціль «не взято» в targetOf задана літералом");
  const t = targetOf(statsOf(shareRows(50, 80), null));
  assert.deepEqual([t.m1.norm, t.m5.norm, t.notTaken.norm], [NORM.m1Pct, NORM.m5Pct, NORM.notTaken], "🔴 ціль у відповіді ≠ NORM");
  const line = fnBody(CARD(), "function TargetLine(");
  for (const k of ["t.m5.norm", "t.m1.norm", "t.notTaken.norm"]) assert.ok(line.includes(`{${k}}`), `🔴 рядок цілі не показує ${k}`);
  assert.doesNotMatch(line.replace(/fontSize: \d+|fontWeight: \d+|gap: \d+|margin: "[^"]*"|lineHeight: [\d.]+/g, ""), /[—:]\s*\d+%?/,
    "🔴 у рядку цілі є число-літерал замість цілі з сервера");
});

/**
 * #2441 — ФАКТ = ЧАСТКА РЯДКА «ВІДДІЛ». Ціль судить рівно ті числа, що стоять у рядку: `target` будується з того самого
 * `statsOf`, а шапка картки бере рядок `kind === "dept"`, не перший і не останній.
 * 🧨 Червоніє, якщо шапка візьме `data.rows[0]` / групу, або ядро порахує ціль з інших угод, ніж рядок.
 */
test("#2441 ФАКТ ЦІЛІ = РЯДОК «ВІДДІЛ»: факт = частка того самого statsOf, шапка бере рядок dept", () => {
  const s = statsOf(shareRows(35, 35, 10), null);
  const t = targetOf(s);
  assert.deepEqual([t.m5.fact, t.m1.fact, t.notTaken.fact], [s.m5Pct, s.m1Pct, s.notTaken], "🔴 факт цілі ≠ числам рядка");
  assert.deepEqual([t.m5.met, t.m1.met, t.notTaken.met], [!s.red.m5, !s.red.m1, !s.red.notTaken], "🔴 «досягнуто» розійшлось із підсвічуванням клітинок");
  assert.match(CORE(), /const statsWithTarget = \(rs: Row\[\]\) => \{ const s = statsOf\(rs, avgCheck\); return \{ \.\.\.s, target: targetOf\(s\) \}; \};/,
    "🔴 ціль рядка рахується не з його ж statsOf");
  assert.match(CORE(), /kind: "dept", key: "dept", label: "ВІДДІЛ", \.\.\.statsWithTarget\(rows\)/, "🔴 рядок «ВІДДІЛ» не несе цілі над усім вибором");
  const card = CARD();
  assert.match(card, /const dept = data\?\.rows\.find\(\(r\) => r\.kind === "dept"\);/, "🔴 шапка цілі бере не рядок «ВІДДІЛ»");
  assert.match(card, /\{dept && <TargetLine dept=\{dept\} \/>\}/, "🔴 рядок цілі не змонтовано або змонтовано не з рядка «ВІДДІЛ»");
});

/**
 * #2442 — МЕЖА ЦІЛІ ПО ОБИДВА БОКИ: 100% «до 5 хв» — «досягнуто», 99% — «бракує 1 п.п.»; 90% «до 1 хв» — досягнуто,
 * 89% — «бракує 1 п.п.»; 0 не взятих — досягнуто, 1 — «понад ціль на 1». Порожній вибір — «немає заявок», а не «досягнуто».
 * 🧨 Червоніє, якщо зсунути порівняння або рахувати розрив не від цілі.
 */
test("#2442 МЕЖА ЦІЛІ: 100% — досягнуто, 99% — бракує 1 п.п.; 90/89 до 1 хв; 0/1 не взято; порожньо — немає заявок", () => {
  const at = targetOf(statsOf(shareRows(90, 100), null));
  assert.deepEqual([at.m5.met, at.m5.gap, at.m5.label], [true, 0, "досягнуто"], "🔴 100% до 5 хв не «досягнуто»");
  assert.deepEqual([at.m1.met, at.m1.label], [true, "досягнуто"], "🔴 90% до 1 хв не «досягнуто»");
  const below = targetOf(statsOf(shareRows(89, 99), null));
  assert.deepEqual([below.m5.met, below.m5.gap, below.m5.label], [false, 1, "бракує 1 п.п."], "🔴 99% до 5 хв — не «бракує 1 п.п.»");
  assert.deepEqual([below.m1.met, below.m1.label], [false, "бракує 1 п.п."], "🔴 89% до 1 хв — не «бракує 1 п.п.»");
  assert.equal(targetOf(statsOf(shareRows(20, 35), null)).m5.label, "бракує 65 п.п.", "🔴 розрив 35% від цілі 100% не 65 п.п.");
  assert.deepEqual([at.notTaken.met, at.notTaken.label], [true, "досягнуто"], "🔴 0 не взятих не «досягнуто»");
  const one = targetOf(statsOf(shareRows(90, 99, 1), null));
  assert.deepEqual([one.notTaken.met, one.notTaken.gap, one.notTaken.label], [false, 1, "понад ціль на 1"], "🔴 1 не взята не «понад ціль на 1»");
  const empty = targetOf(statsOf([], null));
  assert.deepEqual([empty.m5.met, empty.m5.label, empty.notTaken.label], [null, "немає заявок", "немає заявок"], "🔴 порожній вибір читається як «досягнуто»");
});

// ── 📈 СЕРІЯ «ЧАС ОПРАЦЮВАННЯ ЗАЯВКИ» У «СТАТИСТИКАХ» (Роман 26.10.2026) ─────────────────────────────
/** Неділя 20.09.2026 23:30 за Києвом (UTC — та сама неділя 20:30) і понеділок 21.09 00:30 за Києвом (UTC — ще НЕДІЛЯ 21:30). */
const SUN_LATE = kyivAt(2026, 9, 20, 23, 30), MON_EARLY = kyivAt(2026, 9, 21, 0, 30);
const takeRow = (createdAt: number, minutes: number | null) =>
  ({ createdAt, lost: false, take: { takenAt: minutes == null ? null : 1, event: minutes == null ? null : "stage" as const, minutes, bucket: bucketOf(minutes), offHours: false } });

/**
 * #2443 — КОШИК ТИЖНЯ ЗА КИЇВСЬКОЮ ДАТОЮ, МЕДІАНА З УГОД. Понеділок 00:30 за Києвом — це ще неділя за UTC; кошик за
 * UTC-датою віддав би його попередньому тижню, і серія розійшлась би з вікном Звіту (воно ріже період київською датою).
 * Кожен кошик — `statsOf` над угодами кошика; медіана місяця — з угод (3), а не медіана тижневих медіан (14.5).
 * 🧨 Червоніє, якщо кошикувати UTC-датою або рахувати медіану кошика з медіан.
 */
test("#2443 КОШИК СЕРІЇ: тиждень — Пн–Нд за Києвом (обидва боки межі), кошик = statsOf своїх угод, медіана місяця — з угод", () => {
  assert.equal(new Date(MON_EARLY).toISOString().slice(0, 10), "2026-09-20", "фікстура: понеділок 00:30 за Києвом мусить бути ще неділею за UTC");
  assert.deepEqual([kyivBucket(SUN_LATE, "week"), kyivBucket(MON_EARLY, "week")], ["2026-09-14", "2026-09-21"],
    "🔴 межа тижня не за Києвом: неділя 23:30 / понеділок 00:30 потрапили не у свої тижні");
  assert.deepEqual([kyivBucket(MON_EARLY, "day"), kyivBucket(MON_EARLY, "month"), kyivBucket(kyivAt(2026, 10, 1, 0, 10), "month")],
    ["2026-09-21", "2026-09-01", "2026-10-01"], "🔴 кошик дня / місяця не за київською датою");
  const w14 = [takeRow(SUN_LATE, 1), takeRow(kyivAt(2026, 9, 15, 10, 0), 2), takeRow(kyivAt(2026, 9, 15, 11, 0), 3)];
  const w21 = [takeRow(MON_EARLY, 4), takeRow(kyivAt(2026, 9, 23, 10, 0), 50), takeRow(kyivAt(2026, 9, 23, 11, 0), null)];
  const weeks = statsByBucket([...w21, ...w14], "week");
  assert.deepEqual(weeks.map((b) => b.bucket), ["2026-09-14", "2026-09-21"], "🔴 кошики не ті або не хронологічно");
  assert.deepEqual(weeks[0].stats, statsOf(w14, null), "🔴 тиждень 14.09 ≠ statsOf його угод (Пн–Нд за Києвом)");
  assert.deepEqual(weeks[1].stats, statsOf(w21, null), "🔴 тиждень 21.09 ≠ statsOf його угод (Пн–Нд за Києвом)");
  const month = statsByBucket([...w14, ...w21], "month");
  assert.equal(month.length, 1);
  assert.equal(month[0].stats.medianMin, 3, "🔴 медіана місяця не з угод (1,2,3,4,50 → 3) — схоже на медіану тижневих медіан (14.5)");
});

/**
 * #2444 — СЕРІЯ ЗА ТИЖДЕНЬ == ВІКНУ ЗВІТУ ЗА ТОЙ САМИЙ ТИЖДЕНЬ І ФІЛЬТР (живий SQL, scratch). Ліва частина — справжній
 * обчислювач «Статистик» (`COMPUTERS` роуту `/statistics/series`), права — `leadTakeTable` вікна, рядок «ВІДДІЛ», з
 * тим самим `SERIES_TAKE_FILTER`. Фікстура лежить по обидва боки межі тижня за Києвом: неділя 23:30 і понеділок 00:30.
 * Порожньо — ПРОВАЛ: кожен тиждень мусить мати заявки.
 * 🧨 Червоніє, якщо серія кошикує не київською датою, бере інший фільтр, ніж вікно, або йде повз ядро вікна.
 */
test("#2444 ЖИВИЙ SQL: серія «Статистик» за тиждень == рядок «ВІДДІЛ» вікна Звіту за той самий Пн–Нд і фільтр (обидва боки межі)", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const deal = (id: number, mgr: number, created: number) =>
    x.c.query(`INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, price, created_at_kommo, client_source, lead_channel)
               VALUES ($1, $2, $3, $4, 69693652, 0, $5, 'uts.ua', 'ad') ON CONFLICT (kommo_id) DO NOTHING`, [id, `заявка ${id}`, mgr, QUAL, iso(created)]);
  const ev = (id: number, at: number) =>
    x.c.query(`INSERT INTO deal_stage_events (kommo_id, pipeline_id, status_id, changed_at) VALUES ($1, $2, 69693652, $3)`, [id, QUAL, iso(at)]);
  await deal(201, 1, SUN_LATE); await ev(201, SUN_LATE + 3 * MIN);
  await deal(202, 1, MON_EARLY); await ev(202, kyivAt(2026, 9, 21, 8, 21));
  await deal(203, 3, kyivAt(2026, 9, 22, 10, 0)); await ev(203, kyivAt(2026, 9, 22, 10, 40));
  // Робочий час (серії «Статистик» — лише робочий, Роман 26.10.2026): у команди 13 тиждень 21.09 має свою заявку в робочі години.
  await deal(204, 1, kyivAt(2026, 9, 23, 11, 0)); await ev(204, kyivAt(2026, 9, 23, 11, 3));
  const { COMPUTERS } = await import("../routes/statisticsSeries.js");
  for (const teamId of [null, 13]) {
    const series = async (k: string) => new Map((await COMPUTERS[k]("week", "2026-09-14", "2026-09-27", teamId, null)).map((p) => [p.period, p.value]));
    const [m5, med] = [await series("lead_take_m5_pct"), await series("lead_take_median")];
    for (const wk of ["2026-09-14", "2026-09-21"]) {
      const w = weekRange(wk);
      const table: import("./leadTake.js").TakeTable = await x.lt.leadTakeTable({ ...w, ...x.lt.SERIES_TAKE_FILTER, teamId });
      const dept = table.rows.find((r) => r.kind === "dept")!;
      assert.ok(dept.n > 0, `🔴 тиждень ${wk} (команда ${teamId ?? "усі"}) порожній — звіряти нема що, це ПРОВАЛ`);
      assert.equal(m5.get(wk), dept.m5Pct ?? undefined, `🔴 «Взято до 5 хв» тижня ${wk} (команда ${teamId ?? "усі"}): серія ≠ вікно Звіту`);
      assert.equal(med.get(wk), dept.medianMin ?? undefined, `🔴 медіана тижня ${wk} (команда ${teamId ?? "усі"}): серія ≠ вікно Звіту`);
    }
  }
  // Межа тижня за Києвом — на ядрі серій із фільтром «Все» (заявки на межі неділя 23:30 / понеділок 00:30 — неробочі, тож
  // під робочим фільтром серій їх не видно): неділя — у тижні 14.09 (8 заявок фікстури + вона), понеділок — у 21.09.
  const all = { source: "all" as const, time: "all" as const };
  const byWeek = new Map((await x.lt.leadTakeSeries({ from: "2026-09-14", to: "2026-09-27", ...all }, "week")).map((p) => [p.bucket, p.stats.n]));
  const n = async (wk: string) => (await x.lt.leadTakeTable({ ...weekRange(wk), ...all })).rows.find((r) => r.kind === "dept")!.n;
  assert.deepEqual([byWeek.get("2026-09-14"), byWeek.get("2026-09-21")], [await n("2026-09-14"), await n("2026-09-21")], "🔴 ядро серій кошикує тиждень інакше, ніж вікно");
  assert.deepEqual([await n("2026-09-14"), await n("2026-09-21")], [9, 3], "🔴 заявки на межі тижня за Києвом не у своїх тижнях");
});

/**
 * #2444b — РІШЕННЯ ВЛАСНИКА: СЕРІЇ «СТАТИСТИК» — ЛИШЕ РОБОЧИЙ ЧАС (Роман 26.10.2026). `#2444` стереже, що серія == вікну за
 * ТИМ САМИМ фільтром, тож заміну фільтра не помітив би; цей гейт тримає саме значення, а ⓘ графіка каже правду про нього.
 * 🧨 Червоніє, якщо серії знову рахують увесь час доби або підказка обіцяє не той фільтр.
 */
test("#2444b СЕРІЇ ЧАСУ ОПРАЦЮВАННЯ: лише робочий час, усі джерела; ⓘ графіка каже те саме", () => {
  const core = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "core", "leadTake.ts"), "utf8");
  assert.match(core, /export const SERIES_TAKE_FILTER: Pick<TakeQuery, "source" \| "time"> = \{ source: "all", time: "work" \};/,
    "🔴 серії «Статистик» рахують не робочий час (рішення Романа 26.10.2026)");
  const fe = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "StatisticsChartsSection.tsx"), "utf8");
  assert.match(fe, /ЛИШЕ в робочий час/, "🔴 ⓘ графіка не каже, що рахується лише робочий час");
  assert.doesNotMatch(fe, /увесь час доби/, "🔴 ⓘ графіка досі обіцяє увесь час доби");
});

/**
 * #2445 — ПОКАЗНИК Є В КАТАЛОЗІ Й У МЕНЮ ФРОНТУ. Серверний обчислювач без пункту меню — мертвий показник; пункт меню без
 * обчислювача — порожній графік, що читається як «немає даних». Обидва показники — у `CRM_ABLE` (ряд від шва), у
 * `COMPUTERS` через ядро вікна, у категорії «Ліди й канали» зі своєю одиницею, медіаною (не середнім) і застереженням
 * про порожні до вересня поле й нотатки.
 * 🧨 Червоніє, якщо прибрати пункт меню, обчислювач, запис у каталозі або застереження з ⓘ.
 */
test("#2445 КАТАЛОГ І МЕНЮ: «Медіана часу опрацювання заявки, хв» і «Взято до 5 хв, %» — у CRM_ABLE, COMPUTERS і меню «Статистик»", async () => {
  const { isCrmAble } = await import("../statistics/seriesCatalog.js");
  for (const k of ["lead_take_median", "lead_take_m5_pct"]) assert.ok(isCrmAble("sales", k), `🔴 ${k} не в каталозі CRM_ABLE`);
  const route = readFileSync(path.join(ROOT, "backend", "src", "routes", "statisticsSeries.ts"), "utf8");
  assert.match(route, /\blead_take_median: leadTakeC\(\(s\) => s\.medianMin\),/, "🔴 медіана не з medianMin ядра вікна");
  assert.match(route, /\blead_take_m5_pct: leadTakeC\(\(s\) => s\.m5Pct\),/, "🔴 «до 5 хв» не з m5Pct ядра вікна");
  assert.match(route, /await leadTakeSeries\(\{ from, to, \.\.\.SERIES_TAKE_FILTER, teamId, managerId \}, g\)/, "🔴 обчислювач іде повз ядро вікна або без фільтра вікна");
  const fe = readFileSync(path.join(ROOT, "frontend", "src", "pages", "dashboard", "sections", "StatisticsChartsSection.tsx"), "utf8");
  const leads = fe.slice(fe.indexOf(`{ key: "leads"`), fe.indexOf(`{ key: "clients"`));
  assert.match(leads, /\{ key: "lead_take_median", block: "sales", label: "Медіана часу опрацювання заявки, хв", unit: "хв",/, "🔴 медіани немає в меню «Ліди й канали»");
  assert.match(leads, /\{ key: "lead_take_m5_pct", block: "sales", label: "Взято до 5 хв, %", unit: "%",/, "🔴 «Взято до 5 хв» немає в меню «Ліди й канали»");
  assert.ok(fe.includes("до вересня поле «Взято в роботу» й нотатки-дзвінки майже порожні — частка «взято» тоді спиралась на етап і Ringostat"),
    "🔴 у ⓘ немає застереження про порожні до вересня поле й нотатки");
  assert.doesNotMatch(leads, /lead_take_(avg|mean)|label: "[^"]*середн/i, "🔴 з'явилось середнє — рішення власника: лише медіана");
});

/**
 * #2446 — ДОСТУП ТОЙ САМИЙ, ЩО В ІНШИХ СЕРІЙ: нового роуту немає (показники їдуть через наявний `GET /series`, межа —
 * вкладка `statistics`), скоуп — `teamId`/`managerId` з `seriesSet` (серверний клам ролі). Отже матриця не змінюється.
 * 🧨 Червоніє, якщо додати роут у `statsSeriesRouter`, або обчислювач перестане брати скоуп серії (тімлід побачив би компанію).
 */
test("#2446 ДОСТУП: нових роутів «Статистик» немає, показники — через наявний /series із клампом скоупу серії", () => {
  const route = readFileSync(path.join(ROOT, "backend", "src", "routes", "statisticsSeries.ts"), "utf8");
  const paths = [...route.matchAll(/statsSeriesRouter\.(get|post|put|patch|delete)\("([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(paths, ["GET /series", "GET /summary", "GET /plan-fact", "GET /lapsed-clients", "POST /series/manual"], "🔴 склад роутів «Статистик» змінився — потрібен запис у матриці");
  assert.match(route, /const leadTakeC = \(pick: \(s: TakeStats\) => number \| null\): Computer => async \(g, from, to, teamId, managerId\) =>/,
    "🔴 обчислювач не бере скоуп серії");
  assert.match(route, /if \(metric in COMPUTERS\) crm = await COMPUTERS\[metric\]\(g, from > STATS_SEAM \? from : STATS_SEAM, to, sc\.teamId, sc\.managerId\);/,
    "🔴 серію рахують не зі скоупу seriesSet або не від шва");
  const matrix = readFileSync(path.join(ROOT, "backend", "src", "auth", "accessMatrix.ts"), "utf8");
  assert.match(matrix, /\{ method: "GET", path: "\/api\/statistics\/series", cls: "GET",/, "🔴 /api/statistics/series зник із матриці");
});
