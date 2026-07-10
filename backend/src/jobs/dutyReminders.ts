import { pool } from "../db/pool.js";

const SHIFT_LABEL: Record<string, string> = {
  day: "весь день",
  evening: "вечір 18–21",
  weekend: "вихідний",
};

/**
 * Уранці створює задачу «🗓 Сьогодні ти черговий» кожному менеджеру, який стоїть
 * у графіку чергування на СЬОГОДНІ (київський час). Черговий стежить за вхідними
 * заявками у своє вікно (вечір/вихідний), щоб реакція не провисала. Ідемпотентно:
 * анти-дубль по (assignee, дата, префікс). Викликається щоранку + на старті.
 */
export async function createDutyReminders(): Promise<void> {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const titlePrefix = "🗓 Сьогодні ти черговий";

  // Усі призначення на сьогодні (менеджер може мати кілька змін — беремо перелік).
  const rows = await pool.query<{ manager_id: number; shifts: string[] }>(
    `SELECT ds.manager_id, array_agg(DISTINCT ds.shift) AS shifts
       FROM duty_schedule ds
       JOIN managers m ON m.id = ds.manager_id AND m.is_active
      WHERE ds.duty_date = $1
      GROUP BY ds.manager_id`,
    [today]
  );

  let created = 0;
  for (const row of rows.rows) {
    const exists = await pool.query(
      `SELECT 1 FROM tasks
        WHERE assignee_id = $1 AND task_type = 'simple' AND title LIKE $2
          AND deadline = $3::date`,
      [row.manager_id, `${titlePrefix}%`, today]
    );
    if (exists.rowCount) continue;
    const shiftText = row.shifts.map((s) => SHIFT_LABEL[s] ?? s).join(", ");
    await pool.query(
      `INSERT INTO tasks (title, description, status, deadline, assignee_id, priority, department, task_type, created_by)
       VALUES ($1, $2, 'not_started', $3, $4, 'high', 'Чергування', 'simple', NULL)`,
      [
        `${titlePrefix} (${shiftText})`,
        "Стеж за вхідними заявками у своє вікно чергування й швидко бери їх у роботу — щоб клієнт не чекав.",
        today,
        row.manager_id,
      ]
    );
    created++;
  }
  console.log(`Duty reminders: ${created} tasks created for ${rows.rowCount} on-duty managers (${today}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createDutyReminders().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
