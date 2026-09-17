import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDocx, docxText, parseXlsx, readZip, colIndex, excelDate, OfficeParseError } from "./officeParse.js";
import { extractText, formatOf } from "./docText.js";
import { searchDocs, foldText, type SearchDoc } from "./docSearch.js";

/** Мінімальний ZIP-писар для фікстур: частина записів стиснута deflate, частина — без стиснення. */
function zip(entries: [string, string, boolean?][]): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const [name, content, deflate = true] of entries) {
    const raw = Buffer.from(content, "utf8"); const data = deflate ? deflateRawSync(raw) : raw; const nm = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const DOCX = zip([
  ["word/styles.xml", `<w:styles ${W}><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style></w:styles>`, false],
  ["word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>
    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>Регламент оплати</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Жирне </w:t></w:r><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>звичайне &amp; «лапки»</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>пункт списку</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Клієнт</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Сума</w:t></w:r></w:p></w:tc></w:tr>
           <w:tr><w:tc><w:p><w:r><w:t>ТОВ Ромашка</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>5 000</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><mc:AlternateContent><mc:Choice><w:t>напис</w:t></mc:Choice><mc:Fallback><w:t>напис</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>
  </w:body></w:document>`],
]);

/**
 * #509 — WORD БЕЗ БІБЛІОТЕК: заголовок за НАЗВОЮ стилю (id «1» як в українському Word), жирне
 * вмикається й вимикається `w:val="0"`, список, таблиця рядками й клітинками, сутності XML, і
 * запасний вміст `mc:Fallback` не дублює текст. Червоніє, якщо таблиця зникне з перегляду чи пошуку,
 * заголовок визначатиметься за id, або текст напису двоїтиметься.
 */
test("#509 WORD: заголовок за назвою стилю, жирне, список, таблиця, без дубля mc:Fallback", () => {
  const d = parseDocx(DOCX);
  assert.deepEqual(d.blocks[0], { t: "h", level: 1, runs: [{ text: "Регламент оплати" }] }, "заголовок з id «1» не впізнано за назвою стилю");
  assert.deepEqual(d.blocks[1], { t: "p", runs: [{ text: "Жирне ", b: true }, { text: "звичайне & «лапки»", b: false }] }, "жирне/сутності розібрано хибно");
  assert.equal(d.blocks[2].t, "li", "пункт списку не впізнано");
  assert.deepEqual(d.blocks[3], { t: "table", rows: [["Клієнт", "Сума"], ["ТОВ Ромашка", "5 000"]] }, "🔴 таблиця розібрана хибно або зникла");
  const text = docxText(d);
  assert.match(text, /ТОВ Ромашка\t5 000/, "🔴 текст таблиці не потрапляє в пошук");
  assert.equal(text.split("напис").length - 1, 1, "🔴 текст напису задвоївся через mc:Fallback");
});

const XLSX = zip([
  ["xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="Оплати" sheetId="1" r:id="rId1"/><sheet name="Службовий" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`],
  ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`],
  ["xl/sharedStrings.xml", `<sst><si><t>Клієнт</t></si><si><r><t>Комiсiя </t></r><r><t>банку</t></r><rPh><t>ФОНЕТИКА</t></rPh></si></sst>`],
  ["xl/styles.xml", `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00&quot;₴&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="14"/></cellXfs></styleSheet>`],
  ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
    <row r="3"><c r="A3" s="1"><v>46282</v></c><c r="B3" s="2"><v>1234.5</v></c><c r="C3" t="str"><f>A1</f><v>Клієнт</v></c><c r="D3" t="b"><v>1</v></c><c r="E3"><v>0.30000000000000004</v></c><c r="F3" t="inlineStr"><is><t>вручну</t></is></c></row>
  </sheetData></worksheet>`],
  ["xl/worksheets/sheet2.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>таємне</t></is></c></row></sheetData></worksheet>`],
]);

/**
 * #509b — EXCEL БЕЗ БІБЛІОТЕК: клітинки стоять у СВОЇХ колонках (пропуски не зсувають), спільні рядки
 * без фонетики, дата за стилем, гроші-формат НЕ дата, формула — кешоване значення, прихований аркуш
 * не показується. Червоніє, якщо ігнорувати адресу клітинки (C1 зʼїде в B1) або рахувати будь-який
 * числовий формат датою.
 */
test("#509b EXCEL: клітинки у своїх колонках, дата за стилем, формула — значення, прихований аркуш прихований", () => {
  const sheets = parseXlsx(XLSX);
  assert.deepEqual(sheets.map((s) => s.name), ["Оплати"], "🔴 прихований аркуш потрапив у перегляд");
  const s = sheets[0];
  assert.deepEqual(s.rows[0], ["Клієнт", "", "Комiсiя банку"], "🔴 пропущена клітинка B1 зсунула C1 — колонки зʼїхали");
  assert.deepEqual(s.rows[1] ?? [], [], "порожній рядок 2 мусить лишитись порожнім місцем");
  assert.deepEqual(s.rows[2], [excelDate(46282), "1234.5", "Клієнт", "TRUE", "0.3", "вручну"], "значення рядка 3 розібрано хибно");
  assert.match(s.rows[2][0], /^\d{2}\.\d{2}\.\d{4}$/, "дата за стилем не стала датою");
  assert.equal(s.totalRows, 3); assert.equal(s.totalCols, 6); assert.equal(s.truncated, false);
  assert.equal(colIndex("AB12"), 27);
  const cut = parseXlsx(XLSX, 1, 2)[0];
  assert.equal(cut.truncated, true, "обрізаний аркуш не позначено «показано не все»");
  assert.deepEqual(cut.rows, [["Клієнт"]]);
});

/**
 * #509c — ЧЕСНІ СТАНИ ТЕКСТУ: збій розбору — `failed` із причиною, а НЕ `empty`; фото — `unsupported`;
 * PDF без тексту — `empty`; ZIP-бомба зупиняється стелею. Червоніє, якщо зламаний файл тихо стане
 * «тексту немає» — тоді пошук мовчки не знаходить саме те, що зламалось.
 */
test("#509c ТЕКСТ: збій — failed із причиною, не empty; фото — unsupported; скан PDF — empty; стеля проти ZIP-бомби", async () => {
  assert.equal((await extractText("docx", Buffer.from("не zip"), "")).status, "failed");
  assert.match((await extractText("docx", Buffer.from("не zip"), "")).reason ?? "", /ZIP/);
  assert.equal((await extractText(formatOf("фото.jpg", "image/jpeg"), Buffer.alloc(10), "")).status, "unsupported");
  assert.equal((await extractText("pdf", Buffer.alloc(0), "x.pdf", async () => "  \n \f ")).status, "empty");
  const noTool = await extractText("pdf", Buffer.alloc(0), "x.pdf", async () => { throw new Error("на сервері немає pdftotext"); });
  assert.deepEqual([noTool.status, noTool.reason], ["failed", "на сервері немає pdftotext"], "🔴 відсутній pdftotext прочитався як «порожній документ»");
  const ok = await extractText("docx", DOCX, "");
  assert.equal(ok.status, "ok"); assert.match(ok.text ?? "", /ТОВ Ромашка/);
  const bomb = zip([["word/document.xml", "a".repeat(5000)]]);
  assert.throws(() => readZip(bomb, 1000).get("word/document.xml")!(), OfficeParseError, "стеля розпакування не спрацювала");
});

/**
 * #510 — ПОШУК ПО ТЕКСТУ: усі слова (І), регістр і латинські двійники не важать, уривок містить
 * знайдене, текст СТАРОЇ версії не шукається, а документи без тексту й ті, що ще обробляються,
 * рахуються окремо. Червоніє, якщо шукати в тексті попередньої версії, склеїти «не шукались» із
 * «не знайдено» або перейти на АБО.
 */
test("#510 ПОШУК: усі слова, двійники латиниці, уривок, стара версія не шукається, «не шукались» окремим числом", () => {
  const docs: SearchDoc[] = [
    { id: 1, version: 2, contentVersion: 2, status: "ok", text: "Договір поставки. Комiсiя банку 2% сплачує клієнт; комісія повертається." },
    { id: 2, version: 3, contentVersion: 2, status: "ok", text: "комісія банку у старій версії" },
    { id: 3, version: 1, contentVersion: 1, status: "empty", text: null },
    { id: 4, version: 1, contentVersion: 1, status: "failed", text: null },
    { id: 5, version: 1, contentVersion: null, status: null, text: null },
    { id: 6, version: 1, contentVersion: 1, status: "ok", text: "Банк і комісія окремо: ні" },
  ];
  const r = searchDocs(docs, "КОМІСІЯ банку");
  assert.deepEqual(r.hits.map((h) => h.id), [1], "🔴 збіги неправильні: або стара версія, або АБО замість І");
  assert.equal(r.hits[0].count, 2, "латинська «i» у «Комiсiя» не зведена до кириличної");
  assert.match(r.hits[0].snippet, /Комiсiя банку/, "уривок не містить знайденого");
  assert.deepEqual([r.searched, r.notSearchable, r.pending], [2, 2, 2], "🔴 «не шукались» / «обробляються» пораховано хибно");
  assert.equal(foldText("Комiсiя").length, "Комiсiя".length, "згортання змінило довжину — уривок зʼїде");
  assert.deepEqual(searchDocs(docs, "к").hits, [], "однолітерний запит не мусить збігатись з усім");
});

/**
 * #510b — ПОШУК НЕ РОЗКРИВАЄ НЕВИДИМОГО: роут фільтрує `canSeeDocument` ДО читання тексту і шукає лише
 * серед видимих id; перегляд Word/Excel іде через `visibleFile`. Читає джерело роуту. Червоніє, якщо
 * прибрати фільтр (уривок чужого офера потрапить у відповідь) або рендер обійде перевірку доступу.
 */
test("#510b ПОШУК І ПЕРЕГЛЯД: текст читається лише для видимих документів", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/routes/documents.ts", import.meta.url)), "utf8");
  const body = (head: string) => { const i = src.indexOf(head); assert.ok(i >= 0, `немає ${head}`); return src.slice(i, src.indexOf("\n});", i)); };
  const search = body('documentsRouter.get("/search"');
  const filt = search.indexOf("canSeeDocument(viewer, toDocLike(r), ctx)");
  const read = search.indexOf("content_text FROM doc_files WHERE id = ANY($1::int[])");
  assert.ok(filt >= 0, "🔴 пошук не фільтрує за видимістю");
  assert.ok(read > filt, "🔴 текст читається не з відфільтрованого набору");
  assert.match(search, /\[visibleIds\]\)/, "🔴 запит тексту не обмежений видимими id");
  assert.match(body('documentsRouter.get("/file/:id/render"'), /await visibleFile\(req, res,/, "🔴 перегляд Word/Excel без перевірки доступу");
});
