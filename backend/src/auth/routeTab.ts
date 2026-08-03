/**
 * 🔒 РОУТ → ВКЛАДКИ. Винесено з `rbac.ts` 01.08.2026.
 *
 * Причина виносу суто механічна: `rbac.ts` тягне `db/pool.js` → `config.js`, який кидає без
 * `DATABASE_URL` ще на імпорті. Через це архітектурні ворота (#17) не могли працювати
 * у звичайному `npm test` — а ворота, що виконуються лише в прод-режимі, це той самий
 * «скіп, який ніколи не виконувався», на якому ми вже горіли (#8).
 *
 * Тут НЕМАЄ жодного імпорту. Додаючи щось у цей файл — не додавай і надалі.
 *
 * 🔑 ВКЛАДКА — СПИСОК, А НЕ ОДНА (02.08.2026). Семантика: «БУДЬ-ЯКА з них». Роут
 * доступний, якщо роль має хоч одну з перелічених вкладок. Одна вкладка на роут була
 * припущенням, а не правилом: `kvp-report/manager-detail` малює і Звіт КВП
 * (`KvpReportSection`), і Звіт (`ReportPlanSection`). Прив'язати його до однієї вкладки
 * означало б забрати екран у тімліда, який має «report», але не має «kvp».
 * Наскрізна перевірка фронту дала РІВНО ОДИН такий роут — решта односпоживацькі,
 * і списки в них із одного елемента.
 */
