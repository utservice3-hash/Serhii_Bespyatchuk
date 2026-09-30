/**
 * Парсер реквізитів контрагента з довільного тексту (Viber-повідомлення, шапки
 * договорів, «брудні» рядки) + імпорт старих заявок назад у форму.
 *
 * Порт 1:1 із затвердженого макета konstruktor-dokumentiv.html (v15) — поведінка
 * еталона зафіксована тестами requisitesParser.test.ts на тих самих кейсах.
 *
 * Два підводні камені, через які тут усе виглядає саме так (обидва вже кусались):
 * 1. `\w`/`\b` у JS НЕ бачать кирилиці — тому всюди явні діапазони [А-ЯІЇЄҐ][а-яіїєґ'’].
 * 2. Телефон валідується нормалізацією у +380XXXXXXXXX — це відсікає хвости ІПН
 *    (12 цифр не складаються у валідний номер), тож жодних «жадібних» регекспів.
 */

import { OWN_IDS as REF_OWN_IDS, OWN_RX as REF_OWN_RX } from '../data/reference.js';

export interface ParsedRequisites {
  name: string;
  edrpou: string;
  ipn: string;
  addr: string;
  iban: string;
  bank: string;
  phone: string;
  email: string;
  dir: string;
}

export interface ParseResult {
  out: ParsedRequisites;
  /** які поля знайдено — для підсвітки у формі */
  found: Record<keyof ParsedRequisites, boolean>;
}

export const REQUISITE_FIELDS: Array<[keyof ParsedRequisites, string]> = [
  ['name', 'Назва'], ['edrpou', 'ЄДРПОУ'], ['ipn', 'ІПН / ПДВ'], ['addr', 'Адреса'],
  ['iban', 'IBAN'], ['bank', 'Банк'], ['phone', 'Телефон'], ['email', 'Пошта'], ['dir', 'Директор'],
];

/** '0671234567' | '380671234567' (з будь-яким сміттям) → '+380671234567'; інакше ''. */
export function normPhone(s: string): string {
  const d = String(s).replace(/\D/g, '');
  if (/^380\d{9}$/.test(d)) return '+' + d;
  if (/^0\d{9}$/.test(d)) return '+38' + d;
  return '';
}

