/**
 * «Перевірка контрагента» (YouControl / YouScore API) — що зберігаємо і як оцінюємо. Спільне для сервера, вкладок і макета.
 *
 * Критерії (рішення Сергія 21.10):
 *   ✓ зареєстровано не менше 3 років тому;
 *   ✓ немає відкритих справ за перевезення / експедирування, де контрагент — відповідач;
 *   ✓ немає програних за 3 роки справ за перевезення, де контрагент — відповідач.
 *   ФОП — суди вручну (YouScore шукає справи лише за ЄДРПОУ юрособи). Нерезиденти — без автоперевірки.
 * Для інформації (на оцінку не впливає): виконавчі провадження, експрес-аналіз, власники й капітал.
 * Повторна перевірка того самого коду — раз на 2 місяці; до того всі бачать збережену (Сергій може «Перевірити заново зараз»).
 */
import type { From, ReqStatus } from './counterparty.js';
import { casesW, dt, plural } from './cpFormat.js';

export const RECHECK_MONTHS = 2;
/** Позначки в блоці «Власники й капітал»: зміна власників / директора за останні 6 місяців; власник має понад 10 компаній. */
export const OWN_RECENT_MONTHS = 6;
export const MASS_OWNER = 10;
/**
 * Орієнтовна ціна в транзакціях (для підписів на кнопках і прогнозу). Справжня — рахує сервер по кожному запиту до YouScore.
 *   full    — перша перевірка компанії: ЄДР + історія змін + суди + виконавчі + експрес-аналіз (+ PDF до запиту, + нові власники);
 *   repeat  — повторна / планова: ЄДР + суди + виконавчі + експрес (зміни власників і директора — порівнянням з попередньою);
 *   fop     — ФОП: ЄДР + виконавчі + експрес (суди — вручну);
 *   monitor — щомісячні суди: одна сторінка справ.
 */
export const TX_EST = { full: 5, repeat: 4, fop: 3, pdf: 1, usr: 1, owner: 1, monitor: 1 };
/** Планова повторна перевірка клієнтів з лімітом — раз на 3 місяці (рішення Сергія 23.10). */
export const PLANNED_CYCLE_DAYS = 91;
/** Позначка «зміни в YouControl» після планової перевірки показується 30 днів. */
export const NOTICE_DAYS = 30;
/** Програні справи — за останні 3 роки. */
export const LOST_YEARS = 3;

export interface CourtCase {
  no: string;                 // номер справи
  court: string;
  date: string | null;        // надійшла до суду
  subj: string;               // предмет позову
  sum: number | null;         // сума позову, грн
  open: boolean;              // розглядається
  next: string | null;        // найближче засідання
  lost: boolean;              // рішення набрало сили, позов до контрагента задоволено
  lawDate: string | null;     // дата набрання законної сили
  url: string | null;         // документ на YouControl
  fresh?: boolean;            // знайшла щомісячна перевірка
}
export interface Owner { name: string; code: string | null; kind: 'person' | 'company'; share: number | null; ben: boolean; companies: number | null }
export interface Ownership {
  capital: number | null;
  owners: Owner[];
  bens: string[];             // кінцеві бенефіціари, які не є засновниками
  benNote: string;            // «КБВ відсутній: …» з ЄДР
  director: { name: string; since: string | null } | null;
  ownersAt: string | null; ownersWhat: string;   // остання зміна складу власників
  dirAt: string | null; dirWhat: string;         // остання зміна директора
}
export interface ExpressFact { name: string; value: string; tone: 'ok' | 'warn' | 'bad' }
export interface CheckSubject {
  code: string;
  kind: string;               // «ТОВ», «ПП», «ФОП»…
  name: string;
  reg: string | null;         // дата реєстрації
  head: string;               // керівник
  addr: string;
  fop: boolean;
  state: string;              // стан у ЄДР («зареєстровано», «в стані припинення»…)
  own: Ownership | null;      // ФОП — null
  yc: {
    cases: CourtCase[];       // лише справи за перевезення / експедирування, де контрагент — відповідач
    other: number;            // решта справ, які повернув YouScore (не враховано)
    enf: number;              // відкриті виконавчі провадження, де контрагент — боржник
    express: ExpressFact[];
    index: string | null;     // ExpressAnalysisScore: A–D
    checkedAt: string;
    archived: boolean;        // YouScore довго оновлював дані — показано архівні (showCurrentData)
  };
}
export type CheckBase = Pick<CheckSubject, 'code' | 'kind' | 'name' | 'reg' | 'head' | 'addr' | 'fop'>;
export type CheckSrc = 'tool' | 'req' | 'planned' | 'monitor';
export interface CpCheck {
  id: string;
  code: string;
  at: string;
  by: string | null;          // null — система (щомісячна перевірка)
  byName: string | null;
  src: CheckSrc;              // tool — вкладка «Перевірка»; req — з форми запиту; planned — планова (раз на 3 міс.); monitor — щомісячні суди
  status: 'running' | 'done' | 'failed';
  error: string | null;
  tx: number;                 // скільки транзакцій YouScore витрачено
  pdf: boolean;               // PDF-досьє збережено
  base: CheckBase | null;     // ЄДР — приходить першим
  subj: CheckSubject | null;  // повний результат
}
/** Бюджет транзакцій YouControl — бачить лише Сергій (рахує server/ycBudget.ts). */
export interface BudgetInfo {
  balance: number | null;                          // залишок на ключі (/v1/rateLimits); null — YouScore не відповів
  month: { req: number; tool: number; planned: number; monitor: number; total: number };   // з 1-го числа місяця
  last30: number;                                  // за останні 30 днів
  reserve: number;                                 // треба на 60 днів наперед: планові + суди боржникам
  plannedPerMonth: number;                         // планові + суди боржникам у середньому на місяць
  months: number | null;                           // на скільки місяців вистачить залишку
  low: boolean;                                    // залишок менший за резерв → ручні перевірки співробітників зупинено
}

