/**
 * 📤 Банківські операції → «Data» фінансів (18.11.2026). Ядро — `core/dataSheetRows.ts`, джоба — `jobs/exportDataSheet.ts`,
 * запис — `insertDataRows` у `bankSources/googleSheetsWrite.ts`. Кожен гейт — з прикладом по обидва боки своєї межі.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import {
  toDataRow, splitForExport, sheetSerial, buildInsertRequests, assertAppendOnly, shiftFormula, EXPORT_SELECT_SQL, DATA_SHEET_FROM,
  DATA_SHEET_ACCOUNTS, DATA_SHEET_EXCLUDED, type ExportTx,
} from "./dataSheetRows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(here, "../../src/db/schema.sql");
const SRC = (p: string) => readFileSync(path.resolve(here, "../../src", p), "utf8");

/** Формули рядка-шаблону 25101 у тому вигляді, як їх віддає Google (українська локаль: «;» і «1,2»). */
const TPL: Record<number, string> = {
  1: "=YEAR(E25101)", 2: "=month(E25101)",
  8: '=IF(H25101="UAH";1;IFERROR(INDEX(GOOGLEFINANCE("CURRENCY:USDUAH";"price";E25101-1);2;2);""))',
  9: "=IFERROR(IF(H25101=\"UAH\";G25101;G25101*INDEX('FX rate'!L:L;MATCH(INT(E25101);ARRAYFORMULA(INT('FX rate'!K:K));0)));\"\")",
  10: '=IF(AND(REGEXMATCH(M25101;"(?i)ютс");NOT(REGEXMATCH(Q25101;"(?i)без ПДВ")));"✅";"❌")',
  11: '=IF(K25101="✅";J25101/1,2;J25101)', 18: '=IF(R25101="";"";IFERROR(VLOOKUP(R25101;CoA!$B:$C;2;0);""))',
};

const tx = (o: Partial<ExportTx>): ExportTx => ({
  id: 1, account_id: 1, day: "2026-11-17", amount: "-1500.5", currency: "UAH", counterparty_name: "ТОВ «Тест»", purpose: "Оплата", ...o,
});

/**
 * #9981 — РЯДОК DATA: D — дата 1-го числа місяця (ЧИСЛО-дата, не текст «07.2026»), E — дата операції, G — число,
 * Q — ЗАВЖДИ текст (призначення з самих цифр інакше ламає формулу ПДВ), Сейф — «Сейф <валюта>» без хвоста «· угода N».
 * 🧨 Червоніє на текстовому D, зсуві дати на день, числовому Q, хвості угоди в Сейфі чи зрізаному призначенні банку.
 */
test("#9981 РЯДОК DATA: D — 1-ше число датою, E — день, Q — текстом, Сейф без «· угода N», банк — як є", () => {
  assert.equal(sheetSerial("2026-07-01"), 46204, "🔴 серійний номер дати зсунувся");
  assert.equal(sheetSerial("2026-11-17"), 46343);
  assert.equal(sheetSerial("1899-12-31"), 1);
  const r = toDataRow(tx({ day: "2026-11-17", purpose: "62586299" }))!;
  assert.equal(r.d, sheetSerial("2026-11-01"), "🔴 «Період» не перше число місяця");
  assert.equal(typeof r.d, "number", "🔴 «Період» не дата");
  assert.equal(r.e, sheetSerial("2026-11-17"));
  assert.equal(r.g, -1500.5);
  assert.deepEqual([r.m, r.n, r.o, r.h], ['ТОВ "ЮТС"', "ТОВ ЮТС", "ТОВ «Тест»", "UAH"]);
  assert.equal(r.q, "62586299");
  // Q доходить до Google саме stringValue — інакше Google зробить з нього число (#VALUE! у ПДВ).
  const req = buildInsertRequests(5, 25101, [r], TPL) as any[];
  const mq = req[2].updateCells.rows[0].values;
  assert.deepEqual(mq[4], { userEnteredValue: { stringValue: "62586299" } }, "🔴 призначення пішло не текстом");
  assert.deepEqual(req[1].updateCells.rows[0].values[0], { userEnteredValue: { numberValue: r.d } }, "🔴 «Період» пішов не числом-датою");
  // Сейф: рахунок за валютою рядка, без контрагента, хвіст угоди знято; той самий хвіст у банку — НЕ чіпаємо.
  const safe = toDataRow(tx({ account_id: 7, currency: "EUR", counterparty_name: "Хтось", purpose: "По угоді Зейдана · угода 41234" }))!;
  assert.deepEqual([safe.m, safe.n, safe.o, safe.q], ["Сейф EUR", "Сейф", "", "По угоді Зейдана"], "🔴 рядок Сейфу не такий, як у Data");
  assert.equal(toDataRow(tx({ purpose: "Рахунок · угода 5" }))!.q, "Рахунок · угода 5", "🔴 у банківського призначення зрізано текст");
  assert.throws(() => toDataRow(tx({ amount: "abc" })), /не число/);
});

