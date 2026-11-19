// Замір «дзвінки з сайту»: чи несуть utm, на які наші номери дзвонять, скільки — від тих, хто вже був клієнтом. READ ONLY.
// Запуск НА СЕРВЕРІ в бойовому докруті (stdin, файлів не лишає):
//   cd ~/uts.ua/dashboard/backend && set -a && . ./.env && set +a && PGOPTIONS='-c default_transaction_read_only=on' nice -n 20 node --input-type=module - < m.mjs
// Звʼязка угода → дзвінок: вхідний дзвінок (in/transitin) у вікні [створення − 2 год, створення + 15 хв], трьома шляхами,
// як у фактах дзвінків (`core/adCallFactsRules.ts`): номер = ключ клієнта · ключ клієнта дзвінка · телефони контактів угоди.
if (!/default_transaction_read_only=on/.test(process.env.PGOPTIONS ?? "")) throw new Error("без PGOPTIONS read-only не запускаю");
const { pool } = await import(process.cwd() + "/dist/db/pool.js");
const { AD_CLIENTS_SQL } = await import(process.cwd() + "/dist/core/adClients.js");
const { kyivToday } = await import(process.cwd() + "/dist/core/dates.js");

const SITE = ["Дзвінок з uts.ua", "Callback з uts.ua", "uts.ua", "Дзвінок з yalogist.com.ua", "Callback з yalogist.com.ua", "yalogist.com.ua"];
const FROM = "2026-01-01";

const DEALS_CTE = (where) => `
  d0 AS (
    SELECT d.kommo_id, d.client_key, d.client_source, d.created_at_kommo AS created_at,
           (d.utm_source IS NOT NULL OR d.utm_medium IS NOT NULL OR d.utm_campaign IS NOT NULL OR COALESCE(d.traf_type,'') = 'cpc') AS deal_tag
      FROM deals d WHERE ${where}
  ),
  lc AS (
    SELECT d0.kommo_id, rc.* FROM d0 JOIN ringostat_calls rc ON d0.client_key ~ '^[0-9]{10}$' AND rc.client_phone = '38' || d0.client_key
       AND rc.call_type IN ('in','transitin') AND rc.calldate BETWEEN d0.created_at - interval '2 hours' AND d0.created_at + interval '15 minutes'
    UNION
    SELECT d0.kommo_id, rc.* FROM d0 JOIN ringostat_calls rc ON d0.client_key IS NOT NULL AND rc.client_key = d0.client_key
       AND rc.call_type IN ('in','transitin') AND rc.calldate BETWEEN d0.created_at - interval '2 hours' AND d0.created_at + interval '15 minutes'
    UNION
    SELECT d0.kommo_id, rc.* FROM d0 JOIN deal_contacts dc ON dc.deal_kommo_id = d0.kommo_id
      JOIN contact_phones cp ON cp.contact_id = dc.contact_id
      JOIN ringostat_calls rc ON rc.client_phone = cp.phone
       AND rc.call_type IN ('in','transitin') AND rc.calldate BETWEEN d0.created_at - interval '2 hours' AND d0.created_at + interval '15 minutes'
  ),
  c1 AS (
    SELECT DISTINCT ON (kommo_id) kommo_id, n_alias, utm_source, utm_medium, utm_campaign
      FROM lc ORDER BY kommo_id, calldate DESC, uniqueid
  ),
  x AS (
    SELECT d0.*, c1.kommo_id IS NOT NULL AS has_call, c1.n_alias, c1.utm_source AS c_src, c1.utm_medium AS c_med, c1.utm_campaign AS c_camp,
           EXISTS (SELECT 1 FROM deals p JOIN pipeline_stage_map psm ON psm.pipeline_id = p.pipeline_id AND psm.status_id = p.status_id
                    WHERE p.client_key = d0.client_key AND psm.funnel_stage = 'paid' AND p.created_at_kommo < d0.created_at) AS paid_before,
           EXISTS (SELECT 1 FROM deals p WHERE p.client_key = d0.client_key AND p.created_at_kommo < d0.created_at - interval '1 day') AS deal_before
      FROM d0 LEFT JOIN c1 ON c1.kommo_id = d0.kommo_id
  )`;

