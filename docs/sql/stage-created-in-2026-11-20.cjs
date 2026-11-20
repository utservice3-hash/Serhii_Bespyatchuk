// Дати етапів у Звіті (запит Яцика), тред 20.11.2026: замір ЛИШЕ ЧИТАННЯМ (BEGIN READ ONLY … ROLLBACK).
// Питання: скільки угод стоять зараз в «Оплата отримана» (етап 9) / «Очікуємо оплату» (етап 8) БЕЗ події входу в етап
// (створені одразу в етапі), куди вони потрапили б, якщо датою переходу брати дату створення, і що це дає Семенюку.
// Запуск: cd <repo>/backend && nice -n 20 node /tmp/stage.cjs     (потрібні лише node_modules/pg і .env)
// Друкує кількості, суми, id угод і менеджерів. Секретів не друкує.
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require(path.join(process.cwd(), "node_modules", "pg"));
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const FC = [8921932, 155304], PAID = [69716460, 60412544], EXP = [69716312, 25044997];
const FROM_INV = [100274340, 62940064, 69716300, 98470988, 69716304, 69716312, 69716460, 10937178, 42639144, 42639147, 25044997, 62940068, 60412544, 142];
const K = "AT TIME ZONE 'Europe/Kyiv'";
// Угоди, що ЗАРАЗ у групі етапів $2, з датою останнього входу в цю групу і кількістю подій угоди взагалі.
const cur = (st) => `
  SELECT d.kommo_id, d.manager_id, d.price, d.status_id, d.created_at_kommo AS created,
         (SELECT MAX(e.changed_at) FROM deal_stage_events e WHERE e.kommo_id = d.kommo_id AND e.pipeline_id = ANY($1) AND e.status_id = ANY(${st})) AS ev_cur,
         (SELECT COUNT(*) FROM deal_stage_events e WHERE e.kommo_id = d.kommo_id)::int AS ev_any
    FROM deals d WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY(${st})`;
