// 8345 замір: READ ONLY. Що буде, якщо задача клієнту ЗАВЖДИ створює нову угоду. Запуск: cd <repo>/backend && node /tmp/m8345.cjs
const { Client } = require(process.cwd() + "/node_modules/pg");
const fs = require("fs");
if (!process.env.DATABASE_URL) { for (const l of fs.readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^DATABASE_URL=(.*)$/); if (m) process.env.DATABASE_URL = m[1].replace(/^["\x27]|["\x27]$/g, ""); } }
const KY = "AT TIME ZONE 'Europe/Kyiv'";
const Q = {
  // 0. Існування предмета: скільки кроків узагалі і з якого дня колонки kommo_* заповнюються.
  exist: `SELECT count(*)::int AS steps, count(*) FILTER (WHERE kommo_task_id IS NOT NULL)::int AS in_kommo,
                 min(kommo_pushed_at ${KY})::text AS first_push, max(kommo_pushed_at ${KY})::text AS last_push FROM client_next_steps`,
  // 1. Куди лягли задачі з 12.11: у знайдену відкриту угоду чи в нову.
  split: `SELECT kommo_lead_created AS created, count(*)::int AS n, count(DISTINCT client_key)::int AS clients
            FROM client_next_steps WHERE kommo_task_id IS NOT NULL GROUP BY 1 ORDER BY 1`,
  // 2. Відкриті угоди, в які лягла задача: на якому етапі вони зараз (pipeline:status).
  openStage: `SELECT d.pipeline_id::text || ':' || d.status_id::text AS stage, count(*)::int AS n
                FROM client_next_steps s JOIN deals d ON d.kommo_id = s.kommo_lead_id
               WHERE s.kommo_task_id IS NOT NULL AND NOT s.kommo_lead_created GROUP BY 1 ORDER BY 2 DESC`,
  // 3. Угоди, створені дашбордом: де вони зараз і скільки дійшли до грошей.
  createdNow: `SELECT d.pipeline_id::text || ':' || d.status_id::text AS stage, count(*)::int AS n,
                      count(*) FILTER (WHERE psm.funnel_stage = 'paid')::int AS paid
                 FROM client_next_steps s JOIN deals d ON d.kommo_id = s.kommo_lead_id
                 LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
                WHERE s.kommo_lead_created GROUP BY 1 ORDER BY 2 DESC`,
  createdNotInDeals: `SELECT count(*)::int AS n FROM client_next_steps s
                       WHERE s.kommo_lead_created AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.kommo_id = s.kommo_lead_id)`,
  // 4. Темп: кроків на день (з 12.11) — скільки нових угод на день дасть правило «завжди нова».
  perDay: `SELECT to_char((created_at ${KY})::date, 'YYYY-MM-DD') AS day, count(*)::int AS steps,
                  count(*) FILTER (WHERE kommo_lead_created)::int AS new_now, count(DISTINCT client_key)::int AS clients
             FROM client_next_steps WHERE (created_at ${KY})::date >= '2026-11-12' GROUP BY 1 ORDER BY 1`,
  // 5. Повтори: скільки кроків на одного клієнта з 12.11 (кожен повтор = ще одна угода за «завжди нова»).
  repeats: `SELECT n_steps, count(*)::int AS clients FROM (
              SELECT client_key, count(*)::int AS n_steps FROM client_next_steps
               WHERE (created_at ${KY})::date >= '2026-11-12' GROUP BY 1) x GROUP BY 1 ORDER BY 1`,
  // 6. Для порівняння: «Створено» Повного циклу 8921932 за ті самі дні (усі угоди, як у Звіті).
  createdFc: `SELECT to_char((created_at_kommo ${KY})::date, 'YYYY-MM-DD') AS day, count(*)::int AS created
                FROM deals WHERE pipeline_id = 8921932 AND (created_at_kommo ${KY})::date >= '2026-11-12' GROUP BY 1 ORDER BY 1`,
  // 7. У скількох клієнтів з кроком є відкрита угода прямо зараз (за дзеркалом) — саме вони отримають дубль.
  openNow: `SELECT count(DISTINCT s.client_key)::int AS clients_with_step,
                   count(DISTINCT s.client_key) FILTER (WHERE EXISTS (
                     SELECT 1 FROM deals d WHERE d.client_key = s.client_key AND d.status_id NOT IN (142, 143)))::int AS with_open_deal
              FROM client_next_steps s WHERE s.done_at IS NULL`,
  // 8. Черга й помилки.
  queue: `SELECT count(*) FILTER (WHERE kommo_task_id IS NULL AND kommo_error IS NULL)::int AS waiting,
                 count(*) FILTER (WHERE kommo_task_id IS NULL AND kommo_error IS NOT NULL)::int AS with_error
            FROM client_next_steps WHERE done_at IS NULL`,
  errors: `SELECT kommo_error, count(*)::int AS n FROM client_next_steps
            WHERE done_at IS NULL AND kommo_task_id IS NULL AND kommo_error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
  // 9. Андрій (16.11 «не бачить нової угоди»): його кроки з 12.11 і куди вони лягли.
  andrii: `SELECT m.name, to_char((s.created_at ${KY}), 'YYYY-MM-DD HH24:MI') AS at, s.client_key, s.kommo_lead_id::text AS lead,
                  s.kommo_lead_created AS created, d.pipeline_id::text || ':' || d.status_id::text AS lead_stage, left(s.kommo_error, 80) AS err
             FROM client_next_steps s JOIN users u ON u.id = s.created_by JOIN managers m ON m.id = u.manager_id
             LEFT JOIN deals d ON d.kommo_id = s.kommo_lead_id
            WHERE m.name ILIKE 'Андрі%' AND (s.created_at ${KY})::date >= '2026-11-12' ORDER BY s.created_at LIMIT 40`,
  // 10. Текст задачі 8345 у задачнику (щоб звірити, що саме просила Юля) і коментарі.
  task: `SELECT id, title, status, left(comments, 3000) AS comments FROM tasks WHERE id = 8345`,
  taskComments: `SELECT c.id, to_char(c.created_at ${KY}, 'YYYY-MM-DD HH24:MI') AS at, COALESCE(u.full_name, u.email) AS who, left(c.body, 1500) AS body
                   FROM task_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.task_id = 8345 ORDER BY c.created_at`,
};
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query("BEGIN READ ONLY");
  for (const [k, sql] of Object.entries(Q)) {
    try { const r = await c.query(sql); console.log(`\n=== ${k} (${r.rows.length} рядків)`); console.log(JSON.stringify(r.rows, null, 1)); }
    catch (e) { console.log(`\n=== ${k} ПОМИЛКА ${e.message}`); await c.query("ROLLBACK"); await c.query("BEGIN READ ONLY"); }
  }
  await c.query("ROLLBACK"); await c.end();
})().catch((e) => { console.error("ПОМИЛКА", e.message); process.exit(1); });
