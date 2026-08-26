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


// ───────────────────── 💰 МАРЖИНАЛЬНІСТЬ І 🗑 СПИСАННЯ ─────────────────────

/**
 * 🔴 ПІДПИС КОЛОНКИ НАЗИВАЄ ЗНАМЕННИК, І ЦЕ НЕ ПЕДАНТИЗМ.
 *
 * Просто «маржинальність, %» читалась би як «% від боргу» — той самий клас, що
 * «Прострочено (понад ліміт)»: підпис технічно правдивий, а величина за ним
 * інша. Слово «PnL» тут заборонене окремо (`#199f`): це не звіт про прибутки,
 * а відношення двох полів CRM.
 */
export const MARGIN_LABEL = "маржинальність, % від суми рахунків";
export const EARNED_LABEL = "заробили";

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
/**
 * Підпис колонки. Величина — та сама, що «Заробили» в рядку клієнта.
 *
 * 🔴 ПІДПИС І ДЖЕРЕЛО НАЗИВАЮТЬСЯ ПО-РІЗНОМУ НАВМИСНО. У CRM це поле зветься
 * «Бюджет», і саме так його впізнає людина — тому джерело названо словами
 * власника В ПІДКАЗЦІ. Але `deals.price` у цьому продукті — це ВЖЕ МАРЖА
 * (підтверджено власником 25.08.2026), тож заголовок «Бюджет угоди» був би
 * правдоподібною назвою над іншою величиною — рівно тим класом, від якого
 * береже правило «підписуй, якою метрикою рахуєш». Заголовок каже ЗМІСТ,
 * підказка каже ЗВІДКИ.
 */
export const EARNED_COL_LABEL = "Заробили на угоді";

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
