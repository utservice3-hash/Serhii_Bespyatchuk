/**
 * 📄 ОФЕР ІЗ ШАБЛОНУ WORD — ЧИСТЕ ЯДРО (18.09.2026, етап 3 плану за зустріччю 15.09). Без БД і без `config`.
 *
 * Шаблон — звичайний .docx, у тексті якого стоять мітки `{{ПІБ}}`, `{{Посада}}`, `{{Ставка}}`… Ми
 * розпаковуємо архів (`officeParse.readZip`), у XML тексту міняємо мітки на значення і пакуємо назад
 * (`writeZip`, вбудований `zlib`). БЕЗ СТОРОННІХ БІБЛІОТЕК — з тієї самої причини, що й `officeParse`:
 * ланцюг викату не ставить залежностей.
 *
 * 🔴 WORD РВЕ МІТКИ. «{{ПІБ}}», набране з правкою чи перевіркою правопису, в XML лежить кількома
 * шматками: `<w:t>{{</w:t>…<w:t>ПІБ</w:t>…<w:t>}}</w:t>`. Тому шукаємо мітки в ТЕКСТІ АБЗАЦУ (склеєні
 * `<w:t>`), а значення кладемо в перший шматок мітки, решту шматків мітки очищаємо — розмітка
 * (жирний, шрифт) першого шматка лишається. Значення екрануються (`&`, `<`), тож чужий текст не ламає XML.
 * Тримає #576.
 */
import { crc32, deflateRawSync } from "zlib";
import { readZip, OfficeParseError } from "./officeParse.js";

