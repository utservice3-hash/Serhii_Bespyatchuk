import type {
  ReceivableAging, ReceivableCarrierPaid, ReceivableCarrierReason, ReceivableClient,
  ReceivableClientFacts, ReceivableEntity, ReceivableEntityReason, ReceivableMargin,
  ReceivableMarginUnknown, ReceivableTally,
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

/**
 * 🔴 ДРУГИЙ НАБІР ПІДПИСІВ — НЕ ДУБЛЬ, А ІНШЕ ТВЕРДЖЕННЯ (макет v6, 26.08.2026).
 *
 * `CARRIER_LABEL` описує СТАН ОДНОГО рахунка («перевізник оплачений»), і в
 * рядку рахунка лишається дослівно — саме його стереже `#197c`.
 * Тут — ПІДСУМОК по клієнту («не оплачено · 28»), де число вже несе «скільки»,
 * а слово «перевізник» повторюється в кожному з 78 рядків, не додаючи нічого:
 * колонка й так зветься «Перевізник».
 *
 * 📐 Чому взагалі скорочуємо: заміряно в браузері — клітинка 106px, а
 * «перевізник оплачений 10» у неї не влазить і переносить рядок, тобто
 * найдовший підпис задає висоту всій таблиці. У макеті колонка ширша (143px)
 * І підпис коротший; беремо обидва.
 *
 * ⚠️ «н/д» НЕ скорочується й не розшифровується: це третій стан «не знаємо»,
 * і будь-яке «зрозуміліше» слово тут перетворило б незнання на факт неоплати —
 * рівно те, від чого береже `#197c`.
 */
export const CARRIER_LABEL_SHORT: Record<ReceivableCarrierPaid, string> = {
  paid: "оплачено", unpaid: "не оплачено", na: "н/д",
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
  /** Сума виплати як ПІДПИС: число, «суму не вказано», або нічого при `na`. */
  amountText: string | null;
}

/**
 * 🚚 СУМА ВИПЛАТИ — ТРЕТІЙ АРГУМЕНТ, НЕОБОВʼЯЗКОВИЙ.
 *
 * 🔴 «Суму не вказано» — ОКРЕМИЙ стан, а не нуль і не «не оплачено». Заміряно
 * на живому Kommo 25.08.2026: умови виплати заповнені у 195 із 279 угод
 * дебіторки, тобто у 84 (30%) їх немає. Намалювати там «0 ₴» означало б
 * стверджувати, що перевізник отримав нуль, — той самий клас, що «угоди немає»
 * замість «не оплачено», який уже тримає `#205`.
 *
 * При `na` сума не показується взагалі: якщо ми не знаємо навіть ЧИ платили,
 * казати СКІЛЬКИ — це видавати здогад за факт.
 */
export function carrierCell(
  state: ReceivableCarrierPaid | null,
  reason: ReceivableCarrierReason | null,
  amount?: number | null,
): CarrierCell {
  const amt = amount == null
    ? (amount === undefined ? null : "суму не вказано")
    : `${Math.round(amount).toLocaleString("uk-UA")} ₴`;
  if (state === "paid") return { text: "✓ оплачений", why: null, tone: "paid", amountText: amt };
  if (state === "unpaid") return { text: "ще не оплачено", why: null, tone: "unpaid", amountText: amt };
  // `na` І `null` — один і той самий випадок «ми не знаємо». `null` приходить,
  // коли рахунок не зіставився з фактом; мовчки показати його як «не оплачено»
  // було б тією самою підміною, тільки без причини.
  return { text: "н/д", why: reason ? CARRIER_REASON_LABEL[reason] : null, tone: "unknown", amountText: null };
}

/**
 * 🔢 УКРАЇНСЬКИЙ ЧИСЛІВНИК — ТРИ ФОРМИ, А НЕ ОДНА.
 *
 * Знайшло ОКО на власному екрані: плитка архіву писала «**1 рахунків ·
 * 1 клієнтів**». Жоден гейт цього не бачить — рядок склеюється з числа й
 * зашитого слова, обидва по-своєму правильні. Той самий клас, що «амсфарм»
 * у колонці «Клієнт»: текст у списку не перевіряє ніщо.
 *
 * Правило стандартне для української: 11-14 — завжди форма «багато».
 *
 * @param one   1 рахунок · 1 клієнт
 * @param few   2-4 рахунки · 2-4 клієнти
 * @param many  5-20, 0, 11-14 → рахунків · клієнтів
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n));
  const mod100 = a % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = a % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** `1 рахунок` · `2 рахунки` · `5 рахунків` — число разом зі своєю формою. */
export const nPlural = (n: number, one: string, few: string, many: string): string =>
  `${n} ${plural(n, one, few, many)}`;

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
  /**
   * 🔧 `"na_fixable"` — НЕ стан, а ПІДМНОЖИНА «н/д» за ПРИЧИНОЮ: битий лінк і
   * воронка поза мапою. Заміряно 25.08.2026: із 21 «н/д» лагодяться рівно 2,
   * решта 19 — рахунки з 1С, де угоди немає В ПРИНЦИПІ. Поки вони в одній купі,
   * ті два тонуть, і список «н/д» читається як «нічого не вдіяти».
   */
  carrier: ReceivableCarrierPaid | "na_fixable" | "";
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
  if (f.carrier === "na_fixable") {
    const why = c.facts?.carrierReasons ?? [];
    if (!why.includes("broken_link") && !why.includes("out_of_map")) return false;
  } else if (f.carrier && t(c.facts?.carrier[f.carrier]).n === 0) return false;
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
  /**
   * 🔗 Скільки псевдонімів цей ключ УЖЕ приймає (0 — жодного). Приходить із
   * сервера (`canonicalOf`), фронт цього не виводить: реєстр знає лише БД.
   */
  alreadyCanonical: number;
}