export function findPhone(t: string): string {
  // 1) поруч із підписом «Телефон:» — найнадійніше
  const lab = t.match(/(?:тел(?:ефон)?|моб(?:ільний)?|phone)\D{0,3}([+(]?[\d][\d\s()+.-]{8,22}\d)/i);
  if (lab) { const p = normPhone(lab[1]); if (p) return p; }
  // 2) інакше — будь-яке число, що нормалізується у +380XXXXXXXXX.
  //    Нормалізація і відкидає хвіст ІПН: 12 цифр не дають валідного номера.
  for (const c of (t.match(/[+(]?\d[\d\s()+.-]{8,22}\d/g) || [])) {
    const p = normPhone(c); if (p) return p;
  }
  return '';
}

export function parseRequisites(text: string): ParseResult {
  const out = {} as ParsedRequisites;
  const t = String(text).replace(/ /g, ' '); // NBSP → пробіл, інакше регекспи мовчки мажуть
  const grab = (re: RegExp, g = 1): string => {
    const m = t.match(re); return m && m[g] ? m[g].trim() : '';
  };

  out.name = grab(/((?:ТОВ|ТзОВ|ПП|ПРАТ|ПАТ|ТОВАРИСТВО[^\n«"]*)\s*[«"'][^»"'\n]+[»"'])/i)
          || grab(/(ФОП\s+[А-ЯІЇЄҐ][а-яіїєґ'’]+(?:\s+[А-ЯІЇЄҐ][а-яіїєґ'’]+){1,2})/i);
  out.edrpou = grab(/(?:ЄДРПОУ|Єдрпоу)\D{0,12}(\d{8})/i) || grab(/\b(\d{8})\b/);
  out.ipn    = grab(/(?:ІПН|IПН|ПДВ|податковий номер|ідентифікаційн[а-яіїєґ]*\s+номер)\D{0,6}(\d{10,12})/i);
  out.iban   = (grab(/\b(UA\d{27})\b/i) || '').toUpperCase();
  out.bank   = grab(/в\s+(?:банку\s+)?((?:АТ|ПАТ|АБ|Філії|Філія|ТОВ)[^,\n]{3,60}?)(?=\s*(?:код МФО|МФО|,|$))/im);
  const mfo  = grab(/МФО\D{0,12}(\d{6})/i);
  if (out.bank && mfo) out.bank += ', МФО ' + mfo;
  out.phone  = findPhone(t);
  out.email  = grab(/([\w.+-]+@[\w-]+\.[\w.-]+)/);
  out.addr   = grab(/(?:Місцезнаходження|Юридична адреса|Адреса|адреса)\s*:?\s*([^\n]{10,140})/i)
            || grab(/(\d{5},?\s[^\n]{10,140})/);
  out.dir    = grab(/директор[аи]?\s*:?\s*([А-ЯІЇЄҐ][а-яіїєґ'’]+(?:\s+[А-ЯІЇЄҐ][а-яіїєґ'’]+){1,2})/i);
  if (/^фоп/i.test(out.name)) out.name = out.name.replace(/^фоп/i, 'ФОП');
  if (!out.dir && /^ФОП/i.test(out.name)) out.dir = out.name.replace(/^ФОП\s*/i, '');

  const found = {} as Record<keyof ParsedRequisites, boolean>;
  REQUISITE_FIELDS.forEach(([k]) => { found[k] = !!out[k]; });
  return { out, found };
}

/* ───────────────────── Імпорт старої заявки назад у форму ───────────────────── */

/** Наші власні ідентифікатори — щоб при імпорті старої заявки не вихопити СЕБЕ як контрагента. */
const OWN_IDS = new Set<string>(REF_OWN_IDS);
const OWN_RX = REF_OWN_RX;
const OWN_PHONE = '+380688070816';

/** [підпис у таблиці заявки, тип, ключ поля рейсу] — підпис і НАСТУПНИЙ непорожній рядок. */
const LABELS: Array<[string, 't' | 'pay', string]> = [
  ['Маршрут перевезення', 't', 'route'], ['Найменування та кількість вантажу', 't', 'cargo'],
  ['Кількість вантажних місць', 't', 'places'], ['Особливі умови', 't', 'special'],
  ['Вантажовідправник', 't', 'shipper'], ['Вантажоодержувач', 't', 'consignee'],
  ['Адреса завантаження', 't', 'loadAddr'], ['Дата навантаження', 't', 'loadDate'], ['Дата, час навантаження', 't', 'loadDate'],
  ['Адреса розвантаження', 't', 'unloadAddr'], ['Адреси розвантаження', 't', 'unloadAddr'],
  ['Дата доставки', 't', 'unloadDate'], ['Дата, час доставки', 't', 'unloadDate'],
  ['Пункт переходу кордону', 't', 'border'], ['Пункт перетину кордону', 't', 'border'],
  ['Адреса замитнення', 't', 'custAddr'], ['Адреса розмитнення', 't', 'decustAddr'],
  ['Вимоги до', 't', 'reqs'], ['Транспортний засіб', 't', 'truck'], ['Дані водія', 't', 'driver'],
  ['Додаткові умови', 't', 'extra'],
  ['Плата за перевезення', 'pay', ''], ['Загальна ціна послуг', 'pay', ''],
];

export interface ParsedOldDoc {
  dealNo?: string;
  party: 'client' | 'carrier';
  ent: 'uts' | 'avm' | 'fop' | null;
  cp: Partial<ParsedRequisites>;
  trip: Record<string, string>;
  pay?: { sum: string; cur: string; form: string };
  intl?: boolean;
  notes: string[];
}

/**
 * Розбирає ТЕКСТ старої заявки (docx → текст робить викликач) і повертає все,
 * що можна підставити у форму: сторону, юрособу, № угоди, контрагента, рейс, оплату.
 * Контрагент = «усі збіги мінус наші ідентифікатори».
 */
export function parseOldDoc(text: string): ParsedOldDoc {
  const out: ParsedOldDoc = { trip: {}, cp: {}, notes: [], party: 'client', ent: null };
  const m = text.match(/ДОГОВІР\s*№\s*([\w\-\/]+)/i);
  if (m) out.dealNo = m[1];
  out.party = /далі\s*[-—–]\s*Перевізник/i.test(text) ? 'carrier' : 'client';
  out.ent = text.includes('45618360') ? 'avm' : (text.includes('3478512294') ? 'fop' : (text.includes('44186230') ? 'uts' : null));

  const allm = (re: RegExp) => [...text.matchAll(re)].map(x => x[1]);
  out.cp.edrpou = allm(/ЄДРПОУ\D{0,12}(\d{8})/gi).find(v => !OWN_IDS.has(v)) || '';
  out.cp.iban = (allm(/\b(UA\d{27})\b/gi).find(v => !OWN_IDS.has(v.toUpperCase())) || '').toUpperCase();
  out.cp.name = allm(/((?:ТОВ|ТзОВ|ПП|ПРАТ|ПАТ|ТОВАРИСТВО[^\n«"]*)\s*[«"'][^»"'\n]+[»"']|ФОП\s+[А-ЯІЇЄҐ][а-яіїєґ'’]+(?:\s+[А-ЯІЇЄҐ][а-яіїєґ'’]+){1,2})/g)
    .find(v => !OWN_RX.test(v)) || '';
  out.cp.dir = allm(/(?:в особі(?: директора)?|директора)\s*:?\s*([А-ЯІЇЄҐ][а-яіїєґ'’]+(?:\s+[А-ЯІЇЄҐ][а-яіїєґ'’]+){1,2})/g)
    .find(v => !OWN_RX.test(v)) || '';
  out.cp.email = allm(/([\w.+-]+@[\w-]+\.[\w.-]+)/g).find(v => !OWN_RX.test(v)) || '';
  // ФОП підписує сам себе — ПІБ беремо з назви (називний відмінок), бо у преамбулі він у родовому
  if (/^ФОП/i.test(out.cp.name || '')) out.cp.dir = (out.cp.name || '').replace(/^ФОП\s*/i, '');
  for (const c of (text.match(/[+(]?\d[\d\s()+.-]{8,22}\d/g) || [])) {
    const ph = normPhone(c);
    if (ph && ph !== OWN_PHONE) { out.cp.phone = ph; break; }
  }

  // таблиця заявки: рядок-підпис → наступний непорожній рядок
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const isLabel = (l: string) => LABELS.find(([lab]) => l.startsWith(lab));
  let lastMain = '';
  for (let i = 0; i < lines.length; i++) {
    const hit = isLabel(lines[i]);
    if (!hit) {
      if (/^Контактна особа/i.test(lines[i]) && lastMain) {
        const v = lines[i + 1] && !isLabel(lines[i + 1]) && !/^Контактна/i.test(lines[i + 1]) ? lines[i + 1] : '';
        if (v) out.trip[lastMain === 'shipper' ? 'shipperC' : 'consigneeC'] = v;
      }
      continue;
    }
    const v = lines[i + 1] && !isLabel(lines[i + 1]) ? lines[i + 1] : '';
    if (!v) continue;
    if (hit[1] === 'pay') {
      const pm = v.match(/([\d\s.,]{2,15})\s*(грн|є|евро|€)?/i);
      if (pm) {
        out.pay = {
          sum: pm[1].trim(),
          cur: /є|евро|€/i.test(v) ? '€ по курсу НБУ на день завантаження' : 'грн',
          form: /без\s*пдв/i.test(v) ? 'б/г без ПДВ' : (/з\s*пдв/i.test(v) ? 'б/г з ПДВ' : (/софт/i.test(v) ? 'СОФТ платіж' : '')),
        };
      }
    } else {
      out.trip[hit[2]] = v;
      if (hit[2] === 'shipper') lastMain = 'shipper';
      if (hit[2] === 'consignee') lastMain = 'consignee';
    }
  }
  if (out.trip.border || out.trip.custAddr || out.trip.decustAddr) out.intl = true;
  return out;
}
