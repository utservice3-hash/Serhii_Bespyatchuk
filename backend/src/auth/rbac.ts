// RBAC ядро (Phase 1). Ефективна роль = role_override ?? users.role. Визначення ролі
// (data_scope / screen_access / permissions) живе в таблиці `roles`; тут — in-memory кеш
// (оновлюється при старті й після кожного запису ролі) + чисті резолвери для гейтів.
import { pool } from "../db/pool.js";

export type DataScope = "own" | "team" | "company";
export interface RoleDef {
  key: string;
  name: string;
  builtIn: boolean;
  dataScope: DataScope;
  screenAccess: Record<string, boolean>;
  permissions: Record<string, boolean>;
}

let cache = new Map<string, RoleDef>();

export async function refreshRoles(): Promise<void> {
  const rows = await pool.query<{
    key: string; name: string; built_in: boolean; data_scope: DataScope;
    screen_access: Record<string, boolean>; permissions: Record<string, boolean>;
  }>(`SELECT key, name, built_in, data_scope, screen_access, permissions FROM roles`);
  const next = new Map<string, RoleDef>();
  for (const r of rows.rows) {
    next.set(r.key, {
      key: r.key, name: r.name, builtIn: r.built_in, dataScope: r.data_scope,
      screenAccess: r.screen_access ?? {}, permissions: r.permissions ?? {},
    });
  }
  cache = next;
}

export function getRoleDef(key: string): RoleDef | undefined {
  return cache.get(key);
}

/** Ефективний ключ ролі: override переважає синкнуту роль. */
export function effectiveRoleKey(user: { role: string; role_override: string | null }): string {
  return user.role_override ?? user.role;
}

// Scope-compat: значення, яке кладемо у токен як auth.role, щоб НАЯВНА per-route логіка
// (if role==='manager' own / else if 'team_lead' team / else company) давала правильний
// зріз. Вбудовані admin/team_lead/manager — тотожність (нуль змін поведінки). Для kvp/
// кастомних беремо з data_scope; company → 'company' (не 'admin'!) — щоб НЕ надати
// admin-only дій; конкретні дозволені дії відкриваються perm-гейтом на write-роутах.
export type ScopeRole = "admin" | "team_lead" | "manager" | "company";
/** Право-маркер «ця роль працює на рівні адміна». Живе в БД, не в коді. */
export const ADMIN_SCOPE_PERM = "admin_scope";
export function scopeCompatRole(key: string, def: RoleDef | undefined): ScopeRole {
  // Вбудований admin — підлога: навіть на криво засіяній базі він лишається адміном.
  if (key === "admin") return "admin";
  // 🔄 31.07.2026: було жорстко зашито `key === "ceo" || "opdir" || "kvp"`. Тепер це
  // ПРАВО в БД (`admin_scope`) — рівно тому, що ми прибираємо хардкод ролей: додати
  // роль адмінського рівня має бути записом у `roles`, а не правкою цього файла.
  // НЕ blanket company→admin: hr теж company-scope, але права не має і адміном не стає.
  // Наскрізний 1×1 цим НЕ розширюється — він гейтиться окремим правом `view_all_1x1`,
  // тож саме право, а не рівень ролі, вирішує доступ до 1×1.
  if (def?.permissions?.[ADMIN_SCOPE_PERM] === true) return "admin";
  if (key === "team_lead") return "team_lead";
  if (key === "manager") return "manager";
  const scope = def?.dataScope ?? "own";
  return scope === "own" ? "manager" : scope === "team" ? "team_lead" : "company";
}

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
    // решта /api/dashboard/* — оглядові дані; лишаємо без tab-гейта (scope все одно клампить).
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

/** Чи має ефективна роль доступ до вкладки. Невідома роль / відсутня вкладка → false.
 *  Кеш ще не завантажено (size===0, до-старт/до-міграція) → fail-open, щоб не забрикувати
 *  сайт; після завантаження (вбудовані ролі завжди є) — строге застосування. */
export function roleHasTab(roleKey: string, tab: string): boolean {
  if (cache.size === 0) return true;
  const def = cache.get(roleKey);
  return !!def && def.screenAccess[tab] === true;
}

export function roleHasPerm(roleKey: string, perm: string): boolean {
  if (cache.size === 0) return true;
  const def = cache.get(roleKey);
  return !!def && def.permissions[perm] === true;
}
