import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  locateColumns, parseUaDate, parseSheetAmount, maskDigits, parseApprovalRows, classify, bucketMonth, toShownLine, isUaDirection,
  APPROVALS_COLUMNS, type ApprovalLine, type PlanItem,
} from "./paymentApprovals.js";

/**
 * 🧪 «План/факт · авто (тест)» (Роман 20.10.2026) — гейти `#1277`–`#1277e` (`#1277`–`#1289` вільні в `main` і в усіх
 * гілках на 20.10.2026). Правило — зі слів Тетяни 13.10.2026 (відео з 16-ї хв). Номери карток у фікстурах вигадані.
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const HEAD = ["Дата", "ПІБ", "Що купити?", "Категорія", "Сума", "", "Рахунок", "Джерело/банк", "Напрямок", "Реквізити", "Отримувач", "Коментар", "Дата одоб.", "№", "Оплачено", "Дата оплати", "ДЛЯ Фінансиста", "Період (для ЗП)"];
const sheetRow = (o: { entry?: string; what?: string; cat?: string; sum?: string; dir?: string; paid?: string; pay?: string; req?: string }) => {
  const r = Array(18).fill("");
  r[0] = o.entry ?? "05.10.2026"; r[2] = o.what ?? "Покупка"; r[3] = o.cat ?? ""; r[4] = o.sum ?? ""; r[8] = o.dir ?? "UA";
  r[9] = o.req ?? "4441 1110 0000 1234"; r[10] = "Отримувач Тест"; r[14] = o.paid ?? "TRUE"; r[15] = o.pay ?? "";
  return r;
};
const line = (o: Partial<ApprovalLine>): ApprovalLine => ({ row: 2, entryDate: "2026-10-05", payDate: "2026-10-06", payRaw: "06.10.2026",
  what: "Покупка", category: "Оренда офісу", amount: 100, direction: "UA", paid: true, ...o });
const ITEMS: PlanItem[] = [
  { id: 1, name: "Оренда офісу", section: "admin", resp: "Офіс", group: "Офіс", off: false },
  { id: 2, name: "Контекстна реклама", section: "commercial", resp: "Маркетинг", group: "Реклама", off: false },
  { id: 3, name: "Податки ТОВ", section: null, resp: "Фін", group: "Податки", off: false },
  { id: 4, name: "Піца дей", section: "admin", resp: "Офіс", group: "Персонал", off: false },
  { id: 5, name: "Піца дей", section: "admin", resp: "ОД", group: "Персонал", off: false },
  { id: 6, name: "Мобільний звʼязок - Київстар", section: "general", resp: "Офіс", group: "Звʼязок", off: false },
];

/**
 * #1277 — РОЗБІР ТАБЛИЦІ. Колонки шукаються за НАЗВОЮ (зсув колонки не ламає), відсутня — помилка з її назвою; дата
 * оплати «дд.мм.рррр» і з часом — дата, «дубль» / 31.02 — ні; сума з комою / пробілом / мінусом — число, «#NUM!» — ні;
 * номер картки, вписаний у «Що купити?», маскується; реквізити й отримувач у лінію НЕ потрапляють.
 * 🧨 Червоніє, якщо брати колонку за позицією, пустити «дубль» як дату, загубити копійки чи пропустити номер картки.
 */
test("#1277 РОЗБІР ТАБЛИЦІ ОПЛАТ: колонки за назвою, дата оплати і сума по обидва боки межі, картка маскується, реквізитів немає", () => {
  assert.throws(() => locateColumns(HEAD.filter((h) => h !== "Дата оплати")), /«Дата оплати»/, "🔴 без колонки «Дата оплати» — не помилка з її назвою");
  const moved = ["Новий стовпець", ...HEAD];
  assert.equal(locateColumns(moved).payDate, 16, "🔴 колонку взято за позицією, а не за назвою");
  assert.deepEqual(["06.10.2026", "6.10.2026 9:41:00", "дубль", "31.02.2026", "-", "", "2026-10-06"].map(parseUaDate),
    ["2026-10-06", "2026-10-06", null, null, null, null, null], "🔴 дата оплати розібрана хибно");
  assert.deepEqual(["9192,83", "1 745,64", "-1745,64", "#NUM!", "", "41999"].map(parseSheetAmount),
    [9192.83, 1745.64, -1745.64, null, null, 41999], "🔴 сума розібрана хибно");
  assert.equal(maskDigits("ЗП картка 4441 1110 0000 1234 Іванов"), "ЗП картка ••••1234 Іванов", "🔴 номер картки в тексті не замасковано");
  assert.equal(maskDigits("Рахунок 8452 від 06.10"), "Рахунок 8452 від 06.10", "🔴 замасковано звичайне число");
  const lines = parseApprovalRows([HEAD, sheetRow({ cat: "Оренда офісу", sum: "1 000,50", pay: "06.10.2026", what: "оплата 5168 0000 0000 7777" }), Array(18).fill(""),
    sheetRow({ cat: "Оренда офісу", sum: "5", pay: "дубль", paid: "FALSE" })]);
  assert.equal(lines.length, 2, "🔴 порожній рядок не пропущено");
  assert.deepEqual(lines[0], { row: 2, entryDate: "2026-10-05", payDate: "2026-10-06", payRaw: "06.10.2026", what: "оплата ••••7777",
    category: "Оренда офісу", amount: 1000.5, direction: "UA", paid: true }, "🔴 лінія розібрана хибно");
  assert.deepEqual([lines[1].payDate, lines[1].payRaw, lines[1].paid], [null, "дубль", false], "🔴 «дубль» став датою або «FALSE» — оплаченим");
  assert.ok(!JSON.stringify(lines).includes("0000 1234") && !JSON.stringify(lines).includes("Отримувач Тест"), "🔴 реквізити чи отримувач потрапили в лінію");
  assert.deepEqual(Object.keys(APPROVALS_COLUMNS).sort(), ["amount", "category", "direction", "entryDate", "paid", "payDate", "what"], "🔴 читаємо зайву колонку");
});