/** Що ще відомо про цей код — для підказок у панелі перевірки (рахує сервер з урахуванням прав). */
export interface CheckContext {
  latest: { id: string; at: string; byName: string | null } | null;   // найновіша завершена перевірка коду
  req: { id: string; status: ReqStatus; byName: string; visible: boolean; okLine: string | null; okLimit: number | null } | null;
  limit: { limit: number | null; days: number | null; from: From; src: 'debt' | 'set' } | null;   // діючий ліміт без запиту
}
export interface CheckView extends CpCheck { ctx: CheckContext }

// ---------- час ----------
export function monthsBetween(from: string | Date, to: Date): number {
  const a = new Date(from), b = to;
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m--;
  return m;
}
export function age(reg: string | null, now: Date) {
  if (!reg) return { y: 0, m: 0, text: 'невідомо' };
  const m = Math.max(0, monthsBetween(reg, now)), y = Math.floor(m / 12), mo = m % 12;
  return { y, m, text: y ? `${y} ${plural(y, 'рік', 'роки', 'років')}${y < 3 && mo ? ` ${mo} міс.` : ''}` : `${mo} міс.` };
}
export const agoText = (d: string, now: Date) => {
  const m = monthsBetween(d, now);
  return m < 1 ? 'менше місяця тому' : m < 12 ? `${m} міс. тому` : `${Math.floor(m / 12)} ${plural(Math.floor(m / 12), 'рік', 'роки', 'років')} тому`;
};
export function validUntil(at: string): Date { const d = new Date(at); d.setMonth(d.getMonth() + RECHECK_MONTHS); return d; }
export const isFresh = (at: string, now: Date) => validUntil(at) > now;

// ---------- критерії ----------
export type Tone = 'ok' | 'warn' | 'bad' | 'mut';
export interface Crit { age: { st: Tone; v: string }; open: { st: Tone; v: string }; lost: { st: Tone; v: string }; openN: number; lostN: number }
export function critOf(s: CheckSubject, now: Date): Crit {
  const a = age(s.reg, now);
  const open = s.yc.cases.filter(c => c.open).length;
  const lost = s.yc.cases.filter(c => !c.open && c.lost).length;
  return {
    age: { st: s.reg && a.y >= 3 ? 'ok' : 'bad', v: s.reg ? `${dt(s.reg)} · ${a.text}` : 'дати реєстрації немає' },
    open: s.fop ? { st: 'mut', v: 'ФОП — вручну' } : { st: open ? 'warn' : 'ok', v: open ? casesW(open) : 'немає' },
    lost: s.fop ? { st: 'mut', v: 'ФОП — вручну' } : { st: lost ? 'warn' : 'ok', v: lost ? casesW(lost) : 'немає' },
    openN: open, lostN: lost,
  };
}
/** Загальна оцінка: «Без зауважень» / «Є зауваження» / «Суди — вручну» (ФОП без інших зауважень). Власники на оцінку не впливають. */
export function verdict(s: CheckSubject, now: Date): 'ok' | 'warn' | 'fop' {
  const c = critOf(s, now);
  const issue = c.age.st !== 'ok' || c.openN || c.lostN || s.yc.enf || s.yc.express.some(x => x.tone !== 'ok');
  return issue ? 'warn' : s.fop ? 'fop' : 'ok';
}
export function ownFlags(o: Ownership | null, now: Date): string[] {
  if (!o) return [];
  const f: string[] = [];
  if (o.ownersAt && monthsBetween(o.ownersAt, now) < OWN_RECENT_MONTHS) f.push('нові власники');
  if (o.dirAt && monthsBetween(o.dirAt, now) < OWN_RECENT_MONTHS) f.push('новий директор');
  if (o.owners.some(x => (x.companies ?? 0) > MASS_OWNER)) f.push('масовий власник');
  return f;
}
/** Підсумок для історії запиту: «Усі критерії пройдено», «Менше 3 років; справ за перевезення немає», «ФОП: суди — вручну». */
export function checkSummary(s: CheckSubject, now: Date): string {
  const c = critOf(s, now), young = c.age.st !== 'ok', n = c.openN + c.lostN;
  const courts = s.fop ? 'ФОП: суди — вручну' : n ? `знайдено справ за перевезення: ${n}` : young ? 'справ за перевезення немає' : '';
  const out = [young ? 'Менше 3 років' : '', courts].filter(Boolean).join('; ');
  return out ? out[0].toUpperCase() + out.slice(1) : 'Усі критерії пройдено';
}

