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
import type { ReportPlanManager, FirstTouchCell } from "../../api";

export type ColKey =
  | "rank" | "name" | "status" | "created" | "ads" | "leadgen" | "conv" | "convAd" | "convLg"
  | "dispatch" | "avgCheck" | "fact" | "factNew" | "factRepeat" | "factUndef" | "plan" | "pct"
  | "projected" | "needPerDay" | "expectThisMonth" | "expectNew" | "expectRepeat" | "awaitNoDate"
  | "jamDeals" | "jam" | "dobir" | "talks" | "normDays" | "dispRevenue" | "responseTime"
  | "srcAd" | "srcLeadgen" | "srcElogist" | "srcOther" | "srcNoChannel" | "firstTouch";

/**
 * Як колонка згортається в підсумковий рядок.
 * · `add`  — Σ значень (лічильні, гроші);
 * · `none` — підсумку немає (ім'я, ранг, статус);
 * · `ratio:*` — ЧАСТКА: Σ чисельника ÷ Σ знаменника, а не Σ часток.
 */
export type FootKind = "add" | "none" | "ratio:avgCheck" | "ratio:pct" | "ratio:conv" | "ratio:convAd" | "ratio:convLg" | "ratio:firstTouch" | "share:none";

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
  /**
   * Колонка ТИПОВОГО НАБОРУ: увімкнена, доки людина сама її не вимкнула.
   * ⚠️ До 26.10.2026 це означало «завжди видима, не вимикається». Рішення власника
   * (задача 7087): вимкнути можна БУДЬ-ЯКУ колонку, крім «Менеджер» (`LOCKED_COLS`).
   * Поле лишилось — воно задає типовий набір (`DEFAULT_OPT_ON`), а не замок.
   */
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

/** 🎯 Відсоток «ціну названо» — від ОЦІНЕНИХ розмов (без «немає запису»). `null` = нема з чого рахувати. */
export const firstTouchPct = (voiced: number, analyzed: number): number | null =>
  analyzed > 0 ? Math.round((voiced / analyzed) * 1000) / 10 : null;

/**
 * 🎯 ЩО ПИСАТИ В КЛІТИНЦІ «ПЕРШОГО ДОТИКУ» — одне правило на картку й таблицю (ТЗ-3, рішення 17.09.2026).
 * Три стани, і жоден не ховається в інший: «не вимірюється» (бот цю команду не слухає) ≠ «оцінок
 * немає» (слухає, але за період нічого) ≠ відсоток. «Без запису» — окремо й поза відсотком.
 */
export function firstTouchLabel(c: FirstTouchCell | undefined): { main: string; sub: string | null; muted: boolean } {
  if (!c || c.state === "not_covered") return { main: "не вимірюється", sub: null, muted: true };
  const pct = firstTouchPct(c.voiced, c.analyzed);
  const noRec = c.noRecord > 0 ? `без запису ${String(c.noRecord)}` : null;
  if (pct == null) return { main: "—", sub: noRec ?? "оцінок немає", muted: true };
  return { main: `${String(pct)}%`, sub: `${String(c.voiced)} з ${String(c.analyzed)}${noRec ? ` · ${noRec}` : ""}`, muted: false };
}

/**
 * ⚠ ДЖЕРЕЛО МОВЧИТЬ. Бот пише оцінки щодня в робочі дні; три дні без жодної — це вже не вихідні,
 * а зупинка (17.09.2026: остання оцінка 11.09, з ~20.08 бот не отримує відповіді AI). Без позначки
 * «0 з 0» за тиждень читалось би як «менеджери не телефонували».
 */