/**
 * Чи можна зливати цей НАБІР — рівно ті випадки, які сервер відхилив би, тільки
 * сказані людині ДО запиту.
 *
 * 🔴 Ключ сам із собою — окремий випадок: у БД його ловить `CHECK
 * (alias_key <> canonical_key)`, тобто 400. Показати це в діалозі дешевше, ніж
 * пояснювати помилку драйвера.
 *
 * 🔴 І ЛАНЦЮЖОК — ТЕЖ. Ключ, що вже є канонічним, псевдонімом стати не може:
 * тригер `client_key_alias_no_chain` відхиляє це в БД. Без перевірки тут людина
 * дізнавалась би правило з тексту 409 — тобто вчилась би на приреченій дії.
 * Заборона однобічна: приймати ще одного псевдоніма такий ключ МОЖЕ (на проді
 * один тримає 11), тож перевіряється саме роль «псевдонім», а не участь.
 */
export function mergeProblem(
  aliases: readonly MergeSide[], canonical: MergeSide | null, reason: string
): string | null {
  if (!canonical) return "Оберіть основного клієнта";
  if (!aliases.length) return "Оберіть, кого приєднати";
  if (aliases.some((a) => a.clientKey === canonical.clientKey))
    return "Не можна обʼєднати клієнта із самим собою";
  const chained = aliases.find((a) => a.alreadyCanonical > 0);
  if (chained) {
    return `«${chained.clientName}» уже обʼєднує ${chained.alreadyCanonical} — він може бути лише основним`;
  }
  if (!reason.trim()) return "Причина обовʼязкова — реєстр без причини стає смітником";
  return null;
}

/**
 * Підсумок «що стане після обʼєднання». Одне джерело для рядка підтвердження —
 * інакше сума в підсумку і сума в списку одного дня розійдуться.
 */
export function mergeSummary(aliases: readonly MergeSide[], canonical: MergeSide | null) {
  const all = canonical ? [canonical, ...aliases] : aliases;
  return {
    parties: all.length,
    amount: all.reduce((s, x) => s + x.amount, 0),
    invoices: all.reduce((s, x) => s + x.invoices, 0),
  };
}

/**
 * 🧾 ПРАВИЛО ЗВЕДЕННЯ ЛІМІТІВ — СЛОВАМИ, А НЕ ЧИСЛОМ.
 *
 * 🔴 І ЦЕ СВІДОМА ВІДМОВА ВІД ПЕРЕДПОКАЗУ. Показати тут ГОТОВЕ зведене число
 * означало б порахувати його вдруге — на фронті, копією правила, що живе в
 * `backend/src/core/mergeLimits.ts`. Дві копії одного правила збігаються рівно
 * доти, доки ніхто не правив одну з них, і розходяться мовчки (12.6% угод у
 * чипах «новий/постійний»). Число приходить із відповіді сервера ПІСЛЯ дії;
 * до дії людина читає ПРАВИЛО.
 */
export const MERGE_LIMIT_RULE =
  "Ліміти зведуться: днів — менший із погоджених, сума — складеться (відмова «0 ₴» додає нуль). "
  + "У примітці ліміту лишиться запис про зведення.";


// ───────────────────── 💰 МАРЖИНАЛЬНІСТЬ І 🗑 СПИСАННЯ ─────────────────────

/**
 * 🔴 ПІДПИС КОЛОНКИ НАЗИВАЄ ЗНАМЕННИК, І ЦЕ НЕ ПЕДАНТИЗМ.
 *
 * Просто «маржинальність, %» читалась би як «% від боргу» — той самий клас, що
 * «Прострочено (понад ліміт)»: підпис технічно правдивий, а величина за ним
 * інша. Слово «PnL» тут заборонене окремо (`#199f`): це не звіт про прибутки,
 * а відношення двох полів CRM.
 */

export const MARGIN_UNKNOWN_LABEL: Record<ReceivableMarginUnknown, string> = {
  no_deal: "немає звʼязку з угодою",
  no_base: "у CRM не вказана сума угоди",
};

/**
 * Текст відсотка. `—` там, де рахувати нема з чого, і НІКОЛИ нуль: нуль означав
 * би «не заробили», а ми не знаємо. Заміряно: 5 клієнтів із 76 без звʼязаної
 * угоди — саме вони мусять дати «—».
 *
 * Відʼємні показуються ЯК Є: 3 угоди з відʼємним `price`, усі три з
 * `is_minus = true` — це коректне сторно, і ховати правильне число, бо воно
 * негарне, ми не будемо.
 */
export function marginPctText(m: ReceivableMargin | null): string {
  if (!m || m.pct == null) return "—";
  return `${m.pct.toFixed(1)}%`;
}

/** Чому «—». Порожнє місце читається як «нічого немає», а не як «не знаємо». */
export function marginHint(m: ReceivableMargin | null): string {
  if (!m) return "рахунків у деталізації немає";
  if (m.why) return MARGIN_UNKNOWN_LABEL[m.why];
  return `заробили ${Math.round(m.earned ?? 0).toLocaleString("uk-UA")} ₴ від суми рахунків `
    + `${Math.round(m.base ?? 0).toLocaleString("uk-UA")} ₴`;
}

/**
 * 🗑 ПІДПИС СПИСАНОГО. `null` — нічого не списано, і тоді рядка на екрані немає:
 * «списано: 0 на 0 ₴» у кожному рядку перетворив би сигнал на шум (той самий
 * висновок, що з «у т.ч. від менеджерів без плану» — підпис лише коли ≠ 0).
 *
 * 🔴 І ВІН ОБОВʼЯЗКОВИЙ ТАМ, ДЕ СПИСАННЯ Є. Списання ЗМЕНШУЄ суму; плитка, що
 * мовчки просіла, читається як поломка, а не як рішення людини.
 */
export function writtenOffLabel(n: number, amount: number): string | null {
  if (!n) return null;
  return `списано: ${n} на ${Math.round(amount).toLocaleString("uk-UA")} ₴`;
}

/**
 * Чи можна відправляти списання. Ті самі умови, що на сервері, тільки сказані
 * людині ДО запиту: рубежів три — кнопка → 400 роуту → `CHECK` у БД.
 */