const SUMMARY = (groupBy) => `
  SELECT ${groupBy} AS k, COUNT(*)::int AS deals,
         COUNT(*) FILTER (WHERE deal_tag)::int AS deal_tag,
         COUNT(*) FILTER (WHERE has_call)::int AS with_call,
         COUNT(*) FILTER (WHERE has_call AND c_src IS NOT NULL)::int AS call_utm,
         COUNT(*) FILTER (WHERE has_call AND (c_med = 'cpc' OR c_src ILIKE '%google%' AND c_med ILIKE '%cpc%'))::int AS call_cpc,
         COUNT(*) FILTER (WHERE paid_before)::int AS paid_before,
         COUNT(*) FILTER (WHERE deal_before)::int AS deal_before
    FROM x GROUP BY 1 ORDER BY 2 DESC`;

try {
  const c = await pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    const span = (await c.query("SELECT min(calldate)::date AS mn, max(calldate)::date AS mx, COUNT(*)::int AS n FROM ringostat_calls")).rows[0];
    console.log("ringostat_calls:", JSON.stringify(span));
    if (!span.n) throw new Error("дзвінків немає — замір недійсний");

    console.log("\n=== A. Угоди з сайтовим джерелом з", FROM, "(усі воронки)");
    const a = await c.query(`WITH ${DEALS_CTE(`d.client_source = ANY($1) AND d.created_at_kommo >= $2::date`)} ${SUMMARY("client_source")}`, [SITE, FROM]);
    console.table(a.rows);

    console.log("\n=== B. На який наш номер дзвонили (n_alias) — угоди «Дзвінок з uts.ua» зі знайденим дзвінком");
    const b = await c.query(`WITH ${DEALS_CTE(`d.client_source = 'Дзвінок з uts.ua' AND d.created_at_kommo >= $1::date`)}
      SELECT COALESCE(n_alias,'(порожньо)') AS n_alias, COUNT(*)::int AS deals, COUNT(*) FILTER (WHERE c_src IS NOT NULL)::int AS call_utm,
             string_agg(DISTINCT c_src, ', ') FILTER (WHERE c_src IS NOT NULL) AS sources
        FROM x WHERE has_call GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [FROM]);
    console.table(b.rows);

    console.log("\n=== C. Усі вхідні дзвінки з", FROM, "за нашим номером (n_alias): скільки з utm");
    const cc = await c.query(`SELECT COALESCE(n_alias,'(порожньо)') AS n_alias, COUNT(*)::int AS calls,
             COUNT(*) FILTER (WHERE utm_source IS NOT NULL)::int AS with_utm,
             string_agg(DISTINCT utm_source, ', ') FILTER (WHERE utm_source IS NOT NULL) AS sources
        FROM ringostat_calls WHERE call_type IN ('in','transitin') AND calldate >= $1::date GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [FROM]);
    console.table(cc.rows);
    const tot = (await c.query(`SELECT COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE utm_source IS NOT NULL)::int AS with_utm, COUNT(DISTINCT n_alias)::int AS numbers
        FROM ringostat_calls WHERE call_type IN ('in','transitin') AND calldate >= $1::date`, [FROM])).rows[0];
    console.log("усього вхідних:", JSON.stringify(tot));

    console.log("\n=== D. 483 «без мітки»: перша рекламна угода клієнта");
    const marker = "SELECT DISTINCT ON (client_key) client_key, lead_at, campaign, client_name";
    const sel = "SELECT f.client_key, f.campaign";
    if (!AD_CLIENTS_SQL.includes(marker) || !AD_CLIENTS_SQL.includes(sel)) throw new Error("AD_CLIENTS_SQL змінився — оновити замір");
    const adc = AD_CLIENTS_SQL.replace(marker, marker + ", kommo_id").replace(sel, "SELECT f.client_key, f.kommo_id AS first_id, f.campaign");
    const ads = (await c.query("SELECT data->'adSources' AS a FROM app_settings WHERE id=1")).rows[0]?.a;
    if (!Array.isArray(ads) || !ads.length) throw new Error("adSources порожній");
    const cl = (await c.query(adc, [ads, FROM, kyivToday()])).rows;
    const bare = cl.filter((r) => r.campaign === null);
    console.log("клієнтів:", cl.length, "· без мітки:", bare.length);
    if (!bare.length) throw new Error("без мітки 0 — замір недійсний");
    const d = await c.query(`WITH ${DEALS_CTE(`d.kommo_id = ANY($1::bigint[])`)} ${SUMMARY("COALESCE(client_source,'(порожньо)')")}`, [bare.map((r) => r.first_id)]);
    console.table(d.rows);
    await c.query("ROLLBACK");
  } finally { c.release(); }
} finally { await pool.end(); }
