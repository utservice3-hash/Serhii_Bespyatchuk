// Перевірка 25.11.2026 (Роман: «чи збереглися заявки на 100 000»). ЛИШЕ ЧИТАННЯ: BEGIN READ ONLY … ROLLBACK.
// Друкує заявки на аванс user 50 за листопад (з рядками по картах), його карти (лише last4, без номерів) і
// кількість заявок за 25.11 у ВСІХ, де сума більша за ліміт або >= 100 000 (має бути 0). Секретів не друкує.
// Запуск: cd <repo>/backend && nice -n 20 node /tmp/x.cjs
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require(path.join(process.cwd(), "node_modules", "pg"));
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const Q = {
  "заявки user 50, листопад": `SELECT a.id, a.amount::int AS amount, a.cash::int AS cash, a.limit_at_request::int AS limit_at_request, a.status,
      to_char(a.requested_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI:SS') AS requested_kyiv,
      to_char(a.cancelled_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI:SS') AS cancelled_kyiv,
      (SELECT string_agg(c.last4 || '=' || l.amount::int, ', ') FROM payroll_advance_lines l JOIN payroll_cards c ON c.id = l.card_id WHERE l.advance_id = a.id) AS lines
    FROM payroll_advances a WHERE a.user_id = 50 AND a.month = '2026-11-01' ORDER BY a.id`,
  "рядки заявок user 50 без своєї заявки (мають бути 0)": `SELECT COUNT(*)::int AS orphan_lines FROM payroll_advance_lines l
    WHERE l.card_id IN (SELECT id FROM payroll_cards WHERE user_id = 50) AND NOT EXISTS (SELECT 1 FROM payroll_advances a WHERE a.id = l.advance_id)`,
  "карти user 50": `SELECT id, last4, bank, to_char(created_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI') AS created_kyiv,
      to_char(archived_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI') AS archived_kyiv FROM payroll_cards WHERE user_id = 50 ORDER BY id`,
  "заявки 25.11 у всіх: понад ліміт або >= 100 000 (має бути 0)": `SELECT COUNT(*)::int AS n FROM payroll_advances
    WHERE (requested_at AT TIME ZONE 'Europe/Kyiv')::date = '2026-11-25' AND (amount > limit_at_request OR amount >= 100000)`,
  "усього заявок 25.11 (для масштабу)": `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status = 'requested')::int AS requested FROM payroll_advances
    WHERE (requested_at AT TIME ZONE 'Europe/Kyiv')::date = '2026-11-25'`,
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