export function writeoffProblem(note: string): string | null {
  if (!noteIsValid(note)) return "Причина обовʼязкова — списання без «чому» через місяць не відрізнити від помилки";
  return null;
}

// ───────────────── 💰 ЗАРОБІТОК ПО КОЖНОМУ РАХУНКУ В РОЗКРИТТІ ─────────────────

/**
 * 🔴 ЗАРОБІТОК НАЛЕЖИТЬ УГОДІ, А НЕ РАХУНКУ — І САМЕ ЦЕ РОБИТЬ ПРАВИЛО ПОТРІБНИМ.
 *
 * Кілька рахунків можуть посилатись на ОДНУ угоду. Намалювати число в кожному
 * рядку означало б, що Σ колонки перевищить «заробили» в рядку клієнта рівно на
 * кількість дублів — тобто ми власними руками завели б ЩЕ ОДНЕ «два джерела
 * одного числа», через добу після того, як полагодили попереднє.
 *
 * Тому значення несе ПЕРШИЙ рядок угоди, решта отримують позначку «та сама
 * угода» БЕЗ числа. Підсумок у шапці рахується ЛИШЕ з намальованих значень
 * (`earnedShownTotal`), тож розійтись із колонкою він не може в принципі.
 *
 * 📐 ЗАМІРЯНО НА ЖИВОМУ ПРОДІ 26.08.2026, І ЗАМІР ЗМІНИВ ГЕЙТ: 302 рахунки ·
 * 283 з лінком · 283 УНІКАЛЬНІ угоди · рядків «та сама угода» — **НУЛЬ**.
 * Розрив «315 рахунків проти 295 угод» — це рахунки БЕЗ лінка, а не дублі.
 * Отже гейт, побудований на наявності дублів у проді, був би зелений незалежно
 * від коду — рівно пастка `#56b`/`#61b`. Тому механізм перевіряється на ВЛАСНІЙ
 * фікстурі, а живі дані — РІВНІСТЮ (істинна і при нулі дублів).
 *
 * 🔴 СПИСАНИЙ РЯДОК ЧИСЛА НЕ НЕСЕ, і це не косметика: `foldFacts` виключає
 * списані рахунки ДО дедупу угод, тож у «заробили» рядка клієнта їхня угода
 * входить лише через НЕсписаний рахунок. Дай списаному рядку число — і Σ
 * колонки перевищить «заробили» рівно на нього.
 */
export type EarnedUnknown = "one_c" | "broken_link" | "no_price";

export type EarnedCell =
  | { kind: "value"; earned: number }
  | { kind: "same-deal" }
  | { kind: "written-off" }
  | { kind: "unknown"; why: EarnedUnknown };

export const EARNED_UNKNOWN_LABEL: Record<EarnedUnknown, string> = {
  one_c: "виставлено через 1С — угоди немає за задумом",
  broken_link: "лінк не веде на угоду",
  no_price: "у CRM не вказано суму угоди",
};

export const EARNED_SAME_DEAL_LABEL = "та сама угода";
export const EARNED_WRITTEN_OFF_LABEL = "списано";
/*
 * 🗑 `EARNED_COL_LABEL` ПРИБРАНО 26.08.2026 — і причина варта запису.
 *
 * Константа несла підпис ВЛАСНОЇ колонки вкладеної таблиці розкриття. Після
 * переверстки розкриття — рядки ТІЄЇ САМОЇ таблиці, тож власного заголовка в
 * нього більше немає: колонка підписана спільним «Заробили» в шапці. Константа
 * лишилась у коді, читалась як робоча, і `#198i` її БЛАГОСЛОВЛЯВ — тобто гейт
 * стеріг те, чого на екрані немає.
 *
 * Спіймав це не гейт і не око, а `grep` по БАНДЛУ: маркер «Заробили на угоді»
 * дав нуль збігів, бо мертвий експорт вирізало tree-shaking. Той самий клас, що
 * `BandHead` і `expected`: код, написаний для іншої верстки, читається як живий.
 *
 * Гейт тепер звіряє СПРАВЖНІЙ заголовок у шапці, а не константу.
 */

export interface EarnedRow {
  dealId: number | null;
  dealFound: boolean;
  earned: number | null;
  writtenOff: boolean;
}

/**
 * Клітинки колонки в ПОРЯДКУ ВІДОБРАЖЕННЯ. Дедуп мусить іти тим самим порядком,
 * у якому людина читає таблицю, — інакше «перший рядок угоди» на екрані й у
 * розрахунку були б різними рядками.
 */
export function earnedCells(rows: EarnedRow[]): EarnedCell[] {
  const seen = new Set<number>();
  return rows.map((r) => {
    if (r.dealId == null) return { kind: "unknown", why: "one_c" } as const;
    if (!r.dealFound) return { kind: "unknown", why: "broken_link" } as const;
    if (r.writtenOff) return { kind: "written-off" } as const;
    if (seen.has(r.dealId)) return { kind: "same-deal" } as const;
    seen.add(r.dealId);
    if (r.earned == null) return { kind: "unknown", why: "no_price" } as const;
    return { kind: "value", earned: r.earned } as const;
  });
}

/**
 * 🔴 ПІДСУМОК СКЛАДАЄТЬСЯ З ТОГО, ЩО НАМАЛЬОВАНО, а не рахується вдруге з
 * вихідних рядків. Другий вираз для одного числа розходиться мовчки — саме так
 * плитка дебіторки просідала при незміненому рядку клієнта.
 */
export function earnedShownTotal(cells: EarnedCell[]): number {
  return cells.reduce((s, c) => s + (c.kind === "value" ? c.earned : 0), 0);
}

/** Текст клітинки — усе, крім числа; число форматує верстка своїм `formatAmount`. */
export function earnedCellText(c: EarnedCell): string | null {
  if (c.kind === "value") return null;
  if (c.kind === "same-deal") return EARNED_SAME_DEAL_LABEL;
  if (c.kind === "written-off") return EARNED_WRITTEN_OFF_LABEL;
  return "—";
}

