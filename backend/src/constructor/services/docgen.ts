/**
 * Серверна збірка DOCX — порт 1:1 із затвердженого макета (v15).
 *
 * Нуль залежностей: власний zip-writer (stored, без компресії) + WordprocessingML
 * руками. Так зроблено свідомо: макет генерує документ саме цим кодом, тож
 * сервер видає БАЙТ-У-БАЙТ ту саму структуру, яку Сергій затвердив очима.
 * Не міняти на бібліотеку docx без пере-затвердження вигляду.
 *
 * Вхід — знімок стану форми (DocumentState) + картинки підпису/печатки Buffer'ами
 * (читаються з assets/ викликачем; у макеті вони base64 в IMG).
 */

import { ENTITIES } from '../data/entities.js';
import { LEGAL, MAIN_BODY, MAIN_THIRD } from '../data/legalTexts.js';

/* ─────────────────────────── Типи ─────────────────────────── */

export type EntityKey = 'uts' | 'avm' | 'fop';
export type DocKind = 'once' | 'main' | 'carr';
export type Party = 'client' | 'carrier';

export interface Counterparty {
  name?: string; edrpou?: string; ipn?: string; addr?: string;
  iban?: string; bank?: string; phone?: string; email?: string; dir?: string;
}

export interface DocumentState {
  ent: EntityKey;
  doc: DocKind;              // 'carr' завжди party='carrier'; 'once'/'main' — 'client'
  party: Party;
  intl: boolean;
  stamp: boolean;            // авто-підпис і печатка
  fopAcc: number;            // індекс рахунку ФОП (0 = Приват)
  cp: Counterparty;
  trip: Record<string, string>;
  pay: { sum: string; cur: string; form: string; order: string };
  dealNo: string;            // № заявки = ID угоди в Kommo (вручну, обов'язково)
  docDate: string;           // 'YYYY-MM-DD' або '' (тоді сьогодні)
  mainNo: string;
  mainDate: string;
  /** «Діє до» основного договору, ДД.ММ.РРРР; порожньо = 31 грудня року дати договору (Роман, 01.10.2026). */
  mainUntil?: string;
  manager: { name: string; phone: string };  // з профілю користувача дашборда
}

export interface DocImages {
  /** PNG байти (прозорий фон); відсутність = не вставляти (ФОП без печатки, вимкнений перемикач) */
  sig?: Uint8Array;
  stamp?: Uint8Array;
  /** природні розміри в пікселях — для правильних пропорцій у Word */
  sigDim?: [number, number];
  stampDim?: [number, number];
}

/* Розміри вшитих картинок макета (px). Якщо Роман замінить файли в assets/ —
   передати реальні розміри через DocImages, інакше пропорції попливуть. */
export const DEFAULT_IMG_DIM: Record<string, [number, number]> = {
  sigB: [200, 276], sigK: [240, 205], stU: [300, 308], stA: [300, 300],
};

/* ──────────────────── Довідкові збирачі контенту ────────────────────
   Порт condRows/preambleSegs/reqLines/legalBlocks/docTitleParts з макета.
   Використовуються і в docx (тут), і в printTemplate.ts (PDF/прев'ю). */

export interface Seg { t: string; b?: 1 }

const ent = (s: DocumentState) => ENTITIES[s.ent];
const partyLabel = (s: DocumentState) => (s.doc === 'carr' ? 'перевізник' : 'клієнт');

export function docTitleParts(s: DocumentState): { title: string; sub: string } {
  const title = s.doc === 'main' ? 'ДОГОВІР' : (s.doc === 'carr' ? 'ЗАЯВКА-ДОГОВІР' : 'РАЗОВИЙ ДОГОВІР');
  const sub = s.doc === 'main' ? 'про надання транспортно-експедиторських послуг'
            : (s.doc === 'carr' ? 'перевезення вантажу автомобільним транспортом' : 'на організацію перевезення вантажу');
  return { title, sub };
}

export function docDateStr(s: DocumentState, now = new Date()): string {
  if (s.docDate) {
    const [y, m, d] = s.docDate.split('-');
    return `${d}.${m}.${y}`;
  }
  return String(now.getDate()).padStart(2, '0') + '.' + String(now.getMonth() + 1).padStart(2, '0') + '.' + now.getFullYear();
}

const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/** ДД.ММ.РРРР → [д, м, р] лише для справжньої календарної дати (31.02 — ні). */
function parseDmy(v: string): [number, number, number] | null {
  const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(v);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [d, mo, y] : null;
}

