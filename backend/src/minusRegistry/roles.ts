/**
 * Ролі дашборда → ролі реєстру мінусових угод. Одне місце (`roleOf` пакета, ТЗ §3 п.4 і §13). Рішення Сергія 20.10, ТЗ §0:
 *   - погоджує ЛИШЕ акаунт Сергія (операційний директор, utservice3@gmail.com = `users.id 1`) — ролі «адмін» для цього мало;
 *   - бухгалтерія (роль «Бухгалтерія», ключ `____________` — див. `db/roleDeclarations.ts`) — бачить усе, ставить «Оплачено»;
 *   - «інші адміни» — бачать усе, без дій: ролі адмінського рівня (`admin_scope`: адмін, СЕО, ОД, КВП, фінансист);
 *   - менеджер і тім-лід — подають і бачать свої;
 *   - решта (HR, кандидат, бізнес-асистент…) — 403, пункт меню не показується (вкладку `registries` їм не видано).
 *
 * ⚠️ СВІДОМИЙ ВИНЯТОК З ПРАВИЛ ДОСТУПУ: бухгалтерія тут ПИШЕ («Оплачено»), хоча 05.09.2026 власник постановив
 * «бухгалтерія — тільки перегляд». Підстава — рішення Сергія 20.10 у ТЗ пакета (§1 п.4, §4) і слово Романа 20.10
 * «зроби все як сказано в файлі». Не «виправляти» назад без нового рішення.
 */
import type { Role } from "./shared/minusRegistry.js";

/** `users.id` тих, хто погоджує. За рішенням 20.10 — лише Сергій. `MINUS_APPROVER_IDS` у .env може замінити (через кому). */
export const DEFAULT_APPROVER_IDS = ["1"];
export function approverIds(env: string | undefined = process.env.MINUS_APPROVER_IDS): string[] {
  const list = (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_APPROVER_IDS;
}

/** Ключ ролі «Бухгалтерія» в дашборді (форма створення зводить кирилицю до `_`; так і задекларовано). */
export const ACCOUNTING_ROLE_KEY = "____________";

export interface AuthForRegistry { userId: number; roleKey: string; adminScope: boolean }

export function registryRoleOf(a: AuthForRegistry, approvers: readonly string[]): Role | null {
  if (approvers.includes(String(a.userId))) return "approver";
  if (a.roleKey === ACCOUNTING_ROLE_KEY) return "accounting";
  if (a.roleKey === "manager") return "manager";
  if (a.roleKey === "team_lead") return "lead";
  if (a.adminScope) return "viewer";
  return null;
}
