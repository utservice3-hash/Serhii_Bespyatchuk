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