const cat = "CASE WHEN ev_cur IS NOT NULL THEN 'є подія входу' WHEN ev_any = 0 THEN 'створена одразу в етапі (подій 0)' ELSE 'події є, але не в цей етап' END";
const Q = [
  ["Q0 глибина журналу етапів", `SELECT MIN(changed_at) ${K} AS first_event, MAX(changed_at) ${K} AS last_event, COUNT(*)::int AS events FROM deal_stage_events`, []],
  ["Q1 Семенюк у managers", `SELECT id, name, is_active FROM managers WHERE name ILIKE '%Семенюк%' ORDER BY id`, []],
  ["Q2 Семенюк: ЗАРАЗ в «Оплата отримана» (усього, як у Kommo)", `SELECT COUNT(*)::int AS deals, ROUND(SUM(price))::bigint AS sum FROM (${cur("$2")}) x WHERE manager_id IN (SELECT id FROM managers WHERE name ILIKE '%Семенюк%')`, [FC, PAID]],
  ["Q3 Семенюк: етап 9 за категорією і місяцем анкера (ev_cur) / створення", `SELECT ${cat} AS cat, to_char(ev_cur ${K}, 'YYYY-MM') AS anchor_month, to_char(created ${K}, 'YYYY-MM') AS created_month, COUNT(*)::int AS deals, ROUND(SUM(price))::bigint AS sum FROM (${cur("$2")}) x WHERE manager_id IN (SELECT id FROM managers WHERE name ILIKE '%Семенюк%') GROUP BY 1,2,3 ORDER BY 1,2,3`, [FC, PAID]],
  ["Q4 Семенюк: угоди етапу 9 без події входу (до 20)", `SELECT kommo_id, status_id, ROUND(price)::bigint AS price, to_char(created ${K}, 'DD.MM.YYYY HH24:MI') AS created, ev_any FROM (${cur("$2")}) x WHERE manager_id IN (SELECT id FROM managers WHERE name ILIKE '%Семенюк%') AND ev_cur IS NULL ORDER BY created DESC LIMIT 20`, [FC, PAID]],
  ["Q5 компанія: етап 9 ЗАРАЗ за категорією", `SELECT ${cat} AS cat, COUNT(*)::int AS deals, ROUND(SUM(price))::bigint AS sum, to_char(MIN(created) ${K},'DD.MM.YYYY') AS min_created, to_char(MAX(created) ${K},'DD.MM.YYYY') AS max_created FROM (${cur("$2")}) x GROUP BY 1 ORDER BY 1`, [FC, PAID]],
  ["Q6 компанія: етап 8 ЗАРАЗ за категорією", `SELECT ${cat} AS cat, COUNT(*)::int AS deals, ROUND(SUM(price))::bigint AS sum, to_char(MIN(created) ${K},'DD.MM.YYYY') AS min_created, to_char(MAX(created) ${K},'DD.MM.YYYY') AS max_created FROM (${cur("$2")}) x GROUP BY 1 ORDER BY 1`, [FC, EXP]],
  ["Q7 етап 9 без події: за місяцем створення", `SELECT to_char(created ${K}, 'YYYY-MM') AS created_month, ${cat} AS cat, COUNT(*)::int AS deals, ROUND(SUM(price))::bigint AS sum FROM (${cur("$2")}) x WHERE ev_cur IS NULL GROUP BY 1,2 ORDER BY 1,2`, [FC, PAID]],
  ["Q8 етап 8 без події: за місяцем створення", `SELECT to_char(created ${K}, 'YYYY-MM') AS created_month, ${cat} AS cat, COUNT(*)::int AS deals, ROUND(SUM(price))::bigint AS sum FROM (${cur("$2")}) x WHERE ev_cur IS NULL GROUP BY 1,2 ORDER BY 1,2`, [FC, EXP]],
  ["Q9 «Оплата отримана» по місяцях: зараз (є подія) → після фіксу (+створені одразу, за датою створення)", `SELECT to_char(COALESCE(ev_cur, CASE WHEN ev_any = 0 THEN created END) ${K}, 'YYYY-MM') AS month,
      COUNT(*) FILTER (WHERE ev_cur IS NOT NULL)::int AS deals_now, ROUND(SUM(price) FILTER (WHERE ev_cur IS NOT NULL))::bigint AS sum_now,
      COUNT(*) FILTER (WHERE ev_cur IS NULL AND ev_any = 0)::int AS deals_added, ROUND(SUM(price) FILTER (WHERE ev_cur IS NULL AND ev_any = 0))::bigint AS sum_added
    FROM (${cur("$2")}) x WHERE COALESCE(ev_cur, CASE WHEN ev_any = 0 THEN created END) IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 8`, [FC, PAID]],
  ["Q10 «Очікуємо оплату» по місяцях: зараз → після фіксу", `SELECT to_char(COALESCE(ev_cur, CASE WHEN ev_any = 0 THEN created END) ${K}, 'YYYY-MM') AS month,
      COUNT(*) FILTER (WHERE ev_cur IS NOT NULL)::int AS deals_now, ROUND(SUM(price) FILTER (WHERE ev_cur IS NOT NULL))::bigint AS sum_now,
      COUNT(*) FILTER (WHERE ev_cur IS NULL AND ev_any = 0)::int AS deals_added, ROUND(SUM(price) FILTER (WHERE ev_cur IS NULL AND ev_any = 0))::bigint AS sum_added
    FROM (${cur("$2")}) x WHERE COALESCE(ev_cur, CASE WHEN ev_any = 0 THEN created END) IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 8`, [FC, EXP]],
  ["Q11 листопад «Оплата отримана» по менеджерах: зараз → +додані", `SELECT m.name, COUNT(*) FILTER (WHERE ev_cur IS NOT NULL)::int AS deals_now, ROUND(SUM(price) FILTER (WHERE ev_cur IS NOT NULL))::bigint AS sum_now,
      COUNT(*) FILTER (WHERE ev_cur IS NULL)::int AS deals_added, ROUND(SUM(price) FILTER (WHERE ev_cur IS NULL))::bigint AS sum_added
    FROM (${cur("$2")}) x JOIN managers m ON m.id = x.manager_id
   WHERE (COALESCE(ev_cur, CASE WHEN ev_any = 0 THEN created END) ${K})::date BETWEEN '2026-11-01' AND '2026-11-30'
   GROUP BY 1 HAVING COUNT(*) FILTER (WHERE ev_cur IS NULL) > 0 ORDER BY 5 DESC`, [FC, PAID]],
  ["Q12 «з рахунку» (екран Клієнтів): не-142 угоди в етапах від рахунку без жодної події туди", `SELECT ${cat.replace(/ev_cur/g, 'ev_cur')} AS cat, COUNT(*)::int AS deals, ROUND(SUM(price))::bigint AS sum FROM (
      SELECT d.kommo_id, d.price, d.created_at_kommo AS created,
             (SELECT MIN(e.changed_at) FROM deal_stage_events e WHERE e.kommo_id = d.kommo_id AND e.pipeline_id = ANY($1) AND e.status_id = ANY($2)) AS ev_cur,
             (SELECT COUNT(*) FROM deal_stage_events e WHERE e.kommo_id = d.kommo_id)::int AS ev_any
        FROM deals d WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2) AND d.status_id <> 142) x GROUP BY 1 ORDER BY 1`, [FC, FROM_INV]],
];
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  try {
    for (const [name, sql, p] of Q) {
      const t = Date.now();
      const r = await c.query(sql, p);
      console.log(`\n### ${name}  (${r.rowCount} рядків, ${Date.now() - t} мс)`);
      console.table(r.rows);
    }
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
})().catch((e) => { console.error("ПОМИЛКА:", e.message); process.exit(1); });
