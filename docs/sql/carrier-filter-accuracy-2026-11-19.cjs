// Read-only замір: чи ВІРНО працює відсів «Дзвінки на мобільні» (19.11.2026). Звіряє наші дії з тим, що потім
// показує CRM: перевідкриття, угоди замовника на номерах «перевізників», пізні розмови після «Немає зв'язку».
// Нічого не пише. Запуск: cd backend && nice -n 20 node /tmp/ca.cjs
const fs = require("fs"); const path = require("path");
const { Client } = require(path.resolve("node_modules/pg"));
const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));
const K = (x) => `to_char(${x} AT TIME ZONE 'Europe/Kyiv','DD.MM HH24:MI')`;
const CLOSED = `SELECT cl.kommo_id, cl.reason, cl.closed_at, cl.confidence, cd.phone, right(cd.phone,9) AS p9, cd.deal_created_at,
    cd.state AS src, (SELECT x.decision FROM carrier_decisions x WHERE x.kommo_id = cl.kommo_id ORDER BY x.id DESC LIMIT 1) AS human
    FROM carrier_close_log cl JOIN carrier_call_deals cd ON cd.kommo_id = cl.kommo_id
   WHERE cl.mode = 'live' AND cl.closed_at IS NOT NULL AND cl.reverted_at IS NULL`;
const SRC = `CASE WHEN c.human IS NOT NULL THEN 'людина' WHEN c.src IN ('history','lardi') THEN c.src WHEN c.reason='no_talk' THEN 'без розмови' ELSE 'AI' END`;
const DP = `SELECT d.kommo_id, d.status_id, d.pipeline_id, d.reject_reason, d.created_at_kommo, d.price, right(regexp_replace(cp.phone,'\\D','','g'),9) AS p9
      FROM contact_phones cp JOIN deal_contacts dc ON dc.contact_id = cp.contact_id JOIN deals d ON d.kommo_id = dc.deal_kommo_id
    UNION
    SELECT d.kommo_id, d.status_id, d.pipeline_id, d.reject_reason, d.created_at_kommo, d.price, right(regexp_replace(d.name,'\\D','','g'),9)
      FROM deals d WHERE regexp_replace(d.name,'\\D','','g') ~ '^380[0-9]{9}$'`;
const CLIENT = (a) => `${a}.status_id <> 143 AND ${a}.pipeline_id <> ALL (ARRAY[7341740,7491756,13905312]::bigint[])
    AND NOT (${a}.pipeline_id = 8921928 AND ${a}.status_id = 70419108)`;