export const FIRST_TOUCH_STALE_DAYS = 3;
export function firstTouchStale(lastAnalyzedAt: string | null, today: string, periodTo: string): boolean {
  if (!lastAnalyzedAt) return true;
  // 🔴 ВІД КІНЦЯ ОБРАНОГО ПЕРІОДУ, а не від сьогодні (рецензія 17.09.2026): липень, що закінчився
  // до останньої оцінки, повний — тиша бота після нього липневого числа не змінює.
  const end = periodTo < today ? periodTo : today;
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${lastAnalyzedAt}T00:00:00Z`)) / 86_400_000;
  return days > FIRST_TOUCH_STALE_DAYS;
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
    help: "Стан за темпом місяця: у нормі / відстає / зрив. Джерело: statusOf(факт,план) з поправкою на пройдені робочі дні (пороги 1.0 / 0.7)." },
  { key: "created", title: "Створено", core: true, val: (m) => m.created, foot: "add",
    help: "Угод створено за період; у дужках нові/постійні. Джерело: metrics.createdSplitByManager (постійний = клієнт мав визнану FC-угоду). 🔀 На цю колонку діє перемикач зрізу «усі / лише нові / лише постійні» над таблицею: у звуженому стані тут число ЗРІЗУ, і воно збігається зі складом розкриття дня." },
  // 🔴 ЦЕ ОКРЕМА МЕТРИКА КАНАЛУ, А НЕ ЧАСТИНА «СТВОРЕНО». Заміряно 20.08.2026 на
  // проді (тиждень 10–16.08, відділ): «Прийнято реклами» = 248, а створених із
  // каналом `ad` = 228. Різні множини, різниця 20 угод (8.8%). Поки колонка звалась
  // «Реклама» і стояла поруч зі «Створено», «15 = 13+0+2» читалось як розклад — а це
  // був арифметичний збіг. Розклад створених — окремі колонки нижче.
  { key: "ads", title: "Прийнято реклами", core: true, val: (m) => numOrNull(m.kpi.ads.fact), foot: "add",
    help: "Прийнято рекламних лідів за період. Джерело: metrics.adsAcceptedByMgr. ⚠️ Це ОКРЕМА метрика каналу, а не підмножина колонки «Створено»: заміряно 248 проти 228 створених із каналом «реклама» за той самий тиждень. Розклад створених за джерелом — колонки «зі створених: реклама/лідоген»." },
  { key: "leadgen", title: "Прийнято лідоген", core: true, val: (m) => numOrNull(m.kpi.leadgen.fact), foot: "add",
    help: "Угоди, які Kommo СТВОРИЛА менеджеру з передачі лідгена (примітка «створено з угоди Продзвону»), за датою створення. Те саме, що на екрані «Лідогенерація». ⚠️ ДЖЕРЕЛО ЗМІНЕНО 05.10.2026: було — канал lead_channel=\'leadgen\', який губив ~60% таких угод (вересень: 182 проти 451). Колонки «зі створених: лідоген» і «Конв. Р+Л» поки на каналі. ⚠️ Це ОКРЕМА метрика, а не підмножина колонки «Створено» — розклад створених за джерелом стоїть окремими колонками." },
  { key: "conv", title: "Конв. Р+Л", core: true, val: (m) => numOrNull(m.kpi.conversion.fact), foot: "ratio:conv",
    help: "Конверсія по каналах Реклама+лідоген: виграні ÷ взяті. «—» якщо взято <10. Джерело: metrics.conversionByManager." },
  /**
   * 🔀 ТРИ КОНВЕРСІЇ ЗАМІСТЬ ОДНІЄЇ (рішення власника 21.08.2026). Combined лишається
   * як був; канальні — опційні чипи. Показувати конверсію без підпису каналу
   * заборонено правилом глосарію, а одна колонка ховала різницю в 2.3 раза.
   */
  { key: "convAd", title: "Конв. реклама (за каналом)", core: false, val: (m) => numOrNull(m.conversionAd.fact), foot: "ratio:convAd",
    help: "Конверсія лише по РЕКЛАМНИХ лідах: виграні ÷ взяті. Джерело: metrics.conversionByManager(scope, 'ad') — той самий вираз, що «Конв. Р+Л», зі звуженням lead_channel='ad'. Під числом — взято/виграно; відсоток зʼявляється лише при взято ≥10, як і в Р+Л. Заміряно за серпень: реклама 11.0% проти лідогену 24.8%. ⚠️ Знаменник — угоди повного циклу, створені в періоді, а НЕ «прийнято реклами» зі словника метрик." },
  { key: "convLg", title: "Конв. лідоген (за каналом)", core: false, val: (m) => numOrNull(m.conversionLeadgen.fact), foot: "ratio:convLg",
    help: "Конверсія лише по лідах ВІД ЛІДОГЕНЕРАТОРА. Джерело: metrics.conversionByManager(scope, 'leadgen') — решта як у «Конв. реклама». ⚠️ Відсотки трьох колонок НЕ складаються: реклама 11.0% + лідоген 24.8% дають 15.6% у Р+Л, бо це частки з різними знаменниками. ✅ ЗНАМЕННИК ЗІЙШОВСЯ З «conversion_leadgen» зі словника (24.08.2026): раніше там стояв реєстр переданих заявок (159/6 = 3.8% проти наших 302/75 = 24.8% за серпень), тепер обидві беруть ту саму когорту створених угод каналу — рівність тримають гейти #141b і #170b. ⚠️ Відсотки все одно можуть відрізнятись: у «Планах» чисельником рахуються лише угоди з ЗАПИСАНОЮ подією входу в грошову зону, а тут — ще й ті, що стоять там ЗАРАЗ за статусом (заміряно на тій самій множині: 87 проти 59). Це різні фінішні лінії, а не різні метрики." },
  { key: "dispatch", title: "Авто ф/ц", core: true, val: (m) => numOrNull(m.kpi.dispatch.fact), foot: "add",
    help: "Поставлено авто (факт) / тижнева ціль. Факт — metrics.dispatchedByManager (за подіями); ціль — тижнева парасолька Задачника." },
  { key: "avgCheck", title: "Сер. чек", core: true, val: (m) => numOrNull(m.kpi.avgCheck.fact), foot: "ratio:avgCheck",
    help: "Середній чек. Джерело: money.avgCheckPerManager(reportChain) — знімок «зараз у роботі» + виграні, не чисто за період." },
  { key: "fact", title: "Отримано", core: true, val: (m) => m.fact, foot: "add",
    help: "Гроші, що надійшли за період (каса ②). Джерело: money.receivedByMgr." },
  /**
   * 🧬 ГРОШІ НА ТРИ КОЛОНКИ ЗА НОВИЗНОЮ (рішення власника 21.08.2026): «Отримано»
   * лишається як було, поруч — «нові» і «постійні», обидві опційні чипами.
   * Заміряно за серпень: 1 492 822 ₴ = нові 334 584 (133 уг.) + постійні
   * 1 158 238 (368 уг.), Δ0 по кожному з 8 перевірених менеджерів і по відділу.
   */
  { key: "factNew", title: "Отримано · нові", core: false, val: (m) => m.factNew, foot: "add",
    help: "Частина колонки «Отримано», що прийшла від НОВИХ клієнтів. Джерело: money.receivedByMgrKlass — той самий вираз каси ②, розкладений каноном новизни (metrics.dealKlassSql: попередня ВИГРАНА угода того ж клієнта, закрита до створення цієї). «Отримано» = нові + постійні, Δ0." },
  { key: "factRepeat", title: "Отримано · постійні", core: false, val: (m) => m.factRepeat, foot: "add",
    help: "Частина колонки «Отримано» від ПОСТІЙНИХ клієнтів — доповнення до «Отримано · нові» тим самим виразом (money.receivedByMgrKlass). ⚠️ «Постійний» тут = у клієнта вже була виграна угода до створення цієї; це НЕ кваліфікація постійного клієнта з екрана лояльності, де правило 2+/3+ оплат." },
  /**
   * 🔴 ТРЕТЯ ГРОШОВА КОЛОНКА — УМОВНА (рішення власника 25.08.2026, варіант «а»).
   * Показується ЛИШЕ коли клас непорожній. Доти «Отримано == нові + постійні» було
   * правдою; щойно третій клас ожив, різниця почала б мовчки зникати між двома
   * колонками, і жоден інший гейт цього не побачив би — кожне окреме число
   * лишається правильним. Причина заміряна: сторно без `client_key`.
   */
  { key: "factUndef", title: "Отримано · невизначено", core: false, val: (m) => m.factUndef, foot: "add",
    help: "Гроші, що не належать ні «новим», ні «постійним»: у клієнта немає ключа, і «Канал продажу» теж не заповнений. 📐 Заміряно 25.08.2026: 6 угод на −18 004 ₴, усі — сторно тендерних угод. Колонка зʼявляється ЛИШЕ коли клас непорожній: порожня колонка з нулем читалась би як «таких грошей не буває». ⚠️ Джерело проблеми лагодиться в CRM/синку (сторно не успадковує клієнта), а не тут." },
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
  { key: "expectNew", title: "Очікує · нові", core: false, val: (m) => m.expectThisMonthNew, foot: "add",
    help: "Частина колонки «Очікує (дата)» від НОВИХ клієнтів. Джерело: metrics.expectedThisMonthByMgrKlass — та сама зона очікування й та сама планова дата, розкладені каноном metrics.dealKlassSql. Ділиться саме «Очікує (дата)»; «Без дати» лишається цілою." },
  { key: "expectRepeat", title: "Очікує · постійні", core: false, val: (m) => m.expectThisMonthRepeat, foot: "add",
    help: "Частина колонки «Очікує (дата)» від ПОСТІЙНИХ клієнтів — доповнення до «Очікує · нові». Джерело: metrics.expectedThisMonthByMgrKlass, той самий виклик. Заміряно за серпень: 902 222 ₴ = нові 119 912 + постійні 782 310, Δ0." },
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
  // 📞 ТЗ 23.09.2026 п.2: «дні з нормою» для ЗП. `null` = норму не задано в Налаштуваннях — їде донизу.
  { key: "normDays", title: "Днів з нормою", core: false, val: (m) => m.callNorm?.daysWithNorm ?? null, foot: "add",
    help: "Днів, коли розмови+спроби ≥ норми з Налаштувань, / робочих днів Пн–Пт до сьогодні. Норму не задано — колонка так і каже. Джерело: core/callNorm.callNormCell над reportCuts.callsByManagerDay." },
  // 🧺 РОЗКЛАД СТВОРЕНИХ ЗА ДЖЕРЕЛОМ — ТЕПЕР ПОВНИЙ, тобто ПАРТИЦІЯ
  // (рішення власника 24.08.2026; заведено 20.08 як накладка з двох колонок).
  //
  // 🔴 ЩО ЗМІНИЛОСЬ І ЩО НІ. Числа `srcAd`/`srcLeadgen` не зрушили ні на одиницю —
  // це ті самі дві гілки `dealSourceCase`. Змінилось ЧИТАННЯ сімʼї: раніше
  // показувались дві гілки з чотирьох, тож 43.2% створених угод не мали імені на
  // екрані взагалі й читались як «решта, про яку не питали». Тепер показані всі,
  // отже Σ п'яти == «Створено», і кожна угода лежить рівно в одному кошику.
  //
  // ⚠️ І САМЕ ТОМУ ЦЕ НЕ «ЩЕ ОДНА КОЛОНКА». Поки сімʼя була неповною, складати її
  // зі «Створено» було помилкою; тепер це ПЕРЕВІРКА. Різниця в один кошик змінює
  // те, що з числами дозволено робити, — тому інваріант стереже гейт `#174`, а не
  // домовленість.
  //
  // 🔴 «Без джерела» ≠ «невизначено»: перше — канал заповнений, але не рекламний і
  // не лідоген; друге — канал не заповнений узагалі. Друге сьогодні НУЛЬ, і саме
  // тому воно показується ЛИШЕ коли зʼявиться (`hideWhenZero`): підпис у кожному
  // рядку про те, чого немає, — це шпалери, а не сигнал.
  { key: "srcAd", title: "зі створених: реклама", core: false, val: (m) => m.srcAd, foot: "add",
    help: "Скільки зі СТВОРЕНИХ угод періоду мають рекламний канал (deals.lead_channel='ad'). Джерело: metrics.createdSplitByManager. Разом із «лідоген», «eLogist», «без джерела» і «канал не вказано» утворює ПАРТИЦІЮ: Σ п'яти == «Створено». ⚠️ Не плутати з «Прийнято реклами» — то ОКРЕМА метрика (KPI-факт), не частина цього розкладу. 🔀 На цю колонку діє перемикач зрізу «усі / лише нові / лише постійні» над таблицею: у звуженому стані тут число ЗРІЗУ, і воно збігається зі складом розкриття дня." },
  { key: "srcLeadgen", title: "зі створених: лідоген", core: false, val: (m) => m.srcLeadgen, foot: "add",
    help: "Скільки зі СТВОРЕНИХ угод періоду прийшли від лідогенератора (deals.lead_channel='leadgen'). Джерело: metrics.createdSplitByManager. Частина ПАРТИЦІЇ джерела: Σ п'яти == «Створено». ⚠️ Не плутати з «Прийнято лідоген» — то ОКРЕМА метрика (KPI-факт). 🔀 На цю колонку діє перемикач зрізу «усі / лише нові / лише постійні» над таблицею: у звуженому стані тут число ЗРІЗУ, і воно збігається зі складом розкриття дня." },
  // 🟣 eLogist — П'ЯТИЙ кошик партиції (рішення власника 27.10.2026): сестринський сайт, НЕ реклама
  // UTS. До 27.10 ці угоди стояли в «реклама»; тепер окремою колонкою, і Σ п'яти == «Створено».
  { key: "srcElogist", title: "зі створених: eLogist", core: false, val: (m) => m.srcElogist, foot: "add",
    help: "Скільки зі СТВОРЕНИХ угод періоду мають канал eLogist (deals.lead_channel='elogist') — заявки сайту elogist.com.ua (сестринський бренд). Рішення власника 27.10.2026: eLogist — ОКРЕМИЙ канал, НЕ реклама UTS; до цієї дати такі угоди рахувались у «реклама». Ознака ліда — «Источник клиента» = elogist.com.ua, назва «eLogist …» або етап «Заявки eLogist (сайт)»; канал угоди повного циклу — за останнім дотиком. Джерело: metrics.createdSplitByManager. Частина ПАРТИЦІЇ джерела: Σ п'яти == «Створено». ⚠️ Пари «Прийнято …» і плану в неї НЕМАЄ: KPI-цілі ставляться лише по рекламі й лідогену — це не пропуск. 🔀 На цю колонку діє перемикач зрізу «усі / лише нові / лише постійні» над таблицею." },
  { key: "srcOther", title: "зі створених: без джерела", core: false, val: (m) => m.srcOther, foot: "add",
    help: "Скільки зі СТВОРЕНИХ угод періоду не мають ані рекламного, ані лідоген-дотику — менеджер завів угоду сам. Джерело: metrics.createdSplitByManager. Частина ПАРТИЦІЇ джерела: Σ п'яти == «Створено». 📐 Заміряно 25.07-24.08: 1137 угод (43.2%), з них 827 — постійні клієнти, тобто це переважно робота з наявною базою, а не «загублене походження». ⚠️ Пари «Прийнято …» у цієї колонки НЕМАЄ — і це не пропуск: KPI-цілі ставляться лише по рекламі й лідогену. ⚠️ ПЛАНУ по цій колонці НЕМАЄ і не передбачено: цілі ставляться лише по рекламі й лідогену, тож порожньо в «плані» тут — це відсутність цілі, а не недопрацювання. 🔀 На цю колонку діє перемикач зрізу «усі / лише нові / лише постійні» над таблицею: у звуженому стані тут число ЗРІЗУ, і воно збігається зі складом розкриття дня." },
  { key: "srcNoChannel", title: "зі створених: канал не вказано", core: false, val: (m) => m.srcNoChannel, foot: "add",
    help: "Кошик ПАРТИЦІЇ джерела «канал не вказано»: угоди, у яких канал не заповнений узагалі (deals.lead_channel IS NULL) — тобто ми НЕ ЗНАЄМО джерела, на відміну від «без джерела», де відомо, що дотику не було. 📐 Заміряно 24.08.2026: НУЛЬ по всій базі. Колонка існує, щоб перша ж така угода стала видимою, а не осіла тихо в сусідньому кошику; поки нуль — про це кричить гейт #174e, а не підпис у кожному рядку. 🔀 На цю колонку діє перемикач зрізу «усі / лише нові / лише постійні» над таблицею: у звуженому стані тут число ЗРІЗУ, і воно збігається зі складом розкриття дня." },
  // 🎯 ТЗ-3 «перший дотик»: відсоток — ЧАСТКА, тож у підсумку Σ названих ÷ Σ оцінених, а не Σ відсотків.
  { key: "firstTouch", title: "Ціну названо (1-й дотик)", core: false,
    val: (m) => (m.firstTouch?.state === "measured" ? firstTouchPct(m.firstTouch.voiced, m.firstTouch.analyzed) : null),
    foot: "ratio:firstTouch",
    help: "Частка перших розмов з рекламним лідом, у яких менеджер назвав ціну: названо ÷ оцінено. Оцінює AI-бот (uts-bot: розшифровка й мітка «ціну озвучено»), джерело: first_touch_analysis ← jobs/syncFirstTouch. Розмова зараховується тому, хто ДЗВОНИВ (рішення власника 17.09.2026), а не поточному відповідальному угоди. «Не вимірюється» — команду бот не оцінює взагалі (зараз лише РНК). «Без запису» — бот розмови не чув; у відсоток не входить. Рекламного фільтра дашборд не додає: фільтрує бот." },
  { key: "dispRevenue", title: "Авто-сума", core: false, val: (m) => numOrNull(m.kpi.dispatch.revenue), foot: "add",
    help: "Сума відправлених авто ₴. Джерело: kpi.dispatch.revenue." },
  // 🔴 ЧАСТКА, А НЕ МЕДІАНА (рішення власника 19.08.2026). Медіана на проді
  // виявилась нульовою майже в усіх — 69% лідів опрацьовані менш ніж за хвилину,
  // тож колонка казала б «усі миттєві» й ховала хвіст, заради якого існує.
  { key: "responseTime", title: "Ліди >1год", core: false,
    val: (m, ctx) => ctx?.slowByMgr?.get(m.managerId) ?? null, foot: "share:none",
    help: "Частка вхідних лідів воронки Кваліфікації, опрацьованих понад годину (реакція на лід, не повний цикл). «—» якщо лідів немає. Джерело: metrics.responseTimeByManager (first_activity − created > 60 хв)." },
];

