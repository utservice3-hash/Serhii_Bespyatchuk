/**
 * 📄 WORD (.docx) І EXCEL (.xlsx) БЕЗ СТОРОННІХ БІБЛІОТЕК — для перегляду в картці й пошуку по тексту.
 *
 * 🔴 ЧОМУ БЕЗ БІБЛІОТЕК. Ланцюг викату не ставить залежностей (`tools/deploy.ts`, `needDeps`), а
 * крок `test` зупиняється, коли `package-lock.json` розійшовся з продом. Нова залежність означала б
 * ручний `npm ci` на стенді й проді, а без нього — падіння сервера на імпорті. docx і xlsx — це
 * ZIP-архіви з XML, і для них вистачає вбудованого `zlib`.
 *
 * 🔴 ЧОГО ТУТ НЕМАЄ СВІДОМО: старих .doc/.xls (бінарний формат; на проді 17.09.2026 таких нуль),
 * макета сторінки (поля, колонтитули, розриви), картинок, діаграм, обʼєднаних клітинок. Це
 * перегляд для читання, а не копія друку, — і картка каже це людині прямо.
 *
 * Результат — СТРУКТУРА (абзаци, рядки клітинок), а не HTML: фронт малює її React-ом, тож
 * текст із чужого файла ніколи не стає розміткою.
 */
import { inflateRawSync } from "zlib";

/** Стеля розпакованого розміру одного запису — захист від ZIP-бомби. */
export const MAX_ENTRY_BYTES = 60 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export class OfficeParseError extends Error {}

/** Читає ZIP (центральний каталог + stored/deflate). ZIP64 і шифрування не підтримуються. */
export function readZip(buf: Buffer, maxEntryBytes = MAX_ENTRY_BYTES): Map<string, () => Buffer> {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new OfficeParseError("не ZIP-архів");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new OfficeParseError("забагато записів в архіві");
  if (p === 0xffffffff) throw new OfficeParseError("ZIP64 не підтримується");
  const out = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new OfficeParseError("пошкоджений каталог архіву");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    out.set(name, () => {
      if (flags & 1) throw new OfficeParseError("файл зашифровано");
      if (size > maxEntryBytes) throw new OfficeParseError(`запис «${name}» завеликий`);
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new OfficeParseError("пошкоджений запис архіву");
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try { return inflateRawSync(data, { maxOutputLength: maxEntryBytes }); }
        catch (e) { throw new OfficeParseError(`не розпаковано «${name}»: ${(e as Error).message}`); }
      }
      throw new OfficeParseError(`метод стиснення ${method} не підтримується`);
    });
  }
  return out;
}

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e === "lt") return "<"; if (e === "gt") return ">"; if (e === "amp") return "&"; if (e === "quot") return "\""; if (e === "apos") return "'";
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}
const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : null;
};
const onOff = (attrs: string): boolean => { const v = attr(attrs, "val"); return v == null || !["0", "false", "none", "off"].includes(v); };

/* ── Word ─────────────────────────────────────────────────────────────── */

export interface DocxRun { text: string; b?: boolean; i?: boolean; u?: boolean }
export type DocxBlock =
  | { t: "p" | "li"; runs: DocxRun[] }
  | { t: "h"; level: 1 | 2 | 3; runs: DocxRun[] }
  | { t: "table"; rows: string[][] };
export interface DocxResult { blocks: DocxBlock[]; truncated: boolean; hasImages: boolean }

export const MAX_DOCX_BLOCKS = 4000;

/** styleId → рівень заголовка (1..3) за НАЗВОЮ стилю: в українському Word id бувають «1», «2». */
function headingStyles(stylesXml: string | null): Map<string, 1 | 2 | 3> {
  const m = new Map<string, 1 | 2 | 3>();
  if (!stylesXml) return m;
  const re = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(stylesXml))) {
    const id = attr(x[1], "styleId"); const nm = /<w:name\b([^>]*)\/?>/.exec(x[2]);
    const name = nm ? (attr(nm[1], "val") ?? "") : "";
    if (!id) continue;
    const h = /(?:heading|заголовок)\s*(\d)/i.exec(name);
    if (h) m.set(id, Math.min(3, Math.max(1, Number(h[1]))) as 1 | 2 | 3);
    else if (/^(title|назва)$/i.test(name)) m.set(id, 1);
  }
  return m;
}