/**
 * #1277b — ПРАВИЛО ТЕТЯНИ (13.10.2026), по обидва боки кожної межі. Місяць — за ДАТОЮ ОПЛАТИ (внесено в жовтні, оплачено в
 * листопаді — не жовтень; 31.10 — жовтень, 01.11 — ні); лише UA («Украина» до жовтня — теж UA; USA, «Экспорт» — окремо);
 * категорія = стаття без огляду на регістр / пробіли / апостроф; стаття без розділу (Податки ТОВ) — факт є; дві статті з
 * однією назвою — «кілька статей», не вгадуємо; «ЗП - Комерційні» — розділ за назвою, «ЗП» без розділу — не розпізнано;
 * сума не число — окремо; без дати оплати — інформаційно за датою внесення, у факт — ні.
 * 🧨 Червоніє, якщо взяти дату внесення, зарахувати USA, вгадати між двома статтями чи загубити хоч один кошик.
 */
test("#1277b ПРАВИЛО: місяць за датою оплати, лише UA, категорія = стаття, ЗП за назвою, двозначне й нерозпізнане — окремо", () => {
  const byName = new Map<string, PlanItem[]>();
  for (const it of ITEMS) byName.set(it.name.toLowerCase(), [...(byName.get(it.name.toLowerCase()) ?? []), it]);
  assert.deepEqual(classify("  ОРЕНДА   офісу ", byName), { kind: "item", itemId: 1 }, "🔴 регістр / пробіли зламали зіставлення");
  assert.deepEqual(classify("Податки ТОВ", byName), { kind: "item", itemId: 3 }, "🔴 стаття без розділу не отримала факт");
  assert.deepEqual(classify("Піца дей", byName), { kind: "ambiguous", category: "Піца дей" }, "🔴 між двома статтями вгадано");
  assert.deepEqual(classify("ЗП - Адміністративні", byName), { kind: "payroll", section: "admin" }, "🔴 ЗП не за назвою");
  assert.deepEqual(classify("ЗП", byName), { kind: "unrecognized", category: "ЗП" }, "🔴 «ЗП» без розділу вгадано");
  assert.deepEqual(["UA", "Украина", "Україна", "USA", "Экспорт", ""].map(isUaDirection), [true, true, true, false, false, false], "🔴 напрямок UA хибний");

  const b = bucketMonth([
    line({ amount: 100 }),
    line({ amount: 7, payDate: "2026-10-31" }),
    line({ amount: 1000, payDate: "2026-11-01", entryDate: "2026-10-30" }),            // внесено в жовтні, оплачено в листопаді
    line({ amount: 50, entryDate: "2026-09-20" }),                                       // внесено у вересні, оплачено в жовтні
    line({ amount: 300, direction: "USA" }), line({ amount: 30, direction: "Украина" }),
    line({ category: "Мобільний зв'язок - Київстар", amount: 11 }),
    line({ category: "Піца дей", amount: 4282 }),
    line({ category: "ЗП - Комерційні", amount: 900 }), line({ category: "ЗП - Комерційні", amount: 100, paid: false }),
    line({ category: "Дивіденди Артем", amount: 5000 }),
    line({ amount: null }),
    line({ payDate: null, payRaw: "", amount: 777 }), line({ payDate: null, payRaw: "дубль", amount: 1 }),
    line({ payDate: null, payRaw: "", amount: 9, entryDate: "2026-09-30" }),
  ], "2026-10-01", ITEMS);
  assert.deepEqual([b.items.get(1)?.sum, b.items.get(1)?.rows], [187, 4], "🔴 «Оренда офісу» за жовтень — не 100 + 7 (31.10) + 50 + 30 («Украина»)");
  assert.equal(b.items.get(6)?.sum, 11, "🔴 апостроф ' проти ʼ зламав зіставлення");
  assert.deepEqual([b.payroll.get("commercial")?.sum, b.payroll.get("commercial")?.unpaid], [1000, 1], "🔴 ЗП комерційні чи «не оплачено» хибні");
  assert.equal(b.ambiguous.get("піца дей")?.sum, 4282, "🔴 двозначну категорію не винесено окремо");
  assert.equal(b.unrecognized.get("дивіденди артем")?.sum, 5000, "🔴 нерозпізнане загубилось");
  assert.equal(b.notUa.get("USA")?.sum, 300, "🔴 USA зараховано або загублено");
  assert.equal(b.badSum.get("Оренда офісу")?.rows, 1, "🔴 сума не число загубилась");
  assert.deepEqual([b.noPayDate.get("none")?.sum, b.badPayDate.get("дубль")?.sum], [777, 1], "🔴 рядки без дати оплати не видно в місяці внесення");
  assert.equal([...b.items.values()].reduce((s, p) => s + p.sum, 0), 198, "🔴 у факт статей потрапило зайве (листопад, USA, без дати)");
});

