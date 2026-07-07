import { pool } from "../db/pool.js";

/**
 * One-off backfill that re-canonicalises existing `client_key`s to match the new
 * normalization (spaces collapsed) — so spacing/apostrophe variants of the same
 * company merge into one key. Phone keys (digits only) have no spaces and are
 * untouched. Metadata tables with a client_key PK collapse collisions safely.
 */
export async function backfillClientKey(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query<{ c: string }>(
      `SELECT COUNT(DISTINCT client_key) c FROM deals WHERE client_key IS NOT NULL AND position(' ' in client_key) > 0`
    );

    // deals — no unique constraint on client_key (PK is kommo_id), bulk-safe.
    const d = await client.query(
      `UPDATE deals SET client_key = replace(client_key, ' ', '')
        WHERE client_key IS NOT NULL AND position(' ' in client_key) > 0`
    );

    // receivables / receivable_invoices — id PK, bulk-safe (also re-synced later).
    await client.query(`UPDATE receivables SET client_key = replace(client_key, ' ', '') WHERE client_key IS NOT NULL AND position(' ' in client_key) > 0`);
    await client.query(`UPDATE receivable_invoices SET client_key = replace(client_key, ' ', '') WHERE client_key IS NOT NULL AND position(' ' in client_key) > 0`);

    // receivable_notes (PK client_key): move rows whose collapsed key is free,
    // then drop leftover space-versions that would collide.
    await client.query(
      `UPDATE receivable_notes n SET client_key = replace(client_key, ' ', '')
        WHERE position(' ' in client_key) > 0
          AND NOT EXISTS (SELECT 1 FROM receivable_notes m WHERE m.client_key = replace(n.client_key, ' ', ''))`
    );
    await client.query(`DELETE FROM receivable_notes WHERE position(' ' in client_key) > 0`);

    // repeat_client_plans (PK client_key, month): same, per month.
    await client.query(
      `UPDATE repeat_client_plans p SET client_key = replace(client_key, ' ', '')
        WHERE position(' ' in client_key) > 0
          AND NOT EXISTS (SELECT 1 FROM repeat_client_plans q WHERE q.client_key = replace(p.client_key, ' ', '') AND q.month = p.month)`
    );
    await client.query(`DELETE FROM repeat_client_plans WHERE position(' ' in client_key) > 0`);

    await client.query("COMMIT");

    const after = await pool.query<{ c: string }>(`SELECT COUNT(DISTINCT client_key) c FROM deals WHERE client_key IS NOT NULL`);
    console.log(`backfillClientKey done: updated ${d.rowCount} deal rows; distinct spaced keys before ${before.rows[0].c}; total distinct keys now ${after.rows[0].c}.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backfillClientKey()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
