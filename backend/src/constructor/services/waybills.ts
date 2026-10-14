/**
 * 🚚 ТТН (форма № 1-ТН) і CMR із заявки перевізнику (задача 5464, рішення Романа 14.10.2026).
 *
 * Заповнюємо САМІ БЛАНКИ, які дали (`data/waybill/`): ТТН — офіційна 1-ТН (Додаток 7 до Правил перевезень, п. 11.1),
 * CMR — бланк RU/DE як є. Верстку не відтворюємо, тож форма лишається офіційною один в один; на сервері немає
 * LibreOffice, тому віддаємо Excel і Word (менеджер допише вагу/печатку й друкує), а не PDF.
 *
 * Дані — з тієї самої форми, що й заявка. «Автомобільний перевізник» у ТТН і графа 16 CMR — ПЕРЕВІЗНИК ІЗ ЗАЯВКИ
 * (рішення Романа 14.10: той, хто фактично везе; ЮТС — експедитор). Чого в формі окремо немає (вага й місця окремими
 * числами, суми з ПДВ, країни) — НЕ вигадуємо: клітинка лишається порожньою.
 *
 * Бланки в репозиторії порожні; з метаданих прибрано автора (у ТТН був чужий e-mail).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readZip } from '../../core/officeParse.js';
import { zipStore, type DocumentState } from './docgen.js';

const DIR = path.join(import.meta.dirname, '..', 'data', 'waybill');
export const TTN_TEMPLATE = path.join(DIR, 'ttn-1tn.xlsx');
export const CMR_TEMPLATE = path.join(DIR, 'cmr.docx');

const X = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/** Перша дата ДД.ММ.РРРР у вільному тексті («06.10.2026, 08:00»). */
export function firstDate(t: string): { d: string; m: number; y: string } | null {
  const r = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(t || '');
  return r ? { d: r[1].padStart(2, '0'), m: Number(r[2]), y: r[3] } : null;
}
/** «Вольво АА 0000 АА / АА 0000 ХР» → [авто, причіп]; без роздільника — усе в «авто». */
export function splitTruck(t: string): [string, string] {
  const m = /^(.*?)\s*[/\\]\s*(.+)$/.exec((t || '').trim());
  return m ? [m[1].trim(), m[2].trim()] : [(t || '').trim(), ''];
}
const join = (...a: Array<string | undefined>) => a.map((x) => (x || '').trim()).filter(Boolean).join(', ');

/** Перевізник із заявки — однією строкою (як у прикладі заповнення ТТН: «назва, ЄДРПОУ …»). */
const carrierLine = (s: DocumentState) => join(s.cp.name, s.cp.edrpou ? `ЄДРПОУ ${s.cp.edrpou}` : '');

/** ТТН і CMR — лише із заявки перевізнику: у клієнтській немає перевізника, авто й водія. */
export const waybillBlocker = (s: Pick<DocumentState, 'doc'>): string | null =>
  s.doc === 'carr' ? null : 'ТТН і CMR формуються із заявки перевізнику — там є перевізник, авто й водій.';

/* ── ТТН ── */

/** Клітинки аркуша 1-ТН, які заповнюємо (ліві верхні обʼєднаних діапазонів бланка). */
export function ttnCells(s: DocumentState): Record<string, string> {
  const t = s.trip, date = firstDate(t.loadDate || '');
  const [car, trailer] = splitTruck(t.truck || '');
  const out: Record<string, string> = {
    C9: t.loadAddr || '',                                   // місце складання
    C11: car, L11: trailer,                                 // автомобіль, причіп
    X11: 'автоперевезення',                                 // вид перевезень (як у прикладі)
    D15: carrierLine(s),                                    // автомобільний перевізник — із заявки
    U15: t.driver || '',                                    // водій
    D17: join(t.shipper, t.shipperC),                       // вантажовідправник
    D19: join(t.consignee, t.consigneeC),                   // вантажоодержувач
    D21: t.loadAddr || '', R21: t.unloadAddr || '',         // пункти навантаження й розвантаження
    U23: (t.driver || '').split(',')[0].trim(),             // отримав водій/експедитор
    B35: t.cargo || '',                                     // найменування вантажу
  };
  if (date) { out.K7 = date.d; out.N7 = MONTHS_GEN[date.m - 1] ?? ''; out.Q7 = date.y.slice(2); }
  return out;
}

/** Значення в клітинку як inline-рядок; стиль клітинки бланка зберігається. Немає клітинки — помилка (гейт ловить). */
export function setXlsxCell(sheet: string, ref: string, value: string): string {
  const re = new RegExp(`<c r="${ref}"((?:\\s+(?!t=)[\\w:]+="[^"]*")*)(?:\\s+t="[^"]*")?((?:\\s+[\\w:]+="[^"]*")*)\\s*(?:/>|>[\\s\\S]*?</c>)`);
  if (!re.test(sheet)) throw new Error(`у бланку ТТН немає клітинки ${ref}`);
  return sheet.replace(re, (_m, a: string, b: string) => `<c r="${ref}"${a}${b} t="inlineStr"><is><t xml:space="preserve">${X(value)}</t></is></c>`);
}

function rezip(src: string, patch: (name: string, data: Buffer) => Buffer): Uint8Array {
  const zip = readZip(readFileSync(src));
  const files: Array<{ name: string; data: Uint8Array }> = [];
  for (const [name, read] of zip) files.push({ name, data: patch(name, read()) });
  return zipStore(files);
}