/** Схема з нуля (той самий прийом, що в `financeKpi.test.ts`). */
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

/**
 * #1277c — ЖИВИЙ SQL: ПОРІВНЯННЯ МІСЯЦЯ. Різниця = таблиця − вручну (не внесене вручну = 0); розділ «статті» — Σ статей
 * розділу, «разом» = статті + ЗП; операційні вручну — число рядка «Тиждень і місяць» того місяця; стаття без розділу — у
 * «без розділу», в операційні не йде; вимкнена без руху — не показується; рядок для розкриття — лише 5 полів.
 * 🧨 Червоніє, якщо різницю порахувати навпаки, змішати розділи, додати Податки ТОВ в операційні чи віддати реквізити.
 */
test("#1277c ЖИВИЙ SQL: порівняння місяця — різниця = таблиця − вручну, розділи зі ЗП, операційні вручну, без розділу окремо", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    const { approvalsCompare } = await import("./paymentApprovals.js");
    const resp = (await c.query(`INSERT INTO fin_resps (name) VALUES ('Офіс') RETURNING id`)).rows[0].id;
    const grp = (await c.query(`INSERT INTO fin_groups (resp_id, name) VALUES ($1, 'Офіс') RETURNING id`, [resp])).rows[0].id;
    const item = async (name: string, section: string | null, off: string | null = null) =>
      (await c.query(`INSERT INTO fin_items (group_id, name, section, off_from) VALUES ($1, $2, $3, $4) RETURNING id`, [grp, name, section, off])).rows[0].id as number;
    const rent = await item("Оренда офісу", "admin"), ads = await item("Контекстна реклама", "commercial"), tax = await item("Податки ТОВ", null);
    await item("Стара стаття", "admin", "2026-09-01");
    await c.query(`INSERT INTO fin_values (item_id, month, fact) VALUES ($1, '2026-10-01', 150), ($2, '2026-10-01', 800), ($3, '2026-09-01', 999)`, [rent, tax, ads]);
    const sec = (await c.query(`INSERT INTO fin_kpi_sections (name) VALUES ('Опер тест') RETURNING id`)).rows[0].id;
    for (const [ref, v] of [["opex_admin", 5000], ["opex_commercial", null]] as const) {
      const id = (await c.query(`SELECT id FROM fin_kpis WHERE ref_source = $1 AND deleted_at IS NULL`, [ref])).rows[0]?.id
        ?? (await c.query(`INSERT INTO fin_kpis (section_id, name, ref_source) VALUES ($1, $2, $2) RETURNING id`, [sec, ref])).rows[0].id;
      if (v != null) await c.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value) VALUES ($1, 'month', '2026-10-01', $2)
        ON CONFLICT (kpi_id, period_kind, period_start) DO UPDATE SET value = EXCLUDED.value`, [id, v]);
    }
    const r = await approvalsCompare(c as never, "2026-10-01", [
      line({ amount: 100 }), line({ amount: 80 }), line({ category: "Контекстна реклама", amount: 40 }), line({ category: "Податки ТОВ", amount: 800 }),
      line({ category: "ЗП - Адміністративні", amount: 1000 }),
    ], new Date("2026-10-20T10:00:00Z"));
    const it = (id: number) => r.items.find((x) => x.id === id)!;
    assert.deepEqual([it(rent).manual, it(rent).auto, it(rent).diff], [150, 180, 30], "🔴 різниця «Оренди» — не таблиця − вручну");
    assert.deepEqual([it(ads).manual, it(ads).auto, it(ads).diff], [null, 40, 40], "🔴 не внесене вручну не дорівнює нулю в різниці (чи взято вересень)");
    assert.equal(r.items.some((x) => x.name === "Стара стаття"), false, "🔴 вимкнена стаття без руху показана");
    const adm = r.sections.find((x) => x.section === "admin")!;
    assert.deepEqual([adm.manualArticles, adm.autoArticles, adm.autoPayroll, adm.autoTotal, adm.manualOpex], [150, 180, 1000, 1180, 5000], "🔴 Адміністративні зведено хибно");
    assert.equal(r.sections.find((x) => x.section === "commercial")!.manualOpex, null, "🔴 не внесені операційні стали нулем");
    assert.deepEqual(r.withoutSection, { manual: 800, auto: 800, names: ["Податки ТОВ"] }, "🔴 Податки ТОВ не винесено «без розділу»");
    assert.ok(!r.sections.some((x) => x.autoTotal === 1980 || x.autoArticles === 980), "🔴 Податки ТОВ потрапили в операційні");
    assert.deepEqual(Object.keys(it(rent).lines[0]).sort(), ["amount", "direction", "paid", "payDate", "what"], "🔴 рядок для розкриття несе зайві поля");
  } finally { await s.dispose(); }
});

/**
 * #1277d — МЕЖА ВКЛАДКИ: у рядках ЗП прізвища, тож роут — лише `view_private_finance` (Адмін, фінансист) ПЕРШИМ middleware і
 * без жодного запису; у матриці — дозвіл адміну й фінансисту і заборона СЕО / ОД / КВП (дзеркало); вкладка без права —
 * напис і даних не просить; розкриття віддає рівно `toShownLine` (5 полів).
 * 🧨 Червоніє, якщо зняти право з роута, дати його СЕО/ОД/КВП, показати екран без права чи писати щось із роута.
 */
test("#1277d МЕЖА «ПЛАН/ФАКТ · АВТО»: роут під view_private_finance і лише читання, матриця з дзеркалом, вкладка без права — напис", async () => {
  const r = SRC("routes/financeApprovals.ts");
  const handlers = [...r.matchAll(/financeApprovalsRouter\.(get|post|put|patch|delete)\("([^"]+)",\s*([^,]+),/g)];
  assert.equal(handlers.length, 1, "🔴 обробників не рівно один — гейт не бачить нового роута");
  for (const [, m, p, first] of handlers) assert.equal(first.trim(), `requirePerm("view_private_finance")`, `🔴 ${m.toUpperCase()} ${p}: першим стоїть «${first.trim()}»`);
  assert.equal(handlers[0][1], "get", "🔴 тестова вкладка отримала роут на запис");
  assert.doesNotMatch(r + SRC("core/paymentApprovals.ts"), /\b(INSERT|UPDATE|DELETE)\b|googleSheetsWrite/, "🔴 тест щось пише");
  assert.match(SRC("index.ts"), /app\.use\("\/api\/finance\/approvals-test", financeApprovalsRouter\);/, "🔴 роутер не підключено");
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js");
  const m = ACCESS_MATRIX.find((x) => x.method === "GET" && x.path.startsWith("/api/finance/approvals-test?"));
  assert.ok(m, "🔴 роуту немає в матриці");
  assert.deepEqual([...m!.allow].sort(), ["admin", "financier"], "🔴 дозвіл не рівно Адмін і фінансист");
  for (const role of ["ceo", "opdir", "kvp", "manager"]) assert.ok(m!.deny.includes(role), `🔴 ${role} не в забороні`);
  assert.deepEqual(Object.keys(toShownLine(line({}))).sort(), ["amount", "direction", "paid", "payDate", "what"], "🔴 рядок для розкриття несе зайві поля");
  const sec = FE("pages/dashboard/sections/FinanceSection.tsx"), tab = FE("pages/dashboard/sections/FinanceApprovalsTestTab.tsx");
  assert.match(sec, /\{tab === "approvals" && <FinanceApprovalsTestTab \/>\}/, "🔴 вкладка не рендерить екран");
  assert.match(sec, /\["approvals", "План\/факт · авто \(тест\)", false\]/, "🔴 вкладки немає в «Фінансах»");
  assert.match(tab, /const canView = \(getAuthPayload\(\)\?\.perms \?\? \[\]\)\.includes\("view_private_finance"\);/, "🔴 екран не за view_private_finance");
  const body = tab.slice(tab.indexOf("export function FinanceApprovalsTestTab"));
  assert.ok(body.indexOf("if (!canView) return <div") > 0 && body.indexOf("if (!canView) return <div") < body.search(/<table|<Pots|<Lines/), "🔴 таблиця рендериться до перевірки права");
  assert.match(tab, /if \(!canView\) return;\n\s*setBusy\(true\);\n\s*\(refresh \? syncFinApprovals\(\)\.then\(\(\) => fetchFinApprovalsTest\(month\)\) : fetchFinApprovalsTest\(month\)\)/, "🔴 без права екран все одно просить дані");
});

/**
 * #1277e — ФРОНТ ЧИТАЄ РІЗНИЦЮ ТАК САМО, ЯК ЯДРО: таблиця − вручну (і для розділів), «не внесено» — словами, а не нулем;
 * кожен кошик «не потрапило» має свій блок на екрані — інакше гроші зникають мовчки.
 * 🧨 Червоніє, якщо перевернути знак різниці розділу, показати порожнє вручну як 0 чи прибрати блок кошика.
 */
test("#1277e ФРОНТ: різниця = таблиця − вручну і в розділах, «не внесено» словами, кожен кошик «не потрапило» — свій блок", () => {
  const tab = FE("pages/dashboard/sections/FinanceApprovalsTestTab.tsx");
  assert.match(SRC("core/paymentApprovals.ts"), /diff: r2\(auto - \(manual \?\? 0\)\)/, "🔴 ядро рахує різницю не як таблиця − вручну");
  assert.match(tab, /signed\(Math\.round\(\(s\.autoArticles - s\.manualArticles\) \* 100\) \/ 100\)/, "🔴 різниця статей розділу перевернута");
  assert.match(tab, /signed\(Math\.round\(\(s\.autoTotal - s\.manualOpex\) \* 100\) \/ 100\)/, "🔴 різниця операційних перевернута");
  assert.match(tab, /x\.manual == null \? <span className="hr-muted">не внесено<\/span>/, "🔴 порожнє вручну показано як число");
  assert.match(tab, /same\(x\.diff\) \? <span className="fin-good">✓ збігається<\/span> : <span className="fin-bad">\{signed\(x\.diff\)\}<\/span>/, "🔴 різниця статті з ручним — не з ядра");
  for (const k of ["payroll", "statsOnly", "ambiguous", "unrecognized", "notUa", "badSum", "badPayDate", "noPayDate"])
    assert.match(tab, new RegExp(`pots: o\\.${k} \\}`), `🔴 кошика «${k}» немає на екрані`);
  assert.match(tab, /<Outside buckets=\{outsideBuckets\(shown\)\} \/>/, "🔴 кошики «не потрапило» не рендеряться");
});

/**
 * #1277f — «ЛИШЕ ПОНАД ПЛАН» (Роман 20.10.2026) — те саме правило, що в «План/факт витрат»: факт із таблиці більший за
 * план, або факт є, а плану немає (нульовий план — теж «немає»); фільтр звужує таблицю, а не підміняє критерій.
 * 🧨 Червоніє, якщо «понад» рахувати від ручного факту, пропустити статті без плану чи прибрати галочку.
 */
test("#1277f «ЛИШЕ ПОНАД ПЛАН»: факт із таблиці > плану або факт без плану — як у «План/факт витрат»", () => {
  const tab = FE("pages/dashboard/sections/FinanceApprovalsTestTab.tsx");
  assert.match(tab, /const overPlan = \(x: FinApprItem\) => \(x\.plan != null && x\.plan !== 0 \? x\.auto > x\.plan : x\.auto > 0\);/, "🔴 «понад план» не від факту з таблиці або без статей без плану");
  assert.match(tab, /\(!onlyOver \|\| overPlan\(x\)\)/, "🔴 галочка не фільтрує статті");
  assert.match(tab, /checked=\{onlyOver\} onChange=\{\(e\) => setOnlyOver\(e\.target\.checked\)\} \/> лише понад план/, "🔴 галочки «лише понад план» немає");
});

// ───────────── 🧾 З ЖОВТНЯ 2026 ТАБЛИЦЯ ОПЛАТ — ДЖЕРЕЛО (задача Тетяни #5607, 21.10.2026) — гейти `#1279`–`#1279e` ─────────────

