import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { budgetOf, planPnl, emptyFlows, parseInvoices, parsePayments, onecBlock, paidBlock, kommoFlows, orgKind, onecDate, type Flows } from "./dealLedger.js";

/**
 * 📒 «Результат місяця», прохід 2 — угода «як у таблиці Тетяни» (задача #5583, 23.10.2026). Гейти `#1283`–`#1283f`
 * (`#1283`–`#1289` вільні в `main` і в усіх гілках на 23.10.2026). Правила — з коду її скрипта «Обновить сделки»
 * (`main`, `calcBudget_`, `buildRow_`), прочитаного 23.10.2026; приклади бюджету — живі рядки її «Сделки» за жовтень.
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const fl = (o: { in?: Partial<Flows["in"]>; out?: Partial<Flows["out"]> }): Flows => { const f = emptyFlows(); Object.assign(f.in, o.in); Object.assign(f.out, o.out); return f; };

/**
 * #1283 — БЮДЖЕТ = `calcBudget_` ТЕТЯНИ. Кожен коефіцієнт по обидва боки своєї умови, на її жовтневих рядках:
 * ПДВ→ПДВ 65 000/−58 000 = 5 320; без ПДВ→без ПДВ 89 000/−82 000 = 6 580 (×0,94 з обох боків); ПДВ→нал 21 000/−12 500 =
 * 3 040 (×0,74); без ПДВ→нал 4 700/−3 000 = 1 324 (×0,92); ПДВ→без ПДВ 30 000/−18 000 = 4 800 (розхід ×1); вигрузка ×0;
 * усі нулі — порожньо. Плановий PNL — без вигрузки.
 * 🧨 Червоніє, якщо зсунути будь-який коефіцієнт, рахувати вигрузку чи віддати 0 замість порожнього.
 */
test("#1283 БЮДЖЕТ = calcBudget_ Тетяни: коефіцієнти по обидва боки умов на її жовтневих рядках, вигрузка ×0, нулі — порожньо", () => {
  assert.equal(budgetOf(fl({ in: { vat: 65000 }, out: { vat: -58000 } })), 5320, "🔴 ПДВ→ПДВ");
  assert.equal(budgetOf(fl({ in: { novat: 89000 }, out: { novat: -82000 } })), 6580, "🔴 без ПДВ→без ПДВ");
  assert.equal(budgetOf(fl({ in: { vat: 21000 }, out: { cash: -12500 } })), 3040, "🔴 ПДВ→нал (×0,74)");
  assert.equal(budgetOf(fl({ in: { vat: 21000 }, out: { cash: -12500, vat: -1000 } })), 2700, "🔴 ПДВ→нал+ПДВ — ×0,74 замість ×0,76");
  assert.equal(budgetOf(fl({ in: { novat: 4700 }, out: { cash: -3000 } })), 1324, "🔴 без ПДВ→нал (×0,92)");
  assert.equal(budgetOf(fl({ in: { vat: 30000 }, out: { novat: -18000 } })), 4800, "🔴 ПДВ→без ПДВ (розхід ×1)");
  assert.equal(budgetOf(fl({ in: { cash: 2000 }, out: { unload: -7500 } })), 2000, "🔴 «оплата на вигрузці» врахована");
  assert.equal(budgetOf(fl({ in: { novat: 22000 }, out: { unload: -7500 } })), 20240, "🔴 вигрузка змінила коефіцієнт без ПДВ");
  assert.equal(budgetOf(emptyFlows()), null, "🔴 усі нулі — не порожньо");
  assert.equal(planPnl(fl({ in: { vat: 65000 }, out: { vat: -58000, unload: -7500 } })), 7000, "🔴 плановий PNL з вигрузкою");
});

