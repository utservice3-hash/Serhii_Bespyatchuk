// Замір «1x1 ↔ Найм» (19.11.2026): READ ONLY. Запуск: cd <repo>/backend && nice -n 20 node /tmp/m1x1.cjs
// Нічого не пише: BEGIN READ ONLY … ROLLBACK. Телефонів, дат народження, паролів не читає.
const { Client } = require(process.cwd() + "/node_modules/pg");
const fs = require("fs");
if (!process.env.DATABASE_URL) {
  for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = l.match(/^DATABASE_URL=(.*)$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}

// «Працює» для 1×1 — дзеркало SUBJECT_WORKS (routes/oneOnOnes.ts): накладка dismissed або обидва прапорці активності → ні.
const WORKS = (a) => `(NOT EXISTS (SELECT 1 FROM manager_work_state w WHERE w.manager_id=${a}.id AND w.state='dismissed')
  AND ${a}.is_active
  AND NOT (EXISTS (SELECT 1 FROM users u WHERE u.manager_id=${a}.id)
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.manager_id=${a}.id AND u.is_active)))`;
// Людина реєстру ↔ менеджер Kommo: напряму (e.manager_id) або через акаунт (users.manager_id).
const EMP_OF = (a) => `(SELECT e.id FROM employees e LEFT JOIN users eu ON eu.id=e.user_id
   WHERE e.manager_id=${a}.id OR eu.manager_id=${a}.id ORDER BY (e.status='dismissed'), e.id LIMIT 1)`;

const Q = {
  summary: `SELECT
     (SELECT count(*)::int FROM managers m WHERE ${WORKS("m")}) AS roster_v,
     (SELECT count(*)::int FROM managers m WHERE ${WORKS("m")} AND m.is_team_lead) AS roster_b,
     (SELECT count(*)::int FROM managers) AS managers_all,
     (SELECT count(*)::int FROM employees WHERE status IN ('active','finishing')) AS emp_working,
     (SELECT count(*)::int FROM employees WHERE status='finishing') AS emp_finishing,
     (SELECT count(*)::int FROM employees) AS emp_all`,
  // 1) У ростері 1×1, але в Найм — нема людини або вона звільнена
  rosterVsHiring: `SELECT m.id, m.name, t.name AS kommo_team, m.is_team_lead, m.kommo_user_id IS NOT NULL AS has_kommo,
       e.id AS emp_id, e.full_name AS emp_name, e.status AS emp_status, e.position AS emp_position, e.category AS emp_cat
     FROM managers m LEFT JOIN teams t ON t.id=m.team_id
     LEFT JOIN employees e ON e.id = ${EMP_OF("m")}
    WHERE ${WORKS("m")}
    ORDER BY (e.id IS NULL) DESC, e.status, t.name NULLS LAST, m.name`,
  // 2) Працює в Найм, але не в ростері 1×1
  hiringNotInRoster: `SELECT e.id, e.full_name, e.status, e.position, e.category, e.team_label,
       to_char(e.hired_at,'YYYY-MM-DD') AS hired_at, e.candidate_id IS NOT NULL AS from_candidate,
       COALESCE(e.manager_id, eu.manager_id) AS mgr_id, m.name AS mgr_name, m.is_active AS mgr_kommo_active,
       (SELECT state FROM manager_work_state w WHERE w.manager_id=COALESCE(e.manager_id, eu.manager_id)) AS mws
     FROM employees e LEFT JOIN users eu ON eu.id=e.user_id
     LEFT JOIN managers m ON m.id=COALESCE(e.manager_id, eu.manager_id)
    WHERE e.status IN ('active','finishing')
      AND (m.id IS NULL OR NOT ${WORKS("m")})
    ORDER BY (m.id IS NULL) DESC, e.position NULLS LAST, e.full_name`,
  // 3) Команда в 1×1 (managers.team_id) ≠ команда в Найм (картка/дашборд)
  teamMismatch: `SELECT m.id, m.name, tk.name AS team_1x1, e.full_name, e.team_label,
       tc.name AS card_team, dt.name AS dash_team
     FROM managers m JOIN employees e ON e.id = ${EMP_OF("m")}
     LEFT JOIN teams tk ON tk.id=m.team_id LEFT JOIN teams tc ON tc.id=e.team_id
     LEFT JOIN dashboard_teams dt ON dt.id=e.dashboard_team_id
    WHERE ${WORKS("m")} AND (
      (e.team_id IS NOT NULL AND e.team_id IS DISTINCT FROM m.team_id)
      OR (e.dashboard_team_id IS NOT NULL AND dt.kommo_team_id IS DISTINCT FROM m.team_id))
    ORDER BY m.name`,
  // 4) Тімліди: 1×1 тип Б бере managers.is_team_lead; Найм — категорія/посада
  leads: `SELECT m.id, m.name, t.name AS team, m.is_team_lead, ${WORKS("m")} AS works,
       e.full_name, e.position, e.category, e.status
     FROM managers m LEFT JOIN teams t ON t.id=m.team_id LEFT JOIN employees e ON e.id = ${EMP_OF("m")}
    WHERE (m.is_team_lead AND ${WORKS("m")}) OR e.category='teamlead' OR e.position ILIKE '%тім%лід%' OR e.position ILIKE '%тимлід%' OR e.position ILIKE '%team%lead%'
    ORDER BY m.is_team_lead DESC, m.name`,
  // 5) Записи 1×1: обсяг, і чиї субʼєкти зараз поза ростером / звільнені в Найм
  records: `SELECT o.type, count(*)::int AS n,
       count(*) FILTER (WHERE o.meeting_date >= current_date - 90)::int AS n90,
       count(DISTINCT o.subject_manager_id)::int AS subjects,
       count(*) FILTER (WHERE NOT ${WORKS("m")})::int AS subj_not_working,
       count(*) FILTER (WHERE e.id IS NULL)::int AS subj_no_employee,
       count(*) FILTER (WHERE e.status='dismissed')::int AS subj_emp_dismissed,
       min(o.meeting_date)::text AS first, max(o.meeting_date)::text AS last
     FROM one_on_ones o JOIN managers m ON m.id=o.subject_manager_id
     LEFT JOIN employees e ON e.id = ${EMP_OF("m")}
    GROUP BY o.type ORDER BY o.type`,
  conductors: `SELECT o.type, COALESCE(cm.name, u.email) AS who, u.role, u.role_override, count(*)::int AS n,
       max(o.meeting_date)::text AS last
     FROM one_on_ones o LEFT JOIN users u ON u.id=o.conducted_by LEFT JOIN managers cm ON cm.id=u.manager_id
    GROUP BY 1,2,3,4 ORDER BY 1, n DESC`,
  // 6) Форми: версії; записи, чия версія ≠ активна (екран проведення малює АКТИВНУ форму)
  forms: `SELECT type, version, is_active, created_at::text AS created_at,
       jsonb_array_length(questions->'sections') AS sections
     FROM one_on_one_forms ORDER BY type, version`,
  recVsForm: `WITH act AS (SELECT type, version FROM one_on_one_forms WHERE is_active),
     keys AS (SELECT f.type, f.version, array_agg(q->>'qKey') AS qk
                FROM one_on_one_forms f, jsonb_array_elements(f.questions->'sections') s, jsonb_array_elements(s->'questions') q
               GROUP BY f.type, f.version)
   SELECT o.type, o.form_version, a.version AS active_version, count(*)::int AS n,
       count(*) FILTER (WHERE o.answers <> '{}'::jsonb)::int AS with_answers,
       count(*) FILTER (WHERE o.answers <> '{}'::jsonb AND NOT EXISTS (
           SELECT 1 FROM jsonb_object_keys(o.answers) k WHERE k = ANY(ka.qk)))::int AS none_visible_on_active_form,
       count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM jsonb_object_keys(o.answers) k WHERE NOT (k = ANY(ka.qk))))::int AS some_hidden_on_active_form
     FROM one_on_ones o LEFT JOIN act a ON a.type=o.type LEFT JOIN keys ka ON ka.type=o.type AND ka.version=a.version
    GROUP BY 1,2,3 ORDER BY 1,2`,
  // 7) «Кістяки»: рев'ю задачі створило запис, а анкета порожня (відповіді не збережені)
  skeletons: `SELECT o.type, to_char(o.meeting_date,'YYYY-MM-DD') AS meeting_date, m.name AS subject,
       COALESCE(cm.name, u.email) AS conductor, o.updated_at::text AS updated_at,
       jsonb_array_length(COALESCE(o.task_reviews,'[]'::jsonb)) AS reviews,
       (o.answers='{}'::jsonb) AS answers_empty, o.satisfaction_score, o.enps_score
     FROM one_on_ones o JOIN managers m ON m.id=o.subject_manager_id
     LEFT JOIN users u ON u.id=o.conducted_by LEFT JOIN managers cm ON cm.id=u.manager_id
    WHERE o.answers='{}'::jsonb AND o.enps_score IS NULL
    ORDER BY o.meeting_date DESC LIMIT 40`,
  // 8) Рев'ю ПІСЛЯ останньої правки відповідей: updated_at сервера новіший — браузерна чернетка тоді НЕ відновлюється
  reviewAfter: `SELECT o.type, to_char(o.meeting_date,'YYYY-MM-DD') AS meeting_date, m.name AS subject,
       o.updated_at::text AS updated_at, (SELECT max((r->>'at')::timestamptz) FROM jsonb_array_elements(o.task_reviews) r)::text AS last_review,
       (o.answers='{}'::jsonb) AS answers_empty
     FROM one_on_ones o JOIN managers m ON m.id=o.subject_manager_id
    WHERE o.task_reviews IS NOT NULL AND jsonb_array_length(o.task_reviews) > 0
    ORDER BY o.meeting_date DESC LIMIT 40`,
  // 9) Відгуки про 1×1 у «Зворотному звʼязку»
  feedback: `SELECT f.id, f.created_at::date::text AS d, f.section, f.status, COALESCE(m.name,u.email) AS author,
       left(regexp_replace(f.message, '\\s+', ' ', 'g'), 400) AS msg
     FROM feedback f LEFT JOIN users u ON u.id=f.author_user_id LEFT JOIN managers m ON m.id=u.manager_id
    WHERE f.section ILIKE '%one%' OR f.message ~* '(1\\s*[xх×:]\\s*1|ван.?ту.?ван|one.?on.?one|1-on-1)'
    ORDER BY f.created_at DESC LIMIT 30`,
  // 10) Нові люди з Найму (кандидат → співробітник) за 120 днів — чи потрапили в 1×1
  newHires: `SELECT e.id, e.full_name, e.status, e.position, to_char(e.hired_at,'YYYY-MM-DD') AS hired_at,
       e.candidate_id IS NOT NULL AS from_candidate, COALESCE(e.manager_id, eu.manager_id) AS mgr_id,
       (m.id IS NOT NULL AND ${WORKS("m")}) AS in_roster,
       (SELECT count(*)::int FROM one_on_ones o WHERE o.subject_manager_id=m.id) AS o2o_records
     FROM employees e LEFT JOIN users eu ON eu.id=e.user_id LEFT JOIN managers m ON m.id=COALESCE(e.manager_id, eu.manager_id)
    WHERE e.hired_at >= current_date - 120 OR e.created_at >= now() - interval '120 days'
    ORDER BY e.hired_at DESC NULLS LAST`,
};

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  // Перевірка існування предметів ДО чисел (правило 15): таблиці мусять бути й не порожні.
  const ex = (await c.query(`SELECT (SELECT count(*) FROM managers)::int AS m, (SELECT count(*) FROM employees)::int AS e,
     (SELECT count(*) FROM one_on_ones)::int AS o, (SELECT count(*) FROM one_on_one_forms)::int AS f`)).rows[0];
  console.log("EXISTS", JSON.stringify(ex));
  if (!ex.m || !ex.e || !ex.o || !ex.f) throw new Error("порожня таблиця — числам нижче не вірити");
  for (const [k, sql] of Object.entries(Q)) {
    try {
      const r = await c.query(sql);
      console.log(`\n=== ${k}: ${r.rows.length} рядків`);
      if (r.rows.length) console.table(r.rows.slice(0, 120));
    } catch (e) { console.log(`\n=== ${k}: ПОМИЛКА ${e.message}`); }
  }
  await c.query("ROLLBACK");
  await c.end();
})().catch((e) => { console.error("ПОМИЛКА", e.message); process.exit(1); });