/** Статті й рядки таблиці для гейтів `#1279`: три статті (одна без розділу), дев'ять рядків по обидва боки кожної межі. */
async function approvalsFixture(c: import("pg").Client) {
  await c.query(`INSERT INTO users (id, email, password_hash, role, is_active) VALUES (901, 'fin@test', 'x', 'admin', true) ON CONFLICT DO NOTHING`);
  const resp = (await c.query(`INSERT INTO fin_resps (name) VALUES ('Офіс · тест') RETURNING id`)).rows[0].id;
  const grp = (await c.query(`INSERT INTO fin_groups (resp_id, name) VALUES ($1, 'Офіс · тест') RETURNING id`, [resp])).rows[0].id;
  const item = async (name: string, section: string | null) => (await c.query(`INSERT INTO fin_items (group_id, name, section) VALUES ($1, $2, $3) RETURNING id`, [grp, name, section])).rows[0].id as number;
  const rent = await item("Оренда офісу", "admin"), ads = await item("Контекстна реклама", "commercial"), tax = await item("Податки ТОВ", null);
  const rows: [string, number, string, string, boolean][] = [
    ["Оренда офісу", 100, "2026-10-06", "UA", true], ["Контекстна реклама", 50, "2026-10-13", "UA", true],
    ["ЗП - Комерційні", 1000, "2026-10-07", "UA", true], ["Консалтинг СЕО", 300, "2026-10-08", "UA", true],
    ["Дивіденди Артем", 999, "2026-10-08", "UA", true], ["Податки ТОВ", 800, "2026-10-01", "UA", true],
    ["Оренда офісу", 7, "2026-09-30", "UA", true], ["Оренда офісу", 5, "2026-10-06", "USA", true], ["Оренда офісу", 20, "2026-10-31", "UA", false],
  ];
  let n = 1;
  for (const [cat, sum, pay, dir, paid] of rows)
    await c.query(`INSERT INTO fin_approvals (row_no, entry_date, pay_date, pay_raw, what, category, amount, direction, paid) VALUES ($1, $2, $2, $3, 'тест', $4, $5, $6, $7)`,
      [++n, pay, `${pay.slice(8, 10)}.${pay.slice(5, 7)}.${pay.slice(0, 4)}`, cat, sum, dir, paid]);
  const synced = () => c.query(`INSERT INTO fin_approvals_state (id, synced_at, rows) VALUES (1, now(), ${rows.length}) ON CONFLICT (id) DO UPDATE SET synced_at = now()`);
  return { rent, ads, tax, synced };
}

