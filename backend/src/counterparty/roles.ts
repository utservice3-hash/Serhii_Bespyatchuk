/**
 * Ролі пакета «Узгодження» і ключ YouScore — без пулу БД (`mount.ts` тягне `db/pool.js`, а той кидає без `DATABASE_URL` ще на
 * імпорті), щоб гейти `#2405`/`#2408` читали те саме правило, що й роутер.
 */
import { approverIds, ACCOUNTING_ROLE_KEY } from "../minusRegistry/roles.js";
import { YouScore } from "./server/youscore/client.js";
import type { CpRole } from "./shared/counterparty.js";

/** Ролі, що бачать усе без дій (ТЗ §3: admin, ceo, finance → viewer). Наші: адмін, СЕО, ОД, фінансист. */
const VIEWER_ROLES = new Set(["admin", "ceo", "opdir", "financier"]);

/**
 * Роль дашборда → роль пакета (ТЗ §3, рішення Сергія 21–23.10). Погоджує ЛИШЕ Сергій (`MINUS_APPROVER_IDS`/`CP_APPROVER_IDS`,
 * за замовчуванням users.id 1); бухгалтерія — усе без дій; менеджер / тім-лід — подають; керівники — перегляд;
 * КВП, HR, бізнес-асистент та інші співробітники — лише «Перевірка контрагента» (`staff`); кандидат — немає доступу.
 */
export function cpRoleOf(a: { userId: number; roleKey: string }, approvers: readonly string[]): CpRole | null {
  if (approvers.includes(String(a.userId))) return "approver";
  if (a.roleKey === ACCOUNTING_ROLE_KEY) return "accounting";
  if (a.roleKey === "manager") return "manager";
  if (a.roleKey === "team_lead") return "lead";
  if (VIEWER_ROLES.has(a.roleKey)) return "viewer";
  if (!a.roleKey || a.roleKey === "candidate") return null;
  return "staff";
}
export const cpApproverIds = () => approverIds(process.env.CP_APPROVER_IDS || process.env.MINUS_APPROVER_IDS);

/** YouScore на нашому ключі; немає ключа — null (перевірки відповідають 503 з поясненням, решта працює). */
export function youScoreFromOurEnv(env: NodeJS.ProcessEnv = process.env): YouScore | null {
  const key = (env.YOUCONTROL_API_KEY || env.YOUSCORE_API_KEY || "").trim();
  return key ? new YouScore({ apiKey: key }) : null;
}

