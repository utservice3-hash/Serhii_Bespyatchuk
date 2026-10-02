/**
 * ✅ ПЕРЕВІРКА ПОЛІВ КОНСТРУКТОРА (затверджено 02.10.2026 — таблиця «Перевірка полів у конструкторі документів»).
 *
 * Одна чиста функція для прев'ю й формування: сервер блокує формування на 🔴 і віддає весь список у прев'ю,
 * фронт лише показує — окремої копії правил на фронті немає, тож вони не розійдуться.
 *  🔴 `error` — не дає сформувати документ, поки не виправлено;
 *  🟡 `warn`  — попереджає, але сформувати можна.
 * Порожнє необовʼязкове поле — не помилка: перевіряється лише вписане. Обовʼязкові — назва контрагента, № заявки
 * (це вже робить `blockers` пакета) і сума заявки.
 *
 * 📐 Алгоритми контрольних сум заміряно на живих даних 02.10.2026 (лише читання): ЄДРПОУ з CRM — 1595 із 1602 сходяться
 * (решта 7 — описки в CRM), РНОКПП ФОП — 125 із 134, коди й рахунки наших трьох юросіб — усі. IBAN у довіднику й архіві
 * конструктора — 5 із 11: усі 6 відхилених справді криві (три без «UA» на початку, «-», «2»).
 */
import type { DocumentState } from './services/docgen.js';
import { normPhone } from './services/requisitesParser.js';
import { OWN_IDS } from './data/reference.js';

export type IssueLevel = 'error' | 'warn';
export interface Issue { field: string; level: IssueLevel; msg: string }
export interface ValidateCtx {
  /** `false` — угоди з таким ID у нашій базі CRM немає; `null`/не передано — не перевіряли. */
  dealKnown?: boolean | null;
  /** «Сьогодні» за Києвом, YYYY-MM-DD — для дат; у гейтах фіксується. */
  today?: string;
}

const digits = (s: string) => s.replace(/[\s-]/g, '');

/** ЄДРПОУ: 8 цифр, контрольна цифра за алгоритмом ДПС (ваги 1..7 або 7,1..6; при залишку ≥10 — ваги +2). */
export function edrpouValid(code: string): boolean {
  if (!/^\d{8}$/.test(code)) return false;
  const d = [...code].map(Number); const n = Number(code);
  const w = n < 30000000 || n > 60000000 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
  let r = w.reduce((a, x, i) => a + x * d[i], 0) % 11;
  if (r >= 10) { r = w.map((x) => x + 2).reduce((a, x, i) => a + x * d[i], 0) % 11; if (r >= 10) r = 0; }
  return r === d[7];
}

/** РНОКПП (ІПН фізособи / ФОП): 10 цифр, контрольна цифра — (Σ ваг −1,5,7,9,4,6,10,5,7) mod 11 mod 10. */
export function rnokppValid(code: string): boolean {
  if (!/^\d{10}$/.test(code)) return false;
  const d = [...code].map(Number); const w = [-1, 5, 7, 9, 4, 6, 10, 5, 7];
  return ((w.reduce((a, x, i) => a + x * d[i], 0) % 11) + 11) % 11 % 10 === d[9];
}

/** IBAN України: UA + 27 цифр, контрольна сума mod-97 (ISO 13616). Пробіли — не помилка. */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^UA\d{27}$/.test(s)) return false;
  const num = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let m = 0; for (const ch of num) m = (m * 10 + Number(ch)) % 97;
  return m === 1;
}

