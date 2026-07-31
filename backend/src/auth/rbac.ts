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
/** Час останнього УСПІШНОГО завантаження кешу (для сигналізації). null = ще не було. */
let lastRefreshAt: number | null = null;

/** Скільки ролей у кеші. 0 = гейти закриті (fail-closed) — див. `roleHasTab`. */
export function rolesCacheSize(): number {
  return cache.size;
}

/** Стан кешу для банера тривог: порожній або задавнений — це поломка, що мовчить. */
export function rolesCacheState(): { size: number; ageMinutes: number | null } {
  return {
    size: cache.size,
    ageMinutes: lastRefreshAt == null ? null : Math.round((Date.now() - lastRefreshAt) / 60_000),
  };
}

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
  lastRefreshAt = Date.now();
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

// Роут → вкладки живе в окремому модулі без залежностей (див. routeTab.ts),
// щоб ворота доступу перевірялись без БД. Ре-експорт — щоб не ламати наявні імпорти.
export { tabsForPath, hasTabBoundary } from "./routeTab.js";

/**
 * Чи має ефективна роль доступ до вкладки. Невідома роль / відсутня вкладка → false.
 *
 * 🔴 FAIL-CLOSED (31.07.2026). Тут стояло `if (cache.size === 0) return true` — «щоб не
 * забрикувати сайт до першого refresh». Ціна такого зручності: при збої `refreshRoles`
 * на старті сервер приймав запити з порожнім кешем, і ВСІ tab- та perm-гейти
 * пропускали будь-яку роль — включно з `reset_passwords`, `manage_users`,
 * `view_balances`. Само не лікувалось: періодичного refresh не було.
 *
 * Тепер порожній кеш = ВІДМОВА. Це ДРУГИЙ рубіж: перший — сервер із порожнім кешем
 * узагалі не починає слухати (`loadRolesOrDie` в index.ts). Межа не має триматись на
 * одному запобіжнику — рівно те саме правило, що й у read-only харнесі.
 */
export function roleHasTab(roleKey: string, tab: string): boolean {
  if (cache.size === 0) return false;
  const def = cache.get(roleKey);
  return !!def && def.screenAccess[tab] === true;
}

/** Те саме fail-closed, що й `roleHasTab` — і з тієї ж причини. */
export function roleHasPerm(roleKey: string, perm: string): boolean {
  if (cache.size === 0) return false;
  const def = cache.get(roleKey);
  return !!def && def.permissions[perm] === true;
}

/**
 * СТРОГИЙ perm-чек: порожній кеш = НІ.
 *
 * 🔴 Чим відрізняється від `roleHasPerm` і навіщо. Той fail-open (`cache.size === 0
 * → true`), щоб до першого `refreshRoles` не забрикувати сайт tab-гейтом. Для
 * ГЕЙТІВ ДОСТУПУ таке саме fail-open означало б, що у вікні між стартом процесу і
 * завантаженням ролей адмінські дії відкриті ВСІМ. Тому окрема функція, а не прапорець.
 */
function roleHasPermStrict(roleKey: string, perm: string): boolean {
  return cache.get(roleKey)?.permissions[perm] === true;
}

/** Мінімум, який має нести `req.auth` для гейтів нижче. */
export interface AuthLike { role: string; roleKey: string }

/**
 * «Роль працює на рівні адміністратора» — заміна розсипаного `auth.role === "admin"`.
 *
 * 🔒 ЕКВІВАЛЕНТНІСТЬ, а не «приблизно те саме». Перший доданок — рівно старий вираз,
 * тож жодна роль не може ВТРАТИТИ доступ. Другий читає право `admin_scope` з БД —
 * саме те, за яким `scopeCompatRole` і піднімає роль до `"admin"`, тож для всіх
 * восьми відомих ролей обидва доданки дають однакову відповідь (доведено #5.14).
 * Невідома роль: `def` немає → строгий чек `false`, а перший доданок поводиться як
 * раніше. Тобто ширше не стало ніде.
 *
 * Навіщо взагалі: щоб «хто такий адмін» жило в ОДНОМУ місці й у БД, а не в 51 рядку
 * по роутах. Додати роль адмінського рівня = запис у `roles`, не правка коду.
 */
export function isAdminScope(auth: AuthLike): boolean {
  return auth.role === "admin" || roleHasPermStrict(auth.roleKey, ADMIN_SCOPE_PERM);
}

/**
 * «Наглядовий рівень»: адміністратор АБО тімлід. Заміна для
 * `auth.role !== "admin" && auth.role !== "team_lead"` та її дзеркал.
 *
 * `team_lead` лишається порівнянням по scope-ролі СВІДОМО: це не право, а рівень
 * даних (своя команда). Виносити його в permission означало б вигадати бізнес-правило,
 * якого в моделі немає.
 */
export function isAdminOrLead(auth: AuthLike): boolean {
  return isAdminScope(auth) || auth.role === "team_lead";
}
