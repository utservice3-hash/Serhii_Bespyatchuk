import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { normalizeClientName } from "../utils/clientName.js";
import { parseCsv } from "../utils/csv.js";

interface ReceivableRow {
  clientKey: string;
  clientName: string;
  managerNameRaw: string;
  amount: number;
}

/**
 * The sheet has no header row. Columns observed: 0 Контрагент, 1 Счет,
 * 2 "<Менеджер>, Загружен из amoCRM по сделке №...", 3 Сумма, 4 ЕДРПОУ,
 * 5 Сервіс (url), 6 (empty), 7 Пометка.
 */
function parseRow(cells: string[]): ReceivableRow | null {
  const rawClientName = cells[0]?.trim();
  const managerCell = cells[2]?.trim();
  const rawAmount = cells[3]?.trim();
  if (!rawClientName || !rawAmount) return null;

  const amount = Number(rawAmount.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(amount) || amount === 0) return null;

  const managerNameRaw = managerCell?.split(",")[0]?.trim() ?? "";
  const clientKey = normalizeClientName(rawClientName);
  if (!clientKey) return null;

  return { clientKey, clientName: rawClientName, managerNameRaw, amount };
}

export async function syncReceivables(): Promise<void> {
  const res = await fetch(config.receivablesSheetUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch receivables sheet: ${res.status}`);
  }
  const csvText = await res.text();
  const rows = parseCsv(csvText).map(parseRow).filter((r): r is ReceivableRow => r !== null);

  const managerRows = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM managers`
  );
  const managerIdByName = new Map(managerRows.rows.map((m) => [m.name, m.id]));

  const totalsByKey = new Map<
    string,
    { clientName: string; managerNameRaw: string; managerId: number | null; amount: number }
  >();

  for (const row of rows) {
    const managerId = managerIdByName.get(row.managerNameRaw) ?? null;
    const groupKey = `${row.clientKey}::${managerId ?? row.managerNameRaw}`;
    const existing = totalsByKey.get(groupKey);
    if (existing) {
      existing.amount += row.amount;
    } else {
      totalsByKey.set(groupKey, {
        clientName: row.clientName,
        managerNameRaw: row.managerNameRaw,
        managerId,
        amount: row.amount,
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE receivables");
    for (const [key, entry] of totalsByKey) {
      const clientKey = key.split("::")[0];
      await client.query(
        `INSERT INTO receivables (client_key, client_name, manager_id, manager_name_raw, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [clientKey, entry.clientName, entry.managerId, entry.managerNameRaw, entry.amount]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`Synced ${totalsByKey.size} receivable balances from ${rows.length} sheet rows.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncReceivables()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
