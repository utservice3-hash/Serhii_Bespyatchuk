import { addDays, type PeriodState } from "./periodRules";

/**
 * 📵 ЧИСТІ ПРАВИЛА ВКЛАДКИ «ПРОПУЩЕНІ ДЗВІНКИ» — без React, щоб гейти бекенду їх ВИКОНУВАЛИ
 * (транспіляція на льоту, прийом `#138`), а не читали регуляркою.
 */

/**
 * 🔴 ДЕФОЛТ — «ВЧОРА», І ПЕРІОД СВІЙ, А НЕ СПІЛЬНИЙ `dateRange` (ТЗ §1.4 A, звірка 16.09.2026).
 * Доти вкладка брала `dateRange` із `localStorage`, а змінити його з видимих екранів неможливо
 * з 23.07.2026 (Огляд і Команди приховані). Тобто кожен бачив період, збережений при першому
 * заході, — і жодного способу його зсунути. Той самий дефект уже лікували на «Рекламі».
 * «Вчора», бо тімлід розбирає пропущені за минулий повний день; сьогоднішній ще не закінчився.
 */
export function missedDefaultPeriod(today: string): PeriodState {
  const y = addDays(today, -1);
  return { mode: "day", anchor: y, focusDay: y, rangeFrom: addDays(today, -7), rangeTo: y };
}

/**
 * День списку дзвінків (блок C) після зміни періоду. Той, що вже обрано, лишається, якщо входить у
 * новий період; інакше — кінець періоду, але НЕ майбутній день (рецензія 17.09.2026: «Поточний
 * тиждень» відкривав список на неділю й казав «пропущених немає»). Період цілком у майбутньому —
 * його початок.
 */
export function clampListDay(day: string | null, from: string, to: string, today: string): string {
  if (day && day >= from && day <= to) return day;
  if (to <= today) return to;
  return today >= from ? today : from;
}

/**
 * 📈 ПОКАЗНИКИ ГРАФІКА ДИНАМІКИ. Частки рахуються з лічильників КОЖНОЇ точки, а підсумок вікна —
 * зі СУМ (Σ не передзвонених ÷ Σ пропущених), не середнім відсотків: день із двома дзвінками не
 * може важити як день із сотнею. Медіана не усереднюється взагалі — у підсумку вікна її немає.
 */
export interface SeriesPointLike { missed: number; callback: number; clientSelf: number; medianMin: number | null }
export interface SeriesMetric {
  key: "missed" | "noCallbackPct" | "medianMin" | "clientSelfPct";
  label: string; unit: "" | "%" | "хв"; hint: string;
  value: (p: SeriesPointLike) => number | null;
  /** Підсумок вікна; `null` — показник не агрегується (медіана). */
  total: (ps: SeriesPointLike[]) => number | null;
}
const pctOf = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
export const SERIES_METRICS: SeriesMetric[] = [
  { key: "missed", label: "Пропущено", unit: "", hint: "Пропущені вхідні: без розмови, NO ANSWER або BUSY, плечі одного дзвінка склеєні.",
    value: (p) => p.missed, total: (ps) => ps.reduce((n, p) => n + p.missed, 0) },
  { key: "noCallbackPct", label: "Не передзвонили, %", unit: "%", hint: "Частка пропущених, на які за 24 год не було жодного вихідного на той самий номер. Ціль ТЗ рахується саме в цих термінах.",
    value: (p) => pctOf(p.missed - p.callback, p.missed),
    total: (ps) => pctOf(ps.reduce((n, p) => n + p.missed - p.callback, 0), ps.reduce((n, p) => n + p.missed, 0)) },
  { key: "medianMin", label: "Медіана передзвону, хв", unit: "хв", hint: "Медіана часу від пропущеного до першого вихідного — окремо в кожній точці; медіани не усереднюються.",
    value: (p) => p.medianMin, total: () => null },
  { key: "clientSelfPct", label: "Клієнт передзвонив сам, %", unit: "%", hint: "Частка пропущених, де клієнт сам набрав знову й дочекався відповіді. Не зараховується як наш передзвін.",
    value: (p) => pctOf(p.clientSelf, p.missed),
    total: (ps) => pctOf(ps.reduce((n, p) => n + p.clientSelf, 0), ps.reduce((n, p) => n + p.missed, 0)) },
];

export interface TeamLike { teamId: number | null }
export interface PersonLike { managerId: number | null; teamId: number | null }

/**
 * Розкладка людей під рядки команд. «Без відповідального» (managerId `null`) сюди НЕ йде —
 * у нього свій рядок. Людина, чия команда раптом не прийшла рядком, не зникає: вона
 * лишається в `orphans` і малюється окремо — втратити рядок мовчки гірше, ніж показати криво.
 */
export function groupByTeam<T extends TeamLike, P extends PersonLike>(teams: T[], people: P[]):
{ groups: { team: T; people: P[] }[]; orphans: P[] } {
  const humans = people.filter((p) => p.managerId !== null);
  const groups = teams.map((team) => ({ team, people: humans.filter((p) => p.teamId === team.teamId) }));
  const placed = new Set(groups.flatMap((g) => g.people));
  return { groups, orphans: humans.filter((p) => !placed.has(p)) };
}

/** Що стоїть у колонці «Клієнт» списку дзвінків. */
export type ClientCell = "unknown" | "open" | "known";

/**
 * 🔒 КАРТКА — ЛИШЕ ТОМУ, КОМУ ЇЇ ВІДДАСТЬ СЕРВЕР. Роут картки стоїть за вкладкою «Клієнти»
 * (`routeTab`: `client-card → loyalty`) і скоупом усередині. Кнопка без права давала б 403 у
 * відповідь на клік — тому без права пишемо «є в CRM», а не малюємо двері в стіну.
 */
export function clientCell(clientKey: string | null, canOpenClient: boolean): ClientCell {
  if (!clientKey || !clientKey.trim()) return "unknown";
  return canOpenClient ? "open" : "known";
}