/**
 * 📅 СТРОК ДІЇ ОСНОВНОГО ДОГОВОРУ (п. 8.1, рішення Романа 01.10.2026). У шаблоні було зашито «до 31 грудня
 * 2024 року» — кожен договір виходив би з минулим строком. Тепер: введене «Діє до» (ДД.ММ.РРРР), а порожнє —
 * 31 грудня року дати договору (п. 8.3 однаково поновлює договір щороку). `null` — строку не визначити
 * (тоді `blockers` не дає сформувати документ). Тримає `#1172`.
 */
export function mainUntilText(s: DocumentState): string | null {
  const raw = (s.mainUntil ?? '').trim();
  if (raw) {
    const p = parseDmy(raw);
    return p ? `${p[0]} ${MONTHS_GEN[p[1] - 1]} ${p[2]}` : null;
  }
  const y = /(?:^|\D)(\d{4})(?:\D|$)/.exec(s.mainDate || '');
  return y ? `31 грудня ${y[1]}` : null;
}

/** Текст пункту основного договору з підставленими мітками (спільне для Word і PDF). */
export function mainClauseText(s: DocumentState, t: string, third: string): string {
  return t.replace('@THIRD@', third).replace('@UNTIL@', mainUntilText(s) ?? '«___» ____________ 20__');
}

export function currentNum(s: DocumentState): string {
  return s.doc === 'main' ? (s.mainNo || '') : (s.dealNo || '');
}

/** Рядки таблиці «Основні умови перевезення» — різні для клієнта й перевізника (рішення 30.09). */
export function condRows(s: DocumentState): Array<[string, string]> {
  const t = s.trip, carrier = s.party === 'carrier';
  const e = ent(s);
  const pay = s.pay.sum ? `${s.pay.sum} ${s.pay.cur}${s.ent === 'fop' ? ', СОФТ платіж' : ' · ' + s.pay.form}` : '';
  const me = s.manager.name + ', ' + s.manager.phone;
  const intl: Array<[string, string]> = s.intl ? [
    ['Адреса замитнення, контактна особа', t.custAddr || ''],
    ['Пункт переходу кордону', t.border || ''],
    ['Адреса розмитнення, контактна особа', t.decustAddr || '']] : [];
  if (carrier) return [
    ['Маршрут перевезення', t.route || ''],
    ['Найменування та кількість вантажу', t.cargo || ''],
    ['Вантажовідправник', t.shipper || ''],
    ['Контактна особа, номер телефону', t.shipperC || ''],
    ['Адреса завантаження', t.loadAddr || ''],
    ['Дата, час навантаження', t.loadDate || ''],
    ...intl,
    ['Адреси розвантаження', t.unloadAddr || ''],
    ['Дата, час доставки', t.unloadDate || ''],
    ['Вимоги до перевезення вантажу та/або транспортного засобу', t.reqs || ''],
    ['Транспортний засіб: марка, модель, тип, реєстраційні номери авто і причепа', t.truck || ''],
    ['Дані водія: ПІБ, номер посвідчення, телефон', t.driver || ''],
    ['Відповідальна особа Експедитора, телефон', me],
    ['Відповідальна особа Перевізника, телефон', t.otherResp || ''],
    ['Плата за перевезення', pay],
    ['Порядок і строки оплати', s.pay.order || ''],
    ['Нормативний простій', e.dwell],
    ['Додаткові умови', t.extra || ''],
  ];
  return [
    ['Вид перевезення', s.intl ? 'Міжнародне автоперевезення' : 'Автоперевезення'],
    ['Маршрут перевезення', t.route || ''],
    ['Найменування та кількість вантажу, пакування', t.cargo || ''],
    ['Кількість вантажних місць, габарити Д×Ш×В', t.places || ''],
    ['Особливі умови перевезення (температурний режим, крихкий вантаж, обмеження штабелювання тощо)', t.special || ''],
    ['Вантажовідправник', t.shipper || ''],
    ['Контактна особа, номер телефону', t.shipperC || ''],
    ['Адреса завантаження', t.loadAddr || ''],
    ['Дата, час навантаження', t.loadDate || ''],
    ...intl,
    ['Вантажоодержувач', t.consignee || ''],
    ['Контактна особа, номер телефону', t.consigneeC || ''],
    ['Адреси розвантаження', t.unloadAddr || ''],
    ['Дата, час доставки', t.unloadDate || ''],
    ['Вимоги до транспортного засобу', t.reqs || ''],
    ['Транспортний засіб: марка, модель, тип, реєстраційні номери авто і причепа', t.truck || ''],
    ['Дані водія: ПІБ, номер посвідчення, телефон', t.driver || ''],
    ['Відповідальна особа Замовника, телефон', t.otherResp || ''],
    ['Відповідальна особа Експедитора, телефон', me],
    ['Загальна ціна послуг', pay],
    ['Порядок і строки оплати', s.pay.order || ''],
    ['Нормативний простій', e.dwell],
    ['Додаткові умови', t.extra || ''],
  ];
}

