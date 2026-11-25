// Замір 25.11.2026 (вимога Тетяни «по звільнених»). ЛИШЕ ЧИТАННЯ: BEGIN READ ONLY … ROLLBACK. Сум і карт не друкує.
// (1) Звільнені в «Наймі» з 01.09.2026, які є в «Зарплаті»: чи оформлено звільнення в «Зарплаті», чи активний акаунт,
//     скільки угод «Успішно реалізовано» (142, повний цикл) у місяці звільнення і в попередньому, скільки підписів обхідного.
// (2) Люди в «Зарплаті» без звільнення, але з вимкненим акаунтом дашборда (кандидати на «видалено акаунт»).
// Запуск: cd <repo>/backend && nice -n 20 node ../docs/sql/zvilneni-2026-11-25.cjs
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require(path.join(process.cwd(), "node_modules", "pg"));
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const DEALS = (shift) => `(SELECT COUNT(*)::int FROM deals d WHERE d.manager_id = u.manager_id AND d.status_id = 142
     AND d.pipeline_id IN (8921932, 155304) AND d.closed_at_kommo IS NOT NULL
     AND to_char((d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM') = to_char(e.dismissed_at - interval '${shift} month', 'YYYY-MM'))`;
const Q = {
  "(1) звільнені в «Наймі» з 01.09, які є в «Зарплаті»": `SELECT pe.user_id, e.full_name, e.position, COALESCE(u.role_override, u.role) AS role,
      to_char(e.dismissed_at, 'YYYY-MM-DD') AS naim_dismissed, to_char(l.leave_date, 'YYYY-MM-DD') AS zp_leave, l.leave_type,
      u.is_active, (u.manager_id IS NOT NULL) AS has_kommo,
      ${DEALS(0)} AS deals_leave_month, ${DEALS(1)} AS deals_prev_month,
      (SELECT COUNT(*)::int FROM payroll_clearance_signatures s JOIN payroll_clearances k ON k.id = s.clearance_id WHERE k.user_id = pe.user_id) AS signatures
    FROM employees e JOIN payroll_employees pe ON pe.user_id = e.user_id JOIN users u ON u.id = e.user_id
    LEFT JOIN payroll_leaves l ON l.user_id = pe.user_id
    WHERE e.status = 'dismissed' AND e.dismissed_at >= '2026-09-01'
      AND e.id = (SELECT max(x.id) FROM employees x WHERE x.user_id = e.user_id)
    ORDER BY e.dismissed_at, e.full_name`,
  "(2) у «Зарплаті» без звільнення, акаунт вимкнено": `SELECT pe.user_id, COALESCE(u.role_override, u.role) AS role, u.is_active, (u.manager_id IS NOT NULL) AS has_kommo,
      (SELECT e.status FROM employees e WHERE e.user_id = pe.user_id ORDER BY e.id DESC LIMIT 1) AS naim_status
    FROM payroll_employees pe JOIN users u ON u.id = pe.user_id
    WHERE NOT u.is_active AND NOT EXISTS (SELECT 1 FROM payroll_leaves l WHERE l.user_id = pe.user_id) ORDER BY pe.user_id`,
  "(3) усього: у «Зарплаті» / з оформленим звільненням": `SELECT (SELECT COUNT(*)::int FROM payroll_employees) AS in_payroll, (SELECT COUNT(*)::int FROM payroll_leaves) AS with_leave`,
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
