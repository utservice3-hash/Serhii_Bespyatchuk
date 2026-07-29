import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { roleHasPerm } from "../auth/rbac.js";
import { ONE_ON_ONE_TYPES, type OneOnOneType } from "../oneOnOne/catalog.js";

/**
 * Ван-ту-вани (1×1) — три типи (A: тімлід→менеджер, B: керівник→тімлід, V: HR→всі).
 * Доступ до РОЗДІЛУ гейтить екран `oneonone` (tab-гейт у requireAuth). Далі — ДВА скоупи:
 *  • conduct — кого можна ПРОВОДИТИ (за типом);
 *  • view    — чию історію/аналітику видно: conductor бачить ЛИШЕ свої проведені; наскрізний
 *              перегляд (усі типи/люди) — тільки право view_all_1x1 (HR/СЕО/ОД).
 * Питання — версіоновані форми в БД; історія рендериться проти form_version запису.
 */
export const oneOnOnesRouter = Router();
oneOnOnesRouter.use(requireAuth);

const isType = (t: unknown): t is OneOnOneType => ONE_ON_ONE_TYPES.includes(t as OneOnOneType);
const monthOf = (q: unknown) => (String(q || new Date().toISOString().slice(0, 7)).slice(0, 7)) + "-01";
/** Сьогодні по-київськи (YYYY-MM-DD) — дати завжди в київській зоні. */
const kyivToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
/** Дата зустрічі з запиту: строго YYYY-MM-DD, інакше null. */
const dateOf = (q: unknown): string | null => {
  const s = String(q ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
};
const crossview = (auth: { roleKey: string }) => roleHasPerm(auth.roleKey, "view_all_1x1");

/** Чи може ця роль ПРОВОДИТИ тип. A: тімлід(своя команда) або наскрізний; B/V: лише наскрізний. */
function canConduct(auth: { role: string; roleKey: string }, type: OneOnOneType): boolean {
  if (crossview(auth)) return true;
  if (type === "A") return auth.role === "team_lead";
  return false;
}

/** WHERE для субʼєктів, яких дозволено проводити (за типом і скоупом). */
function conductSubjectScope(auth: { role: string; roleKey: string; teamId: number | null }, type: OneOnOneType) {
  if (type === "B") return { where: "m.is_team_lead AND m.is_active", params: [] as unknown[] };
  if (type === "V") return { where: "m.is_active", params: [] as unknown[] };
  // type A
  if (crossview(auth)) return { where: "m.is_active", params: [] as unknown[] };
  return { where: "m.team_id = $1 AND m.is_active", params: [auth.teamId] as unknown[] };
}

/** WHERE-фрагмент для VIEW-скоупу (історія/аналітика): наскрізний → усе; інакше лише свої проведені. */
function viewScope(auth: { userId: number; roleKey: string }, alias = "o") {
  if (crossview(auth)) return { frag: "TRUE", params: [] as unknown[] };
  return { frag: `${alias}.conducted_by = $P`, params: [auth.userId] as unknown[] };
}

const overallFrom = (type: OneOnOneType, answers: Record<string, { score?: number }>, enps: number | null) => {
  if (type === "V") return typeof enps === "number" ? enps : null;
  const s = Object.values(answers || {}).map((a) => a?.score).filter((x): x is number => typeof x === "number" && x > 0);
  return s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : null;
};

/** Які типи 1×1 цей користувач може ПРОВОДИТИ + прапорці — усе по ЖИВОМУ roleKey/правах,
 *  не по scope-clamped auth.role чи знімку токена. FE бере доступні типи ЗВІДСИ (працює за
 *  будь-якого data_scope і незалежно від свіжості токена). */
oneOnOnesRouter.get("/conduct-types", (req, res) => {
  const auth = req.auth!;
  res.json({
    types: ONE_ON_ONE_TYPES.filter((t) => canConduct(auth, t)),
    crossview: crossview(auth),
    canEdit: roleHasPerm(auth.roleKey, "edit_1x1_forms"),
  });
});

async function activeForm(type: OneOnOneType): Promise<{ version: number; questions: unknown } | null> {
  const r = await pool.query<{ version: number; questions: unknown }>(
    "SELECT version, questions FROM one_on_one_forms WHERE type=$1 AND is_active ORDER BY version DESC LIMIT 1", [type]);
  return r.rows[0] ?? null;
}

// ── Форми (питання) ──────────────────────────────────────────────────────────
/** Активна (або конкретна) версія форми типу — для рендеру та історії. */
oneOnOnesRouter.get("/forms/:type", async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const ver = req.query.version ? Number(req.query.version) : null;
  const r = ver
    ? await pool.query("SELECT type, version, questions, is_active FROM one_on_one_forms WHERE type=$1 AND version=$2", [type, ver])
    : await pool.query("SELECT type, version, questions, is_active FROM one_on_one_forms WHERE type=$1 AND is_active ORDER BY version DESC LIMIT 1", [type]);
  if (!r.rows[0]) return res.status(404).json({ error: "Форма не знайдена" });
  res.json(r.rows[0]);
});

