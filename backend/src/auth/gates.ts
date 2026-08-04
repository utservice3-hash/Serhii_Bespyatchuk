/**
 * 🔒 АРХІТЕКТУРНІ ВОРОТА (крок B) — правила, які раніше жили в промтах власника,
 * тепер живуть у коді й перевіряються набором.
 *
 * Мета одна: щоб НОВА фіча фізично не могла бути написаною повз ядро й повз межі
 * доступу — незалежно від того, хто її пише і чи згадав хтось про перевірку.
 *
 * 🔴 СПІЛЬНИЙ ПРИНЦИП УСІХ ЧОТИРЬОХ РЕЄСТРІВ НИЖЧЕ. Виняток дозволений, але його
 * треба НАЗВАТИ ВГОЛОС: рядок у реєстрі з причиною текстом. Це та сама ціна, що й
 * у маніфесті набору — зміна має бути свідомою, а не побічним ефектом.
 * Порожня причина = червоний тест: реєстр не сміє стати смітником, бо мертвий запис
 * глушив би справжнє порушення.
 */

// ─────────────────────────────────────────────────────────────────────────────
// B2 · ЗУСТРІЧНИЙ ДЕФОЛТ: роут БЕЗ явної межі — помилка конфігурації
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 🔴 НАВІЩО. У `rbac.ts` роками стояло припущення «решта `/api/dashboard/*` — без
 * tab-гейта, scope все одно клампить». Для company-ролі клампа НЕМАЄ за визначенням,
 * тож щойно HR отримав `data_scope='company'`, три оглядові ендпоінти відкрились
 * ролі, у якої немає ні «overview», ні «loyalty», ні «manager-report».
 *
 * Дефолт був хибний: «немає межі → дозволено». Тепер навпаки — «немає межі →
 * ЧЕРВОНИЙ ТЕСТ з назвою роута». Наступна така діра не доживе до інциденту.
 */
export interface RouteExemption {
  method: string;
  path: string;
  /** Чому цей роут не має ані ROUTE_TAB, ані perm-гейта. Порожньо = червоний. */
  why: string;
  /** `true` — межі не буде ніколи (свідомо публічний). `false` — борг, закриємо. */
  permanent: boolean;
}

/**
 * Роути без явної межі — зафіксовані «як є» станом на 01.08.2026.
 *
 * ⚠️ ЖОДЕН ІЗ НИХ НЕ ЗАКРИТО В ЦЬОМУ КРОЦІ. Крок B не змінює поведінку; кожен
 * рядок із `permanent: false` — це борг із готовою пропозицією в
 * `docs/SCOPE_ONLY_ROUTES.md`, яку розсуджує власник ОДНИМ рішенням.
 */
