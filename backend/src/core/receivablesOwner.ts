/**
 * 👤 ХТО ВІДПОВІДАЄ ЗА БОРГ КЛІЄНТА — фінальна модель (рішення власника 22.08.2026).
 *
 * Рядок дебіторки = ОДИН клієнт (канонічний `client_key`), із повною сумою боргу.
 * Ділити його на пари (клієнт, менеджер) ми перестали: так борг клієнта ніде не
 * було видно одним числом. Заміряно перед зміною: 299 рахунків давали 80 рядків
 * при 73 клієнтах, а найбільший боржник компанії (ПВК АРСЕНАЛ, 2 424 200 ₴) жив
 * як ЧОТИРИ рядки, найбільший з яких підписаний «Без менеджера».
 *
 * Ланцюг рішення, згори вниз:
 *   1. `override`      — ручне призначення адміном (таблиця приїде наступним комітом);
 *   2. `auto-majority` — менеджер із НАЙБІЛЬШОЮ СУМОЮ боргу цього клієнта;
 *   3. `auto-teamlead` — якщо мажоритар звільнений, відповідає тімлід його команди;
 *   4. `none`          — нікого визначити не вдалось.
 *
 * 🔴 ЧОМУ САМЕ СУМА, А НЕ «ОСТАННІЙ РАХУНОК». Попередня редакція правила брала
 * творця найсвіжішого рахунку, і на живих даних це віддавало АВТОСТРАДУ ВК
 * (1 034 500 ₴) Семенюку за ОДИН рахунок на 15 900 ₴ — 1.5% боргу, — забираючи
 * її в Шевчука з його 22 рахунками на 1 018 600 ₴. Сума описує, хто цього клієнта
 * реально веде; дата останнього рахунку — ні.
 *
 * ЧИСТИЙ МОДУЛЬ: ні мережі, ні БД. Факти про менеджерів (активність, тімліди)
 * приходять параметром, тож усе правило перевіряється у звичайному `npm test`,
 * а не лише проти прода.
 */

import { isActiveManager } from "./activeManager.js";

/** Рядок рахунку в обсязі, потрібному для вибору відповідального. */
export interface OwnerRow {
  managerId: number | null;
  amount: number;
  /** ISO `YYYY-MM-DD`; `null` — дата не витягнулась. Потрібна лише для тай-брейка. */
  invoiceDate: string | null;
}

/** Факти про менеджера. Джерело — БД, але правило про них нічого не знає. */
export interface ManagerFact {
  teamId: number | null;
  isTeamLead: boolean;
  kommoActive: boolean;
  /** Стани логінів (`users.is_active`); порожньо = логіна немає. */
  loginStates: boolean[];
}

export type OwnerSource = "override" | "auto-majority" | "auto-teamlead" | "cash-invoice" | "none";

export interface Responsible {
  managerId: number | null;
  source: OwnerSource;
  /** Мажоритар ДО перевірки активності — щоб екран міг сказати «замість звільненого X». */
  majorityId: number | null;
}

/**
 * 💵 ГОТІВКОВИЙ РЯДОК — менеджер уже ВІДОМИЙ, рахувати мажоритара нема чого.
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ НА ПРОДІ 23.08.2026. Рядок «МГЕР (готівка)» показував
 * «без відповідального · немає менеджера в рахунках», а підсумок «По
 * відповідальних» ТОЙ САМИЙ рядок зараховував Семенюку Дмитру — 224 917 ₴.
 * Обидва числа бралися з одного рядка `receivables`: список читав `owner_source`
 * (який лишався дефолтним `none`), підсумок — `manager_id` (заповнений із CRM).
 * Підпис і сума розповідали різне про одну людину.
 *
 * 🔴 ОКРЕМЕ ЗНАЧЕННЯ, А НЕ `auto-majority`. Мажоритар рахується по рахунках
 * дебіторки; готівковий менеджер приходить із УГОД CRM. Це різне походження, і
 * підпис на екрані мусить це казати — інакше ми знову маємо правильне число під
 * неправильним поясненням.
 *
 * ⚠️ `majorityId` тут ЗАВЖДИ `null`: жодного мажоритара не рахували, і вигадане
 * значення змусило б екран сказати «замість звільненого X» про людину, яку
 * ніхто не заміщав.
 *
 * Заміряно 23.08: cash-рядків 1, усі 11 його рахунків на одному менеджері;
 * cash-рядків БЕЗ менеджера — 0, але гілка потрібна: `insertCashReceivables`
 * ставить `null`, коли в жодної угоди немає виконавця.
 */
export function resolveCashOwner(managerId: number | null): Responsible {
  if (managerId == null) return { managerId: null, source: "none", majorityId: null };
  return { managerId, source: "cash-invoice", majorityId: null };
}

/** Явне рішення адміна. Сам факт наявності обʼєкта = override заданий. */
export interface OwnerOverride {
  /** `null` — СВІДОМО без відповідального (бухгалтерські рахунки). */
  managerId: number | null;
}