/**
 * 🔒 НЕВИМИКНА ЛИШЕ «Менеджер» (рішення власника 26.10.2026, задача 7087: «вибирати
 * будь-які колонки»). Без імені рядок таблиці — набір чисел нічий, і підсумок
 * («Весь відділ · N») теж живе в цій колонці. «#» вимикається: номер рядка ні на що
 * інше не впливає.
 */
export const LOCKED_COLS: ColKey[] = ["name"];
export const isLockedCol = (k: ColKey): boolean => LOCKED_COLS.includes(k);

/**
 * ТИПОВИЙ НАБІР: усі колонки `core` + опційні, увімкнені за замовчуванням.
 *
 * 🔴 КОЛОНКИ `core` ТУТ ЯВНО `true` — і саме це береже старі збережені вибори.
 * Доти у сховищі лежали лише опційні ключі (core були невимикні, їх не писали).
 * `readColPrefs` накладає збережене поверх цього обʼєкта, тож у старому виборі
 * core-колонки читаються увімкненими, і після викату ні в кого нічого не зникає.
 * Ключі core виводяться з реєстру, а не перелічуються руками: нова core-колонка
 * не випаде з типового набору.
 */
export const DEFAULT_OPT_ON: Record<string, boolean> = {
  ...Object.fromEntries(REPORT_COLS.filter((c) => c.core && !isLockedCol(c.key)).map((c) => [c.key, true])),
  projected: true, needPerDay: true, expectThisMonth: true, awaitNoDate: true,
  jamDeals: true, responseTime: true,
  jam: false, dobir: false, talks: false, dispRevenue: false,
  srcAd: false, srcLeadgen: false, srcElogist: false, srcOther: false, srcNoChannel: false,
  firstTouch: true,
};