export const ROUTE_BOUNDARY_EXEMPTIONS: RouteExemption[] = [
  { method: "POST", path: "/api/auth/login", permanent: true,
    why: "Логін — єдиний роут ДО автентифікації. Межа тут неможлива за визначенням." },
  { method: "POST", path: "/api/auth/logout", permanent: true,
    why: "Вихід із сесії — доступний будь-кому автентифікованому, межа не потрібна." },
  { method: "GET", path: "/api/auth/me", permanent: true,
    why: "Профіль ВЛАСНОГО токена. Скоуп визначено самим токеном, чужого не віддає." },
  { method: "GET", path: "/api/dashboard/sync-status", permanent: false,
    why: "Стан синку (не дані). Відкритий усім автентифікованим — борг, пропозиція: tab «settings»." },
  { method: "GET", path: "/api/dashboard/leadgen-regulars", permanent: false,
    why: "Постійні від підігріву. Відкритий усім — борг, пропозиція: tab «leadgen»." },
  { method: "GET", path: "/api/dashboard/repeat-client-history", permanent: false,
    why: "Історія клієнта. Відкритий усім — борг, пропозиція: tab «loyalty»." },
  { method: "GET", path: "/api/dashboard/conversion-timeseries", permanent: false,
    why: "МЕРТВИЙ, кандидат на видалення. Єдиний споживач — `ConversionTrendCard`, а він рендериться лише в `ReportSection.tsx`, який НІДЕ не імпортується. У прод-бандлі рядка «conversion-timeseries» немає (tree-shaking викинув). Межу навмання не ставимо — ставити нікуди." },
  { method: "GET", path: "/api/dashboard/daily", permanent: false,
    why: "МЕРТВИЙ, кандидат на видалення. Те саме: `DailyProductivityCard` живе лише в мертвому `ReportSection.tsx`; рядка «dashboard/daily» у прод-бандлі немає." },
  { method: "GET", path: "/api/dashboard/expected-deals", permanent: false,
    why: "МЕРТВИЙ, кандидат на видалення. `fetchExpectedDeals` не має ЖОДНОГО виклику у фронті — навіть мертвого." },
  { method: "GET", path: "/api/dashboard/funnel-weekly", permanent: false,
    why: "МЕРТВИЙ, кандидат на видалення. `fetchFunnelWeekly` без викликів поза `api.ts`; рядка «funnel-weekly» у прод-бандлі немає." },
  { method: "POST", path: "/api/tracker/auth", permanent: true,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: свідомо публічний — трекер має ВЛАСНУ авторизацію (device-токен), без JWT." },
  { method: "POST", path: "/api/tracker/heartbeat", permanent: true,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: свідомо публічний — той самий device-токен." },
  { method: "POST", path: "/api/tracker/logout", permanent: true,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: свідомо публічний — той самий device-токен." },
];

/**
 * 🪦 КАНДИДАТИ НА ВИДАЛЕННЯ — роути, яких НІХТО не викликає.
 *
 * 🔴 Навіщо окремий реєстр, а не «просто видалити». Мертвий роут не можна гейтити
 * «навмання»: вкладку немає з чого вивести, бо немає споживача, і будь-який мапінг був
 * би вигадкою. Але й лишати його в реєстрі межі мовчки не можна — там він виглядав би
 * як звичайний борг, який колись закриють вкладкою.
 *
 * 🔎 Доказ смерті — ТРИ незалежні, бо кожен окремо бреше:
 *   1) немає виклику функції-обгортки поза `api.ts`;
 *   2) компонент-споживач (якщо є) сам рендериться лише з файла, який ніхто не імпортує;
 *   3) рядка шляху НЕМАЄ у зібраному прод-бандлі — tree-shaking його викинув.
 * Третій пункт головний: він міряє те, що реально поїхало користувачу, а не наміри коду.
 *
 * ⚠️ Видалення — ОКРЕМЕ рішення власника, не побічний ефект цього кроку.
 */
export interface DeadRouteCandidate { method: string; path: string; why: string }
export const DEAD_ROUTE_CANDIDATES: DeadRouteCandidate[] = [
  { method: "GET", path: "/api/dashboard/conversion-timeseries",
    why: "ConversionTrendCard → лише ReportSection.tsx (файл ніде не імпортується); рядка немає у прод-бандлі." },
  { method: "GET", path: "/api/dashboard/daily",
    why: "DailyProductivityCard → лише ReportSection.tsx; рядка немає у прод-бандлі." },
  { method: "GET", path: "/api/dashboard/expected-deals",
    why: "fetchExpectedDeals не викликається взагалі — навіть із мертвого файла." },
  { method: "GET", path: "/api/dashboard/funnel-weekly",
    why: "fetchFunnelWeekly без викликів поза api.ts; рядка немає у прод-бандлі." },
  { method: "GET", path: "/api/dashboard/repeat-plans-grid",
    why: "ВИВОДИТЬСЯ З УЖИТКУ з 03.08.2026: компонент RepeatPlanGrid прибрано з екрана "
       + "(рахував факт зі знімком етапу 9 — метрику ②, якої на екрані клієнтів бути не "
       + "повинно за правилом власника 02.08.2026), заміна — GET /api/dashboard/client-plans. "
       + "Роут лишається живим ОДИН спринт: рішення власника — зникнення має бути рішенням, "
       + "а не наслідком. ⏳ ПЕРЕГЛЯНУТИ ПІСЛЯ 2026-09-01: якщо звернень немає — видалити "
       + "разом із /repeat-client-plan* і repeat_client_plan_history." },
  // 🪦 ТРИ СТАРІ БЛОКИ ЕКРАНА КЛІЄНТІВ, прибрані з UI 04.08.2026 (рішення власника).
  // Роути лишаються живими — зникнення має бути рішенням, а не наслідком правки UI.
  // Доказ смерті для всіх пʼяти рядків — той самий і повний:
  //   (1) обгортки `fetchRegularClients` / `addReactivationClient` не кличе НІХТО;
  //       `fetchReactivation`/`update…`/`remove…` — лише `ReactivationGrid.tsx`;
  //   (2) `ReactivationGrid` рендериться ЛИШЕ з `ReportSection.tsx`, а той файл не
  //       імпортує ніхто (Dashboard.tsx бере ManagerReportSection/KvpReportSection);
  //   (3) рядків "/dashboard/reactivation" (точний, без дефіса) і "regular-clients"
  //       у прод-бандлі НЕМАЄ — заміряно `grep` по dist/assets/index-*.js.
  // ⚠️ ДАНІ НЕ ЧІПАЄМО: у `reactivation_clients` лишились 6 живих рядків (усі
  // «в роботі», без дат контактів/результатів/коментарів — замір 04.08.2026).
  // Що з ними робити — питання до власника, а не побічний ефект прибирання UI.
  // ⏳ ПЕРЕГЛЯНУТИ ПІСЛЯ 2026-10-01.
  { method: "GET", path: "/api/dashboard/regular-clients",
    why: "Блок «Усі постійні клієнти (усі команди)» прибрано з екрана; заміна — "
       + "GET /api/dashboard/client-plans (ієрархія команда → менеджер → клієнти). "
       + "fetchRegularClients не кличе ніхто; рядка немає у прод-бандлі." },
  { method: "GET", path: "/api/dashboard/reactivation",
    why: "Грід «🔄 Реактивація — клієнти в роботі» прибрано; заміна — "
       + "GET /api/dashboard/reactivation-list + задачі `reactivation_client`. "
       + "Єдиний споживач — ReactivationGrid.tsx із мертвого ReportSection.tsx." },
  { method: "POST", path: "/api/dashboard/reactivation",
    why: "Кнопки «➕ в реактивацію» прибрано разом із грідом: вони писали в таблицю, "
       + "якої ніхто не показує. Обгортка addReactivationClient без викликів." },
  { method: "PUT", path: "/api/dashboard/reactivation",
    why: "Редагування рядків того самого гріда (1-й/2-й контакт, результат, статус)." },
  { method: "DELETE", path: "/api/dashboard/reactivation/:clientKey",
    why: "Видалення рядка того самого гріда." },
  { method: "GET", path: "/api/dashboard/kvp-extra",
    why: "fetchKvpExtra без викликів. Межу все одно поставлено (tab «kvp») — роут живе в КВП-родині "
       + "й у MASTER_PLAN стоїть на переведення в ядро; закрити його дешевше, ніж лишити відкритим до видалення." },
];

// ─────────────────────────────────────────────────────────────────────────────
// B3 · МЕТРИКА МИМО ЯДРА НЕ ПРОХОДИТЬ
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 🔴 НАВІЩО. `core/money.ts` — єдине джерело грошових метрик: анкер по даті входу в
 * етап + дедуплікація. Свій SQL по виручці в роуті обходить обидва правила, і
 * розбіжність спливає через місяці як «дашборд бреше». Ми вже закрили це для AI,
 * замінивши вільний SQL на `get_metric`; тут — те саме для решти коду.
 *
 * Ознаки «метрики» в сирому SQL: суми/середні по `price`, фільтри по стадіях
 * (`status_id`, `142`), грошові анкери (`closed_at`).
 */
export interface CoreExemption { file: string; why: string }

/**
 * 🔎 ТРИ КЛАСИ SQL із грошима/стадіями. Детектор дивиться не на форму запиту, а на
 * те, ЩО САМЕ обмежує вибірку в часі — бо саме там і живе різниця між метрикою і
 * предикатом.
 *
 *   `money-period`     — є фільтр періоду по ГРОШОВОМУ анкері (`closed_at`/`changed_at`).
 *                        Це гроші за проміжок → мусить рахувати `core/money.ts`.
 *   `created-cohort`   — період по `created_at`. Законно (когорта СТВОРЕННЯ: «скільки
 *                        завели», воронка клієнтів), але має бути НАЗВАНА поіменно.
 *   `lifetime`         — періоду немає взагалі. `funnel_stage='paid'` тут означає
 *                        «клієнт КОЛИСЬ платив» — предикат сегментації, не метрика.
 *
 * 🔴 Навіщо саме так. Раніше `#17c` дивився на файл цілком: один сирий SUM(price)
 * робив увесь `dashboard.ts` винятком, і ворота ставали сліпі на 5000 рядків — рівно
 * те, від чого ми йшли. Класифікація по БЛОКУ звужує виняток із «увесь файл» до
 * названих запитів. Замір, що це працює: у `dashboard.ts` було 35 збігів у 18 блоках,
 * із них 28 — lifetime, 7 — дві когорти, і НУЛЬ money-period.
 */
export type SqlClass = "money-period" | "created-cohort" | "lifetime";
/** Грошова/стадійна ознака — те, що взагалі робить запит кандидатом. */
export const METRIC_SQL = /\b(SUM|AVG)\s*\(\s*[a-z_.]*price|status_id\s*(=|IN)|closed_at\s+BETWEEN|'142'|\b142\b\s*\)/i;
const MONEY_PERIOD = /(closed_at\w*|anchor_at|changed_at)[^\n]{0,90}(BETWEEN|>=|<=|<|>)|date_trunc\('\w+'\s*,\s*[^)]*?(closed_at|anchor_at|changed_at)/i;
const CREATED_PERIOD = /created_at\w*[^\n]{0,90}(BETWEEN|>=|<=|<|>)|date_trunc\('(day|week|month)'\s*,\s*[a-z_.]*created_at/i;

export function classifySql(q: string): SqlClass | null {
  if (!METRIC_SQL.test(q)) return null;
  if (MONEY_PERIOD.test(q)) return "money-period";
  if (CREATED_PERIOD.test(q)) return "created-cohort";
  return "lifetime";
}

/**
 * Когорти СТВОРЕННЯ, названі поіменно. Кожна — законна, але мусить бути свідомою:
 * саме тут колись і сховався анкер `created_at` у грошах.
 */
export interface CohortExemption { file: string; frag: string; why: string }
export const CREATED_COHORT_EXEMPTIONS: CohortExemption[] = [
  { file: "routes/dashboard.ts", frag: "AS dispatched",
    why: "/overview «Історія за 3 місяці» — КІЛЬКОСТІ (створено/поставлено/нові/постійні) "
       + "за місяцем створення. Гроші цього блоку переведено на `successByBucket` 02.08.2026, "
       + "а мертву колонку `revenue` прибрано; лишились самі лічильники, і вони про «скільки "
       + "завели», а не «скільки грошей»." },
  { file: "routes/dashboard.ts", frag: "AS carryover",
    why: "/funnel-report «перенесені»: `SUM(price) FILTER (в роботі AND created_at < період)`. "
       + "Тут `created_at` І Є означенням перенесеної угоди — створена до періоду й досі в "
       + "роботі. Грошового анкера в неї ще НЕ ІСНУЄ, бо вона не оплачена." },
];

/** Місця, де сирий SQL із грошима/стадіями лишається свідомо. */
export const CORE_BYPASS_EXEMPTIONS: CoreExemption[] = [
  { file: "routes/statistics.ts",
    why: "Розділ «Статистики (відділи)» читає EAV-таблицю statistics_values, а не угоди. "
       + "Це не метрика ядра, а імпортовані/ручні показники — ядру там нема що рахувати." },
  { file: "routes/plans.ts",
    why: "Плани — таблиця `plans`, не гроші з угод. Ядро планів (core/plans.ts) дає розкладку, "
       + "а роут читає збережені значення." },
];

// ─────────────────────────────────────────────────────────────────────────────
// B3b · КАНОНІЧНИЙ client_key ПИШЕ ЛИШЕ ПЕРЕРАХУНОК
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 🔴 НАВІЩО. Модель: `deals.client_key_raw` — те, що порахував синк; `client_key` —
 * похідна (`COALESCE(активний аліас, raw)`). Варто комусь через півроку написати в
 * `client_key` НАПРЯМУ — і аліас для цієї угоди мовчки перестане діяти. Найгірше,
 * що зламається саме те, що змінюється найчастіше: угоди, які синк оновлює щодня.
 *
 * Тому запис у `deals.client_key` дозволений РІВНО у трьох місцях, і кожне з них
 * обчислює канонічний із `raw` через реєстр псевдонімів, а не пише сире значення.
 */
export interface CanonWriteExemption { file: string; why: string }
export const CLIENT_KEY_WRITERS: CanonWriteExemption[] = [
  { file: "jobs/clientKeySql.ts",
    why: "ВИРАЗ перерахунку (`RECOMPUTE_SQL`) — саме той рядок, що його виконує джоба і "
       + "перевіряє #21. Живе окремо БЕЗ імпортів, щоб тест і робочий код брали ОДИН SQL, "
       + "а не схожий: інакше доказ зворотності перевіряв би текст, а не поведінку." },
  { file: "jobs/recomputeClientKeys.ts",
    why: "ВЛАСНЕ перерахунок: єдине місце, що має право змінювати канонічний ключ масово." },
  { file: "jobs/syncKommo.ts",
    why: "Upsert угоди: пише `client_key_raw`, а канонічний обчислює підзапитом до "
       + "`client_key_alias` — інакше синк затер би чинний аліас при наступному оновленні." },
  { file: "jobs/backfillClientKeys.ts",
    why: "Бекфіл ключів із Kommo: те саме — сирий від Kommo, канонічний із реєстру." },
];

// ─────────────────────────────────────────────────────────────────────────────
// B4 · РЯДОК БД НЕ ВІДДАЄТЬСЯ СПРЕДОМ
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 🔴 НАВІЩО. Витік реквізитів стався саме так: `return { ...a }` віддавав УСЕ, що
 * було в рядку `bank_accounts`, і нова колонка (`key_card`) поїхала назовні сама,
 * без жодної правки роута. Явний перелік полів робить розширення відповіді
 * СВІДОМИМ рішенням, а не наслідком міграції.
 *
 * Правило лишається чинним НЕЗАЛЕЖНО від політики доступу: політика вирішує, ЩО
 * можна віддавати, а це правило — щоб нічого не поїхало БЕЗ рішення.
 */
export interface SpreadExemption { file: string; frag: string; why: string }

/**
 * 🔴 УТОЧНЕННЯ ПІСЛЯ ЗАМІРУ (01.08.2026): справжня межа — це SELECT, а не спред.
 *
 * Реквізити протекли не тому, що був `{ ...a }`, а тому що SELECT перелічував 19
 * колонок і спред пропускав їх усі. Там, де SELECT називає колонки поіменно, спред
 * несе рівно їх — нова колонка в таблиці туди НЕ потрапить.
 *
 * Тому головні ворота — `SELECT *` (зараз у роутах його 0, і це треба втримати), а
 * спреди лишаються під реєстром: більшість із них узагалі не рядки БД, а обчислені
 * акумулятори.
 */
export const ROW_SPREAD_EXEMPTIONS: SpreadExemption[] = [
  { file: "routes/bank.ts", frag: "return { ...b, balance_",
    why: "SELECT вище називає РІВНО 6 колонок (id, label, company, balance_amount, "
       + "balance_currency, balance_updated_at) — спред несе тільки їх. Нова колонка в "
       + "bank_accounts сюди не поїде. Плюс роут за правом view_balances." },
  { file: "routes/dashboard.ts", frag: "({ ...row, date })",
    why: "Акумулятор поденної агрегації, зібраний у памʼяті циклом. Не рядок БД." },
  { file: "routes/dashboard.ts", frag: "({ month: monthKey, ...row })",
    why: "Той самий акумулятор, помісячний зріз." },
  { file: "routes/dashboard.ts", frag: "({ ...g,",
    why: "`g` — згрупований у памʼяті обʼєкт із byManager.values(), не рядок БД." },
  { file: "routes/dashboard.ts", frag: "({ ...e, a",
    why: "`e` — елемент обчисленого ряду по періодах." },
  { file: "routes/dashboard.ts", frag: "return { ...e,",
    why: "Той самий обчислений ряд, збагачений конверсією." },
  { file: "routes/dashboard.ts", frag: "return { ...s, planMonth",
    why: "`s` — етап воронки з обчисленого масиву, не рядок БД." },
  { file: "routes/dashboard.ts", frag: "({ ...m,",
    why: "`m` — обчислений рядок по менеджеру (byManager), не рядок БД." },
  { file: "routes/dashboard.ts", frag: "return { ...d, conversion:",
    why: "`d` — елемент обчисленого dirSplit (розріз по напрямках)." },
  { file: "routes/plans.ts", frag: "successByManagerMonth({ ...sco",
    why: "Спред у АРГУМЕНТ виклику ядра, а не у відповідь. Назовні не їде." },
  { file: "routes/plans.ts", frag: "clientSplitForPlan({ ...scop",
    why: "Той самий спред scope в аргумент ядра." },
  { file: "routes/settings.ts", frag: "const merged = { ..",
    why: "Мердж дефолтів налаштувань у памʼяті; app_settings — одна JSON-колонка, "
       + "нових колонок там не зʼявляється за побудовою." },
  { file: "routes/statisticsSeries.ts", frag: "{ ...company, benchmark: true",
    why: "`company` — обчислений ScopeSpec, не рядок БД." },
  { file: "routes/statistics.ts", frag: "({ ...x, value:",
    why: "statistics_values — EAV фіксованої форми (department/period_type/period_start/"
       + "team_lead/metric_key/value/source). Описує ПОКАЗНИКИ відділів, не людей." },
  { file: "routes/tasks.ts", frag: "({ ...m, a",
    why: "`m` — обчислена поденна метрика, не рядок БД." },
  { file: "routes/tasks.ts", frag: "clients.map((c) => ({",
    why: "Побудова чеклісту реактивації з обчисленого списку клієнтів." },
];

// ─────────────────────────────────────────────────────────────────────────────
// СПІЛЬНА ПЕРЕВІРКА РЕЄСТРІВ
// ─────────────────────────────────────────────────────────────────────────────
/** Кожен виняток мусить мати НЕПОРОЖНЮ причину — інакше реєстр стає смітником. */
export function exemptionsWithoutReason(): string[] {
  const bad: string[] = [];
  for (const e of ROUTE_BOUNDARY_EXEMPTIONS) if (!e.why.trim()) bad.push(`межа: ${e.method} ${e.path}`);
  for (const e of CORE_BYPASS_EXEMPTIONS) if (!e.why.trim()) bad.push(`ядро: ${e.file}`);
  for (const e of ROW_SPREAD_EXEMPTIONS) if (!e.why.trim()) bad.push(`спред: ${e.file} ${e.frag}`);
  for (const e of DEAD_ROUTE_CANDIDATES) if (!e.why.trim()) bad.push(`мертвий: ${e.method} ${e.path}`);
  for (const e of CREATED_COHORT_EXEMPTIONS) if (!e.why.trim()) bad.push(`когорта: ${e.file} ${e.frag}`);
  return bad;
}
