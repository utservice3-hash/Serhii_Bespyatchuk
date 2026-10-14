/**
 * 🌍 ДОКУМЕНТИ ДЛЯ НЕРЕЗИДЕНТА (задачі 5144 / 5284 / 5463, 14.10.2026): договір транспортного експедирування UA | EN
 * у дві колонки і заявка на рейс (спершу українська частина, потім англійська) — лише від ТОВ «АвтоМув».
 *
 * Стиль — той самий конструктор («Б»: шапка з логотипом, таблиця умов, картки реквізитів, підписи); нового вигляду
 * немає, лише дві колонки договору (`NR_CSS`, підключається ТІЛЬКИ для цих документів — CSS макета `docCss.ts`
 * не чіпається). Текст договору — `data/nonresidentTexts.ts` (1:1 з Word-шаблону).
 *
 * Що змінює менеджер (вказівки Nana 14.10): у договорі — назва клієнта, директор, номер, дата, «діє до» (п. 6.1),
 * реквізити; у заявці — номер і дата договору підтягуються з договору. Англійську частину заявки менеджер вписує
 * сам (рішення Романа 14.10: перекладу/транслітерації автоматом немає); порожнє англійське поле → те саме значення,
 * що в українській частині (дати, телефони, номери авто не перекладаються).
 */
import { ENTITIES } from '../data/entities.js';
import { NR_BODY } from '../data/nonresidentTexts.js';
import type { DocumentState } from './docgen.js';

export const isNr = (s: { doc: string }) => s.doc === 'nrmain' || s.doc === 'nrapp';

const MONTHS_UA = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
const isoOk = (v: string | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const parts = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; };
/** «23» вересня 2026 */
export const dateUa = (iso: string) => { const { y, m, d } = parts(iso); return `«${String(d).padStart(2, '0')}» ${MONTHS_UA[m - 1]} ${y}`; };
/** 23 September 2026 */
export const dateEn = (iso: string) => { const { y, m, d } = parts(iso); return `${d} ${MONTHS_EN[m - 1]} ${y}`; };
/** September 23, 2026 — як у преамбулі шаблону */
const dateEnUs = (iso: string) => { const { y, m, d } = parts(iso); return `${MONTHS_EN[m - 1]} ${d}, ${y}`; };

/** Дата договору (nrmain) / заявки (nrapp): з календарика, інакше сьогодні. */
export const nrDocIso = (s: DocumentState) => (isoOk(s.docDate) ? s.docDate : todayIso());

