import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

/**
 * Графік чергування. Тімлід (РНК) призначає менеджерів своєї команди на дні,
 * адмін — будь-яку команду. Менеджер бачить графік своєї команди (свої дні
 * підсвічені) у режимі читання. Мотивація: заявки, що надходять увечері/у
 * вихідні, чекають відповідального довше (див. «сер. час опрацювання заявки») —
 * черговий закриває це вікно.
 * shift: 'day' (весь день) | 'evening' (18–21) | 'weekend' (вихідний).
 */
export const dutyRouter = Router();
dutyRouter.use(requireAuth);

const pad = (n: number) => String(n).padStart(2, "0");
const defFrom = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
};
const defTo = () => {
  const d = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const SHIFTS = new Set(["day", "evening", "weekend"]);

// У чергуванні беруть участь ЛИШЕ команди РНК (робота з наявними клієнтами),
// включно з їхніми тімлідами. Менеджерів РПК/інших до графіка не пропонуємо.
const RNK_TEAM = "t.name ILIKE '%РНК%'";

/** Менеджери, доступні для призначення тому, хто дивиться (лід → своя команда). */
async function assignableManagers(auth: { role: string; teamId: number | null }, teamId: number | null) {
  let scope = teamId;
  if (auth.role === "team_lead") scope = auth.teamId;
  const params: unknown[] = [];
  // Тімлід — лише РНК (своя команда). Адмін — БУДЬ-ЯКА команда (РНК і РПК) → без RNK-фільтра.
  let where = "m.is_active";
  if (auth.role === "team_lead") where += ` AND ${RNK_TEAM}`;
  if (scope) { params.push(scope); where += ` AND m.team_id = $${params.length}`; }
  const r = await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name
       FROM managers m LEFT JOIN teams t ON t.id = m.team_id
      WHERE ${where}
      ORDER BY t.name NULLS LAST, m.name`,
    params
  );
  return r.rows;
}

/**
 * Графік за період. Скоуп: manager → лише СВОЯ команда (щоб бачив, хто чергує);
 * team_lead → своя команда; admin → усі або обрана команда (?teamId).
 * Повертає assignments + (для лід/адмін) список менеджерів для призначення.
 */
dutyRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  const from = (req.query.from as string) || defFrom();
  const to = (req.query.to as string) || defTo();
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager" || auth.role === "team_lead") teamId = auth.teamId;

  // 🔴 ЧЕРГУВАННЯ — окремий скоуп ПЕРЕГЛЯДУ (права на запис НЕ чіпаємо): тімлід бачить
  // чергування ВСІХ команд (координація графіка), не лише своєї. Менеджер — своя команда;
  // адмін — усі або обрана ?teamId. ВІДСУТНОСТІ лишаються team-scoped (нижче, self-scope
  // за роллю). Це лише READ; POST/DELETE гейти незмінні (тімлід РНК-only своєї команди).
  const dutyTeamId = auth.role === "manager" ? auth.teamId
    : auth.role === "team_lead" ? null
    : (req.query.teamId ? Number(req.query.teamId) : null); // admin (або кастомна company-роль)

  const params: unknown[] = [from, to];
  const conds = ["ds.duty_date BETWEEN $1 AND $2"];
  if (dutyTeamId) { params.push(dutyTeamId); conds.push(`ds.team_id = $${params.length}`); }

  const r = await pool.query<{
    id: number; duty_date: string; manager_id: number; manager_name: string;
    team_id: number | null; team_name: string | null; shift: string; note: string | null;
  }>(
    `SELECT ds.id, to_char(ds.duty_date, 'YYYY-MM-DD') AS duty_date, ds.manager_id,
            m.name AS manager_name, ds.team_id, t.name AS team_name, ds.shift, ds.note
       FROM duty_schedule ds
       JOIN managers m ON m.id = ds.manager_id
       LEFT JOIN teams t ON t.id = ds.team_id
      WHERE ${conds.join(" AND ")}
      ORDER BY ds.duty_date, ds.shift, m.name`,
    params
  );
  const assignments = r.rows.map((x) => ({
    id: x.id, date: x.duty_date, managerId: x.manager_id, managerName: x.manager_name,
    teamId: x.team_id, teamName: x.team_name, shift: x.shift, note: x.note,
    mine: x.manager_id === auth.managerId,
  }));

  const canEdit = auth.role === "admin" || auth.role === "team_lead";
  const managers = canEdit ? await assignableManagers(auth, teamId) : [];

  // ── ВІДСУТНОСТІ (окремий шар; чергування вище лишається як є) ──
  // Роль-скоуп СЕРВЕРНО (не FE-приховування): admin — усе (або ?teamId); team_lead — своя
  // команда; manager — ЛИШЕ свої (сервер не віддає чужі дні). Діапазон перетинає [from,to].
  const absMgrs = calendarManagerScope(auth, teamId); // повертає перелік менеджерів для FE-фільтра
  const absences = await queryAbsences(auth, teamId, from, to);
  // Держсвята — глобальні (усі бачать), у діапазоні.
  const holidays = (await pool.query<{ id: number; d: string; name: string }>(
    `SELECT id, to_char(holiday_date,'YYYY-MM-DD') AS d, name FROM company_holidays
      WHERE holiday_date BETWEEN $1 AND $2 ORDER BY holiday_date`, [from, to])).rows
    .map((h) => ({ id: h.id, date: h.d, name: h.name }));
  // Бейдж «⏳ N на погодженні» — рахуємо ЛИШЕ те, що ЦЕЙ глядач може погодити.
  const pendingCount = await countApprovablePending(auth, from, to);

  res.json({ from, to, assignments, absences, holidays, managers, absenceManagers: await absMgrs, canEdit, pendingCount });
});

/** Призначити менеджера на день (лід — лише своя команда). */
dutyRouter.post("/", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const date = String(req.body?.date ?? "").slice(0, 10);
  const managerId = Number(req.body?.managerId);
  const shift = SHIFTS.has(String(req.body?.shift)) ? String(req.body.shift) : "day";
  const note = req.body?.note != null ? String(req.body.note).slice(0, 500) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !managerId) {
    return res.status(400).json({ error: "date (YYYY-MM-DD) та managerId обовʼязкові" });
  }
  // Команда менеджера + гейт для тімліда (лише своя команда) + лише РНК-команди.
  const mgr = await pool.query<{ team_id: number | null; is_rnk: boolean }>(
    `SELECT m.team_id, (t.name ILIKE '%РНК%') AS is_rnk
       FROM managers m LEFT JOIN teams t ON t.id = m.team_id
      WHERE m.id = $1 AND m.is_active`, [managerId]);
  if (!mgr.rowCount) return res.status(404).json({ error: "Менеджера не знайдено" });
  const teamId = mgr.rows[0].team_id;
  // Тімлід — лише своя РНК-команда (як було). Адмін — будь-яка команда (РНК і РПК): RNK-гейт
  // до адміна НЕ застосовуємо (рішення власника — адмін може призначити чергового і в РПК).
  if (auth.role === "team_lead") {
    if (!mgr.rows[0].is_rnk) return res.status(400).json({ error: "У чергуванні беруть участь лише команди РНК" });
    if (teamId !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  const r = await pool.query<{ id: number }>(
    `INSERT INTO duty_schedule (duty_date, manager_id, team_id, shift, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (duty_date, manager_id, shift) DO UPDATE SET note = EXCLUDED.note
     RETURNING id`,
    [date, managerId, teamId, shift, note, auth.userId]
  );
  res.json({ ok: true, id: r.rows[0].id });
});

/** Зняти призначення (лід — лише своя команда). */
dutyRouter.delete("/:id", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const id = Number(req.params.id);
  const row = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM duty_schedule WHERE id = $1`, [id]);
  if (!row.rowCount) return res.json({ ok: true }); // already gone
  if (auth.role === "team_lead" && row.rows[0].team_id !== auth.teamId) {
    return res.status(403).json({ error: "Лише своя команда" });
  }
  await pool.query(`DELETE FROM duty_schedule WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// ════════════════════ ВІДСУТНОСТІ (Календар команди) ════════════════════
// Чергування (вище) — окремий тип, RNK-only, не чіпаємо. Відсутності — для ВСІХ команд.
const ABSENCE_KINDS = new Set(["day_off", "vacation", "sick", "short_day"]);
type Auth = { role: string; teamId: number | null; managerId: number | null; userId: number };

/** Менеджери для FE-фільтра відсутностей — УСІ команди (не лише РНК). Роль-скоуп:
 *  admin → усі активні (або обрана команда); team_lead → своя команда; manager → лише себе. */
async function calendarManagerScope(auth: Auth, teamId: number | null) {
  const params: unknown[] = [];
  const conds = ["m.is_active"];
  if (auth.role === "manager") { params.push(auth.managerId); conds.push(`m.id = $${params.length}`); }
  else if (auth.role === "team_lead") { params.push(auth.teamId); conds.push(`m.team_id = $${params.length}`); }
  else if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name FROM managers m LEFT JOIN teams t ON t.id = m.team_id
      WHERE ${conds.join(" AND ")} ORDER BY t.name NULLS LAST, m.name`, params);
  return r.rows.map((x) => ({ id: x.id, name: x.name, teamId: x.team_id, teamName: x.team_name }));
}

/** Роль-скоуп відсутностей СЕРВЕРНО (сервер не віддає чужі дні):
 *  admin — усе (або ?teamId); team_lead — своя команда; manager — ЛИШЕ свої. */
function absenceScope(auth: Auth, teamId: number | null, params: unknown[]): string {
  const conds: string[] = [];
  if (auth.role === "manager") { params.push(auth.managerId); conds.push(`a.manager_id = $${params.length}`); }
  else if (auth.role === "team_lead") { params.push(auth.teamId); conds.push(`a.team_id = $${params.length}`); }
  else if (teamId) { params.push(teamId); conds.push(`a.team_id = $${params.length}`); }
  return conds.length ? " AND " + conds.join(" AND ") : "";
}

async function queryAbsences(auth: Auth, teamId: number | null, from: string, to: string) {
  const params: unknown[] = [from, to];
  const scope = absenceScope(auth, teamId, params);
  // Перетин діапазону відсутності з вікном [from,to]: start<=to AND end>=from.
  const r = await pool.query<{
    id: number; manager_id: number; manager_name: string; team_id: number | null; team_name: string | null;
    kind: string; start_date: string; end_date: string; hours: string | null; note: string | null;
    status: string; created_by: number | null; created_at: string; approved_by: number | null;
    approver_name: string | null; approved_at: string | null;
  }>(
    `SELECT a.id, a.manager_id, m.name AS manager_name, a.team_id, t.name AS team_name,
            a.kind, to_char(a.start_date,'YYYY-MM-DD') AS start_date, to_char(a.end_date,'YYYY-MM-DD') AS end_date,
            a.hours, a.note, a.status, a.created_by, to_char(a.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ') AS created_at,
            a.approved_by, COALESCE(am.name, au.email) AS approver_name, to_char(a.approved_at,'YYYY-MM-DD"T"HH24:MI:SSZ') AS approved_at
       FROM team_calendar_absences a
       JOIN managers m ON m.id = a.manager_id
       LEFT JOIN teams t ON t.id = a.team_id
       LEFT JOIN users au ON au.id = a.approved_by
       LEFT JOIN managers am ON am.id = au.manager_id
      WHERE a.start_date <= $2 AND a.end_date >= $1 ${scope}
      ORDER BY a.start_date, m.name`, params);
  return r.rows.map((x) => ({
    id: x.id, managerId: x.manager_id, managerName: x.manager_name, teamId: x.team_id, teamName: x.team_name,
    kind: x.kind, startDate: x.start_date, endDate: x.end_date, hours: x.hours == null ? null : Number(x.hours),
    note: x.note, status: x.status, createdBy: x.created_by, createdAt: x.created_at,
    approvedBy: x.approved_by, approverName: x.approver_name, approvedAt: x.approved_at,
    mine: x.manager_id === auth.managerId,
  }));
}

/** «⏳ N на погодженні» — рахуємо лише те, що ГЛЯДАЧ може погодити (admin — усе; team_lead —
 *  своя команда). Менеджер бачить власні pending як інфо (свій лічильник). */
async function countApprovablePending(auth: Auth, from: string, to: string): Promise<number> {
  const params: unknown[] = [from, to];
  let scope = "";
  if (auth.role === "manager") { params.push(auth.managerId); scope = ` AND a.manager_id = $${params.length}`; }
  else if (auth.role === "team_lead") { params.push(auth.teamId); scope = ` AND a.team_id = $${params.length}`; }
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) n FROM team_calendar_absences a
      WHERE a.status = 'pending' AND a.start_date <= $2 AND a.end_date >= $1 ${scope}`, params);
  return Number(r.rows[0]?.n ?? 0);
}

/** Створити відсутність. Manager — лише собі, status='pending'. Team_lead — своя команда,
 *  Admin — будь-хто; їхні власні відмітки одразу approved (як repeat_client_plans). */
dutyRouter.post("/absences", async (req, res) => {
  const auth = req.auth! as Auth;
  const kind = String(req.body?.kind ?? "");
  if (!ABSENCE_KINDS.has(kind)) return res.status(400).json({ error: "kind ∈ day_off|vacation|sick|short_day" });
  let managerId = Number(req.body?.managerId);
  const start = String(req.body?.startDate ?? "").slice(0, 10);
  // Поденні типи (day_off/short_day) ігнорують end — end=start. Діапазонні беруть end.
  const isRange = kind === "vacation" || kind === "sick";
  const end = isRange ? String(req.body?.endDate ?? start).slice(0, 10) : start;
  const hours = kind === "short_day" && req.body?.hours != null ? Number(req.body.hours) : null;
  const note = req.body?.note != null ? String(req.body.note).slice(0, 500) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return res.status(400).json({ error: "startDate/endDate (YYYY-MM-DD)" });
  if (end < start) return res.status(400).json({ error: "endDate < startDate" });
  // Хто для кого:
  if (auth.role === "manager") managerId = auth.managerId!;           // менеджер — лише собі
  if (!managerId) return res.status(400).json({ error: "managerId обовʼязковий" });
  const mgr = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1 AND is_active`, [managerId]);
  if (!mgr.rowCount) return res.status(404).json({ error: "Менеджера не знайдено" });
  const teamId = mgr.rows[0].team_id;
  if (auth.role === "team_lead" && teamId !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  // 🔴 «Не погоджуєш сам себе»: відмітка АПРУВЕРА одразу approved, ОКРІМ власної відсутності
  // тімліда (він не погоджує себе → pending на адміна). Admin → завжди approved (сам собі теж:
  // адмін — найвищий рівень, вище нема). manager → завжди pending.
  const isSelf = managerId === auth.managerId;
  const approver = auth.role === "admin" || (auth.role === "team_lead" && teamId === auth.teamId && !isSelf);
  const status = approver ? "approved" : "pending";
  const r = await pool.query<{ id: number }>(
    `INSERT INTO team_calendar_absences (manager_id, team_id, kind, start_date, end_date, hours, note, status, created_by, approved_by, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ${approver ? "$9" : "NULL"}, ${approver ? "now()" : "NULL"}) RETURNING id`,
    [managerId, teamId, kind, start, end, hours, note, status, auth.userId]);
  res.json({ ok: true, id: r.rows[0].id, status });
});

