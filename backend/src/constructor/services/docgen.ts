/**
 * Серверна збірка DOCX — порт 1:1 із затвердженого макета (v20, оформлення «Б», 15.10).
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

/* Щільність документа (рішення 14–15.10). Заявка має бути рівно на 3 сторінках:
   клієнтська стартує з d1 (10,5 пт), перевізницька — з dc (10 пт); якщо з довгими даними виходить
   4-та сторінка — крок щільніше, до d95 (9,5 пт) — це «автопідгонка» (pdfRenderer.renderDocumentPdf).
   Основний договір — dm (9,5 пт, 8 сторінок), без підгонки. Ті самі значення — у CSS (.dens-*) і в Word (W_DENS). */
export type Density = 'd1' | 'dc' | 'd95' | 'dm';
export const DENS_STEPS: Record<DocKind, Density[]> = { once: ['d1', 'dc', 'd95'], carr: ['dc', 'd95'], main: ['dm'] };
export const MAX_PAGES = 3;
/** Заголовок колонтитула «… № N · сторінка X з Y». */
export const FOOT_TITLE: Record<DocKind, string> = { once: 'Разовий договір', carr: 'Заявка-договір', main: 'Договір' };
export const densSteps = (s: { doc: DocKind }): Density[] => DENS_STEPS[s.doc] || ['d1'];

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
  /** логотип юрособи в шапці (ЮТС, АвтоМув; ФОП — немає) */
  logo?: Uint8Array;
  logoDim?: [number, number];
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
  sigB: [200, 276], sigK: [240, 205], stU: [300, 308], stA: [300, 300], logoU: [441, 330], logoA: [799, 180],
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
 * (тоді `blockers` не дає сформувати документ). Тримає `#1190`.
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
/* Оформлення «Б» (рішення 14–15.10) — порт buildDocx() макета v20 символ у символ (тест docgen.test.ts):
   шапка-таблиця [логотип · юрособа] [№ у рамці] зі смугою акценту; таблиця умов з акцентною лівою межею;
   реквізити в картках; колонтитул footer1.xml «… № · сторінка {PAGE} з {NUMPAGES}»; рамка адреси для
   оригіналів (ЮТС) у самому низу. Кеглі/інтервали — з тієї ж щільності, що PDF. */

const X = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RF = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';

/** ширина тексту, twips: A4 11906 − 2 × 624 (поля 11 мм) */
const W_TXT = 10658;
const WC = { ink: '17181C', grey: '5A5F6B', key: 'F8F5F2', line: 'D8D2CC', card: 'F8F6F4', cardLine: 'EBE5DF', band: 'E3DDD7', foot: '7C8090' };

interface WDens {
  sz: number; line: number; after: number; ind: number; bandA: number; logoU: number; h2: number; sub: number; subA: number;
  dl: number; dlA: number; h3: number; h3B: number; h3A: number; tB: number; tA: number; tk: number; tkL: number; tv: number;
  tvL: number; cV: number; cH: number; kW: number; rqB: number; rq: number; rqL: number; gap: number; cardV: number;
  cardH: number; sigB: number; hang?: number;
}
/* кеглі — півпункти, інтервали й відступи — twips (1/20 пт); ті самі значення, що в CSS .dens-* */
const W_DENS: Record<Density, WDens> = {
  d1: { sz: 21, line: 294, after: 70, ind: 640, bandA: 240, logoU: 21, h2: 30, sub: 21, subA: 200, dl: 21, dlA: 240,
    h3: 22, h3B: 160, h3A: 60, tB: 100, tA: 200, tk: 19, tkL: 256, tv: 20, tvL: 270, cV: 60, cH: 140, kW: 4476,
    rqB: 160, rq: 19, rqL: 281, gap: 280, cardV: 160, cardH: 200, sigB: 360 },
  dc: { sz: 20, line: 244, after: 30, ind: 480, bandA: 160, logoU: 19, h2: 27, sub: 19, subA: 120, dl: 19, dlA: 140,
    h3: 21, h3B: 100, h3A: 40, tB: 80, tA: 140, tk: 18, tkL: 216, tv: 19, tvL: 228, cV: 40, cH: 100, kW: 4903,
    rqB: 60, rq: 18, rqL: 230, gap: 240, cardV: 120, cardH: 180, sigB: 200 },
  d95: { sz: 19, line: 228, after: 20, ind: 480, bandA: 140, logoU: 18, h2: 26, sub: 18, subA: 100, dl: 18, dlA: 120,
    h3: 20, h3B: 80, h3A: 40, tB: 60, tA: 120, tk: 17, tkL: 200, tv: 18, tvL: 212, cV: 30, cH: 100, kW: 4903,
    rqB: 60, rq: 17, rqL: 212, gap: 240, cardV: 100, cardH: 160, sigB: 180 },
  dm: { sz: 19, line: 232, after: 30, ind: 480, bandA: 160, logoU: 19, h2: 27, sub: 19, subA: 120, dl: 19, dlA: 140,
    h3: 20, h3B: 120, h3A: 40, tB: 80, tA: 140, tk: 18, tkL: 216, tv: 19, tvL: 228, cV: 40, cH: 100, kW: 4903,
    rqB: 60, rq: 18, rqL: 230, gap: 240, cardV: 120, cardH: 180, sigB: 200, hang: 640 },
};

