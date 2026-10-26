/**
 * Які вкладки «Реєстрів та узгодження» показати ролі — дзеркало серверних ролей (ТЗ §3, рішення Сергія 21–23.10):
 *   «Реєстр мінусових угод» — `registryRoleOf` (backend/src/minusRegistry/roles.ts): менеджер, тім-лід, бухгалтерія, адмінський рівень;
 *   «Узгодження…» — `cpRoleOf` ≠ staff (backend/src/counterparty/mount.ts): менеджер, тім-лід, бухгалтерія, адмін/СЕО/ОД/фінансист;
 *   «Перевірка контрагента» — усім, кому видано вкладку `registries` (КВП, HR, бізнес-асистент та інші — лише вона).
 * Це косметика: сервер гейтить сам (чужа вкладка дала б 403). Розходження з сервером ловить гейт `#2408`.
 */
import type { RegTab } from './registriesMount';

export const ACCOUNTING_ROLE_KEY = '____________';
const ADMIN_SCOPE = ['admin', 'ceo', 'opdir', 'kvp', 'financier'];
const CP_VIEWERS = ['admin', 'ceo', 'opdir', 'financier'];
const SUBMITTERS = ['manager', 'team_lead', ACCOUNTING_ROLE_KEY];

export function regTabsFor(roleKey: string | null | undefined): RegTab[] {
  const k = roleKey ?? '';
  const tabs: RegTab[] = [];
  if (SUBMITTERS.includes(k) || ADMIN_SCOPE.includes(k)) tabs.push('minus');
  if (SUBMITTERS.includes(k) || CP_VIEWERS.includes(k)) tabs.push('new');
  tabs.push('check');
  return tabs;
}
