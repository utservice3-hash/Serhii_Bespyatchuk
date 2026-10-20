import { Router, type NextFunction, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { isAdminScope, roleHasTab } from "../auth/rbac.js";
import { NAME_SQL } from "../surveys/surveyRules.js";
import { minusRegistryRouter } from "./router.js";
import type { DealSource } from "./kommoSource.js";
import { approverIds, registryRoleOf } from "./roles.js";
import type { Role } from "./shared/minusRegistry.js";

/**
 * Стик реєстру з дашбордом (фабрика) — винесено з `routes/`, бо там реєстрація роутів мусить бути на верхньому рівні (#896).
 * Викликається ОДИН раз на імпорті `routes/minusRegistry.ts`, тож Express знає всі роути одразу. Гейт `#1843` будує ту саму
 * фабрику з фейковою Kommo. Що тут і чому — див. `routes/minusRegistry.ts`.
 */
/** Вкладка-межа реєстрів (пункт меню «Реєстри»). */
export const REGISTRIES_TAB = "registries";

/** Фабрика — щоб гейт міг підставити фейкову Kommo (`deals`); у проді — наш клієнт (`minusDealsRouter` нижче). */
export function buildMinusDealsRouter(deals: DealSource): Router {
  const r = Router();
  r.use(requireAuth);
  r.use((req, res, next) => {
    if (!req.auth || !roleHasTab(req.auth.roleKey, REGISTRIES_TAB)) return res.status(403).json({ error: "Реєстри недоступні для вашої ролі." });
    next();
  });
  r.use((req: Request, res: Response, next: NextFunction) => {
    const a = req.auth!;
    const role = registryRoleOf({ userId: a.userId, roleKey: a.roleKey, adminScope: isAdminScope(a) }, approverIds());
    if (!role) { res.status(403).json({ error: "Немає доступу до реєстру." }); return; }
    pool.query<{ name: string | null }>(`${NAME_SQL} WHERE u.id = $1`, [a.userId])
      .then((q) => { (req as Request & { user?: unknown }).user = { id: String(a.userId), name: q.rows[0]?.name ?? "", role }; next(); })
      .catch(next);
  });
  r.use(minusRegistryRouter(pool, { deals, roleOf: (u) => (u.role as Role | undefined) ?? null }));
  return r;
}

