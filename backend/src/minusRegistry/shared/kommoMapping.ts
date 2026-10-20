/**
 * Kommo → реєстр: як з угоди (lead) і її контактів зібрати CrmDeal.
 * ID полів звірено з акаунтом utsercice.kommo.com 20.10 (API, лише читання). Перевірити на своєму токені: `npm run check:kommo`.
 * Реєстр у Kommo НІЧОГО не пише — лише читає.
 */
import type { CrmDeal, Line } from './minusRegistry.js';

/** Один рядок приходу / розходу: сума, «Тип оплаты» (форма оплати), «расчет», у першого — ще валюта. */
export interface LineFields { sum: number; type: number; net: number; cur?: number }

export const KOMMO_FIELDS = {
  /** «Расчет приходов» */ incTotal: 2097649,
  /** «Расчет расходов» */ expTotal: 2097681,
  /** «Приход 1–5»: сума / «Приход N Тип оплаты» / «Приход N расчет»; «Валюта прихода 1» */
  inc: [
    { sum: 2097627, type: 2097629, net: 2097639, cur: 2099903 },
    { sum: 2097683, type: 2097631, net: 2097641 },
    { sum: 2097685, type: 2097633, net: 2097643 },
    { sum: 2097687, type: 2097635, net: 2097645 },
    { sum: 2097689, type: 2097637, net: 2097647 },
  ] as LineFields[],
  /** «Расход 1–5»: сума / «Расход N Тип оплаты» / «Расход N расчет»; «Валюта расхода 1» */
  exp: [
    { sum: 2097661, type: 2097651, net: 2097671, cur: 2099905 },
    { sum: 2097663, type: 2097653, net: 2097673 },
    { sum: 2097665, type: 2097655, net: 2097675 },
    { sum: 2097667, type: 2097657, net: 2097677 },
    { sum: 2097669, type: 2097659, net: 2097679 },
  ] as LineFields[],
  /** «Назва перевізника» — вкладка «Заявки на оплату», розділ «Оплата перевізнику по б/готівці». Заповнюється, коли менеджер відправляє заявку. */
  carrier: 2097493,
  /** Поле контакту «Тип контакта» і його значення «Перевозчик» — такий контакт клієнтом не вважаємо. */
  contactType: 437631,
  contactTypeCarrier: 990237,
} as const;

/** Очікувані назви полів — для перевірки ID на акаунті (tools/checkKommoFields.ts). */
export const KOMMO_FIELD_NAMES: Record<number, string> = (() => {
  const m: Record<number, string> = { [KOMMO_FIELDS.incTotal]: 'Расчет приходов', [KOMMO_FIELDS.expTotal]: 'Расчет расходов', [KOMMO_FIELDS.carrier]: 'Назва перевізника' };
  KOMMO_FIELDS.inc.forEach((f, i) => { m[f.sum] = `Приход ${i + 1}`; m[f.type] = `Приход ${i + 1} Тип оплаты`; m[f.net] = `Приход ${i + 1} расчет`; if (f.cur) m[f.cur] = 'Валюта прихода 1'; });
  KOMMO_FIELDS.exp.forEach((f, i) => { m[f.sum] = `Расход ${i + 1}`; m[f.type] = `Расход ${i + 1} Тип оплаты`; m[f.net] = `Расход ${i + 1} расчет`; if (f.cur) m[f.cur] = 'Валюта расхода 1'; });
  return m;
})();

// ---------- мінімальні типи відповіді Kommo API v4 ----------
export interface KommoValue { value?: string | number | boolean | null; enum_id?: number | null }
export interface KommoFieldValue { field_id: number; field_name?: string; values: KommoValue[] | null }
export interface KommoLead {
  id: number;
  name: string | null;
  price: number | null;                 // «Бюджет» угоди
  status_id: number;
  pipeline_id: number;
  custom_fields_values: KommoFieldValue[] | null;
  _embedded?: { contacts?: Array<{ id: number; is_main?: boolean }> };
}
export interface KommoContact { id: number; name: string | null; custom_fields_values: KommoFieldValue[] | null }
export interface KommoPipeline { id: number; name: string; _embedded?: { statuses?: Array<{ id: number; name: string }> } }