export function parseDocx(buf: Buffer): DocxResult {
  const zip = readZip(buf);
  const doc = zip.get("word/document.xml");
  if (!doc) throw new OfficeParseError("у файлі немає word/document.xml — це не документ Word");
  const xml = doc().toString("utf8");
  const heads = headingStyles(zip.get("word/styles.xml")?.().toString("utf8") ?? null);
  const blocks: DocxBlock[] = [];
  let truncated = false;
  let hasImages = false;

  // Потоковий розбір тегів зі стеком: вкладені таблиці, абзаци в клітинках, текст лише з <w:t>.
  const tok = /<(\/?)([A-Za-z][\w.-]*:)?([\w.-]+)((?:\s[^>]*?)?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|([^<]+)/g;
  const stack: string[] = [];
  let skipDepth = 0; // усередині mc:Fallback — дубль вмісту для старих програм
  type Para = { style: string | null; list: boolean; runs: DocxRun[] };
  let para: Para | null = null;
  let run: DocxRun | null = null;
  let inRPr = false;
  const tables: { rows: string[][]; row: string[] | null; cell: string[] | null }[] = [];

  const pushBlock = (b: DocxBlock) => { if (blocks.length >= MAX_DOCX_BLOCKS) { truncated = true; return; } blocks.push(b); };
  const addText = (s: string) => {
    if (tables.length) { const t = tables[tables.length - 1]; if (t.cell) t.cell[t.cell.length - 1] += s; return; }
    if (!para) return;
    if (!run) { run = { text: "" }; para.runs.push(run); }
    run.text += s;
  };

  let x: RegExpExecArray | null;
  while ((x = tok.exec(xml))) {
    if (x[6] != null) { // текст
      if (!skipDepth && stack[stack.length - 1] === "w:t") addText(decodeXml(x[6]));
      continue;
    }
    if (!x[3]) continue; // коментар / декларація
    const closing = x[1] === "/"; const selfClose = x[5] === "/";
    const name = `${x[2] ?? ""}${x[3]}`; const attrs = x[4] ?? "";
    if (closing) {
      const i = stack.lastIndexOf(name); if (i >= 0) stack.length = i;
      if (name === "mc:Fallback" && skipDepth) skipDepth--;
      if (skipDepth) continue;
      if (name === "w:rPr") inRPr = false;
      else if (name === "w:r") run = null;
      else if (name === "w:p") {
        if (tables.length) { const t = tables[tables.length - 1]; if (t.cell) t.cell.push(""); }
        else if (para) {
          const runs = para.runs.filter((r) => r.text.length);
          const level = para.style ? heads.get(para.style) : undefined;
          if (level) pushBlock({ t: "h", level, runs });
          else if (runs.length || !para.list) pushBlock({ t: para.list ? "li" : "p", runs });
        }
        para = null;
      } else if (name === "w:tc") {
        const t = tables[tables.length - 1];
        if (t?.row && t.cell) t.row.push(t.cell.join("\n").replace(/\n+$/, ""));
        if (t) t.cell = null;
      } else if (name === "w:tr") {
        const t = tables[tables.length - 1]; if (t?.row) t.rows.push(t.row); if (t) t.row = null;
      } else if (name === "w:tbl") {
        const t = tables.pop()!;
        const rows = t.rows.filter((r) => r.some((c) => c.trim()));
        if (tables.length) { const outer = tables[tables.length - 1]; if (outer.cell) outer.cell[outer.cell.length - 1] += rows.map((r) => r.join(" · ")).join("\n"); }
        else if (rows.length) pushBlock({ t: "table", rows });
      }
      continue;
    }
    if (name === "mc:Fallback") { if (!selfClose) { skipDepth++; stack.push(name); } continue; }
    if (skipDepth) { if (!selfClose) stack.push(name); continue; }
    switch (name) {
      case "w:p": if (!tables.length) para = { style: null, list: false, runs: [] }; if (selfClose && !tables.length) { pushBlock({ t: "p", runs: [] }); para = null; } break;
      case "w:pStyle": if (para) para.style = attr(attrs, "val"); break;
      case "w:numPr": if (para) para.list = true; break;
      case "w:r": if (!tables.length && para) { run = { text: "" }; para.runs.push(run); } break;
      case "w:rPr": inRPr = !selfClose; break;
      case "w:b": if (inRPr && run) run.b = onOff(attrs); break;
      case "w:i": if (inRPr && run) run.i = onOff(attrs); break;
      case "w:u": if (inRPr && run) run.u = onOff(attrs); break;
      case "w:tab": if (!inRPr && stack[stack.length - 1] !== "w:tabs") addText("\t"); break;
      case "w:br": case "w:cr": addText("\n"); break;
      case "w:drawing": case "w:pict": hasImages = true; break;
      case "w:tbl": tables.push({ rows: [], row: null, cell: null }); break;
      case "w:tr": { const t = tables[tables.length - 1]; if (t) t.row = []; break; }
      case "w:tc": { const t = tables[tables.length - 1]; if (t) t.cell = [""]; break; }
    }
    if (!selfClose) stack.push(name);
  }
  // Порожні абзаци поспіль стискаємо до одного: у Word ними роблять відступи.
  const squeezed = blocks.filter((b, i) => !(b.t === "p" && !b.runs.length && (i === 0 || (blocks[i - 1].t === "p" && !(blocks[i - 1] as { runs: DocxRun[] }).runs.length))));
  return { blocks: squeezed, truncated, hasImages };
}

export function docxText(r: DocxResult): string {
  return r.blocks.map((b) => b.t === "table" ? b.rows.map((row) => row.join("\t")).join("\n") : b.runs.map((x) => x.text).join("")).join("\n");
}

/* ── Excel ────────────────────────────────────────────────────────────── */

export interface XlsxSheet { name: string; rows: string[][]; totalRows: number; totalCols: number; truncated: boolean }
export const MAX_XLSX_ROWS = 1000;
export const MAX_XLSX_COLS = 60;

export function colIndex(ref: string): number {
  const m = /^([A-Z]+)/i.exec(ref); if (!m) return -1;
  let n = 0; for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dmyhs]/i.test(bare) && !/^general$/i.test(bare.trim());
}
/** Серійне число Excel → «дд.мм.рррр» (+ «гг:хх», якщо є час). Система дат 1900. */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  const hasTime = Math.abs(serial % 1) > 1e-9;
  return hasTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}
