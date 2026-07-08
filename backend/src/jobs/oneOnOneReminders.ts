import { pool } from "../db/pool.js";

/**
 * На початку місяця створює задачу «🤝 Провести ван-ту-вани» кожному тімліду
 * (assignee = тімлід, дедлайн — кінець місяця, департамент «Ван ту ван»).
 * Ідемпотентно: пропускає, якщо задача на цей місяць уже є. Викликається
 * 1-го числа + на старті (щоб посіяти поточний місяць, якщо ще нема).
 */
export async function createOneOnOneReminders(): Promise<void> {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
  const monthLabel = `${String(now.getMonth() + 1).padStart(2, "0")}.${now.getFullYear()}`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const deadline = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}`;
  const titlePrefix = "🤝 Провести ван-ту-вани з командою";

  // Тімліди з активним обліковим записом.
  const leads = await pool.query<{ id: number }>(
    `SELECT DISTINCT m.id FROM managers m
       WHERE m.is_team_lead AND m.is_active`
  );
  let created = 0;
  for (const l of leads.rows) {
    const exists = await pool.query(
      `SELECT 1 FROM tasks WHERE assignee_id = $1 AND task_type = 'simple'
         AND title LIKE $2 AND (deadline IS NULL OR date_trunc('month', deadline) = date_trunc('month', $3::date))`,
      [l.id, `${titlePrefix}%`, deadline]
    );
    if (exists.rowCount) continue;
    await pool.query(
      `INSERT INTO tasks (title, status, deadline, assignee_id, priority, department, task_type, created_by)
       VALUES ($1, 'todo', $2, $3, 'high', 'Ван ту ван', 'simple', NULL)`,
      [`${titlePrefix} (${monthLabel})`, deadline, l.id]
    );
    created++;
  }
  console.log(`One-on-one reminders: ${created} tasks created for ${leads.rowCount} team leads.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createOneOnOneReminders().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
