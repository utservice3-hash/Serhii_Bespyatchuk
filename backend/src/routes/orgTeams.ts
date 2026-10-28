import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { roleHasTab, roleHasPerm } from "../auth/rbac.js";
import type { Db } from "../core/secrets.js";
import { TeamsError, listTeams, createDashboardTeam, updateDashboardTeam, setEmployeeTeam, parseTeamRef } from "../core/teams.js";

/**
 * 👥 КОМАНДИ: KOMMO + ДАШБОРД (рішення Романа 27.10.2026). Правила — `core/teams.ts`.
 *
 * Межі:
 *  1. tab-гейт `pre("/api/org")` у `requireAuth` (шлях `/api/org/teams` — під ним) + та сама вкладка `org` першим
 *     middleware роутера: список команд бачать усі, хто бачить орг-структуру;
 *  2. запис — право `manage_teams` (керівництво й HR — рішення Романа 27.10, п.1) на КОЖНОМУ роуті запису.
 * Окремий роутер, а не `orgRouter`: межа запису тут інша (`manage_teams`, не `edit_org`).
 */
export const orgTeamsRouter = Router();
orgTeamsRouter.use(requireAuth);
orgTeamsRouter.use((req, res, next) => {
  if (!req.auth || !roleHasTab(req.auth.roleKey, "org")) return res.status(403).json({ error: "Команди недоступні для вашої ролі" });
  next();
});

const me = (req: Request) => req.auth!.userId;
const num = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw new TeamsError(400, `Некоректний ${what}`);
  return n;
};
function fail(res: Response, e: unknown) {
  if (e instanceof TeamsError) return res.status(e.status).json({ error: e.message });
  console.error("[org-teams]", (e as Error)?.message ?? e);
  return res.status(500).json({ error: "Не вдалося обробити запит — спробуйте ще раз" });
}
async function tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client as unknown as Db);
    await client.query("COMMIT");
    return out;
  } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { client.release(); }
}

orgTeamsRouter.get("/", async (req, res) => {
  try {
    const { kommo, dashboard } = await listTeams(pool as unknown as Db);
    // Поля поіменно, без спреду (#17e2).
    res.json({ kommo, dashboard, canManage: roleHasPerm(req.auth!.roleKey, "manage_teams") });
  } catch (e) { fail(res, e); }
});

orgTeamsRouter.post("/", requirePerm("manage_teams"), async (req, res) => {
  try { res.status(201).json({ id: await tx((db) => createDashboardTeam(db, me(req), req.body ?? {})) }); } catch (e) { fail(res, e); }
});

orgTeamsRouter.patch("/:id", requirePerm("manage_teams"), async (req, res) => {
  try { await tx((db) => updateDashboardTeam(db, me(req), num(req.params.id, "id команди"), req.body ?? {})); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
});

orgTeamsRouter.put("/people/:employeeId", requirePerm("manage_teams"), async (req, res) => {
  try {
    const ref = parseTeamRef(req.body?.team);
    const r = await tx((db) => setEmployeeTeam(db, me(req), num(req.params.employeeId, "id співробітника"), ref));
    res.json({ ok: true, name: r.name });
  } catch (e) { fail(res, e); }
});