/** Підказка. «—» без пояснення — порожнє місце, а воно читається як «нічого немає». */
export function earnedCellHint(c: EarnedCell): string {
  if (c.kind === "value") return "наш заробіток по цій угоді — поле «Бюджет» з картки угоди в CRM (те саме число, що в рядку клієнта)";
  if (c.kind === "same-deal") return "цей рахунок належить угоді, заробіток якої вже показано вище — щоб Σ колонки не подвоїлась";
  if (c.kind === "written-off") return "рахунок списано як безнадійний — у «заробили» він не входить";
  return EARNED_UNKNOWN_LABEL[c.why];
}

// ───────────── 🗜 ЗГОРНУТІ КОЛОНКИ: ОДИН РЯДОК + РОЗКЛАД У ПІДКАЗЦІ ─────────────

/**
 * 🔴 БАГАТОРЯДКОВИЙ БЛОК У КЛІТИНЦІ РОЗДУВАВ ВИСОТУ ВСЬОГО РЯДКА.
 *
 * «ЮТС 27 / Автомув 3 / невідомо 11» трьома рядками робить рядок клієнта втричі
 * вищим — а таких колонок дві, юрособа й перевізник. Заміряно в проході 2:
 * саме чипи, а не другий рядок під контролом, тримали висоту в 66 рядках із 76.
 *
 * Тому в клітинці — НАЙБІЛЬША складова одним рядком, повний розклад у підказці.
 * Це не приховування: підказка є біля кожного показника (правило власника), і
 * саме там живе відповідь на «з чого це число».
 */
export interface Folded {
  /** Що показати в клітинці: найбільша складова. */
  head: string;
  /** Скільки рахунків у ній. */
  n: number;
  /** Повний розклад для підказки — усі складові через «·». */
  full: string;
  /** Скільки складових усього: 1 → підказка не додає нічого нового. */
  parts: number;
}

const foldTally = <K extends string>(
  m: Partial<Record<K, ReceivableTally>>, label: (k: K) => string, order: readonly K[],
): Folded | null => {
  const rows = order.map((k) => ({ k, ...t(m[k]) })).filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!rows.length) return null;
  return {
    head: label(rows[0].k), n: rows[0].n,
    full: rows.map((r) => `${label(r.k)} ${r.n}`).join(" · "),
    parts: rows.length,
  };
};

const ENTITY_ORDER: readonly ReceivableEntity[] = ["uts", "avtomuv", "fop", "unknown"];
const CARRIER_ORDER: readonly ReceivableCarrierPaid[] = ["paid", "unpaid", "na"];

export const foldEntity = (f: ReceivableClientFacts | null): Folded | null =>
  f ? foldTally(f.entity, (k) => ENTITY_LABEL[k], ENTITY_ORDER) : null;

export const foldCarrier = (f: ReceivableClientFacts | null): Folded | null =>
  f ? foldTally(f.carrier, (k) => CARRIER_LABEL_SHORT[k], CARRIER_ORDER) : null;

// ───────────── 🗓 КОМЕНТАР ТИЖНЯ: ЛІНИВА МЕЖА, БЕЗ ЖОДНОЇ ДЖОБИ ─────────────

/**
 * 🔴 НІЧОГО НЕ ЗАТИРАЄМО — ЗМІНЮЄТЬСЯ ЛИШЕ ТЕ, ЩО ВВАЖАЄТЬСЯ АКТИВНИМ.
 *
 * Джоба, що щопонеділка чистить поле, — це незворотна втрата даних заради
 * косметики, і вона ще й не спрацює, якщо в понеділок сервер лежав. Правило
 * натомість чисте: активним є запис, зроблений ПІСЛЯ початку поточного тижня.
 * Тоді нічого не гине, крона немає, і межа працює навіть після простою.
 *
 * 🔴 ПОНЕДІЛОК 00:00 ЗА КИЄВОМ, а не за UTC і не за часом браузера. Той самий
 * якір, що в усіх періодах продукту; за UTC у ніч на понеділок межа зсунулась би
 * на 2-3 години, і запис, зроблений о 01:00 у понеділок, читався б як минулого
 * тижня.
 */
export const KYIV_TZ = "Europe/Kyiv";

/**
 * 🔴 РОЗБІР ДАТИ, ЩО НЕ КИДАЄ — І ЦЕ НЕ ПЕРЕСТРАХОВКА, А ЗАКРИТА АВАРІЯ.
 *
 * 26.08.2026 розділ дебіторки ліг ЦІЛКОМ: «Invalid time value» замість таблиці.
 * Причина — Postgres `to_char(..., 'OF')` віддає ДВОЗНАЧНЕ зміщення (`+03`), а
 * ECMAScript вимагає `±HH:mm`. `new Date("2026-08-26T10:21:50+03")` дає Invalid
 * Date, `Intl.format` на ньому КИДАЄ, і виняток усередині `.map` по рядках
 * убиває всю секцію — не клітинку, не рядок, а екран.
 *
 * ⚠️ І ГІПОТЕЗА «падають ті, у кого дати НЕМА» була ХИБНОЮ: саме там стоїть
 * сторож і все гаразд. Падали ті, у кого дата Є — 49 із 76. Перевіряти треба
 * не правдоподібне, а відтворюване.
 *
 * Тому: `null` там, де дати немає АБО вона нерозбірна. Відсутнє значення має
 * свій СТАН, а не виняток — те саме правило, що «н/д» ≠ нуль.
 */
export function parseDateSafe(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d;
  // Добираємо двозначне зміщення Postgres до канонічного `±HH:mm`.
  const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})([+-]\d{2})$/.exec(v);
  if (m) {
    const d2 = new Date(`${m[1].replace(" ", "T")}${m[2]}:00`);
    if (!Number.isNaN(d2.getTime())) return d2;
  }
  return null;
}