/** Колонки, які людина може вимкнути в меню, — усі, крім закритих замком (`LOCKED_COLS`). */
export const OPTIONAL_COLS = REPORT_COLS.filter((c) => !isLockedCol(c.key));

/** Чи показана колонка за вибором людини. Умовну «Отримано · невизначено» вирішує таблиця, не вибір. */
export const colVisible = (k: ColKey, prefs: Record<string, boolean>): boolean =>
  isLockedCol(k) || prefs[k] === true;

/**
 * 🗂 ГРУПИ КОЛОНОК У МЕНЮ «Колонки» (26.10.2026).
 *
 * Окрема мапа, а не поле в кожному записі реєстру: `Record<ColKey, …>` змушує
 * tsc вимагати групу для КОЖНОЇ колонки — нова колонка без групи не збереться,
 * а не тихо випаде з меню. І записи реєстру, які читають текстові гейти, не
 * зсуваються.
 */
export type ColGroup = "base" | "leads" | "src" | "money" | "expect" | "auto" | "calls";
export const COL_GROUPS: { key: ColGroup; title: string }[] = [
  { key: "base", title: "Менеджер" },
  { key: "money", title: "Гроші" },
  { key: "expect", title: "Очікування й затор" },
  { key: "leads", title: "Ліди й конверсія" },
  { key: "src", title: "Створені за джерелом" },
  { key: "auto", title: "Авто" },
  { key: "calls", title: "Дзвінки й реакція" },
];
export const COL_GROUP_OF: Record<ColKey, ColGroup> = {
  rank: "base", name: "base", status: "base",
  fact: "money", plan: "money", pct: "money", avgCheck: "money",
  factNew: "money", factRepeat: "money", factUndef: "money", projected: "money", needPerDay: "money", dobir: "money",
  expectThisMonth: "expect", expectNew: "expect", expectRepeat: "expect", awaitNoDate: "expect",
  jamDeals: "expect", jam: "expect",
  created: "leads", ads: "leads", leadgen: "leads", conv: "leads", convAd: "leads", convLg: "leads",
  srcAd: "src", srcLeadgen: "src", srcElogist: "src", srcOther: "src", srcNoChannel: "src",
  dispatch: "auto", dispRevenue: "auto",
  talks: "calls", normDays: "calls", firstTouch: "calls", responseTime: "calls",
};

