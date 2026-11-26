import { pool } from "../db/pool.js";
import { agreementActualSql } from "../core/receivableAgreement.js";
import {
  CLOSE_REASON_PAID, closeReasonDuplicate, planReceivableTasks, receivableTaskKey,
  RECEIVABLE_TASK_PREFIX, type DueReceivable, type OpenReceivableTask,
} from "../core/receivableTasks.js";

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
 *
 * 💰 З 9934 (26.11.2026) скинута позначка більше НЕ означає «нова задача»: на один борг — одна
 * відкрита задача (ключ `tasks.receivable_key`), новий дедлайн її оновлює, дублі й оплачені борги
 * закриваються. Правило — у чистій `core/receivableTasks.planReceivableTasks`; тут лише читання й запис.
 */
export async function createReceivableDeadlineTasks(): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const due: DueReceivable[] = [];
  // Позначки «задачу поставлено» ставимо лише ПІСЛЯ того, як план виконано.
  const invMarks: { clientKey: string; invoiceNo: string }[] = [];
  const cliMarks: string[] = [];

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
    due.push({
      key: receivableTaskKey(r.client_key, r.invoice_no),
      title: `${RECEIVABLE_TASK_PREFIX}${r.client_name} — рахунок №${r.invoice_no} (дедлайн ${r.due_date} минув)`,
      comments: `Сума рахунку: ${Math.round(Number(r.amount)).toLocaleString("uk-UA")} ₴. Створено автоматично з дебіторки.`,
      managerId: r.manager_id,
      department: r.team_name ?? "Дебіторка",
    });
    invMarks.push({ clientKey: r.client_key, invoiceNo: r.invoice_no });
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
     WHERE n.due_date < $1::date AND n.task_created_at IS NULL AND r.manager_id IS NOT NULL
       -- 🗓 Лише АКТУАЛЬНИЙ запис (06.10.2026): дата з попередньої угоди задачі «отримати оплату» не ставить —
       -- інакше нова угода клієнта отримала б задачу за старою обіцянкою (Бінарт: 31.08 при угоді від 05.10).
       AND ${agreementActualSql("n")}`,
    [today]
  );
  for (const r of cli.rows) {
    due.push({
      key: receivableTaskKey(r.client_key, null),
      title: `${RECEIVABLE_TASK_PREFIX}${r.client_name} (дедлайн ${r.due_date} минув)`,
      comments: `Борг клієнта: ${Math.round(Number(r.amount)).toLocaleString("uk-UA")} ₴. Створено автоматично з дебіторки.`,
      managerId: r.manager_id,
      department: r.team_name ?? "Дебіторка",
    });
    cliMarks.push(r.client_key);
  }

  // 3) Що є зараз: відкриті задачі з ключем боргу і живі борги. Ключ `cli:` — клієнт у `receivables`,
  //    `inv:` — рядок у `receivable_invoices` (той самий COALESCE номера, що й у дедлайнах вище).
  const [open, live] = await Promise.all([
    pool.query<{ id: number; receivable_key: string }>(
      `SELECT id, receivable_key FROM tasks WHERE receivable_key IS NOT NULL AND status <> 'done'`),
    pool.query<{ key: string; kind: "inv" | "cli" }>(
      `SELECT 'cli:' || client_key AS key, 'cli' AS kind FROM receivables
       UNION ALL
       SELECT 'inv:' || client_key || ':' || COALESCE(invoice_no, '') AS key, 'inv' AS kind FROM receivable_invoices`),
  ]);
  const liveRows = { inv: 0, cli: 0 };
  for (const r of live.rows) liveRows[r.kind]++;
  const openTasks: OpenReceivableTask[] = open.rows.map((r) => ({ id: r.id, key: r.receivable_key }));
  const plan = planReceivableTasks({ due, open: openTasks, liveKeys: new Set(live.rows.map((r) => r.key)), liveRows });

  // 4) Виконання плану — однією транзакцією, щоб позначки й задачі не розійшлись.
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const close = async (id: number, reason: string) => {
      const r = await db.query(
        `UPDATE tasks SET status = 'done', closed_at = now(), close_reason = $2, updated_at = now()
          WHERE id = $1 AND status <> 'done' RETURNING id`, [id, reason]);
      if (r.rowCount) {
        await db.query(
          "INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, NULL, 'done', NULL)", [id]);
      }
    };
    for (const d of plan.closeDuplicate) await close(d.id, closeReasonDuplicate(d.keptId));
    for (const id of plan.closePaid) await close(id, CLOSE_REASON_PAID);
    for (const u of plan.update) {
      await db.query(
        `UPDATE tasks SET title = $2, deadline = $3, assignee_id = $4, department = $5, comments = $6, updated_at = now()
          WHERE id = $1`,
        [u.id, u.due.title, today, u.due.managerId, u.due.department, u.due.comments]);
    }
    for (const d of plan.insert) {
      await db.query(
        `INSERT INTO tasks (title, status, deadline, assignee_id, priority, department, task_type, comments, receivable_key)
         VALUES ($1, 'not_started', $2, $3, 'high', $4, 'simple', $5, $6)`,
        [d.title, today, d.managerId, d.department, d.comments, d.key]);
    }
    for (const m of invMarks) {
      await db.query(
        `UPDATE receivable_invoice_notes SET task_created_at = now() WHERE client_key = $1 AND invoice_no = $2`,
        [m.clientKey, m.invoiceNo]);
    }
    for (const ck of cliMarks) {
      await db.query(`UPDATE receivable_notes SET task_created_at = now() WHERE client_key = $1`, [ck]);
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    db.release();
  }

  const skipped = plan.paidCheckSkipped.length ? ` · закриття оплачених пропущено (порожньо: ${plan.paidCheckSkipped.join(", ")})` : "";
  console.log(`Receivable deadline tasks: ${String(plan.insert.length)} created, ${String(plan.update.length)} updated, `
    + `${String(plan.closeDuplicate.length)} duplicates closed, ${String(plan.closePaid.length)} paid closed `
    + `(${String(inv.rowCount)} invoice-level, ${String(cli.rowCount)} client-level due)${skipped}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createReceivableDeadlineTasks().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