/**
 * Формат дати для екрана, що НЕ кидає. `fallback` — те, що людина побачить
 * замість числа: порожнє місце читається як «нічого немає», а не як «не знаємо».
 */
export function formatDateSafe(v: string | null | undefined, fallback = "дати немає"): string {
  const d = parseDateSafe(v);
  return d ? d.toLocaleDateString("uk-UA") : fallback;
}

/** Київська дата (YYYY-MM-DD) моменту — без залежності від часу браузера. */
export function kyivDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KYIV_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

/** Київський день тижня: 1 = понеділок … 7 = неділя. */
export function kyivWeekday(at: Date): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: KYIV_TZ, weekday: "short" }).format(at);
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(s) + 1;
}

/** Київський понеділок поточного тижня, як YYYY-MM-DD. */
export function weekStartKyiv(now: Date): string {
  const back = kyivWeekday(now) - 1;
  const d = new Date(now.getTime() - back * 86400000);
  return kyivDate(d);
}

/**
 * Чи є цей запис домовленістю ПОТОЧНОГО тижня.
 *
 * `null`/порожньо — ні; торішній текст — теж ні, і саме в цьому сенс: порожнє
 * поле чесно каже «на цей тиждень домовленості ще немає», а старий текст
 * виглядав би як актуальна обіцянка.
 */
export function isCurrentWeekNote(updatedAt: string | null, now: Date): boolean {
  // 🔴 ДРУГИЙ РУБІЖ. Бекенд тепер віддає канонічний ISO, але правило не має
  // права падати від формату: виняток тут убиває ВЕСЬ екран, а не одну дату.
  // Нерозбірна дата = «не цього тижня», тобто запис поводиться як старий і
  // лишається досяжним в історії — найгірше, що станеться, це зайвий перехід
  // у журнал. Проти мертвої секції це не ціна.
  const d = parseDateSafe(updatedAt);
  if (!d) return false;
  return kyivDate(d) >= weekStartKyiv(now);
}

/** Що показувати в полі: текст поточного тижня або порожнеча. */
export function activeNote(
  comment: string | null, updatedAt: string | null, now: Date,
): string {
  return isCurrentWeekNote(updatedAt, now) ? (comment ?? "") : "";
}

/** Підпис порожнього стану — він мусить бути ВІДПОВІДДЮ, а не порожнім місцем. */
export const NOTE_EMPTY_PLACEHOLDER = "на цей тиждень ще не записано…";

/**
 * 🗓 ДОМОВЛЕНІСТЬ ОДНИМ РЯДКОМ (макет v6.1, прохід B).
 *
 * 🔴 НАВІЩО ЧИСТА ФУНКЦІЯ, А НЕ РОЗМІТКА В СЕКЦІЇ. Колонка згортається з
 * трьох контролів (`input[type=date]` + `CommentField` + кнопка) в ОДИН рядок,
 * і саме тут найлегше загубити зміст: дата без коментаря, коментар без дати,
 * порожнеча, що читається як «нічого немає» замість «цього тижня не писали».
 * Чотири стани мають бути перелічені в одному місці й перевірятись без DOM.
 *
 * ⚠️ ТИЖНЕВА МЕЖА СЮДИ НЕ ПЕРЕЇЖДЖАЄ. На вхід подається ВЖЕ звужений
 * `activeNote(...)` — тобто запис ПОТОЧНОГО тижня. Якби функція сама вирішувала,
 * що показати, правило «активний лише запис цього тижня» існувало б двічі, і
 * поповер редагував би не те, що показано в рядку.
 */
export interface AgreementLine {
  /** Дата обіцянки або порожньо — порожня НЕ означає «немає домовленості». */
  dateText: string;
  /** Текст запису поточного тижня; порожній рядок, коли його немає. */
  text: string;
  /** Обидві половини порожні — рядок показує підпис порожнього стану. */
  empty: boolean;
  /** Повний текст для підказки: обрізання не має ховати зміст. */
  tip: string;
}

export function agreementLine(dueDate: string | null, note: string): AgreementLine {
  const text = (note ?? "").trim();
  const hasDate = !!dueDate && formatDateSafe(dueDate, "") !== "";
  const dateText = hasDate ? formatDateSafe(dueDate) : "";
  const empty = !hasDate && text === "";
  const tip = empty
    ? "Записів за поточний тиждень немає. Натисніть, щоб додати дату й коментар."
    : [hasDate ? `Обіцяли ${dateText}.` : "Дати немає.",
       text ? `«${text}»` : "Коментаря цього тижня немає.",
       "Натисніть, щоб змінити."].join(" ");
  return { dateText, text, empty, tip };
}

/** Підпис порожньої домовленості в рядку — відповідь, а не порожнє місце. */
export const AGREEMENT_EMPTY_LABEL = "записів немає";

/* ═══════════════════════════════════════════════════════════════════════════
   🏢 РОЗКЛАД «ЮРОСОБА → СУМА» У ЗГОРНУТОМУ РЯДКУ

   Скарга власника дослівно: «коли обʼєднуємо клієнтів, в загальному списку не
   зрозуміло стає по якій компанії борг». Отже підпис потрібен САМЕ в списку,
   без кліку — у розкритті юрособа була видна й до цього.

   🔴 ЗАЛИШОК НАЗИВАЄТЬСЯ ЧИСЛОМ. Сума рядка приходить із `receivables`, розклад
   — із `receivable_invoices`; це різні таблиці, і по всіх 63 рядках вони
   розходяться в 11 (заміряно 01.09.2026). Показати доданки під сумою, якій
   вони не дорівнюють, — це «гарна неправда»: вона переконлива саме тим, що не
   сходиться непомітно. Тож або Δ = 0 і залишку немає, або залишок видно.
   ═══════════════════════════════════════════════════════════════════════════ */

export interface BreakdownPart { key: string; name: string | null; n: number; amount: number }
export interface BreakdownIn { parts: BreakdownPart[]; remainder: number; ok: boolean; show: boolean }