/**
 * #1283b — РОЗБІР 1С. Лише рядки з 8-значним номером угоди; дата «1.11.2023 0:00:00» → ISO, «01.01.2001» (сентинел
 * 1С) → немає; «24 000» і «152 783,4» — числа; розхід за «RashodType» зі знаком мінус, невідомий тип не йде в колонки;
 * у оплатах немає менеджера (там телефони).
 * 🧨 Червоніє, якщо пустити рядок без угоди, прочитати сентинел як дату чи загубити кому в сумі.
 */
test("#1283b РОЗБІР 1С: лише угоди, сентинел 01.01.2001 — немає дати, суми з пробілами й комою, розхід за типом з мінусом, без менеджера", () => {
  const inv = parseInvoices([
    { Number: "5602", Organization: 'ТОВ "ЮНАЙТЕД ТРАНСПОРТ СЕРВІС"', Kontragent: "К", Data: "1.09.2025 0:00:00", Sum: 29400, Currency: "грн", Deal: "61328055", DateAct: "01.01.2001 0:00:00",
      Rashod1: "24 000", Rashod2: "152 783,4", Rashod3: "500", RashodType1: "Безнал с НДС", RashodType2: "Оплата на выгрузке", RashodType3: "Бартер" },
    { Number: "1", Organization: "X", Data: "01.09.2025", Sum: 100, Deal: "" },
    { Number: "2", Organization: "X", Data: "01.09.2025", Sum: 100, Deal: "1234567" },
  ]);
  assert.equal(inv.length, 1, "🔴 рядок без угоди пройшов");
  assert.deepEqual([inv[0].deal, inv[0].docOn, inv[0].actOn, inv[0].sum, inv[0].out], [61328055, "2025-09-01", null, 29400, { vat: -24000, novat: 0, unload: -152783.4, cash: 0 }], "🔴 розбір реалізації");
  assert.equal(onecDate("23.10.2026 11:49:24"), "2026-10-23", "🔴 дата з часом");
  const pay = parsePayments([{ Organization: "О", Kontragent: "К", ERPOU: "1", Data: "21.10.2026 0:00:00", Sum: 16000, Currency: "грн", Deal: "62767427", Manager: "Менеджер, +380000000000" }, { Sum: 1, Deal: "" }]);
  assert.deepEqual(pay, [{ deal: 62767427, organization: "О", kontragent: "К", paidOn: "2026-10-21", sum: 16000, currency: "грн" }], "🔴 оплата клієнта чи менеджер у даних");
});

/**
 * #1283c — БЛОКИ УГОДИ. Організація → тип: ТОВ «ЮТС» — з ПДВ, готівкові з «Настройки» (і з хвостовим пробілом, як віддає
 * 1С) — нал, решта (АвтоМув) — без ПДВ. Валютний рядок не йде в гривневі колонки, а стоїть окремо. Оплати — за тим самим
 * правилом, з останньою датою. Kommo — слоти 1–5 за «Тип оплаты», розхід із мінусом (і вигрузка), слот без типу — окремо.
 * 🧨 Червоніє, якщо змішати євро з гривнею, віддати АвтоМув у ПДВ чи загубити слот 2–5.
 */
