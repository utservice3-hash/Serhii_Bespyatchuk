/**
 * 🧹 РАЗОВЕ ПРИБИРАННЯ ЗАДАЧ «💰 Отримати оплату», ПОСТАВЛЕНИХ ДО 9934 (26.11.2026).
 *
 *   node dist/tools/cleanupReceivableTasks.js            # список: що закрилось би, нічого не пише
 *   node dist/tools/cleanupReceivableTasks.js --write    # виконати (одна транзакція)
 *
 * Логіка — `core/receivableTasks.planLegacyCleanup` (гейт `#9934f`). Стара задача ключа не має, тож борг
 * виводиться з НАЗВИ клієнта через поточну дебіторку:
 *  · рівно один client_key → задача отримує ключ; серед задач одного боргу лишається НАЙНОВІША, решта —
 *    «Дубль: по цьому боргу відкрита задача №…»;
 *  · клієнта / рахунку в дебіторці вже немає → «Боргу вже немає в дебіторці»;
 *  · назву не розібрано або вона веде до кількох client_key → НЕ чіпаємо, лише показуємо.
 *
 * ⚠️ Порожня дебіторка (синк не дав даних) — СТОП без запису: інакше закрилось би все.
 * ⚠️ Закрите можна повернути кнопкою «↩ У роботу»; revert коду закритих задач НЕ повертає.
 * Повторний запуск нічого не змінює: закриті вже не відкриті, ключовані вже не «старі».
 */
import { pool } from "../db/pool.js";
import {
  CLOSE_REASON_PAID, closeReasonDuplicate, planLegacyCleanup, RECEIVABLE_TASK_PREFIX,
} from "../core/receivableTasks.js";

const write = process.argv.includes("--write");
const db = await pool.connect();
try {
  // До викату 9934 колонки ще немає: тоді список усе одно будується (усі задачі — старі), а запис заборонено.
  const hasKey = (await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'receivable_key'`)).rowCount === 1;
  if (write && !hasKey) throw new Error("🔴 колонки tasks.receivable_key ще немає — спершу викат 9934, потім --write");
  const [legacy, keyed, cli, inv] = await Promise.all([
    db.query<{ id: number; title: string; assignee: string | null; created: string }>(
      `SELECT t.id, t.title, m.name AS assignee, to_char(t.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS created
         FROM tasks t LEFT JOIN managers m ON m.id = t.assignee_id
        WHERE ${hasKey ? "t.receivable_key IS NULL AND " : ""}t.status <> 'done' AND t.title LIKE $1
        ORDER BY t.id`, [`${RECEIVABLE_TASK_PREFIX}%`]),
    hasKey
      ? db.query<{ id: number; receivable_key: string }>(
        `SELECT id, receivable_key FROM tasks WHERE receivable_key IS NOT NULL AND status <> 'done'`)
      : Promise.resolve({ rows: [] as { id: number; receivable_key: string }[], rowCount: 0 }),
    db.query<{ client_name: string; client_key: string }>(
      `SELECT DISTINCT client_name, client_key FROM receivables`),
    db.query<{ client_name: string; invoice_no: string; client_key: string }>(
      `SELECT DISTINCT client_name, COALESCE(invoice_no, '') AS invoice_no, client_key FROM receivable_invoices`),
  ]);
  if (cli.rowCount === 0 || inv.rowCount === 0) {
    throw new Error(`🔴 дебіторка порожня (клієнтів ${String(cli.rowCount)}, рахунків ${String(inv.rowCount)}) — `
      + "закрити все як «оплачене» було б брехнею; спершу синк дебіторки");
  }
  const clients = new Map<string, Set<string>>();
  for (const r of cli.rows) {
    const name = r.client_name.trim();
    clients.set(name, (clients.get(name) ?? new Set()).add(r.client_key));
  }
  const invoices = new Map<string, Map<string, Set<string>>>();
  for (const r of inv.rows) {
    const name = r.client_name.trim();
    const byNo = invoices.get(name) ?? new Map<string, Set<string>>();
    byNo.set(r.invoice_no, (byNo.get(r.invoice_no) ?? new Set()).add(r.client_key));
    invoices.set(name, byNo);
  }
  const plan = planLegacyCleanup({
    legacy: legacy.rows.map((r) => ({ id: r.id, title: r.title })),
    keyedOpen: keyed.rows.map((r) => ({ id: r.id, key: r.receivable_key })),
    live: { clients, invoices },
  });

  const info = new Map(legacy.rows.map((r) => [r.id, r]));
  const line = (id: number) => {
    const r = info.get(id);
    return r ? `№${String(id)}  ${r.created}  ${r.assignee ?? "—"}  ${r.title.slice(RECEIVABLE_TASK_PREFIX.length)}` : `№${String(id)} (з ключем)`;
  };
  console.log(`Старих відкритих задач без ключа: ${String(legacy.rowCount)}; з ключем: ${String(keyed.rowCount)}`);
  console.log(`\n— ДУБЛІ, закрити (${String(plan.closeDuplicate.length)}):`);
  for (const d of plan.closeDuplicate) console.log(`  ${line(d.id)}   → лишається №${String(d.keptId)}`);
  console.log(`\n— БОРГУ ВЖЕ НЕМАЄ в дебіторці, закрити (${String(plan.closePaid.length)}):`);
  for (const id of plan.closePaid) console.log(`  ${line(id)}`);
  console.log(`\n— ЛИШАЮТЬСЯ, отримують ключ (${String(plan.assignKey.length)}):`);
  for (const a of plan.assignKey) console.log(`  ${line(a.id)}   [${a.key}]`);
  console.log(`\n— НЕ ЧІПАЄМО (${String(plan.untouched.length)}):`);
  for (const u of plan.untouched) console.log(`  ${line(u.id)}   (${u.why === "unparsed" ? "назву не розібрано" : "назва веде до кількох клієнтів"})`);

  if (!write) {
    console.log("\nℹ️ це лише список; запис: --write");
  } else {
    await db.query("BEGIN");
    const close = async (id: number, reason: string) => {
      const r = await db.query(
        `UPDATE tasks SET status = 'done', closed_at = now(), close_reason = $2, updated_at = now()
          WHERE id = $1 AND status <> 'done' RETURNING id`, [id, reason]);
      if (r.rowCount) {
        await db.query(
          "INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, NULL, 'done', NULL)", [id]);
      }
      return r.rowCount ?? 0;
    };
    let closed = 0;
    for (const d of plan.closeDuplicate) closed += await close(d.id, closeReasonDuplicate(d.keptId));
    for (const id of plan.closePaid) closed += await close(id, CLOSE_REASON_PAID);
    for (const a of plan.assignKey) {
      await db.query("UPDATE tasks SET receivable_key = $2 WHERE id = $1 AND receivable_key IS NULL", [a.id, a.key]);
    }
    await db.query("COMMIT");
    console.log(`\n✅ закрито ${String(closed)}, ключ отримали ${String(plan.assignKey.length)}`);
  }
} catch (e) {
  if (write) await db.query("ROLLBACK").catch(() => undefined);
  throw e;
} finally {
  db.release();
  await pool.end();
}