export interface BreakdownLine {
  /** Готові підписи «НАЗВА — сума ₴», у порядку ядра. */
  items: { key: string; label: string }[];
  /** Підпис нерознесеного залишку або `null`, коли розклад сходиться. */
  remainderLabel: string | null;
}

/** Той самий підпис, що в ядрі: юрособи в рахунку не вказано. */
export const BREAKDOWN_UNKNOWN = "юрособу не вказано";

const uah = (n: number): string =>
  `${Math.round(n).toLocaleString("uk-UA")} ₴`;

/**
 * Готує розклад до показу. `null` — показувати нічого (юрособа одна або їх
 * немає); саме так виглядають 61 рядок із 63, і вони не змінюються взагалі.
 */
export function breakdownLine(b: BreakdownIn | null | undefined): BreakdownLine | null {
  if (!b || !b.show || b.parts.length === 0) return null;
  const items = b.parts.map((p) => ({
    key: p.key,
    label: `${(p.name ?? "").trim() || BREAKDOWN_UNKNOWN} — ${uah(p.amount)}`,
  }));
  // Округлення до гривні може зробити копійчану різницю невидимою — тому
  // вирішує `ok` із ядра (епсилон), а не порівняння вже відформатованих рядків.
  return { items, remainderLabel: b.ok ? null : `не рознесено — ${uah(b.remainder)}` };
}

/**
 * Підпис «ще N» для нотаток, узятих із набору псевдонімів.
 *
 * 🔴 З НАЗВАМИ, А НЕ САМИМ ЧИСЛОМ. «Ще 2» без назв — та сама хвороба, з якої
 * почалась заявка: людина бачить, що чогось не видно, і не знає чого.
 */
/**
 * 🏢 ЮРОСОБА НАВПРОТИ КОЖНОГО РАХУНКУ — лише коли їх у клієнта БІЛЬШЕ ОДНІЄЇ.
 *
 * Скарга власника дослівно: «треба бачити навпроти кожного рахунку яка компанія».
 * Підпис «усередині 3 юрособи» називає СКЛАД, але не каже, ЯКИЙ рахунок чий, — а в
 * розкритті їх 64.
 *
 * 🔴 УМОВУ РАХУЄМО ПО ВСЬОМУ СПИСКУ РАХУНКІВ, А НЕ ПО ОДНОМУ. «Чи юросіб більше
 * однієї» — властивість КЛІЄНТА, і питати про неї в кожного рахунка окремо означало б
 * дати різну відповідь на різних рядках. Той самий урок, що «рівно один» рахується
 * серед усіх кандидатів, а не серед тих, хто спитав.
 *
 * У 62 незлитих клієнтів підпису немає взагалі: там юрособа одна, і підпис у кожному
 * рядку був би шумом — правило «невідоме має бути видимим ТАМ, ДЕ ЙОГО ВИДНО».
 */
export function invoiceEntityShown(
  invoices: readonly { entityKey?: string | null; entityName?: string | null }[] | null | undefined,
): boolean {
  const keys = new Set<string>();
  for (const x of invoices ?? []) keys.add((x.entityKey ?? "").trim());
  return keys.size > 1;
}

/** Підпис юрособи для одного рахунка. `null` — показувати нічого. */
export function invoiceEntityLabel(
  inv: { entityKey?: string | null; entityName?: string | null },
  shown: boolean,
): string | null {
  if (!shown) return null;
  const n = (inv.entityName ?? "").trim();
  return n === "" ? BREAKDOWN_UNKNOWN : n;
}