interface ROpts { b?: 1 | 0; color?: string; pos?: number; sz: number; bdr?: string }
const wR = (t: string, o: ROpts) => `<w:r><w:rPr>${RF}${o.b ? '<w:b/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}${o.pos ? `<w:position w:val="${o.pos}"/>` : ''}<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>${o.bdr ? `<w:bdr w:val="single" w:sz="8" w:space="1" w:color="${o.bdr}"/>` : ''}</w:rPr><w:t xml:space="preserve">${X(t)}</w:t></w:r>`;
const wTab = (sz: number) => `<w:r><w:rPr>${RF}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:tab/></w:r>`;

interface POpts {
  jc?: 'left' | 'center' | 'right' | 'both'; va?: string; before?: number; after?: number; line?: number;
  ind?: number; indL?: number; indR?: number; hang?: number; keep?: 1; bdr?: string; tabs?: string;
}
function wPa(runs: string, o: POpts = {}): string {
  const ind = (o.ind || o.indL || o.indR || o.hang) ? `<w:ind${o.indL ? ` w:left="${o.indL}"` : ''}${o.indR ? ` w:right="${o.indR}"` : ''}${o.ind ? ` w:firstLine="${o.ind}"` : ''}${o.hang ? ` w:hanging="${o.hang}"` : ''}/>` : '';
  return `<w:p><w:pPr>${o.keep ? '<w:keepNext/>' : ''}${o.bdr || ''}${o.tabs || ''}<w:spacing w:before="${o.before || 0}" w:after="${o.after || 0}"${o.line ? ` w:line="${o.line}" w:lineRule="exact"` : ''}/>${ind}<w:jc w:val="${o.jc || 'both'}"/>${o.va ? `<w:textAlignment w:val="${o.va}"/>` : ''}</w:pPr>${runs}</w:p>`;
}
/** порожній абзац точної висоти — відступ між блоками (keep — тримати з наступним) */
const wGap = (tw: number, keep?: 1) => `<w:p><w:pPr>${keep ? '<w:keepNext/>' : ''}<w:spacing w:before="0" w:after="0" w:line="${tw}" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>`;
const wMar = (tag: string, v: number, h: number) => `<w:${tag}><w:top w:w="${v}" w:type="dxa"/><w:left w:w="${h}" w:type="dxa"/><w:bottom w:w="${v}" w:type="dxa"/><w:right w:w="${h}" w:type="dxa"/></w:${tag}>`;

