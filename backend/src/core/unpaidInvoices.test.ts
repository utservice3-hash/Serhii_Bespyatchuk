import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseUnpaid, unpaidFxTotals, UNPAID_FROM, type UnpaidInvoice } from "./unpaidInvoices.js";

/**
 * 💱 Валютна дебіторка з сервісу неоплачених рахунків 1С (задача #5297; Роман 26.10.2026: «роби лише 2026 рік і щоб можна
 * було глянути що сам там не так»). Гейти `#1286`–`#1286d` (вільні в `main` і в усіх гілках на 26.10.2026); наступники
 * знятих `#994` / `#995` (рахунок 362). Замір 26.10: 7 валютних рахунків 2026 року на 6 073 EUR — у Тетяни 6 060.
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const inv = (o: Record<string, unknown>) => ({ uid: "u", number: "000008471", date: "2026-10-12", organization: 'ТОВ "АвтоМув"', contractor: "ODM Nexus", edrpou: "CZ1",
  currency: "EUR", invoice_sum: 1800, realized_sum: 0, paid_sum: 0, remaining: 1800, realization_status: "not_realized", payment_status: "unpaid",
  debt_account: null, due_date: null, manager: "Менеджер", id_amo: "62752319", comment: "62752319 / Менеджер", ...o });

/**
 * #1286 — РОЗБІР НЕОПЛАЧЕНИХ. `state: false` (кривий параметр) чи немає списку — помилка, не «боргів немає»; лише рахунки з
 * 01.01.2026 (31.12.2025 — ні) і залишком > 0; угода — лише 8 цифр. Підсумок — лише валютні рахунки: EUR і USD окремо,
 * гривня — за курсом НБУ; гривневі рахунки не йдуть у валютну; без курсу — рахунок рахується окремо, а не нулем.
 * 🧨 Червоніє, якщо зсунути межу 2026 року, прийняти `state: false`, змішати гривню з валютою чи втратити борг без курсу.
 */
test("#1286 РОЗБІР НЕОПЛАЧЕНИХ: state false — помилка, лише 2026 рік із залишком, угода — 8 цифр, підсумок за валютою, без курсу — окремо", () => {
  assert.throws(() => parseUnpaid({ state: false, message: "Валюта GBP не підтримується" }), /GBP не підтримується/, "🔴 state: false прийнято");
  assert.throws(() => parseUnpaid({ state: true }), /немає списку/, "🔴 відповідь без списку прийнято як «боргів немає»");
  const rows = parseUnpaid({ state: true, invoices: [
    inv({}), inv({ number: "1", date: "2025-12-31" }), inv({ number: "2", remaining: 0 }), inv({ number: "3", currency: "UAH", remaining: 5000, id_amo: "123" }),
    inv({ number: "4", currency: "USD", remaining: 100, realization_status: "realized", payment_status: "partially_paid", debt_account: "362" }),
    inv({ number: "5", currency: "EUR", remaining: 15, date: "2026-01-01" }),
  ] });
  assert.equal(UNPAID_FROM, "2026-01-01", "🔴 межа — не 2026 рік");
  assert.deepEqual(rows.map((r) => r.number), ["000008471", "3", "4", "5"], "🔴 межа 2026 року чи залишку > 0");
  assert.deepEqual([rows[0].dealId, rows[1].dealId, rows[2].realized, rows[2].partiallyPaid, rows[2].debtAccount], [62752319, null, true, true, "362"], "🔴 поля рахунку");
  const t = unpaidFxTotals(rows, { EUR: 48.5, USD: 41.5 });
  assert.deepEqual([t.rows, t.eur, t.usd, t.totalUah, t.zeroUah], [3, 1815, 100, 1815 * 48.5 + 100 * 41.5, 0], "🔴 підсумок за валютою / гривнею");
  const noRate = unpaidFxTotals(rows, { EUR: 48.5 });
  assert.deepEqual([noRate.usd, noRate.totalUah, noRate.zeroUah], [100, 1815 * 48.5, 1], "🔴 без курсу USD борг загублено або пораховано нулем");
});

async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  return { c, dispose: async () => { await c.end(); scratch.dispose(); } };
}
const row = (o: Partial<UnpaidInvoice>): UnpaidInvoice => ({ uid: "u", number: "1", date: "2026-10-12", organization: "О", contractor: "К", edrpou: null, currency: "EUR",
  invoiceSum: 100, paidSum: 0, remaining: 100, realized: false, partiallyPaid: false, debtAccount: null, dueDate: null, manager: null, dealId: 62700001, comment: null, ...o });

