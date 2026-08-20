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
  | "jamDeals" | "jam" | "dobir" | "talks" | "dispRevenue" | "responseTime"
  | "srcAd" | "srcLeadgen";

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
  /**
   * ПОЯСНЕННЯ КОЛОНКИ: що показник означає і ЗВІДКИ береться (функція ядра).
   *
   * 🔴 ОДНЕ ПОЛЕ, А НЕ ДВА. Доти тут жив `hint` — але лише в частини колонок, і
   * заголовок без нього мовчав. Два поля з підказками на одному заголовку дали б
   * два різні тултипи; тому `hint` злито сюди, разом із застереженнями, які він
   * ніс (наприклад «очікує (дата)» не залежить від обраного періоду).
   *
   * Обовʼязкове для всіх колонок, крім `NO_HELP_COLS` — тримає гейт #90.
   */
  help?: string;
}

/**
 * Колонки, яким пояснення не потрібне: номер рядка і ПІБ пояснюють себе самі.
 * Список ЯВНИЙ, щоб «колонка без help» не стала тихою діркою в гейті — розширення
 * цього переліку має бути свідомим рішенням, а не побічним ефектом.
 */
export const NO_HELP_COLS: ColKey[] = ["rank", "name"];

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
    help: "Стан за темпом місяця: у нормі / відстає / зрив. Джерело: statusOf(факт,план) з поправкою на пройдені робочі дні (пороги 1.0 / 0.7)." },
  { key: "created", title: "Створено", core: true, val: (m) => m.created, foot: "add",
    help: "Угод створено за період; у дужках нові/постійні. Джерело: metrics.createdSplitByManager (постійний = клієнт мав визнану FC-угоду)." },
  // 🔴 ЦЕ ОКРЕМА МЕТРИКА КАНАЛУ, А НЕ ЧАСТИНА «СТВОРЕНО». Заміряно 20.08.2026 на
  // проді (тиждень 10–16.08, відділ): «Прийнято реклами» = 248, а створених із
  // каналом `ad` = 228. Різні множини, різниця 20 угод (8.8%). Поки колонка звалась
  // «Реклама» і стояла поруч зі «Створено», «15 = 13+0+2» читалось як розклад — а це
  // був арифметичний збіг. Розклад створених — окремі колонки нижче.
  { key: "ads", title: "Прийнято реклами", core: true, val: (m) => numOrNull(m.kpi.ads.fact), foot: "add",
    help: "Прийнято рекламних лідів за період. Джерело: metrics.adsAcceptedByMgr. ⚠️ Це ОКРЕМА метрика каналу, а не підмножина колонки «Створено»: заміряно 248 проти 228 створених із каналом «реклама» за той самий тиждень. Розклад створених за джерелом — колонки «зі створених: реклама/лідоген»." },
  { key: "leadgen", title: "Прийнято лідоген", core: true, val: (m) => numOrNull(m.kpi.leadgen.fact), foot: "add",
    help: "Прийнято лідів від лідогенератора. Джерело: metrics.leadgenByManager. ⚠️ Це ОКРЕМА метрика каналу, а не підмножина колонки «Створено» — розклад створених за джерелом стоїть окремими колонками." },
  { key: "conv", title: "Конв. Р+Л", core: true, val: (m) => numOrNull(m.kpi.conversion.fact), foot: "ratio:conv",
    help: "Конверсія по каналах Реклама+лідоген: виграні ÷ взяті. «—» якщо взято <10. Джерело: metrics.conversionByManager." },
  { key: "dispatch", title: "Авто ф/ц", core: true, val: (m) => numOrNull(m.kpi.dispatch.fact), foot: "add",
    help: "Поставлено авто (факт) / тижнева ціль. Факт — metrics.dispatchedByManager (за подіями); ціль — тижнева парасолька Задачника." },
  { key: "avgCheck", title: "Сер. чек", core: true, val: (m) => numOrNull(m.kpi.avgCheck.fact), foot: "ratio:avgCheck",
    help: "Середній чек. Джерело: money.avgCheckPerManager(reportChain) — знімок «зараз у роботі» + виграні, не чисто за період." },
  { key: "fact", title: "Отримано", core: true, val: (m) => m.fact, foot: "add",
    help: "Гроші, що надійшли за період (каса ②). Джерело: money.receivedByMgr." },
  { key: "plan", title: "План міс.", core: true, val: (m) => m.plan, foot: "add",
    help: "Місячний грошовий план, апорт по робочих днях періоду. Джерело: plans.managerPlan." },
  { key: "pct", title: "Викон.", core: true, val: (m) => m.pct, foot: "ratio:pct",
    help: "Отримано ÷ план." },

  { key: "projected", title: "Прогноз", core: false, val: (m) => (m.monthInProgress ? m.projected : null), foot: "add",
    help: "Очікуваний підсумок місяця = факт + рахунки з плановою датою. Лише для повного поточного місяця. Джерело: projected." },
  { key: "needPerDay", title: "Треба ₴/д", core: false, val: (m) => m.needPerDay, foot: "add",
    help: "Скільки приносити щодня до кінця місяця, щоб дотягти план: (план−факт) ÷ роб. дні, що лишились." },
  { key: "expectThisMonth", title: "Очікує (дата)", core: false, val: (m) => m.expectThisMonth, foot: "add",
    help: "Гроші з плановою датою оплати цього місяця (входять у прогноз). Джерело: metrics.expectedByManagerDay. Рахується по календарному місяцю і НЕ залежить від обраного періоду." },
  { key: "awaitNoDate", title: "Без дати", core: false, val: (m) => m.cohort.awaitNoDateSum, foot: "add",
    help: "Гроші без планової дати; у прогноз НЕ входять — ризик. Джерело: cohort.awaitNoDateSum." },
  // 🔴 «ЗАТОР», А НЕ «ЗАСТРЯГЛО»: слово «застрягло» в Звіті вже зайняте списком
  // угод без руху ≥21 дня (`stuck-deals`) — геть інша множина. Дві різні речі під
  // одним підписом на одному екрані ми вже проходили з двома «очікуємо».
  { key: "jamDeals", title: "Затор (рах.)", core: false, val: (m) => m.jamDeals, foot: "add",
    help: "Угоди, застряглі на «Виставленні рахунку» (шт). Джерело: reportCuts.invoicingJamByManager. Це НЕ «застряглі угоди» з блоку нижче — ті без руху ≥21 дня, інша множина." },
  { key: "jam", title: "Затор ₴", core: false, val: (m) => m.jam, foot: "add",
    help: "Сума ₴, що висить у заторі. Те саме джерело." },
  { key: "dobir", title: "Добір", core: false, val: (m) => m.dobir, foot: "add",
    help: "Середній добір за 3 міс; у прогноз НЕ входить. Джерело: money.dobirByManager." },
  { key: "talks", title: "Дзвінки", core: false, val: (m) => m.talks, foot: "add",
    help: "Розмов / спроб (дві цифри). Джерело: reportCuts.callsByManager." },
  // 🟢 СПРАВЖНІЙ РОЗКЛАД СТВОРЕНИХ ЗА ДЖЕРЕЛОМ (рішення власника 20.08.2026).
  // Це НАКЛАДКА на «Створено», а не партиція: сума двох колонок ≤ створених, решта —
  // угоди без рекламного чи лідоген-дотику. Складати їх зі «Створено» не можна.
  { key: "srcAd", title: "зі створених: реклама", core: false, val: (m) => m.srcAd, foot: "add",
    help: "Скільки зі СТВОРЕНИХ угод періоду мають рекламний канал (deals.lead_channel='ad'). Джерело: metrics.createdSplitByManager. Це накладка на «Створено», а не окремий потік: srcAd + srcLeadgen ≤ Створено." },
  { key: "srcLeadgen", title: "зі створених: лідоген", core: false, val: (m) => m.srcLeadgen, foot: "add",
    help: "Скільки зі СТВОРЕНИХ угод періоду прийшли від лідогенератора (deals.lead_channel='leadgen'). Джерело: metrics.createdSplitByManager. Накладка на «Створено», не підсумовується з нею." },
  { key: "dispRevenue", title: "Авто-сума", core: false, val: (m) => numOrNull(m.kpi.dispatch.revenue), foot: "add",
    help: "Сума відправлених авто ₴. Джерело: kpi.dispatch.revenue." },
  // 🔴 ЧАСТКА, А НЕ МЕДІАНА (рішення власника 19.08.2026). Медіана на проді
  // виявилась нульовою майже в усіх — 69% лідів опрацьовані менш ніж за хвилину,
  // тож колонка казала б «усі миттєві» й ховала хвіст, заради якого існує.
  { key: "responseTime", title: "Ліди >1год", core: false,
    val: (m, ctx) => ctx?.slowByMgr?.get(m.managerId) ?? null, foot: "share:none",
    help: "Частка вхідних лідів воронки Кваліфікації, опрацьованих понад годину (реакція на лід, не повний цикл). «—» якщо лідів немає. Джерело: metrics.responseTimeByManager (first_activity − created > 60 хв)." },
];

/** Опційні колонки, увімкнені за замовчуванням (решта — вимкнені). */
export const DEFAULT_OPT_ON: Record<string, boolean> = {
  projected: true, needPerDay: true, expectThisMonth: true, awaitNoDate: true,
  jamDeals: true, responseTime: true,
  jam: false, dobir: false, talks: false, dispRevenue: false,
  srcAd: false, srcLeadgen: false,
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
