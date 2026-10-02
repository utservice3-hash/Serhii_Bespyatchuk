/**
 * 🔁 РАЗОВИЙ ПЕРЕРАХУНОК ЗАДАЧ «📵 Передзвонити клієнту» за правилом «розмова від 10 с» (задача 4373,
 * рішення Романа 02.10.2026). Логіка — `core/missedCallSignal.recountMissedTasks` (гейт `#1306`).
 *
 *   node dist/tools/recountMissedTasks.js            # список: що перевідкрилось би, нічого не пише
 *   node dist/tools/recountMissedTasks.js --write    # перевідкрити
 *
 * Перевідкриває лише задачі, закриті ДЖОБОЮ, після сигналу яких досі немає розмови від 10 с.
 * Закриті людьми не чіпає. Повторний запуск нічого не змінює.
 */
import { pool } from "../db/pool.js";
import { recountMissedTasks } from "../core/missedCallSignal.js";

const write = process.argv.includes("--write");
const client = await pool.connect();
try {
  const { rows, reopened } = await recountMissedTasks(client, write);
  for (const r of rows) console.log(`${r.kday}  задача ${String(r.task_id)}  менеджер ${String(r.manager_id)}  +${r.client_phone}  — ${r.close_reason}`);
  console.log(write
    ? `✅ перевідкрито ${String(reopened)} із ${String(rows.length)}`
    : `ℹ️ кандидатів ${String(rows.length)} — це лише список; запис: --write`);
} finally {
  client.release();
  await pool.end();
}