const ORG_FORM = /^(ТОВ|ТзОВ|ТДВ|ПП|ПрАТ|ПАТ|АТ|ДП|КП|ФГ|СГ|СФГ|ВКФ|ПВКФ|ПКФ|ГО|КТ|ОК|ФОП|ТОВАРИСТВО|ПРИВАТНЕ|АКЦІОНЕРНЕ|ПУБЛІЧНЕ|ДЕРЖАВНЕ|КОМУНАЛЬНЕ|ФЕРМЕРСЬКЕ|ФІЗИЧНА|СІЛЬСЬКОГОСПОДАРСЬКЕ|ВИРОБНИЧ|КОРПОРАЦІЯ|КООПЕРАТИВ|LLC|LTD|GMBH|SP\.?\s*Z|SRL|UAB|OOO)(?=[\s«"'“„.,]|$)/i;   // не \b: у JS він не бачить межі кириличного слова
const isFopName = (name: string) => /^(ФОП|ФІЗИЧНА\s+ОСОБА)/i.test(name.trim());

/** «15.01.2026, 08:00» → 2026-01-15 (перша дата в тексті); не розпізнано — null. */
function dateOf(text: string): string | null {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text || '');
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

export function validateForm(s: DocumentState, ctx: ValidateCtx = {}): Issue[] {
  const out: Issue[] = [];
  const add = (field: string, level: IssueLevel, msg: string) => out.push({ field, level, msg });
  const cp = s.cp || {};
  const name = (cp.name || '').trim();
  const fop = isFopName(name);

  // ── Реквізити контрагента ──
  if (!name) add('cp.name', 'error', 'Вкажіть назву контрагента — без неї в документі порожня сторона.');
  else if (!ORG_FORM.test(name)) add('cp.name', 'warn', 'Немає форми власності (ТОВ, ПП, АТ, ФОП…) — перевірте назву.');

  const code = digits(cp.edrpou || '');
  if (code) {
    if (!/^\d+$/.test(code)) add('cp.edrpou', 'error', 'ЄДРПОУ — лише цифри.');
    else if ((OWN_IDS as readonly string[]).includes(code)) add('cp.edrpou', 'error', 'Це код нашої юрособи — впишіть реквізити контрагента.');
    else if (fop && code.length === 8) add('cp.edrpou', 'error', 'У назві ФОП, а код 8-значний (як у компанії). Для ФОП — ІПН, 10 цифр.');
    else if (!fop && code.length === 10 && name) add('cp.edrpou', 'error', 'Код 10-значний (ІПН ФОП), а в назві не ФОП. Для компанії — ЄДРПОУ, 8 цифр.');
    else if (code.length === 8) { if (!edrpouValid(code)) add('cp.edrpou', 'error', 'ЄДРПОУ не сходиться за контрольною цифрою — перевірте, чи не переставлені цифри.'); }
    else if (code.length === 10) { if (!rnokppValid(code)) add('cp.edrpou', 'error', 'ІПН ФОП не сходиться за контрольною цифрою — перевірте цифри.'); }
    else add('cp.edrpou', 'error', `ЄДРПОУ компанії — 8 цифр, ІПН ФОП — 10; тут ${code.length}.`);
  }

  const ipn = digits(cp.ipn || '');
  if (ipn) {
    const need = fop ? 10 : 12;
    if (!/^\d+$/.test(ipn)) add('cp.ipn', 'error', 'ІПН / ПДВ — лише цифри.');
    else if (ipn.length !== need) add('cp.ipn', 'error', fop ? `ІПН ФОП — 10 цифр; тут ${ipn.length}.` : `ІПН платника ПДВ компанії — 12 цифр; тут ${ipn.length}.`);
  }

  const ibanRaw = (cp.iban || '').trim();
  const iban = ibanRaw.replace(/\s+/g, '').toUpperCase();
  if (ibanRaw) {
    if (/^\d{27}$/.test(iban)) add('cp.iban', 'error', 'IBAN має починатися з UA — допишіть UA перед цифрами.');
    else if (!/^UA\d{27}$/.test(iban)) add('cp.iban', 'error', `IBAN — UA і 27 цифр (29 знаків); тут ${iban.length}.`);
    else if (!ibanValid(iban)) add('cp.iban', 'error', 'IBAN не сходиться за контрольною сумою — перевірте цифри.');
  }
  const bank = (cp.bank || '').trim();
  if (ibanRaw && ibanValid(iban)) {
    if (!bank) add('cp.bank', 'warn', 'IBAN вписано, а банк — ні.');
    else {
      const mfo = /МФО\D{0,3}(\d{6})/i.exec(bank)?.[1];
      if (mfo && mfo !== iban.slice(4, 10)) add('cp.bank', 'warn', `МФО банку (${mfo}) не збігається з МФО в IBAN (${iban.slice(4, 10)}).`);
    }
  }

  if ((cp.phone || '').trim() && !normPhone(cp.phone || '')) add('cp.phone', 'warn', 'Телефон не схожий на український номер (+380 XX XXX XX XX).');
  if ((cp.email || '').trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((cp.email || '').trim())) add('cp.email', 'warn', 'Пошта не схожа на адресу (імʼя@домен).');
  const dir = (cp.dir || '').trim();
  if (dir && (dir.split(/\s+/).length < 2 || /\d/.test(dir))) add('cp.dir', 'warn', 'Директор — щонайменше прізвище й імʼя, без цифр.');
  const addr = (cp.addr || '').trim();
  if (addr && (addr.length < 10 || !/\d/.test(addr))) add('cp.addr', 'warn', 'Адреса закоротка або без номера будинку чи індексу.');

  // ── Заявка ── (основний договір — свої поля й гейти в `blockers`)
  if (s.doc !== 'main') {
    const deal = (s.dealNo || '').trim();
    if (deal && !/^\d+$/.test(deal)) add('dealNo', 'error', '№ заявки — це ID угоди в CRM, лише цифри.');
    else if (deal && ctx.dealKnown === false) add('dealNo', 'warn', `Угоди ${deal} у CRM не знайдено — перевірте ID (нова угода підтягується до 30 хв).`);

    const sumRaw = (s.pay?.sum || '').trim();
    const sum = Number(sumRaw.replace(/[\s ]/g, '').replace(',', '.'));
    if (!sumRaw) add('pay.sum', 'error', 'Вкажіть суму — обовʼязкова.');
    else if (!Number.isFinite(sum) || sum <= 0) add('pay.sum', 'error', 'Сума — число більше нуля (напр. 13 000 або 13000,50).');

    const load = dateOf(s.trip?.loadDate || ''), unload = dateOf(s.trip?.unloadDate || '');
    if (load && unload && unload < load) add('trip.unloadDate', 'warn', 'Дата доставки раніша за дату завантаження.');
  }
  if (s.docDate) {
    const today = ctx.today ?? kyivToday();
    if (s.docDate > addDays(today, 30)) add('docDate', 'warn', 'Дата договору більш ніж на 30 днів уперед — перевірте рік.');
    else if (s.docDate < addDays(today, -365)) add('docDate', 'warn', 'Дата договору давніша за рік — перевірте рік.');
  }
  return out;
}

/** Перша 🔴 — текст відмови формування (як `blockers`): менеджер бачить, що саме виправити. */
export const firstError = (issues: Issue[]): string | null => issues.find((i) => i.level === 'error')?.msg ?? null;
