// Швидкість «Статистик», тред 21.11.2026: ДЕ САМЕ йде час у чотирьох важких запитах ядра. ЛИШЕ ЧИТАННЯ
// (BEGIN READ ONLY … ROLLBACK): EXPLAIN (ANALYZE, BUFFERS) виконує SELECT і нічого не пише. Kommo, задачник і файли не чіпає.
// SQL і параметри зняті з зібраного main a9b14be підміною pool.query (ті самі функції ядра, що кличе /api/statistics/series
// для компанії за 2025-06-01 … 2026-11-21), тож dist на ноуті не потрібен.
// Запуск: cd <repo>/backend && nice -n 20 node /tmp/x.cjs      (потрібні лише node_modules/pg і .env)
// Друкує: розміри трьох таблиць, назви їхніх індексів, час планування й виконання, вузли плану з найбільшим власним часом.
// Умов фільтрів, значень полів і секретів не друкує. Навантаження: чотири запити по черзі, разом до ~20 с.
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require(path.join(process.cwd(), "node_modules", "pg"));
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const Q = {
 "leadTakeSeries company": {
  "text": "SELECT d.kommo_id, d.name, d.manager_id, m.name AS manager, (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) AS team_id, t.name AS team,\n            d.created_at_kommo AS created,\n            (SELECT MIN(e.changed_at) FROM deal_stage_events e\n              WHERE e.kommo_id = d.kommo_id AND e.status_id NOT IN (142, 143) AND e.changed_at >= d.created_at_kommo) AS stage_at,\n            -- Вихідний дзвінок: нотатка Kommo (Ringostat → контакт → угода) або запис Ringostat того самого клієнта.\n            LEAST(d.first_call_out_at,\n              (SELECT MIN(rc.calldate) FROM ringostat_calls rc\n                WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n                  AND rc.call_type IN ('out', 'transitout') AND rc.calldate >= d.created_at_kommo)) AS call_at,\n            d.taken_field_at AS field_at,\n            -- Прийнятий вхідний дзвінок (8705): найперший, що ще тривав у мить створення угоди або почався пізніше.\n            inc.calldate AS in_at, inc.ended AS in_end_at,\n            d.status_id, d.reject_reason, d.client_source, d.utm_campaign\n       FROM deals d\n       LEFT JOIN managers m ON m.id = d.manager_id\n       LEFT JOIN teams t ON t.id = (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END)\n       LEFT JOIN LATERAL (\n         SELECT rc.calldate, rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) AS ended\n           FROM ringostat_calls rc\n          WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n            AND rc.call_type IN ('in', 'transitin') AND rc.billsec >= 10\n            AND rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) >= d.created_at_kommo\n          ORDER BY rc.calldate LIMIT 1) inc ON true\n      WHERE d.pipeline_id = ANY($1) AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date AND ((d.client_source = ANY($4) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.client_source = ANY($5) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.lead_channel = 'leadgen') OR (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472)))\n      ORDER BY d.created_at_kommo",
  "params": [
   [
    8921928,
    7336928,
    8921932,
    155304
   ],
   "2025-06-01",
   "2026-11-21",
   [
    "Дзвінок з uts.ua",
    "uts.ua",
    "Callback з uts.ua"
   ],
   [
    "Дзвінок з yalogist.com.ua",
    "yalogist.com.ua",
    "Callback з yalogist.com.ua"
   ]
  ]
 },
 "dispatchedByLoadBucket company": {
  "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, to_char(date_trunc('month', (d.load_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket, d.price,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id AND m.is_active\n        WHERE d.pipeline_id = ANY($1) AND d.load_at IS NOT NULL AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date <= $4\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, bucket, price,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS (\n       SELECT manager_id, bucket, price, \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'\n    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n    ELSE 'undef'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT f.bucket AS ym, COUNT(*)::int AS deals, COALESCE(SUM(f.price),0) AS revenue,\n       COUNT(*) FILTER (WHERE klass = 'repeat')  AS repeat_c,\n       COUNT(*) FILTER (WHERE klass = 'leadgen') AS leadgen_c,\n       COUNT(*) FILTER (WHERE klass = 'ad')      AS ad_c,\n       COUNT(*) FILTER (WHERE klass = 'elogist') AS elogist_c,\n       COUNT(*) FILTER (WHERE klass = 'undef')   AS undef_c\n       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active\n      GROUP BY f.bucket ORDER BY f.bucket",
  "params": [
   [
    8921932,
    155304
   ],
   [
    "названиенеуказано",
    "companynamenotspecified",
    ""
   ],
   "2025-06-01",
   "2026-11-21"
  ]
 },
 "createdSplitByBucket company": {
  "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, to_char(date_trunc('month', (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv'))::date, 'YYYY-MM-DD') AS bucket,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id \n        WHERE d.pipeline_id = ANY($1) AND d.created_at_kommo IS NOT NULL AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $4\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, bucket,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS (\n       SELECT manager_id, bucket, \n  CASE\n    WHEN vkey IS NULL THEN\n      CASE WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n           WHEN sales_channel = 'Нові клієнти' THEN 'new'\n           ELSE 'undef' END\n    WHEN has_prior THEN 'repeat'\n    ELSE 'new'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT bucket,\n            COUNT(*) AS created,\n            COUNT(*) FILTER (WHERE klass = 'new') AS new_count,\n            COUNT(*) FILTER (WHERE klass = 'repeat') AS repeat_count,\n            COUNT(*) FILTER (WHERE klass = 'undef') AS undef_count,\n            COUNT(*) FILTER (WHERE source = 'ad') AS ad_count,\n            COUNT(*) FILTER (WHERE source = 'leadgen') AS leadgen_count,\n            COUNT(*) FILTER (WHERE source = 'elogist') AS elogist_count,\n            COUNT(*) FILTER (WHERE source = 'linkedin') AS linkedin_count,\n            COUNT(*) FILTER (WHERE source = 'prozorro') AS prozorro_count,\n            COUNT(*) FILTER (WHERE source = 'other') AS other_count,\n            COUNT(*) FILTER (WHERE source = 'undef') AS no_channel_count\n       FROM final\n      GROUP BY bucket ORDER BY bucket",
  "params": [
   [
    8921932,
    155304
   ],
   [
    "названиенеуказано",
    "companynamenotspecified",
    ""
   ],
   "2025-06-01",
   "2026-11-21"
  ]
 },
 "repeatClientsByBucket company": {
  "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, to_char(date_trunc('month', (d.load_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket, d.price,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id AND m.is_active\n        WHERE d.pipeline_id = ANY($1) AND d.load_at IS NOT NULL AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date <= $4\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, bucket, price,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS (\n       SELECT manager_id, bucket, price, vkey, \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'\n    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n    ELSE 'undef'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT f.bucket, COUNT(DISTINCT f.vkey)::int AS active, COUNT(*)::int AS cars, COALESCE(SUM(f.price),0) AS revenue\n       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active\n      WHERE f.klass = 'repeat' GROUP BY f.bucket ORDER BY f.bucket",
  "params": [
   [
    8921932,
    155304
   ],
   [
    "названиенеуказано",
    "companynamenotspecified",
    ""
   ],
   "2025-06-01",
   "2026-11-21"
  ]
 }
};

