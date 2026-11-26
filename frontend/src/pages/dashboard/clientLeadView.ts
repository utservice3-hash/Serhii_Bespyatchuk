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
  lead: { color: "green" | "yellow" | "red"; problem?: unknown; works: { yes: boolean } };
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
export interface LeadFilter { work: WorkFilter }
export const DEFAULT_LEAD_FILTER: LeadFilter = { work: "all" };

/** Чи фільтр щось звужує — щоб показати «скинути» і не ховати зелених мовчки. */
export function leadFilterActive(f: LeadFilter): boolean {
  return f.work !== "all";
}

/** Звуження списку. Кожна умова — «і»; вимкнена умова нічого не відсікає. */
export function applyLeadFilter<T extends LeadViewRow>(rows: readonly T[], f: LeadFilter): T[] {
  return rows.filter((r) => {
    if (f.work === "yes" && !r.lead.works.yes) return false;
    if (f.work === "no" && r.lead.works.yes) return false;
    return true;
  });
}

/** «Працюють X з N» для набору рядків: сума двох частин завжди дорівнює набору. */
export function workSplit(rows: readonly LeadViewRow[]): { yes: number; no: number; all: number } {
  const yes = rows.filter((r) => r.lead.works.yes).length;
  return { yes, no: rows.length - yes, all: rows.length };
}