/**
 * #1286b — ЖИВИЙ SQL: СПИСОК І ЧИСЛО НЕ РОЗХОДЯТЬСЯ. Синк пише список рахунків і підсумок журналу (джерело `unpaid-2026`)
 * однією транзакцією; нуль рахунків — відмова, і список та журнал лишаються як були, причина — у стані. Період отримує
 * останній підсумок НЕ пізніше свого кінця; підсумок старший за добу — немає числа; до журналу — немає. Список «які
 * рахунки» — лише валютні, свіжі зверху, разом зі станом синку.
 * 🧨 Червоніє, якщо порожня відповідь зітре список, минулий тиждень візьме пізніший підсумок чи список покаже гривню.
 */
test("#1286b ЖИВИЙ SQL: список і журнал однією транзакцією, нуль рахунків — відмова без змін, період — свій підсумок, застаре — порожньо", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { replaceUnpaid, saveUnpaidError, loadUnpaidFx, FX_SOURCE } = await import("./unpaidSync.js");
  const k = await import("./financeKpi.js");
  const db = c as unknown as import("./finance.js").Db;
  try {
    const out = await replaceUnpaid(db, [row({ number: "8471", remaining: 1800, date: "2026-10-12" }), row({ number: "8227", remaining: 650, date: "2026-10-02" }),
      row({ number: "9", currency: "UAH", remaining: 5000 })], { EUR: 48 });
    assert.deepEqual(out, { rows: 3, fx: 2 }, "🔴 записано не все");
    const j = (await c.query(`SELECT eur::float8 AS eur, total_uah::float8 AS uah, rows, source FROM receivables_fx_totals`)).rows;
    assert.deepEqual(j, [{ eur: 2450, uah: 2450 * 48, rows: 2, source: FX_SOURCE }], "🔴 журнал не з тим самим числом чи без джерела");
    await assert.rejects(replaceUnpaid(db, [], { EUR: 48 }), /жодного рахунку 2026 року/, "🔴 порожня відповідь прийнята");
    await saveUnpaidError(db, "1С не відповіла");
    const list = await loadUnpaidFx(db, "https://k.test");
    assert.deepEqual([list.invoices.map((r) => r.number), list.error, list.rowsAll, list.from], [["8471", "8227"], "1С не відповіла", 3, "2026-01-01"], "🔴 список — не валютні свіжі зверху, чи загубив стан");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM receivables_fx_totals`)).rows[0].n, 1, "🔴 відмова дописала журнал");

    await c.query(`DELETE FROM receivables_fx_totals`);
    const put = (at: string, uah: number) => c.query(`INSERT INTO receivables_fx_totals (synced_at, rows, total_uah, total_val, source) VALUES ($1, 1, $2, 1, $3)`, [at, uah, FX_SOURCE]);
    await put("2026-10-11T20:50:00Z", 111);   // нд 11.10 23:50 Київ — кінець тижня 05.10
    await put("2026-10-11T21:10:00Z", 222);   // пн 12.10 00:10 Київ — уже наступний тиждень
    await put("2026-10-14T09:00:00Z", 333);
    const now = new Date("2026-10-14T10:00:00Z");
    assert.equal((await k.receivablesFxAt(db, "2026-10-11", now))?.uah, 111, "🔴 минулий тиждень отримав пізніший підсумок");
    assert.deepEqual([(await k.receivablesFxAt(db, "2026-10-18", now))?.uah, (await k.receivablesFxAt(db, "2026-10-18", now))?.source], [333, FX_SOURCE], "🔴 поточний тиждень — не свіжий підсумок чи без джерела");
    assert.equal(await k.receivablesFxAt(db, "2026-10-18", new Date("2026-10-15T10:00:00Z")), null, "🔴 добове мовчання синку показане старим числом");
    assert.equal(await k.receivablesFxAt(db, "2026-10-04", now), null, "🔴 період до журналу отримав чуже число");
  } finally { await s.dispose(); }
});

/**
 * #1286c — ПРОВОДКА. Синк — окрема джоба щогодини о :15 під наглядом із тим самим інтервалом (збій валютної не чіпає 361);
 * адреса — поруч із сервісом 361 і з 2026 року; рахунку 362 у коді більше немає. Список «які рахунки» — першим рядком
 * межа «Фінансів», рядок у матриці; таблиці закриті від AI. Фронт: під «Тиждень і місяць» число з валютою, «Які рахунки»
 * зі станом реалізації й посиланням на угоду; минулі періоди старого джерела — під своїм підписом.
 * 🧨 Червоніє, якщо повернути 362, синкати валютну в одному потоці з 361, зняти межу зі списку чи загубити список на екрані.
 */
test("#1286c ПРОВОДКА: синк :15 під наглядом, адреса поруч із 361 і з 2026, без 362, список — межа «Фінансів» і матриця, фронт — рахунки з угодою", async () => {
  assert.match(SRC("index.ts"), /cron\.schedule\("15 \* \* \* \*", \(\) => \{\s*void runJob\("syncUnpaidInvoices", \(\) => syncUnpaidInvoices\(\)\);/, "🔴 крону немає");
  assert.match(SRC("jobs/monitoredJobs.ts"), /\{ name: "syncUnpaidInvoices", everyMin: 60,/, "🔴 нагляд не з тим самим інтервалом");
  assert.match(SRC("jobs/syncUnpaidInvoices.ts"), /new URL\("unpaid-invoices", config\.receivables1cUrl\)\.toString\(\)\}\?from=\$\{UNPAID_FROM\}/, "🔴 адреса — не поруч із 361 чи без межі 2026");
  for (const f of ["config.ts", "jobs/syncReceivables.ts", "jobs/syncUnpaidInvoices.ts"]) assert.doesNotMatch(SRC(f), /debit-balance-account-362|syncReceivablesFx\(/, `🔴 ${f}: повернувся рахунок 362`);
  const r = SRC("routes/finance.ts");
  assert.match(r, /financeRouter\.get\("\/fx-unpaid", async \(req, res\) => \{\s*try \{\s*onlyFinance\(req\);/, "🔴 список без межі першим рядком");
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js");
  assert.deepEqual(ACCESS_MATRIX.find((x) => x.method === "GET" && x.path === "/api/finance/fx-unpaid")?.deny, ["hr", "team_lead", "manager"], "🔴 списку немає в матриці");
  for (const tbl of ["onec_unpaid_invoices", "onec_unpaid_state"]) {
    assert.match(SRC("db/schema.sql"), new RegExp(`REVOKE ALL ON ${tbl} FROM ai_readonly;`), `🔴 ${tbl} відкрита для AI`);
    assert.match(SRC("ai/metricTools.ts"), new RegExp(`"${tbl}"`), `🔴 ${tbl} не в заборонених AI`);
  }
  assert.match(FE("pages/dashboard/sections/FinanceWeekTab.tsx"), /\{data\.receivablesFx && <FxNote fx=\{data\.receivablesFx\} \/>\}/, "🔴 примітки валютної немає");
  const fe = FE("pages/dashboard/sections/FinanceFxUnpaid.tsx");
  assert.match(fe, /if \(fx\.source !== "unpaid-2026"\) return \(/, "🔴 старе джерело показане під новим підписом");
  assert.match(fe, /fetchFxUnpaid\(\)/, "🔴 список рахунків не завантажується");
  assert.match(fe, /\$\{list\.kommoBase\}\/leads\/detail\/\$\{r\.dealId\}/, "🔴 немає посилання на угоду");
  assert.match(fe, />реалізації немає</, "🔴 не видно, що реалізації немає");
});

/**
 * #1286d — РАЗОВИЙ КРОК СХЕМИ ПРОХОДУ 2в (наступник частини `#995`). На базі з рядками «ФМ» старого вигляду: три
 * операційні стають авто з розділом, «Загальновиробничі» → «Загальні витрати», зʼявляється рівно один «ЗП + Податки на
 * ЗП», «Валютна дебіторка» — авто; повторний прогін схеми нічого не міняє: свідомо повернутий у ручний рядок і видалений
 * «ЗП» не відроджуються. 🧨 Червоніє, якщо крок повторюється або дублює «ЗП».
 */
test("#1286d ЖИВИЙ SQL: разовий крок 2в — авто-операційні, «Загальні», один «ЗП», «Валютна дебіторка» — авто", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    await c.query(`DELETE FROM fin_kpi_imports WHERE key = 'opex-fx-2026-10-05'`);
    const sec = (await c.query(`INSERT INTO fin_kpi_sections (name) VALUES ('Операційні витрати') RETURNING id`)).rows[0].id;
    const rest = (await c.query(`INSERT INTO fin_kpi_sections (name) VALUES ('Залишки на дату') RETURNING id`)).rows[0].id;
    for (const [n, i] of [["Разом", 0], ["Комерційні витрати", 1], ["Загальновиробничі витрати", 2], ["Адміністративні витрати", 3]] as const)
      await c.query(`INSERT INTO fin_kpis (section_id, name, kind, sort) VALUES ($1, $2, $3, $4)`, [sec, n, n === "Разом" ? "sum" : "manual", i]);
    await c.query(`INSERT INTO fin_kpis (section_id, name, kind) VALUES ($1, 'Валютна дебіторка', 'manual')`, [rest]);
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await c.query(schema);
    const rows = async () => (await c.query(`SELECT name, kind, ref_source FROM fin_kpis WHERE deleted_at IS NULL ORDER BY section_id, sort, id`)).rows.map((x) => `${x.name}|${x.kind}|${x.ref_source ?? ""}`);
    const once = await rows();
    assert.deepEqual(once, ["Разом|sum|", "Комерційні витрати|auto|opex_commercial", "Загальні витрати|auto|opex_general", "Адміністративні витрати|auto|opex_admin",
      "ЗП + Податки на ЗП|auto|opex_payroll", "Валютна дебіторка|auto|receivables_fx"], "🔴 разовий крок 2в зробив не те");
    // Свідомі правки після кроку: «Комерційні» знову ручні, «ЗП» видалено. Повторний прогін схеми не має їх відродити.
    await c.query(`UPDATE fin_kpis SET kind = 'manual', ref_source = NULL WHERE name = 'Комерційні витрати'`);
    await c.query(`UPDATE fin_kpis SET deleted_at = now() WHERE name = 'ЗП + Податки на ЗП'`);
    const edited = await rows();
    await c.query(schema);
    assert.deepEqual(await rows(), edited, "🔴 повторний прогін схеми повторив крок — свідомі правки відкочено або «ЗП» відроджено");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM fin_kpis WHERE name = 'ЗП + Податки на ЗП'`)).rows[0].n, 1, "🔴 «ЗП» продубльовано");
  } finally { await s.dispose(); }
});

/**
 * #1287 — ВАЛЮТА В ДУЖКАХ І «ЗВІДКИ ЧИСЛО» ПРЯМО В РЯДКУ (Тетяна 26.10.2026: «загальна сума саме у валюті… в дужках після
 * грн» у тиждень/місяць; Роман: «щоб можна було розгорнути і побачити, звідки ідуть дані, по яких рахунках»). Сервер
 * віддає підсумок журналу і на кінець ПОПЕРЕДНЬОГО періоду; у рядку «Валютна дебіторка» під гривнею обох стовпців —
 * валюта в дужках із того самого підсумку; «▾ рахунки» в рядку (клік не відкриває картку показника) розгортає під ним
 * список рахунків; для не поточного періоду список прямо каже, що це стан ЗАРАЗ, а не склад числа періоду.
 * 🧨 Червоніє, якщо минулий стовпець візьме сьогоднішню валюту, дужки зникнуть чи список видасть себе за історію.
 */
test("#1287 ВАЛЮТА В ДУЖКАХ І РАХУНКИ В РЯДКУ: обидва стовпці зі свого підсумку, «▾ рахунки» під рядком, минулий період — «стан зараз»", () => {
  const r = SRC("routes/finance.ts");
  assert.match(r, /const prevStart = shiftPeriod\(p\.kind, p\.start, -1\);\s*const fxPrev = autoActive\(p\.kind, prevStart\) \? await receivablesFxAt\(pool as unknown as Db, periodEnd\(p\.kind, prevStart\), new Date\(\)\) : null;/, "🔴 минулий стовпець — не підсумок на кінець попереднього періоду");
  assert.match(r, /receivablesFx: fx, receivablesFxPrev: fxPrev,/, "🔴 сервер не віддає валюту минулого періоду");
  const wk = FE("pages/dashboard/sections/FinanceWeekTab.tsx");
  assert.match(wk, /\{isFx && fxBrackets\(data\.receivablesFxPrev\) &&/, "🔴 у минулому стовпці немає дужок");
  assert.match(wk, /\{isFx && fxBrackets\(data\.receivablesFx\) &&/, "🔴 у поточному стовпці немає дужок");
  assert.match(wk, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); setFxOpen\(\(o\) => !o\); \}\}/, "🔴 «▾ рахунки» відкриває картку показника або не розгортає");
  assert.match(wk, /\{isFx && fxOpen && <tr><td colSpan=\{fxCols\}[^>]*><FxInvoices current=\{!!data\.current\} \/><\/td><\/tr>\}/, "🔴 список не розгортається під рядком");
  const fx = FE("pages/dashboard/sections/FinanceFxUnpaid.tsx");
  assert.match(fx, /fx\.eur \? `\$\{money\(fx\.eur\)\} EUR` : null, fx\.usd \? `\$\{money\(fx\.usd\)\} USD` : null/, "🔴 дужки не з EUR / USD підсумку");
  assert.match(fx, /\{!current && <div className="hr-note"[^>]*>Список — стан рахунків ЗАРАЗ/, "🔴 для минулого періоду список видає себе за історію");
});