/**
 * #9982 — НЕВІДОМИЙ РАХУНОК НЕ ЗНИКАЄ МОВЧКИ: описані → рядки, виключені з причиною → лічильник, решта → `unmapped`,
 * а джоба на `unmapped` завершується помилкою (після запису описаних). Кожне виключення має причину.
 * 🧨 Червоніє, якщо невідомий рахунок потрапить у рядки з порожнім M або зникне без сліду.
 */
test("#9982 НЕВІДОМИЙ РАХУНОК: описані — у Data, виключені — з причиною, невідомі — помилка прогону, а не тиша", () => {
  const s = splitForExport([tx({ id: 1, account_id: 1 }), tx({ id: 2, account_id: 8 }), tx({ id: 3, account_id: 12 }), tx({ id: 4, account_id: 12 })]);
  assert.deepEqual(s.rows.map((r) => r.txId), [1]);
  assert.deepEqual(s.excluded, [{ accountId: 8, count: 1 }]);
  assert.deepEqual(s.unmapped, [{ accountId: 12, count: 2 }], "🔴 невідомий рахунок не названо");
  for (const [id, why] of Object.entries(DATA_SHEET_EXCLUDED)) {
    assert.ok(why.trim().length > 20, `🔴 рахунок ${id} виключено без причини`);
    assert.ok(!(Number(id) in DATA_SHEET_ACCOUNTS), `🔴 рахунок ${id} і описаний, і виключений`);
  }
  const job = SRC("jobs/exportDataSheet.ts");
  assert.match(job, /if \(split\.unmapped\.length\) \{\s*throw new Error/, "🔴 джоба мовчить про невідомі рахунки");
});

/**
 * #9983 — ЗАПИТ ЛИШЕ ДОДАЄ: вставка рядків рівно після останнього заповненого (з форматом рядка вище), значення й
 * формули — лише в нові рядки, усе одним batchUpdate. Захист стоїть і в рантаймі (`assertAppendOnly` перед відправкою).
 * 🧨 Червоніє на видаленні/очищенні, записі в наявний рядок, вставці не там, звичайному (не формульному) копіюванні,
 * чи на другому запиті до batchUpdate у писарі.
 */
test("#9983 ЗАПИТ ЛИШЕ ДОДАЄ: вставка після останнього рядка, запис і формули лише в нові рядки, один batchUpdate", () => {
  const rows = [toDataRow(tx({ id: 1 }))!, toDataRow(tx({ id: 2 }))!];
  const ok = buildInsertRequests(795952987, 25101, rows, TPL) as any[];
  assert.doesNotThrow(() => assertAppendOnly(ok, 25101, 2), "🔴 правильний запит відхилено");
  assert.deepEqual(ok[0].insertDimension.range, { sheetId: 795952987, dimension: "ROWS", startIndex: 25101, endIndex: 25103 });
  assert.equal(ok[0].insertDimension.inheritFromBefore, true, "🔴 нові рядки без формату рядка вище");
  assert.equal(ok.filter((r) => r.copyPaste).length, 0, "🔴 повернулось copyPaste — під фільтром фінансиста Google його відхиляє (19–20.11.2026)");
  const fcells = ok.slice(3).map((r) => [r.updateCells.start.columnIndex, r.updateCells.rows[0].values.length]);
  assert.deepEqual(fcells, [[1, 2], [8, 4], [18, 1]], "🔴 формули пишуться не в B–C, I–L, S");
  assert.equal(ok[3].updateCells.rows[1].values[0].userEnteredValue.formulaValue, "=YEAR(E25103)", "🔴 формула другого нового рядка не на свій рядок");
  const bad = (mut: (r: any[]) => void) => { const r = structuredClone(ok); mut(r); return r; };
  const cases: [string, any[]][] = [
    ["видалення рядків", bad((r) => r.push({ deleteDimension: { range: { sheetId: 1, dimension: "ROWS", startIndex: 0, endIndex: 1 } } }))],
    ["очищення", bad((r) => r.push({ updateCells: { range: {}, fields: "*" } }))],
    ["запис у наявний рядок", bad((r) => { r[1].updateCells.start.rowIndex = 25100; })],
    ["вставка не там", bad((r) => { r[0].insertDimension.range.startIndex = 100; r[0].insertDimension.range.endIndex = 102; })],
    ["копіювання (будь-яке)", bad((r) => r.push({ copyPaste: { source: {}, destination: {}, pasteType: "PASTE_FORMULA" } }))],
    ["формули поверх наявних", bad((r) => { r[3].updateCells.start.rowIndex = 25000; })],
  ];
  for (const [why, req] of cases) assert.throws(() => assertAppendOnly(req, 25101, 2), /Data:/, `🔴 пропущено: ${why}`);
  const writer = SRC("bankSources/googleSheetsWrite.ts");
  const fn = writer.slice(writer.indexOf("export async function insertDataRows"));
  assert.equal(fn.match(/:batchUpdate`/g)?.length, 1, "🔴 запис у Data — не одним атомарним batchUpdate");
  assert.ok(fn.indexOf("assertAppendOnly(") > 0 && fn.indexOf("assertAppendOnly(") < fn.indexOf(":batchUpdate`"),
    "🔴 рантайм-захист не стоїть перед відправкою");
});

/**
 * #9985 — ЗСУВ ФОРМУЛИ ШАБЛОНУ: посилання на свій рядок отримують новий номер; цілі колонки інших вкладок (`CoA!$B:$C`,
 * `'FX rate'!L:L`), текст у лапках («CURRENCY:USDUAH»), числа з комою (`1,2`) і назви функцій — без змін; посилання на
 * чужий або абсолютний рядок — відмова, а не тихий зсув. Живі формули Data (20.11.2026) — як фікстура.
 * 🧨 Червоніє, якщо зсув зачепить колонку іншої вкладки, лапки чи число, або мовчки «зсуне» посилання на чужий рядок.
 */
test("#9985 ЗСУВ ФОРМУЛИ: свій рядок → новий, колонки інших вкладок, лапки й числа — як є; чужий рядок — відмова", () => {
  assert.equal(shiftFormula(TPL[1], 25101, 25102), "=YEAR(E25102)");
  assert.equal(shiftFormula(TPL[11], 25101, 30000), '=IF(K30000="✅";J30000/1,2;J30000)', "🔴 зачеплено число 1,2 чи пропущено посилання");
  assert.equal(shiftFormula(TPL[18], 25101, 25102), '=IF(R25102="";"";IFERROR(VLOOKUP(R25102;CoA!$B:$C;2;0);""))', "🔴 зачеплено CoA!$B:$C");
  assert.equal(shiftFormula(TPL[9], 25101, 25102), TPL[9].replaceAll("25101", "25102"), "🔴 зачеплено 'FX rate'!L:L");
  assert.equal(shiftFormula(TPL[8], 25101, 25102), TPL[8].replaceAll("25101", "25102"));
  assert.match(shiftFormula(TPL[8], 25101, 25102), /"CURRENCY:USDUAH"/, "🔴 зачеплено текст у лапках");
  assert.equal(shiftFormula('=IF(A1="E25101";1;2)', 1, 7), '=IF(A7="E25101";1;2)', "🔴 зсунуто текст у лапках");
  assert.equal(shiftFormula("=LOG10(E5)", 5, 6), "=LOG10(E6)", "🔴 назву функції прийнято за клітинку");
  for (const bad of ["=E25100+E25101", "=E$25101", "=SUM(E1:E25101)"]) {
    assert.throws(() => shiftFormula(bad, 25101, 25102), /не на свій рядок/, `🔴 «${bad}» зсунуто мовчки`);
  }
  assert.throws(() => shiftFormula("2026", 1, 2), /не формула/);
});

// ── Живий SQL і джоба: один тимчасовий кластер на файл ──────────────────────────────────────────────────────────
type Cluster = { url: string; q: (sql: string, p?: unknown[]) => Promise<any[]>; done: () => Promise<void> };
let shared: Promise<Cluster | { unavailable: string }> | null = null;
async function cluster(t: { skip: (m: string) => void }): Promise<Cluster | null> {
  shared ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const s = provisionScratch();
    if ("unavailable" in s) return { unavailable: skipReason(s) };
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: s.url });
    await c.connect();
    await c.query(readFileSync(SCHEMA, "utf8"));
    for (const [id, bank] of [[1, "privat"], [7, "privat"], [8, "mono"], [12, "privat"]] as const) {
      await c.query(`INSERT INTO bank_accounts (id, company, bank, label) VALUES ($1, 'uts', $2, $3) ON CONFLICT (id) DO NOTHING`, [id, bank, `рахунок ${id}`]);
    }
    return { url: s.url, q: async (sql: string, p?: unknown[]) => (await c.query(sql, p)).rows, done: async () => { await c.end(); s.dispose(); } };
  })();
  const s = await shared;
  if ("unavailable" in s) { t.skip(s.unavailable); return null; }
  return s;
}
after(async () => { const s = shared && (await shared); if (s && !("unavailable" in s)) await s.done(); });

