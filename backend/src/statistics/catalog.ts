import { DISPATCH_FROM_LABEL } from "../core/dispatched.js";
// Каталог метрик розділу «Статистики» — ЄДИНЕ джерело правди структури.
// І бекенд (бекфіл/перерахунок/API), і фронт беруть перелік відділів/метрик
// ЛИШЕ звідси. Ніяких хардкодів у компонентах/скриптах.
//
// Рішення власника й правила — docs/STATISTICS_SPEC.md (§0-БІС).
// Склад: 6 відділів (intl/air_sea/tenders ВИКЛЮЧЕНО).
// «План …» тут НЕМАЄ (R4) — план читається з таблиці `plans` окремо (§5 спеки).

export type Unit = "uah" | "count" | "percent";
export type Source = "auto" | "manual" | "derived";
export type Aggregation = "sum" | "avg" | "last";

export interface MetricDef {
  /** Стабільний латинський ключ (metric_key у statistics_values). */
  key: string;
  /** Підпис у UA. */
  label: string;
  unit: Unit;
  source: Source;
  /** Для R2 (злиття «самостійні»→Шевчук) і рядка «Разом». */
  aggregation: Aggregation;
  /** Для derived — формула через інші key того ж рядка (напр. "revenue_won / machines_success"). */
  formula?: string;
  /** Індекс колонки в CSV-листі (0-базований) — для бекфілу imported/manual. undefined = не з листа. */
  csvIndexMonth?: number;
  csvIndexWeek?: number;
  /** Порядок показу. */
  order: number;
  /** Нотатка (напр. «Ringostat — після підключення»). */
  note?: string;
}

