// Read-only замір: чи працює відсів «Дзвінки на мобільні» зараз (19.11.2026). Нічого не пише.
// Запуск: cd backend && nice -n 20 node /tmp/cf.cjs
const fs = require("fs"); const path = require("path");
const { Client } = require(path.resolve("node_modules/pg"));
const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));
const Q = {
  jobs: `SELECT name, last_success_at AT TIME ZONE 'Europe/Kyiv' AS ok_kyiv, round(extract(epoch FROM now()-last_success_at)/60) AS ok_min_ago,
           last_error_at AT TIME ZONE 'Europe/Kyiv' AS err_kyiv, left(last_error,160) AS err, consecutive_skips, last_skip_reason
           FROM job_runs WHERE name ILIKE '%carrier%' OR name ILIKE '%call%' OR name = 'syncKommo' ORDER BY name`,
  now: `SELECT now() AT TIME ZONE 'Europe/Kyiv' AS kyiv_now`,
  dealsByDay: `SELECT (deal_created_at AT TIME ZONE 'Europe/Kyiv')::date AS day, count(*) AS n,
           count(*) FILTER (WHERE state='own') AS own, count(*) FILTER (WHERE state='reused') AS reused,
           count(*) FILTER (WHERE state='waiting') AS waiting, count(*) FILTER (WHERE state='no_talk') AS no_talk,
           count(*) FILTER (WHERE state='history') AS history, count(*) FILTER (WHERE state='lardi') AS lardi
           FROM carrier_call_deals WHERE deal_created_at >= now() - interval '8 days' GROUP BY 1 ORDER BY 1`,
  lastSeen: `SELECT max(seen_at) AT TIME ZONE 'Europe/Kyiv' AS last_seen, max(updated_at) AT TIME ZONE 'Europe/Kyiv' AS last_upd,
           round(extract(epoch FROM now()-max(seen_at))/60) AS seen_min_ago FROM carrier_call_deals`,
  analysesByDay: `SELECT (a.updated_at AT TIME ZONE 'Europe/Kyiv')::date AS day, a.status, count(*) AS n
           FROM call_analyses a WHERE a.rubric_version IN ('carrier-v2','carrier-v1') AND a.updated_at >= now() - interval '8 days'
           GROUP BY 1,2 ORDER BY 1,2`,
  transcriptsStuck: `SELECT t.status, count(*) AS n, max(t.updated_at) AT TIME ZONE 'Europe/Kyiv' AS last_upd
           FROM call_transcripts t JOIN carrier_call_deals d ON d.uniqueid = t.uniqueid
           WHERE d.deal_created_at >= now() - interval '3 days' GROUP BY 1 ORDER BY 1`,
  verdicts: `SELECT COALESCE(a.result->>'caller_role', a.result->>'verdict') AS role,
           CASE WHEN COALESCE(a.result->>'caller_role_confidence', a.result->>'confidence')::numeric >= 0.9 THEN '>=90'
                WHEN COALESCE(a.result->>'caller_role_confidence', a.result->>'confidence')::numeric >= 0.85 THEN '85-90' ELSE '<85' END AS band,
           COALESCE(a.result->>'quote_check','?') AS quote, count(*) AS n
           FROM call_analyses a WHERE a.rubric_version = 'carrier-v2' AND a.status = 'done' AND a.updated_at >= '2026-11-17'
           GROUP BY 1,2,3 ORDER BY 1,2,3`,
  closes: `SELECT (decided_at AT TIME ZONE 'Europe/Kyiv')::date AS day, reason, mode, count(*) AS n,
           count(*) FILTER (WHERE closed_at IS NOT NULL) AS closed, count(*) FILTER (WHERE close_error IS NOT NULL) AS err,
           count(*) FILTER (WHERE reverted_at IS NOT NULL) AS reverted
           FROM carrier_close_log WHERE decided_at >= now() - interval '8 days' GROUP BY 1,2,3 ORDER BY 1,2,3`,
  closeLast: `SELECT max(decided_at) AT TIME ZONE 'Europe/Kyiv' AS last_decided, max(closed_at) AT TIME ZONE 'Europe/Kyiv' AS last_closed FROM carrier_close_log`,
  closeErrors: `SELECT left(close_error,140) AS err, count(*) AS n FROM carrier_close_log WHERE close_error IS NOT NULL AND decided_at >= now() - interval '8 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
  moves: `SELECT (decided_at AT TIME ZONE 'Europe/Kyiv')::date AS day, mode, count(*) AS n, count(*) FILTER (WHERE moved_at IS NOT NULL) AS moved,
           count(*) FILTER (WHERE move_error IS NOT NULL) AS err, count(*) FILTER (WHERE reverted_at IS NOT NULL) AS reverted
           FROM carrier_client_moves WHERE decided_at >= now() - interval '8 days' GROUP BY 1,2 ORDER BY 1,2`,
  decisions: `SELECT (decided_at AT TIME ZONE 'Europe/Kyiv')::date AS day, decision, count(*) AS n,
           count(*) FILTER (WHERE ai_role IS NOT NULL AND ai_role <> decision) AS vs_ai_differs
           FROM carrier_decisions WHERE decided_at >= now() - interval '8 days' GROUP BY 1,2 ORDER BY 1,2`,
  onStageNow: `SELECT count(*) AS on_stage_now_in_deals_table, max(updated_at_kommo) AT TIME ZONE 'Europe/Kyiv' AS deals_last_kommo_upd
           FROM deals WHERE pipeline_id = 8921928 AND status_id = 70419108`,
};
(async () => {
  const c = new Client({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_URL.includes("sslmode") ? undefined : { rejectUnauthorized: false } });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  for (const [k, sql] of Object.entries(Q)) {
    await c.query("SAVEPOINT s");
    try { const r = await c.query(sql); console.log(`\n== ${k} (${r.rowCount})`); console.table(r.rows); }
    catch (e) { console.log(`\n== ${k} ПОМИЛКА: ${e.message}`); await c.query("ROLLBACK TO SAVEPOINT s"); }
  }
  await c.query("ROLLBACK"); await c.end();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