/** Погодити / відхилити — лише admin або team_lead (своя команда). */
async function decide(req: import("express").Request, res: import("express").Response, decision: "approved" | "rejected") {
  const auth = req.auth! as Auth;
  if (auth.role !== "admin" && auth.role !== "team_lead") return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  const id = Number(req.params.id);
  const row = await pool.query<{ team_id: number | null; manager_id: number; status: string }>(`SELECT team_id, manager_id, status FROM team_calendar_absences WHERE id = $1`, [id]);
  if (!row.rowCount) return res.status(404).json({ error: "Не знайдено" });
  if (auth.role === "team_lead") {
    if (row.rows[0].team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
    // 🔴 Тімлід НЕ погоджує власну відсутність — це робить адмін (рівень вище).
    if (row.rows[0].manager_id === auth.managerId) return res.status(403).json({ error: "Власну відсутність погоджує адміністратор" });
  }
  await pool.query(
    `UPDATE team_calendar_absences SET status = $1, approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $3`,
    [decision, auth.userId, id]);
  res.json({ ok: true, status: decision });
}
dutyRouter.post("/absences/:id/approve", (req, res) => decide(req, res, "approved"));
dutyRouter.post("/absences/:id/reject", (req, res) => decide(req, res, "rejected"));

/** Видалити відсутність. Творець (свій pending), team_lead (своя команда), admin (будь-хто). */
dutyRouter.delete("/absences/:id", async (req, res) => {
  const auth = req.auth! as Auth;
  const id = Number(req.params.id);
  const row = await pool.query<{ team_id: number | null; manager_id: number; created_by: number | null; status: string }>(
    `SELECT team_id, manager_id, created_by, status FROM team_calendar_absences WHERE id = $1`, [id]);
  if (!row.rowCount) return res.json({ ok: true });
  const a = row.rows[0];
  const isAdmin = auth.role === "admin";
  const isLeadOwn = auth.role === "team_lead" && a.team_id === auth.teamId;
  const isOwnPending = a.manager_id === auth.managerId && a.status === "pending";
  if (!isAdmin && !isLeadOwn && !isOwnPending) return res.status(403).json({ error: "Немає прав видалити цю відмітку" });
  await pool.query(`DELETE FROM team_calendar_absences WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// ── ДЕРЖСВЯТА (глобальні, admin-only запис) ──
dutyRouter.post("/holidays", async (req, res) => {
  const auth = req.auth! as Auth;
  if (auth.role !== "admin") return res.status(403).json({ error: "Держсвята фіксує лише адміністратор" });
  const date = String(req.body?.date ?? "").slice(0, 10);
  const name = String(req.body?.name ?? "").slice(0, 200).trim() || "Свято";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date (YYYY-MM-DD)" });
  const r = await pool.query<{ id: number }>(
    `INSERT INTO company_holidays (holiday_date, name, created_by) VALUES ($1,$2,$3)
     ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [date, name, auth.userId]);
  res.json({ ok: true, id: r.rows[0].id });
});
dutyRouter.delete("/holidays/:id", async (req, res) => {
  const auth = req.auth! as Auth;
  if (auth.role !== "admin") return res.status(403).json({ error: "Лише адміністратор" });
  await pool.query(`DELETE FROM company_holidays WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
});

/**
 * PHASE-2 API — «чи присутній менеджер у день Y». Повертає для кожного дня [from,to]:
 * present (робочий і без approved-відсутності/свята), або причину (weekend|holiday|<kind>).
 * 🔴 Враховує ЛИШЕ approved-відсутності (pending план не чіпає). short_day → present=true,
 * але partialHours віддається (Phase 2 вирішить, як зважити). Роль-скоуп той самий.
 */
dutyRouter.get("/presence", async (req, res) => {
  const auth = req.auth! as Auth;
  const managerId = auth.role === "manager" ? auth.managerId : (req.query.managerId ? Number(req.query.managerId) : null);
  const from = String(req.query.from ?? "").slice(0, 10);
  const to = String(req.query.to ?? "").slice(0, 10);
  if (!managerId || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "managerId, from, to (YYYY-MM-DD) обовʼязкові" });
  }
  // Скоуп: team_lead — лише своя команда; manager — лише себе (вже примусово вище).
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  const [absR, holR] = await Promise.all([
    pool.query<{ kind: string; start_date: string; end_date: string; hours: string | null }>(
      `SELECT kind, to_char(start_date,'YYYY-MM-DD') start_date, to_char(end_date,'YYYY-MM-DD') end_date, hours
         FROM team_calendar_absences WHERE manager_id = $1 AND status = 'approved' AND start_date <= $3 AND end_date >= $2`,
      [managerId, from, to]),
    pool.query<{ d: string }>(`SELECT to_char(holiday_date,'YYYY-MM-DD') d FROM company_holidays WHERE holiday_date BETWEEN $1 AND $2`, [from, to]),
  ]);
  const holidays = new Set(holR.rows.map((h) => h.d));
  const days: { date: string; present: boolean; reason: string | null; partialHours: number | null }[] = [];
  const d = new Date(from + "T00:00:00Z"); const end = new Date(to + "T00:00:00Z");
  while (d.getTime() <= end.getTime()) {
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    let present = true, reason: string | null = null, partial: number | null = null;
    if (dow === 0 || dow === 6) { present = false; reason = "weekend"; }
    else if (holidays.has(date)) { present = false; reason = "holiday"; }
    else {
      const ab = absR.rows.find((a) => date >= a.start_date && date <= a.end_date);
      if (ab) {
        if (ab.kind === "short_day") { partial = ab.hours == null ? null : Number(ab.hours); reason = "short_day"; }
        else { present = false; reason = ab.kind; }
      }
    }
    days.push({ date, present, reason, partialHours: partial });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const workingDaysPresent = days.filter((x) => x.present && x.reason !== "short_day").length + days.filter((x) => x.reason === "short_day").length;
  res.json({ managerId, from, to, days, workingDaysPresent });
});