const siText = (inner: string) => {
  const noPh = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let s = ""; const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g; let m: RegExpExecArray | null;
  while ((m = re.exec(noPh))) s += decodeXml(m[1]);
  return s;
};

export function parseXlsx(buf: Buffer, maxRows = MAX_XLSX_ROWS, maxCols = MAX_XLSX_COLS): XlsxSheet[] {
  const zip = readZip(buf);
  const wb = zip.get("xl/workbook.xml");
  if (!wb) throw new OfficeParseError("у файлі немає xl/workbook.xml — це не книга Excel");
  const read = (n: string) => zip.get(n)?.().toString("utf8") ?? null;
  const shared: string[] = [];
  const sst = read("xl/sharedStrings.xml");
  if (sst) { const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g; let m: RegExpExecArray | null; while ((m = re.exec(sst))) shared.push(m[1] ? siText(m[1]) : ""); }

  const dateXf = new Set<number>();
  const styles = read("xl/styles.xml");
  if (styles) {
    const custom = new Map<number, string>();
    const fr = /<numFmt\b([^>]*?)\/?>/g; let f: RegExpExecArray | null;
    while ((f = fr.exec(styles))) { const id = Number(attr(f[1], "numFmtId")); const code = attr(f[1], "formatCode"); if (code != null) custom.set(id, code); }
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
    if (xfs) {
      const xr = /<xf\b([^>]*?)(?:\/>|>)/g; let i = 0; let m: RegExpExecArray | null;
      while ((m = xr.exec(xfs[1]))) {
        const id = Number(attr(m[1], "numFmtId") ?? 0);
        if (BUILTIN_DATE_FMTS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) dateXf.add(i);
        i++;
      }
    }
  }

  const rels = new Map<string, string>();
  const relXml = read("xl/_rels/workbook.xml.rels");
  if (relXml) { const re = /<Relationship\b([^>]*?)\/?>/g; let m: RegExpExecArray | null; while ((m = re.exec(relXml))) { const id = attr(m[1], "Id"); const tg = attr(m[1], "Target"); if (id && tg) rels.set(id, tg); } }

  const sheets: XlsxSheet[] = [];
  const sr = /<sheet\b([^>]*?)\/?>/g; let s: RegExpExecArray | null;
  const wbXml = wb().toString("utf8");
  while ((s = sr.exec(wbXml))) {
    if ((attr(s[1], "state") ?? "visible") !== "visible") continue;
    const name = attr(s[1], "name") ?? "Аркуш";
    const rid = attr(s[1], "id");
    const target = rid ? rels.get(rid) : null;
    if (!target) continue;
    const pathIn = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const sheetXml = read(pathIn);
    if (!sheetXml) continue;
    const rows: string[][] = [];
    let totalRows = 0, totalCols = 0, truncated = false, nextRow = 0;
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g; let r: RegExpExecArray | null;
    while ((r = rowRe.exec(sheetXml))) {
      const rAttr = attr(r[1], "r");
      const ri = rAttr ? Number(rAttr) - 1 : nextRow;
      nextRow = ri + 1;
      const cells: string[] = [];
      let nextCol = 0;
      if (r[2]) {
        const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let c: RegExpExecArray | null;
        while ((c = cRe.exec(r[2]))) {
          const ref = attr(c[1], "r");
          const ci = ref ? colIndex(ref) : nextCol;
          nextCol = ci + 1;
          const inner = c[2] ?? "";
          const t = attr(c[1], "t");
          const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          let val = "";
          if (t === "s") val = v != null ? (shared[Number(v)] ?? "") : "";
          else if (t === "inlineStr") { const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner); val = is ? siText(is[1]) : ""; }
          else if (t === "str" || t === "e") val = v != null ? decodeXml(v) : "";
          else if (t === "b") val = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
          else if (v != null) {
            const n = Number(v);
            const xf = Number(attr(c[1], "s") ?? -1);
            val = !Number.isFinite(n) ? decodeXml(v) : dateXf.has(xf) ? excelDate(n) : String(Number(n.toPrecision(15)));
          }
          if (val === "") continue;
          totalCols = Math.max(totalCols, ci + 1);
          if (ci < maxCols) { while (cells.length < ci) cells.push(""); cells[ci] = val; }
        }
      }
      if (!cells.length) continue;
      totalRows = Math.max(totalRows, ri + 1);
      if (ri >= maxRows) { truncated = true; continue; }
      while (rows.length < ri) rows.push([]);
      rows[ri] = cells;
    }
    if (totalCols > maxCols) truncated = true;
    sheets.push({ name, rows, totalRows, totalCols, truncated });
  }
  return sheets;
}

export function xlsxText(sheets: XlsxSheet[]): string {
  return sheets.map((s) => `${s.name}\n${s.rows.map((r) => r.filter(Boolean).join("\t")).filter(Boolean).join("\n")}`).join("\n\n");
}