/**
 * #1279 — ЖИВИЙ SQL: ОПЕРАЦІЙНІ «ТИЖДЕНЬ І МІСЯЦЬ» — З ТАБЛИЦІ ОПЛАТ (змінене твердження `#992`). За датою оплати, і
 * тиждень, і місяць: статті розділу + «ЗП - <розділ>» + «Консалтинг СЕО» → Комерційні (Тетяна 21.10); «Дивіденди» —
 * нікуди; USA — ні; 30.09 — не жовтень, 31.10 — жовтень; стаття без розділу (Податки ТОВ) — окремим числом. Поки таблицю
 * не синхронізовано жодного разу — ключів немає, і рядок не рахується нулем. Рядок `opex_*` у тижні — авто.
 * 🧨 Червоніє, якщо рахувати за датою внесення, загубити ЗП чи Консалтинг, зарахувати дивіденди / USA / Податки ТОВ,
 * показати нуль без синку чи лишити тиждень ручним.
 */
test("#1279 ЖИВИЙ SQL: операційні з таблиці оплат — тиждень і місяць за датою оплати, ЗП і Консалтинг СЕО в розділ, дивіденди нікуди, без синку — не нуль", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    const p = await import("./paymentApprovals.js"), k = await import("./financeKpi.js");
    const { synced } = await approvalsFixture(c);
    assert.deepEqual(await p.opexFromApprovals(c as never, "2026-10-01", "2026-10-31"), { refs: {}, unassigned: { items: 0, fact: 0 } }, "🔴 без синку операційні стали нулем");
    await synced();
    assert.deepEqual(await p.opexFromApprovals(c as never, "2026-10-01", "2026-10-31"),
      { refs: { opex_commercial: 1350, opex_admin: 120, opex_general: 0 }, unassigned: { items: 1, fact: 800 } }, "🔴 жовтень операційних хибний");
    const wk = await p.opexFromApprovals(c as never, "2026-10-05", "2026-10-11");
    assert.deepEqual(wk.refs, { opex_commercial: 1300, opex_admin: 100, opex_general: 0 }, "🔴 тиждень 05.10 не за датою оплати (реклама 13.10 — наступний тиждень)");
    const sec = (await c.query(`INSERT INTO fin_kpi_sections (name) VALUES ('Опер · тест') RETURNING id`)).rows[0].id;
    const com = (await c.query(`INSERT INTO fin_kpis (section_id, name, kind, ref_source) VALUES ($1, 'Комерційні · тест', 'auto', 'opex_commercial') RETURNING id`, [sec])).rows[0].id;
    const row = async (kind: "week" | "month", start: string, refs: Record<string, number>) =>
      (await k.loadPeriod(c as never, kind, start, refs, new Date("2026-10-21T10:00:00Z"))).sections.flatMap((x) => x.kpis).find((x: any) => x.id === com);
    assert.deepEqual([(await row("week", "2026-10-05", wk.refs)).kind, (await row("week", "2026-10-05", wk.refs)).value], ["auto", 1300], "🔴 тиждень операційних лишився ручним");
    assert.equal((await row("week", "2026-10-05", {})).kind, "manual", "🔴 без джерела тиждень показав авто");
  } finally { await s.dispose(); }
});

