import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { roleHasTab, roleHasPerm } from "../auth/rbac.js";
import type { Db } from "../core/secrets.js";
import { ImportError } from "../core/employeeImport.js";
import { uploadPhoto, PeopleError } from "../core/people.js";
import {
  OrgError, ORG_DEPTS, loadOrg, myEmployeeId, orgLog, setMyTelegram, moveEmployee, createUnit, updateUnit, deleteUnit, logMyPhoto,
} from "../core/orgTree.js";

/**
 * 🏢 ОРГ-СТРУКТУРА (задача 7062). Правила — `core/orgTree.ts`.
 *
 * Межі:
 *  1. tab-гейт `pre("/api/org")` у `requireAuth` + та сама вкладка `org` першим middleware роутера (друга лінія,
 *     як у опитувань): бачать усі ролі, включно з кандидатом (рішення Романа 27.10.2026);
 *  2. запис у схему — право `edit_org` (admin, HR, бізнес-асистент — ТЗ) на кожному роуті редагування;
 *  3. «моє» (нік, фото) — лише СВІЙ рядок реєстру: id береться з акаунта, а не з запиту (#2703).
 */
export const orgRouter = Router();
orgRouter.use(requireAuth);
orgRouter.use((req, res, next) => {
  if (!req.auth || !roleHasTab(req.auth.roleKey, "org")) return res.status(403).json({ error: "Орг структура недоступна для вашої ролі" });
  next();
});

const me = (req: Request) => req.auth!.userId;
const num = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw new OrgError(400, `Некоректний ${what}`);
  return n;
};
const b64 = (v: unknown) => (typeof v === "string" && v ? Buffer.from(v.includes(",") ? v.split(",")[1] : v, "base64") : null);

function fail(res: Response, e: unknown) {
  if (e instanceof OrgError || e instanceof ImportError || e instanceof PeopleError) return res.status(e.status).json({ error: e.message });
  console.error("[org]", (e as Error)?.message ?? e);
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

orgRouter.get("/tree", async (req, res) => {
  try {
    const db = pool as unknown as Db;
    const canEdit = roleHasPerm(req.auth!.roleKey, "edit_org");
    const [tree, meId] = await Promise.all([loadOrg(db, me(req)), myEmployeeId(db, me(req))]);
    const teams = canEdit ? (await db.query<{ id: number; name: string }>(`SELECT id, name FROM teams ORDER BY name`)).rows : [];
    // Поля поіменно, без спреду (#17e2): що саме йде у відповідь, видно тут, а не лише в ядрі.
    res.json({ units: tree.units, people: tree.people, unassigned: tree.unassigned, unknownLabels: tree.unknownLabels, stats: tree.stats,
      depts: ORG_DEPTS, canEdit, meEmployeeId: meId, teams });
  } catch (e) { fail(res, e); }
});

orgRouter.put("/me/telegram", async (req, res) => {
  try { res.json({ telegram: await tx((db) => setMyTelegram(db, me(req), req.body?.telegram)) }); } catch (e) { fail(res, e); }
});

orgRouter.post("/me/photo", async (req, res) => {
  try {
    const db = pool as unknown as Db;
    const id = await myEmployeeId(db, me(req));
    if (id == null) throw new OrgError(404, "Вашого акаунта немає серед працюючих у «Найм → Співробітники» — зверніться до HR");
    const out = await uploadPhoto(id, b64(req.body?.dataBase64), me(req));
    await logMyPhoto(db, me(req), id);
    res.status(201).json(out);
  } catch (e) { fail(res, e); }
});

orgRouter.get("/log", requirePerm("edit_org"), async (_req, res) => {
  try { res.json({ rows: await orgLog(pool as unknown as Db) }); } catch (e) { fail(res, e); }
});

orgRouter.post("/units", requirePerm("edit_org"), async (req, res) => {
  try { res.status(201).json({ id: await tx((db) => createUnit(db, me(req), req.body ?? {})) }); } catch (e) { fail(res, e); }
});

orgRouter.patch("/units/:id", requirePerm("edit_org"), async (req, res) => {
  try { await tx((db) => updateUnit(db, me(req), num(req.params.id, "id блоку"), req.body ?? {})); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

orgRouter.delete("/units/:id", requirePerm("edit_org"), async (req, res) => {
  try { await tx((db) => deleteUnit(db, me(req), num(req.params.id, "id блоку"))); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

orgRouter.put("/people/:employeeId/unit", requirePerm("edit_org"), async (req, res) => {
  try {
    const unitId = req.body?.unitId == null ? null : num(req.body.unitId, "id блоку");
    await tx((db) => moveEmployee(db, me(req), num(req.params.employeeId, "id співробітника"), unitId));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
