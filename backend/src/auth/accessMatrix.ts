/**
 * 🔒 ЗЛІПОК ДОСТУПУ — знято ЕМПІРИЧНО з прода 31.07.2026 (450 пар роль×ендпоінт).
 *
 * Це НЕ побажання, а фотографія «як є» ПЕРЕД рефакторингом хардкоду ролей. Її
 * призначення — зловити будь-яку зміну поведінки під час заміни `role === "admin"`
 * на `roleHasPerm`. Рефакторинг не має права змінити жодну клітинку; змінив —
 * це вже не рефакторинг, а зміна політики, і робиться вона окремо й свідомо.
 *
 * 🟢 ПЕРЕЗНЯТО 31.07.2026 — ЗМІНА ПОЛІТИКИ, НЕ РЕГРЕСІЯ.
 * Рішення власника: ФІНАНСИСТ ПРАЦЮЄ НА РІВНІ АДМІНА. Попередній дефолт «немає
 * вкладки → закрити ендпоінт» скасовано: 15 продажних ендпоінтів не закривали, а
 * роль вирівняли до адмінської (правами й екранами в `roles`, не хардкодом у роутах).
 *
 * Зрушило РІВНО 50 рядків, і в кожному зміна одна й та сама: `+financier`. Жодна
 * інша роль не додана, жодна не знята — перевірено перезніманням усіх пар тим самим
 * пробником проти сервера з новим кодом.
 *
 * ДВА ВИНЯТКИ лишились і перевірені окремо (обидва financier=403):
 *   • GET  /settings/users              — керування користувачами;
 *   • POST /settings/users/:id/reset-password — скидання паролів.
 *
 * ⚠️ У 14 рядках класу `deny-only` financier ЗНИК З ОБОХ списків, а не переїхав у
 * `allow`. Причина не косметична: ці рядки реально ЗАПИСУЮТЬ, і тест пробує лише
 * ролі зі списку `deny`. Лишити фінансиста там, де він тепер проходить гейт, означало
 * б, що наступний прогін #11 виконає справжній POST проти прода. Спіймав це #11b —
 * інваріант «у deny-only рядку не буває дозволених ролей» саме для цього й існує.
 *
 * ⚠️ ЯКЩО ЧИТАЄШ ЦЕ ЧЕРЕЗ ПІВРОКУ: широкі права фінансиста — НЕ баг і не наслідок
 * недогляду в рефакторингу. Це узгоджене рішення. Не «виправляй» назад.
 *
 * ⚠️ Чому емпірично, а не з розбору коду: статичний маппер «гейт → ендпоінт»
 * помилився на /dashboard/data-quality (приписав гейт не тому роуту). Зліпок із
 * живого API такої помилки не має за побудовою.
 *
 * КЛАСИ ПРОБИ — визначають, що тест має право робити на живому API:
 *  • GET          читання, пробуємо всі ролі;
 *  • DELETE-ghost DELETE з НЕІСНУЮЧОЮ ціллю: збігів немає, отже й запису немає;
 *  • deny-only    POST/PUT, що апсертять або запускають дію (напр. POST /dashboard/sync
 *                 стартує синк). Пробуємо ЛИШЕ ролі, яким гейт відмовляє; дозволені
 *                 не чіпаємо — вони б записали. Для них гарантія інша: гейт стоїть
 *                 ПЕРШИМ значущим оператором (перевірено читанням усіх обробників).
 *
 * Доведено знімком 70 таблиць до і після проби: жодного рядка, жодного штампа часу.
 *
 * `allow` = «сервер НЕ віддав 403». Код 400 (бракує параметрів) — теж пройдений гейт:
 * питання матриці — доступ, а не валідність запиту.
 */
export interface AccessRow {
  method: string;
  path: string;
  cls: "GET" | "DELETE-ghost" | "deny-only";
  /** Ролі, яким сервер віддав НЕ 403. */
  allow: string[];
  /** Ролі, яким сервер віддав 403. */
  deny: string[];
}

export const ACCESS_ROLES = ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"] as const;

export const ACCESS_MATRIX: AccessRow[] = [
  { method: "DELETE", path: "/dashboard/loyalty-override/:clientKey", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/dashboard/reactivation/:clientKey", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/duty/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "DELETE", path: "/duty/holidays/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/news/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "DELETE", path: "/reports/:id", cls: "DELETE-ghost",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/dashboard/conversion", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/conversion-timeseries", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/daily", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/data-quality", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/expected-deals", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/funnel", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/funnel-plan", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/funnel-report", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/funnel-weekly", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/kvp-extra", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/dashboard/kvp-report/manager-detail", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/lead-quality", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/lead-recommendation", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/leadgen", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/loyalty", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/loyalty-overrides", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/dashboard/manager-report", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/managers", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/overview", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/personal", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/plans-grid", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/reactivation", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/reactivation-candidates", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/receivables", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/receivables/invoices", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/regular-clients", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/repeat-plans-grid", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/report", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/dashboard/report-plan", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/report-plan/deals", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/response-time", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/stuck-deals", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/dashboard/stuck-deals-grouped", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/dashboard/timeseries", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/duty/", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/duty/presence", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/feedback/", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/goals/", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/plans/", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/plans/formation/repeat-clients", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/rates/stats", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"], deny: ["hr", "team_lead", "manager"] },
  { method: "GET", path: "/statistics/", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"], deny: ["hr"] },
  { method: "GET", path: "/tasks/", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "GET", path: "/teams/managers", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead"], deny: ["hr", "manager"] },
  { method: "GET", path: "/training/tree", cls: "GET",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"], deny: [] },
  { method: "POST", path: "/dashboard/funnel-plan", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/dashboard/loyalty-override", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/dashboard/reactivation", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "PUT", path: "/dashboard/receivables/note", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/dashboard/repeat-client-plan/approve", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/dashboard/repeat-client-plan/approve-all", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/dashboard/sync", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/dashboard/sync-receivables", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/duty/", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/duty/holidays", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/news/", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "PUT", path: "/news/km-prices", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "PUT", path: "/settings/", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
  { method: "POST", path: "/tasks/reactivation", cls: "deny-only",
    allow: [], deny: ["hr", "manager"] },
];