/**
 * #1279b — ЖИВИЙ SQL: «ПЛАН/ФАКТ» З ЖОВТНЯ — ФАКТ ІЗ ТАБЛИЦІ. До першого синку — ручний (і вноситься); після — факт статті
 * = Σ її рядків за датою оплати (UA), без оплат — «не внесено»; ручний факт жовтня — 400, план — вільний; ручні числа в
 * базі не зникають; вересень — ручний; картка статті — оплати обраного місяця (лише 5 полів); решта — у кошиках.
 * 🧨 Червоніє, якщо жовтень бере ручний факт, вересень — таблицю, ручний факт приймається, ручні числа стираються,
 * Консалтинг / ЗП потрапляють у статті, або картка віддає реквізити.
 */
test("#1279b ЖИВИЙ SQL: «План/факт» з жовтня — факт із таблиці після синку, вересень ручний, ручний факт — 400, картка — оплати місяця", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    const fin = await import("./finance.js");
    const { rent, ads, tax, synced } = await approvalsFixture(c);
    await c.query(`INSERT INTO fin_values (item_id, month, plan, fact) VALUES ($1, '2026-10-01', 150, 555), ($1, '2026-09-01', NULL, 444)`, [rent]);
    const now = new Date("2026-10-21T10:00:00Z");
    const it = (m: Awaited<ReturnType<typeof fin.loadMonth>>, id: number) => m.tree.flatMap((r) => r.groups.flatMap((g) => g.items)).find((x) => x.id === id)!;
    const before = await fin.loadMonth(c as never, "2026-10", now);
    assert.deepEqual([before.factSource, it(before, rent).fact], ["manual", 555], "🔴 до першого синку факт не ручний");
    await synced();
    const oct = await fin.loadMonth(c as never, "2026-10", now);
    assert.deepEqual([oct.factSource, it(oct, rent).fact, it(oct, rent).factRows, it(oct, ads).fact, it(oct, tax).fact], ["approvals", 120, 2, 50, 800], "🔴 факт жовтня не з таблиці");
    assert.deepEqual([oct.approvals!.outside.statsOnly.map((x) => x.sum), oct.approvals!.outside.unrecognized.map((x) => x.label), oct.approvals!.outside.payroll.map((x) => x.sum), oct.approvals!.outside.notUa.map((x) => x.sum)],
      [[300], ["Дивіденди Артем"], [1000], [5]], "🔴 кошики «не потрапило» хибні");
    assert.equal(oct.totals.fact, 970, "🔴 підсумок факту не сума статей із таблиці");
    assert.equal(it(await fin.loadMonth(c as never, "2026-09", now), rent).fact, 444, "🔴 вересень узяв таблицю");
    await assert.rejects(fin.saveValues(c as never, 901, "2026-10", [{ itemId: rent, field: "fact", value: "1" }], now), (e) => (e as { status?: number }).status === 400, "🔴 ручний факт жовтня прийнято");
    assert.deepEqual(await fin.saveValues(c as never, 901, "2026-10", [{ itemId: ads, field: "plan", value: "60" }], now), { changed: 1 }, "🔴 план жовтня заблоковано");
    assert.equal((await c.query(`SELECT fact::float8 AS f FROM fin_values WHERE item_id = $1 AND month = '2026-10-01'`, [rent])).rows[0].f, 555, "🔴 ручний факт стерто з бази");
    const card = await fin.itemCard(c as never, rent, 2026, "2026-10", now);
    assert.deepEqual([card.months[9].fact, card.months[9].factAuto, card.months[8].fact, card.payments?.length], [120, true, 444, 2], "🔴 картка статті — не з таблиці чи без оплат місяця");
    assert.deepEqual(Object.keys(card.payments![0]).sort(), ["amount", "direction", "paid", "payDate", "what"], "🔴 картка віддає зайві поля");
  } finally { await s.dispose(); }
});