/** Список версій форми (для редактора/історії). */
oneOnOnesRouter.get("/forms/:type/versions", async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const r = await pool.query(
    "SELECT version, is_active, created_at FROM one_on_one_forms WHERE type=$1 ORDER BY version DESC", [type]);
  res.json({ versions: r.rows });
});

/** Редагувати набір питань → нова версія (стара лишається для історії). Право edit_1x1_forms. */
oneOnOnesRouter.put("/forms/:type", requirePerm("edit_1x1_forms"), async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const questions = req.body?.questions;
  if (!questions || typeof questions !== "object" || !Array.isArray(questions.sections)) {
    return res.status(400).json({ error: "questions.sections обовʼязкові" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const nv = await client.query<{ v: number }>("SELECT COALESCE(MAX(version),0)+1 AS v FROM one_on_one_forms WHERE type=$1", [type]);
    const version = nv.rows[0].v;
    await client.query("UPDATE one_on_one_forms SET is_active=false WHERE type=$1 AND is_active", [type]);
    await client.query(
      "INSERT INTO one_on_one_forms (type, version, questions, is_active, created_by) VALUES ($1,$2,$3,true,$4)",
      [type, version, JSON.stringify(questions), req.auth!.userId]);
    await client.query("COMMIT");
    res.json({ ok: true, type, version });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// ── Проведення ───────────────────────────────────────────────────────────────
/** Список субʼєктів, яких дозволено проводити (за типом) + зустрічі за МІСЯЦЬ.
 *  Зустрічей у місяці може бути КІЛЬКА: `meetings` — скільки, `overall`/`last_meeting_date` —
 *  по ОСТАННІЙ. `done` = чи була хоч одна (яку я маю право бачити). */
oneOnOnesRouter.get("/subjects", async (req, res) => {
  const type = String(req.query.type || "");
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  if (!canConduct(req.auth!, type)) return res.status(403).json({ error: "Немає доступу до проведення цього типу" });
  const month = monthOf(req.query.month);
  const { where, params } = conductSubjectScope(req.auth!, type);
  // conductSubjectScope для типу A використовує $1 → його параметри мають іти ПЕРШИМИ.
  const p: unknown[] = [...params];
  const push = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const typeP = push(type), monthP = push(month);
  // видимість запису: наскрізний → усі; інакше лише мною проведені (статус чесний).
  const vsFrag = crossview(req.auth!) ? "TRUE" : `x.conducted_by = ${push(req.auth!.userId)}`;
  const inMonth = `x.subject_manager_id = m.id AND x.type = ${typeP}
                   AND date_trunc('month', x.meeting_date) = ${monthP}::date AND (${vsFrag})`;
  const r = await pool.query(
    `SELECT m.id, m.name, m.team_id, m.is_team_lead, t.name AS team_name,
            last.overall, to_char(last.meeting_date,'YYYY-MM-DD') AS last_meeting_date,
            last.updated_at, agg.meetings, (agg.meetings > 0) AS done
       FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id
       LEFT JOIN LATERAL (SELECT count(*)::int AS meetings FROM one_on_ones x WHERE ${inMonth}) agg ON TRUE
       LEFT JOIN LATERAL (SELECT x.overall, x.meeting_date, x.updated_at FROM one_on_ones x
                           WHERE ${inMonth} ORDER BY x.meeting_date DESC LIMIT 1) last ON TRUE
      WHERE ${where}
      ORDER BY t.name NULLS LAST, m.is_team_lead DESC, m.name`,
    p
  );
  res.json({ type, month, subjects: r.rows });
});

/** Журнал зустрічей одного субʼєкта за N місяців (view-скоуп). Кожна зустріч — окремий рядок. */
oneOnOnesRouter.get("/meetings/:type/:managerId", async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const managerId = Number(req.params.managerId);
  const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));
  const p: unknown[] = [managerId, type];
  const push = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const vsFrag = crossview(req.auth!) ? "TRUE" : `o.conducted_by = ${push(req.auth!.userId)}`;
  const monthsP = push(months - 1);
  const r = await pool.query(
    `SELECT to_char(o.meeting_date,'YYYY-MM-DD') AS meeting_date, o.overall, o.enps_score,
            o.satisfaction_score, o.form_version, o.conducted_by, o.updated_at,
            COALESCE(mm.name, u.email) AS conducted_by_name
       FROM one_on_ones o
       LEFT JOIN users u ON u.id = o.conducted_by
       LEFT JOIN managers mm ON mm.id = u.manager_id
      WHERE o.subject_manager_id=$1 AND o.type=$2 AND (${vsFrag})
        AND o.meeting_date >= (date_trunc('month', now()) - make_interval(months => ${monthsP}))
      ORDER BY o.meeting_date DESC`,
    p
  );
  res.json({ type, subject_manager_id: managerId, meetings: r.rows });
});

/** Один запис ЗУСТРІЧІ за датою (для проведення або перегляду). Дата — авторитетна:
 *  ?date=YYYY-MM-DD визначає КОНКРЕТНУ зустріч. Без дати — сьогоднішня (нова зустріч).
 *  Порожній шаблон — якщо на цю дату ще не проводили. */
oneOnOnesRouter.get("/record/:type/:managerId", async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const managerId = Number(req.params.managerId);
  const meetingDate = dateOf(req.query.date) ?? kyivToday();
  const r = await pool.query(
    `SELECT o.subject_manager_id, o.type, to_char(o.meeting_date,'YYYY-MM-DD') AS meeting_date,
            o.form_version, o.answers, o.overall, o.satisfaction_score,
            o.enps_score, o.enps_reason, o.notes, o.conducted_by, o.updated_at,
            COALESCE(mm.name, u.email) AS conducted_by_name
       FROM one_on_ones o
       LEFT JOIN users u ON u.id = o.conducted_by
       LEFT JOIN managers mm ON mm.id = u.manager_id
      WHERE o.subject_manager_id=$1 AND o.type=$2 AND o.meeting_date=$3`,
    [managerId, type, meetingDate]);
  const rec = r.rows[0];
  if (rec) {
    if (!crossview(req.auth!) && rec.conducted_by !== req.auth!.userId) {
      return res.status(403).json({ error: "Цей запис проводив інший" });
    }
    return res.json(rec);
  }
  // немає запису → віддаємо порожній шаблон, лише якщо цей користувач може проводити цей тип
  if (!canConduct(req.auth!, type)) return res.status(403).json({ error: "Немає доступу" });
  const form = await activeForm(type);
  res.json({ subject_manager_id: managerId, type, meeting_date: meetingDate, form_version: form?.version ?? 1,
    answers: {}, overall: null, satisfaction_score: null, enps_score: null, enps_reason: null, notes: null, conducted_by: null });
});

