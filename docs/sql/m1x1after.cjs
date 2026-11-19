// Приймання викату «записи 1×1 на картці Найму» (19.11.2026): READ ONLY.
// Запуск: cd <repo>/backend && nice -n 20 node /tmp/m1x1after.cjs
// Очікування: ключ — subject_employee_id,type,meeting_date; 129 записів, без картки 0; 33 задачі, без картки 0.
// Нічого не пише: BEGIN READ ONLY … ROLLBACK. Телефонів, дат народження, паролів не читає.
const { Client } = require(process.cwd() + "/node_modules/pg");
const fs = require("fs");
if (!process.env.DATABASE_URL) {
  for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = l.match(/^DATABASE_URL=(.*)$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}
const Q = {
  pk: `SELECT string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum)) AS cols
     FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'one_on_ones'::regclass AND c.contype = 'p'`,
  records: `SELECT type, count(*)::int AS records, count(*) FILTER (WHERE subject_employee_id IS NULL)::int AS no_card,
       count(*) FILTER (WHERE subject_manager_id IS NULL)::int AS without_kommo,
       count(DISTINCT subject_employee_id)::int AS people
     FROM one_on_ones GROUP BY ROLLUP(type) ORDER BY type NULLS LAST`,
  // Запис і його картка кажуть про ту саму людину: менеджер запису — пара картки (напряму чи через акаунт).
  mismatch: `SELECT count(*)::int AS n FROM one_on_ones o JOIN employees e ON e.id=o.subject_employee_id
     LEFT JOIN users eu ON eu.id=e.user_id
    WHERE o.subject_manager_id IS NOT NULL AND o.subject_manager_id IS DISTINCT FROM COALESCE(e.manager_id, eu.manager_id)`,
  tasks: `SELECT count(*)::int AS tasks, count(*) FILTER (WHERE o2o_employee_id IS NULL)::int AS no_card,
       count(*) FILTER (WHERE assignee_user_id IS NOT NULL)::int AS to_account
     FROM tasks WHERE task_type='oneonone'`,
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
