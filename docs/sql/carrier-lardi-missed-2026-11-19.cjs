// Read-only: пропуски кроку Lardi (швидка версія запиту missed). Нічого не пише. Запуск: cd backend && nice -n 20 node /tmp/cm.cjs
const fs = require("fs"); const path = require("path");
const { Client } = require(path.resolve("node_modules/pg"));
const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));
const LPM = `SELECT p9, min(first_seen) AS fs FROM (SELECT right(regexp_replace(p->>'n','\\D','','g'),9) AS p9, o.first_seen
               FROM lardi_offers o, jsonb_array_elements(o.phones) p WHERE o.side = 'lorry') x GROUP BY p9`;
const ROLE = `(SELECT COALESCE(a.result->>'caller_role', a.result->>'verdict') FROM call_transcripts t JOIN call_analyses a ON a.transcript_id = t.id
                WHERE t.uniqueid = COALESCE(src.uniqueid, cd.uniqueid) AND a.rubric_version IN ('carrier-v2','carrier-v1') AND a.status = 'done' ORDER BY a.id DESC LIMIT 1)`;
const BASE = `WITH lpm AS MATERIALIZED (${LPM}), start AS (SELECT min(seen_at) AS t FROM carrier_call_deals WHERE state = 'lardi'),
  x AS (SELECT cd.kommo_id, cd.state, cd.seen_at, lpm.fs, ${ROLE} AS ai,
               (SELECT d.decision FROM carrier_decisions d WHERE d.kommo_id = cd.kommo_id ORDER BY d.id DESC LIMIT 1) AS human
          FROM carrier_call_deals cd CROSS JOIN start LEFT JOIN carrier_call_deals src ON src.kommo_id = cd.reused_from
          LEFT JOIN lpm ON lpm.p9 = right(cd.phone,9) WHERE cd.seen_at >= start.t)`;
const Q = {
  // Позитивний контроль: угоди 'lardi' мусять мати номер в архіві ДО того, як ми їх побачили (очікуємо 155 із 155)
  missedByState: `${BASE} SELECT state, count(*) AS deals, count(*) FILTER (WHERE fs <= seen_at) AS in_archive_before,
       count(*) FILTER (WHERE fs > seen_at) AS appeared_later FROM x GROUP BY 1 ORDER BY 1`,
  missedExamples: `${BASE} SELECT kommo_id, state, to_char(seen_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD HH24:MI') AS seen,
       to_char(fs AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD HH24:MI') AS lardi_first, ai, human FROM x
       WHERE fs <= seen_at AND state NOT IN ('lardi','history') ORDER BY seen_at DESC LIMIT 20`,
  laterByAi: `${BASE} SELECT state, COALESCE(ai,'—') AS ai, COALESCE(human,'—') AS human, count(*) AS n,
       round(avg(extract(epoch FROM fs - seen_at)/86400)::numeric,1) AS avg_days_until_on_lardi
       FROM x WHERE fs > seen_at GROUP BY 1,2,3 ORDER BY 4 DESC`,
};
(async () => {
  const c = new Client({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_URL.includes("sslmode") ? undefined : { rejectUnauthorized: false } });
  await c.connect(); await c.query("BEGIN READ ONLY"); await c.query("SET LOCAL statement_timeout = '150s'");
  for (const [k, sql] of Object.entries(Q)) {
    await c.query("SAVEPOINT s"); const t0 = Date.now();
    try { const r = await c.query(sql); console.log(`\n== ${k} (${r.rowCount} рядків, ${Date.now() - t0} мс)`); console.table(r.rows); }
    catch (e) { console.log(`\n== ${k} ПОМИЛКА: ${e.message}`); await c.query("ROLLBACK TO SAVEPOINT s"); }
  }
  await c.query("ROLLBACK"); await c.end();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