/**
 * Менеджер із найбільшою сумою боргу.
 *
 * 🔴 РАХУНКИ БЕЗ МЕНЕДЖЕРА В ЗМАГАННІ НЕ БЕРУТЬ УЧАСТІ. «Без менеджера» — це не
 * менеджер, це відсутність даних, і пускати відсутність вигравати означало б
 * зробити найбільшого боржника компанії нічийним ЗА ПРАВИЛОМ, а не за фактом:
 * у ПВК АРСЕНАЛ нічийна купа — 1 560 000 ₴ проти 780 000 ₴ у Яцика. Заміряно
 * 22.08.2026: різниця між двома прочитаннями — рівно цей один клієнт.
 *
 * Тай-брейк при РІВНИХ сумах — свіжіша дата рахунку. На сьогодні таких клієнтів
 * нуль (заміряно), але без детермінованого тай-брейка відповідальний стрибав би
 * між синками сам по собі, залежно від порядку рядків у відповіді 1С.
 */
export function majorityByAmount(rows: OwnerRow[]): { managerId: number | null; amount: number } {
  const byMgr = new Map<number, { amount: number; last: string }>();
  for (const r of rows) {
    if (r.managerId == null) continue;
    const e = byMgr.get(r.managerId) ?? { amount: 0, last: "" };
    e.amount += r.amount;
    if (r.invoiceDate != null && r.invoiceDate > e.last) e.last = r.invoiceDate;
    byMgr.set(r.managerId, e);
  }
  if (byMgr.size === 0) return { managerId: null, amount: 0 };
  const [id, e] = [...byMgr.entries()].sort(
    (a, b) => b[1].amount - a[1].amount || (a[1].last < b[1].last ? 1 : a[1].last > b[1].last ? -1 : a[0] - b[0])
  )[0];
  return { managerId: id, amount: e.amount };
}

/**
 * Відповідальний за клієнта.
 *
 * `facts` — мапа `managerId → ManagerFact`. Менеджера, якого в мапі немає,
 * вважаємо НЕактивним: невідомий стан не має тихо ставати «працює».
 *
 * ⚠️ Гілка `auto-teamlead` сьогодні не спрацьовує ЖОДНОГО разу — не тому, що
 * звільнених немає, а тому, що єдиний такий випадок (Міжнародна організація з
 * міграції → Косяк Дмитро) має `team_id IS NULL`, тобто команди в нього немає.
 * Механізм ставиться НАПЕРЕД і мовчить, поки не знадобиться, — як будильник `#59`.
 * Саме тому в нього є власний гейт: інакше він поїхав би в прод неперевіреним.
 */
export function resolveOwner(
  rows: OwnerRow[],
  facts: Map<number, ManagerFact>,
  override?: OwnerOverride | null
): Responsible {
  const majority = majorityByAmount(rows);
  // 🔴 `override` ІСНУЄ ≠ `override.managerId` ЗАПОВНЕНИЙ. Рядок із `managerId: null`
  // означає «адмін подивився й вирішив, що відповідального немає» — і це ІНША
  // відповідь, ніж «ми ще не дивились». Плутати їх не можна: перша забороняє авто,
  // друга його вмикає.
  if (override) {
    return { managerId: override.managerId, source: "override", majorityId: majority.managerId };
  }
  if (majority.managerId == null) {
    return { managerId: null, source: "none", majorityId: null };
  }
  const fact = facts.get(majority.managerId);
  if (fact && isActiveManager(fact)) {
    return { managerId: majority.managerId, source: "auto-majority", majorityId: majority.managerId };
  }
  const lead = fact != null ? activeTeamLead(fact.teamId, facts) : null;
  if (lead != null) {
    return { managerId: lead, source: "auto-teamlead", majorityId: majority.managerId };
  }
  // Звільнений мажоритар без активного тімліда (або без команди взагалі).
  // `none` тут — ВІДПОВІДЬ, а не прогалина, і екран мусить її підписати словами:
  // порожнє місце читається як «нічого немає», а не як «ми не знаємо».
  return { managerId: null, source: "none", majorityId: majority.managerId };
}

/** Активний тімлід команди; `null` — команди немає або тімлід у ній неактивний. */
export function activeTeamLead(teamId: number | null, facts: Map<number, ManagerFact>): number | null {
  if (teamId == null) return null;
  for (const [id, f] of facts) {
    if (f.teamId === teamId && f.isTeamLead && isActiveManager(f)) return id;
  }
  return null;
}

/** Підсумок по одному менеджеру всередині клієнта — для розкриття рядка. */
export interface ManagerSlice { managerId: number | null; amount: number; count: number }

/**
 * Розклад боргу клієнта по менеджерах — те, що бачить людина, розгорнувши рядок.
 *
 * 🔴 РАХУЄТЬСЯ ТИМ САМИМ ПЕРЕЛІКОМ, ЩО Й МАЖОРИТАР, і саме тому лежить поруч:
 * поки розклад і вибір відповідального жили б окремо, дописати правило в одне
 * й забути в другому було б справою рядка — і екран пояснював би число не тим
 * виразом, яким його порахував. Той самий урок, що чипи «новий/постійний».
 * Тут «Без менеджера» ПОКАЗУЄТЬСЯ (це видима купа), хоч у змаганні й не грає.
 */
export function sliceByManager(rows: OwnerRow[]): ManagerSlice[] {
  const by = new Map<number | null, ManagerSlice>();
  for (const r of rows) {
    const e = by.get(r.managerId) ?? { managerId: r.managerId, amount: 0, count: 0 };
    e.amount += r.amount;
    e.count++;
    by.set(r.managerId, e);
  }
  return [...by.values()].sort((a, b) => b.amount - a.amount);
}
