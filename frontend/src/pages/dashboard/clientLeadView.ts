/**
 * 🚦 «З КИМ ГОВОРИТИ» — ВИБІР КОЛЬОРУ Й ФІЛЬТРИ СПИСКУ (задача 11227; зустріч по дашборду 25.11.2026).
 *
 * На зустрічі: «нажав красні — випали всі красні всіх менеджерів», «за 20 секунд: з 274 червоних хто в роботі».
 * Тому колір — клікабельний на будь-якому рівні (компанія, команда, менеджер), а список можна звузити до тих,
 * з ким працюють, або тих, з ким роботи немає.
 *
 * 🔴 ТУТ НЕМАЄ ВЛАСНОГО ПРАВИЛА. Колір, «Проблемний», «працюють» приходять із сервера (`row.lead`, ядро
 * `core/clientLeadRules.ts`); модуль лише ВІДБИРАЄ рядки за вже порахованими ознаками.
 *
 * Модуль без імпортів: його транспілює й ВИКОНУЄ гейт `#11227*`, а не читає очима.
 */

export type LeadGroup = "green" | "yellow" | "red" | "problem";

/** Мінімум рядка, який читає цей модуль (структурно сумісний із `ClientPlanRow`). */
export interface LeadViewRow {
  lead: { color: "green" | "yellow" | "red"; problem?: unknown; works: { yes: boolean }; rhythm?: { over: boolean }; handOver?: boolean; orderDays?: number | null };
  /** 📞 Остання розмова (11224): київська дата і скільки днів тому; обидва `null` — розмов не було. */
  lastTalk?: string | null; lastTalkDays?: number | null;
  /** 📵 11226: стан номера з сервера (`phoneState`); `"none"` — у контактах клієнта в Kommo немає жодного номера. */
  phone?: "has" | "none";
  lifetimeRevenue?: number;
}

/** Група рядка: діюча позначка «Проблемний» (8350) переважає колір. */
export function leadGroupOf(r: LeadViewRow): LeadGroup {
  return r.lead.problem ? "problem" : r.lead.color;
}

/** Рядки обраної групи; `null` — колір не обрано, рядки як є. */
export function pickRows<T extends LeadViewRow>(rows: readonly T[], pick: LeadGroup | null): T[] {
  return pick == null ? [...rows] : rows.filter((r) => leadGroupOf(r) === pick);
}

export type WorkFilter = "all" | "yes" | "no";
/**
 * 📞 ДАВНІСТЬ ОСТАННЬОЇ РОЗМОВИ (11224; зустріч 25.11.2026: «дата останньої розмови + фільтр»). Пороги — лише для
 * відбору списку, це не правило кольору чи сегмента. `"none"` — розмов не було взагалі; число — «без розмови понад N
 * днів», і сюди ж ідуть ті, з ким не говорили ніколи (те саме означення, що фільтр «Без розмови 30+ днів» на «Плані місяця»).
 */
export const TALK_AGE_DAYS: readonly number[] = [14, 30, 60];
export type TalkFilter = "all" | "none" | number;
export function talkMatches(r: LeadViewRow, t: TalkFilter): boolean {
  if (t === "all") return true;
  if (t === "none") return r.lastTalk == null;
  return r.lastTalkDays == null || r.lastTalkDays > t;
}

export interface LeadFilter {
  work: WorkFilter;
  talk: TalkFilter;
  /** ⏱ 11228: лише ті, хто пропустив свій звичний ритм замовлень (ознака з сервера — `lead.rhythm.over`). */
  overRhythm: boolean;
  /** 📵 11226: лише клієнти без жодного номера в Kommo — розмову з ними телефонія привʼязати не може. */
  noPhone: boolean;
}
export const DEFAULT_LEAD_FILTER: LeadFilter = { work: "all", talk: "all", overRhythm: false, noPhone: false };

/** Чи фільтр щось звужує — щоб показати «скинути» і не ховати зелених мовчки. */
export function leadFilterActive(f: LeadFilter): boolean {
  return f.work !== "all" || f.talk !== "all" || f.overRhythm || f.noPhone;
}

/** Звуження списку. Кожна умова — «і»; вимкнена умова нічого не відсікає. */
export function applyLeadFilter<T extends LeadViewRow>(rows: readonly T[], f: LeadFilter): T[] {
  return rows.filter((r) => {
    if (f.work === "yes" && !r.lead.works.yes) return false;
    if (f.work === "no" && r.lead.works.yes) return false;
    if (!talkMatches(r, f.talk)) return false;
    if (f.overRhythm && !overRhythm(r)) return false;
    if (f.noPhone && !noPhone(r)) return false;
    return true;
  });
}

/** ⏱ Пропустив свій ритм (11228). Рядок без ознаки (старий сервер) — ні: невідоме не видаємо за сигнал. */
export function overRhythm(r: LeadViewRow): boolean {
  return r.lead.rhythm?.over === true;
}

/**
 * 📵 Без номера (11226; зустріч 25.11.2026: «клієнти без номера — в окремий список»). Ознака з сервера; рядок без неї
 * (старий сервер) — ні: «невідомо» не видаємо за «номера немає».
 */
export function noPhone(r: LeadViewRow): boolean {
  return r.phone === "none";
}

/** «Працюють X з N» для набору рядків: сума двох частин завжди дорівнює набору. */
export function workSplit(rows: readonly LeadViewRow[]): { yes: number; no: number; all: number } {
  const yes = rows.filter((r) => r.lead.works.yes).length;
  return { yes, no: rows.length - yes, all: rows.length };
}

/**
 * ↕️ ПОРЯДОК СПИСКУ (11224). `money` — як було: спершу «передати іншому», далі за грошима клієнта. `talk` — найдавніша
 * розмова зверху, а ті, з ким не говорили ніколи, — першими. `order` — хто довше без замовлення, зверху; без замовлень — першими.
 * Вхідний масив не змінюється; рівні рядки лишаються в порядку `money`.
 */
export type LeadSort = "money" | "talk" | "order";
export function sortLead<T extends LeadViewRow>(rows: readonly T[], by: LeadSort): T[] {
  const money = (a: T, b: T) => Number(b.lead.handOver ?? false) - Number(a.lead.handOver ?? false) || (b.lifetimeRevenue ?? 0) - (a.lifetimeRevenue ?? 0);
  const age = (v: number | null | undefined) => (v == null ? Number.POSITIVE_INFINITY : v);
  const cmpAge = (x: number, y: number) => (x === y ? 0 : y > x ? 1 : -1);
  return [...rows].sort((a, b) => {
    if (by === "talk") return cmpAge(age(a.lastTalkDays), age(b.lastTalkDays)) || money(a, b);
    if (by === "order") return cmpAge(age(a.lead.orderDays), age(b.lead.orderDays)) || money(a, b);
    return money(a, b);
  });
}
