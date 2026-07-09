import { pool } from "../db/pool.js";

/**
 * Прострочені дедлайни оплати дебіторки → задача менеджеру «отримати оплату».
 *
 * Два джерела дедлайнів:
 *  1) receivable_invoice_notes.due_date — дедлайн КОНКРЕТНОГО рахунку (менеджер
 *     ставить у деталізації). Задача створюється, якщо дедлайн минув, а рахунок
 *     досі в receivable_invoices (файл дебіторки = ще неоплачений).
 *  2) receivable_notes.due_date — дедлайн ПО КЛІЄНТУ (тімлід/адмін). Задача,
 *     якщо дедлайн минув, а клієнт досі в receivables.
 *
 * Анти-дубль: task_created_at — після створення задачі повторно не створюємо;
 * зміна дедлайну скидає позначку (див. PUT /receivables/invoice-note).
 * Запускається щодня + на старті бекенду (ідемпотентно).
 */
export async function createReceivableDeadlineTasks(): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  let created = 0;

  // 1) Дедлайни по рахунках.
  const inv = await pool.query<{
    client_key: string; invoice_no: string; due_date: string;
    client_name: string; manager_id: number; team_name: string | null; amount: string;
  }>(
    `SELECT nn.client_key, nn.invoice_no, to_char(nn.due_date, 'DD.MM.YYYY') AS due_date,
            ri.client_name, ri.manager_id, t.name AS team_name, ri.amount
     FROM receivable_invoice_notes nn
     JOIN receivable_invoices ri
       ON ri.client_key = nn.client_key AND COALESCE(ri.invoice_no, '') = nn.invoice_no
     JOIN managers m ON m.id = ri.manager_id AND m.is_active
     LEFT JOIN teams t ON t.id = m.team_id
     WHERE nn.due_date < $1::date AND nn.task_created_at IS NULL AND ri.manager_id IS NOT NULL`,
    [today]
  );
  for (const r of inv.rows) {
    await pool.query(
      `INSERT INTO tasks (title, status, deadline, assignee_id, priority, department, task_type, comments)
       VALUES ($1, 'not_started', $2, $3, 'high', $4, 'simple', $5)`,
      [
        `💰 Отримати оплату: ${r.client_name} — рахунок №${r.invoice_no} (дедлайн ${r.due_date} минув)`,
        today, r.manager_id, r.team_name ?? "Дебіторка",
        `Сума рахунку: ${Math.round(Number(r.amount)).toLocaleString("uk-UA")} ₴. Створено автоматично з дебіторки.`,
      ]
    );
    await pool.query(
      `UPDATE receivable_invoice_notes SET task_created_at = now()
       WHERE client_key = $1 AND invoice_no = $2`,
      [r.client_key, r.invoice_no]
    );
    created++;
  }

  // 2) Дедлайни по клієнтах (загальна дата оплати в таблиці дебіторки).
  const cli = await pool.query<{
    client_key: string; due_date: string; client_name: string; manager_id: number;
    team_name: string | null; amount: string;
  }>(
    `SELECT n.client_key, to_char(n.due_date, 'DD.MM.YYYY') AS due_date,
            r.client_name, r.manager_id, t.name AS team_name, r.amount
     FROM receivable_notes n
     JOIN receivables r ON r.client_key = n.client_key
     JOIN managers m ON m.id = r.manager_id AND m.is_active
     LEFT JOIN teams t ON t.id = m.team_id
     WHERE n.due_date < $1::date AND n.task_created_at IS NULL AND r.manager_id IS NOT NULL`,
    [today]
  );
  for (const r of cli.rows) {
    await pool.query(
      `INSERT INTO tasks (title, status, deadline, assignee_id, priority, department, task_type, comments)
       VALUES ($1, 'not_started', $2, $3, 'high', $4, 'simple', $5)`,
      [
        `💰 Отримати оплату: ${r.client_name} (дедлайн ${r.due_date} минув)`,
        today, r.manager_id, r.team_name ?? "Дебіторка",
        `Борг клієнта: ${Math.round(Number(r.amount)).toLocaleString("uk-UA")} ₴. Створено автоматично з дебіторки.`,
      ]
    );
    await pool.query(
      `UPDATE receivable_notes SET task_created_at = now() WHERE client_key = $1`,
      [r.client_key]
    );
    created++;
  }

  console.log(`Receivable deadline tasks: ${created} created (${inv.rowCount} invoice-level, ${cli.rowCount} client-level).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createReceivableDeadlineTasks().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