const Q = {
  total: `WITH c AS (${CLOSED}) SELECT c.reason, ${SRC} AS src, count(*) AS n, min(${K("c.closed_at")}) AS first, max(${K("c.closed_at")}) AS last FROM c GROUP BY 1,2 ORDER BY 1,2`,
  // 1. Що з нашою закритою угодою в CRM зараз
  nowInCrm: `WITH c AS (${CLOSED}) SELECT c.reason, ${SRC} AS src,
      CASE WHEN dd.kommo_id IS NULL THEN 'немає в deals' WHEN dd.status_id = 142 THEN 'УСПІХ'
           WHEN dd.status_id = 143 THEN 'закрита: ' || COALESCE(dd.reject_reason,'—')
           WHEN dd.pipeline_id = 8921928 AND dd.status_id = 70419108 THEN 'ЗНОВУ на етапі' ELSE 'ВІДКРИТА в роботі' END AS now_state,
      count(*) AS n
      FROM c LEFT JOIN deals dd ON dd.kommo_id = c.kommo_id GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`,
  reopenedExamples: `WITH c AS (${CLOSED}) SELECT c.kommo_id, c.reason, ${SRC} AS src, round(c.confidence,2) AS conf, ${K("c.closed_at")} AS closed,
      dd.pipeline_id, dd.status_id, dd.reject_reason, ${K("dd.updated_at_kommo")} AS crm_upd, m.name AS manager
      FROM c JOIN deals dd ON dd.kommo_id = c.kommo_id LEFT JOIN managers m ON m.kommo_user_id = dd.kommo_user_id
     WHERE dd.status_id <> 143 OR dd.reject_reason IS DISTINCT FROM
           CASE c.reason WHEN 'carrier' THEN 'Перевізник' WHEN 'other' THEN 'Нецільове звернення' ELSE 'Немає зв''язку' END
     ORDER BY c.closed_at DESC LIMIT 25`,
  // 2. Номер, закритий як «Перевізник», має угоду замовника
  clientDealOnCarrierPhone: `WITH c AS (${CLOSED} AND cl.reason = 'carrier'), dp AS (${DP}),
      hit AS (SELECT c.kommo_id, ${SRC} AS src, bool_or(dp.status_id = 142) AS won, bool_or(dp.status_id <> 142) AS open,
                     bool_or(dp.created_at_kommo > c.closed_at) AS after_close
                FROM c JOIN dp ON dp.p9 = c.p9 AND dp.kommo_id <> c.kommo_id AND ${CLIENT("dp")} GROUP BY 1,2)
      SELECT src, count(*) AS phones_with_client_deal, count(*) FILTER (WHERE won) AS with_success, count(*) FILTER (WHERE after_close) AS deal_after_close,
             (SELECT count(*) FROM c c2) AS all_carrier_closes FROM hit GROUP BY 1 ORDER BY 1`,
  clientDealExamples: `WITH c AS (${CLOSED} AND cl.reason = 'carrier'), dp AS (${DP})
      SELECT DISTINCT ON (c.kommo_id) c.kommo_id AS closed_deal, ${SRC} AS src, round(c.confidence,2) AS conf, ${K("c.closed_at")} AS closed,
             dp.kommo_id AS client_deal, dp.pipeline_id, dp.status_id, dp.price, ${K("dp.created_at_kommo")} AS client_created
        FROM c JOIN dp ON dp.p9 = c.p9 AND dp.kommo_id <> c.kommo_id AND ${CLIENT("dp")}
       ORDER BY c.kommo_id DESC, (dp.status_id = 142) DESC, dp.created_at_kommo DESC LIMIT 25`,
  // 3. «Немає зв'язку», а розмова від 10 с усе ж була
  noTalkButTalk: `WITH c AS (${CLOSED} AND cl.reason = 'no_talk')
      SELECT count(*) AS no_talk_closes,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ringostat_calls r WHERE right(r.client_phone,9) = c.p9 AND r.billsec >= 10
              AND r.calldate BETWEEN c.deal_created_at - interval '10 min' AND c.deal_created_at + interval '4 hours')) AS talk_IN_4h_window,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ringostat_calls r WHERE right(r.client_phone,9) = c.p9 AND r.billsec >= 10
              AND r.calldate BETWEEN c.deal_created_at - interval '10 min' AND c.closed_at)) AS talk_BEFORE_close,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ringostat_calls r WHERE right(r.client_phone,9) = c.p9 AND r.billsec >= 10
              AND r.calldate > c.closed_at AND r.calldate <= c.closed_at + interval '7 days')) AS talk_within_7d_after
      FROM c`,
  noTalkBeforeExamples: `WITH c AS (${CLOSED} AND cl.reason = 'no_talk')
      SELECT c.kommo_id, ${K("c.deal_created_at")} AS deal_created, ${K("c.closed_at")} AS closed, r.uniqueid, ${K("r.calldate")} AS call_at, r.billsec, r.call_type
        FROM c JOIN ringostat_calls r ON right(r.client_phone,9) = c.p9 AND r.billsec >= 10
             AND r.calldate BETWEEN c.deal_created_at - interval '10 min' AND c.closed_at
       ORDER BY c.closed_at DESC LIMIT 15`,
  // 4. Перенесені клієнти — що з ними далі
  movesOutcome: `SELECT CASE WHEN dd.status_id = 142 THEN 'УСПІХ' WHEN dd.status_id = 143 THEN 'закрита: ' || COALESCE(dd.reject_reason,'—')
           WHEN dd.status_id = 69693652 THEN 'досі «Лід взятий у роботу»' ELSE 'далі по воронці ' || dd.pipeline_id || '/' || dd.status_id END AS now_state,
           count(*) AS n
      FROM carrier_client_moves mv JOIN deals dd ON dd.kommo_id = mv.kommo_id
     WHERE mv.mode = 'live' AND mv.moved_at IS NOT NULL AND mv.reverted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`,
  // 5. Людина проти AI (усе з 30.09)
  humanVsAi: `SELECT COALESCE(ai_role,'—') AS ai_said, decision AS human_said, count(*) AS n FROM carrier_decisions GROUP BY 1,2 ORDER BY 1,2`,
  reverted: `SELECT 'закриття' AS what, count(*) FILTER (WHERE reverted_at IS NOT NULL) AS reverted, count(*) FILTER (WHERE closed_at IS NOT NULL) AS done FROM carrier_close_log WHERE mode='live'
             UNION ALL SELECT 'перенос клієнта', count(*) FILTER (WHERE reverted_at IS NOT NULL), count(*) FILTER (WHERE moved_at IS NOT NULL) FROM carrier_client_moves WHERE mode='live'`,
  // 6. Черга людей зараз
  reviewQueueNow: `SELECT count(*) AS on_stage_in_crm FROM deals WHERE pipeline_id = 8921928 AND status_id = 70419108`,
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
