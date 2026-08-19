/**
 * 📋 РЕЄСТР КОЛОНОК ТАБЛИЧНОГО ВИГЛЯДУ ЗВІТУ — ЧИСТИЙ МОДУЛЬ (19.08.2026).
 *
 * 🔴 НАВІЩО ОКРЕМИЙ ФАЙЛ БЕЗ REACT. Колонка складається з трьох різних речей:
 * що показати, за чим сортувати і як згорнути в підсумок. Поки вони живуть
 * усередині JSX, кожна нова колонка — це три місця, де можна розійтись, і жодне
 * з них не перевіряється нічим, окрім ока. Тут вони лежать ОДНИМ записом, тож
 * «колонка є, а підсумок від іншого поля» стає неможливим за побудовою.
 *
 * 🔴 ПІДСУМКИ НЕ НАЇВНІ, І ЦЕ ГОЛОВНЕ. Σ по стовпчику правильна лише для
 * лічильних і грошових колонок. Сер.чек, Викон.% і Конверсія — ЧАСТКИ: їхня
 * «сума» рахується від Σ чисельника й Σ знаменника, а не складанням часток.
 * Наївний `sum()` дав би три неправильні числа, і жодне з них не виглядало б
 * дивним — рівно той клас, що вже коштував нам «середнє середніх» у доборі
 * (завищення на 87 955 ₴ при кожному окремо правильному числі).
 */
import type { ReportPlanManager } from "../../api";

export type ColKey =
  | "rank" | "name" | "status" | "created" | "ads" | "leadgen" | "conv"
  | "dispatch" | "avgCheck" | "fact" | "plan" | "pct"
  | "projected" | "needPerDay" | "expectThisMonth" | "awaitNoDate"
  | "jamDeals" | "jam" | "dobir" | "talks" | "dispRevenue" | "responseTime";

/**
 * Як колонка згортається в підсумковий рядок.
 * · `add`  — Σ значень (лічильні, гроші);
 * · `none` — підсумку немає (ім'я, ранг, статус);
 * · `ratio:*` — ЧАСТКА: Σ чисельника ÷ Σ знаменника, а не Σ часток.
 */
export type FootKind = "add" | "none" | "ratio:avgCheck" | "ratio:pct" | "ratio:conv" | "share:none";

/**
 * Дані, яких НЕМАЄ в рядку менеджера, але за якими треба сортувати.
 * Поки що це лише частка повільних лідів: вона приходить окремим запитом і не
 * може лежати в `ReportPlanManager`.
 */
export interface SortCtx { slowByMgr?: Map<number, number | null> }

export interface ColDef {
  key: ColKey;
  /** Підпис у шапці. */
  title: string;
  /** Колонка з набору «завжди видимих» (чипом не вимикається). */
  core: boolean;
  /** Ліве вирівнювання (текстові колонки). */
  left?: boolean;
  /** Значення для СОРТУВАННЯ. `null` = «немає даних» і завжди їде донизу. */
  val: (m: ReportPlanManager, ctx?: SortCtx) => number | string | null;
  foot: FootKind;
  /** Підказка ⓘ — там, де підпис сам по собі збрехав би про природу числа. */
  hint?: string;
}

/** «Немає даних» ≠ «нуль». Конверсія `null` при <10 взятих — це не 0%. */
const numOrNull = (v: number | null | undefined): number | null =>
  v == null ? null : v;