/** Заповнений бланк 1-ТН (xlsx). */
export function buildTtn(s: DocumentState): Uint8Array {
  const cells = ttnCells(s);
  return rezip(TTN_TEMPLATE, (name, data) => {
    if (name !== 'xl/worksheets/sheet1.xml') return data;
    let x = data.toString('utf8');
    for (const [ref, v] of Object.entries(cells)) if (v) x = setXlsxCell(x, ref, v);
    return Buffer.from(x, 'utf8');
  });
}

/* ── CMR ── */

/**
 * Куди писати в CMR: клітинка-підпис графи (за початком тексту) і зсув до клітинки значення в порядку документа
 * (найглибші `w:tc`). `append` — дописати абзацом у саму клітинку (графи 25/26: окремої клітинки значення немає).
 */
interface CmrSlot { label: string; off: number; append?: true; value: (s: DocumentState) => string[] }
const cmrDate = (s: DocumentState) => { const d = firstDate(s.trip.loadDate || ''); return d ? `${d.d}/${String(d.m).padStart(2, '0')}/${d.y}` : ''; };
export const CMR_SLOTS: CmrSlot[] = [
  { label: 'Отправитель (наименование', off: 2, value: (s) => [s.trip.shipper || ''] },          // 1: назва
  { label: 'Отправитель (наименование', off: 4, value: (s) => [s.trip.loadAddr || ''] },         // 1: адреса
  { label: 'Отправитель (наименование', off: 6, value: (s) => [s.trip.shipperC || ''] },         // 1: контакт
  { label: 'Получатель (наименование', off: 3, value: (s) => [s.trip.consignee || ''] },         // 2
  { label: 'Получатель (наименование', off: 5, value: (s) => [s.trip.unloadAddr || ''] },
  { label: 'Получатель (наименование', off: 7, value: (s) => [s.trip.consigneeC || ''] },
  { label: 'Перевозчик (наименование', off: 2, value: (s) => [s.cp.name || '', s.cp.addr || '', s.cp.edrpou ? `ЄДРПОУ ${s.cp.edrpou}` : '', s.cp.phone || ''] }, // 16
  { label: 'Место разгрузки груза', off: 4, value: (s) => [s.trip.unloadAddr || ''] },           // 3: місце
  { label: 'Место и дата погрузки', off: 3, value: (s) => [s.trip.loadAddr || ''] },             // 4: місце
  { label: 'Место и дата погрузки', off: 10, value: (s) => [cmrDate(s)] },                       // 4: дата
  { label: 'Прилагаемые документы', off: 2, value: (s) => [s.dealNo ? `Заявка № ${s.dealNo}` : ''] }, // 5
  { label: 'Объём, м', off: 1, value: (s) => [s.trip.cargo || ''] },                             // 6–9: вантаж
  { label: 'Составлен в', off: 3, value: (s) => [cmrDate(s)] },                                  // 21: дата
  { label: 'Регистрац. номер', off: 0, append: true, value: (s) => [s.trip.truck || ''] },       // 25
];

const CELL = /<w:tc>(?:(?!<w:tc>)[\s\S])*?<\/w:tc>/g;
const cellText = (tc: string) => (tc.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('').trim();
// кілька рядків — в одному run через <w:br/> (поза <w:r> Word перенос ігнорує)
const RPR = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr>';
const run = (lines: string[]) => `<w:r>${RPR}${lines.map((l, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${X(l)}</w:t>`).join('')}</w:r>`;

/** Індекси клітинок значень для кожного слота (за підписом графи в бланку). Підпису немає — помилка. */
export function cmrTargets(xml: string): number[] {
  const cells = [...xml.matchAll(CELL)].map((m) => cellText(m[0]));
  return CMR_SLOTS.map((sl) => {
    const i = cells.findIndex((t) => t.startsWith(sl.label));
    if (i < 0) throw new Error(`у бланку CMR немає графи «${sl.label}»`);
    return i + sl.off;
  });
}

export function fillCmrXml(xml: string, s: DocumentState): string {
  const targets = cmrTargets(xml);
  const want = new Map<number, { lines: string[]; append?: true }>();
  CMR_SLOTS.forEach((sl, k) => { const lines = sl.value(s).filter((l) => l.trim()); if (lines.length) want.set(targets[k], { lines, append: sl.append }); });
  let i = -1;
  return xml.replace(CELL, (tc) => {
    i++;
    const w = want.get(i);
    if (!w) return tc;
    if (w.append) return tc.replace(/<\/w:tc>$/, `<w:p>${run(w.lines)}</w:p></w:tc>`);
    // перший абзац порожньої клітинки: <w:p/> або <w:p …>…</w:p>
    if (/<w:p\/>/.test(tc)) return tc.replace(/<w:p\/>/, `<w:p>${run(w.lines)}</w:p>`);
    return tc.replace(/(<w:p[ >][\s\S]*?)(<\/w:p>)/, (_m, a: string, b: string) => a + run(w.lines) + b);
  });
}

/** Заповнений бланк CMR (docx). */
export function buildCmr(s: DocumentState): Uint8Array {
  return rezip(CMR_TEMPLATE, (name, data) => (name === 'word/document.xml' ? Buffer.from(fillCmrXml(data.toString('utf8'), s), 'utf8') : data));
}
