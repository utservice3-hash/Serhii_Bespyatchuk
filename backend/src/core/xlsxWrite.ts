import { writeZip } from "./offerTemplate.js";

/**
 * 📊 МІНІМАЛЬНИЙ .XLSX БЕЗ БІБЛІОТЕК — для вивантаження таблиць у Excel (вперше: вікно «Час опрацювання заявки»,
 * ТЗ 24.09.2026, п.9). Аркуші з рядками рядків/чисел, перший рядок жирний.
 *
 * 🔴 ЧОМУ НА СЕРВЕРІ Й БЕЗ ЗАЛЕЖНОСТЕЙ. Бібліотека Excel у фронті додала б ~400 КБ до ОДНОГО бандла, який тягне
 * кожен користувач (`#225`: збірка мусить бути одним чанком). Тут — `writeZip`, що вже пише .docx конструктора, і
 * ~40 рядків XML. Чи відкривається файл, стереже гейт, що читає його нашим же `parseXlsx`.
 */
export type Cell = string | number | null;
export interface Sheet { name: string; rows: Cell[][] }

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // Керівні символи XML 1.0 забороняє — Excel відмовився б відкрити файл через один такий у назві угоди.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

const colName = (i: number): string => {
  let s = "", n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

function sheetXml(rows: Cell[][]): string {
  const body = rows.map((row, ri) => {
    const cells = row.map((v, ci) => {
      if (v == null || v === "") return "";
      const ref = `${colName(ci)}${ri + 1}`;
      const style = ri === 0 ? ' s="1"' : "";
      return typeof v === "number" && Number.isFinite(v)
        ? `<c r="${ref}"${style}><v>${v}</v></c>`
        : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** Назва аркуша: ≤31 символ, без `[]:*?/\` — інакше Excel «відновлює» файл. */
const sheetName = (s: string, i: number): string => (s.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || `Аркуш ${i + 1}`);

export function buildXlsx(sheets: Sheet[]): Buffer {
  const names = sheets.map((s, i) => sheetName(s.name, i));
  const entries: [string, Buffer][] = [
    ["[Content_Types].xml", Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
      + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
      + `</Types>`)],
    ["_rels/.rels", Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)],
    ["xl/workbook.xml", Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
      + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
      + names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
      + `</sheets></workbook>`)],
    ["xl/_rels/workbook.xml.rels", Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
      + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + `</Relationships>`)],
    ["xl/styles.xml", Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
      + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
      + `<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>`
      + `<cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`)],
    ...sheets.map((s, i): [string, Buffer] => [`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(sheetXml(s.rows))]),
  ];
  return writeZip(entries);
}