/**
 * Що змінилось з попередньої перевірки — для позначки «зміни в YouControl» на ліміті (не призупиняє; нові справи — окремо).
 * Немає попередньої — свіжі зміни власників / директора (за 6 міс.), виконавчі, «особлива увага» в експрес-аналізі.
 */
export function changesSince(prev: CheckSubject | null, cur: CheckSubject, now: Date): string[] {
  const out: string[] = [];
  const o = cur.own, po = prev?.own || null;
  if (!prev) {
    if (o?.ownersAt && monthsBetween(o.ownersAt, now) < OWN_RECENT_MONTHS) out.push(`нові власники: ${o.ownersWhat}`);
    if (o?.dirAt && monthsBetween(o.dirAt, now) < OWN_RECENT_MONTHS) out.push(`новий директор: ${o.dirWhat}`);
    if (cur.yc.enf) out.push(`виконавчі провадження: ${cur.yc.enf}`);
  } else {
    if (o && po && o.ownersAt && o.ownersAt !== po.ownersAt) out.push(`нові власники: ${o.ownersWhat}`);
    if (o && po && o.dirAt && o.dirAt !== po.dirAt) out.push(`новий директор: ${o.dirWhat}`);
    if (cur.yc.enf > prev.yc.enf) out.push(`нові виконавчі провадження: ${prev.yc.enf} → ${cur.yc.enf}`);
    if (cur.state && prev.state && cur.state !== prev.state) out.push(`стан у ЄДР: ${cur.state}`);
  }
  const wasBad = new Set((prev?.yc.express || []).filter(x => x.tone === 'bad').map(x => x.name));
  const bad = cur.yc.express.filter(x => x.tone === 'bad' && !wasBad.has(x.name)).map(x => x.name);
  if (bad.length) out.push(`експрес-аналіз: ${bad.join(', ')}`);
  const wasMass = new Set((po?.owners || []).filter(x => (x.companies ?? 0) > MASS_OWNER).map(x => x.name));
  const mass = (o?.owners || []).filter(x => (x.companies ?? 0) > MASS_OWNER && !wasMass.has(x.name)).map(x => `${x.name} (${x.companies})`);
  if (mass.length) out.push(`масовий власник: ${mass.join(', ')}`);
  return out;
}

// ---------- суди: що вважаємо справою «за перевезення» ----------
/** Предмет позову / категорія справи про перевезення чи експедирування. */
export const TRANSPORT_RE = /перевез|перевіз|експедир|транспортн|вантаж|фрахт|логістичн|\bcmr\b|автоперевез/i;
export const isTransport = (...texts: Array<string | null | undefined>) => texts.some(t => !!t && TRANSPORT_RE.test(t));
/** Рішення, яким позов задоволено (повністю чи частково). «Відмовити в задоволенні» — ні. */
export function claimSatisfied(resolution: string | null | undefined): boolean {
  const t = (resolution || '').toLowerCase().replace(/\s+/g, ' ');
  if (!t) return false;
  if (/у задоволенні (позову|позовних вимог)[^.]{0,40}відмовити|відмовити (у|в) задоволенні (позову|позовних вимог)( повністю)?/.test(t) && !/задовольнити частково/.test(t)) return false;
  return /позов[^.]{0,60}задовольнити|задовольнити (позов|частково|повністю)|стягнути з/.test(t);
}