test("#1283c БЛОКИ: організація → тип оплати, валюта окремо, оплати за тим самим правилом, Kommo — п'ять слотів за типом", () => {
  assert.deepEqual([orgKind('ТОВ "ЮНАЙТЕД ТРАНСПОРТ СЕРВІС"'), orgKind("ФОП ШЕВЧУК ВІКТОР ВАСИЛЬОВИЧ "), orgKind('ТОВ "АвтоМув"'), orgKind("Облік сейфу")], ["vat", "cash", "novat", "cash"], "🔴 організація → тип");
  const b = onecBlock([
    { organization: 'ТОВ "АвтоМув"', sum: 37322, currency: "грн", actOn: null, out: { vat: 0, novat: -27235, unload: 0, cash: 0 } },
    { organization: 'ТОВ "АвтоМув"', sum: 950, currency: "EUR", actOn: "2026-10-01", out: { vat: 0, novat: -800, unload: 0, cash: 0 } },
  ])!;
  assert.deepEqual([b.organization, b.flows.in, b.flows.out.novat, b.fx, b.actOn], ['ТОВ "АвтоМув"', { vat: 0, novat: 37322, cash: 0 }, -27235, [{ currency: "EUR", sum: 950 }], "2026-10-01"], "🔴 блок 1С");
  assert.equal(b.budget, Math.round(37322 * 0.94 - 27235 * 0.94), "🔴 бюджет блоку 1С");
  assert.equal(onecBlock([]), null, "🔴 без реалізації — не порожньо");
  const p = paidBlock([{ organization: 'ТОВ "ЮНАЙТЕД ТРАНСПОРТ СЕРВІС"', sum: 10000, currency: "грн", paidOn: "2026-10-05" }, { organization: "Фізична особа", sum: 500, currency: "грн", paidOn: "2026-10-09" },
    { organization: "Фізична особа", sum: 20, currency: "USD", paidOn: "2026-10-10" }])!;
  assert.deepEqual([p.vat, p.novat, p.cash, p.total, p.fx, p.lastOn], [10000, 0, 500, 10500, [{ currency: "USD", sum: 20 }], "2026-10-10"], "🔴 оплати клієнта");
  const F: Record<number, string> = { 2097627: "1000", 2097629: "Безнал с НДС", 2097689: "500", 2097637: "Наличные", 2097683: "300", 2097631: "$ Готівка",
    2097661: "800", 2097651: "Безнал без НДС", 2097669: "7500", 2097659: "Оплата на выгрузке" };
  const k = kommoFlows((id) => F[id]);
  assert.deepEqual([k.in, k.out, k.untyped], [{ vat: 1000, novat: 0, cash: 500 }, { vat: 0, novat: -800, unload: -7500, cash: 0 }, 1], "🔴 Kommo за слотами й типами");
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
const inv1 = (deal: number, sum: number, org = 'ТОВ "ЮНАЙТЕД ТРАНСПОРТ СЕРВІС"', currency = "грн") =>
  ({ deal, number: String(deal), organization: org, kontragent: "К", docOn: "2026-09-10", actOn: null, sum, currency, out: { vat: -Math.round(sum * 0.8), novat: 0, unload: 0, cash: 0 } });

/**
 * #1283d — ЖИВИЙ SQL: СИНК 1С ЗАМІНЮЄ ЦІЛКОМ ЛИШЕ ПІСЛЯ ПЕРЕВІРОК. Перший запис — усе й стан; порожньо — відмова; зникло
 * понад 10% — відмова; рівно 10% — проходить; відмова лишає попередні дані й пише причину.
 * 🧨 Червоніє, якщо порожня чи обрізана відповідь 1С стирає дані, чи стан не оновлюється.
 */
test("#1283d ЖИВИЙ SQL: синк 1С — заміна цілком, порожньо й понад −10% — відмова без змін, причина в стані", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { replaceOnec, saveOnecError } = await import("./onecSync.js");
  const db = c as unknown as import("./finance.js").Db;
  const count = async () => (await c.query(`SELECT (SELECT count(*) FROM onec_deal_invoices)::int AS i, (SELECT count(*) FROM onec_deal_payments)::int AS p`)).rows[0];
  try {
    const inv = Array.from({ length: 10 }, (_, i) => inv1(62700000 + i, 1000 + i));
    const pay = Array.from({ length: 10 }, (_, i) => ({ deal: 62700000 + i, organization: "О", kontragent: "К", paidOn: "2026-10-01", sum: 100, currency: "грн" }));
    assert.deepEqual(await replaceOnec(db, inv, pay), { invoices: 10, payments: 10 }, "🔴 перший запис");
    assert.deepEqual(await count(), { i: 10, p: 10 }, "🔴 записано не все");
    await assert.rejects(replaceOnec(db, [], pay), /не віддав жодного рядка/, "🔴 порожня відповідь прийнята");
    await assert.rejects(replaceOnec(db, inv.slice(0, 8), pay), /зникло понад 10%/, "🔴 −20% прийнято");
    assert.deepEqual(await count(), { i: 10, p: 10 }, "🔴 відмова змінила дані");
    assert.deepEqual(await replaceOnec(db, inv.slice(0, 9), pay), { invoices: 9, payments: 10 }, "🔴 −10% відмовлено");
    await saveOnecError(db, "1С недоступна");
    const st = (await c.query(`SELECT invoices, payments, error, synced_at IS NOT NULL AS ok FROM onec_deals_state`)).rows[0];
    assert.deepEqual(st, { invoices: 9, payments: 10, error: "1С недоступна", ok: true }, "🔴 стан синку");
  } finally { await s.dispose(); }
});

/**
 * #1283e — ЖИВИЙ SQL: «РЕЗУЛЬТАТ МІСЯЦЯ» З 1С. Угода з реалізацією 1С отримує блок 1С, оплати клієнта, плановий PNL; бюджет
 * 1С ≠ Kommo — на перевірку з обома числами; рівний — без перевірки; валютна реалізація — перевірка «у валюті», у гривневі
 * колонки не йде; без 1С — блок порожній і ця перевірка мовчить; «станом на» — з часу синку.
 * 🧨 Червоніє, якщо загубити блок, не помітити розбіжність Kommo ↔ 1С чи змішати валюту з гривнею.
 */
test("#1283e ЖИВИЙ SQL: угода з 1С — блоки, плановий PNL, Kommo ≠ 1С і валюта на перевірку, без 1С — мовчить", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { loadMonthResult } = await import("./monthResult.js");
  const { replaceOnec } = await import("./onecSync.js");
  const db = c as unknown as import("./finance.js").Db;
  try {
    await c.query(`INSERT INTO managers (id, name, kommo_user_id, is_active) VALUES (1, 'М', 777, true)`);
    for (const [id, price] of [[201, 5320], [202, 3000], [203, 1000], [204, 900]])
      await c.query(`INSERT INTO deals (kommo_id, name, manager_id, price, pipeline_id, status_id, closed_at_kommo, payment_type) VALUES ($1, 'У', 1, $2, 8921932, 142, '2026-09-10T10:00:00Z', 'Безнал с НДС')`, [id, price]);
    const ex = (deal: number, sum: number, outVat: number, currency = "грн") => ({ deal, number: "1", organization: 'ТОВ "ЮНАЙТЕД ТРАНСПОРТ СЕРВІС"', kontragent: "К", docOn: "2026-09-10", actOn: null, sum, currency, out: { vat: outVat, novat: 0, unload: 0, cash: 0 } });
    await replaceOnec(db, [ex(201, 65000, -58000), ex(202, 65000, -58000), ex(203, 950, 0, "EUR")], [{ deal: 201, organization: 'ТОВ "ЮНАЙТЕД ТРАНСПОРТ СЕРВІС"', kontragent: "К", paidOn: "2026-09-20", sum: 65000, currency: "грн" }]);
    const live = async (ids: number[]) => new Map(ids.map((id) => [id, { orderNo: "1", paid1c: true, income: null, cashExpense: null }]));
    const r = await loadMonthResult(db, "2026-09-01", { live, bankPaid: async () => new Set<number>(), kommoBase: "https://k.test" });
    const d = (id: number) => r.deals.find((x) => x.id === id)!;
    assert.deepEqual([d(201).onec?.budget, d(201).planPnl, d(201).paid?.total, d(201).checks], [5320, 7000, 65000, []], "🔴 угода з 1С, що сходиться");
    assert.deepEqual(d(202).checks, ["бюджет Kommo 3 000 ≠ 1С 5 320"], "🔴 розбіжність Kommo ↔ 1С не на перевірці");
    assert.deepEqual([d(203).onec?.flows.in.vat, d(203).onec?.fx, d(203).checks.some((x) => /у валюті \(950 EUR\)/.test(x))], [0, [{ currency: "EUR", sum: 950 }], true], "🔴 валюта змішана з гривнею чи без перевірки");
    assert.deepEqual([d(204).onec, d(204).paid, d(204).planPnl, d(204).checks], [null, null, null, []], "🔴 без 1С — не порожньо чи зайва перевірка");
    assert.ok(r.onecSince && !r.onecError, "🔴 немає «станом на» синку 1С");
  } finally { await s.dispose(); }
});