export const REPORT_COLS: ColDef[] = [
  { key: "rank", title: "#", core: true, left: true, val: () => null, foot: "none" },
  { key: "name", title: "Менеджер", core: true, left: true, val: (m) => m.name, foot: "none" },
  // 🔴 СТАТУС — ВІД ТЕМПУ, А НЕ ВІД ВІДСОТКА. `status` рахує бекенд як
  // `(факт/план) ÷ частка робочих днів, що минули`; на 3-й день місяця 20% плану
  // це «в нормі», а не «зрив». Фарбувати крапку за `pct` означало б завести на
  // екрані другу, іншу відповідь на те саме питання.
  { key: "status", title: "Статус", core: true, val: (m) => m.status === "r" ? 0 : m.status === "a" ? 1 : 2, foot: "none",
    hint: "Світлофор рахується від ТЕМПУ: факт ÷ план ÷ частка робочих днів, що минули. Тому на початку місяця низький % ще не «зрив»." },
  { key: "created", title: "Створено", core: true, val: (m) => m.created, foot: "add" },
  { key: "ads", title: "Реклама", core: true, val: (m) => numOrNull(m.kpi.ads.fact), foot: "add" },
  { key: "leadgen", title: "Лідоген", core: true, val: (m) => numOrNull(m.kpi.leadgen.fact), foot: "add" },
  { key: "conv", title: "Конв. Р+Л", core: true, val: (m) => numOrNull(m.kpi.conversion.fact), foot: "ratio:conv",
    hint: "Когортна конверсія по угодах повного циклу з каналом «реклама» або «лідоген»: скільки з узятих дійшли до грошової зони. Менше 10 узятих — «—», бо відсоток від трьох угод нічого не означає." },
  { key: "dispatch", title: "Авто ф/ц", core: true, val: (m) => numOrNull(m.kpi.dispatch.fact), foot: "add",
    hint: "Факт / ціль. Ціль береться ЛИШЕ з тижневої задачі Задачника — місячної цілі по показниках більше немає, тож у місячному вигляді ціль часто «—»." },
  { key: "avgCheck", title: "Сер. чек", core: true, val: (m) => numOrNull(m.kpi.avgCheck.fact), foot: "ratio:avgCheck",
    hint: "ЗНІМКОВА величина: пул «угоди ЗАРАЗ у роботі (авто працює → оплата отримана) ⊎ виграні за період». Не чисто за період, на відміну від решти колонок." },
  { key: "fact", title: "Отримано", core: true, val: (m) => m.fact, foot: "add",
    hint: "② «успішно реалізовано» ⊎ «оплата отримана», з дедупом. Та сама цифра, що у картковому вигляді." },
  { key: "plan", title: "План міс.", core: true, val: (m) => m.plan, foot: "add" },
  { key: "pct", title: "Викон.", core: true, val: (m) => m.pct, foot: "ratio:pct" },

  { key: "projected", title: "Прогноз", core: false, val: (m) => (m.monthInProgress ? m.projected : null), foot: "add",
    hint: "Факт + очікування з плановою датою оплати в цьому ж місяці. Рахується ЛИШЕ для повного поточного місяця; для тижня, діапазону й завершеного місяця прогнозу немає — там стояв би факт під чужим підписом." },
  { key: "needPerDay", title: "Треба ₴/д", core: false, val: (m) => m.needPerDay, foot: "add" },
  { key: "expectThisMonth", title: "Очікує (дата)", core: false, val: (m) => m.expectThisMonth, foot: "add",
    hint: "За ПЛАНОВОЮ датою оплати, календарний місяць. НЕ залежить від обраного періоду." },
  { key: "awaitNoDate", title: "Без дати", core: false, val: (m) => m.cohort.awaitNoDateSum, foot: "add",
    hint: "Відправлено й не оплачено, планової дати немає. У прогноз НЕ входить: поки дати немає, це намір, а не домовленість." },
  // 🔴 «ЗАТОР», А НЕ «ЗАСТРЯГЛО»: слово «застрягло» в Звіті вже зайняте списком
  // угод без руху ≥21 дня (`stuck-deals`) — геть інша множина. Дві різні речі під
  // одним підписом на одному екрані ми вже проходили з двома «очікуємо».
  { key: "jamDeals", title: "Затор (рах.)", core: false, val: (m) => m.jamDeals, foot: "add",
    hint: "Скільки угод з очікувань стоїть на стадії «Виставлення рахунку». Це НЕ «застряглі угоди» (ті — без руху ≥21 дня, окремий блок нижче)." },
  { key: "jam", title: "Затор ₴", core: false, val: (m) => m.jam, foot: "add" },
  { key: "dobir", title: "Добір", core: false, val: (m) => m.dobir, foot: "add",
    hint: "Скільки менеджер ЗАЗВИЧАЙ добирає нового бізнесу — середнє за 3 місяці, а не конкретні угоди. У прогноз не входить." },
  { key: "talks", title: "Дзвінки", core: false, val: (m) => m.talks, foot: "add",
    hint: "Розмови (від 10 c) / спроби. ДВІ різні цифри — складати їх заборонено: це відповіді на різні питання." },
  { key: "dispRevenue", title: "Авто-сума", core: false, val: (m) => numOrNull(m.kpi.dispatch.revenue), foot: "add" },
  // 🔴 ЧАСТКА, А НЕ МЕДІАНА (рішення власника 19.08.2026). Медіана на проді
  // виявилась нульовою майже в усіх — 69% лідів опрацьовані менш ніж за хвилину,
  // тож колонка казала б «усі миттєві» й ховала хвіст, заради якого існує.
  { key: "responseTime", title: "Ліди >1год", core: false,
    val: (m, ctx) => ctx?.slowByMgr?.get(m.managerId) ?? null, foot: "share:none",
    hint: "Частка вхідних лідів, які чекали першого контакту ПОНАД ГОДИНУ. Рахується лише по воронці «Кваліфікація» — це реакція на вхідний лід, а не на угоду повного циклу. «—» означає «лідів у періоді не було», а не «швидко». Підсумку немає: частка від часток не є часткою." },
];

