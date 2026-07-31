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
  { method: "DELETE", path: "/api/dashboard/loyalty-override/:clientKey", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «loyalty»." },
  { method: "GET", path: "/api/dashboard/conversion-timeseries", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «overview»." },
  { method: "GET", path: "/api/dashboard/daily", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «overview»." },
  { method: "GET", path: "/api/dashboard/data-quality", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «dataquality»." },
  { method: "GET", path: "/api/dashboard/expected-deals", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «overview»." },
  { method: "GET", path: "/api/dashboard/funnel-weekly", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «overview»." },
  { method: "GET", path: "/api/dashboard/kvp-extra", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «kvp» — та сама причина." },
  { method: "GET", path: "/api/dashboard/kvp-plan", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «kvp» — та сама причина." },
  { method: "GET", path: "/api/dashboard/kvp-report", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «kvp» (зараз pre(/api/dashboard/kvp) не матчить kvp-report — дефіс, не слеш)." },
  { method: "GET", path: "/api/dashboard/kvp-report/manager-detail", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «kvp» — та сама причина." },
  { method: "GET", path: "/api/dashboard/lead-recommendation", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «leadgen»." },
  { method: "GET", path: "/api/dashboard/loyalty-overrides", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «loyalty»." },
  { method: "GET", path: "/api/dashboard/reactivation-candidates", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «loyalty»." },
  { method: "GET", path: "/api/dashboard/report-plan", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «report»." },
  { method: "GET", path: "/api/dashboard/report-plan/deals", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «report»." },
  { method: "GET", path: "/api/dashboard/response-time", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «overview»." },
  { method: "GET", path: "/api/dashboard/stuck-deals-grouped", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «dataquality»." },
  { method: "POST", path: "/api/dashboard/deal-note", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «dataquality» (нотатка до угоди — робота з якістю даних)." },
  { method: "POST", path: "/api/dashboard/kvp-plan", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «kvp» — та сама причина." },
  { method: "POST", path: "/api/dashboard/loyalty-override", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: tab «loyalty»." },
  { method: "POST", path: "/api/dashboard/sync", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: право (нове) `run_sync` — запуск синку це дія, не екран." },
  { method: "POST", path: "/api/dashboard/sync-receivables", permanent: false,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: право `run_sync` — те саме." },
  { method: "POST", path: "/api/tracker/auth", permanent: true,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: свідомо публічний — трекер має ВЛАСНУ авторизацію (device-токен), без JWT." },
  { method: "POST", path: "/api/tracker/heartbeat", permanent: true,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: свідомо публічний — той самий device-токен." },
  { method: "POST", path: "/api/tracker/logout", permanent: true,
    why: "Зафіксовано «як є» 01.08.2026. Межі немає; пропозиція: свідомо публічний — той самий device-токен." },
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

/** Місця, де сирий SQL із грошима/стадіями лишається свідомо. */
export const CORE_BYPASS_EXEMPTIONS: CoreExemption[] = [
  { file: "routes/dashboard.ts",
    why: "Історичний обсяг: частина віджетів рахує власним SQL ще до появи core/money.ts. "
       + "Переписування — окрема робота з поштучною звіркою кожної цифри проти ядра, "
       + "а не побічний ефект кроку B (він не змінює поведінку)." },
  { file: "routes/statistics.ts",
    why: "Розділ «Статистики (відділи)» читає EAV-таблицю statistics_values, а не угоди. "
       + "Це не метрика ядра, а імпортовані/ручні показники — ядру там нема що рахувати." },
  { file: "routes/messages.ts",
    why: "Лідерборд у месенджері рахує SUM(d.price) власним SQL. Це борг: цифра там може "
       + "розійтися з «Отриманими коштами» ядра, бо не має ні дедупу 9∪10, ні анкера по "
       + "даті входу. Переписування — окрема робота зі звіркою, не побічний ефект кроку B." },
  { file: "routes/plans.ts",
    why: "Плани — таблиця `plans`, не гроші з угод. Ядро планів (core/plans.ts) дає розкладку, "
       + "а роут читає збережені значення." },
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
  return bad;
}
