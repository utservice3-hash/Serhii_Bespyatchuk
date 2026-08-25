import type {
  ReceivableAging, ReceivableCarrierPaid, ReceivableCarrierReason, ReceivableClient,
  ReceivableClientFacts, ReceivableEntity, ReceivableEntityReason, ReceivableTally,
} from "../../api";

/**
 * 🏷 ПІДПИСИ Й ФІЛЬТРИ ЕКРАНА ДЕБІТОРКИ — чисті функції, окремо від верстки.
 *
 * 🔴 Кожен «невідомо» тут МУСИТЬ мати власний підпис. Заміряно 24.08.2026:
 * невідомих юросіб три різні причини — 1С (14 рах. / 1 589 000 ₴), незаповнена
 * форма оплати (7 / 124 300 ₴) і битий лінк (1 / 4 700 ₴). Звести їх в одне
 * «—» означало б послати трьох різних людей робити три різні дії за однією
 * порожньою клітинкою.
 */

export const ENTITY_LABEL: Record<ReceivableEntity, string> = {
  uts: "ЮТС", avtomuv: "Автомув", fop: "ФОП", unknown: "невідомо",
};

export const ENTITY_REASON_LABEL: Record<ReceivableEntityReason, string> = {
  one_c: "виставлено через 1С",
  no_payment_type: "форма оплати не вказана",
  broken_link: "лінк не веде на угоду",
};

export const CARRIER_LABEL: Record<ReceivableCarrierPaid, string> = {
  paid: "перевізник оплачений", unpaid: "ще не оплачено", na: "н/д",
};

export const CARRIER_REASON_LABEL: Record<ReceivableCarrierReason, string> = {
  one_c: "виставлено через 1С",
  broken_link: "лінк не веде на угоду",
  out_of_map: "воронка поза мапою етапів",
};

/**
 * 🚚 КЛІТИНКА «ПЕРЕВІЗНИК» — ЧИСТЕ ПРАВИЛО, А НЕ ЛАНЦЮЖОК `&&` У ВЕРСТЦІ.
 *
 * 🔴 ТРИ СТАНИ, І ТРЕТІЙ НЕ Є ДРУГИМ. «Угоди немає» означає, що ми НЕ ЗНАЄМО,
 * а не що перевізник не оплачений. Заміряно на живому проді 25.08.2026:
 * рахунків 290 — оплачено 131 (3 240 342 ₴), не оплачено 142 (5 298 987 ₴),
 * «н/д» 17 (1 604 500 ₴, з них 15 виставлені через 1С). Показати «н/д» як
 * «ще не оплачено» означало б домалювати 1.6 млн неіснуючого факту — рівно та
 * підміна, яку в плитці вже тримає `#152`.
 *
 * Правило винесено з JSX навмисно: поки воно жило трьома `&&` у розмітці,
 * перевірити його можна було лише читанням тексту компонента, а гейт на текст
 * не бачить, що код РОБИТЬ (урок `#203`).
 */
export interface CarrierCell {
  text: string;
  /** Чому «не знаємо». `null` для двох визначених станів. */
  why: string | null;
  tone: "paid" | "unpaid" | "unknown";
}

export function carrierCell(
  state: ReceivableCarrierPaid | null,
  reason: ReceivableCarrierReason | null,
): CarrierCell {
  if (state === "paid") return { text: "✓ оплачений", why: null, tone: "paid" };
  if (state === "unpaid") return { text: "ще не оплачено", why: null, tone: "unpaid" };
  // `na` І `null` — один і той самий випадок «ми не знаємо». `null` приходить,
  // коли рахунок не зіставився з фактом; мовчки показати його як «не оплачено»
  // було б тією самою підміною, тільки без причини.
  return { text: "н/д", why: reason ? CARRIER_REASON_LABEL[reason] : null, tone: "unknown" };
}

