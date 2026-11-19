// Замір «записи 1×1 на людині Найму» (19.11.2026, план міграції): READ ONLY.
// Запуск: cd <repo>/backend && nice -n 20 node /tmp/m1x1emp.cjs
// Нічого не пише: BEGIN READ ONLY … ROLLBACK. Телефонів, дат народження, паролів не читає.
const { Client } = require(process.cwd() + "/node_modules/pg");
const fs = require("fs");
if (!process.env.DATABASE_URL) {
  for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = l.match(/^DATABASE_URL=(.*)$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}
// Картки Найму менеджера: напряму або через акаунт — той самий зв'язок, що в ROSTER_SQL.
const CARDS = (a) => `(SELECT array_agg(e.id || ':' || e.status ORDER BY e.id) FROM employees e LEFT JOIN users eu ON eu.id=e.user_id
   WHERE e.manager_id=${a} OR eu.manager_id=${a})`;
const Q = {
  // 1. Чи кожен запис 1×1 можна однозначно перенести на картку Найму.
  recordsBackfill: `SELECT
       count(*)::int AS records,
       count(*) FILTER (WHERE cards IS NULL)::int AS no_card,
       count(*) FILTER (WHERE cardinality(cards) = 1)::int AS one_card,
       count(*) FILTER (WHERE cardinality(cards) > 1)::int AS many_cards
     FROM (SELECT o.*, ${CARDS("o.subject_manager_id")} AS cards FROM one_on_ones o) x`,
  recordsAmbiguous: `SELECT o.subject_manager_id, m.name, count(*)::int AS records, ${CARDS("o.subject_manager_id")} AS cards
     FROM one_on_ones o JOIN managers m ON m.id=o.subject_manager_id
    GROUP BY 1,2 HAVING ${CARDS("o.subject_manager_id")} IS NULL OR cardinality(${CARDS("o.subject_manager_id")}) <> 1
    ORDER BY 2`,
  // 2. Задачі з 1×1: виконавець — менеджер Kommo; скільки їх і чи перенесуться.
  tasks: `SELECT count(*)::int AS tasks, count(*) FILTER (WHERE o2o_resolution IS NULL AND status<>'done')::int AS open,
       count(*) FILTER (WHERE ${CARDS("t.assignee_id")} IS NULL)::int AS assignee_no_card,
       count(*) FILTER (WHERE assignee_id IS NULL)::int AS no_assignee
     FROM tasks t WHERE task_type='oneonone'`,
  // 3. Люди без Kommo: чи є в них акаунт дашборду (задачу можна дати акаунту, assignee_user_id).
  noKommo: `SELECT e.id, e.full_name, e.position, e.status, e.user_id IS NOT NULL AS has_account,
       u.is_active AS account_active, COALESCE(u.role_override, u.role) AS role, u.manager_id AS account_manager
     FROM employees e LEFT JOIN users u ON u.id=e.user_id
    WHERE e.status IN ('active','finishing') AND COALESCE(e.manager_id, u.manager_id) IS NULL
    ORDER BY e.full_name`,
  // 4. Хто може проводити «HR→Всі» (право view_all_1x1) — і роль акаунта Романова Івана (питання 4).
  crossviewRoles: `SELECT key, name, data_scope, (permissions->>'view_all_1x1')::boolean AS view_all_1x1,
       (permissions->>'edit_1x1_forms')::boolean AS edit_forms
     FROM roles WHERE (permissions->>'view_all_1x1')::boolean ORDER BY key`,
  ivan: `SELECT u.id, u.email, u.is_active, u.role, u.role_override, r.name AS role_name,
       (r.permissions->>'view_all_1x1')::boolean AS view_all_1x1, e.full_name
     FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN roles r ON r.key=COALESCE(u.role_override, u.role)
    WHERE e.full_name ILIKE 'Романов%'`,
  // 5. Хто ще посилається на one_on_ones / tasks.assignee_id з FK (що зачепить зміна ключа).
  fks: `SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE confrelid IN ('one_on_ones'::regclass) OR conrelid='one_on_ones'::regclass ORDER BY 1,2`,
};

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN READ ONLY");
    const ex = (await c.query(`SELECT (SELECT count(*) FROM one_on_ones)::int AS o, (SELECT count(*) FROM employees)::int AS e,
       (SELECT count(*) FROM tasks WHERE task_type='oneonone')::int AS t`)).rows[0];
    console.log("EXISTS", JSON.stringify(ex));
    if (!ex.o || !ex.e) throw new Error("порожня таблиця — числам нижче не вірити");
    for (const [k, sql] of Object.entries(Q)) {
      try {
        const r = await c.query(sql);
        console.log(`\n=== ${k}: ${r.rows.length} рядків`);
        if (r.rows.length) console.table(r.rows.slice(0, 80));
      } catch (e) { console.log(`\n=== ${k}: ПОМИЛКА ${e.message}`); }
    }
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