/** Зберегти запис (upsert). Ставить conducted_by=я, form_version=активна. */
oneOnOnesRouter.post("/record", async (req, res) => {
  const auth = req.auth!;
  const type = String(req.body?.type || "");
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  if (!canConduct(auth, type)) return res.status(403).json({ error: "Немає доступу до проведення цього типу" });
  const managerId = Number(req.body?.subjectManagerId);
  // ДАТА ЗУСТРІЧІ — авторитетна: визначає, який саме запис створюється/оновлюється.
  const meetingDate = dateOf(req.body?.meetingDate) ?? kyivToday();
  const answers = (req.body?.answers ?? {}) as Record<string, { score?: number; text?: string }>;
  if (!managerId || typeof answers !== "object") return res.status(400).json({ error: "subjectManagerId та answers обовʼязкові" });
  // субʼєкт має бути в conduct-скоупі цього типу
  const { where, params } = conductSubjectScope(auth, type);
  const inScope = await pool.query(`SELECT 1 FROM managers m WHERE m.id=$${params.length + 1} AND (${where})`, [...params, managerId]);
  if (!inScope.rowCount) return res.status(403).json({ error: "Субʼєкт поза вашим скоупом" });
  // не можна перезаписувати чужий запис (лише свій або наскрізний)
  const ex = await pool.query<{ conducted_by: number | null }>(
    "SELECT conducted_by FROM one_on_ones WHERE subject_manager_id=$1 AND type=$2 AND meeting_date=$3",
    [managerId, type, meetingDate]);
  if (ex.rows[0] && !crossview(auth) && ex.rows[0].conducted_by !== auth.userId) {
    return res.status(403).json({ error: "Цей запис проводив інший" });
  }
  const enpsScore = type === "V" && Number.isInteger(req.body?.enpsScore) ? Number(req.body.enpsScore) : null;
  const enpsReason = type === "V" ? (req.body?.enpsReason ?? null) : null;
  const notes = type === "V" ? (req.body?.notes ?? null) : null;
  // ЗАДОВОЛЕНІСТЬ: для A/Б — власний структурний блок (1-10); для В — це і є eNPS-бал
  // (єдине джерело для історії). У `overall` НЕ входить — окремий показник.
  const rawSat = Number(req.body?.satisfactionScore);
  const satisfaction = type === "V"
    ? enpsScore
    : (Number.isInteger(rawSat) && rawSat >= 1 && rawSat <= 10 ? rawSat : null);
  const overall = overallFrom(type, answers, enpsScore);
  const form = await activeForm(type);
  await pool.query(
    `INSERT INTO one_on_ones (subject_manager_id, type, meeting_date, form_version, conducted_by, answers, overall, enps_score, enps_reason, notes, satisfaction_score, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (subject_manager_id, type, meeting_date) DO UPDATE SET
       answers=EXCLUDED.answers, overall=EXCLUDED.overall, enps_score=EXCLUDED.enps_score,
       enps_reason=EXCLUDED.enps_reason, notes=EXCLUDED.notes, conducted_by=EXCLUDED.conducted_by,
       satisfaction_score=EXCLUDED.satisfaction_score,
       form_version=EXCLUDED.form_version, updated_at=now()`,
    [managerId, type, meetingDate, form?.version ?? 1, auth.userId, JSON.stringify(answers), overall,
     enpsScore, enpsReason, notes ? JSON.stringify(notes) : null, satisfaction]);
  res.json({ ok: true, overall, satisfaction, meetingDate });
});