export const AGING_ORDER: ReceivableAging[] = ["0-30", "31-60", "61-90", "90+"];
export const AGING_LABEL: Record<ReceivableAging, string> = {
  "0-30": "до 30 днів", "31-60": "31–60", "61-90": "61–90", "90+": "понад 90",
};

export const t = (x: ReceivableTally | undefined): ReceivableTally => x ?? { n: 0, amount: 0 };

// ───────────────────────────── ФІЛЬТРИ ─────────────────────────────

export type Tab = "all" | "overdue" | "aged";

export interface Filters {
  tab: Tab;
  entity: ReceivableEntity | "";
  carrier: ReceivableCarrierPaid | "";
  aging: ReceivableAging | "";
}

export const EMPTY_FILTERS: Filters = { tab: "all", entity: "", carrier: "", aging: "" };

/**
 * Прострочка. ЄДИНИЙ вираз на весь екран — плитка, червоний рядок, фільтр
 * «Прострочені» і підсумок менеджера беруть його, а не свою копію.
 *
 * 🔴 ПРАВИЛО ЗМІНЕНО В Е4 (рішення власника 24.08.2026): неузгоджений ліміт
 * поводиться як НУЛЬОВИЙ. Було `limitDays != null && overdue > limitDays` —
 * тобто клієнт без ліміту не потрапляв у прострочку НІЯК (`NULL > NULL` = NULL),
 * і плитка мовчки рахувала 39% дебіторки: 45 боржників із 74 на 1 683 550 ₴
 * не мали ліміту взагалі. Заміряно перед викатом: плитка 20 → 63.
 *
 * ⚠️ Дзеркалить `core/creditLimits.isOverdue` на бекенді. Дві мови — два файли,
 * але твердження одне, і `#188` звіряє їх на живих даних. Інакше екран і API
 * розійшлися б мовчки, як уже було з чипами «новий/постійний».
 */
export const isOverdue = (c: { overdueDays: number | null; limitDays: number | null }) =>
  c.overdueDays != null && c.overdueDays > (c.limitDays ?? 0);

/** Три стани ліміту — і кожен має СВІЙ підпис, бо «чому» в них різне. */
export type LimitState = "agreed" | "declined" | "never-set";

export function limitState(limitDays: number | null): LimitState {
  // ⚠️ Спершу null, потім нуль: `Number(null) === 0` дає true, і наївна
  // перевірка порахувала б 45 «нулів», яких немає. Я на цьому спіймався у
  // власному замірі — див. коментар у `core/creditLimits.ts`.
  if (limitDays == null) return "never-set";
  return Number(limitDays) === 0 ? "declined" : "agreed";
}

/**
 * 🔴 «0 днів» НЕ ПИШЕМО. Рішення власника: нуль означає «ліміт розглянули і не
 * дали», тобто перевізника ми не сплачуємо. Число «0» у колонці читалось би як
 * незаповнена комірка — рівно та підміна підпису, від якої береже правило
 * «невідоме має читатись як невідоме».
 */
export function limitLabel(limitDays: number | null): string {
  switch (limitState(limitDays)) {
    case "agreed": return `${limitDays} дн.`;
    // 🔴 ОБИДВА НЕУЗГОДЖЕНІ СТАНИ ПІДПИСАНІ В КОЛОНЦІ ОДНАКОВО — так у макеті,
    // затвердженому власником. І це не суперечить `#187`, а доповнює його:
    // для ЛЮДИНИ, що дивиться на колонку, обидва означають рівно одне —
    // відстрочки немає, перевізника не сплачуємо. Різниця «не дивились» проти
    // «подивились і відмовили» — це відповідь на «чому», і вона живе в
    // ПІДКАЗЦІ (`limitHint`), а не в двох схожих словах у вузькій клітинці.
    //
    // ⚠️ Стани в КОДІ лишаються різними (`declined` / `never-set`) — саме тому
    // `#187` перевіряє `limitState` і `limitHint`, а не `limitLabel`. Звести їх
    // в один стан «щоб простіше» означало б втратити відповідь назавжди.
    case "declined":
    case "never-set": return "не узгоджено";
  }
}

