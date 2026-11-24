// Пропущені «на мобільні» (перехоплені), тред 20.11.2026: замір ЛИШЕ ЧИТАННЯМ (BEGIN READ ONLY … ROLLBACK).
// Питання: чи «дзвінок, у якому всі плечі transitin» = «дзвінок на мобільний менеджера (бізнес-номер 073…)».
// Склейка плечей — те саме правило, що core/missedCallUnits.ts (номер, розрив до 60 с, розмова в будь-якому плечі = взяли).
// Запуск: cd <repo>/backend && nice -n 20 node /tmp/mm.cjs   (потрібні лише node_modules/pg і .env). Секретів не друкує.
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require(path.join(process.cwd(), "node_modules", "pg"));
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const UNITS = `
  WITH legs AS (
    SELECT rc.uniqueid, rc.call_type, rc.calldate, rc.billsec, rc.disposition, rc.client_phone, rc.dst, rc.n_alias,
           COALESCE(rc.client_phone, 'u:' || rc.uniqueid) AS ckey
      FROM ringostat_calls rc
     WHERE rc.call_type IN ('in','transitin')
       AND rc.calldate >= ('2026-11-13'::timestamp AT TIME ZONE 'Europe/Kyiv') - interval '60 seconds'
       AND rc.calldate <  ('2026-11-20'::timestamp AT TIME ZONE 'Europe/Kyiv') + interval '60 seconds'
  ), brk AS (
    SELECT l.*, CASE WHEN l.calldate - LAG(l.calldate) OVER (PARTITION BY l.ckey ORDER BY l.calldate, l.uniqueid)
                     <= interval '60 seconds' THEN 0 ELSE 1 END AS b FROM legs l
  ), grp AS (
    SELECT x.*, SUM(x.b) OVER (PARTITION BY x.ckey ORDER BY x.calldate, x.uniqueid) AS cid FROM brk x
  ), units AS (
    SELECT ckey, cid, MIN(calldate) AS calldate, MAX(client_phone) AS client_phone,
           bool_or(billsec > 0) AS answered,
           CASE WHEN bool_or(disposition = 'NO ANSWER') THEN 'NO ANSWER' WHEN bool_or(disposition = 'BUSY') THEN 'BUSY'
                ELSE (array_agg(disposition ORDER BY calldate, uniqueid))[1] END AS disposition,
           bool_and(call_type = 'transitin') AS all_transit, bool_or(call_type = 'in') AS has_in,
           array_agg(DISTINCT dst) AS dsts, array_agg(DISTINCT n_alias) AS aliases
      FROM grp GROUP BY ckey, cid
  ), missed AS (
    SELECT u.*, EXISTS (SELECT 1 FROM carrier_phones cpx WHERE cpx.p9 = right(u.client_phone, 9)) AS is_carrier
      FROM units u
     WHERE NOT u.answered AND u.disposition IN ('NO ANSWER','BUSY')
       AND (u.calldate AT TIME ZONE 'Europe/Kyiv')::date BETWEEN '2026-11-13' AND '2026-11-19'
  )`;
const Q = {
  "1. По днях: пропущені без перевізників, з них «усі плечі transitin» (19.11 очікуємо 90 і 42)": `${UNITS}
    SELECT to_char((calldate AT TIME ZONE 'Europe/Kyiv')::date,'DD.MM') AS day,
           COUNT(*) FILTER (WHERE NOT is_carrier)::int AS missed,
           COUNT(*) FILTER (WHERE NOT is_carrier AND all_transit)::int AS all_transit,
           COUNT(*) FILTER (WHERE NOT is_carrier AND NOT all_transit)::int AS has_in_leg,
           COUNT(*) FILTER (WHERE is_carrier)::int AS carriers
      FROM missed GROUP BY 1 ORDER BY 1`,
  "2. Куди йшли дзвінки «усі плечі transitin»: dst (13-19.11, без перевізників)": `${UNITS}
    SELECT d AS dst, COUNT(*)::int AS units FROM missed, unnest(dsts) d WHERE NOT is_carrier AND all_transit
     GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
  "3. Те саме по n_alias": `${UNITS}
    SELECT a AS n_alias, COUNT(*)::int AS units FROM missed, unnest(aliases) a WHERE NOT is_carrier AND all_transit
     GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
  "4. Для порівняння: dst дзвінків, де є плече «in»": `${UNITS}
    SELECT d AS dst, COUNT(*)::int AS units FROM missed, unnest(dsts) d WHERE NOT is_carrier AND NOT all_transit
     GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
};
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  await c.query("SET LOCAL statement_timeout = '240s'");
  for (const [t, sql] of Object.entries(Q)) {
    const s = Date.now();
    try {
      const r = await c.query(sql);
      console.log(`\n── ${t} · ${r.rows.length} рядків · ${Date.now() - s} мс`);
      if (r.rows[0]) console.log("  " + Object.keys(r.rows[0]).join(" | "));
      for (const row of r.rows) console.log("  " + Object.values(row).join(" | "));
    } catch (e) { console.log(`\n── ${t}: ПОМИЛКА ${e.message}`); }
  }
  await c.query("ROLLBACK");
  await c.end();
})();
