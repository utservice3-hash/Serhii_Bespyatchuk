// Read-only замір: чи на 100% працює крок «перевізник за Lardi» (19.11.2026). Нічого не пише.
// Запуск: cd backend && nice -n 20 node /tmp/cl.cjs
const fs = require("fs"); const path = require("path");
const { Client } = require(path.resolve("node_modules/pg"));
const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));
const K = (x) => `to_char(${x} AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD HH24:MI')`;
// Телефони машин Lardi: 9 цифр + сирий вигляд + коли вперше бачили
const LP = `SELECT right(regexp_replace(p->>'n','\\D','','g'),9) AS p9, regexp_replace(p->>'n','\\D','','g') AS digits,
                   o.company, o.first_seen FROM lardi_offers o, jsonb_array_elements(o.phones) p WHERE o.side = 'lorry'`;
const ROLE = `(SELECT COALESCE(a.result->>'caller_role', a.result->>'verdict') || ' ' || round(COALESCE(a.result->>'caller_role_confidence', a.result->>'confidence')::numeric,2)
                 FROM call_transcripts t JOIN call_analyses a ON a.transcript_id = t.id
                WHERE t.uniqueid = cd.uniqueid AND a.rubric_version IN ('carrier-v2','carrier-v1') AND a.status = 'done' ORDER BY a.id DESC LIMIT 1)`;
