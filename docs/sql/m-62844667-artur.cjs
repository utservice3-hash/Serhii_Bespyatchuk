// Замір: угода 62844667 (Артур, Полтава - Харків) і передачі Аліни. READ ONLY.
// Запуск: cd <repo>/backend && node /tmp/m62844667.cjs
const { Client } = require(process.cwd() + "/node_modules/pg");
const fs = require("fs");
if (!process.env.DATABASE_URL) { for (const l of fs.readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^DATABASE_URL=(.*)$/); if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ""); } }
const K = "AT TIME ZONE 'Europe/Kyiv'";
const PZ = [8921936, 7337048];
const DEAL = `d.kommo_id, d.name, d.pipeline_id, d.status_id, mg.name AS manager, d.client_key, d.client_name,
  to_char(d.created_at_kommo ${K}, 'YYYY-MM-DD HH24:MI:SS') AS created, d.price, d.is_minus,
  to_char(d.load_at ${K}, 'YYYY-MM-DD') AS load_day, to_char(d.closed_at_kommo ${K}, 'YYYY-MM-DD') AS closed_day`;
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query("BEGIN READ ONLY");
  const show = (t, rows) => { console.log(`\n=== ${t}: ${rows.length} рядк.`); if (rows.length) console.table(rows); };

  const t = (await c.query(`SELECT ${DEAL} FROM deals d LEFT JOIN managers mg ON mg.id = d.manager_id WHERE d.kommo_id = 62844667`)).rows;
  show("1. Угода 62844667", t);
  if (t.length !== 1) throw new Error("угоди 62844667 у базі немає — далі міряти нічого");
  const ck = t[0].client_key;

  show("2. Менеджери «Аліна/Алина»", (await c.query(
    `SELECT m.id, m.name, m.kommo_user_id, m.is_active, tm.name AS team FROM managers m LEFT JOIN teams tm ON tm.id = m.team_id
      WHERE m.name ILIKE '%аліна%' OR m.name ILIKE '%алина%' ORDER BY m.id`)).rows);

  show("3. lead_child_links з участю 62844667", (await c.query(
    `SELECT parent_id, child_id, to_char(created_at ${K}, 'YYYY-MM-DD HH24:MI') AS at FROM lead_child_links
      WHERE child_id = 62844667 OR parent_id = 62844667`)).rows);

  show(`4. Усі угоди клієнта ${JSON.stringify(ck)}`, ck ? (await c.query(
    `SELECT ${DEAL}, (SELECT string_agg(l.parent_id::text, ',') FROM lead_child_links l WHERE l.child_id = d.kommo_id) AS created_from
       FROM deals d LEFT JOIN managers mg ON mg.id = d.manager_id
      WHERE d.client_key = $1 ORDER BY d.created_at_kommo`, [ck])).rows : []);

  // 5. Передачі (вхід угоди Продзвону в 142) з 01.09 — того самого клієнта, або з «Артур»/«Полтав» у назві/клієнті.
  const h = (await c.query(
    `SELECT e.kommo_id AS pz_id, to_char(e.changed_at ${K}, 'YYYY-MM-DD HH24:MI:SS') AS qualified_at, lg.name AS lg_now,
            d.name AS pz_name, d.client_name AS pz_client, d.client_key AS pz_ck,
            (SELECT string_agg(l.child_id::text, ',') FROM lead_child_links l WHERE l.parent_id = e.kommo_id) AS children
       FROM deal_stage_events e JOIN deals d ON d.kommo_id = e.kommo_id LEFT JOIN managers lg ON lg.id = d.manager_id
      WHERE e.pipeline_id = ANY($1) AND e.status_id = 142 AND e.changed_at >= '2026-09-01'
        AND (d.client_key = $2 OR d.name ILIKE '%артур%' OR d.client_name ILIKE '%артур%' OR d.name ILIKE '%полтав%')
      ORDER BY e.changed_at`, [PZ, ck])).rows;
  show("5. Передачі з 01.09: той самий клієнт або «Артур»/«Полтав»", h);

  // 6. Угоди-діти цих передач (з приміток Kommo) — що зараз привʼязано до передачі.
  const kids = [...new Set(h.flatMap((x) => (x.children ? x.children.split(",").map(Number) : [])))];
  show("6. Угоди менеджера, створені з цих передач", kids.length ? (await c.query(
    `SELECT ${DEAL} FROM deals d LEFT JOIN managers mg ON mg.id = d.manager_id WHERE d.kommo_id = ANY($1::bigint[]) ORDER BY d.created_at_kommo`, [kids])).rows : []);

  await c.query("ROLLBACK"); await c.end();
})().catch((e) => { console.error("ПОМИЛКА", e.message); process.exit(1); });
