/**
 * 🔒 РОУТ → ВКЛАДКА. Винесено з `rbac.ts` 01.08.2026 БЕЗ зміни вмісту.
 *
 * Причина суто механічна: `rbac.ts` тягне `db/pool.js` → `config.js`, який кидає без
 * `DATABASE_URL` ще на імпорті. Через це архітектурні ворота (#17) не могли працювати
 * у звичайному `npm test` — а ворота, що виконуються лише в прод-режимі, це той самий
 * «скіп, який ніколи не виконувався», на якому ми вже горіли (#8).
 *
 * Тут НЕМАЄ жодного імпорту. Додаючи щось у цей файл — не додавай і надалі.
 */
// ── Роут → вкладка (для серверного tab-гейта). Найбільш специфічні префікси — першими.
// null (немає в мапі) → гейт пропускає (auth усе одно обов'язковий).
const ROUTE_TAB: { test: (p: string) => boolean; tab: string }[] = (() => {
  const pre = (prefix: string) => (p: string) => p === prefix || p.startsWith(prefix + "/");
  return [
    // /api/dashboard — суб-шляхи по вкладках (специфічні перед загальними)
    { test: pre("/api/dashboard/kvp"), tab: "kvp" },
    { test: pre("/api/dashboard/plans-grid"), tab: "plans" },
    { test: pre("/api/dashboard/repeat-plans-grid"), tab: "plans" },
    { test: pre("/api/dashboard/repeat-client-plan"), tab: "plans" },
    { test: pre("/api/dashboard/funnel-plan"), tab: "plans" },
    { test: pre("/api/dashboard/report"), tab: "report" },
    { test: pre("/api/dashboard/funnel-report"), tab: "report" },
    { test: pre("/api/dashboard/personal"), tab: "manager-report" },
    { test: pre("/api/dashboard/teams"), tab: "teams" },
    { test: pre("/api/dashboard/managers"), tab: "managers" },
    { test: pre("/api/dashboard/loyalty"), tab: "loyalty" },
    { test: pre("/api/dashboard/reactivation"), tab: "loyalty" },
    { test: pre("/api/dashboard/receivables"), tab: "receivables" },
    { test: pre("/api/dashboard/leadgen"), tab: "leadgen" },
    { test: pre("/api/dashboard/stuck-deals"), tab: "dataquality" },
    { test: pre("/api/dashboard/overview"), tab: "overview" },
    { test: pre("/api/dashboard/funnel"), tab: "overview" },
    { test: pre("/api/dashboard/conversion"), tab: "overview" },
    { test: pre("/api/dashboard/timeseries"), tab: "overview" },
    // 🔴 ДОДАНО 31.07.2026 — ПОВЕРНЕННЯ ДО МОДЕЛІ, не рефакторинг. Ці три жили без
    // tab-гейта, і їхньою ЄДИНОЮ межею був scope-кламп: `if (auth.role === "manager")
    // return 403`. Щойно HR отримав company-scope, кламп зник — і роль, у якої немає
    // ні «overview», ні «loyalty», ні «manager-report», побачила їх усі. Спіймав #11.
    { test: pre("/api/dashboard/lead-quality"), tab: "overview" },
    { test: pre("/api/dashboard/regular-clients"), tab: "loyalty" },
    { test: pre("/api/dashboard/manager-report"), tab: "manager-report" },
    // ⚠️ РЕШТА /api/dashboard/* ЛИШАЄТЬСЯ БЕЗ TAB-ГЕЙТА — і це ВІДОМА ДІРА, а не задум.
    // Тут раніше стояло «scope все одно клампить». Це припущення НЕПРАВИЛЬНЕ для будь-якої
    // company-ролі: у неї клампа немає за визначенням. Наступна роль зі scope=company
    // відкриє ці роути так само тихо. Повний перелік — `docs/SCOPE_ONLY_ROUTES.md`;
    // закриваємо їх окремою свідомою роботою (крок B), а не по одному після інциденту.
    // /api/statistics — series* → statistics; інше → depstats
    { test: pre("/api/statistics/series"), tab: "statistics" },
    { test: pre("/api/statistics"), tab: "depstats" },
    // виділені роутери
    { test: pre("/api/plans"), tab: "plans" },
    { test: pre("/api/teams"), tab: "teams" },
    { test: pre("/api/tasks"), tab: "tasks" },
    { test: pre("/api/goals"), tab: "goals" },
    { test: pre("/api/settings"), tab: "settings" },
    { test: pre("/api/messages"), tab: "messenger" },
    { test: pre("/api/news"), tab: "news" },
    { test: pre("/api/feedback"), tab: "feedback" },
    { test: pre("/api/ai-work"), tab: "aiwork" },
    { test: pre("/api/reports"), tab: "reports" },
    { test: pre("/api/rates"), tab: "rates" },
    { test: pre("/api/documents"), tab: "documents" },
    { test: pre("/api/one-on-ones"), tab: "oneonone" },
    { test: pre("/api/duty"), tab: "duty" },
    { test: pre("/api/training"), tab: "training" },
    { test: pre("/api/bank"), tab: "bank" },
  ];
})();

export function tabForPath(originalUrl: string): string | null {
  const path = originalUrl.split("?")[0];
  for (const r of ROUTE_TAB) if (r.test(path)) return r.tab;
  return null;
}