export interface DepartmentDef {
  /** Ключ відділу (department у statistics_values). */
  key: string;
  /** Підпис у UA (вкладка розділу). */
  label: string;
  /** Назви аркушів у Google-таблиці (для бекфілу). */
  tabMonth: string;
  tabWeek: string;
  /** Чи є розріз по тімліду (лише sales). */
  hasTeamLeadBreakdown: boolean;
  /** Індекс колонки дати в листі (0). */
  csvDateIndex: number;
  metrics: MetricDef[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Індекси колонок звірені з реальними заголовками листа (STATISTICS_SPEC §3).
// Тримати по ПОЗИЦІЇ (заголовки містять \n і зайві лапки — A8).
// ─────────────────────────────────────────────────────────────────────────────

export const CATALOG: DepartmentDef[] = [
  {
    key: "sales",
    label: "Відділ продажів",
    tabMonth: "Відділ продажів М",
    tabWeek: "Відділ продажів Т",
    hasTeamLeadBreakdown: true,
    csvDateIndex: 0,
    // Місяць CSV: 0 дата,1 тімлід,2 План дохід,3 дохід,4 План оплата,5 оплата,
    //  6 План рахунки,7 рахунки,8 План сер.чек,9 сер.чек,10 План дзвінки,11 дзвінки,
    //  12 План менеджери,13 менеджери,14 успішні авто,15 готівка,16 поставлені,17 дохід сер.чек
    // Тиждень CSV: 0 дата,1 тімлід,2 дохід,3 оплата,4 рахунки,5 сер.чек,6 дзвінки,
    //  7 менеджери,8 успішні машини,9 готівка,10 поставлені,11 дохід сер.чек
    metrics: [
      { key: "revenue_won", label: "Успішно реалізовано, грн", unit: "uah", source: "auto", aggregation: "sum", csvIndexMonth: 3, csvIndexWeek: 2, order: 1 },
      { key: "payment_received", label: "Оплата отримана (знімок), грн", unit: "uah", source: "auto", aggregation: "sum", csvIndexMonth: 5, csvIndexWeek: 3, order: 2 },
      { key: "invoiced_amount", label: "Очікувані оплати (рахунки, знімок), грн", unit: "uah", source: "auto", aggregation: "sum", csvIndexMonth: 7, csvIndexWeek: 4, order: 3 , note: "ЗНІМОК, не період: рахується без фільтра дати (поточний стан deals) і кладеться в бакет ПОТОЧНОГО місяця й тижня. Рядок «липень» для цієї колонки — не липень, а стан бази в останню годину липня"},
      { key: "avg_check", label: "Середній чек, грн", unit: "uah", source: "derived", aggregation: "avg", formula: "revenue_won / machines_success", csvIndexMonth: 9, csvIndexWeek: 5, order: 4, note: "Успішна виручка ÷ УСПІШНІ УГОДИ. Знаменник змінено 02.09.2026 з machines_dispatched: «відправлені» стали рахувати НЕоплачені, і сер. чек почав би ділити гроші оплачених на кількість неоплачених. Це застосування чинного рішення власника від 06.08.2026 («сер.чек = гроші ÷ угоди, а не ÷ авто»), а не нове означення. Задачник рахує той самий чек незалежно (money.avgCheckByManager = success_rev ÷ success_deals) — після цієї правки вони збіглись, а не розійшлись" },
      { key: "calls", label: "Кількість дзвінків", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 11, csvIndexWeek: 6, order: 5, note: "Ringostat live: employee_fio→тімлід, результативні (billsec>0)" },
      { key: "managers_count", label: "К-ть менеджерів (знімок)", unit: "count", source: "auto", aggregation: "last", csvIndexMonth: 13, csvIndexWeek: 7, order: 6 , note: "ЗНІМОК, не період: COUNT активних менеджерів команди СЬОГОДНІ, покладений у поточний бакет"},
      { key: "machines_success", label: "Кількість успішних угод (авто)", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 14, csvIndexWeek: 8, order: 7 },
      { key: "cash_deals_amount", label: "Успішні угоди готівкою (приход), грн", unit: "uah", source: "auto", aggregation: "sum", csvIndexMonth: 15, csvIndexWeek: 9, order: 8 },
      { key: "machines_dispatched", label: `Відправлені машини (знімок; означення з ${DISPATCH_FROM_LABEL})`, unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 16, csvIndexWeek: 10, order: 9 , note: "Створені в цьому місяці, поїхали (за датою завантаження) і оплата ще НЕ зайшла; закриті «не реалізовано» виключені — рішення власника 02.09.2026. ДВА РІЗНІ ЗАСТЕРЕЖЕННЯ, і вони не про одне й те саме. (1) ЗНІМОК: стан на СЬОГОДНІ, а не за той місяць — показник тане, бо все врешті або оплачується, або падає в 143 (заміряно 02.09: серпень 250, липень 67, червень 17, грудень 2025 — 3). (2) ОЗНАЧЕННЯ З МЕЖІ (core/dispatched.ts DISPATCH_FROM): до неї тут лежить ІНША величина — копія «успішних угод» (2026-01…06, ~700-1000) і до 2025-12 числа з листа; вони не перераховуються (джоба бачить лише останні 75 днів) і з новими не порівнюються. Означення й усі заміряні факти — core/dispatched.ts" },
    ],
  },
  {
    key: "leadgen",
    label: "Лідогенерація (Міжн.)",
    tabMonth: "ЛідгенМіжн м",
    tabWeek: "ЛідгенМіжн т",
    hasTeamLeadBreakdown: false,
    csvDateIndex: 0,
    // CSV: 0 дата,1 прорахунки,2 нові клієнти,3 конверсія,4 дохід,5 сер.чек
    metrics: [
      { key: "quotes", label: "Кількість прорахунків", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 1, csvIndexWeek: 1, order: 1 },
      { key: "new_clients", label: "Кількість нових клієнтів", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 2, csvIndexWeek: 2, order: 2 },
      { key: "conversion", label: "Конверсія прорахунок→новий, %", unit: "percent", source: "derived", aggregation: "avg", formula: "new_clients / quotes * 100", csvIndexMonth: 3, csvIndexWeek: 3, order: 3 },
      { key: "revenue", label: "Дохід, грн", unit: "uah", source: "auto", aggregation: "sum", csvIndexMonth: 4, csvIndexWeek: 4, order: 4 },
      { key: "avg_check", label: "Середній чек, грн", unit: "uah", source: "derived", aggregation: "avg", formula: "revenue / new_clients", csvIndexMonth: 5, csvIndexWeek: 5, order: 5 },
    ],
  },
  {
    key: "marketing",
    label: "Відділ маркетингу",
    tabMonth: "Відділ маркетингу М",
    tabWeek: "Відділ маркетингу Т",
    hasTeamLeadBreakdown: false,
    csvDateIndex: 0,
    // Місяць CSV: 0 дата,1 реклама ліди,2 не цільові,3 оплачені авто,4 дохід нових Р,
    //  5 конв Р,6 Ялогист,7 ЮТС,8 Эвразия,9 сер.чек лідів,10 собів.ліда,11 лідоген прорахунки,
    //  12 нові з прорахунків,13 дохід нових Л,14 конв Л,15 бюджет лідогенів,16 сер.чек прорах,
    //  17 собів.ліда прорах,18 к-ть лідогенів,19 дохід усіх,20 сума продажів
    metrics: [
      { key: "ad_leads", label: "Ліди з реклами (лист, не оновлюється)", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 1, csvIndexWeek: 1, order: 1,
        // 🔴 ПІДПИС КАЖЕ «НЕ ОНОВЛЮЄТЬСЯ» СВІДОМО. Колонка живиться разовим імпортом
        // Google-листа; останні дані — 06.2026 (заміряно 01.09.2026). Показувати старе
        // число без цього слова означає видавати заморожене за поточне — та сама брехня
        // на екрані, що «знімок, підписаний періодом».
        //
        // Джерелом істини стане РЕКЛАМНИЙ КАБІНЕТ через API (рішення власника 01.09.2026,
        // доступ очікується). Наше CRM-означення розходиться з листом на ~30% і свідомо
        // НЕ вмикається — це вибір означення, а не технічна прогалина.
        //
        // 🔗 Підпис і стан звʼязані гейтом `#26f`: доки ключа немає в `DEPT_AUTO_ENABLED`,
        // мітка мусить стояти; щойно джерело зʼявиться і ключ увімкнуть — мітку треба
        // зняти, і гейт це вимагатиме. Дата в мітці не стоїть саме тому, що вона старіла б
        // мовчки; «не оновлюється» перевіряється станом, а не памʼяттю.
        note: "Джерело — разовий імпорт Google-листа, останні дані 06.2026. Живим джерелом стане рекламний кабінет через API; наше CRM-означення розходиться з листом на ~30% і свідомо не використовується" },
      { key: "non_target_leads", label: "Кількість не цільових лідів", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 2, csvIndexWeek: 2, order: 2 },
      { key: "ad_paid_clients", label: "Оплачені авто (реклама)", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 3, csvIndexWeek: 3, order: 3 },
      { key: "ad_new_revenue", label: "Дохід з нових клієнтів (Р), грн", unit: "uah", source: "auto", aggregation: "sum", csvIndexMonth: 4, csvIndexWeek: 4, order: 4 },
      { key: "ad_conversion", label: "Конверсія Р, %", unit: "percent", source: "derived", aggregation: "avg", formula: "ad_paid_clients / ad_leads * 100", csvIndexMonth: 5, csvIndexWeek: 5, order: 5 },
      { key: "ad_budget_total", label: "Рекламний бюджет (заг.), грн", unit: "uah", source: "auto", aggregation: "sum", order: 6, note: "з ad_budget_daily (без розбивки по акаунтах, ВП-7)" },
      { key: "ad_avg_check", label: "Сер. чек (з лідів), грн", unit: "uah", source: "derived", aggregation: "avg", formula: "ad_new_revenue / ad_paid_clients", csvIndexMonth: 9, csvIndexWeek: 9, order: 7 },
      { key: "ad_cost_per_lead", label: "Собівартість ліда (реклама), грн", unit: "uah", source: "derived", aggregation: "avg", formula: "ad_budget_total / ad_leads", order: 8 },
      { key: "lg_quotes", label: "Лідогенератори: прорахунки", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 11, csvIndexWeek: 11, order: 9 },
      { key: "lg_new_clients", label: "Нові клієнти (з прорахунків)", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 12, csvIndexWeek: 12, order: 10 },
      { key: "lg_new_revenue", label: "Дохід з нових клієнтів (Л), грн", unit: "uah", source: "auto", aggregation: "sum", csvIndexMonth: 13, csvIndexWeek: 13, order: 11 },
      { key: "lg_conversion", label: "Конверсія Л, %", unit: "percent", source: "derived", aggregation: "avg", formula: "lg_new_clients / lg_quotes * 100", csvIndexMonth: 14, csvIndexWeek: 14, order: 12 },
      { key: "lg_budget", label: "Бюджет лідогенераторів (ЗП), грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 15, order: 13 },
      { key: "lg_avg_check", label: "Сер. чек (з прорахунків), грн", unit: "uah", source: "derived", aggregation: "avg", formula: "lg_new_revenue / lg_new_clients", csvIndexMonth: 16, order: 14 },
      { key: "lg_cost_per_lead", label: "Собівартість ліда (прорах.), грн", unit: "uah", source: "derived", aggregation: "avg", formula: "lg_budget / lg_quotes", csvIndexMonth: 17, order: 15 },
      { key: "lg_count", label: "К-ть лідогенераторів", unit: "count", source: "auto", aggregation: "last", csvIndexMonth: 18, order: 16 },
      // 🎯 ДВІ КОГОРТНІ КОНВЕРСІЇ З CRM (01.09.2026, рішення власника). Стоять ПОРУЧ
      // із «Конверсія Р/Л», але це ІНШІ метрики, а не полагоджені старі:
      //   · там — відношення двох НЕЗАЛЕЖНИХ чисел із листа (чисельник і знаменник
      //     можуть стосуватись різних угод), заморожених на 2026-06;
      //   · тут — КОГОРТА: ті самі угоди по обидва боки, вхід = створення угоди,
      //     чисельник = дійшли до MONEY_ZONE, поріг знаменника ≥10 → інакше «—».
      // Старі поля свідомо НЕ оживлюємо: це дало б шов усередині однієї колонки.
      // Ім'я з суфіксом `_crm` — щоб на екрані було видно, що джерело інше.
      { key: "conversion_new_crm", label: "Конверсія нових (CRM, змінюється заднім числом), %", unit: "percent", source: "auto", aggregation: "avg", order: 20,
        note: "Когорта: FC-угоди сегмента «новий» (клієнт не мав попередньої оплаченої), створені в періоді → скільки з них дійшло до зони грошей. Поріг ≥10 угод, інакше «—». Джерело — CRM, не Google-лист. 🔴 ЧИСЛО РУХОМЕ: сегмент визначається за ПОТОЧНИМ станом попередніх угод клієнта, тож коли стара угода стає оплаченою, серпнева виходить зі знаменника; чисельник теж поточний і росте. Заміряно 01.09.2026: за 12 годин 1670→1664 і 199→201" },
      { key: "conversion_leadgen_crm", label: "Конверсія лідогенів (CRM, когорта), %", unit: "percent", source: "auto", aggregation: "avg", order: 21,
        note: "Когорта: FC-угоди з lead_channel='leadgen', створені в періоді → скільки з них дійшло до зони грошей. Поріг ≥10 угод, інакше «—». Джерело — CRM, не Google-лист" },
      { key: "total_revenue", label: "Дохід з усіх клієнтів, грн", unit: "uah", source: "derived", aggregation: "sum", formula: "ad_new_revenue + lg_new_revenue", csvIndexMonth: 19, order: 17 },
    ],
  },
  {
    key: "finance",
    label: "Фінанси",
    tabMonth: "Фінанси М",
    tabWeek: "Фінанси Т",
    hasTeamLeadBreakdown: false,
    csvDateIndex: 0,
    // CSV: 0 дата,1 cash flow,2 витрати заг,3 дохід поставлених,4 витрати поставлених,
    //  5 комісійні поставлених,6 дохід по акту,7 витрати,8 комісійні,9 дохід оплачених,
    //  10 витрати оплачених,11 комісійні оплачених,12 загальні витрати,13 дебіторка,14 чистий прибуток
    metrics: [
      { key: "cash_flow", label: "CASH FLOW загальний, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 1, csvIndexWeek: 1, order: 1 },
      { key: "expenses_total", label: "Витрати загальні, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 2, csvIndexWeek: 2, order: 2 },
      { key: "dispatched_income", label: "Дохід з поставлених машин, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 3, csvIndexWeek: 3, order: 3 },
      { key: "dispatched_costs", label: "Витрати з поставлених машин, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 4, csvIndexWeek: 4, order: 4 },
      { key: "dispatched_commission", label: "Комісійні з поставлених, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 5, csvIndexWeek: 5, order: 5 },
      { key: "act_income", label: "Дохід по даті акту, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 6, csvIndexWeek: 6, order: 6 },
      { key: "act_costs", label: "Сума витрат, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 7, csvIndexWeek: 7, order: 7 },
      { key: "act_commission", label: "Комісійні, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 8, csvIndexWeek: 8, order: 8 },
      { key: "paid_dispatched_income", label: "Дохід з оплачених поставлених, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 9, csvIndexWeek: 9, order: 9 },
      { key: "paid_dispatched_costs", label: "Витрати з оплачених поставлених, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 10, csvIndexWeek: 10, order: 10 },
      { key: "paid_dispatched_commission", label: "Комісійні з оплачених поставлених, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 11, csvIndexWeek: 11, order: 11 },
      { key: "total_costs", label: "Загальні витрати, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 12, csvIndexWeek: 12, order: 12 },
      { key: "receivables", label: "Дебіторка (знімок), грн", unit: "uah", source: "auto", aggregation: "last", csvIndexMonth: 13, csvIndexWeek: 13, order: 13,
        // 🔴 Підпис каже «знімок» СВІДОМО. `receivables` TRUNCATE-иться синком кожні
        // 15 хв і має лише `synced_at` — історії боргу в базі немає, тож «дебіторка за
        // червень» ретроспективно не рахується. У бакеті лежить ОСТАННІЙ знімок
        // усередині нього: для закритого місяця це його кінець, для поточного — «зараз».
        // Без цього слова знімок читався б як період — та сама хиба, що вже живе в
        // payment_received / invoiced_amount / managers_count, підписаних періодними.
        note: "ЗНІМОК, не період: борг станом на останній перерахунок усередині бакета (для закритого місяця — на його кінець). Джерело — ядро дебіторки, те саме, що на екрані «Дебіторка»" },
      { key: "net_profit", label: "Чистий прибуток, грн", unit: "uah", source: "manual", aggregation: "sum", csvIndexMonth: 14, csvIndexWeek: 14, order: 14 },
    ],
  },
  {
    key: "hr",
    label: "HR-відділ",
    tabMonth: "HR-відділ М",
    tabWeek: "HR-відділ Т",
    hasTeamLeadBreakdown: false,
    csvDateIndex: 0,
    // CSV: 0 дата,1 найняті,2 звільнені,3 резюме,4 співбесіди,5 на навчання,6 відмови,
    //  7 сер.час закриття,8 конверсія,9 плинність нових,10 заг.плинність,11 заг.к-ть,12 відвід.тренінгів
    metrics: [
      { key: "hired", label: "К-ть найнятих", unit: "count", source: "manual", aggregation: "sum", csvIndexMonth: 1, csvIndexWeek: 1, order: 1 },
      { key: "fired", label: "К-ть звільнених", unit: "count", source: "manual", aggregation: "sum", csvIndexMonth: 2, csvIndexWeek: 2, order: 2 },
      { key: "resumes", label: "К-ть оброблених резюме", unit: "count", source: "manual", aggregation: "sum", csvIndexMonth: 3, csvIndexWeek: 3, order: 3 },
      { key: "interviews", label: "К-ть проведених співбесід", unit: "count", source: "manual", aggregation: "sum", csvIndexMonth: 4, csvIndexWeek: 4, order: 4 },
      { key: "to_training", label: "К-ть виведених на навчання", unit: "count", source: "manual", aggregation: "sum", csvIndexMonth: 5, csvIndexWeek: 5, order: 5 },
      { key: "offer_declines", label: "К-ть відмов від оферу", unit: "count", source: "manual", aggregation: "sum", csvIndexMonth: 6, csvIndexWeek: 6, order: 6 },
      { key: "avg_vacancy_days", label: "Сер. час закриття вакансії, дн", unit: "count", source: "manual", aggregation: "avg", csvIndexMonth: 7, csvIndexWeek: 7, order: 7 },
      { key: "conversion", label: "Конверсія, %", unit: "percent", source: "manual", aggregation: "avg", csvIndexMonth: 8, csvIndexWeek: 8, order: 8 },
      { key: "new_turnover", label: "Плинність нових, %", unit: "percent", source: "manual", aggregation: "avg", csvIndexMonth: 9, csvIndexWeek: 9, order: 9 },
      { key: "total_turnover", label: "Загальна плинність, %", unit: "percent", source: "manual", aggregation: "avg", csvIndexMonth: 10, csvIndexWeek: 10, order: 10 },
      { key: "headcount", label: "Загальна к-ть співробітників", unit: "count", source: "manual", aggregation: "last", csvIndexMonth: 11, csvIndexWeek: 11, order: 11 },
      { key: "training_attendance", label: "Відвідуваність тренінгів, %", unit: "percent", source: "manual", aggregation: "avg", csvIndexMonth: 12, csvIndexWeek: 12, order: 12 },
    ],
  },
  {
    key: "logistics",
    label: "Відділ логістики",
    tabMonth: "Відділ логістики М",
    tabWeek: "Відділ логістики Т",
    hasTeamLeadBreakdown: false,
    csvDateIndex: 0,
    // CSV: 0 дата,1 постійні клієнти в роботі,2 машини постійних,3 сума від постійних,
    //  4 сер.чек,5 поставлені машини з усіх
    metrics: [
      { key: "repeat_clients_active", label: "Постійні клієнти в роботі", unit: "count", source: "auto", aggregation: "last", csvIndexMonth: 1, csvIndexWeek: 1, order: 1 },
      { key: "repeat_machines", label: "Машини постійних клієнтів", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 2, csvIndexWeek: 2, order: 2 },
      { key: "repeat_revenue", label: "Сума від постійних, грн", unit: "uah", source: "auto", aggregation: "sum", csvIndexMonth: 3, csvIndexWeek: 3, order: 3 },
      { key: "avg_check", label: "Середній чек (постійні), грн", unit: "uah", source: "derived", aggregation: "avg", formula: "repeat_revenue / repeat_machines", csvIndexMonth: 4, csvIndexWeek: 4, order: 4 },
      { key: "machines_dispatched_total", label: "Поставлені машини (всі клієнти)", unit: "count", source: "auto", aggregation: "sum", csvIndexMonth: 5, csvIndexWeek: 5, order: 5 },
    ],
  },
];

/** team_id → прізвище тімліда в листі (для sales-розрізу; R2: 4/no-manager→Шевчук). */
export const SALES_TEAM_LEAD: Record<number, string> = {
  5: "Яцик",
  6: "Дмитрук",
  13: "Безпамятний",
  14: "Шаврова",
  15: "Михальчевська",
  4: "Шевчук Назар", // «Самостійний» → Шевчук (R2)
};
/** Куди складати угоди без менеджера / поза командами (R2). */
export const SALES_FALLBACK_LEAD = "Шевчук Назар";
/** Нормалізація прізвища з листа → канон (R2: «самостійні»→«Шевчук Назар»). */
export function canonTeamLead(raw: string): string {
  const s = raw.trim();
  if (/самост/i.test(s)) return "Шевчук Назар";
  if (/^шевчук/i.test(s)) return "Шевчук Назар";
  return s;
}

// Межа довіри до auto-перерахунку sales: до цієї дати CRM-історія в нашій БД
// НЕПОВНА (глибокі угоди не досинхронізовані — див. docs/STATISTICS_RECONCILIATION.md),
// тож старіші періоди лишаємо imported (значення з листа). Від цієї дати CRM ≈ лист
// (звірка: розбіжність revenue_won ≤5%), тому period_start >= цієї межі → auto.
export const STATS_AUTO_FROM = "2026-01-01";
// Метрики sales, які НЕ перезаписуємо auto навіть у межах довіри:
//  cash_deals_amount — payment_type у БД заповнений неповно (auto недобирає ~60%),
//  тож готівка лишається imported до бекфілу payment_type.
export const SALES_AUTO_METRICS = ["revenue_won", "machines_success", "machines_dispatched"];

export const DEPARTMENTS = CATALOG.map((d) => d.key);
export function getDepartment(key: string): DepartmentDef | undefined {
  return CATALOG.find((d) => d.key === key);
}
export function getMetric(dept: string, key: string): MetricDef | undefined {
  return getDepartment(dept)?.metrics.find((m) => m.key === key);
}