// ---------- читання полів ----------
const first = (vals: KommoFieldValue[] | null | undefined, id: number): KommoValue | null => {
  const f = (vals || []).find(x => x.field_id === id);
  return f && f.values && f.values.length ? f.values[0] : null;
};
/** Число з поля Kommo: числові поля приходять і числом, і рядком («19000», «17860.5»). Порожньо → null. */
export function num(v: KommoValue | null): number | null {
  if (!v || v.value === null || v.value === undefined || v.value === '') return null;
  const n = typeof v.value === 'number' ? v.value : Number(String(v.value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
export const text = (v: KommoValue | null) => (v && v.value !== null && v.value !== undefined ? String(v.value).trim() : '');

/** Рядки приходів або розходів. Порожні слоти (без суми й розрахунку) пропускаються; нумерація в реєстрі — за порядком. */
export function leadLines(lead: Pick<KommoLead, 'custom_fields_values'>, side: 'inc' | 'exp'): Line[] {
  const out: Line[] = [];
  for (const f of KOMMO_FIELDS[side]) {
    const sum = num(first(lead.custom_fields_values, f.sum));
    const net = num(first(lead.custom_fields_values, f.net));
    if (!sum && !net) continue;
    const type = text(first(lead.custom_fields_values, f.type));
    const line: Line = { sum: sum ?? 0, type, net: net ?? 0 };
    const cur = f.cur ? text(first(lead.custom_fields_values, f.cur)) : '';
    if (cur && type === 'ВАЛЮТА') line.cur = cur;
    out.push(line);
  }
  return out;
}

const isCarrierContact = (c: KommoContact) => (c.custom_fields_values || []).some(f =>
  f.field_id === KOMMO_FIELDS.contactType && (f.values || []).some(v => v.enum_id === KOMMO_FIELDS.contactTypeCarrier));

/**
 * Клієнт = «картка клієнта» в угоді (рішення 20.10): назва основного контакту.
 * Якщо основний контакт має «Тип контакта» = Перевозчик — беремо перший інший контакт, що не перевізник. Немає — ''.
 */
export function pickClient(lead: Pick<KommoLead, '_embedded'>, contacts: KommoContact[]): string {
  const links = [...(lead._embedded?.contacts || [])].sort((a, b) => Number(!!b.is_main) - Number(!!a.is_main));
  const byId = new Map(contacts.map(c => [c.id, c]));
  for (const l of links) {
    const c = byId.get(l.id);
    if (c && !isCarrierContact(c) && (c.name || '').trim()) return (c.name || '').trim();
  }
  return '';
}

/** Назва етапу: статуси шукаються в межах воронки угоди (142 / 143 — спільні «Успішно» / «Закрито»). */
export function stageName(pipelines: KommoPipeline[], lead: Pick<KommoLead, 'pipeline_id' | 'status_id'>): string {
  const p = pipelines.find(x => x.id === lead.pipeline_id);
  const s = p?._embedded?.statuses?.find(x => x.id === lead.status_id);
  return s ? s.name.trim() : `Етап ${lead.status_id}`;
}

const sumNet = (l: Line[]) => l.reduce((s, x) => s + x.net, 0);

/** Угода Kommo → знімок для реєстру. Підсумки й бюджет — з CRM як є; порожнє поле підсумку → сума рядків. */
export function leadToCrmDeal(lead: KommoLead, contacts: KommoContact[], stage: string): CrmDeal {
  const inc = leadLines(lead, 'inc'), exp = leadLines(lead, 'exp');
  const incTotal = num(first(lead.custom_fields_values, KOMMO_FIELDS.incTotal)) ?? sumNet(inc);
  const expTotal = num(first(lead.custom_fields_values, KOMMO_FIELDS.expTotal)) ?? sumNet(exp);
  return {
    dealId: String(lead.id),
    name: (lead.name || '').trim() || `Угода ${lead.id}`,
    stage,
    client: pickClient(lead, contacts),
    carrier: text(first(lead.custom_fields_values, KOMMO_FIELDS.carrier)),
    inc, exp, incTotal, expTotal,
    budget: typeof lead.price === 'number' ? lead.price : incTotal - expTotal,
  };
}
