// 9223 замір: READ ONLY (БД — BEGIN READ ONLY … ROLLBACK; Kommo — лише GET). Запуск: cd <repo>/backend && node /tmp/m9223.cjs
// Секретів не друкує.
const { Client } = require(process.cwd() + "/node_modules/pg");
const fs = require("fs");
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL|KOMMO_BASE_URL|KOMMO_API_TOKEN)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const kget = async (p) => {
  const r = await fetch(process.env.KOMMO_BASE_URL + p, { headers: { Authorization: "Bearer " + process.env.KOMMO_API_TOKEN } });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error("Kommo " + p.split("?")[0] + " → " + r.status);
  return r.json();
};
const J = (x) => JSON.stringify(x);
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  const q = async (label, sql, p = []) => { const r = await c.query(sql, p); console.log(`\n== ${label} (${r.rowCount})`); for (const x of r.rows) console.log(J(x)); return r.rows; };
  try {
    await q("ЗАДАЧА 9223", `SELECT t.id, t.title, t.status, t.deadline, t.task_type, t.client_key, t.description, t.comments,
        m.name AS assignee, COALESCE(u.full_name,u.email) AS author, COALESCE(rv.full_name,rv.email) AS reviewer,
        t.created_at, t.updated_at
      FROM tasks t LEFT JOIN managers m ON m.id=t.assignee_id LEFT JOIN users u ON u.id=t.created_by LEFT JOIN users rv ON rv.id=t.reviewer_id
      WHERE t.id=9223`);
    await q("КОМЕНТАРІ 9223", `SELECT tc.created_at, COALESCE(u.full_name,u.email) AS who, tc.body FROM task_comments tc LEFT JOIN users u ON u.id=tc.author_id WHERE task_id=9223 ORDER BY tc.created_at`);
    await q("СТАТУСИ 9223", `SELECT l.changed_at, l.from_status, l.to_status, COALESCE(u.full_name,u.email) AS who FROM task_status_log l LEFT JOIN users u ON u.id=l.changed_by WHERE task_id=9223 ORDER BY changed_at`);
    await q("МЕНЕДЖЕРИ Шаврова/Пехньо", `SELECT m.id, m.name, m.kommo_user_id, m.is_active, m.team_id, t.name AS team FROM managers m LEFT JOIN teams t ON t.id=m.team_id
      WHERE m.name ILIKE '%шаврова%' OR m.name ILIKE '%пехньо%' ORDER BY m.id`);
    const keys = await q("КЛЮЧІ Global Solar", `SELECT d.client_key, COUNT(*)::int AS deals, MIN(d.client_name) AS name1, MAX(d.client_name) AS name2,
        MIN(d.created_at_kommo)::date AS first, MAX(d.created_at_kommo)::date AS last
      FROM deals d WHERE d.client_name ILIKE '%global%solar%' OR d.client_name ILIKE '%глобал%солар%' OR d.client_key ILIKE '%globalsolar%' OR d.client_key ILIKE '%глобалсолар%' OR d.name ILIKE '%global solar%'
      GROUP BY d.client_key ORDER BY deals DESC`);
    const ks = keys.map((k) => k.client_key).filter(Boolean);
    await q("АЛІАСИ", `SELECT * FROM client_key_alias WHERE alias_key = ANY($1) OR canonical_key = ANY($1)`, [ks]);
    const deals = await q("УГОДИ Global Solar", `SELECT d.kommo_id, d.client_key, d.name, m.name AS mgr, d.kommo_user_id, d.pipeline_id, d.status_id, psm.funnel_stage, d.price,
        (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date AS created, (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date AS closed,
        (d.updated_at_kommo AT TIME ZONE 'Europe/Kyiv') AS upd, d.synced_at
      FROM deals d LEFT JOIN managers m ON m.id=d.manager_id LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id=d.pipeline_id AND psm.status_id=d.status_id
      WHERE d.client_key = ANY($1) ORDER BY d.created_at_kommo DESC LIMIT 60`, [ks]);
    await q("ОПЛАЧЕНІ ПО МЕНЕДЖЕРАХ (як primary_mgr)", `SELECT d.client_key, m.name, COUNT(*)::int AS n, MAX(d.closed_at_kommo)::date AS mx
      FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id=d.pipeline_id AND psm.status_id=d.status_id LEFT JOIN managers m ON m.id=d.manager_id
      WHERE psm.funnel_stage='paid' AND d.client_key = ANY($1) GROUP BY 1,2 ORDER BY 1, n DESC, mx DESC`, [ks]);
    await q("LOYALTY_OVERRIDES", `SELECT lo.client_key, lo.hidden, lo.pinned_manager_id, m.name AS pinned, lo.pinned_from_month, lo.archived_at, lo.updated_at, COALESCE(u.full_name,u.email) AS by
      FROM loyalty_overrides lo LEFT JOIN managers m ON m.id=lo.pinned_manager_id LEFT JOIN users u ON u.id=lo.updated_by WHERE lo.client_key = ANY($1)`, [ks]);
    await q("ІСТОРІЯ ПЕРЕДАЧ", `SELECT h.client_key, fm.name AS from_m, tm.name AS to_m, h.effective_from, h.kind, h.reason, COALESCE(u.full_name,u.email) AS who, h.created_at
      FROM client_manager_history h LEFT JOIN managers fm ON fm.id=h.from_manager_id JOIN managers tm ON tm.id=h.to_manager_id LEFT JOIN users u ON u.id=h.changed_by
      WHERE h.client_key = ANY($1) ORDER BY h.created_at`, [ks]);
    await q("ЖУРНАЛ client_admin_log", `SELECT at, client_key, action, actor_user_id, details FROM client_admin_log WHERE client_key = ANY($1) ORDER BY at`, [ks]);
    await q("ЦИКЛИ РЕАКТИВАЦІЇ", `SELECT * FROM client_react_cycles WHERE client_key = ANY($1) ORDER BY cycle_month`, [ks]);
    await q("ПЛАНИ ПО КЛІЄНТУ", `SELECT p.client_key, p.month, m.name AS mgr, p.plan, p.status, p.comment, p.updated_at FROM repeat_client_plans p LEFT JOIN managers m ON m.id=p.manager_id
      WHERE p.client_key = ANY($1) AND p.month >= DATE '2026-09-01' ORDER BY p.month`, [ks]).catch((e) => console.log("ПЛАНИ:", e.message));
    await q("ЗАДАЧІ ПО КЛІЄНТУ", `SELECT t.id, t.title, t.status, t.task_type, m.name AS assignee, t.created_at FROM tasks t LEFT JOIN managers m ON m.id=t.assignee_id
      WHERE t.client_key = ANY($1) ORDER BY t.created_at DESC LIMIT 20`, [ks]);
    await q("ЗАПАСНИЙ ПОШУК: *solar* у Шаврової/Пехньо", `SELECT d.client_key, d.client_name, m.name, COUNT(*)::int AS n FROM deals d JOIN managers m ON m.id=d.manager_id
      WHERE (d.client_name ILIKE '%solar%' OR d.client_name ILIKE '%солар%' OR d.name ILIKE '%solar%' OR d.name ILIKE '%солар%') AND (m.name ILIKE '%шаврова%' OR m.name ILIKE '%пехньо%') GROUP BY 1,2,3`);
    await q("УСІ ПЕРЕДАЧІ від/до Шаврової чи Пехньо з 01.10", `SELECT h.client_key, fm.name AS from_m, tm.name AS to_m, h.effective_from, h.kind, h.reason, h.created_at
      FROM client_manager_history h LEFT JOIN managers fm ON fm.id=h.from_manager_id JOIN managers tm ON tm.id=h.to_manager_id
      WHERE h.created_at >= '2026-10-01' AND (fm.name ILIKE '%шаврова%' OR tm.name ILIKE '%пехньо%' OR tm.name ILIKE '%шаврова%' OR fm.name ILIKE '%пехньо%') ORDER BY h.created_at`);
    // масштаб: усі передачі за листопад
    await q("ПЕРЕДАЧІ З 01.10 (усі клієнти)", `SELECT h.kind, h.effective_from, COUNT(*)::int AS n FROM client_manager_history h WHERE h.created_at >= '2026-10-01' GROUP BY 1,2 ORDER BY 2,1`);
    // Kommo: поточний відповідальний по угодах і компаніях
    const ids = deals.map((d) => d.kommo_id).slice(0, 40);
    if (ids.length) {
      try {
        const r = await kget(`/api/v4/leads?with=companies&${ids.map((i) => `filter[id][]=${i}`).join("&")}`);
        const ls = r?._embedded?.leads ?? [];
        console.log(`\n== KOMMO УГОДИ (${ls.length})`);
        const comp = new Set();
        for (const l of ls) { console.log(J({ id: l.id, resp: l.responsible_user_id, status: l.status_id, upd: new Date(l.updated_at * 1000).toISOString(), companies: (l._embedded?.companies ?? []).map((x) => x.id) })); for (const x of l._embedded?.companies ?? []) comp.add(x.id); }
        for (const cid of comp) { const co = await kget(`/api/v4/companies/${cid}`); console.log("KOMMO КОМПАНІЯ", J({ id: co.id, name: co.name, resp: co.responsible_user_id, upd: new Date(co.updated_at * 1000).toISOString() })); }
      } catch (e) { console.log("KOMMO УГОДИ:", e.message); }
      try {
        const ev = await kget(`/api/v4/events?filter[type]=entity_responsible_changed&filter[entity]=lead&${ids.slice(0, 10).map((i) => `filter[entity_id][]=${i}`).join("&")}&limit=100`);
        console.log("\n== KOMMO ЗМІНИ ВІДПОВІДАЛЬНОГО");
        for (const e of ev?._embedded?.events ?? []) console.log(J({ lead: e.entity_id, at: new Date(e.created_at * 1000).toISOString(), by: e.created_by, before: e.value_before, after: e.value_after }));
      } catch (e) { console.log("KOMMO ПОДІЇ:", e.message); }
    }
  } finally { await c.query("ROLLBACK"); await c.end(); }
})().catch((e) => { console.error("ПОМИЛКА", e.message); process.exit(1); });