/**
 * #1279c — СИНК ТАБЛИЦІ ОПЛАТ: дзеркало замінюється ЦІЛКОМ лише після перевірок — порожньо — відмова; зникло понад 10%
 * — відмова й старі дані на місці (рівно 10% — можна); стан пише час і кількість; у таблиці НЕМАЄ колонок реквізитів;
 * джоба — крон «20,50», нагляд 30 хв, пропуск — `jobSkip`, таблицю лише читає.
 * 🧨 Червоніє, якщо обрізана вкладка стре дзеркало, з'явиться колонка реквізитів чи синк навчиться писати в таблицю.
 */
test("#1279c СИНК ТАБЛИЦІ ОПЛАТ: заміна цілком лише після перевірок (порожньо / −10%), стан, без реквізитів, крон і нагляд", async (t) => {
  const sy = await import("./approvalsSync.js");
  assert.deepEqual([sy.replaceVerdict(null, 0) != null, sy.replaceVerdict(100, 89) != null, sy.replaceVerdict(100, 90), sy.replaceVerdict(null, 5), sy.replaceVerdict(100, 150)],
    [true, true, null, null, null], "🔴 межа «зникло понад 10%» хибна");
  const idx = SRC("index.ts"), job = SRC("jobs/syncApprovals.ts");
  assert.match(idx, /cron\.schedule\("20,50 \* \* \* \*", \(\) => \{\s*void runJob\("syncApprovals", \(\) => syncApprovals\(\)\);/, "🔴 синк не за розкладом");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "syncApprovals")?.everyMin, 30, "🔴 мовчання синку ніхто не помітить");
  assert.match(job, /return jobSkip\("Таблиця оплат: попередній синк ще йде"\)/, "🔴 пропуск рахується успіхом");
  assert.doesNotMatch(job + SRC("core/approvalsSync.ts"), /googleSheetsWrite|writeSheetTab/, "🔴 синк навчився писати в таблицю");
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'fin_approvals' ORDER BY column_name`)).rows.map((x) => x.column_name);
    assert.deepEqual(cols, ["amount", "category", "direction", "entry_date", "paid", "pay_date", "pay_raw", "row_no", "what"], "🔴 у дзеркалі зайві колонки (реквізити?)");
    const lines = (n: number) => Array.from({ length: n }, (_, i) => line({ row: i + 2, amount: i + 1 }));
    await c.query("BEGIN"); await sy.replaceApprovals(c as never, lines(10)); await c.query("COMMIT");
    const count = async () => (await c.query(`SELECT count(*)::int AS n, (SELECT rows FROM fin_approvals_state) AS st FROM fin_approvals`)).rows[0];
    assert.deepEqual(await count(), { n: 10, st: 10 }, "🔴 дзеркало чи стан не записано");
    await assert.rejects(sy.replaceApprovals(c as never, lines(8)), /зникло понад 10%/, "🔴 обрізана вкладка пройшла");
    assert.deepEqual(await count(), { n: 10, st: 10 }, "🔴 відмова зачепила дані");
    await c.query("BEGIN"); await sy.replaceApprovals(c as never, lines(9)); await c.query("COMMIT");
    assert.deepEqual(await count(), { n: 9, st: 9 }, "🔴 рівно 10% не пройшло або старі рядки лишились");
  } finally { await s.dispose(); }
});

/**
 * #1279d — ЖИВИЙ SQL: РАЗОВИЙ КРОК «ОПЕРАЦІЙНІ ЗНОВУ АВТО» (21.10.2026). Три рядки `opex_commercial / admin / general`
 * стають авто; «ручне поверх» знято лише з жовтня (місяць) і з тижня 05.10 — вересень не чіпається; числа лишаються;
 * «ЗП» (`opex_payroll`) і «Гроші» (`bank_in`) — як були; повтор схеми свідомо повернений ручний не скидає.
 * 🧨 Червоніє, якщо крок зачепить вересень, чужий рядок чи число, або спрацює вдруге.
 */
test("#1279d ЖИВИЙ SQL: разовий крок — операційні знову авто, «ручне поверх» знято лише з жовтня, числа й чужі рядки ті самі", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
  try {
    const sec = (await c.query(`INSERT INTO fin_kpi_sections (name) VALUES ('Опер · крок') RETURNING id`)).rows[0].id;
    const kpi = async (name: string, kind: string, ref: string) => (await c.query(`INSERT INTO fin_kpis (section_id, name, kind, ref_source) VALUES ($1, $2, $3, $4) RETURNING id`, [sec, name, kind, ref])).rows[0].id;
    const com = await kpi("Ком · крок", "manual", "opex_commercial"), pay = await kpi("ЗП · крок", "manual", "opex_payroll"), bank = await kpi("Надх · крок", "auto", "bank_in");
    for (const [kind, p, v] of [["month", "2026-10-01", 1878603], ["week", "2026-10-05", 1692609], ["month", "2026-09-01", 113593], ["week", "2026-09-28", 777]] as const)
      await c.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value, manual_override) VALUES ($1, $2, $3, $4, true)`, [com, kind, p, v]);
    await c.query(`DELETE FROM fin_kpi_imports WHERE key = 'opex-approvals-auto-2026-10-21'`);
    await c.query(schema);
    const kinds = (await c.query(`SELECT id, kind FROM fin_kpis WHERE id = ANY($1)`, [[com, pay, bank]])).rows.reduce((a: any, x: any) => ({ ...a, [x.id]: x.kind }), {});
    assert.deepEqual([kinds[com], kinds[pay], kinds[bank]], ["auto", "manual", "auto"], "🔴 крок не зробив операційні авто або зачепив ЗП / «Гроші»");
    const ov = (await c.query(`SELECT period_kind || ':' || period_start::text AS p, manual_override AS o, value::float8 AS v FROM fin_kpi_values WHERE kpi_id = $1 ORDER BY 1`, [com])).rows;
    assert.deepEqual(ov, [{ p: "month:2026-09-01", o: true, v: 113593 }, { p: "month:2026-10-01", o: false, v: 1878603 }, { p: "week:2026-09-28", o: true, v: 777 }, { p: "week:2026-10-05", o: false, v: 1692609 }],
      "🔴 «ручне поверх» знято не рівно з жовтня чи числа змінились");
    await c.query(`UPDATE fin_kpis SET kind = 'manual' WHERE id = $1`, [com]);
    await c.query(schema);
    assert.equal((await c.query(`SELECT kind FROM fin_kpis WHERE id = $1`, [com])).rows[0].kind, "manual", "🔴 повтор схеми скинув свідомо повернений ручний");
  } finally { await s.dispose(); }
});

