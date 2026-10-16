import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { kommoStateOf, discrepancyOf, fileRow, clipboardTsv, screenCard, totalsOf, type ScreenRow } from "./paymentScreen.js";
import { xlsxBook } from "./xlsx.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
// Номери карток вигадані.
const row = (o: Partial<ScreenRow> = {}): ScreenRow => ({ mainId: 62762651, requestId: 62764709, createdAt: null, amount: 18000, ok: true, paidBy: "Виписка",
  reasons: [], notes: [], card: "1111 2222 3333 4444", owner: "Іваненко Іван приват", category: "Транспортні послуги", kommo: "open", diff: false, ...o });

/**
 * #1271 — РОЗБІЖНІСТЬ ІЗ KOMMO (екран «Оплати перевізникам», 16.10.2026) — те, що 15.10 звіряли з Тетяною руками:
 * система «перевірити» + запит «Оплачено» = розбіжність; система «до оплати» + «Відмовлено» = розбіжність; «до оплати» +
 * «Оплачено» — збіг; «до оплати» + висить — НЕ розбіжність (Тетяна ще не дійшла). Підсумки рахують рівно рядки.
 * 🧨 Червоніє, якщо хоч один випадок класифікується хибно або розбіжність не потрапить у підсумок.
 */
test("#1271 РОЗБІЖНІСТЬ ІЗ KOMMO: «перевірити»+оплачено і «до оплати»+відмовлено — так; збіг і «висить» — ні; підсумки", () => {
  assert.deepEqual([kommoStateOf(142), kommoStateOf(143), kommoStateOf(60434924), kommoStateOf(null)], ["paid", "rejected", "open", "open"], "🔴 статус Kommo прочитано хибно");
  assert.equal(discrepancyOf(false, "paid"), true, "🔴 «перевірити», а оплачено — не розбіжність");
  assert.equal(discrepancyOf(true, "rejected"), true, "🔴 «до оплати», а відмовлено — не розбіжність");
  assert.equal(discrepancyOf(true, "paid"), false, "🔴 збіг названо розбіжністю");
  assert.equal(discrepancyOf(true, "open"), false, "🔴 «ще висить» названо розбіжністю");
  assert.equal(discrepancyOf(false, "open"), false, "🔴 «перевірити» + висить названо розбіжністю");
  const t = totalsOf([row(), row({ ok: false, diff: true, amount: 3000 }), row({ amount: 500.5 })]);
  assert.deepEqual(t, { total: 3, ok: 2, okSum: 18500.5, check: 1, diff: 1 }, "🔴 підсумки не дорівнюють рядкам");
});

/**
 * #1271b — ФАЙЛ І «КОПІЮВАТИ»: рівно колонки Таниного файлу (ID | Номер карти | Власник карти | Сума | Категорії),
 * лише затверджені, табуляцією — вставляється в Google-таблицю в її колонки; табуляція всередині тексту не ламає рядок.
 * Той самий порядок і на фронті. Картка — `0000 0000 0000 0000`, не 16 цифр — як вніс менеджер.
 * 🧨 Червоніє, якщо зміниться порядок колонок, у буфер потрапить незатверджений рядок або фронт копіює інакше.
 */