/** Опційні колонки, увімкнені за замовчуванням (решта — вимкнені). */
export const DEFAULT_OPT_ON: Record<string, boolean> = {
  projected: true, needPerDay: true, expectThisMonth: true, awaitNoDate: true,
  jamDeals: true, responseTime: true,
  jam: false, dobir: false, talks: false, dispRevenue: false,
};

export const OPTIONAL_COLS = REPORT_COLS.filter((c) => !c.core);

/**
 * СОРТУВАННЯ. `null` — це «даних немає», і воно ЗАВЖДИ внизу, у будь-якому
 * напрямку: інакше перемикання ↑↓ піднімало б нагору порожні рядки, і таблиця
 * читалась би як «у цих найгірше», хоч про них просто нічого не відомо.
 */
export function sortRows<T extends ReportPlanManager>(rows: T[], key: ColKey, dir: 1 | -1, ctx?: SortCtx): T[] {
  const col = REPORT_COLS.find((c) => c.key === key);
  if (!col) return rows;
  return [...rows].sort((a, b) => {
    const x = col.val(a, ctx), y = col.val(b, ctx);
    if (x == null && y == null) return 0;
    if (x == null) return 1;          // null донизу незалежно від dir
    if (y == null) return -1;
    if (typeof x === "string" || typeof y === "string")
      return dir * String(x).localeCompare(String(y), "uk");
    return dir * (x - y);
  });
}

export interface FootValue { kind: FootKind; value: number | null; extra?: { num: number; den: number } }

/**
 * ПІДСУМОК КОЛОНКИ. Повертає `null` там, де підсумку не існує — і це відповідь,
 * а не порожнеча: у шапці буде «—», а не випадкове число.
 */
export function footValue(key: ColKey, rows: ReportPlanManager[]): FootValue {
  const col = REPORT_COLS.find((c) => c.key === key);
  const kind: FootKind = col?.foot ?? "none";
  if (kind === "none" || kind === "share:none") return { kind, value: null };
  if (kind === "ratio:avgCheck") {
    // Σ маржі ÷ Σ угод пулу — так само, як `glance.avgCheck` на бекенді.
    const num = rows.reduce((s, m) => s + (m.kpi.avgCheck.revenue ?? 0), 0);
    const den = rows.reduce((s, m) => s + (m.kpi.avgCheck.deals ?? 0), 0);
    return { kind, value: den > 0 ? Math.round(num / den) : null, extra: { num, den } };
  }
  if (kind === "ratio:pct") {
    const num = rows.reduce((s, m) => s + m.fact, 0);
    const den = rows.reduce((s, m) => s + m.plan, 0);
    return { kind, value: den > 0 ? Math.round((num / den) * 100) : null, extra: { num, den } };
  }
  if (kind === "ratio:conv") {
    // Когортна конверсія відділу = Σ виграних ÷ Σ узятих. Середнє відсотків дало б
    // менеджеру з трьома угодами таку саму вагу, як менеджеру з трьомастами.
    const num = rows.reduce((s, m) => s + (m.kpi.conversion.won ?? 0), 0);
    const den = rows.reduce((s, m) => s + (m.kpi.conversion.taken ?? 0), 0);
    return { kind, value: den > 0 ? Math.round((num / den) * 1000) / 10 : null, extra: { num, den } };
  }
  const col2 = REPORT_COLS.find((c) => c.key === key)!;
  const value = rows.reduce((s, m) => {
    const v = col2.val(m);
    return s + (typeof v === "number" ? v : 0);
  }, 0);
  return { kind, value };
}