export function limitHint(limitDays: number | null): string {
  switch (limitState(limitDays)) {
    case "agreed":
      return `узгоджена відстрочка ${limitDays} дн. від дати рахунку`;
    case "declined":
      return "ліміт розглянули і не дали — перевізника не сплачуємо, поки клієнт не заплатить";
    case "never-set":
      return "ліміт цьому клієнту не встановлювали — перевізника не сплачуємо, поки клієнт не заплатить";
  }
}

/** Рахунок 2023 року в колонці «днів без оплати» читається як збій. Підписуємо. */
export const ANCIENT_DEBT_DAYS = 365;
export const isAncientDebt = (ageDays: number | null) =>
  ageDays != null && ageDays > ANCIENT_DEBT_DAYS;

/**
 * Чи лишається клієнт у списку під фільтрами.
 *
 * 🔴 «Має ХОЧА Б ОДИН рахунок у цьому зрізі», а не «весь клієнт такий». У ПВК
 * АРСЕНАЛ 11 рахунків із 40 виставлені через 1С — тобто клієнти БУВАЮТЬ
 * змішані, і фільтр «юрособа = ЮТС» мусить показувати такого клієнта, а не
 * ховати його через ті 11. Ховання тут читалось би як «клієнта немає».
 *
 * 🔴 Фільтра «джерело = 1С» тут НЕМАЄ і бути не має (рішення власника
 * 24.08.2026): 1С — це ЯРЛИК на рядку, а не окремий зріз екрана.
 */
export function passesFilters(c: ReceivableClient & { facts: ReceivableClientFacts | null }, f: Filters): boolean {
  if (f.tab === "overdue" && !isOverdue(c)) return false;
  if (f.tab === "aged" && t(c.facts?.aging["90+"]).n === 0) return false;
  if (f.entity && t(c.facts?.entity[f.entity]).n === 0) return false;
  if (f.carrier && t(c.facts?.carrier[f.carrier]).n === 0) return false;
  if (f.aging && t(c.facts?.aging[f.aging]).n === 0) return false;
  return true;
}

export const hasActiveFilters = (f: Filters) =>
  f.tab !== "all" || f.entity !== "" || f.carrier !== "" || f.aging !== "";

// ───────────────────────────── ЯРЛИКИ РЯДКА ─────────────────────────────

export interface RowBadge { icon: string; text: string; hint: string; tone: "warn" | "muted" }

/**
 * Ярлики походження рахунків клієнта.
 *
 * 🔴 ЧОМУ З ЧИСЛОМ, А НЕ ПРОСТО ЯРЛИК. Клієнт буває ЗМІШАНИЙ: у ПВК АРСЕНАЛ
 * 11 із 40 рахунків через 1С, решта 29 — звичайні угоди Kommo. Ярлик без числа
 * стверджував би, що весь клієнт такий, — і це була б неправда рівно про той
 * випадок, заради якого категорію й заводили.
 */
export function originBadges(f: ReceivableClientFacts | null): RowBadge[] {
  if (!f) return [];
  const out: RowBadge[] = [];
  const oneC = t(f.link.one_c);
  if (oneC.n > 0) out.push({
    icon: "🧾", tone: "muted",
    text: oneC.n === f.invoices ? "виставлено через 1С" : `1С · ${oneC.n} із ${f.invoices}`,
    hint: `Рахунки виставлені напряму в 1С, повз CRM — угоди в Kommo для них немає за задумом. ${oneC.n} рах.`,
  });
  const broken = t(f.link.broken_link);
  if (broken.n > 0) out.push({
    icon: "⚠️", tone: "warn",
    text: broken.n === f.invoices ? "лінк не веде на угоду" : `битий лінк · ${broken.n} із ${f.invoices}`,
    hint: "№ угоди в рахунку є, але такої угоди в CRM немає: або одруківка в 1С, або угоду видалили. Це НЕ те саме, що «виставлено через 1С».",
  });
  return out;
}

