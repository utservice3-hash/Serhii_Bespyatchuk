/**
 * 🤝 Стик пакета Сергія «Реєстри та узгодження + Ліміти клієнтів» (23–24.10.2026) з дашбордом. Логіка — код пакета
 * (`counterparty/server`, `counterparty/shared`) без змін; тут лише те, що ТЗ §1–§3 просить підставити «вашим»:
 *  1. Вхід — наш `requireAuth`; межа — вкладка (`registries` для /api/counterparty, `receivables` для /api/client-limits).
 *  2. `req.user = { id, name, role }` — з нашої сесії: роль — `cpRoleOf` (одне місце), імʼя — `NAME_SQL`, команда тім-ліда —
 *     `managers.team_id` (`teamMemberUserIds`).
 *  3. YouScore — наш ключ `YOUCONTROL_API_KEY` (той самий, що в конструкторі); у пакеті він звався `YOUSCORE_API_KEY`.
 *  4. Файли й PDF-досьє — `documents/counterparty` (тека під нічним бекапом, як інші документи дашборда).
 *  5. Борг і прострочка — наша дебіторка (`debtSourceDb.ts`).
 * Async-мідлвари `.use` наш патч `lib/asyncRoutes.ts` не обгортає — тому помилки тут явно йдуть у `next(err)`.
 */
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasTab } from "../auth/rbac.js";
import { NAME_SQL } from "../surveys/surveyRules.js";
import { UPLOAD_DIR } from "../routes/uploads.js";
import { approverIds, ACCOUNTING_ROLE_KEY } from "../minusRegistry/roles.js";
import { teamMemberUserIds } from "../minusRegistry/team.js";
import { counterpartyRouter } from "./server/routes/counterparty.js";
import { clientLimitsRouter } from "./server/routes/clientLimits.js";
import { checkRunner } from "./server/cpChecks.js";
import { dirFileStore } from "./server/fileStore.js";
import { cachedDebtSource } from "./server/debtSource.js";
import { YouScore } from "./server/youscore/client.js";
import { receivablesDebtSource } from "./debtSourceDb.js";
import { mirrorToReceivables } from "./legacyLimits.js";
import type { CpRole } from "./shared/counterparty.js";

export const REGISTRIES_TAB = "registries";
export const RECEIVABLES_TAB = "receivables";

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

export const CP_FILES_DIR = process.env.CP_FILES_DIR || path.join(UPLOAD_DIR, "..", "documents", "counterparty");

/** Одне на процес: перевірки йдуть фоном, ручні й планові ділять той самий runner (ТЗ §2). */
export const youscore = youScoreFromOurEnv();
export const files = dirFileStore(CP_FILES_DIR);
export const debts = cachedDebtSource(receivablesDebtSource(pool));
export const runner = checkRunner({ pool, youscore, files });

/** Наш вхід + межа вкладки + `req.user` пакета. */
function gate(tab: string): Router {
  const r = Router();
  r.use(requireAuth);
  r.use((req, res, next) => {
    if (!req.auth || !roleHasTab(req.auth.roleKey, tab)) return res.status(403).json({ error: "Розділ недоступний для вашої ролі." });
    next();
  });
  r.use((req: Request, res: Response, next: NextFunction) => {
    const a = req.auth!;
    const role = cpRoleOf({ userId: a.userId, roleKey: a.roleKey }, cpApproverIds());
    if (!role) { res.status(403).json({ error: "Немає доступу." }); return; }
    pool.query<{ name: string | null }>(`${NAME_SQL} WHERE u.id = $1`, [a.userId])
      .then((q) => { (req as Request & { user?: unknown }).user = { id: String(a.userId), name: q.rows[0]?.name ?? "", role, teamId: a.teamId }; next(); })
      .catch(next);
  });
  return r;
}
/**
 * Після кожної успішної дії, що щось змінює (погодження, зміна ліміту, «лишити» тощо), — дзеркало «Лімітів клієнтів» у
 * колонки «Активної дебіторки» (`legacyLimits.ts`). Відповідь людині не чекає; збій — у лог, наступна дія чи джоба
 * `clientLimitsMirror` (раз на 10 хв) підтягнуть.
 */
function mirrorAfterWrites(): Router {
  const r = Router();
  r.use((req, res, next) => {
    if (req.method !== "GET") res.on("finish", () => {
      if (res.statusCode < 400) void mirrorToReceivables(pool, debts).catch((e) => console.error("[client-limits] дзеркало в дебіторку:", (e as Error).message));
    });
    next();
  });
  return r;
}
const roleOf = (u: { role?: string }) => (u.role as CpRole | undefined) ?? null;
const teamOf = (u: { id: string }) => teamMemberUserIds((u as { teamId?: number | null }).teamId, Number(u.id));

export function buildCounterpartyRouter(): Router {
  const r = gate(REGISTRIES_TAB);
  r.use(mirrorAfterWrites());
  r.use(counterpartyRouter(pool, { youscore, files, runner, roleOf, teamOf, debts }));
  return r;
}
export function buildClientLimitsRouter(): Router {
  const r = gate(RECEIVABLES_TAB);
  r.use(mirrorAfterWrites());
  r.use(clientLimitsRouter(pool, { debts, roleOf, teamOf }));
  return r;
}