/**
 * 💾 ВИБІР КОЛОНОК — ОСОБИСТИЙ ДЛЯ КОРИСТУВАЧА (26.10.2026).
 *
 * Доти ключ був один на браузер (`rptTableCols`): двоє людей за одним компʼютером
 * перемикали колонки ОДНЕ ОДНОМУ. Тепер ключ — `rptTableCols:<userId>`. Старий
 * ключ лишається ФОЛБЕКОМ на читання: інакше всі, хто вже налаштував таблицю,
 * після викату побачили б типовий набір і вирішили б, що вибір «злетів». Старий
 * ключ не стирається — ним можуть ще користуватись інші люди того ж браузера.
 *
 * Сховище передається параметром, а не береться глобально: модуль лишається
 * чистим, і поведінку (а не текст) перевіряють гейти #2432–#2434. Кожне читання й
 * запис — у try/catch: приватне вікно чи заблоковане сховище кидають на доступі,
 * і таблиця мусить відмалюватись із типовим набором, а не впасти.
 */
export const COLS_LS_LEGACY = "rptTableCols";
export interface ColsStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void }
export const colsStorageKey = (userId: number | null | undefined): string =>
  userId != null ? `${COLS_LS_LEGACY}:${String(userId)}` : COLS_LS_LEGACY;

