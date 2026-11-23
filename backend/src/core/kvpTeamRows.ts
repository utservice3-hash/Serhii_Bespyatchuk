/**
 * 🏅 РЯДКИ ТАБЛИЦІ «КОМАНДИ — ПЛАН / ФАКТ» У ЗВІТІ КВП: кого показувати і під якою назвою.
 *
 * 🔴 ПРИВІД (скріншот Романа 20.11.2026). Під пʼятьма продажними командами стояли три рядки БЕЗ НАЗВИ з нулями:
 * «Повний цикл» і двічі «Лідогенерація». Заміряно на проді того ж дня:
 *   · безіменний «Повний цикл» — команда 37283 «Комерційний відділ», у ній одна людина, КВП Левентова (без CRM);
 *   · друга «Лідогенерація» — команда 11 «Вікторія Демчук TeamLead»: три менеджери, жодного активного; «лідогенерацією»
 *     її робить лише старий запис у переліку (до 23.09 це була лідогенерація Ковтонюк);
 *   · справжня «Лідогенерація» — команда 50011, четверо активних.
 * Назви не було, бо команду без грошей у періоді заводив рядок плану менеджера — з порожнім іменем.
 *
 * Правило (рішення Романа 20.11.2026: «забрати повний цикл», «лідогенерація має бути одна»):
 *   рядок НЕ показується, коли він ПОРОЖНІЙ (план, факт, очікування й тижні — нулі) і водночас команда або не має
 *   жодного активного менеджера, або це відділ КВП (не продажний юніт). Порожня команда з живими менеджерами
 *   лишається: нуль у неї — це інформація, а не сміття.
 *
 * ⚠️ Гроші не ховаються НІКОЛИ: щойно в такої команди зʼявиться хоч гривня чи план, рядок повертається. Тому
 * Σ команд == відділ лишається чинною за побудовою — прибираються лише рядки з нулями.
 */

export interface KvpTeamRowLike {
  teamId: number;
  plan: number;
  revenue: number;
  expected: number;
  expectedThisMonth: number;
  expectedNextMonth: number;
  expectedPastMonths: number;
  weeks: readonly { plan: number; fact: number; expected: number; auto: number; leadsAd: number; leadsLeadgen: number }[];
}

/** Рядок без жодного числа: ні плану, ні грошей, ні очікувань, ні активності по тижнях. */
export function isEmptyKvpTeamRow(t: KvpTeamRowLike): boolean {
  return t.plan === 0 && t.revenue === 0 && t.expected === 0
    && t.expectedThisMonth === 0 && t.expectedNextMonth === 0 && t.expectedPastMonths === 0
    && t.weeks.every((w) => w.plan === 0 && w.fact === 0 && w.expected === 0 && w.auto === 0 && w.leadsAd === 0 && w.leadsLeadgen === 0);
}

/** Чи ховати рядок команди: лише порожній, і лише якщо команда без активних менеджерів або це відділ КВП. */
export function hideKvpTeamRow(t: KvpTeamRowLike, hasActiveManagers: boolean, kvpDeptTeamId: number): boolean {
  return isEmptyKvpTeamRow(t) && (!hasActiveManagers || t.teamId === kvpDeptTeamId);
}

/** Назва рядка: відома — як є; невідома — словами з номером, а не порожнім місцем (правило «невідоме читається як невідоме»). */
export function kvpTeamRowName(name: string | null | undefined, teamId: number): string {
  const n = (name ?? "").trim();
  return n !== "" ? n : `Команда #${String(teamId)}`;
}