// ── Роут → вкладки (для серверного tab-гейта). Найбільш специфічні префікси — першими.
// null (немає в мапі) → гейт пропускає (auth усе одно обов'язковий).
const ROUTE_TAB: { test: (p: string) => boolean; tabs: string[] }[] = (() => {
  const pre = (prefix: string) => (p: string) => p === prefix || p.startsWith(prefix + "/");
  return [
    // ⚠️ `pre()` матчить лише по СЛЕШУ, тож `pre("/api/dashboard/kvp")` НЕ покриває
    // `kvp-report`/`kvp-plan`/`kvp-extra` — там дефіс. Патерн лишаємо як є (він
    // правильний: «сусід через дефіс» — це інший роут), а дефісних сусідів прописуємо
    // ЯВНО. Точний перелік важливіший за спритний патерн.
    { test: pre("/api/dashboard/kvp"), tabs: ["kvp"] },
    { test: pre("/api/dashboard/kvp-plan"), tabs: ["kvp"] },
    { test: pre("/api/dashboard/kvp-extra"), tabs: ["kvp"] },
    // ДВА СПОЖИВАЧІ — єдиний такий роут у застосунку (перевірено обходом фронту):
    // `KvpReportSection` (вкладка kvp) і `ReportPlanSection` (вкладка report).
    // Найбільш специфічний шлях мусить іти ПЕРЕД `/api/dashboard/kvp-report`.
    { test: pre("/api/dashboard/kvp-report/manager-detail"), tabs: ["kvp", "report"] },
    { test: pre("/api/dashboard/kvp-report"), tabs: ["kvp"] },
    { test: pre("/api/dashboard/plans-grid"), tabs: ["plans"] },
    { test: pre("/api/dashboard/repeat-plans-grid"), tabs: ["plans"] },
    { test: pre("/api/dashboard/repeat-client-plan"), tabs: ["plans"] },
    { test: pre("/api/dashboard/funnel-plan"), tabs: ["plans"] },
    { test: pre("/api/dashboard/lead-recommendation"), tabs: ["plans"] },
    { test: pre("/api/dashboard/report-plan"), tabs: ["report"] },
    { test: pre("/api/dashboard/report"), tabs: ["report"] },
    { test: pre("/api/dashboard/funnel-report"), tabs: ["report"] },
    { test: pre("/api/dashboard/response-time"), tabs: ["report"] },
    { test: pre("/api/dashboard/stuck-deals-grouped"), tabs: ["report"] },
    { test: pre("/api/dashboard/deal-note"), tabs: ["report"] },
    { test: pre("/api/dashboard/personal"), tabs: ["manager-report"] },
    { test: pre("/api/dashboard/teams"), tabs: ["teams"] },
    { test: pre("/api/dashboard/managers"), tabs: ["managers"] },
    // ФАЗА A · «Постійні клієнти · план місяця» — заміна екрана «Клієнти та
    // реактивація», тож вкладка та сама. `pre` матчить ПО СЛЕШУ, тому
    // `/client-plans` і `/client-comments` — окремі записи, а не один префікс:
    // сусід через дефіс є ІНШИМ роутом.
    { test: pre("/api/dashboard/client-plans"), tabs: ["loyalty"] },
    // ФАЗА B. `client-seasonal` і `client-manager` — окремі записи, а не один
    // префікс `client-`: сусід через дефіс є ІНШИМ роутом (pre матчить по слешу).
    { test: pre("/api/dashboard/client-seasonal"), tabs: ["loyalty"] },
    { test: pre("/api/dashboard/client-manager"), tabs: ["loyalty"] },
    { test: pre("/api/dashboard/reactivation-list"), tabs: ["loyalty"] },
    // Задача реактивації живе на екрані клієнтів, але веде в задачник — доступ
    // мають обидві вкладки: тімлід відкриває її зі списку, менеджер бачить у себе.
    { test: pre("/api/dashboard/reactivation-task"), tabs: ["loyalty", "tasks"] },
    { test: pre("/api/dashboard/client-plan"), tabs: ["loyalty"] },
    { test: pre("/api/dashboard/client-comments"), tabs: ["loyalty"] },
    { test: pre("/api/dashboard/loyalty"), tabs: ["loyalty"] },
    { test: pre("/api/dashboard/loyalty-override"), tabs: ["loyalty"] },
    { test: pre("/api/dashboard/loyalty-overrides"), tabs: ["loyalty"] },
    { test: pre("/api/dashboard/reactivation"), tabs: ["loyalty"] },
    // Кандидати на реактивацію малює ЗАДАЧНИК (`TasksSection`) — тип задачі
    // «🔄 Реактивація клієнтів». Не «loyalty», хоч назва й натякає: мапінг за
    // ФРОНТОМ, а не за співзвучністю (саме тут я помилився з першого разу).
    // Рядок вище `reactivation` його НЕ накриває — там дефіс, не слеш.
    { test: pre("/api/dashboard/reactivation-candidates"), tabs: ["tasks"] },
    { test: pre("/api/dashboard/receivables"), tabs: ["receivables"] },
    { test: pre("/api/dashboard/sync-receivables"), tabs: ["receivables"] },
    { test: pre("/api/dashboard/leadgen"), tabs: ["leadgen"] },
    { test: pre("/api/dashboard/stuck-deals"), tabs: ["dataquality"] },
    { test: pre("/api/dashboard/data-quality"), tabs: ["dataquality"] },
    { test: pre("/api/dashboard/overview"), tabs: ["overview"] },
    { test: pre("/api/dashboard/sync"), tabs: ["overview"] },
    { test: pre("/api/dashboard/funnel"), tabs: ["overview"] },
    { test: pre("/api/dashboard/conversion"), tabs: ["overview"] },
    { test: pre("/api/dashboard/timeseries"), tabs: ["overview"] },
    // 🔴 ДОДАНО 31.07.2026 — ПОВЕРНЕННЯ ДО МОДЕЛІ, не рефакторинг. Ці три жили без
    // tab-гейта, і їхньою ЄДИНОЮ межею був scope-кламп: `if (auth.role === "manager")
    // return 403`. Щойно HR отримав company-scope, кламп зник — і роль, у якої немає
    // ні «overview», ні «loyalty», ні «manager-report», побачила їх усі. Спіймав #11.
    { test: pre("/api/dashboard/lead-quality"), tabs: ["overview"] },
    { test: pre("/api/dashboard/regular-clients"), tabs: ["loyalty"] },
    { test: pre("/api/dashboard/manager-report"), tabs: ["manager-report"] },
    // ⚠️ РЕШТА /api/dashboard/* ЛИШАЄТЬСЯ БЕЗ TAB-ГЕЙТА — і це ВІДОМА ДІРА, а не задум.
    // Тут раніше стояло «scope все одно клампить». Це припущення НЕПРАВИЛЬНЕ для будь-якої
    // company-ролі: у неї клампа немає за визначенням. Кожен такий роут названий у
    // `ROUTE_BOUNDARY_EXEMPTIONS` (`gates.ts`) з причиною — мовчазних більше немає.
    // /api/statistics — series* → statistics; інше → depstats
    { test: pre("/api/statistics/series"), tabs: ["statistics"] },
    { test: pre("/api/statistics"), tabs: ["depstats"] },
    // виділені роутери
    { test: pre("/api/plans"), tabs: ["plans"] },
    { test: pre("/api/teams"), tabs: ["teams"] },
    { test: pre("/api/tasks"), tabs: ["tasks"] },
    { test: pre("/api/goals"), tabs: ["goals"] },
    { test: pre("/api/settings"), tabs: ["settings"] },
    { test: pre("/api/messages"), tabs: ["messenger"] },
    { test: pre("/api/news"), tabs: ["news"] },
    { test: pre("/api/feedback"), tabs: ["feedback"] },
    { test: pre("/api/ai-work"), tabs: ["aiwork"] },
    { test: pre("/api/reports"), tabs: ["reports"] },
    { test: pre("/api/rates"), tabs: ["rates"] },
    { test: pre("/api/documents"), tabs: ["documents"] },
    { test: pre("/api/one-on-ones"), tabs: ["oneonone"] },
    { test: pre("/api/duty"), tabs: ["duty"] },
    { test: pre("/api/training"), tabs: ["training"] },
    { test: pre("/api/bank"), tabs: ["bank"] },
  ];
})();

/**
 * Вкладки, БУДЬ-ЯКА з яких відкриває цей шлях. `null` — шлях поза мапою.
 *
 * ⚠️ Порядок у `ROUTE_TAB` значущий: перший збіг виграє, тож специфічні префікси
 * (`kvp-report/manager-detail`, `reactivation-candidates`) стоять ПЕРЕД загальними.
 * Це тримає окремий тест — інакше «додав рядок у кінець» тихо нічого не робило б.
 */
export function tabsForPath(originalUrl: string): string[] | null {
  const path = originalUrl.split("?")[0];
  for (const r of ROUTE_TAB) if (r.test(path)) return r.tabs;
  return null;
}

/**
 * Чи має шлях межу-вкладку взагалі. Для АРХІТЕКТУРНИХ воріт (#17), а не для доступу.
 *
 * Свідомо окрема функція, а не `tabsForPath(...)?.[0]`: «перша вкладка зі списку» —
 * саме та зручність, якою легко авторизувати повз решту списку. Хто перевіряє доступ,
 * мусить узяти ВЕСЬ список.
 */
export function hasTabBoundary(originalUrl: string): boolean {
  return tabsForPath(originalUrl) !== null;
}
