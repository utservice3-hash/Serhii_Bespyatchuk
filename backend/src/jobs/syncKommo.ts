import { pool } from "../db/pool.js";
import { fetchAllDeals, fetchUsers } from "../kommo/client.js";

function toTimestamp(unixSeconds: number | null): Date | null {
  return unixSeconds ? new Date(unixSeconds * 1000) : null;
}

export async function syncKommo(): Promise<void> {
  const [deals, users] = await Promise.all([fetchAllDeals(), fetchUsers()]);

  // Ensure every Kommo user has a corresponding manager row.
  for (const user of users) {
    await pool.query(
      `INSERT INTO managers (name, kommo_user_id)
       VALUES ($1, $2)
       ON CONFLICT (kommo_user_id) DO UPDATE SET name = EXCLUDED.name`,
      [user.name, user.id]
    );
  }

  for (const deal of deals) {
    const managerRes = await pool.query<{ id: number }>(
      `SELECT id FROM managers WHERE kommo_user_id = $1`,
      [deal.responsible_user_id]
    );
    const managerId = managerRes.rows[0]?.id ?? null;

    await pool.query(
      `INSERT INTO deals (
         kommo_id, name, manager_id, kommo_user_id, pipeline_id, status_id,
         price, created_at_kommo, updated_at_kommo, closed_at_kommo, synced_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (kommo_id) DO UPDATE SET
         name = EXCLUDED.name,
         manager_id = EXCLUDED.manager_id,
         pipeline_id = EXCLUDED.pipeline_id,
         status_id = EXCLUDED.status_id,
         price = EXCLUDED.price,
         updated_at_kommo = EXCLUDED.updated_at_kommo,
         closed_at_kommo = EXCLUDED.closed_at_kommo,
         synced_at = now()`,
      [
        deal.id,
        deal.name,
        managerId,
        deal.responsible_user_id,
        deal.pipeline_id,
        deal.status_id,
        deal.price,
        toTimestamp(deal.created_at),
        toTimestamp(deal.updated_at),
        toTimestamp(deal.closed_at),
      ]
    );
  }

  console.log(`Synced ${users.length} users and ${deals.length} deals.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncKommo()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