export function noteOthersLabel(names: readonly string[] | null | undefined): string | null {
  const list = (names ?? []).filter((s) => (s ?? "").trim() !== "");
  return list.length === 0 ? null : `ще ${list.length}: ${list.join(", ")}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   🕐 ШТАМП РАХУНКУ: ДАТА + ЧАС, І ПОРОЖНІЙ ЧАС — ЦЕ ВІДПОВІДЬ

   🔴 `null` У ЧАСІ НЕ ДОРІВНЮЄ «00:00». 1С пише сентинел `00:00:00`, коли часу
   не записано, і парсер (`core/receivables1c.invoiceRefOf`) перетворює його на
   `null` ОДИН раз. Заміряно на живому фіді 27.08.2026: із 293 рядків **121**
   саме такі. Доказ, що це заглушка, а не мить доби: у годині `00` немає жодного
   ІНШОГО значення, тоді як решта годин дає нормальний робочий день (пік 09-13).

   Тому екран показує дату й підписує брак часу словами, а не малює «00:00» —
   інакше 121 рахунок отримав би впевнену мить, якої ми не знаємо.
   ═══════════════════════════════════════════════════════════════════════════ */

export interface InvoiceStamp {
  /** «26.08.2026» або підпис порожнього стану. */
  date: string;
  /** «14:46» або `null` — часу не записано. */
  time: string | null;
  /** Що показати замість часу. Порожнеча мусить читатись як відповідь. */
  timeLabel: string;
}

export function invoiceStamp(date: string | null, time: string | null): InvoiceStamp {
  // Секунди на екран не йдуть: вони не несуть рішення, а колонку розширюють.
  const hhmm = time && /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : null;
  return {
    date: formatDateSafe(date, "дати немає"),
    time: hhmm,
    timeLabel: hhmm ?? "часу не записано",
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ↕️ СОРТУВАННЯ СПИСКУ БОРЖНИКІВ (рішення власника 27.08.2026)

   Дослівно: «хочу тиснути на суму, к-сть днів і бачити зверху більше, а знизу
   найменше». Отже лише клікабельні заголовки — ані діапазонів, ані порогів,
   ані фільтра по менеджеру.

   📐 Заміряно ПЕРЕД роботою: список УЖЕ відсортований за боргом спадно. Тобто
   будується КЕРУВАННЯ, а поведінка за замовчуванням не змінюється — і це
   важливо сказати вголос, бо інакше «нічого не змінилось» читалось би як
   «не викотилось».

   🔴 ЧОМУ ЧИСТА ФУНКЦІЯ. Дві з трьох пасток нижче ламають екран ТИХО: числа
   лишаються правильними, і помічає їх лише той, хто дивиться на порядок рядків.
   Такі речі перевіряються значенням, а не оком.
   ═══════════════════════════════════════════════════════════════════════════ */

export type SortKey = "amount" | "days";
export type SortDir = "desc" | "asc";
export interface SortState { key: SortKey; dir: SortDir }

/** Дефолт дорівнює тому, що вже було на екрані: борг спадно. */
export const DEFAULT_SORT: SortState = { key: "amount", dir: "desc" };

/** Клік по активній колонці перевертає напрям; по іншій — бере її зі спадного. */
export function nextSort(cur: SortState, key: SortKey): SortState {
  if (cur.key !== key) return { key, dir: "desc" };
  return { key, dir: cur.dir === "desc" ? "asc" : "desc" };
}

/** Стрілка напряму — щоб дві числові колонки не плутались між собою. */
export const sortMark = (cur: SortState, key: SortKey): string =>
  cur.key !== key ? "" : cur.dir === "desc" ? " ↓" : " ↑";

/** Значення `aria-sort` для `<th>`: порядок мусить бути чутним, а не лише видимим. */
export const ariaSort = (cur: SortState, key: SortKey): "descending" | "ascending" | "none" =>
  cur.key !== key ? "none" : cur.dir === "desc" ? "descending" : "ascending";

export interface SortableRow { amount: number; overdueDays: number | null }

/**
 * 🔴 ТРИ ПАСТКИ, КОЖНА З ЯКИХ ЗЛАМАЛА Б ЦЕ ТИХО.
 *
 * 1. **Рахунки їдуть за своїм клієнтом.** Розкриття рендериться рядками ТІЄЇ
 *    САМОЇ таблиці — так зроблено навмисно, щоб колонки збігались за побудовою.
 *    Тому сортувати можна ЛИШЕ клієнтів: функція бере список клієнтів і нічого
 *    не знає про рахунки, а секція малює розкриття одразу за своїм рядком. Якби
 *    сортувався плаский список рядків, рахунки роз'їхались би по таблиці.
 *
 * 2. **«—» НЕ Є НУЛЕМ.** У колонці «Днів» частина клієнтів має `null` — і після
 *    фікса «списаний клієнт зникає» їх побільшало. Порожнє значення йде в
 *    КІНЕЦЬ в ОБИДВА боки, окремою групою: інакше «не знаємо» опинилось би
 *    серед «нуль днів прострочки», тобто найспокійніші й найзагадковіші рядки
 *    злиплись би в один блок.
 *
 * 3. **Сортування СТАБІЛЬНЕ.** Рівні значення не сміють перескакувати між
 *    перерендерами — рядок під курсором має лишатись тим самим рядком. Другий
 *    ключ — позиція у вхідному списку, тобто той порядок, у якому список і так
 *    упорядкований (борг спадно).
 */
export function sortClients<T extends SortableRow>(rows: readonly T[], sort: SortState): T[] {
  const valueOf = (r: T): number | null => (sort.key === "amount" ? r.amount : r.overdueDays);
  const sign = sort.dir === "desc" ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const va = valueOf(a.row), vb = valueOf(b.row);
      // Пастка 2: порожнє — окрема група В КІНЦІ, і напрям на неї не впливає.
      const na = va == null, nb = vb == null;
      if (na !== nb) return na ? 1 : -1;
      if (!na && !nb && va !== vb) return sign * (va! - vb!);
      // Пастка 3: рівні (і обидва порожні) лишаються у вхідному порядку.
      return a.i - b.i;
    })
    .map((x) => x.row);
}

/* ═══════════════════════════════════════════════════════════════════════════
   💰 ЛІМІТ ПО СУМІ — ДЗЕРКАЛО `core/creditLimits` ДРУГОЮ МОВОЮ

   ⚠️ Дві мови — два файли, і саме тому `#199be` звіряє ЗНАЧЕННЯ обох копій,
   а не текст. Дзеркало підказок маржі (`#199af`) вже показало, чим це
   закінчується інакше: гейти читали копію ядра, а екран малював фронтову, і
   саботаж «поміняти причини місцями У ФРОНТІ» лишав усе зеленим.
   ═══════════════════════════════════════════════════════════════════════════ */

export type AmountLimitState = "agreed" | "declined" | "never-set";

/**
 * ⚠️ NULL-ПАСТКА, ТА САМА, ЩО В ДНЯХ, І ТУТ ВОНА ДОРОЖЧА: `Number(null) === 0`,
 * тож наївне порівняння зробило б «розглянули і не дали» ВСІМ, кому суму просто
 * не ставили — а на момент викату це всі 78 боржників до одного.
 */
export function amountLimitState(limitAmount: number | null): AmountLimitState {
  if (limitAmount == null) return "never-set";
  return Number(limitAmount) === 0 ? "declined" : "agreed";
}

/** Борг перейшов узгоджену суму. Неузгоджений ліміт = нульовий (рішення 26.08.2026). */
export const isOverAmount = (c: { amount: number | null; limitAmount: number | null }) =>
  c.amount != null && Number(c.amount) > Number(c.limitAmount ?? 0);

/** Підпис у клітинці. Не «0 ₴» — це число читається як помилка заповнення. */
export function amountLimitLabel(limitAmount: number | null): string {
  switch (amountLimitState(limitAmount)) {
    case "agreed": return `${Math.round(Number(limitAmount)).toLocaleString("uk-UA")} ₴`;
    case "declined":
    case "never-set": return "не узгоджено";
  }
}

/** Розгорнуте «чому» — у підказці, як і в днях. */
export function amountLimitHint(limitAmount: number | null): string {
  switch (amountLimitState(limitAmount)) {
    case "agreed":
      return `узгоджений ліміт боргу ${Math.round(Number(limitAmount)).toLocaleString("uk-UA")} ₴`;
    case "declined":
      return "ліміт суми розглянули і не дали — будь-який борг вважається перевищенням";
    case "never-set":
      return "ліміт суми цьому клієнту не встановлювали — будь-який борг вважається перевищенням";
  }
}

/**
 * 🧾 Заголовок задачі на перегляд ліміту — дзеркало `core/creditLimits.limitRequestTitle`.
 * Тімлід читає його в списку своєї команди; без клієнта й суми це «дайте ліміт»
 * без предмета — задача, яку неможливо виконати, не відкривши її.
 */
export function limitRequestTitle(clientName: string, debt: number, limitAmount: number | null): string {
  const money = (n: number) => `${Math.round(n).toLocaleString("uk-UA")} ₴`;
  const lim = amountLimitState(limitAmount) === "agreed" ? money(Number(limitAmount)) : "не встановлено";
  return `Ліміт по сумі: ${clientName} — борг ${money(debt)}, ліміт ${lim}`;
}


// ─────────────────────── 💰 «ГРОШІ ЗАЙШЛИ» (28.08.2026) ───────────────────────

/**
 * 🔴 ЧОТИРИ ВІДПОВІДІ, І ЖОДНА НЕ ПОРОЖНЯ.
 *
 * Порожня клітинка читається як «нічого немає», а не як «ми не зіставили» —
 * тому «не зіставлено» тут ТЕКСТ, а не відсутність. Це те саме правило, через
 * яке «н/д» у перевізнику носить причину.
 *
 * 🔴 І `ambiguous` НЕ ЗВОДИТЬСЯ до «не зіставлено» (рішення власника
 * 28.08.2026): там є ПРИЧИНА, і назвати її означає дати людині розвʼязати це
 * очима за дві секунди замість пошуку наосліп.
 *
 * ⚠️ ФРОНТ НІЧОГО НЕ ВИРІШУЄ. `kind` приходить із сервера (`core/paymentMatch`);
 * тут лише підпис. Друге рішення на фронті розійшлося б із сервером мовчки —
 * рівно те, що дало чипи «новий/постійний».
 */
export type SeenTone = "ok" | "warn" | "muted";

export interface SeenCell { text: string; why: string | null; tone: SeenTone }

export function seenCell(s: PaymentSeenLike | null | undefined): SeenCell {
  const kind = s?.kind ?? "none";
  const on = s?.bookedOn ? formatDateSafe(s.bookedOn) : null;
  switch (kind) {
    case "seen":
      return { text: on ? `💰 зайшли ${on}` : "💰 зайшли", tone: "ok",
        why: "гроші видно у виписці; рахунок зникне, щойно бухгалтерія його рознесе" };
    case "stale":
      // 🔴 НЕ ЗНИКАЄ, А КАЖЕ ПРО СЕБЕ. Мовчазне зникнення забрало б єдиний слід
      // того, що гроші прийшли не за цим рахунком.
      return { text: on ? `💰 зайшли ${on} · не рознесено` : "💰 не рознесено", tone: "warn",
        why: `гроші видно ${s?.workdays ?? "?"} роб. дн., а рознесення не сталося — перевірте, чи це оплата саме цього рахунку` };
    case "ambiguous":
      return { text: "платіж називає кілька рахунків", tone: "warn",
        why: "один платіж посилається на кілька відкритих рахунків — ми не вгадуємо, який саме оплачено" };
    default:
      return { text: "не зіставлено", tone: "muted",
        why: "у виписці немає платежу, який однозначно вказує на цей рахунок" };
  }
}

/** Мінімум, потрібний підпису. Ширший тип живе в `api.ts`. */
export interface PaymentSeenLike {
  kind: "seen" | "stale" | "ambiguous" | "none";
  bookedOn?: string | null;
  workdays?: number | null;
}

/**
 * Згортка в рядку клієнта: «💰 2 з 5». `null` — рахунків немає, і тоді нічого
 * не показуємо: це не «не зіставлено», а «нема чого зіставляти».
 *
 * 🔴 `stale` І `ambiguous` НАЗИВАЮТЬСЯ ОКРЕМО, а не тонуть у «2 з 5»: саме вони
 * і є привід відкрити клієнта.
 */
export function seenRollLabel(r: { seen: number; stale: number; ambiguous: number; total: number } | null | undefined):
  { text: string; tone: SeenTone } | null {
  if (!r || r.total === 0) return null;
  const withMoney = r.seen + r.stale;
  if (withMoney === 0 && r.ambiguous === 0) return null;
  const parts = [`💰 ${withMoney} з ${r.total}`];
  if (r.stale) parts.push(`${r.stale} не рознесено`);
  if (r.ambiguous) parts.push(`${r.ambiguous} неоднозначних`);
  return { text: parts.join(" · "), tone: r.stale || r.ambiguous ? "warn" : "ok" };
}

/**
 * 🔑 ІДЕНТИЧНІСТЬ РЯДКА ДЕБІТОРКИ — ВІД КЛІЄНТА, І ТІЛЬКИ ВІД НЬОГО.
 *
 * 🔴 Було `key={`${c.clientKey}-${i}`}` — з ІНДЕКСОМ у списку. Список сортується
 * за сумою спадно, суми міняються щоразу, коли дебіторку перечитують із 1С
 * (TRUNCATE+insert кожні 15 хв) або коли екран сам робить рефетч. Щойно рядок
 * переїжджає, його `key` стає іншим, і React РОЗМОНТОВУЄ його разом із відкритим
 * редактором домовленості — набраний, але не збережений текст зникає без сліду.
 *
 * Ключ — функція КЛІЄНТА, не позиції: тоді пересортування рухає рядок, а не
 * створює новий. Заміряно на проді 01.09.2026: 60 рядків, 60 різних `client_key`,
 * тож ключ унікальний і без індексу.
 */
export function receivableRowKey(c: { clientKey: string }): string {
  return c.clientKey;
}
