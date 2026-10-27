import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { kommoStateOf, discrepancyOf, fileRow, clipboardTsv, screenCard, totalsOf, splitTotals, archiveDayOf, type ScreenRow } from "./paymentScreen.js";
import { xlsxBook } from "./xlsx.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
// Номери карток вигадані.
const row = (o: Partial<ScreenRow> = {}): ScreenRow => ({ mainId: 62762651, requestId: 62764709, createdAt: null, amount: 18000, ok: true, paidBy: "Виписка",
  reasons: [], notes: [], card: "1111 2222 3333 4444", owner: "Іваненко Іван приват", category: "Транспортні послуги", kommo: "open", diff: false, stage: "Заявка на оплату", ...o });

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
  assert.deepEqual(t, { total: 3, ok: 2, okSum: 18500.5, check: 1, diff: 1, toClose: 2 }, "🔴 підсумки не дорівнюють рядкам");
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

// #1271d знято 26.10.2026 (роутів стало чотири — «Погоджено» / коментар) — наступник `#1288c` у `core/paymentMarks.test.ts`.

/**
 * #1273 — АРХІВ ПЕРЕКРЕСЛЕНИЙ (Роман 16.10.2026: «закрита — типу перекреслена»). Запит, що вийшов із фільтра в «Оплачено»
 * чи «Отказано», в архіві перекреслений і приглушений; розбіжність (система «перевірити», а оплачено) лишається підсвіченою.
 * 🧨 Червоніє, якщо перекреслити відкритий або загубити перекреслення / підсвітку розбіжності в архіві.
 */
