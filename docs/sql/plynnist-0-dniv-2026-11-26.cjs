// Замір 26.11.2026 (запит HR: ручна корекція звільнених у «Плинності»). ЛИШЕ ЧИТАННЯ: BEGIN READ ONLY … ROLLBACK.
// Телефонів, дат народження, сум не друкує. Питання: скільки звільнених зі стажем 0-14 днів, звідки вони в реєстрі,
// наскільки вони рухають помісячну плинність, і чи користувались уже «дата невідома — не рахувати в плинності».
// Запуск: cd <repo>/backend && nice -n 20 node /tmp/p.cjs
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require(path.join(process.cwd(), "node_modules", "pg"));
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
// Той самий всесвіт, що churnReport: звільнені з відомою датою (dismiss_date_unknown з датою — поза розрахунком).
const KNOWN = `(SELECT e.*, (e.dismissed_at - e.hired_at) AS tenure FROM employees e
  WHERE NOT (e.dismiss_date_unknown AND e.dismissed_at IS NOT NULL))`;
const Q = {
  "(0) розмір простору": `SELECT COUNT(*)::int AS employees_all,
      COUNT(*) FILTER (WHERE dismissed_at IS NOT NULL)::int AS with_dismissed_at,
      COUNT(*) FILTER (WHERE dismiss_date_unknown)::int AS date_unknown,
      COUNT(*) FILTER (WHERE dismissed_at IS NOT NULL AND hired_at IS NULL)::int AS dismissed_no_hire_date,
      COUNT(*) FILTER (WHERE status = 'finishing')::int AS finishing
    FROM employees`,
  "(1) стаж звільнених, усі роки і з 01.01.2026": `SELECT b AS bucket, COUNT(*)::int AS all_time,
      COUNT(*) FILTER (WHERE dismissed_at >= '2026-01-01')::int AS since_2026,
      COUNT(*) FILTER (WHERE dismissed_at >= '2026-09-01')::int AS since_sep
    FROM (SELECT dismissed_at, CASE WHEN hired_at IS NULL THEN 'z без дати прийому' WHEN tenure < 0 THEN 'a мінус'
        WHEN tenure = 0 THEN 'b 0 дн' WHEN tenure = 1 THEN 'c 1 дн' WHEN tenure <= 3 THEN 'd 2-3 дн' WHEN tenure <= 7 THEN 'e 4-7 дн'
        WHEN tenure <= 14 THEN 'f 8-14 дн' WHEN tenure <= 30 THEN 'g 15-30 дн' WHEN tenure <= 90 THEN 'h 31-90 дн' ELSE 'i >90 дн' END AS b
      FROM ${KNOWN} k WHERE dismissed_at IS NOT NULL) x GROUP BY b ORDER BY b`,
  "(2) поіменно: стаж 0-14 днів, звільнені з 01.01.2026": `SELECT k.id, k.full_name, k.category, k.position, k.source, k.candidate_id,
      to_char(k.hired_at, 'YYYY-MM-DD') AS hired, to_char(k.dismissed_at, 'YYYY-MM-DD') AS dismissed, k.tenure,
      left(COALESCE(o.reason, k.dismiss_reason, ''), 80) AS reason, to_char(k.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS created,
      (SELECT string_agg(DISTINCT h.to_status, ',') FROM hiring_events h WHERE h.candidate_id = k.candidate_id AND h.to_status IS NOT NULL) AS cand_statuses
    FROM ${KNOWN} k LEFT JOIN employee_offboarding o ON o.employee_id = k.id
    WHERE k.dismissed_at >= '2026-01-01' AND k.tenure BETWEEN 0 AND 14 ORDER BY k.dismissed_at, k.full_name`,
  "(3) помісячно з 01.2026: як зараз і без стажу ≤3 / ≤7 днів": `WITH m AS (SELECT generate_series('2026-01-01'::date, '2026-11-01'::date, '1 month')::date AS s),
    mm AS (SELECT s, (s + interval '1 month' - interval '1 day')::date AS e FROM m)
    SELECT to_char(s, 'YYYY-MM') AS month,
      COUNT(*) FILTER (WHERE (hired_at IS NULL OR hired_at <= e) AND (dismissed_at IS NULL OR dismissed_at >= s))::int AS worked,
      COUNT(*) FILTER (WHERE dismissed_at BETWEEN s AND e)::int AS dismissed,
      COUNT(*) FILTER (WHERE dismissed_at BETWEEN s AND e AND tenure <= 3)::int AS d_le3,
      COUNT(*) FILTER (WHERE dismissed_at BETWEEN s AND e AND tenure <= 7)::int AS d_le7,
      round(100.0 * COUNT(*) FILTER (WHERE dismissed_at BETWEEN s AND e)
        / NULLIF(COUNT(*) FILTER (WHERE (hired_at IS NULL OR hired_at <= e) AND (dismissed_at IS NULL OR dismissed_at >= s)), 0), 1) AS turnover_now,
      round(100.0 * COUNT(*) FILTER (WHERE dismissed_at BETWEEN s AND e AND NOT COALESCE(tenure <= 3, false))
        / NULLIF(COUNT(*) FILTER (WHERE (hired_at IS NULL OR hired_at <= e) AND (dismissed_at IS NULL OR dismissed_at >= s) AND NOT COALESCE(tenure <= 3, false)), 0), 1) AS turnover_wo_le3
    FROM mm CROSS JOIN ${KNOWN} k GROUP BY s ORDER BY s`,
  "(4) «дата невідома»: хто, коли, з яким коментарем": `SELECT to_char(a.at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD HH24:MI') AS at, a.actor_user_id, a.target_label,
      a.details->>'unknown' AS unknown, a.details->>'from' AS was, a.details->>'to' AS became, left(a.details->>'comment', 90) AS comment
    FROM access_audit a WHERE a.action IN ('employees.dismiss_date', 'employees.dismiss_start') AND (a.details->>'unknown' = 'true' OR a.details->>'dateUnknown' = 'true')
    ORDER BY a.at`,
  "(5) правки дат через «Змінити» (усі), по авторах": `SELECT a.actor_user_id, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE a.details ? 'hiredTo')::int AS with_hired,
      to_char(min(a.at) AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS first, to_char(max(a.at) AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS last
    FROM access_audit a WHERE a.action = 'employees.dismiss_date' GROUP BY a.actor_user_id ORDER BY n DESC`,
  "(6) хто з ролями hr / admin / opdir / ceo": `SELECT id, COALESCE(NULLIF(full_name, ''), email) AS who, COALESCE(role_override, role) AS role, is_active
    FROM users WHERE COALESCE(role_override, role) IN ('hr', 'admin', 'opdir', 'ceo') ORDER BY role, id`,
};
const show = (t, rows) => { console.log(`\n── ${t} (${rows.length})`); if (rows[0]) console.log("  " + Object.keys(rows[0]).join(" | "));
  for (const r of rows) console.log("  " + Object.values(r).join(" | ")); };
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  try {
    for (const [t, sql] of Object.entries(Q)) {
      await c.query("SAVEPOINT s");
      try { show(t, (await c.query(sql)).rows); await c.query("RELEASE SAVEPOINT s"); }
      catch (e) { console.log(`\n── ${t}: ПОМИЛКА ${e.message}`); await c.query("ROLLBACK TO SAVEPOINT s"); }
    }
  } finally { await c.query("ROLLBACK"); await c.end(); }
})().catch((e) => { console.error("ПОМИЛКА:", e.message); process.exit(1); });