/** Власний час вузла = (його час × цикли) − час дітей. Сума власних часів ≈ час запиту. */
function flatten(node, out, depth, parentRel) {
  const loops = node["Actual Loops"] ?? 1;
  const total = (node["Actual Total Time"] ?? 0) * loops;
  const kids = node.Plans ?? [];
  const kidsTotal = kids.reduce((s, k) => s + (k["Actual Total Time"] ?? 0) * (k["Actual Loops"] ?? 1), 0);
  out.push({
    self: Math.max(0, total - kidsTotal), total, loops, rows: node["Actual Rows"] ?? 0, depth,
    what: [node["Node Type"], node["Relation Name"] && `on ${node["Relation Name"]}`, node["Index Name"] && `using ${node["Index Name"]}`,
      node["Subplan Name"] && `[${node["Subplan Name"]}]`, node["Parent Relationship"] === "SubPlan" && !node["Subplan Name"] && "[SubPlan]",
      node["CTE Name"] && `cte ${node["CTE Name"]}`, node["Join Type"] && `${node["Join Type"]} join`].filter(Boolean).join(" "),
    removed: (node["Rows Removed by Filter"] ?? 0) * loops,
    read: node["Shared Read Blocks"] ?? 0, hit: node["Shared Hit Blocks"] ?? 0,
  });
  for (const k of kids) flatten(k, out, depth + 1, node["Relation Name"]);
}
const ms = (x) => (Math.round(x * 10) / 10).toString().padStart(9);
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  await c.query("SET LOCAL statement_timeout = '120s'");
  try {
    const sz = await c.query(`SELECT relname, n_live_tup::bigint AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
                                FROM pg_stat_user_tables WHERE relname IN ('deals','deal_stage_events','ringostat_calls','managers') ORDER BY relname`);
    console.log("── ТАБЛИЦІ"); for (const r of sz.rows) console.log(`  ${r.relname}: ${r.rows} рядків, ${r.size}`);
    const ix = await c.query(`SELECT tablename, indexname FROM pg_indexes WHERE tablename IN ('deals','deal_stage_events','ringostat_calls') ORDER BY 1, 2`);
    console.log("── ІНДЕКСИ (" + ix.rows.length + ")");
    for (const t of ["deals", "deal_stage_events", "ringostat_calls"]) console.log(`  ${t}: ${ix.rows.filter((r) => r.tablename === t).map((r) => r.indexname).join(", ")}`);
    const ver = await c.query("SELECT current_setting('server_version') AS v, current_setting('work_mem') AS wm, current_setting('max_parallel_workers_per_gather') AS par");
    console.log(`── СЕРВЕР: Postgres ${ver.rows[0].v}, work_mem ${ver.rows[0].wm}, паралельних воркерів ${ver.rows[0].par}`);
    for (const [name, q] of Object.entries(Q)) {
      const t0 = Date.now();
      try {
        const r = await c.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + q.text, q.params);
        const top = r.rows[0]["QUERY PLAN"][0];
        const nodes = []; flatten(top.Plan, nodes, 0, null);
        console.log(`\n── ${name}: виконання ${Math.round(top["Execution Time"])} мс, планування ${Math.round(top["Planning Time"])} мс, з клієнта ${Date.now() - t0} мс, рядків на виході ${top.Plan["Actual Rows"]}, вузлів ${nodes.length}`);
        console.log("     власний мс |    цикли |    рядків | відкинуто | блоків з диска | вузол");
        for (const n of nodes.sort((a, b) => b.self - a.self).slice(0, 12))
          console.log(`  ${ms(n.self)} | ${String(n.loops).padStart(8)} | ${String(n.rows).padStart(9)} | ${String(n.removed).padStart(9)} | ${String(n.read).padStart(14)} | ${"·".repeat(Math.min(n.depth, 12))}${n.what}`);
      } catch (e) { console.log(`\n── ${name}: ПОМИЛКА ${e.message}`); }
    }
  } finally { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
})().catch((e) => { console.error("ПОМИЛКА:", e.message); process.exit(1); });