/** Номер договору за замовчуванням — «EUR/ДД/ММ/РРРР» з дати договору (як EUR/23/09/2026 у шаблоні). */
export function nrAutoNo(iso: string): string {
  const { y, m, d } = parts(iso);
  return `EUR/${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}
export const nrContractNo = (s: DocumentState) => (s.mainNo || '').trim() || nrAutoNo(nrDocIso(s));

/** «Діє до» (п. 6.1, Nana 14.10): введене ДД.ММ.РРРР, інакше 31.12 року дати договору; невалідне → null. */
export function nrUntil(s: DocumentState): string | null {
  const raw = (s.mainUntil || '').trim();
  if (!raw) return `31.12.${parts(nrDocIso(s)).y}`;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
  if (!m) return null;
  const t = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return t.getUTCDate() === +m[1] && t.getUTCMonth() === +m[2] - 1 ? raw : null;
}

/** Ліміт заборгованості (п. 4.7), EUR; за замовчуванням 0 — як у шаблоні. */
export const nrLimit = (s: DocumentState) => ((s.trip?.limit || '').trim() || '0');

const blank = (v: string | undefined, n = 20) => ((v || '').trim() || '_'.repeat(n));

/* ── Договір ── */

export interface Bi { ua: string[]; en: string[]; h?: 1 }

/** Шапка договору/заявки: назва, підзаголовок, місто й дата обома мовами. */
export function nrHead(s: DocumentState) {
  if (s.doc === 'nrmain') {
    const no = nrContractNo(s), iso = nrDocIso(s);
    return { title: `ДОГОВІР № ${no}`, titleEn: `FORWARDING AGREEMENT No. ${no}`,
      sub: 'транспортного експедирування', subEn: 'freight forwarding',
      city: 'Україна, м. Київ', cityEn: 'Ukraine, Kyiv', date: `${dateUa(iso)} р.`, dateEn: dateEn(iso), appendix: null as null | { ua: string; en: string } };
  }
  const iso = nrDocIso(s), cIso = isoOk(s.mainDate) ? s.mainDate : '';
  return { title: `ЗАЯВКА № ${s.dealNo || '______'}`, titleEn: `APPLICATION No. ${s.dealNo || '______'}`,
    sub: 'на міжнародне перевезення вантажу автомобільним транспортом', subEn: 'for the international carriage of goods by road',
    city: 'м. Київ', cityEn: 'Kyiv', date: iso.split('-').reverse().join('.'), dateEn: iso.split('-').reverse().join('.'),
    appendix: {
      ua: `Додаток до Договору № ${blank(s.mainNo, 14)} від ${cIso ? dateUa(cIso) + ' р.' : '«___» ____________ 20__ р.'}`,
      en: `Appendix to Contract No. ${blank(s.mainNo, 14)} dated ${cIso ? dateEn(cIso) : '______________'}`,
    } };
}

/** Преамбула — як у шаблоні; змінні: назва клієнта, законодавство країни, директор, номер і дата. */
export function nrPreamble(s: DocumentState): Bi {
  const c = s.cp, no = nrContractNo(s), iso = nrDocIso(s);
  const name = blank(c.name), dir = blank(c.dir), law = blank(c.lawUa, 12), lawEn = blank(c.lawEn, 12);
  return {
    ua: [`ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ «АВТОМУВ», зареєстроване та діє відповідно до законодавства України, надалі — «Експедитор», в особі директора Ковтонюк Тетяни Миколаївни, яка діє на підставі Статуту, з однієї сторони, та ${name}, зареєстроване та діє відповідно до законодавства ${law}, надалі — «Замовник», в особі директора ${dir}, яке діє на підставі Статуту, з іншої сторони, разом надалі іменовані «Сторони», а кожна окремо — «Сторона», уклали цей Договір транспортного експедирування № ${no} від ${dateUa(iso)} року (надалі — «Договір») про наступне:`],
    en: [`LIMITED LIABILITY COMPANY "AVTOMUV", registered and acting in accordance with the legislation of Ukraine (hereinafter — the "Forwarder"), represented by its Director Tetiana M. Kovtoniuk acting on the basis of the Charter, on the one hand, and ${name}, duly registered and operating in accordance with the laws of ${lawEn}, hereinafter referred to as the “Customer”, represented by its Director, ${dir}, acting pursuant to the Charter, on the other hand, collectively hereinafter referred to as the “Parties”, and each individually as a “Party”, have entered into this Freight Forwarding Agreement No. ${no} dated ${dateEnUs(iso)} (hereinafter referred to as the “Agreement”) as follows:`],
  };
}

/** Розділи 1–8 з підставленими мітками (@LIMIT@, @UNTIL@, @EMAIL_OUR@, @EMAIL_CP@). */
export function nrClauses(s: DocumentState): Bi[] {
  const fill = (t: string) => t.replace(/@LIMIT@/g, nrLimit(s)).replace(/@UNTIL@/g, nrUntil(s) ?? '__.__.____')
    .replace(/@EMAIL_OUR@/g, ENTITIES.avm.email).replace(/@EMAIL_CP@/g, blank(s.cp.email, 16));
  return NR_BODY.map((b) => ({ ...(b.h ? { h: 1 as const } : {}), ua: b.ua.map(fill), en: b.en.map(fill) }));
}

/** Реквізити АвтоМув для нерезидента — з Word-шаблону (валютний рахунок, SWIFT, банки-кореспонденти). */
const AVM_REQ: Array<[string, string]> = [
  ['ТОВ «АВТОМУВ»', 'LLC "AVTOMUV"'],
  ['Код ЄДРПОУ: 45618360', 'Registration No.: 45618360'],
  ['Адреса: 03187, м. Київ, вул. Полярна, 10Н', 'Address: 10H Poliarna str., Kyiv, 03187, Ukraine'],
  ['IBAN: UA073052990000026007005024731', 'IBAN: UA073052990000026007005024731'],
  ['Банк: АТ КБ «ПРИВАТБАНК», вул. Грушевського, 1Д, м. Київ, 01001, Україна', 'Bank: JSC CB "PRIVATBANK", 1D Hrushevskoho str., Kyiv, 01001, Ukraine'],
  ['SWIFT банку: PBANUA2X', 'Bank SWIFT: PBANUA2X'],
  ['Банки-кореспонденти: рах. 400886700401, SWIFT COBADEFF, Commerzbank AG, Frankfurt am Main, Germany; або рах. 6231605145, SWIFT CHASDEFX, J.P. Morgan AG, Frankfurt am Main, Germany',
    'Correspondent banks: acc. 400886700401, SWIFT COBADEFF, Commerzbank AG, Frankfurt am Main, Germany; or acc. 6231605145, SWIFT CHASDEFX, J.P. Morgan AG, Frankfurt am Main, Germany'],
];

/** Картки реквізитів: [заголовок UA / EN, рядки]. Перший рядок — назва (жирна). */
export function nrReq(s: DocumentState): { cp: { head: string; lines: string[] }; our: { head: string; lines: string[] } } {
  const c = s.cp;
  const cp: string[] = [blank(c.name)];
  if (c.addr) cp.push(`Адреса / Address: ${c.addr}`);
  if (c.regNo) cp.push(`Реєстраційний номер / Registration No.: ${c.regNo}`);
  for (const l of (c.bankText || '').split(/\r?\n/)) if (l.trim()) cp.push(l.trim());
  cp.push(`E-mail: ${blank(c.email, 16)}`);
  const our = AVM_REQ.map(([u, e]) => (u === e ? u : `${u} / ${e}`));
  our.push(`Офіційна e-mail адреса / Official e-mail: ${ENTITIES.avm.email}`);
  return { cp: { head: 'ЗАМОВНИК / CUSTOMER', lines: cp }, our: { head: 'ЕКСПЕДИТОР / FORWARDER', lines: our } };
}

/** Підписанти: [наш, клієнта] — «Директор / Director». */
export const nrSigners = (s: DocumentState) => ({
  our: 'Директор / Director: Ковтонюк Т. М. / T. M. Kovtoniuk', cp: `Директор / Director: ${blank(s.cp.dir, 15)}`,
});

/* ── Заявка ── */

/** Рядки заявки: [мітка UA, значення UA, мітка EN, ключ EN-поля]. Порядок — як у зразку АвтоМув (06.10.2026). */
const APP_ROWS: Array<[string, (s: DocumentState) => string, string, string]> = [
  ['Маршрут перевезення', (s) => s.trip.route || '', 'Transportation route', 'routeEn'],
  ['Найменування та кількість вантажу', (s) => s.trip.cargo || '', 'Description and quantity of cargo', 'cargoEn'],
  ['Вантажовідправник, контактна особа, телефон', (s) => [s.trip.shipper, s.trip.shipperC].filter(Boolean).join(', '), 'Shipper, contact person, telephone', 'shipperEn'],
  ['Адреса завантаження', (s) => s.trip.loadAddr || '', 'Loading address', 'loadAddrEn'],
  ['Дата навантаження', (s) => s.trip.loadDate || '', 'Loading date', 'loadDateEn'],
  ['Адреса замитнення', (s) => s.trip.custAddr || '', 'Customs clearance address (departure)', 'custAddrEn'],
  ['Пункт перетину кордону', (s) => s.trip.border || '', 'Border crossing point', 'borderEn'],
  ['Адреса розмитнення', (s) => s.trip.decustAddr || '', 'Customs clearance address (destination)', 'decustAddrEn'],
  ['Вантажоодержувач, контактна особа, телефон', (s) => [s.trip.consignee, s.trip.consigneeC].filter(Boolean).join(', '), 'Consignee, contact person, telephone', 'consigneeEn'],
  ['Адреса розвантаження', (s) => s.trip.unloadAddr || '', 'Unloading address', 'unloadAddrEn'],
  ['Дата доставки', (s) => s.trip.unloadDate || '', 'Delivery date', 'unloadDateEn'],
  ['Вимоги до перевезення вантажу та/або транспортного засобу', (s) => s.trip.reqs || '', 'Requirements for cargo transportation and/or vehicle', 'reqsEn'],
  ['Транспортний засіб: марка, модель, тип, реєстраційний номер автомобіля, причепа, його параметри', (s) => s.trip.truck || '',
    'Vehicle: make, model, type, registration number of vehicle and trailer, parameters', 'truckEn'],
  ['Дані водія: ПІП, номер посвідчення водія, номер телефону', (s) => s.trip.driver || '', "Driver's details: full name, driver's license number, telephone number", 'driverEn'],
  ['Відповідальна особа Експедитора, номер телефону, email', (s) => [s.manager.name, s.manager.phone].filter(Boolean).join(', '),
    'Responsible person of the Freight Forwarder, telephone number, email', 'mgrEn'],
  ['Відповідальна особа Замовника, номер телефону, email', (s) => s.trip.otherResp || '', 'Responsible person of the Customer, telephone number, email', 'otherRespEn'],
  ['Загальна ціна послуг', (s) => (s.pay.sum ? `${s.pay.sum} ${s.pay.cur || 'EUR'}` : ''), 'Total service fee', ''],
  ['Додаткові умови', (s) => s.trip.extra || '', 'Additional terms', 'extraEn'],
];
/** Ключі англійських полів рейсу (для форми й перевірки). */
export const NR_EN_KEYS = APP_ROWS.map((r) => r[3]).filter(Boolean);

/** Рядки обох частин заявки. Англійське порожнє → те саме значення (дати, телефони, номери авто). */
export function nrAppRows(s: DocumentState): { ua: Array<[string, string]>; en: Array<[string, string]> } {
  const ua: Array<[string, string]> = [], en: Array<[string, string]> = [];
  for (const [lu, get, le, k] of APP_ROWS) {
    const v = get(s);
    ua.push([lu, v]);
    en.push([le, (k && (s.trip[k] || '').trim()) || v]);
  }
  return { ua, en };
}

/** Підписи заявки: UA і EN частини. */
export const nrAppSign = (s: DocumentState) => ({
  ua: { our: ['Експедитор: ТОВ «АвтоМув»', 'Директор Ковтонюк Т. М.'], cp: [`Замовник: ${blank(s.cp.name)}`, `Директор ${blank(s.cp.dir, 15)}`], seal: 'М.П.' },
  en: { our: ['Freight Forwarder: LLC "AutoMuv"', 'Director: T. M. Kovtoniuk'], cp: [`Customer: ${blank(s.cp.name)}`, `Director: ${blank(s.cp.dir, 15)}`], seal: 'Seal' },
});

/** Перевірка перед формуванням (текст — менеджеру як є). */
export function nrBlocker(s: DocumentState): string | null {
  if (s.ent !== 'avm') return 'Договір і заявка для нерезидента оформлюються лише від ТОВ «АвтоМув».';
  if (!(s.cp.name || '').trim()) return 'Вкажіть назву клієнта (латиницею, як у його документах).';
  if (s.doc === 'nrmain') {
    if (!(s.cp.dir || '').trim()) return 'Вкажіть директора клієнта.';
    if (!(s.cp.lawUa || '').trim() || !(s.cp.lawEn || '').trim()) return 'Вкажіть країну реєстрації клієнта обома мовами («законодавства Англії» / «laws of England»).';
    if (!nrUntil(s)) return '«Діє до» — дата у форматі ДД.ММ.РРРР, напр. 31.12.2026.';
    return null;
  }
  if (!s.dealNo) return 'Вкажіть № заявки — це ID угоди в СРМ, поле обов\'язкове.';
  if (!(s.mainNo || '').trim() || !isoOk(s.mainDate)) return 'Оберіть договір, до якого заявка (або впишіть його № і дату).';
  return null;
}

/** Колонки договору й розрив перед англійською частиною заявки — лише для цих документів. */
export const NR_CSS = `
.docfmt table.bi{border-left:0;margin:6pt 0 8pt;line-height:1.35}
.docfmt table.bi td{border:0;padding:1.5pt 6pt;width:50%;vertical-align:top;text-align:justify}
.docfmt table.bi td p{margin:0 0 3pt;text-indent:0}
.docfmt table.bi tr.bh td{color:var(--acc);font-weight:700;padding-top:7pt;text-align:left}
.docfmt table.bi tr.bh2 td{font-weight:700}
.docfmt .nrapx{text-align:right;font-size:9.5pt;color:#5a5f6b;margin:0 0 6pt}
.docfmt .nrpart{break-before:page;page-break-before:always}
`;