/**
 * #1283f — ПРОВОДКА. Синк 1С — щогодини о :45 і під наглядом із тим самим інтервалом, адреса — поруч із сервісом
 * дебіторки (не нова змінна оточення); три нові таблиці закриті від AI; Excel «Угоди» — у порядку колонок її «Сделки»;
 * фронт — блоки Kommo / 1С / Оплати клієнтів з перемикачами, закріплена угода, підсвітка Kommo ≠ 1С і рядок «Разом».
 * 🧨 Червоніє, якщо розвести крон і нагляд, захардкодити нову адресу, відкрити таблиці AI чи загубити блок на екрані.
 */
test("#1283f ПРОВОДКА: синк 1С :45 під наглядом, адреса з сервісу дебіторки, AI закрито, Excel і фронт — блоки як у «Сделки»", () => {
  assert.match(SRC("index.ts"), /cron\.schedule\("45 \* \* \* \*", \(\) => \{\s*void runJob\("syncOnecDeals", \(\) => syncOnecDeals\(\)\);/, "🔴 крону синку 1С немає");
  assert.match(SRC("jobs/monitoredJobs.ts"), /\{ name: "syncOnecDeals", everyMin: 60,/, "🔴 нагляд не з тим самим інтервалом");
  assert.match(SRC("jobs/syncOnecDeals.ts"), /new URL\(name, config\.receivables1cUrl\)/, "🔴 адреса 1С — не поруч із дебіторкою");
  for (const tbl of ["onec_deal_invoices", "onec_deal_payments", "onec_deals_state"]) {
    assert.match(SRC("db/schema.sql"), new RegExp(`REVOKE ALL ON ${tbl} FROM ai_readonly;`), `🔴 ${tbl} відкрита для AI`);
    assert.match(SRC("ai/metricTools.ts"), new RegExp(`"${tbl}"`), `🔴 ${tbl} не в заборонених AI`);
  }
  const x = SRC("jobs/monthResultData.ts");
  assert.match(x, /DEAL_HEAD = \["Сделка", "Дата создания", "Дата закрытия", "Дата акта", "ID відповідального",\s*"Бюджет Коммо", "Прихід: Безнал с НДС"/, "🔴 Excel — не в порядку «Сделки»");
  assert.match(x, /"Бюджет Коммо-1С", "Organization", "1С прихід: Безнал с НДС"/, "🔴 блок 1С в Excel — не в її порядку");
  const fe = FE("pages/dashboard/sections/FinanceMonthResultTab.tsx");
  assert.match(fe, /BLOCKS: \[Block, string\]\[\] = \[\["kommo", "Kommo"\], \["onec", "1С"\], \["paid", "Оплати клієнтів \(1С\)"\]\]/, "🔴 блоків на екрані не три");
  assert.match(fe, /onClick=\{\(\) => toggleBlock\(b\)\}/, "🔴 блоки не згортаються");
  assert.match(fe, /position: "sticky", left: 0/, "🔴 угода не закріплена");
  assert.match(fe, /Math\.abs\(d\.price - d\.onec\.budget\) >= 1/, "🔴 розбіжність Kommo ↔ 1С не підсвічена");
  assert.match(fe, />Разом · \{list\.length\}</, "🔴 немає рядка «Разом»");
  assert.match(fe, /data\.onecSince \? `1С по угодах — станом на/, "🔴 не видно, станом на коли 1С");
});