/**
 * Розклад юросіб клієнта — СПИСКОМ, а не «домінанта + ще».
 *
 * 🔴 Заголовок за найбільшою сумою бреше саме там, де болить: у ПВК АРСЕНАЛ
 * 29 рахунків із 40 — ЮТС, але 11 через 1С важать більше грошима, тож підпис
 * ставав «невідомо». Клієнт читався б як повністю невідомий, хоча про три
 * чверті його рахунків ми знаємо все. Розклад цього не робить у принципі.
 */
export function entityBreakdown(f: ReceivableClientFacts | null): { rows: { key: ReceivableEntity; label: string; n: number; amount: number }[]; hint: string } | null {
  if (!f) return null;
  const rows = (Object.keys(ENTITY_LABEL) as ReceivableEntity[])
    .map((k) => ({ key: k, label: ENTITY_LABEL[k], ...t(f.entity[k]) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.amount - a.amount);
  if (rows.length === 0) return null;
  const hint = rows.map((r) => `${r.label}: ${r.n} рах.`).join(" · ")
    + (f.entityReasons.length ? ` · невідомо тому, що ${f.entityReasons.map((r) => ENTITY_REASON_LABEL[r]).join(", ")}` : "");
  return { rows, hint };
}

// ───────────────────── ДІЇ: ВІДПОВІДАЛЬНИЙ І СКЛЕЙКА ─────────────────────

/**
 * 🔴 ТРИ СТАНИ ВІДПОВІДАЛЬНОГО, А НЕ ДВА.
 *
 * `auto` — правило вирішило само (мажоритар / тімлід / менеджер з угод CRM).
 * `manual` — людина СВІДОМО призначила когось.
 * `manual-none` — людина СВІДОМО сказала «нікого».
 *
 * Третій стан не можна зводити до першого: «нікого, бо так вирішили» і «нікого,
 * бо ще не дивились» — різні відповіді на одне питання, і саме їх розрізняє
 * `receivable_manager_override` (рядок є проти рядка немає). Той самий поділ
 * стереже `#127` у ядрі; тут його стереже `#162`.
 */
export type OwnerState = "auto" | "manual" | "manual-none";

export function ownerState(c: { ownerSource: string; managerName?: string }): OwnerState {
  if (c.ownerSource !== "override") return "auto";
  // Override стоїть, але людини немає → це свідоме «нікого».
  return c.managerName && c.managerName !== "Без відповідального" ? "manual" : "manual-none";
}

/**
 * Примітка при override ОБОВʼЯЗКОВА — і це `CHECK` у БД, а не побажання.
 *
 * 🔴 Та сама умова, що на сервері (`btrim(note) <> ''`), і перевіряється ДО
 * відправки. Не щоб «підстрахувати» сервер, а щоб людина побачила зрозумілу
 * відмову замість помилки з мережі. Рубежів три: кнопка → 400 роуту → `CHECK`.
 */
export const noteIsValid = (note: string): boolean => note.trim().length > 0;

/** Скільки лишилось до ліміту роуту (він ріже `note.slice(0, 300)`). */
export const NOTE_MAX = 300;

export interface MergeSide {
  clientKey: string;
  clientName: string;
  amount: number;
  invoices: number;
}

/**
 * Чи можна зливати цю пару — рівно ті випадки, які сервер відхилив би, тільки
 * сказані людині ДО запиту.
 *
 * 🔴 Ключ сам із собою — окремий випадок: у БД його ловить `CHECK
 * (alias_key <> canonical_key)`, тобто 400. Показати це в діалозі дешевше, ніж
 * пояснювати помилку драйвера.
 */
export function mergeProblem(a: MergeSide | null, b: MergeSide | null, reason: string): string | null {
  if (!a || !b) return "Оберіть обидві сторони";
  if (a.clientKey === b.clientKey) return "Не можна обʼєднати клієнта із самим собою";
  if (!reason.trim()) return "Причина обовʼязкова — реєстр без причини стає смітником";
  return null;
}