test("#1273 АРХІВ ПЕРЕКРЕСЛЕНИЙ: що вийшло з фільтра («Оплачено» / «Отказано») — перекреслене й приглушене, розбіжність підсвічена", () => {
  const tab = FE("pages/dashboard/sections/FinancePaymentsTab.tsx");
  assert.match(tab, /const closedStyle = \(r: PayScreenRow\): React\.CSSProperties \| undefined =>\n\s*r\.kommo === "open" \? undefined : \{ textDecoration: "line-through", color: "var\(--text-muted\)" \};/,
    "🔴 перекреслюється не рівно закрите (оплачено / відмовлено)");
  assert.match(tab, /\{data\.archive\.map\(\(r\) => \(\n\s*<tr key=\{r\.requestId\} style=\{\{ \.\.\.closedStyle\(r\), \.\.\.\(r\.diff \? \{ background:/, "🔴 в архіві закриті не перекреслені або загубилась розбіжність");
});

/**
 * #1278 — ГОЛОВНЕ — ФІЛЬТР, АРХІВ — ЗА ДНЕМ ЗАКРИТТЯ (Тетяна через Романа 20.10.2026: «в архів сьогоднішнього дня мають
 * попадати усі закриті запити цього ж дня»; змінене твердження `#1274`). «У фільтрі зараз» — живий фільтр Тетяни БЕЗ вікна
 * дати; рішення — останнє з журналу, нового запиту — «ще не перевірено». Архів дня — запити, яких у фільтрі вже немає і які
 * ЗАКРИТО в Kommo цього календарного дня за Києвом (поданий 19.10 о 17:06 — файл 20.10 — і закритий о 17:07 — це архів
 * 19.10); північ — київська, і влітку, і взимку; вийшов із фільтра без закриття — у день свого файлу. Кандидати — журнал за
 * 14 днів до і день після (поданий після 17:00 належить файлу завтра). Кнопка — на сам запит; порожній фільтр — пусто.
 * 🧨 Червоніє, якщо групувати архів за днем файлу, брати північ за UTC, загубити незакриті чи день «після», домішати вікно
 * дати до фільтра, або порожній фільтр покаже щось.
 */
test("#1278 ФІЛЬТР І АРХІВ ЗА ДНЕМ ЗАКРИТТЯ: фільтр без вікна дати; архів дня — закриті в Kommo цього дня за Києвом, незакриті — у день файлу", () => {
  const t = splitTotals([row({ requestId: 1 }), row({ requestId: 2, ok: false }), row({ requestId: 3, ok: false, pending: true })],
    [row({ requestId: 9, kommo: "paid", ok: false, diff: true }), row({ requestId: 8, kommo: "paid" })]);
  assert.deepEqual(t, { active: 3, activeOk: 1, activeOkSum: 18000, activeCheck: 1, pending: 1, archive: 2, diff: 1 }, "🔴 підсумки фільтра й архіву хибні");
  const unix = (iso: string) => Date.parse(iso) / 1000;
  assert.equal(archiveDayOf(unix("2026-10-19T14:07:00Z"), "2026-10-20"), "2026-10-19", "🔴 закритий 19.10 о 17:07 (файл 20.10) — не в архіві 19.10");
  assert.equal(archiveDayOf(unix("2026-10-19T20:30:00Z"), "2026-10-19"), "2026-10-19", "🔴 23:30 за Києвом — не той самий день");
  assert.equal(archiveDayOf(unix("2026-10-19T21:30:00Z"), "2026-10-19"), "2026-10-20", "🔴 00:30 за Києвом 20.10 узято за UTC (19.10)");
  assert.equal(archiveDayOf(unix("2026-11-30T22:30:00Z"), "2026-11-30"), "2026-12-01", "🔴 зимова північ за Києвом (UTC+2) хибна");
  assert.deepEqual([archiveDayOf(null, "2026-10-18"), archiveDayOf(undefined, "2026-10-18"), archiveDayOf(0, "2026-10-18")],
    ["2026-10-18", "2026-10-18", "2026-10-18"], "🔴 незакритий запит не в дні свого файлу");
  const job = SRC("jobs/buildPaymentFile.ts");
  const open = job.slice(job.indexOf("export async function fetchOpenFilter"), job.indexOf("/** Excel:"));
  assert.ok(open.length > 0, "🔴 фільтр не знайдено — гейту нічого перевіряти");
  assert.match(open, /PAY_STATUSES\.map/, "🔴 фільтр не за трьома етапами Тетяни");
  assert.doesNotMatch(open, /created_at|142/, "🔴 до живого фільтра домішано вікно дати чи «Оплачено»");
  const screen = job.slice(job.indexOf("export async function loadScreenDay"), job.indexOf("export async function fetchOpenFilter"));
  assert.match(screen, /FROM payment_file_log WHERE day BETWEEN \$1::date - 14 AND \$1::date \+ 1 ORDER BY request_id, day DESC, last_at DESC/, "🔴 кандидати архіву — не журнал за 14 днів до і день після");
  assert.match(screen, /const gone = log\.filter\(\(x\) => !activeSet\.has\(Number\(x\.request_id\)\)\);/, "🔴 в архів потрапляє те, що досі у фільтрі");
  assert.match(screen, /archiveDayOf\(leads\.get\(Number\(x\.request_id\)\)\?\.closed_at, x\.day!\) === day/, "🔴 архів не за днем закриття з Kommo");
  assert.match(screen, /const day = dayArg && .* \? dayArg : todayCal;/, "🔴 день архіву за замовчуванням — не сьогодні за календарем");
  assert.match(job, /reasons: v \? v\.reasons : \["ще не перевірено — натисніть «↻ Перевірити зараз»"\]/, "🔴 новий запит без рішення не названо «ще не перевірено»");
  const tab = FE("pages/dashboard/sections/FinancePaymentsTab.tsx");
  assert.match(tab, /\{!data\.active\.length \? <p className="hr-muted" style=\{\{ margin: "8px 0" \}\}>У фільтрі зараз немає запитів/, "🔴 порожній фільтр не порожній");
  assert.match(tab, /href=\{`\$\{data\.kommoBase\}\/leads\/detail\/\$\{r\.requestId\}`\}/, "🔴 кнопка веде не на сам запит у воронці");
  assert.match(tab, /const ok = data\.active\.filter\(\(r\) => r\.ok\);/, "🔴 файл «До оплати» не лише з фільтра");
  assert.match(tab, /закриті в Kommo \{dm\(data\.day\)\}/, "🔴 підпис архіву не каже, що це день закриття");
});

/**
 * #1276 — ПІДКАЗКА НАЗИВАЄ КНОПКУ ТАК, ЯК ВОНА НАПИСАНА НА ЕКРАНІ. Рядок «ще не перевірено» каже, що натиснути, — і
 * назва мусить бути рівно підписом кнопки на вкладці (Роман 19.10.2026: підказка казала «Оновити зараз», а кнопка —
 * «↻ Перевірити зараз», і її не знайшли).
 * 🧨 Червоніє, якщо перейменувати кнопку чи підказку поодинці.
 */
test("#1276 ПІДКАЗКА = КНОПКА: «ще не перевірено» називає рівно підпис кнопки перевірки на вкладці", () => {
  const tab = FE("pages/dashboard/sections/FinancePaymentsTab.tsx");
  const label = /\{busy \? "Перевіряю…" : "([^"]+)"\}/.exec(tab)?.[1];
  assert.ok(label, "🔴 кнопку перевірки на вкладці не знайдено");
  assert.ok(SRC("jobs/buildPaymentFile.ts").includes(`натисніть «${label}»`), `🔴 підказка не називає кнопку «${label}»`);
});