/** XML-частини документа, де можуть стояти мітки: тіло, колонтитули, виноски. */
const TEXT_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const MARKER = /\{\{\s*([^{}]{1,60}?)\s*\}\}/g;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Назва мітки для звірки: регістр, пробіли, апострофи. «піб», « ПІБ » і «ПІБ» — одна мітка. */
export const markerKey = (s: string) => s.toLowerCase().replace(/[ʼ'’`]/g, "'").replace(/\s+/g, " ").trim();

export class OfferTemplateError extends Error {
  constructor(public status: number, message: string, public fields?: string[]) { super(message); }
}

function parts(buf: Buffer) {
  let zip: Map<string, () => Buffer>;
  try { zip = readZip(buf); } catch (e) { throw new OfferTemplateError(400, `Це не файл Word (.docx): ${(e as OfficeParseError).message}`); }
  if (!zip.has("word/document.xml")) throw new OfferTemplateError(400, "Це не файл Word (.docx): немає word/document.xml");
  return zip;
}

/** Абзаци XML з їхніми шматками тексту `<w:t>` (позиції в рядку XML). */
function paragraphs(xml: string) {
  const out: { runs: { start: number; end: number; text: string; open: string }[] }[] = [];
  const P = /<w:p[ >][\s\S]*?<\/w:p>/g;
  for (let pm = P.exec(xml); pm; pm = P.exec(xml)) {
    const runs: { start: number; end: number; text: string; open: string }[] = [];
    const T = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)<\/w:t>/g;
    for (let tm = T.exec(pm[0]); tm; tm = T.exec(pm[0])) {
      const at = pm.index + tm.index;
      runs.push({ start: at, end: at + tm[0].length, open: tm[1], text: unesc(tm[2]) });
    }
    if (runs.length) out.push({ runs });
  }
  return out;
}

/** Усі мітки шаблону — унікальні, у порядку появи. */
export function extractMarkers(buf: Buffer): string[] {
  const zip = parts(buf), seen = new Map<string, string>();
  for (const [name, read] of zip) {
    if (!TEXT_PART.test(name)) continue;
    for (const p of paragraphs(read().toString("utf8"))) {
      const text = p.runs.map((r) => r.text).join("");
      for (const m of text.matchAll(MARKER)) if (!seen.has(markerKey(m[1]))) seen.set(markerKey(m[1]), m[1].trim());
    }
  }
  return [...seen.values()];
}

/** Підставити значення в одну XML-частину. `values` — за `markerKey`. */
function fillXml(xml: string, values: Map<string, string>, missing: Set<string>): string {
  const edits: { start: number; end: number; xml: string }[] = [];
  for (const p of paragraphs(xml)) {
    const text = p.runs.map((r) => r.text).join("");
    if (!MARKER.test(text)) { MARKER.lastIndex = 0; continue; }
    MARKER.lastIndex = 0;
    // Кожному символу абзацу — його шматок; для символів мітки — що писати замість.
    const owner: number[] = [];
    p.runs.forEach((r, i) => { for (let k = 0; k < r.text.length; k++) owner.push(i); });
    const repl = new Map<number, string | null>(); // позиція → значення (перший символ мітки) або null (стерти)
    for (const m of text.matchAll(MARKER)) {
      const key = markerKey(m[1]);
      const v = values.get(key);
      if (v == null) { missing.add(m[1].trim()); continue; }
      for (let k = 0; k < m[0].length; k++) repl.set(m.index! + k, k === 0 ? v : null);
    }
    const next = p.runs.map(() => "");
    for (let k = 0; k < text.length; k++) {
      const r = repl.get(k);
      if (r === undefined) next[owner[k]] += text[k];
      else if (r !== null) next[owner[k]] += r;
    }
    p.runs.forEach((r, i) => {
      if (next[i] === r.text) return;
      const open = /xml:space=/.test(r.open) ? r.open : r.open.replace(/^<w:t/, '<w:t xml:space="preserve"');
      edits.push({ start: r.start, end: r.end, xml: `${open}${esc(next[i])}</w:t>` });
    });
  }
  let out = xml;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.xml + out.slice(e.end);
  return out;
}

/**
 * Заповнити шаблон. `values` — назва мітки → значення (назви звіряються через `markerKey`).
 * Немає значення хоч для однієї мітки — `OfferTemplateError(400)` з назвами полів: офер із
 * «{{Ставка}}» посеред тексту гірший за відсутній. Тримає #576/#577.
 */
export function fillDocx(buf: Buffer, values: Record<string, string>): Buffer {
  const zip = parts(buf);
  const vals = new Map<string, string>();
  for (const [k, v] of Object.entries(values)) if (v != null && String(v).trim() !== "") vals.set(markerKey(k), String(v).trim());
  const missing = new Set<string>();
  const entries: [string, Buffer][] = [];
  for (const [name, read] of zip) {
    const data = read();
    entries.push([name, TEXT_PART.test(name) ? Buffer.from(fillXml(data.toString("utf8"), vals, missing), "utf8") : data]);
  }
  if (missing.size) throw new OfferTemplateError(400, `Не заповнено: ${[...missing].join(", ")}`, [...missing]);
  return writeZip(entries);
}

/** Мінімальний запис ZIP (deflate) — рівно стільки, скільки треба для .docx. */
export function writeZip(entries: [string, Buffer][]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Поля, які дашборд заповнює сам (з картки кандидата). Решту міток Іван дописує у формі. */
export const AUTO_FIELDS: [string, string][] = [
  ["ПІБ", "ПІБ кандидата"], ["Посада", "посада з картки або вакансії"], ["Команда", "команда кандидата"],
  ["Тімлід", "тімлід команди"], ["Дата", "сьогодні"], ["Телефон", "телефон кандидата"], ["Пошта", "пошта кандидата"],
];
const ALIASES: Record<string, string> = { "піп": "ПІБ", "фіо": "ПІБ", "прізвище ім'я по батькові": "ПІБ", "дата оферу": "Дата", "керівник": "Тімлід" };
/** Мітка шаблону → назва автополя (або null — поле ручне). */
export function autoFieldOf(marker: string): string | null {
  const k = markerKey(marker);
  const hit = AUTO_FIELDS.find(([name]) => markerKey(name) === k);
  return hit ? hit[0] : ALIASES[k] ?? null;
}