/** Юртекст: перевізницький — один на всі юрособи; клієнтський — з @FINES@ по юрособі; основний — MAIN_BODY окремо. */
export function legalBlocks(s: DocumentState): Array<string | { h: string }> | null {
  if (s.doc === 'carr') return [LEGAL.carrIntro, ...LEGAL.carrBody];
  if (s.doc === 'once') return [LEGAL.onceIntro,
    ...LEGAL.onceBody.map((x: string | { h: string }) =>
      x === '@FINES@' ? (LEGAL.onceFines as Record<EntityKey, string>)[s.ent] : x)];
  return null;
}

/* Форми назв (рішення 08.10, «зверху повна — внизу скорочена»): у преамбулі
   організаційна форма контрагента розгортається, у реквізитах — скорочується.
   Власна назва в лапках не чіпається. Лукахед замість \b — межі слів у JS
   не бачать кирилиці. */
const ORG_EXPAND: Array<[RegExp, string]> = [
  [/^ТОВ(?=[\s«"'])/i, 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ'],
  [/^ТзОВ(?=[\s«"'])/i, 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ'],
  [/^ТДВ(?=[\s«"'])/i, 'ТОВАРИСТВО З ДОДАТКОВОЮ ВІДПОВІДАЛЬНІСТЮ'],
  [/^ПрАТ(?=[\s«"'])/i, 'ПРИВАТНЕ АКЦІОНЕРНЕ ТОВАРИСТВО'],
  [/^ПРАТ(?=[\s«"'])/i, 'ПРИВАТНЕ АКЦІОНЕРНЕ ТОВАРИСТВО'],
  [/^ПАТ(?=[\s«"'])/i, 'ПУБЛІЧНЕ АКЦІОНЕРНЕ ТОВАРИСТВО'],
  [/^ПП(?=[\s«"'])/i, 'ПРИВАТНЕ ПІДПРИЄМСТВО'],
  [/^АТ(?=[\s«"'])/i, 'АКЦІОНЕРНЕ ТОВАРИСТВО'],
  [/^ФОП(?=\s)/i, 'ФІЗИЧНА ОСОБА-ПІДПРИЄМЕЦЬ'],
];
const ORG_SHORT: Array<[RegExp, string]> = [
  [/^ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ(?=[\s«"'])/i, 'ТОВ'],
  [/^ТОВАРИСТВО З ДОДАТКОВОЮ ВІДПОВІДАЛЬНІСТЮ(?=[\s«"'])/i, 'ТДВ'],
  [/^ПРИВАТНЕ АКЦІОНЕРНЕ ТОВАРИСТВО(?=[\s«"'])/i, 'ПрАТ'],
  [/^ПУБЛІЧНЕ АКЦІОНЕРНЕ ТОВАРИСТВО(?=[\s«"'])/i, 'ПАТ'],
  [/^ПРИВАТНЕ ПІДПРИЄМСТВО(?=[\s«"'])/i, 'ПП'],
  [/^АКЦІОНЕРНЕ ТОВАРИСТВО(?=[\s«"'])/i, 'АТ'],
  [/^ФІЗИЧНА ОСОБА[\s–—-]ПІДПРИЄМЕЦЬ(?=\s)/i, 'ФОП'],
];
export function expandOrgName(n: string): string {
  for (const [re, full] of ORG_EXPAND) if (re.test(n)) return n.replace(re, full);
  return n;
}
export function shortOrgName(n: string): string {
  for (const [re, ab] of ORG_SHORT) if (re.test(n)) return n.replace(re, ab);
  return n;
}

/** Преамбула сегментами {t, b}: назви компаній і ПІБ директорів жирні (рішення 08.10). */
export function preambleSegs(s: DocumentState): Seg[] {
  const e = ent(s), c = s.cp;
  const cn = c.name || '____________________', cd = c.dir || '____________________';
  const our: Seg[] = s.ent === 'fop'
    ? [{ t: e.full, b: 1 }, { t: ', далі — Експедитор, який діє на підставі виписки з Єдиного державного реєстру' }]
    : [{ t: e.full, b: 1 }, { t: ', далі — Експедитор, в особі директора ' }, { t: e.dir, b: 1 }, { t: ', який діє на підставі Статуту' }];
  const their = (role: string): Seg[] => /^ФОП/i.test(cn)
    ? [{ t: expandOrgName(cn), b: 1 }, { t: ', далі — ' + role + ', який діє на підставі виписки з Єдиного державного реєстру' }]
    : [{ t: expandOrgName(cn), b: 1 }, { t: ', далі — ' + role + ', в особі директора ' }, { t: cd, b: 1 }, { t: ', який діє на підставі Статуту' }];
  const tail: Seg = { t: ', з іншої сторони, разом надалі іменуються Сторони, уклали цей Договір про наступне:' };
  return partyLabel(s) === 'перевізник'
    ? [...our, { t: ', з однієї сторони, та ' }, ...their('Перевізник'), tail]
    : [...their('Замовник'), { t: ', з однієї сторони, та ' }, ...our, tail];
}

/** Рядки реквізитів у дві колонки; перший рядок (назва) — жирний в обох форматах. */
export function reqLines(s: DocumentState, side: 'our' | 'their'): string[] {
  const e = ent(s), c = s.cp;
  if (side === 'our') {
    const L: string[] = [('docName' in e && e.docName) || e.name];
    if (e.addr) L.push('Місцезнаходження: ' + e.addr);
    L.push((s.ent === 'fop' ? 'ІПН ' : 'Ідентифікаційний код в ЄДРПОУ ') + e.edrpou);
    if (e.ipn !== '—') L.push('ІПН ' + e.ipn);
    const acc = 'accounts' in e && e.accounts ? e.accounts[s.fopAcc] : null;
    L.push('п/р ' + (acc ? acc[1] : e.iban));
    L.push('в ' + (acc ? acc[0] : e.bank));
    L.push('Телефон: ' + e.phone, 'Email: ' + e.email, e.tax);
    return L;
  }
  const L: string[] = [c.name ? shortOrgName(c.name) : '—'];
  if (c.addr) L.push('Місцезнаходження: ' + c.addr);
  if (c.edrpou) L.push('Ідентифікаційний код в ЄДРПОУ ' + c.edrpou);
  if (c.ipn) L.push('ІПН ' + c.ipn);
  if (c.iban) L.push('п/р ' + c.iban);
  if (c.bank) L.push('в ' + c.bank);
  if (c.phone) L.push('Телефон: ' + c.phone);
  if (c.email) L.push('Email: ' + c.email);
  return L;
}

/** Гейти формування — ті самі повідомлення, що в макеті (показувати менеджеру як є). */
export function blockers(s: DocumentState): string | null {
  const fopConflict = s.ent === 'fop' && s.party === 'client' && !!s.cp.name && !/^ФОП/i.test(s.cp.name);
  if (fopConflict) return 'Від ФОП Беспятчука клієнтом може бути лише інший ФОП — для цього контрагента оберіть ЮТС або АвтоМув.';
  if (s.party === 'carrier' && s.doc === 'carr' && !s.cp.iban) return 'Немає IBAN перевізника — оплата йде на його рахунок, без нього заявка не формується.';
  if (s.doc === 'main' && !s.mainNo) return 'Вкажіть номер основного договору — він вноситься вручну після погодження.';
  if (s.doc === 'main' && !s.mainDate) return 'Вкажіть дату, з якої діє основний договір.';
  if (s.doc === 'main' && (s.mainUntil ?? '').trim() && !mainUntilText(s)) return '«Діє до» — дата у форматі ДД.ММ.РРРР, напр. 31.12.2026.';
  if (s.doc === 'main' && !mainUntilText(s)) return 'Вкажіть «Діє до» або дату договору з роком — інакше строк дії договору (п. 8.1) не визначити.';
  if (s.doc !== 'main' && !s.dealNo) return 'Вкажіть № заявки — це ID угоди в СРМ, поле обов\'язкове.';
  return null;
}

/* ─────────────────────────── ZIP (stored) ─────────────────────────── */

const CRC_T = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function zipStore(files: Array<{ name: string; data: string | Uint8Array }>): Uint8Array {
  const enc = new TextEncoder(); const parts: Uint8Array[] = [];
  const cdir: Array<{ name: Uint8Array; crc: number; size: number; off: number }> = [];
  let off = 0;
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  files.forEach(f => {
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const head = new Uint8Array([0x50, 0x4B, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    parts.push(head, name, data);
    cdir.push({ name, crc, size: data.length, off });
    off += head.length + name.length + data.length;
  });
  const cdOff = off; let cdLen = 0;
  cdir.forEach(c => {
    const rec = new Uint8Array([0x50, 0x4B, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(c.off)]);
    parts.push(rec, c.name); cdLen += rec.length + c.name.length;
  });
  parts.push(new Uint8Array([0x50, 0x4B, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(cdLen), ...u32(cdOff), ...u16(0)]));
  const total = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(total);
  let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; });
  return out;
}

/* ──────────────────────── WordprocessingML ──────────────────────── */

const X = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RF = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';

interface POpts { c?: 1; b?: 1; sp?: false; sz?: number }

const wP = (t: string, o: POpts = {}) =>
  `<w:p><w:pPr>${o.c ? '<w:jc w:val="center"/>' : '<w:jc w:val="both"/>'}${o.sp !== false ? '<w:spacing w:after="120"/>' : ''}</w:pPr><w:r><w:rPr>${RF}${o.b ? '<w:b/>' : ''}<w:sz w:val="${o.sz || 22}"/></w:rPr><w:t xml:space="preserve">${X(t)}</w:t></w:r></w:p>`;

/** Абзац із кількох ранів — для жирних назв/ПІБ усередині речення. */
const wPRich = (segs: Seg[], o: POpts = {}) =>
  `<w:p><w:pPr>${o.c ? '<w:jc w:val="center"/>' : '<w:jc w:val="both"/>'}${o.sp !== false ? '<w:spacing w:after="120"/>' : ''}</w:pPr>` +
  segs.map(x => `<w:r><w:rPr>${RF}${x.b ? '<w:b/>' : ''}<w:sz w:val="${o.sz || 22}"/></w:rPr><w:t xml:space="preserve">${X(x.t)}</w:t></w:r>`).join('') + `</w:p>`;

function wCell(txts: string | string[], w: number, opts: { shade?: 1; b?: 1 } = {}): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${opts.shade ? '<w:shd w:val="clear" w:fill="F4F2F0"/>' : ''}</w:tcPr>` +
    (Array.isArray(txts) ? txts : [txts]).map(t => wP(t, { sp: false, sz: 20, b: opts.b })).join('') + `</w:tc>`;
}

const wCellRaw = (xml: string, w: number) =>
  `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${xml}</w:tc>`;

/** Inline-картинка (підпис/печатка) у спільному абзаці — щоб стояли ПОРУЧ (рішення 07.10). */
function wImgRun(rid: string, dim: [number, number], targetCm: number, seq: number): string {
  const [wpx, hpx] = dim;
  const cx = Math.round(targetCm * 360000), cy = Math.round(cx * hpx / wpx);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${seq}" name="img${seq}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${seq}" name="img${seq}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

/* ─────────────────────────── buildDocx ─────────────────────────── */

export function buildDocx(s: DocumentState, num: string, img: DocImages = {}): Uint8Array {
  const e = ent(s);
  const { title, sub } = docTitleParts(s);
  const rows = condRows(s);
  const legal = legalBlocks(s);
  const other = partyLabel(s) === 'перевізник' ? 'ПЕРЕВІЗНИК' : 'ЗАМОВНИК';
  const B = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(x => `<w:${x} w:val="single" w:sz="6" w:color="444444"/>`).join('') + '</w:tblBorders>';
  const mainMode = s.doc === 'main';
  const dateStr = mainMode ? (s.mainDate || '«___» ____________ 2026 р.') : docDateStr(s);
  const hasSig = s.stamp && !!img.sig;
  const hasStamp = s.stamp && !!img.stamp;
  let seq = 0;

  let body = wP(`UTS · ${('docName' in e && e.docName) || e.name} · ${s.ent === 'fop' ? 'ІПН' : 'ЄДРПОУ'} ${e.edrpou} · ${e.vat}`, { c: 1, b: 1, sz: 16 }) +
    wP(`${title} № ${num}`, { c: 1, b: 1, sz: 28 }) + wP(sub, { c: 1 }) +
    `<w:tbl><w:tblPr><w:tblW w:w="9800" w:type="dxa"/></w:tblPr><w:tr>` +
    wCell('м. Київ', 4900) + wCell(dateStr, 4900) + `</w:tr></w:tbl>` + wP('', { sp: false }) +
    wPRich(preambleSegs(s));

  if (mainMode) {
    (MAIN_BODY as ReadonlyArray<{ h?: string; n?: string; t?: string }>).forEach(b => {
      if (b.h) { body += wP(b.h, { c: 1, b: 1 }); return; }
      body += wP(b.n + ' ' + mainClauseText(s, b.t || '', (MAIN_THIRD as Record<EntityKey, string>)[s.ent] || ''));
    });
  } else {
    body += (legal ? wP(legal[0] as string) : '') +
      wP('2. Основні умови перевезення:', { b: 1 }) +
      `<w:tbl><w:tblPr><w:tblW w:w="9800" w:type="dxa"/>${B}</w:tblPr>` +
      rows.map(([k, v]) => `<w:tr>${wCell(k, 4100, { shade: 1 })}${wCell(v || '—', 5700, { b: 1 })}</w:tr>`).join('') + `</w:tbl>` + wP('', { sp: false });
    legal!.slice(1).forEach(b => { body += (typeof b === 'object') ? wP(b.h, { b: 1 }) : wP(b); });
  }

  body += wP('РЕКВІЗИТИ СТОРІН', { c: 1, b: 1 }) +
    `<w:tbl><w:tblPr><w:tblW w:w="9800" w:type="dxa"/></w:tblPr><w:tr>` +
    wCellRaw([other, ...reqLines(s, 'their')].map((t, i) => wP(t, { sp: false, sz: 20, b: i < 2 ? 1 : undefined })).join(''), 4900) +
    wCellRaw(['ЕКСПЕДИТОР', ...reqLines(s, 'our')].map((t, i) => wP(t, { sp: false, sz: 20, b: i < 2 ? 1 : undefined })).join(''), 4900) +
    `</w:tr><w:tr>` +
    wCellRaw(
      wP('', { sp: false, sz: 20 }) + wP('Від ' + (other === 'ПЕРЕВІЗНИК' ? 'Перевізника' : 'Замовника') + ':', { sp: false, sz: 20 }) +
      wP('', { sp: false, sz: 20 }) +
      wPRich([{ t: '__________________  Директор ' }, { t: (s.cp.dir || '_______________'), b: 1 }], { sp: false, sz: 20 }) +
      wP('М.П.', { sp: false, sz: 20 })
      , 4900) +
    wCellRaw(
      wP('', { sp: false, sz: 20 }) + wP('Від Експедитора:', { sp: false, sz: 20 }) +
      (hasSig || hasStamp
        ? `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr>` +
          (hasSig ? wImgRun('rIdSig', img.sigDim || DEFAULT_IMG_DIM[s.ent === 'avm' ? 'sigK' : 'sigB'], 2.3, ++seq) : '') +
          `<w:r><w:rPr>${RF}</w:rPr><w:t xml:space="preserve">  </w:t></w:r>` +
          (hasStamp ? wImgRun('rIdSt', img.stampDim || DEFAULT_IMG_DIM[s.ent === 'avm' ? 'stA' : 'stU'], 3.0, ++seq) : '') +
          `</w:p>`
        : wP('', { sp: false, sz: 20 })) +
      wPRich([{ t: '__________________  ' + (s.ent === 'fop' ? 'ФОП ' : 'Директор ') }, { t: e.dirShort, b: 1 }], { sp: false, sz: 20 })
      , 4900) +
    `</w:tr></w:tbl>` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="850" w:bottom="900" w:left="850"/></w:sectPr>`;

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;

  const files: Array<{ name: string; data: string | Uint8Array }> = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
  ];
  let rels = '';
  if (hasSig) {
    files.push({ name: 'word/media/sig.png', data: img.sig! });
    rels += '<Relationship Id="rIdSig" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/sig.png"/>';
  }
  if (hasStamp) {
    files.push({ name: 'word/media/stamp.png', data: img.stamp! });
    rels += '<Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/stamp.png"/>';
  }
  files.push({ name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` });
  files.push({ name: 'word/document.xml', data: doc });
  return zipStore(files);
}