// ── Історія / аналітика (view-скоуп) ─────────────────────────────────────────
/** Історія оцінок субʼєктів за N місяців (під view-скоупом). */
oneOnOnesRouter.get("/stats/scores", async (req, res) => {
  const type = String(req.query.type || "A");
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const months = Math.min(24, Math.max(1, Number(req.query.months) || 6));
  const vs = viewScope(req.auth!, "o");
  const params: unknown[] = [type];
  let vsFrag = vs.frag;
  if (vs.params.length) { params.push(vs.params[0]); vsFrag = vs.frag.replace("$P", `$${params.length}`); }
  params.push(months - 1);
  const r = await pool.query(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name,
            to_char(o.meeting_date,'YYYY-MM-DD') AS meeting_date,
            to_char(date_trunc('month', o.meeting_date),'YYYY-MM') AS month,
            o.overall, o.enps_score, o.satisfaction_score, o.form_version, o.answers
       FROM one_on_ones o
       JOIN managers m ON m.id = o.subject_manager_id
       LEFT JOIN teams t ON t.id = m.team_id
      WHERE o.type=$1 AND (${vsFrag})
        AND o.meeting_date >= (date_trunc('month', now()) - make_interval(months => $${params.length}))
      ORDER BY t.name NULLS LAST, m.name, o.meeting_date`, params);
  res.json({ type, rows: r.rows });
});

/** eNPS-агрегат за місяцями (тип В): %промоутерів − %критиків (0-6 крит /7-8 нейтр /9-10 пром). */
oneOnOnesRouter.get("/enps", async (req, res) => {
  const months = Math.min(24, Math.max(1, Number(req.query.months) || 12));
  const vs = viewScope(req.auth!, "o");
  const params: unknown[] = [];
  let vsFrag = vs.frag;
  if (vs.params.length) { params.push(vs.params[0]); vsFrag = vs.frag.replace("$P", `$${params.length}`); }
  params.push(months - 1);
  const r = await pool.query<{ month: string; prom: number; det: number; total: number }>(
    `SELECT to_char(date_trunc('month', o.meeting_date),'YYYY-MM') AS month,
            count(*) FILTER (WHERE o.enps_score BETWEEN 9 AND 10)::int AS prom,
            count(*) FILTER (WHERE o.enps_score BETWEEN 0 AND 6)::int  AS det,
            count(*) FILTER (WHERE o.enps_score IS NOT NULL)::int      AS total
       FROM one_on_ones o
      WHERE o.type='V' AND o.enps_score IS NOT NULL AND (${vsFrag})
        AND o.meeting_date >= (date_trunc('month', now()) - make_interval(months => $${params.length}))
      GROUP BY date_trunc('month', o.meeting_date) ORDER BY date_trunc('month', o.meeting_date)`, params);
  const series = r.rows.map((x) => ({
    month: x.month, promoters: x.prom, detractors: x.det, passives: x.total - x.prom - x.det,
    total: x.total, enps: x.total ? Math.round(((x.prom - x.det) / x.total) * 100) : null,
  }));
  res.json({ series });
});
