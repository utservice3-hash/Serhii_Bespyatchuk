/**
 * 🔭 ХТО З ТРЬОХ ЧИТАЧІВ ЗОНИ ОЧІКУВАНЬ БАЧИТЬ УГОДУ — ОДНЕ МІСЦЕ ЗАМІСТЬ ТРЬОХ SQL.
 *
 * 🔴 ПРИВІД (01.09.2026). Плитка «Очікуємо» на КВП рахується
 * `metrics.expectedPaymentsByPlanned({})`, а рядки команд під нею —
 * `metrics.expectedZoneByScope({}, "team")`. Коментар над другою функцією стверджує
 * інваріант матрьошки: «Σ рядків = total». Він СЬОГОДНІ істинний — і НЕ за побудовою:
 *
 *   • `expectedPaymentsByPlanned` — `LEFT JOIN managers`, `is_active` лише за проханням
 *     (`activeOnly`), тобто бачить і угоди без менеджера, і угоди звільнених;
 *   • `expectedZoneByScope`/`expectedMonthByScope` — `JOIN managers … AND m.is_active`,
 *     а для `by="team"` ще й `JOIN teams`, тобто мовчки втрачають і тих, і тих, і
 *     менеджера без команди.
 *
 * 📐 ЗАМІРЯНО НА ПРОДІ 01.09.2026 21:32 (київський): зона = 336 угод / 837 043 ₴,
 * і всі три читачі дали ТЕ САМЕ число, бо **в кожному з чотирьох класів розбіжності
 * рівно 0 угод**. Тобто екран сходиться завдяки стану даних, а не завдяки коду.
 *
 * 🔴 І ЦЕЙ СТАН НЕ ВІЧНИЙ — він уже ламався в сусідньому місці. 05.08.2026 менеджера
 * деактивували в Kommo, а угоди перепризначили за пів години: у цю щілину
 * `Σ(менеджери)` стала на 16 567 ₴ меншою за `Σ(команди)`. Тут щілина буде та сама, а
 * симптом — гірший: плитка й сума рядків під нею розійдуться БЕЗ ЖОДНОГО видимого
 * сліду, бо жодне окреме число не виглядатиме дивним.
 *
 * ⚠️ ЦЕЙ МОДУЛЬ НІЧОГО НЕ ВИПРАВЛЯЄ. Зрівняти читачів — це зміна ПОВЕДІНКИ (гроші
 * звільнених або поїдуть у рядки команд, або зникнуть із плитки), а на неї є чинне
 * правило власника «`is_active` керує списками, а не історичними сумами» і окреме
 * рішення про згорнутий рядок «звільнені». Тому тут — лише ознака, за якою
 * розбіжність стає ГУЧНОЮ в день появи, а не через півроку на екрані.
 */

/** Три форми приєднання менеджера, якими три функції очікувань читають ОДНУ зону. */
export type ExpectReader = "planned" | "zoneManager" | "zoneTeam";

/** Угода зони очікувань разом із тим, ЩО про її менеджера знає таблиця `managers`. */
export interface ZoneDeal {
  kommoId: number;
  price: number;
  managerId: number | null;
  /** `null` — рядка в `managers` немає взагалі (осиротіле посилання), а не «неактивний». */
  managerActive: boolean | null;
  teamId: number | null;
}

/** Класи розбіжності — по одному на КОЖНУ причину відмови, без спільного смітника. */
export type DivergenceKlass = "no-manager" | "unknown-manager" | "inactive-manager" | "no-team";

export const KLASS_LABEL: Record<DivergenceKlass, string> = {
  "no-manager": "угода без менеджера (`manager_id IS NULL`)",
  "unknown-manager": "менеджера немає в `managers` (осиротіле посилання)",
  "inactive-manager": "менеджер неактивний (`m.is_active = false`)",
  "no-team": "менеджер активний, але без команди (`team_id IS NULL`)",
};

/**
 * Чи ДОХОДИТЬ угода до цього читача. Тіло — дослівний переказ трьох JOIN-ів, тому
 * зміна будь-якого з них має правитись ТУТ, а не третьою копією умови.
 */
export function reaches(d: ZoneDeal, by: ExpectReader): boolean {
  const hasMgr = d.managerId !== null && d.managerActive === true;
  if (by === "planned") return true;                 // LEFT JOIN, без is_active
  if (by === "zoneManager") return hasMgr;           // JOIN managers … AND m.is_active
  return hasMgr && d.teamId !== null;                // + JOIN teams
}

/**
 * Причина, з якої угода не доходить до всіх трьох, або `null` — доходить усюди.
 * 🔴 Порядок гілок — від найконкретнішої: інакше «немає команди» ковтало б і
 * «немає менеджера», і під одним підписом жили б дві різні відмови.
 */
export function divergenceKlass(d: ZoneDeal): DivergenceKlass | null {
  if (d.managerId === null) return "no-manager";
  if (d.managerActive === null) return "unknown-manager";
  if (!d.managerActive) return "inactive-manager";
  if (d.teamId === null) return "no-team";
  return null;
}

export interface DivergenceGroup { klass: DivergenceKlass; deals: number; sum: number; ids: number[] }

/** Розбіжність, згрупована за ПРИЧИНОЮ. Порожній масив = три читачі бачать одне й те саме. */
export function scopeDivergence(deals: readonly ZoneDeal[]): DivergenceGroup[] {
  const by = new Map<DivergenceKlass, DivergenceGroup>();
  for (const d of deals) {
    const k = divergenceKlass(d);
    if (k === null) continue;
    const g = by.get(k) ?? { klass: k, deals: 0, sum: 0, ids: [] };
    g.deals += 1; g.sum += d.price; g.ids.push(d.kommoId);
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => a.klass.localeCompare(b.klass));
}

export interface ReachTally { deals: number; sum: number }

/** Скільки бачить конкретний читач — саме те число, що потрапляє на екран. */
export function tallyFor(deals: readonly ZoneDeal[], by: ExpectReader): ReachTally {
  let n = 0, s = 0;
  for (const d of deals) if (reaches(d, by)) { n += 1; s += d.price; }
  return { deals: n, sum: s };
}