const Q = {
  archive: `SELECT count(*) AS lorry_offers, count(*) FILTER (WHERE phones IS NULL OR jsonb_array_length(phones) = 0) AS without_phones,
              ${K("min(first_seen)")} AS first, ${K("max(first_seen)")} AS last FROM lardi_offers WHERE side = 'lorry'`,
  archivePhones: `WITH lp AS (${LP}) SELECT count(DISTINCT p9) AS distinct_p9, count(DISTINCT p9) FILTER (WHERE length(p9) < 9) AS short_p9,
              count(DISTINCT p9) FILTER (WHERE digits ~ '^(380|0)' AND length(digits) IN (10,12)) AS ua_p9,
              count(DISTINCT p9) FILTER (WHERE NOT (digits ~ '^(380|0)' AND length(digits) IN (10,12))) AS non_ua_p9 FROM lp`,
  jobs: `SELECT name, ${K("last_success_at")} AS ok, ${K("last_error_at")} AS err_at, left(last_error,120) AS err FROM job_runs WHERE name IN ('collectLardi','syncLardi','carrierCallJob')`,
  lardiDeals: `SELECT count(*) AS lardi_deals, ${K("min(seen_at)")} AS first_seen_at, ${K("max(seen_at)")} AS last_seen_at FROM carrier_call_deals WHERE state = 'lardi'`,
  // 1. ПРОПУСКИ: номер БУВ в архіві машин до того, як угода прийшла, але угода пішла іншим шляхом
  missed: `WITH lp AS (${LP}), start AS (SELECT min(seen_at) AS t FROM carrier_call_deals WHERE state = 'lardi')
     SELECT cd.state, count(*) AS deals,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lp WHERE lp.p9 = right(cd.phone,9) AND lp.first_seen <= cd.seen_at)) AS in_archive_before,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lp WHERE lp.p9 = right(cd.phone,9) AND lp.first_seen > cd.seen_at)) AS appeared_later
       FROM carrier_call_deals cd, start WHERE cd.seen_at >= start.t GROUP BY 1 ORDER BY 1`,
  missedExamples: `WITH lp AS (${LP}), start AS (SELECT min(seen_at) AS t FROM carrier_call_deals WHERE state = 'lardi')
     SELECT cd.kommo_id, cd.state, ${K("cd.seen_at")} AS deal_seen, ${ROLE} AS ai,
            (SELECT ${K("min(lp.first_seen)")} FROM lp WHERE lp.p9 = right(cd.phone,9)) AS lardi_first_seen,
            (SELECT max(lp.company) FROM lp WHERE lp.p9 = right(cd.phone,9)) AS company,
            (SELECT x.decision FROM carrier_decisions x WHERE x.kommo_id = cd.kommo_id ORDER BY x.id DESC LIMIT 1) AS human
       FROM carrier_call_deals cd, start
      WHERE cd.seen_at >= start.t AND cd.state IN ('own','reused','no_talk')
        AND EXISTS (SELECT 1 FROM lp WHERE lp.p9 = right(cd.phone,9) AND lp.first_seen <= cd.seen_at)
      ORDER BY cd.seen_at DESC LIMIT 25`,
  // 2. ТОЧНІСТЬ: хто насправді ці номери
  matchedPhoneFormat: `WITH lp AS (${LP}), ld AS (SELECT kommo_id, right(phone,9) AS p9 FROM carrier_call_deals WHERE state = 'lardi')
     SELECT fmt, count(*) AS deals FROM (
       SELECT CASE WHEN bool_or(lp.digits ~ '^(380|0)' AND length(lp.digits) IN (10,12)) THEN 'є український запис' ELSE 'ЛИШЕ іноземний/дивний запис' END AS fmt
         FROM ld JOIN lp USING (p9) GROUP BY ld.kommo_id) x GROUP BY 1`,
  companiesPerPhone: `WITH lp AS (${LP}), ld AS (SELECT DISTINCT right(phone,9) AS p9 FROM carrier_call_deals WHERE state = 'lardi')
     SELECT n_companies, count(*) AS phones FROM (SELECT ld.p9, count(DISTINCT lp.company) AS n_companies FROM ld JOIN lp USING (p9) GROUP BY 1) x GROUP BY 1 ORDER BY 1`,
  aiOnSamePhone: `WITH ld AS (SELECT DISTINCT right(phone,9) AS p9 FROM carrier_call_deals WHERE state = 'lardi')
     SELECT split_part(${ROLE}, ' ', 1) AS ai_role, count(*) AS other_deals_same_phone
       FROM carrier_call_deals cd JOIN ld ON ld.p9 = right(cd.phone,9) WHERE cd.state = 'own' GROUP BY 1 ORDER BY 2 DESC`,
  humanOnLardi: `SELECT x.decision, count(*) FROM carrier_decisions x JOIN carrier_call_deals cd ON cd.kommo_id = x.kommo_id WHERE cd.state = 'lardi' GROUP BY 1`,
  lardiDealsCrmNow: `SELECT CASE WHEN dd.kommo_id IS NULL THEN 'немає в deals' WHEN dd.status_id = 142 THEN 'УСПІХ' WHEN dd.status_id = 143 THEN 'закрита: ' || COALESCE(dd.reject_reason,'—') ELSE 'ВІДКРИТА ' || dd.pipeline_id || '/' || dd.status_id END AS now_state, count(*)
       FROM carrier_call_deals cd LEFT JOIN deals dd ON dd.kommo_id = cd.kommo_id WHERE cd.state = 'lardi' GROUP BY 1 ORDER BY 2 DESC`,
  // 3. Номери Lardi, у яких є успішна угода замовника, — скільки й коли була остання оплата відносно дзвінка
  paidClientOnLardi: `WITH ld AS (SELECT kommo_id, right(phone,9) AS p9, seen_at FROM carrier_call_deals WHERE state = 'lardi'),
     dp AS (SELECT d.kommo_id, d.status_id, d.pipeline_id, d.created_at_kommo, right(regexp_replace(cp.phone,'\\D','','g'),9) AS p9
              FROM contact_phones cp JOIN deal_contacts dc ON dc.contact_id = cp.contact_id JOIN deals d ON d.kommo_id = dc.deal_kommo_id
            UNION SELECT d.kommo_id, d.status_id, d.pipeline_id, d.created_at_kommo, right(regexp_replace(d.name,'\\D','','g'),9) FROM deals d
             WHERE regexp_replace(d.name,'\\D','','g') ~ '^380[0-9]{9}$')
     SELECT count(DISTINCT ld.kommo_id) AS lardi_deals_with_paid_client_deal,
            count(DISTINCT ld.kommo_id) FILTER (WHERE dp.created_at_kommo >= ld.seen_at - interval '90 days') AS paid_deal_within_90d,
            count(DISTINCT ld.p9) AS distinct_phones
       FROM ld JOIN dp ON dp.p9 = ld.p9 AND dp.kommo_id <> ld.kommo_id AND dp.status_id = 142
        AND dp.pipeline_id <> ALL (ARRAY[7341740,7491756,13905312]::bigint[])`,
};
(async () => {
  const c = new Client({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_URL.includes("sslmode") ? undefined : { rejectUnauthorized: false } });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  await c.query("SET LOCAL statement_timeout = '120s'");
  for (const [k, sql] of Object.entries(Q)) {
    await c.query("SAVEPOINT s");
    const t0 = Date.now();
    try { const r = await c.query(sql); console.log(`\n== ${k} (${r.rowCount} рядків, ${Date.now() - t0} мс)`); console.table(r.rows); }
    catch (e) { console.log(`\n== ${k} ПОМИЛКА: ${e.message}`); await c.query("ROLLBACK TO SAVEPOINT s"); }
  }
  await c.query("ROLLBACK"); await c.end();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