export function readColPrefs(store: ColsStore | null, userId: number | null | undefined): Record<string, boolean> {
  try {
    if (!store) return { ...DEFAULT_OPT_ON };
    const own = store.getItem(colsStorageKey(userId));
    const raw: unknown = JSON.parse((own ?? store.getItem(COLS_LS_LEGACY)) || "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_OPT_ON };
    const picked: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "boolean") picked[k] = v;
    return { ...DEFAULT_OPT_ON, ...picked };
  } catch {
    return { ...DEFAULT_OPT_ON };
  }
}

/** Пише ЛИШЕ особистий ключ. `false` — сховище недоступне (вибір живе до перезавантаження). */
export function writeColPrefs(store: ColsStore | null, userId: number | null | undefined, prefs: Record<string, boolean>): boolean {
  try {
    if (!store) return false;
    store.setItem(colsStorageKey(userId), JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

/** «Скинути до типових» — рівно `DEFAULT_OPT_ON`, копією (щоб стан не ділив обʼєкт із реєстром). */
export const resetColPrefs = (): Record<string, boolean> => ({ ...DEFAULT_OPT_ON });

/** «Усі» — кожна опційна колонка увімкнена. */
export const allColPrefs = (): Record<string, boolean> =>
  Object.fromEntries(OPTIONAL_COLS.map((c) => [c.key, true]));

/**
 * ↔️ ПОРЯДОК КОЛОНОК — ОСОБИСТИЙ, ПОРУЧ ІЗ ВИБОРОМ (задача 7087, 26.10.2026).
 *
 * 🔴 ОКРЕМИЙ КЛЮЧ `rptTableColOrder:<userId>`, А НЕ ПОЛЕ У ЗАПИСІ ВИБОРУ. Запис
 * вибору — `Record<string, boolean>`, і `readColPrefs` свідомо викидає все
 * не-булеве (#2434). Масив у тому самому обʼєкті або зламав би цей фільтр, або
 * був би ним мовчки викинутий. Два ключі — дві незалежні речі: зіпсований порядок
 * не губить вибору, і навпаки.
 *
 * 🔴 ЗАКРІПЛЕНІ «#» І «Менеджер» (`PINNED_COLS`) ЗАВЖДИ ПЕРШІ, у порядку реєстру,
 * що б не лежало у сховищі. «Менеджер» — липкий кут (`sticky-mgr`, `left: 0`):
 * зсунутий углиб таблиці, він липнув би поверх чужих колонок.
 *
 * 🔴 НОВА КОЛОНКА СТАЄ НА СВОЄ ТИПОВЕ МІСЦЕ — одразу за найближчим сусідом зліва з
 * реєстру, а не в хвіст. Інакше кожна нова колонка в людей із налаштованим порядком
 * зʼявлялась би десь праворуч за скролом і читалась би як «її не додали». Ключі,
 * яких у реєстрі більше немає, відкидаються.
 *
 * Порядок завжди ПОВНИЙ — усі колонки реєстру, і показані, і сховані: увімкнена
 * пізніше колонка стає туди, де людина її колись поставила.
 */
export const PINNED_COLS: ColKey[] = ["rank", "name"];
export const isPinnedCol = (k: ColKey): boolean => PINNED_COLS.includes(k);
/** Типовий порядок — рівно порядок реєстру. */
export const defaultColOrder = (): ColKey[] => REPORT_COLS.map((c) => c.key);

/** Будь-що зі сховища → повний порядок реєстру без дублів, закріплені спереду. */
export function normalizeColOrder(saved: unknown): ColKey[] {
  const def = defaultColOrder();
  const known = new Set<ColKey>(def);
  const out: ColKey[] = [...PINNED_COLS];
  const seen = new Set<ColKey>(PINNED_COLS);
  if (Array.isArray(saved)) {
    for (const k of saved) {
      if (typeof k !== "string" || !known.has(k as ColKey) || seen.has(k as ColKey)) continue;
      out.push(k as ColKey); seen.add(k as ColKey);
    }
  }
  // Відсутні в збереженому — на типове місце: за найближчим уже поставленим сусідом зліва.
  def.forEach((k, i) => {
    if (seen.has(k)) return;
    let at = PINNED_COLS.length;
    for (let j = i - 1; j >= 0; j--) {
      const p = out.indexOf(def[j]);
      if (p >= 0) { at = Math.max(p + 1, PINNED_COLS.length); break; }
    }
    out.splice(at, 0, k); seen.add(k);
  });
  return out;
}

/** Упорядковує список колонок за збереженим порядком. Єдине місце, де порядок застосовується. */
export function applyColOrder<T extends { key: ColKey }>(cols: T[], order: readonly ColKey[]): T[] {
  const pos = new Map<ColKey, number>(normalizeColOrder(order).map((k, i) => [k, i]));
  return [...cols].sort((a, b) => (pos.get(a.key) ?? 0) - (pos.get(b.key) ?? 0));
}

/**
 * Перемістити колонку `from` НА МІСЦЕ `to` (перетягування): `from` стає на індекс,
 * який займала `to`, решта зсувається. Закріплену не рухаємо й на її місце не ставимо —
 * повертається нормалізований порядок без змін.
 */
export function moveCol(order: readonly ColKey[], from: ColKey, to: ColKey): ColKey[] {
  const cur = normalizeColOrder(order);
  if (from === to || isPinnedCol(from) || isPinnedCol(to)) return cur;
  const i = cur.indexOf(from), j = cur.indexOf(to);
  if (i < 0 || j < 0) return cur;
  cur.splice(i, 1);
  cur.splice(j, 0, from);
  return cur;
}

/**
 * Крок ↑/↓ (клавіатура, телефон): на місце СУСІДНЬОЇ ПОКАЗАНОЇ колонки. Сховані
 * колонки між ними не рахуються — інакше кнопка «нічого не робила б» кілька натискань
 * поспіль. `visible` — показані колонки в поточному порядку.
 */
export function moveColStep(order: readonly ColKey[], key: ColKey, dir: -1 | 1, visible: readonly ColKey[]): ColKey[] {
  const i = visible.indexOf(key);
  const to = i < 0 ? undefined : visible[i + dir];
  return to == null ? normalizeColOrder(order) : moveCol(order, key, to);
}

export const COL_ORDER_LS = "rptTableColOrder";
export const colOrderStorageKey = (userId: number | null | undefined): string =>
  userId != null ? `${COL_ORDER_LS}:${String(userId)}` : COL_ORDER_LS;

export function readColOrder(store: ColsStore | null, userId: number | null | undefined): ColKey[] {
  try {
    if (!store) return defaultColOrder();
    return normalizeColOrder(JSON.parse(store.getItem(colOrderStorageKey(userId)) || "null"));
  } catch {
    return defaultColOrder();
  }
}

/**
 * Пише ЛИШЕ особистий ключ порядку; ключ вибору колонок не чіпає. Порядок, що
 * збігається з типовим, ключ ПРИБИРАЄ: людина, яка скинула порядок, далі йде за
 * реєстром, а не за застиглою копією сьогоднішнього типового.
 */
export function writeColOrder(store: ColsStore | null, userId: number | null | undefined, order: readonly ColKey[]): boolean {
  try {
    if (!store) return false;
    const key = colOrderStorageKey(userId);
    const norm = normalizeColOrder(order);
    if (norm.join() === defaultColOrder().join() && store.removeItem) store.removeItem(key);
    else store.setItem(key, JSON.stringify(norm));
    return true;
  } catch {
    return false;
  }
}

/** «Скинути до типових» для порядку — порядок реєстру, новою копією. */
export const resetColOrder = (): ColKey[] => defaultColOrder();

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
  if (kind === "ratio:convAd" || kind === "ratio:convLg") {
    // 🔴 Σwon ÷ Σtaken ОКРЕМО для кожного каналу — частку не можна ані складати,
    // ані усереднювати по рядках (реклама 11.0%, лідоген 24.8%, разом 15.6%).
    const pick = (m: ReportPlanManager) => (kind === "ratio:convAd" ? m.conversionAd : m.conversionLeadgen);
    const num = rows.reduce((s, m) => s + pick(m).won, 0);
    const den = rows.reduce((s, m) => s + pick(m).taken, 0);
    return { kind, value: den > 0 ? Math.round((num / den) * 1000) / 10 : null, extra: { num, den } };
  }
  if (kind === "ratio:firstTouch") {
    // 🔴 Σ названих ÷ Σ оцінених: середнє відсотків дало б людині з однією оцінкою вагу тієї, у кого їх сорок.
    const num = rows.reduce((s, m) => s + (m.firstTouch?.voiced ?? 0), 0);
    const den = rows.reduce((s, m) => s + (m.firstTouch?.analyzed ?? 0), 0);
    return { kind, value: firstTouchPct(num, den), extra: { num, den } };
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
