// Запит Яцика 24.11.2026: які угоди Семенюка стоять ЗАРАЗ в «Оплата отримана», але Звіт рахує їх НЕ в поточному місяці.
// ЛИШЕ ЧИТАННЯ (BEGIN READ ONLY … ROLLBACK). Запуск: cd <repo>/backend && nice -n 20 node /tmp/sem.cjs
// Анкер як у core/money.ts (main 430a92f): остання подія входу в етап; подій немає взагалі - дата створення.
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require(path.join(process.cwd(), "node_modules", "pg"));
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const FC = [8921932, 155304], PAID = [69716460, 60412544];
const K = "AT TIME ZONE 'Europe/Kyiv'";
const base = `
  SELECT d.kommo_id, d.name, d.price, d.created_at_kommo AS created,
         COALESCE((SELECT MAX(e.changed_at) FROM deal_stage_events e WHERE e.kommo_id = d.kommo_id AND e.pipeline_id = ANY($1) AND e.status_id = ANY($2)),
                  CASE WHEN NOT EXISTS (SELECT 1 FROM deal_stage_events e0 WHERE e0.kommo_id = d.kommo_id) THEN d.created_at_kommo END) AS anchor
    FROM deals d
   WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2)
     AND d.manager_id IN (SELECT id FROM managers WHERE name ILIKE '%Семенюк%')`;
const Q = [
  ["A розклад по місяцях входу в етап (усе, що зараз в «Оплата отримана»)", `SELECT COALESCE(to_char(anchor ${K}, 'YYYY-MM'), 'без дати') AS month, COUNT(*)::int AS deals, ROUND(SUM(price))::bigint AS sum FROM (${base}) x GROUP BY 1 ORDER BY 1`],
  ["B угоди, яких немає у Звіті за поточний місяць", `SELECT kommo_id, ROUND(price)::bigint AS price, COALESCE(to_char(anchor ${K}, 'DD.MM.YYYY HH24:MI'), 'без дати') AS entered_stage, to_char(created ${K}, 'DD.MM.YYYY') AS created, left(name, 40) AS name, 'https://utsercice.kommo.com/leads/detail/' || kommo_id AS url FROM (${base}) x WHERE anchor IS NULL OR to_char(anchor ${K}, 'YYYY-MM') <> to_char(now() ${K}, 'YYYY-MM') ORDER BY anchor NULLS LAST`],
];
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  try {
    for (const [name, sql] of Q) {
      const r = await c.query(sql, [FC, PAID]);
      console.log(`\n### ${name}  (${r.rowCount} рядків)`);
      console.table(r.rows);
    }
  } finally { await c.query("ROLLBACK"); await c.end(); }
})().catch((e) => { console.error("ПОМИЛКА:", e.message); process.exit(1); });