test("#1271b ФАЙЛ І «КОПІЮВАТИ»: колонки Таниного файлу, лише затверджені, табуляцією; фронт — той самий порядок", () => {
  assert.deepEqual(fileRow(row()), [62762651, "1111 2222 3333 4444", "Іваненко Іван приват", 18000, "Транспортні послуги"], "🔴 колонки не як у файлі Тані");
  const tsv = clipboardTsv([row(), row({ ok: false, mainId: 1 }), row({ mainId: 2, owner: "А\tБ" })]);
  assert.equal(tsv, "62762651\t1111 2222 3333 4444\tІваненко Іван приват\t18000\tТранспортні послуги\n2\t1111 2222 3333 4444\tА Б\t18000\tТранспортні послуги",
    "🔴 у буфер пішов незатверджений рядок або табуляція зламала колонки");
  assert.equal(screenCard("1111222233334444"), "1111 2222 3333 4444");
  assert.equal(screenCard(" 1111 2222 "), "1111 2222", "🔴 неповну картку змінено, а не показано як є");
  assert.match(FE("pages/dashboard/sections/FinancePaymentsTab.tsx"), /rows\.filter\(\(r\) => r\.ok\)\.map\(\(r\) => \[r\.mainId \?\? "", r\.card, r\.owner, r\.amount \?\? 0, r\.category\]/,
    "🔴 фронт копіює не в колонках файлу або не лише затверджені");
});

/**
 * #1271c — EXCEL ВІДКРИВАЄТЬСЯ: архів — коректний ZIP (підписи, CRC кожного файлу, центральний каталог із тим самим
 * числом записів), аркуш «До оплати» несе шапку Таниного файлу, номер картки — ТЕКСТОМ (не числом у науковому форматі).
 * 🧨 Червоніє, якщо зламати CRC, загубити файл у каталозі чи записати картку числом.
 */
test("#1271c EXCEL ВІДКРИВАЄТЬСЯ: ZIP із правильними CRC і каталогом, шапка Тані, картка — текстом", () => {
  const buf = xlsxBook([{ name: "До оплати", rows: [["ID", "Номер карти", "Власник карти", 18000, "Категорії"], [62762651, "1111 2222 3333 4444", "Іваненко", 18000, "Транспортні послуги"]] },
    { name: "Усі запити", rows: [["ID угоди"], [1]] }]);
  const files = new Map<string, string>();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const crc = buf.readUInt32LE(p + 14), size = buf.readUInt32LE(p + 18), nl = buf.readUInt16LE(p + 26), xl = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nl).toString("utf8"), data = buf.subarray(p + 30 + nl + xl, p + 30 + nl + xl + size);
    assert.equal(crc32(data) >>> 0, crc, `🔴 CRC файлу ${name} не збігається — Excel не відкриє`);
    files.set(name, data.toString("utf8"));
    p += 30 + nl + xl + size;
  }
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0 && buf.readUInt16LE(eocd + 10) === files.size, "🔴 центральний каталог не збігається з файлами");
  for (const f of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"])
    assert.ok(files.has(f), `🔴 у книзі немає ${f}`);
  const s1 = files.get("xl/worksheets/sheet1.xml")!;
  assert.match(s1, /<t xml:space="preserve">Номер карти<\/t>/, "🔴 немає шапки Таниного файлу");
  assert.match(s1, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">1111 2222 3333 4444<\/t>/, "🔴 картку записано не текстом");
  assert.match(files.get("xl/workbook.xml")!, /<sheet name="До оплати" sheetId="1" r:id="rId1"\/><sheet name="Усі запити"/, "🔴 аркуші не на місці");
});

/**
 * #1271d — МЕЖА ЕКРАНА: на екрані номери карток і ПІБ, тож усі три роути — лише `view_private_finance` (Адмін,
 * фінансист) ПЕРШИМ middleware; у матриці — дозвіл адміну й фінансисту і заборона СЕО / ОД / КВП (дзеркало); вкладка
 * «Фінанси» рендерить екран, а без права — напис, і даних не просить.
 * 🧨 Червоніє, якщо зняти право з будь-якого роута, дати його СЕО/ОД/КВП у матриці чи показати екран без права.
 */
test("#1271d МЕЖА ЕКРАНА «ОПЛАТИ ПЕРЕВІЗНИКАМ»: три роути під view_private_finance, матриця з дзеркалом, вкладка без права — напис", async () => {
  const fin = SRC("routes/finance.ts");
  for (const r of [`get("/payments"`, `get("/payments/export.xlsx"`, `post("/payments/run"`])
    assert.ok(fin.includes(`financeRouter.${r}, requirePerm("view_private_finance"), async`), `🔴 роут ${r} без права view_private_finance`);
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js");
  const m = (method: string, p: string) => ACCESS_MATRIX.find((x) => x.method === method && x.path.startsWith(p) && (x.path === p || x.path[p.length] === "?"));
  for (const p of ["/api/finance/payments", "/api/finance/payments/export.xlsx"]) {
    const r = m("GET", p);
    assert.ok(r, `🔴 ${p} немає в матриці`);
    assert.deepEqual([...r!.allow].sort(), ["admin", "financier"], `🔴 ${p}: дозвіл не рівно Адмін і фінансист`);
    for (const role of ["ceo", "opdir", "kvp", "manager"]) assert.ok(r!.deny.includes(role), `🔴 ${p}: ${role} не в забороні`);
  }
  assert.ok(m("POST", "/api/finance/payments/run")?.deny.includes("kvp"), "🔴 «Оновити зараз» не в матриці");
  const sec = FE("pages/dashboard/sections/FinanceSection.tsx"), tab = FE("pages/dashboard/sections/FinancePaymentsTab.tsx");
  assert.match(sec, /\{tab === "payments" && <FinancePaymentsTab \/>\}/, "🔴 вкладка не рендерить екран");
  assert.match(sec, /\["payments", "Оплати перевізникам", false\]/, "🔴 вкладки немає в «Фінансах»");
  assert.match(tab, /const canView = \(getAuthPayload\(\)\?\.perms \?\? \[\]\)\.includes\("view_private_finance"\);/, "🔴 екран не за view_private_finance");
  assert.ok(tab.indexOf("if (!canView) return") < tab.indexOf("<table"), "🔴 таблиця рендериться до перевірки права");
  assert.match(tab, /if \(!canView\) return;\n\s*fetchCarrierPayments/, "🔴 без права екран все одно просить дані");
});