/**
 * #1279e — ПРОВОДКА: «Оновити з таблиці» — `POST /api/finance/approvals/sync`, першим рядком право вносити, у матриці
 * deny-only; «Тиждень і місяць» бере операційні й безрозділові з таблиці (і тиждень); фронт «План/факт» — факт із таблиці
 * лише для читання, плашка джерела, кошики «не потрапило», оплати в картці статті.
 * 🧨 Червоніє, якщо зняти межу з синку, лишити операційні на «План/факт», дати вносити авто-факт чи загубити кошики.
 */
test("#1279e ПРОВОДКА: синк — canEdit першим і в матриці, операційні з таблиці і за тиждень, фронт — факт лише для читання, кошики, оплати в картці", async () => {
  const r = SRC("routes/finance.ts");
  assert.match(r, /financeRouter\.post\("\/approvals\/sync", async \(req, res\) => \{\s*try \{\s*canEdit\(req\);\s*const r = await runApprovalsSyncNow\(\);/, "🔴 синк без межі «вносити» першим рядком");
  assert.match(r, /const opex = autoActive\(p\.kind, p\.start\) \? \(await opexFromApprovals\(pool as unknown as Db, p\.start, p\.end\)\)\.unassigned : null;/, "🔴 безрозділові — не з таблиці чи лише за місяць");
  assert.match(SRC("core/financeKpiRefs.ts"), /Object\.assign\(refs, \(await opexFromApprovals\(db, start, end\)\)\.refs\);/, "🔴 операційні не з таблиці");
  assert.doesNotMatch(SRC("core/financeKpiRefs.ts"), /opexMonth|kind === "month"\) Object\.assign/, "🔴 операційні знову лише помісячні з «План/факт»");
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js");
  assert.deepEqual(ACCESS_MATRIX.find((x) => x.method === "POST" && x.path === "/api/finance/approvals/sync")?.deny, ["hr", "team_lead", "manager"], "🔴 синку немає в матриці");
  const fe = FE("pages/dashboard/sections/FinanceSection.tsx");
  assert.match(fe, /if \(f === "fact" && factAuto\) return <span title="Факт — з таблиці «Утверждение оплат»">\{money\(it\.fact\)\}<\/span>;/, "🔴 авто-факт можна вносити руками");
  assert.match(fe, /\{factAuto && data\.approvals && <Outside buckets=\{outsideBuckets\(data\.approvals\.outside\)\} \/>\}/, "🔴 кошики «не потрапило» не показано");
  assert.match(fe, /fetchFinItem\(id, year, month\)/, "🔴 картка не просить оплати місяця");
  assert.match(fe, /card\.payments && \(/, "🔴 оплати в картці не показано");
  assert.match(fe, /🧾 факт — з таблиці «UTS Утверждение оплат»/, "🔴 плашки джерела факту немає");
});
