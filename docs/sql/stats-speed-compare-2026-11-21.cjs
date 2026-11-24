// Швидкість «Статистик», тред 21.11.2026, прохід 2: СТАРИЙ запит проти НОВОГО на тих самих даних. ЛИШЕ ЧИТАННЯ.
// Усе йде в ОДНІЙ транзакції `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY … ROLLBACK`: обидва боки кожного порівняння
// бачать один знімок бази, тож різниця може бути лише від запиту, а не від синку між двома викликами. Kommo, задачник,
// файли не чіпає; нічого не пише.
// Що порівнює:
//   А. Вісім запитів ядра з класом угоди («клієнт уже був»): СТАРИЙ (`final AS (`, як на проді зараз) і НОВИЙ
//      (`final AS MATERIALIZED (`) — рядок у рядок, плюс час кожного. Серед них три запити Звіту, які читають те саме ядро.
//   Б. «Час опрацювання заявки»: заявки компанії з team_id команди проти окремої вибірки цієї команди — ті самі угоди
//      і ті самі поля взяття. Новий код бере розріз із заявок компанії; тут доводиться, що це та сама множина.
// SQL і параметри зняті з зібраної гілки підміною pool.query (ті самі функції ядра), тож dist на ноуті не потрібен.
// Запуск: cd <repo>/backend && nice -n 20 node /tmp/y.cjs      (потрібні лише node_modules/pg і .env)
// Друкує: назву порівняння, «однаково: так / НІ», кількість рядків і час. Значень полів, умов і секретів не друкує.
// Навантаження: 16 + 7 запитів ПО ЧЕРЗІ, разом до ~1 хв.
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require(path.join(process.cwd(), "node_modules", "pg"));
for (const l of (fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const Q = {
 "classify": [
  {
   "name": "Поставлені / відправлені авто, компанія, по місяцях",
   "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, to_char(date_trunc('month', (d.load_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket, d.price,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id AND m.is_active\n        WHERE d.pipeline_id = ANY($1) AND d.load_at IS NOT NULL AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date <= $4\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, bucket, price,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS MATERIALIZED (\n       SELECT manager_id, bucket, price, \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'\n    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n    ELSE 'undef'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT f.bucket AS ym, COUNT(*)::int AS deals, COALESCE(SUM(f.price),0) AS revenue,\n       COUNT(*) FILTER (WHERE klass = 'repeat')  AS repeat_c,\n       COUNT(*) FILTER (WHERE klass = 'leadgen') AS leadgen_c,\n       COUNT(*) FILTER (WHERE klass = 'ad')      AS ad_c,\n       COUNT(*) FILTER (WHERE klass = 'elogist') AS elogist_c,\n       COUNT(*) FILTER (WHERE klass = 'undef')   AS undef_c\n       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active\n      GROUP BY f.bucket ORDER BY f.bucket",
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
  {
   "name": "Поставлені, одна команда, по тижнях",
   "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, to_char(date_trunc('week', (d.load_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket, d.price,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id AND m.is_active\n        WHERE d.pipeline_id = ANY($1) AND d.load_at IS NOT NULL AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date <= $4 AND ((m.team_id = $5 OR m.id IN (SELECT mv1.manager_id FROM manager_team_moves mv1)) AND (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.load_at AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.load_at AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) IS NOT DISTINCT FROM $5)\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, bucket, price,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS MATERIALIZED (\n       SELECT manager_id, bucket, price, \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'\n    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n    ELSE 'undef'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT f.bucket AS ym, COUNT(*)::int AS deals, COALESCE(SUM(f.price),0) AS revenue,\n       COUNT(*) FILTER (WHERE klass = 'repeat')  AS repeat_c,\n       COUNT(*) FILTER (WHERE klass = 'leadgen') AS leadgen_c,\n       COUNT(*) FILTER (WHERE klass = 'ad')      AS ad_c,\n       COUNT(*) FILTER (WHERE klass = 'elogist') AS elogist_c,\n       COUNT(*) FILTER (WHERE klass = 'undef')   AS undef_c\n       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active\n      GROUP BY f.bucket ORDER BY f.bucket",
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
    "2026-11-21",
    13
   ]
  },
  {
   "name": "Створені (Prozorro / LinkedIn), компанія, по місяцях",
   "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, to_char(date_trunc('month', (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv'))::date, 'YYYY-MM-DD') AS bucket,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id \n        WHERE d.pipeline_id = ANY($1) AND d.created_at_kommo IS NOT NULL AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $4\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, bucket,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS MATERIALIZED (\n       SELECT manager_id, bucket, \n  CASE\n    WHEN vkey IS NULL THEN\n      CASE WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n           WHEN sales_channel = 'Нові клієнти' THEN 'new'\n           ELSE 'undef' END\n    WHEN has_prior THEN 'repeat'\n    ELSE 'new'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT bucket,\n            COUNT(*) AS created,\n            COUNT(*) FILTER (WHERE klass = 'new') AS new_count,\n            COUNT(*) FILTER (WHERE klass = 'repeat') AS repeat_count,\n            COUNT(*) FILTER (WHERE klass = 'undef') AS undef_count,\n            COUNT(*) FILTER (WHERE source = 'ad') AS ad_count,\n            COUNT(*) FILTER (WHERE source = 'leadgen') AS leadgen_count,\n            COUNT(*) FILTER (WHERE source = 'elogist') AS elogist_count,\n            COUNT(*) FILTER (WHERE source = 'linkedin') AS linkedin_count,\n            COUNT(*) FILTER (WHERE source = 'prozorro') AS prozorro_count,\n            COUNT(*) FILTER (WHERE source = 'other') AS other_count,\n            COUNT(*) FILTER (WHERE source = 'undef') AS no_channel_count\n       FROM final\n      GROUP BY bucket ORDER BY bucket",
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
  {
   "name": "Створені, одна команда, по тижнях",
   "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, to_char(date_trunc('week', (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv'))::date, 'YYYY-MM-DD') AS bucket,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id \n        WHERE d.pipeline_id = ANY($1) AND d.created_at_kommo IS NOT NULL AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $4 AND ((m.team_id = $5 OR m.id IN (SELECT mv1.manager_id FROM manager_team_moves mv1)) AND (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) IS NOT DISTINCT FROM $5)\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, bucket,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS MATERIALIZED (\n       SELECT manager_id, bucket, \n  CASE\n    WHEN vkey IS NULL THEN\n      CASE WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n           WHEN sales_channel = 'Нові клієнти' THEN 'new'\n           ELSE 'undef' END\n    WHEN has_prior THEN 'repeat'\n    ELSE 'new'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT bucket,\n            COUNT(*) AS created,\n            COUNT(*) FILTER (WHERE klass = 'new') AS new_count,\n            COUNT(*) FILTER (WHERE klass = 'repeat') AS repeat_count,\n            COUNT(*) FILTER (WHERE klass = 'undef') AS undef_count,\n            COUNT(*) FILTER (WHERE source = 'ad') AS ad_count,\n            COUNT(*) FILTER (WHERE source = 'leadgen') AS leadgen_count,\n            COUNT(*) FILTER (WHERE source = 'elogist') AS elogist_count,\n            COUNT(*) FILTER (WHERE source = 'linkedin') AS linkedin_count,\n            COUNT(*) FILTER (WHERE source = 'prozorro') AS prozorro_count,\n            COUNT(*) FILTER (WHERE source = 'other') AS other_count,\n            COUNT(*) FILTER (WHERE source = 'undef') AS no_channel_count\n       FROM final\n      GROUP BY bucket ORDER BY bucket",
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
    "2026-11-21",
    13
   ]
  },
  {
   "name": "Постійні клієнти, компанія, по місяцях",
   "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, to_char(date_trunc('month', (d.load_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket, d.price,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id AND m.is_active\n        WHERE d.pipeline_id = ANY($1) AND d.load_at IS NOT NULL AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date <= $4\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, bucket, price,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS MATERIALIZED (\n       SELECT manager_id, bucket, price, vkey, \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'\n    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n    ELSE 'undef'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT f.bucket, COUNT(DISTINCT f.vkey)::int AS active, COUNT(*)::int AS cars, COALESCE(SUM(f.price),0) AS revenue\n       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active\n      WHERE f.klass = 'repeat' GROUP BY f.bucket ORDER BY f.bucket",
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
  {
   "name": "Звіт: створені по менеджерах, поточний місяць",
   "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id \n        WHERE d.pipeline_id = ANY($1) AND d.created_at_kommo IS NOT NULL AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $4\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS MATERIALIZED (\n       SELECT manager_id, \n  CASE\n    WHEN vkey IS NULL THEN\n      CASE WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n           WHEN sales_channel = 'Нові клієнти' THEN 'new'\n           ELSE 'undef' END\n    WHEN has_prior THEN 'repeat'\n    ELSE 'new'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT m.id AS manager_id, m.name, m.team_id,\n            COUNT(*) AS created,\n            COUNT(*) FILTER (WHERE klass = 'new') AS new_count,\n            COUNT(*) FILTER (WHERE klass = 'repeat') AS repeat_count,\n            COUNT(*) FILTER (WHERE klass = 'undef') AS undef_count,\n            COUNT(*) FILTER (WHERE source = 'ad') AS ad_count,\n            COUNT(*) FILTER (WHERE source = 'leadgen') AS leadgen_count,\n            COUNT(*) FILTER (WHERE source = 'elogist') AS elogist_count,\n            COUNT(*) FILTER (WHERE source = 'linkedin') AS linkedin_count,\n            COUNT(*) FILTER (WHERE source = 'prozorro') AS prozorro_count,\n            COUNT(*) FILTER (WHERE source = 'other') AS other_count,\n            COUNT(*) FILTER (WHERE source = 'undef') AS no_channel_count,\n            COUNT(*) FILTER (WHERE klass = 'new' AND source = 'ad') AS new_ad,\n            COUNT(*) FILTER (WHERE klass = 'new' AND source = 'leadgen') AS new_lg,\n            COUNT(*) FILTER (WHERE klass = 'new' AND source = 'elogist') AS new_el,\n            COUNT(*) FILTER (WHERE klass = 'new' AND source = 'linkedin') AS new_li,\n            COUNT(*) FILTER (WHERE klass = 'new' AND source = 'prozorro') AS new_pz,\n            COUNT(*) FILTER (WHERE klass = 'new' AND source = 'other') AS new_oth,\n            COUNT(*) FILTER (WHERE klass = 'new' AND source = 'undef') AS new_nch,\n            COUNT(*) FILTER (WHERE klass = 'repeat' AND source = 'ad') AS repeat_ad,\n            COUNT(*) FILTER (WHERE klass = 'repeat' AND source = 'leadgen') AS repeat_lg,\n            COUNT(*) FILTER (WHERE klass = 'repeat' AND source = 'elogist') AS repeat_el,\n            COUNT(*) FILTER (WHERE klass = 'repeat' AND source = 'linkedin') AS repeat_li,\n            COUNT(*) FILTER (WHERE klass = 'repeat' AND source = 'prozorro') AS repeat_pz,\n            COUNT(*) FILTER (WHERE klass = 'repeat' AND source = 'other') AS repeat_oth,\n            COUNT(*) FILTER (WHERE klass = 'repeat' AND source = 'undef') AS repeat_nch,\n            COUNT(*) FILTER (WHERE klass = 'undef' AND source = 'ad') AS undef_ad,\n            COUNT(*) FILTER (WHERE klass = 'undef' AND source = 'leadgen') AS undef_lg,\n            COUNT(*) FILTER (WHERE klass = 'undef' AND source = 'elogist') AS undef_el,\n            COUNT(*) FILTER (WHERE klass = 'undef' AND source = 'linkedin') AS undef_li,\n            COUNT(*) FILTER (WHERE klass = 'undef' AND source = 'prozorro') AS undef_pz,\n            COUNT(*) FILTER (WHERE klass = 'undef' AND source = 'other') AS undef_oth,\n            COUNT(*) FILTER (WHERE klass = 'undef' AND source = 'undef') AS undef_nch\n       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active\n      GROUP BY m.id, m.name, m.team_id\n      ORDER BY created DESC",
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
    "2026-11-01",
    "2026-11-21"
   ]
  },
  {
   "name": "Звіт: відправлені авто по менеджерах, поточний місяць",
   "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, d.price,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id \n        WHERE d.pipeline_id = ANY($1) AND d.load_at IS NOT NULL AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date <= $4\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, price,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS MATERIALIZED (\n       SELECT manager_id, price, \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'\n    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n    ELSE 'undef'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT f.manager_id, COUNT(*) deals, COALESCE(SUM(f.price),0) revenue,\n       COUNT(*) FILTER (WHERE klass = 'repeat')  AS repeat_c,\n       COUNT(*) FILTER (WHERE klass = 'leadgen') AS leadgen_c,\n       COUNT(*) FILTER (WHERE klass = 'ad')      AS ad_c,\n       COUNT(*) FILTER (WHERE klass = 'elogist') AS elogist_c,\n       COUNT(*) FILTER (WHERE klass = 'undef')   AS undef_c\n       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active\n      GROUP BY f.manager_id",
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
    "2026-11-01",
    "2026-11-21"
   ]
  },
  {
   "name": "Звіт: відправлені авто по менеджерах і днях, поточний місяць",
   "text": "WITH base AS (\n       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel, to_char(date_trunc('day', (d.load_at AT TIME ZONE 'Europe/Kyiv'))::date, 'YYYY-MM-DD') AS bucket, d.price,\n              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey,\n              (COALESCE(btrim(d.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags, '{}'::text[]))) AS is_li, (COALESCE(btrim(d.client_source), '') = 'AI тендер' OR COALESCE(d.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]) AS is_pz\n         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id \n        WHERE d.pipeline_id = ANY($1) AND d.load_at IS NOT NULL AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date >= $3 AND (d.load_at AT TIME ZONE 'Europe/Kyiv')::date <= $4\n     ),\n     classed AS (\n       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.is_li, b.is_pz, bucket, price,\n              (b.vkey IS NOT NULL AND (\n        EXISTS (SELECT 1 FROM deals pw\n                 WHERE pw.client_key = b.vkey AND pw.kommo_id <> b.kommo_id\n                   AND pw.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[])\n                   AND ((pw.status_id = 142 AND pw.closed_at_kommo < b.created_at_kommo)\n                     OR (pw.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                         AND COALESCE(pw.closed_at_kommo, pw.created_at_kommo) < b.created_at_kommo)))\n     OR EXISTS (SELECT 1 FROM deal_stage_events pe\n                  JOIN deals pd ON pd.kommo_id = pe.kommo_id\n                 WHERE pd.client_key = b.vkey AND pd.kommo_id <> b.kommo_id\n                   AND pe.pipeline_id = ANY(ARRAY[8921932,155304]::bigint[]) AND pe.status_id = ANY(ARRAY[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068,69716460,60412544,142]::bigint[])\n                   AND pe.changed_at < b.created_at_kommo)\n  )) AS has_prior\n         FROM base b\n     ),\n     final AS MATERIALIZED (\n       SELECT manager_id, bucket, price, \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'\n    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'\n    ELSE 'undef'\n  END AS klass,\n              \n  CASE\n    WHEN lead_channel = 'ad' THEN 'ad'\n    WHEN lead_channel = 'leadgen' THEN 'leadgen'\n    WHEN lead_channel = 'elogist' THEN 'elogist'\n    WHEN lead_channel IS NULL THEN 'undef'\n    WHEN is_li THEN 'linkedin'\n    WHEN is_pz THEN 'prozorro'\n    ELSE 'other'\n  END AS source\n         FROM classed\n     )\n     SELECT f.manager_id, f.bucket, COUNT(*) deals, COALESCE(SUM(f.price),0) revenue,\n       COUNT(*) FILTER (WHERE klass = 'repeat')  AS repeat_c,\n       COUNT(*) FILTER (WHERE klass = 'leadgen') AS leadgen_c,\n       COUNT(*) FILTER (WHERE klass = 'ad')      AS ad_c,\n       COUNT(*) FILTER (WHERE klass = 'elogist') AS elogist_c,\n       COUNT(*) FILTER (WHERE klass = 'undef')   AS undef_c\n       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active\n      GROUP BY f.manager_id, f.bucket ORDER BY f.bucket",
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
    "2026-11-01",
    "2026-11-21"
   ]
  }
 ],
 "lead": [
  {
   "name": "компанія",
   "teamId": null,
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
  {
   "name": "команда 13",
   "teamId": 13,
   "text": "SELECT d.kommo_id, d.name, d.manager_id, m.name AS manager, (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) AS team_id, t.name AS team,\n            d.created_at_kommo AS created,\n            (SELECT MIN(e.changed_at) FROM deal_stage_events e\n              WHERE e.kommo_id = d.kommo_id AND e.status_id NOT IN (142, 143) AND e.changed_at >= d.created_at_kommo) AS stage_at,\n            -- Вихідний дзвінок: нотатка Kommo (Ringostat → контакт → угода) або запис Ringostat того самого клієнта.\n            LEAST(d.first_call_out_at,\n              (SELECT MIN(rc.calldate) FROM ringostat_calls rc\n                WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n                  AND rc.call_type IN ('out', 'transitout') AND rc.calldate >= d.created_at_kommo)) AS call_at,\n            d.taken_field_at AS field_at,\n            -- Прийнятий вхідний дзвінок (8705): найперший, що ще тривав у мить створення угоди або почався пізніше.\n            inc.calldate AS in_at, inc.ended AS in_end_at,\n            d.status_id, d.reject_reason, d.client_source, d.utm_campaign\n       FROM deals d\n       LEFT JOIN managers m ON m.id = d.manager_id\n       LEFT JOIN teams t ON t.id = (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END)\n       LEFT JOIN LATERAL (\n         SELECT rc.calldate, rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) AS ended\n           FROM ringostat_calls rc\n          WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n            AND rc.call_type IN ('in', 'transitin') AND rc.billsec >= 10\n            AND rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) >= d.created_at_kommo\n          ORDER BY rc.calldate LIMIT 1) inc ON true\n      WHERE d.pipeline_id = ANY($1) AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date AND ((d.client_source = ANY($4) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.client_source = ANY($5) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.lead_channel = 'leadgen') OR (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) AND (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) IS NOT DISTINCT FROM $6\n      ORDER BY d.created_at_kommo",
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
    ],
    13
   ]
  },
  {
   "name": "команда 5",
   "teamId": 5,
   "text": "SELECT d.kommo_id, d.name, d.manager_id, m.name AS manager, (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) AS team_id, t.name AS team,\n            d.created_at_kommo AS created,\n            (SELECT MIN(e.changed_at) FROM deal_stage_events e\n              WHERE e.kommo_id = d.kommo_id AND e.status_id NOT IN (142, 143) AND e.changed_at >= d.created_at_kommo) AS stage_at,\n            -- Вихідний дзвінок: нотатка Kommo (Ringostat → контакт → угода) або запис Ringostat того самого клієнта.\n            LEAST(d.first_call_out_at,\n              (SELECT MIN(rc.calldate) FROM ringostat_calls rc\n                WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n                  AND rc.call_type IN ('out', 'transitout') AND rc.calldate >= d.created_at_kommo)) AS call_at,\n            d.taken_field_at AS field_at,\n            -- Прийнятий вхідний дзвінок (8705): найперший, що ще тривав у мить створення угоди або почався пізніше.\n            inc.calldate AS in_at, inc.ended AS in_end_at,\n            d.status_id, d.reject_reason, d.client_source, d.utm_campaign\n       FROM deals d\n       LEFT JOIN managers m ON m.id = d.manager_id\n       LEFT JOIN teams t ON t.id = (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END)\n       LEFT JOIN LATERAL (\n         SELECT rc.calldate, rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) AS ended\n           FROM ringostat_calls rc\n          WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n            AND rc.call_type IN ('in', 'transitin') AND rc.billsec >= 10\n            AND rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) >= d.created_at_kommo\n          ORDER BY rc.calldate LIMIT 1) inc ON true\n      WHERE d.pipeline_id = ANY($1) AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date AND ((d.client_source = ANY($4) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.client_source = ANY($5) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.lead_channel = 'leadgen') OR (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) AND (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) IS NOT DISTINCT FROM $6\n      ORDER BY d.created_at_kommo",
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
    ],
    5
   ]
  },
  {
   "name": "команда 6",
   "teamId": 6,
   "text": "SELECT d.kommo_id, d.name, d.manager_id, m.name AS manager, (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) AS team_id, t.name AS team,\n            d.created_at_kommo AS created,\n            (SELECT MIN(e.changed_at) FROM deal_stage_events e\n              WHERE e.kommo_id = d.kommo_id AND e.status_id NOT IN (142, 143) AND e.changed_at >= d.created_at_kommo) AS stage_at,\n            -- Вихідний дзвінок: нотатка Kommo (Ringostat → контакт → угода) або запис Ringostat того самого клієнта.\n            LEAST(d.first_call_out_at,\n              (SELECT MIN(rc.calldate) FROM ringostat_calls rc\n                WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n                  AND rc.call_type IN ('out', 'transitout') AND rc.calldate >= d.created_at_kommo)) AS call_at,\n            d.taken_field_at AS field_at,\n            -- Прийнятий вхідний дзвінок (8705): найперший, що ще тривав у мить створення угоди або почався пізніше.\n            inc.calldate AS in_at, inc.ended AS in_end_at,\n            d.status_id, d.reject_reason, d.client_source, d.utm_campaign\n       FROM deals d\n       LEFT JOIN managers m ON m.id = d.manager_id\n       LEFT JOIN teams t ON t.id = (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END)\n       LEFT JOIN LATERAL (\n         SELECT rc.calldate, rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) AS ended\n           FROM ringostat_calls rc\n          WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n            AND rc.call_type IN ('in', 'transitin') AND rc.billsec >= 10\n            AND rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) >= d.created_at_kommo\n          ORDER BY rc.calldate LIMIT 1) inc ON true\n      WHERE d.pipeline_id = ANY($1) AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date AND ((d.client_source = ANY($4) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.client_source = ANY($5) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.lead_channel = 'leadgen') OR (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) AND (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) IS NOT DISTINCT FROM $6\n      ORDER BY d.created_at_kommo",
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
    ],
    6
   ]
  },
  {
   "name": "команда 36283",
   "teamId": 36283,
   "text": "SELECT d.kommo_id, d.name, d.manager_id, m.name AS manager, (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) AS team_id, t.name AS team,\n            d.created_at_kommo AS created,\n            (SELECT MIN(e.changed_at) FROM deal_stage_events e\n              WHERE e.kommo_id = d.kommo_id AND e.status_id NOT IN (142, 143) AND e.changed_at >= d.created_at_kommo) AS stage_at,\n            -- Вихідний дзвінок: нотатка Kommo (Ringostat → контакт → угода) або запис Ringostat того самого клієнта.\n            LEAST(d.first_call_out_at,\n              (SELECT MIN(rc.calldate) FROM ringostat_calls rc\n                WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n                  AND rc.call_type IN ('out', 'transitout') AND rc.calldate >= d.created_at_kommo)) AS call_at,\n            d.taken_field_at AS field_at,\n            -- Прийнятий вхідний дзвінок (8705): найперший, що ще тривав у мить створення угоди або почався пізніше.\n            inc.calldate AS in_at, inc.ended AS in_end_at,\n            d.status_id, d.reject_reason, d.client_source, d.utm_campaign\n       FROM deals d\n       LEFT JOIN managers m ON m.id = d.manager_id\n       LEFT JOIN teams t ON t.id = (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END)\n       LEFT JOIN LATERAL (\n         SELECT rc.calldate, rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) AS ended\n           FROM ringostat_calls rc\n          WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n            AND rc.call_type IN ('in', 'transitin') AND rc.billsec >= 10\n            AND rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) >= d.created_at_kommo\n          ORDER BY rc.calldate LIMIT 1) inc ON true\n      WHERE d.pipeline_id = ANY($1) AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date AND ((d.client_source = ANY($4) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.client_source = ANY($5) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.lead_channel = 'leadgen') OR (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) AND (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) IS NOT DISTINCT FROM $6\n      ORDER BY d.created_at_kommo",
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
    ],
    36283
   ]
  },
  {
   "name": "команда 15",
   "teamId": 15,
   "text": "SELECT d.kommo_id, d.name, d.manager_id, m.name AS manager, (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) AS team_id, t.name AS team,\n            d.created_at_kommo AS created,\n            (SELECT MIN(e.changed_at) FROM deal_stage_events e\n              WHERE e.kommo_id = d.kommo_id AND e.status_id NOT IN (142, 143) AND e.changed_at >= d.created_at_kommo) AS stage_at,\n            -- Вихідний дзвінок: нотатка Kommo (Ringostat → контакт → угода) або запис Ringostat того самого клієнта.\n            LEAST(d.first_call_out_at,\n              (SELECT MIN(rc.calldate) FROM ringostat_calls rc\n                WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n                  AND rc.call_type IN ('out', 'transitout') AND rc.calldate >= d.created_at_kommo)) AS call_at,\n            d.taken_field_at AS field_at,\n            -- Прийнятий вхідний дзвінок (8705): найперший, що ще тривав у мить створення угоди або почався пізніше.\n            inc.calldate AS in_at, inc.ended AS in_end_at,\n            d.status_id, d.reject_reason, d.client_source, d.utm_campaign\n       FROM deals d\n       LEFT JOIN managers m ON m.id = d.manager_id\n       LEFT JOIN teams t ON t.id = (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END)\n       LEFT JOIN LATERAL (\n         SELECT rc.calldate, rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) AS ended\n           FROM ringostat_calls rc\n          WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n            AND rc.call_type IN ('in', 'transitin') AND rc.billsec >= 10\n            AND rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) >= d.created_at_kommo\n          ORDER BY rc.calldate LIMIT 1) inc ON true\n      WHERE d.pipeline_id = ANY($1) AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date AND ((d.client_source = ANY($4) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.client_source = ANY($5) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.lead_channel = 'leadgen') OR (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) AND (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) IS NOT DISTINCT FROM $6\n      ORDER BY d.created_at_kommo",
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
    ],
    15
   ]
  },
  {
   "name": "команда 14",
   "teamId": 14,
   "text": "SELECT d.kommo_id, d.name, d.manager_id, m.name AS manager, (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) AS team_id, t.name AS team,\n            d.created_at_kommo AS created,\n            (SELECT MIN(e.changed_at) FROM deal_stage_events e\n              WHERE e.kommo_id = d.kommo_id AND e.status_id NOT IN (142, 143) AND e.changed_at >= d.created_at_kommo) AS stage_at,\n            -- Вихідний дзвінок: нотатка Kommo (Ringostat → контакт → угода) або запис Ringostat того самого клієнта.\n            LEAST(d.first_call_out_at,\n              (SELECT MIN(rc.calldate) FROM ringostat_calls rc\n                WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n                  AND rc.call_type IN ('out', 'transitout') AND rc.calldate >= d.created_at_kommo)) AS call_at,\n            d.taken_field_at AS field_at,\n            -- Прийнятий вхідний дзвінок (8705): найперший, що ще тривав у мить створення угоди або почався пізніше.\n            inc.calldate AS in_at, inc.ended AS in_end_at,\n            d.status_id, d.reject_reason, d.client_source, d.utm_campaign\n       FROM deals d\n       LEFT JOIN managers m ON m.id = d.manager_id\n       LEFT JOIN teams t ON t.id = (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END)\n       LEFT JOIN LATERAL (\n         SELECT rc.calldate, rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) AS ended\n           FROM ringostat_calls rc\n          WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key\n            AND rc.call_type IN ('in', 'transitin') AND rc.billsec >= 10\n            AND rc.calldate + make_interval(secs => GREATEST(COALESCE(rc.duration, 0), COALESCE(rc.billsec, 0))) >= d.created_at_kommo\n          ORDER BY rc.calldate LIMIT 1) inc ON true\n      WHERE d.pipeline_id = ANY($1) AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date AND ((d.client_source = ANY($4) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.client_source = ANY($5) AND NOT (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) OR (d.lead_channel = 'leadgen') OR (COALESCE(btrim(d.client_source), '') = 'elogist.com.ua'\n     OR COALESCE(btrim(d.name), '') ~ '^eLogist\\M'\n     OR (d.pipeline_id = ANY(ARRAY[8921928, 7336928]::bigint[]) AND d.status_id = 108581472))) AND (CASE WHEN m.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN m.team_id WHEN EXISTS (SELECT 1 FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date)) THEN (SELECT mv.from_team_id FROM manager_team_moves mv WHERE mv.manager_id = m.id AND mv.effective_from > ((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date) ORDER BY mv.effective_from LIMIT 1) ELSE m.team_id END) IS NOT DISTINCT FROM $6\n      ORDER BY d.created_at_kommo",
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
    ],
    14
   ]
  }
 ]
};
const NEW = "final AS MATERIALIZED (", OLD = "final AS (";
const canon = (rows) => JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  let bad = 0;
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await c.query("SET LOCAL statement_timeout = '120s'");
    const timed = async (text, params) => { const t = Date.now(); const r = await c.query(text, params); return { rows: r.rows, ms: Date.now() - t }; };
    console.log("── А. КЛАС УГОДИ: старий запит проти нового (той самий знімок бази)");
    let sumOld = 0, sumNew = 0;
    for (const q of Q.classify) {
      if (q.text.split(NEW).length !== 2) { console.log(`  ✖ ${q.name}: у запиті немає рівно одного «${NEW}» — порівнювати нема що`); bad++; continue; }
      const oldText = q.text.replace(NEW, OLD);
      // Двічі кожен, беремо другий замір: перший платить за читання з диска, і хто йде першим — той і «повільний».
      await timed(oldText, q.params); await timed(q.text, q.params);
      const a = await timed(oldText, q.params), b = await timed(q.text, q.params);
      const same = canon(a.rows) === canon(b.rows);
      if (!same) bad++;
      if (a.rows.length === 0) { bad++; console.log(`  ✖ ${q.name}: порожньо з обох боків — рівність порожнього нічого не доводить`); continue; }
      sumOld += a.ms; sumNew += b.ms;
      console.log(`  ${same ? "✔" : "✖"} ${q.name}: однаково: ${same ? "так" : "НІ"} · рядків ${a.rows.length} / ${b.rows.length} · було ${a.ms} мс → стало ${b.ms} мс`);
    }
    console.log(`  разом: було ${sumOld} мс → стало ${sumNew} мс`);

    console.log("── Б. ЧАС ОПРАЦЮВАННЯ: розріз команди із заявок компанії проти окремої вибірки команди");
    const pick = (r) => JSON.stringify([String(r.kommo_id), r.manager_id, r.team_id, r.created, r.stage_at, r.call_at, r.field_at, r.in_at, r.in_end_at, String(r.status_id), r.reject_reason]);
    const company = await timed(Q.lead[0].text, Q.lead[0].params);
    console.log(`  компанія: заявок ${company.rows.length} · ${company.ms} мс (новий код робить ЛИШЕ цей запит)`);
    if (company.rows.length === 0) { bad++; console.log("  ✖ заявок компанії нуль — звіряти нема що"); }
    let teamsMs = 0, covered = 0;
    for (const q of Q.lead.slice(1)) {
      const t = await timed(q.text, q.params);
      teamsMs += t.ms;
      const fromCompany = company.rows.filter((r) => r.team_id === q.teamId).map(pick).sort();
      const own = t.rows.map(pick).sort();
      const same = JSON.stringify(fromCompany) === JSON.stringify(own);
      if (!same) bad++;
      covered += own.length;
      console.log(`  ${same ? "✔" : "✖"} ${q.name}: однаково: ${same ? "так" : "НІ"} · заявок ${fromCompany.length} / ${own.length} · окрема вибірка ${t.ms} мс`);
    }
    if (covered === 0) { bad++; console.log("  ✖ у жодної команди немає заявок — рівність порожнього нічого не доводить"); }
    console.log(`  старий код: компанія + ${Q.lead.length - 1} команд = ${company.ms + teamsMs} мс по черзі (на сервері вони йшли паралельно й заважали одна одній)`);
    const idx = await c.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_rc_client_out'");
    console.log(`── індекс idx_rc_client_out: ${idx.rowCount ? "є" : "ще немає (зʼявиться з міграцією викату)"}`);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
  console.log(bad ? `🔴 РОЗБІЖНОСТЕЙ: ${bad}` : "✅ усі порівняння однакові");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("ПОМИЛКА:", String(e).slice(0, 400)); process.exit(2); });
