// Задача 10723 (Тетяна, вкладка «Зарплата»): замір ЛИШЕ ЧИТАННЯМ (BEGIN READ ONLY … ROLLBACK). Нічого не пише.
// Запуск — з теки backend прод-чекауту або стенду (потрібні лише .env і node_modules/pg, dist не потрібен):
//   cd <repo>/backend && nice -n 20 node /tmp/m10723.cjs
// Секретів не друкує. Друкує імена, посади, команди, дати звільнення, суми ДН. Дат народження НЕ друкує.
//
// Що міряє (план — /mnt/project-files/plans/10723-zarplata-plan.md):
//   Z0  скільки людей у «Зарплаті» і в «Наймі»
//   Z1  у «Зарплаті» без звільнення, а в «Наймі» звільнені (або акаунт вимкнено) — їм рушій далі рахує ЗП і збір на ДН
//   Z2  у «Наймі» працюють, а в «Зарплаті» їх немає (приклад з ТЗ — Олександр Тищенко); окремо — без акаунта
//   Z3  команди «Зарплати»: назва (рукою) проти команди Kommo і тім-ліда; хто тім-лід зараз
//   Z4  рівень «Старт/Профі»: «Зарплата» (payroll_terms) проти «Найму» (employee_levels) — розбіжності
//   Z5  задачі рекрутеру «Перепідписати офер»: скільки, чому, підписано / анульовано / відкрито
//   Z6  дні народження: чинне правило проти правила з ТЗ, по місяцях листопад 2026 … жовтень 2027
//   Z7  одноразові рядки фінансиста («Премія», «Корекція ±», «Утримання», «Податки») — чи ними вже користуються
const fs = require("node:fs");
const { createRequire } = require("node:module");
const req = createRequire(process.cwd() + "/package.json");
const { Client } = req("pg");
if (fs.existsSync(".env")) for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const show = (title, rows) => {
  console.log(`\n── ${title} (${rows.length})`);
  for (const r of rows) console.log("  " + Object.values(r).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null ? "∅" : v)).join(" | "));
};
const NAME = `COALESCE(m.name, (SELECT e.full_name FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1), u.full_name, u.email)`;
const NJOIN = `LEFT JOIN managers m ON m.id = u.manager_id`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  try {
    const today = (await c.query(`SELECT (now() AT TIME ZONE 'Europe/Kyiv')::date::text AS d`)).rows[0].d;
    const live = today.slice(0, 7);
    console.log("сьогодні (Київ):", today, "· живий місяць", live);

    // ── Z0. Існування предмета ДО чисел (правило 15)
    show("Z0 обсяги", (await c.query(`
      SELECT (SELECT COUNT(*) FROM payroll_employees)::int AS zp_vsogo,
             (SELECT COUNT(*) FROM payroll_leaves)::int AS zp_zi_zvilnenniam,
             (SELECT COUNT(*) FROM employees WHERE status = 'active')::int AS naim_pratsyuyut,
             (SELECT COUNT(*) FROM employees WHERE status = 'dismissed')::int AS naim_zvilneni,
             (SELECT COUNT(*) FROM employees WHERE status = 'active' AND user_id IS NULL)::int AS naim_pratsyuyut_bez_akauntu`)).rows);

    // ── Z1. «Зарплата» вважає працюючим, «Найм» — звільненим (або акаунт вимкнено)
    show("Z1 у Зарплаті без звільнення, але Найм каже «звільнений» або акаунт вимкнено: імʼя | роль | команда | Найм статус | Найм дата звільнення | акаунт активний", (await c.query(`
      SELECT ${NAME} AS name, pe.role, pe.team_code, e.status AS naim_status, e.dismissed_at, u.is_active
        FROM payroll_employees pe JOIN users u ON u.id = pe.user_id ${NJOIN}
        LEFT JOIN LATERAL (SELECT * FROM employees x WHERE x.user_id = pe.user_id ORDER BY x.id DESC LIMIT 1) e ON true
       WHERE NOT EXISTS (SELECT 1 FROM payroll_leaves l WHERE l.user_id = pe.user_id)
         AND (e.status = 'dismissed' OR NOT u.is_active)
       ORDER BY e.dismissed_at NULLS LAST, 1`)).rows);
    show("Z1b у Зарплаті, але в Наймі запису з цим акаунтом немає: імʼя | роль | відділ", (await c.query(`
      SELECT ${NAME} AS name, pe.role, pe.dept_code
        FROM payroll_employees pe JOIN users u ON u.id = pe.user_id ${NJOIN}
       WHERE NOT EXISTS (SELECT 1 FROM employees x WHERE x.user_id = pe.user_id) ORDER BY 1`)).rows);
    show("Z1c звільнені в Зарплаті (обхідний лист): імʼя | дата | тип | Найм статус", (await c.query(`
      SELECT ${NAME} AS name, l.leave_date, l.leave_type, e.status AS naim_status
        FROM payroll_leaves l JOIN users u ON u.id = l.user_id ${NJOIN}
        LEFT JOIN LATERAL (SELECT * FROM employees x WHERE x.user_id = l.user_id ORDER BY x.id DESC LIMIT 1) e ON true
       ORDER BY l.leave_date`)).rows);

    // ── Z2. «Найм» каже «працює», у «Зарплаті» немає
    show("Z2 працюють у Наймі, у Зарплаті немає, акаунт Є: імʼя | посада | команда (Найм) | категорія | роль акаунта | акаунт активний", (await c.query(`
      SELECT e.full_name, e.position, e.team_label, e.category, COALESCE(u.role_override, u.role) AS role, u.is_active
        FROM employees e JOIN users u ON u.id = e.user_id
       WHERE e.status = 'active' AND NOT EXISTS (SELECT 1 FROM payroll_employees pe WHERE pe.user_id = e.user_id)
       ORDER BY e.team_label NULLS LAST, e.full_name`)).rows);
    show("Z2b працюють у Наймі БЕЗ акаунта (у Зарплату їх зараз не додати взагалі): імʼя | посада | команда", (await c.query(`
      SELECT e.full_name, e.position, e.team_label FROM employees e
       WHERE e.status = 'active' AND e.user_id IS NULL ORDER BY e.team_label NULLS LAST, e.full_name`)).rows);
    show("Z2c пошук «Тищенко» у Наймі й акаунтах: джерело | імʼя | статус/активний | посада | у Зарплаті", (await c.query(`
      SELECT 'naim' AS src, e.full_name AS name, e.status AS st, e.position, EXISTS (SELECT 1 FROM payroll_employees pe WHERE pe.user_id = e.user_id) AS in_zp
        FROM employees e WHERE e.full_name ILIKE '%тищенко%'
      UNION ALL
      SELECT 'user', COALESCE(u.full_name, u.email), u.is_active::text, COALESCE(u.role_override, u.role), EXISTS (SELECT 1 FROM payroll_employees pe WHERE pe.user_id = u.id)
        FROM users u WHERE COALESCE(u.full_name, '') ILIKE '%тищенко%'`)).rows);

    // ── Z3. Команди «Зарплати»
    show("Z3 команди Зарплати: код | назва (рукою) | офер | команда Kommo | тім-лід у Зарплаті | його звільнення | людей без звільнення", (await c.query(`
      SELECT t.code, t.name, t.offer_code, k.name AS kommo_team,
             (SELECT ${NAME} FROM payroll_employees pe JOIN users u ON u.id = pe.user_id ${NJOIN} WHERE pe.role = 'lead' AND pe.leads_team_code = t.code) AS lead,
             (SELECT l.leave_date FROM payroll_employees pe JOIN payroll_leaves l ON l.user_id = pe.user_id WHERE pe.role = 'lead' AND pe.leads_team_code = t.code) AS lead_leave,
             (SELECT COUNT(*) FROM payroll_employees pe WHERE pe.team_code = t.code AND NOT EXISTS (SELECT 1 FROM payroll_leaves l WHERE l.user_id = pe.user_id))::int AS people
        FROM payroll_teams t LEFT JOIN teams k ON k.id = t.kommo_team_id ORDER BY t.dept_code, t.name`)).rows);
    show("Z3b відділи Зарплати: код | назва | продає | людей без звільнення", (await c.query(`
      SELECT d.code, d.name, d.is_sales,
             (SELECT COUNT(*) FROM payroll_employees pe WHERE pe.dept_code = d.code AND NOT EXISTS (SELECT 1 FROM payroll_leaves l WHERE l.user_id = pe.user_id))::int AS people
        FROM payroll_departments d ORDER BY d.code`)).rows);

    // ── Z4. Рівень: «Зарплата» проти «Найму»
    const zpLvl = (await c.query(`
      SELECT pe.user_id, ${NAME} AS name,
             (SELECT t.level FROM payroll_terms t WHERE t.user_id = pe.user_id AND t.level IS NOT NULL AND t.valid_from <= $1::date ORDER BY t.valid_from DESC, t.id DESC LIMIT 1) AS zp_now,
             (SELECT t.level || ' з ' || to_char(t.valid_from, 'YYYY-MM') FROM payroll_terms t WHERE t.user_id = pe.user_id AND t.level IS NOT NULL AND t.valid_from > $1::date ORDER BY t.valid_from, t.id LIMIT 1) AS zp_next,
             e.id AS emp_id
        FROM payroll_employees pe JOIN users u ON u.id = pe.user_id ${NJOIN}
        LEFT JOIN LATERAL (SELECT * FROM employees x WHERE x.user_id = pe.user_id ORDER BY x.id DESC LIMIT 1) e ON true
       WHERE pe.role = 'manager' AND NOT EXISTS (SELECT 1 FROM payroll_leaves l WHERE l.user_id = pe.user_id)`, [`${live}-01`])).rows;
    const nl = (await c.query(`SELECT employee_id, level, to_char(from_month, 'YYYY-MM') AS mk, id FROM employee_levels WHERE cancelled_at IS NULL ORDER BY from_month DESC, id DESC`)).rows;
    const naimNow = (empId) => { const r = nl.find((x) => x.employee_id === empId && x.mk <= live); return r ? (r.level === "pro" ? "profi" : "start") : "start"; };
    const naimNext = (empId) => { const r = nl.find((x) => x.employee_id === empId && x.mk > live); return r ? `${r.level === "pro" ? "profi" : "start"} з ${r.mk}` : null; };
    const lvRows = zpLvl.map((r) => ({ name: r.name, zp: r.zp_now ?? "start", zpNext: r.zp_next, naim: r.emp_id == null ? "нема в Наймі" : naimNow(r.emp_id), naimNext: r.emp_id == null ? null : naimNext(r.emp_id) }));
    console.log(`\nZ4 менеджерів у Зарплаті без звільнення: ${lvRows.length}; записів employee_levels (нескасованих): ${nl.length}`);
    show("Z4 рівень розходиться: імʼя | Зарплата зараз | Зарплата далі | Найм зараз | Найм далі", lvRows.filter((r) => r.zp !== r.naim || (r.zpNext ?? "") !== (r.naimNext ?? "")));

    // ── Z5. Задачі «Перепідписати офер»
    show("Z5 задачі рекрутеру: чому | підписано | анульовано | відкрито", (await c.query(`
      SELECT COALESCE(why, '∅') AS why, COUNT(*) FILTER (WHERE signed_at IS NOT NULL)::int AS signed,
             COUNT(*) FILTER (WHERE void_at IS NOT NULL)::int AS void, COUNT(*) FILTER (WHERE signed_at IS NULL AND void_at IS NULL)::int AS open
        FROM payroll_offer_docs GROUP BY 1 ORDER BY 1`)).rows);

    // ── Z6. Дні народження: чинне правило рушія проти правила з ТЗ
    const emp = (await c.query(`
      SELECT pe.user_id, ${NAME} AS name, pe.role, to_char(pe.start_date, 'YYYY-MM-DD') AS start, pe.birthday_md AS bd, to_char(l.leave_date, 'YYYY-MM') AS leave_mk
        FROM payroll_employees pe JOIN users u ON u.id = pe.user_id ${NJOIN} LEFT JOIN payroll_leaves l ON l.user_id = pe.user_id`)).rows;
    console.log(`\nZ6 у Зарплаті без дня народження: ${emp.filter((x) => !x.bd).length} з ${emp.length}`);
    const employedIn = (e, mk) => e.start.slice(0, 7) <= mk && !(e.leave_mk && e.leave_mk < mk);
    const tenure = (start, iso) => { const [sy, sm, sd] = start.split("-").map(Number), [y, m, d] = iso.split("-").map(Number); return Math.max(0, (y - sy) * 12 + (m - sm) - (d < sd ? 1 : 0)); };
    const months = []; for (let y = 2026, m = 11, i = 0; i < 12; i++) { months.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
    const rows6 = [], people6 = [];
    for (const mk of months) {
      const on = emp.filter((e) => employedIn(e, mk));
      const bd = on.filter((e) => e.bd && e.bd.slice(0, 2) === mk.slice(5));
      let oldGift = 0, oldCompany = 0, oldCollected = 0, newGift = 0;
      for (const b of bd) {
        const t = tenure(b.start, `${mk}-${b.bd.slice(3)}`), young = t < 12, company = b.role === "lead" ? 600 : 400;
        const givers = young ? 0 : on.length - 1;
        const o = young ? t * 100 + company : givers * 100 + company;
        const n = young ? t * 100 + company : 1200 + company;
        oldGift += o; oldCompany += company; oldCollected += young ? 0 : givers * 100; newGift += n;
        if (mk <= "2026-12") people6.push({ mk, name: b.name, role: b.role, tenureMonths: t, old: o, new: n });
      }
      rows6.push({ mk, employed: on.length, birthdays: bd.length, young: bd.filter((b) => tenure(b.start, `${mk}-${b.bd.slice(3)}`) < 12).length,
        oldGifts: oldGift, oldCollectedFromStaff: oldCollected, newGifts: newGift, newCollectedFromStaff: on.length * 100 });
    }
    show("Z6 по місяцях: місяць | працює | іменинників | з них стаж < року | ДН зараз: подарунки всього | зараз: зібрано з колег | ТЗ: подарунки всього | ТЗ: 100 ₴ × усі", rows6);
    show("Z6b іменинники листопада й грудня: місяць | імʼя | роль | стаж, міс | зараз ₴ | за ТЗ ₴", people6);

    // ── Z7. Одноразові рядки фінансиста
    show("Z7 рядки «Премії, утримання» у Перевірці: місяць | вид | скільки | сума", (await c.query(`
      SELECT to_char(r.month, 'YYYY-MM') AS mk, x.kind, COUNT(*)::int AS n, SUM(x.amount)::numeric(12,2) AS sum
        FROM payroll_record_extras x JOIN payroll_records r ON r.id = x.record_id
       WHERE x.deleted_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2`)).rows);
    show("Z7b закриті місяці", (await c.query(`SELECT to_char(month, 'YYYY-MM') AS mk, status, closed_at FROM payroll_months ORDER BY month`)).rows);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
})().catch((e) => { console.error("ПОМИЛКА:", e.message); process.exit(1); });