/** Inline-картинка DrawingML (логотип, підпис, печатка). */
function wDraw(rid: string, cx: number, cy: number, seq: number): string {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${seq}" name="img${seq}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${seq}" name="img${seq}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

/* ─────────────────────────── buildDocx ─────────────────────────── */

/** dens — щільність, з якою зібрано PDF цього документа (зберігається в constructor_documents.dens);
 *  без неї — стартова для типу документа. Так Word має ті самі кеглі й ті самі 3 (8) сторінки, що PDF. */
export function buildDocx(s: DocumentState, num: string, img: DocImages = {}, dens?: Density): Uint8Array {
  const e = ent(s);
  const acc: string = e.acc;
  const orig: string | undefined = 'orig' in e ? e.orig : undefined;
  const hasStampFile = 'stampImg' in e && !!e.stampImg;
  const { title, sub } = docTitleParts(s);
  const rows = condRows(s);
  const legal = legalBlocks(s);
  const other = partyLabel(s) === 'перевізник' ? 'ПЕРЕВІЗНИК' : 'ЗАМОВНИК';
  const mainMode = s.doc === 'main';
  const dateStr = mainMode ? (s.mainDate || '«___» ____________ 2026 р.') : docDateStr(s);
  const dn = W_DENS[dens || densSteps(s)[0]] || W_DENS.d1;
  const hasSig = s.stamp && !!img.sig;
  const hasStamp = s.stamp && !!img.stamp;
  let seq = 0;
  const draw = (rid: string, cx: number, cy: number) => wDraw(rid, cx, cy, ++seq);
  const imgRun = (rid: string, dim: [number, number], targetCm: number) => {
    const [wpx, hpx] = dim;
    const cx = Math.round(targetCm * 360000), cy = Math.round(cx * hpx / wpx);
    return draw(rid, cx, cy);
  };

  /* шапка — таблиця в один рядок: [логотип · юрособа] [№ у рамці]; зліва смуга акценту, знизу тонка лінія.
     Таблиця, а не табулятор: рамка номера біля правого табулятора в LibreOffice губить праву сторону. */
  const logoPt = img.logo ? (s.ent === 'avm' ? 17 : dn.logoU) : 0;
  const logoDim = img.logoDim || DEFAULT_IMG_DIM[s.ent === 'avm' ? 'logoA' : 'logoU'];
  const logoRun = img.logo ? draw('rIdLogo', Math.round(logoPt * 12700 * logoDim[0] / logoDim[1]), Math.round(logoPt * 12700)) : '';
  const numW = 2700;
  let body = `<w:tbl><w:tblPr><w:tblW w:w="${W_TXT}" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/>` +
      `<w:tblBorders><w:left w:val="single" w:sz="32" w:space="0" w:color="${acc}"/><w:bottom w:val="single" w:sz="6" w:space="0" w:color="${WC.band}"/></w:tblBorders>` +
      `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="200" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
      `<w:tblGrid><w:gridCol w:w="${W_TXT - numW}"/><w:gridCol w:w="${numW}"/></w:tblGrid><w:tr>` +
      `<w:tc><w:tcPr><w:tcW w:w="${W_TXT - numW}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>` +
        wPa(logoRun + wR((img.logo ? '   ' : '') + `${('docName' in e && e.docName) || e.name} · ${s.ent === 'fop' ? 'ІПН' : 'ЄДРПОУ'} ${e.edrpou} · ${e.vat}`, { b: 1, color: WC.ink, sz: 17 }),
          { jc: 'left', va: 'center' }) + `</w:tc>` +
      `<w:tc><w:tcPr><w:tcW w:w="${numW}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>` +
        wPa(wR(` № ${num} `, { b: 1, color: acc, sz: 17, bdr: acc }), { jc: 'right', indR: 40 }) + `</w:tc>` +
      `</w:tr></w:tbl>` + wGap(dn.bandA) +
    wPa(wR(`${title} № ${num}`, { b: 1, color: WC.ink, sz: dn.h2 }), { jc: 'center', after: 40 }) +
    wPa(wR(sub, { color: WC.grey, sz: dn.sub }), { jc: 'center', after: dn.subA }) +
    wPa(wR('м. Київ', { sz: dn.dl }) + wTab(dn.dl) + wR(dateStr, { sz: dn.dl }),
      { jc: 'left', after: dn.dlA, tabs: `<w:tabs><w:tab w:val="right" w:pos="${W_TXT}"/></w:tabs>` }) +
    wPa(preambleSegs(s).map(x => wR(x.t, { b: x.b, sz: dn.sz })).join(''), { line: dn.line, after: dn.after, ind: dn.ind });
  const pTxt = (t: string) => wPa(wR(t, { sz: dn.sz }), { line: dn.line, after: dn.after, ind: dn.ind });
  const h3 = (t: string, c?: 1) => wPa(wR(t, { b: 1, color: acc, sz: dn.h3 }), { jc: c ? 'center' : 'left', before: dn.h3B, after: dn.h3A, keep: 1 });

  if (mainMode) {
    /* основний договір: розділ — з тонкою лінією знизу; пункт — номер висячим стовпчиком (як у PDF) */
    const secBdr = `<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="${WC.band}"/></w:pBdr>`;
    (MAIN_BODY as ReadonlyArray<{ h?: string; n?: string; t?: string }>).forEach(b => {
      if (b.h) { body += wPa(wR(b.h, { b: 1, color: acc, sz: dn.h3 }), { jc: 'left', before: dn.h3B, after: dn.h3A, keep: 1, bdr: secBdr }); return; }
      body += wPa(wR(b.n || '', { b: 1, sz: dn.sz }) + wTab(dn.sz) + wR(mainClauseText(s, b.t || '', (MAIN_THIRD as Record<EntityKey, string>)[s.ent] || ''), { sz: dn.sz }),
        { line: dn.line, after: dn.after, indL: dn.hang || 640, hang: dn.hang || 640 });
    });
  } else {
    if (legal) body += pTxt(legal[0] as string);
    const vW = W_TXT - dn.kW;
    const tb = (side: string) => `<w:${side} w:val="single" w:sz="${side === 'left' ? 20 : 4}" w:space="0" w:color="${side === 'left' ? acc : WC.line}"/>`;
    body += h3('2. Основні умови перевезення:') + wGap(dn.tB, 1) +
      `<w:tbl><w:tblPr><w:tblW w:w="${W_TXT}" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/>` +
      `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(tb).join('')}</w:tblBorders>` +
      `<w:tblLayout w:type="fixed"/>${wMar('tblCellMar', dn.cV, dn.cH)}</w:tblPr>` +
      `<w:tblGrid><w:gridCol w:w="${dn.kW}"/><w:gridCol w:w="${vW}"/></w:tblGrid>` +
      rows.map(([k, v]) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>` +
        `<w:tc><w:tcPr><w:tcW w:w="${dn.kW}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${WC.key}"/></w:tcPr>` +
          wPa(wR(k, { color: WC.grey, sz: dn.tk }), { jc: 'left', line: dn.tkL }) + `</w:tc>` +
        `<w:tc><w:tcPr><w:tcW w:w="${vW}" w:type="dxa"/></w:tcPr>` +
          wPa(wR(v || '—', { b: 1, color: WC.ink, sz: dn.tv }), { jc: 'left', line: dn.tvL }) + `</w:tc></w:tr>`).join('') +
      `</w:tbl>` + wGap(dn.tA);
    legal!.slice(1).forEach(b => { body += (typeof b === 'object') ? h3(b.h) : pTxt(b); });
  }

  /* реквізити — у світлих картках, під ними підписи; рядки не розриваються між сторінками */
  const cw = Math.floor((W_TXT - dn.gap) / 2);
  const card = (head: string, lines: string[]) => `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/><w:tcBorders>` +
      ['top', 'left', 'bottom', 'right'].map(x => `<w:${x} w:val="single" w:sz="4" w:space="0" w:color="${WC.cardLine}"/>`).join('') +
      `</w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="${WC.card}"/>${wMar('tcMar', dn.cardV, dn.cardH)}</w:tcPr>` +
    wPa(wR(head, { b: 1, color: acc, sz: 20 }), { jc: 'left', after: 100 }) +
    lines.map((l, i) => wPa(wR(l, { b: i === 0 ? 1 : 0, sz: dn.rq }), { jc: 'left', line: dn.rqL })).join('') + `</w:tc>`;
  const gapCell = `<w:tc><w:tcPr><w:tcW w:w="${dn.gap}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`;
  const sigCell = (xml: string) => `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/></w:tcPr>${xml}</w:tc>`;
  const sp = (t: string, b?: 1) => wPa(wR(t, { b, sz: 19 }), { jc: 'left' });
  body += h3('РЕКВІЗИТИ СТОРІН', 1) + wGap(dn.rqB, 1) +
    `<w:tbl><w:tblPr><w:tblW w:w="${W_TXT}" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/><w:tblLayout w:type="fixed"/>${wMar('tblCellMar', 0, 0)}</w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="${cw}"/><w:gridCol w:w="${dn.gap}"/><w:gridCol w:w="${cw}"/></w:tblGrid>` +
    `<w:tr><w:trPr><w:cantSplit/></w:trPr>` + card(other, reqLines(s, 'their')) + gapCell + card('ЕКСПЕДИТОР', reqLines(s, 'our')) + `</w:tr>` +
    `<w:tr><w:trPr><w:cantSplit/></w:trPr>` +
      sigCell(wPa(wR('Від ' + (other === 'ПЕРЕВІЗНИК' ? 'Перевізника' : 'Замовника') + ':', { sz: 19 }), { jc: 'left', before: dn.sigB }) + sp('') +
        wPa(wR('__________________  Директор ', { sz: 19 }) + wR(s.cp.dir || '_______________', { b: 1, sz: 19 }), { jc: 'left' }) + sp('М.П.')) +
      gapCell +
      sigCell(wPa(wR('Від Експедитора:', { sz: 19 }), { jc: 'left', before: dn.sigB }) +
        ((hasSig || hasStamp)
          ? `<w:p><w:pPr><w:spacing w:before="0" w:after="40"/></w:pPr>` +
            (hasSig ? imgRun('rIdSig', img.sigDim || DEFAULT_IMG_DIM[s.ent === 'avm' ? 'sigK' : 'sigB'], 2.3) : '') +
            `<w:r><w:rPr>${RF}</w:rPr><w:t xml:space="preserve">  </w:t></w:r>` +
            (hasStamp ? imgRun('rIdSt', img.stampDim || DEFAULT_IMG_DIM[s.ent === 'avm' ? 'stA' : 'stU'], 3.0) : '') + `</w:p>`
          : sp('')) +
        wPa(wR('__________________  ' + (s.ent === 'fop' ? 'ФОП ' : 'Директор '), { sz: 19 }) + wR(e.dirShort, { b: 1, sz: 19 }), { jc: 'left' }) +
        (hasStampFile ? sp('М.П.') : '')) +
    `</w:tr></w:tbl>`;
  /* у самому низу документів ЮТС — маленька рамка з адресою для оригіналів (рішення 15.10) */
  body += orig
    ? wPa(wR('Адреса для надсилання оригіналів документів: ', { b: 1, color: acc, sz: 17 }) + wR(orig, { color: WC.ink, sz: 17 }),
        { jc: 'left', before: 160, line: 230, indL: 120, indR: 120,
          bdr: '<w:pBdr>' + ['top', 'left', 'bottom', 'right'].map(x =>
            `<w:${x} w:val="single" w:sz="6" w:space="${x === 'top' || x === 'bottom' ? 3 : 5}" w:color="${acc}"/>`).join('') + '</w:pBdr>' })
    : wGap(20);                           // Word вимагає абзац після таблиці — мінімальний, щоб не створив зайву сторінку
  body += `<w:sectPr><w:footerReference w:type="default" r:id="rIdFtr"/><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="567" w:right="624" w:bottom="850" w:left="624" w:header="284" w:footer="340" w:gutter="0"/></w:sectPr>`;

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;
  const fr = (t: string) => `<w:r><w:rPr>${RF}<w:color w:val="${WC.foot}"/><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr><w:t xml:space="preserve">${X(t)}</w:t></w:r>`;
  const fld = (instr: string) => `<w:fldSimple w:instr=" ${instr} ">${fr('1')}</w:fldSimple>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${W_TXT}"/></w:tabs><w:spacing w:before="0" w:after="0"/></w:pPr>${fr((FOOT_TITLE[s.doc] || 'Договір') + ' № ' + num)}${wTab(12)}${fr('сторінка ')}${fld('PAGE')}${fr(' з ')}${fld('NUMPAGES')}</w:p></w:ftr>`;

  const files: Array<{ name: string; data: string | Uint8Array }> = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
  ];
  let rels = '<Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';
  if (img.logo) {
    files.push({ name: 'word/media/logo.png', data: img.logo });
    rels += '<Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>';
  }
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
  files.push({ name: 'word/footer1.xml', data: footer });
  return zipStore(files);
}