let txSeq = 900_000;
async function addTx(c: Cluster, o: { account?: number; kyiv: string; amount?: number; deleted?: boolean; currency?: string; purpose?: string }): Promise<number> {
  const id = ++txSeq;
  await c.q(`INSERT INTO bank_transactions (id, account_id, direction, external_tx_id, booked_at, amount, currency, purpose, counterparty_name, deleted_at)
    VALUES ($1, $2, $3, $4, ($5::timestamp AT TIME ZONE 'Europe/Kyiv'), $6, $7, $8, 'Контрагент', $9)`,
    [id, o.account ?? 1, (o.amount ?? -100) < 0 ? "out" : "in", `t-${id}`, o.kyiv, o.amount ?? -100, o.currency ?? "UAH", o.purpose ?? "призначення", o.deleted ? new Date() : null]);
  return id;
}
/** Київська дата «сьогодні» / «вчора» у мить тесту — межа «лише повні дні» рухається з календарем. */
const kyivDay = (shift: number) => {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
  d.setDate(d.getDate() + shift);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * #9980 — ВІДБІР: не видалені; від 01.07.2026 за КИЇВСЬКОЮ датою (30.06 23:30 Київ — ні, 01.07 00:10 — так); лише повні
 * дні (сьогодні — ні, вчора 23:50 — так); уже записане (done і pending) — ні; запізніла стара операція — так.
 * 🧨 Червоніє без `deleted_at IS NULL`, з UTC-межею, з «сьогодні» у вибірці чи без перевірки обліку.
 */
test("#9980 ЖИВИЙ SQL: відбір — не видалені, від 01.07 за Києвом, до вчора, ще не записані; запізніла — так", async (t) => {
  const c = await cluster(t); if (!c) return;
  const ids = {
    beforeStart: await addTx(c, { kyiv: "2026-06-30 23:30" }),
    atStart: await addTx(c, { kyiv: "2026-07-01 00:10" }),
    deleted: await addTx(c, { account: 7, kyiv: "2026-10-06 12:00", deleted: true }),
    alive: await addTx(c, { account: 7, kyiv: "2026-10-06 12:00" }),
    today: await addTx(c, { kyiv: `${kyivDay(0)} 00:05` }),
    yesterday: await addTx(c, { kyiv: `${kyivDay(-1)} 23:50` }),
    done: await addTx(c, { kyiv: "2026-08-01 10:00" }),
    pending: await addTx(c, { kyiv: "2026-08-01 11:00" }),
    late: await addTx(c, { kyiv: "2026-07-15 09:00" }),
  };
  await c.q(`INSERT INTO data_sheet_exports (tx_id, status) VALUES ($1, 'done'), ($2, 'pending')`, [ids.done, ids.pending]);
  try {
    const got = new Set((await c.q(EXPORT_SELECT_SQL, [DATA_SHEET_FROM])).map((r) => Number(r.id)));
    const want = { beforeStart: false, atStart: true, deleted: false, alive: true, today: false, yesterday: true, done: false, pending: false, late: true };
    for (const [k, v] of Object.entries(want)) assert.equal(got.has(ids[k as keyof typeof ids]), v, `🔴 ${k}: ${v ? "мав потрапити" : "не мав потрапити"} у вибірку`);
    const day = (await c.q(EXPORT_SELECT_SQL, [DATA_SHEET_FROM])).find((r) => Number(r.id) === ids.atStart)?.day;
    assert.equal(day, "2026-07-01", "🔴 день операції не київський");
  } finally {
    await c.q(`DELETE FROM data_sheet_exports WHERE tx_id = ANY($1::int[])`, [Object.values(ids)]);
    await c.q(`DELETE FROM bank_transactions WHERE id = ANY($1::int[])`, [Object.values(ids)]);
  }
});

/**
 * #9984 — ОБЛІК У ДВА КРОКИ, ДЖОБОЮ ПРОТИ БАЗИ З НУЛЯ (Google підмінено): `dry` не ходить у мережу й не пише облік;
 * `on` — один batchUpdate, облік `done` із номерами рядків; Google відмовив — облік прибрано (повтор безпечний);
 * обрив без відповіді — облік лишається `pending`, і НАСТУПНИЙ прогін падає без жодного запису; невідомий рахунок —
 * описані записано, прогін — помилка з номером рахунку.
 * 🧨 Червоніє, якщо обрив дає повтор (дубль у фінансах), відмова блокує повтор, `dry` пише, чи невідомий рахунок мовчить.
 */
test("#9984 ЖИВИЙ SQL: облік у два кроки — dry без запису, успіх → done, відмова → повтор, обрив → стоп; невідомий рахунок — помилка", async (t) => {
  const c = await cluster(t); if (!c) return;
  const keyDir = mkdtempSync(path.join(tmpdir(), "ds-key-"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(path.join(keyDir, "sa.json"), JSON.stringify({ client_email: "t@t.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
  Object.assign(process.env, { DATABASE_URL: c.url, JWT_SECRET: "scratch-only", KOMMO_BASE_URL: "http://127.0.0.1:9", KOMMO_API_TOKEN: "scratch",
    GA4_SERVICE_ACCOUNT_JSON: path.join(keyDir, "sa.json"), DATA_SHEET_MODE: "dry" });
  const { config } = await import("../config.js");
  const { exportDataSheet } = await import("../jobs/exportDataSheet.js");
  const { pool } = await import("../db/pool.js");

  let batch: "ok" | "500" | "drop" = "ok";
  const calls: string[] = [];
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("oauth2.googleapis.com/token")) return j({ access_token: "tok", expires_in: 3600 });
    if (url.includes(":batchUpdate")) {
      if (batch === "drop") throw new Error("socket hang up");
      if (batch === "500") return j({ error: { message: "boom" } }, 500);
      bodies.push(JSON.parse(String(init?.body))); return j({ replies: [] });
    }
    if (url.includes("fields=sheets.properties")) return j({ sheets: [{ properties: { sheetId: 795952987, title: "Data" } }] });
    if (url.includes(encodeURIComponent("Data!E1:E"))) return j({ values: [["", "Дата платежу", "01.06.2026", "02.06.2026"]] });
    if (url.includes("fields=sheets.data.rowData")) {
      const f = (x: string) => ({ userEnteredValue: { formulaValue: x } });
      return j({ sheets: [{ data: [{ rowData: [{ values: [{}, f("=YEAR(E4)"), f("=month(E4)"), {}, {}, {}, {}, {}, f("=IF(H4=\"UAH\";1;2)"), f("=G4*I4"),
        f("=IF(REGEXMATCH(M4;\"ютс\");\"✅\";\"❌\")"), f("=IF(K4=\"✅\";J4/1,2;J4)"), {}, {}, {}, {}, {}, {}, f("=IF(R4=\"\";\"\";R4)")] }] }] }] });
    }
    return j({ error: { message: `неочікуваний запит ${url}` } }, 400);
  }) as typeof fetch;
  const a = await addTx(c, { kyiv: "2026-11-10 10:00", amount: 500 });
  const b = await addTx(c, { account: 7, kyiv: "2026-11-11 10:00", amount: -40, purpose: "Готівка · угода 7" });
  const ledger = async () => (await c.q(`SELECT tx_id, status, sheet_row FROM data_sheet_exports WHERE tx_id = ANY($1::int[]) ORDER BY tx_id`, [[a, b]]))
    .map((r) => `${r.tx_id}:${r.status}:${r.sheet_row ?? "-"}`);
  try {
    // dry — рахує, але ні мережі, ні обліку.
    config.dataSheet.mode = "dry";
    const dry = (await exportDataSheet()) as Record<string, any>;
    assert.equal(dry.rows, 2);
    assert.equal(calls.length, 0, "🔴 dry ходив у Google");
    assert.deepEqual(await ledger(), [], "🔴 dry записав облік");

    // on, Google відмовив (атомарно — нічого не лягло) → облік прибрано, повтор можливий.
    config.dataSheet.mode = "on";
    batch = "500";
    await assert.rejects(exportDataSheet(), /boom/);
    assert.deepEqual(await ledger(), [], "🔴 після відмови Google облік лишився — повтор заблоковано");

    // on, успіх → один batchUpdate, рядки 5 і 6 (останній з датою — 4), облік done.
    batch = "ok";
    const ok = (await exportDataSheet()) as Record<string, any>;
    assert.equal(ok.firstRow, 5);
    assert.equal(bodies.length, 1, "🔴 не один batchUpdate");
    assert.equal(bodies[0].requests[2].updateCells.rows[1].values[4].userEnteredValue.stringValue, "Готівка", "🔴 Сейф із хвостом угоди");
    assert.equal(bodies[0].requests[3].updateCells.rows[1].values[0].userEnteredValue.formulaValue, "=YEAR(E6)", "🔴 формула рядка 6 не на свій рядок");
    assert.ok(!bodies[0].requests.some((r: any) => r.copyPaste), "🔴 у запиті copyPaste — під фільтром Google його відхиляє");
    assert.deepEqual(await ledger(), [`${a}:done:5`, `${b}:done:6`]);
    assert.equal(((await exportDataSheet()) as Record<string, any>).rows, 0, "🔴 записане пішло вдруге");

    // обрив без відповіді → pending лишається, наступний прогін падає, нічого не відправивши.
    const d = await addTx(c, { kyiv: "2026-11-12 10:00" });
    batch = "drop";
    await assert.rejects(exportDataSheet(), /обірвався/);
    assert.equal((await c.q(`SELECT status FROM data_sheet_exports WHERE tx_id = $1`, [d]))[0]?.status, "pending", "🔴 після обриву облік прибрано — буде дубль");
    batch = "ok";
    const before = bodies.length;
    await assert.rejects(exportDataSheet(), new RegExp(`у процесі[\\s\\S]*${d}`), "🔴 після обриву джоба поїхала далі");
    assert.equal(bodies.length, before, "🔴 після обриву щось записано повторно");
    await c.q(`UPDATE data_sheet_exports SET status = 'done' WHERE tx_id = $1`, [d]);

    // невідомий рахунок: описаний записано, прогін — помилка з номером рахунку.
    const known = await addTx(c, { kyiv: "2026-11-13 10:00" });
    await addTx(c, { account: 12, kyiv: "2026-11-13 10:00" });
    await assert.rejects(exportDataSheet(), /записано 1[\s\S]*рахунок 12: 1/, "🔴 невідомий рахунок промовчано");
    assert.equal((await c.q(`SELECT status FROM data_sheet_exports WHERE tx_id = $1`, [known]))[0]?.status, "done", "🔴 через невідомий рахунок не записано відомий");
  } finally {
    globalThis.fetch = realFetch;
    await pool.end();
  }
});
