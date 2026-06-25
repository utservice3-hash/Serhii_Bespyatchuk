import { pool } from "../db/pool.js";
import { fetchAllDeals, fetchUsers } from "../kommo/client.js";

function toTimestamp(unixSeconds: number | null): Date | null {
  return unixSeconds ? new Date(unixSeconds * 1000) : null;
}

export async function syncManagers(): Promise<number> {
  const users = await fetchUsers();

  const teamIdByGroupId = new Map<number, number>();
  for (const user of users) {
    const group = user._embedded?.groups?.[0];
    if (!group || teamIdByGroupId.has(group.id)) continue;
    const result = await pool.query<{ id: number }>(
      `INSERT INTO teams (name, kommo_group_id)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET kommo_group_id = EXCLUDED.kommo_group_id
       RETURNING id`,
      [group.name, group.id]
    );
    teamIdByGroupId.set(group.id, result.rows[0].id);
  }

  for (const user of users) {
    const group = user._embedded?.groups?.[0];
    const teamId = group ? teamIdByGroupId.get(group.id) ?? null : null;
    const role = user._embedded?.roles?.[0]?.name ?? "";
    const isTeamLead = role.toLowerCase().includes("тимлід");

    await pool.query(
      `INSERT INTO managers (name, kommo_user_id, team_id, is_team_lead, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (kommo_user_id) DO UPDATE SET
         name = EXCLUDED.name,
         team_id = EXCLUDED.team_id,
         is_team_lead = EXCLUDED.is_team_lead,
         is_active = true`,
      [user.name, user.id, teamId, isTeamLead]
    );
  }

  const activeKommoIds = users.map((user) => user.id);
  await pool.query(
    `UPDATE managers SET is_active = false
     WHERE kommo_user_id IS NOT NULL AND NOT (kommo_user_id = ANY($1))`,
    [activeKommoIds]
  );

  return users.length;
}

const FULL_SYNC_LOOKBACK_DAYS = 180;

async function getSyncWindowStart(): Promise<number> {
  const result = await pool.query<{ last_synced_at: Date | null }>(
    `SELECT last_synced_at FROM sync_state WHERE id = 1`
  );
  const lastSyncedAt = result.rows[0]?.last_synced_at;
  if (lastSyncedAt) {
    return Math.floor(lastSyncedAt.getTime() / 1000);
  }
  // First-ever sync: only pull recent history to avoid an unbounded
  // full-account import (some Kommo accounts have years of leads).
  return Math.floor(Date.now() / 1000) - FULL_SYNC_LOOKBACK_DAYS * 24 * 60 * 60;
}

export async function syncKommo(): Promise<void> {
  const syncStartedAt = new Date();
  const windowStart = await getSyncWindowStart();

  const [deals, managerCount] = await Promise.all([
    fetchAllDeals(windowStart),
    syncManagers(),
  ]);

  const managerRows = await pool.query<{ id: number; kommo_user_id: string }>(
    `SELECT id, kommo_user_id FROM managers WHERE kommo_user_id IS NOT NULL`
  );
  const managerIdByKommoUserId = new Map(
    managerRows.rows.map((row) => [Number(row.kommo_user_id), row.id])
  );

  const CONCURRENCY = 20;
  for (let i = 0; i < deals.length; i += CONCURRENCY) {
    const batch = deals.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((deal) => upsertDeal(deal, managerIdByKommoUserId)));
  }

  await pool.query(
    `INSERT INTO sync_state (id, last_synced_at) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at`,
    [syncStartedAt]
  );

  console.log(`Synced ${managerCount} users and ${deals.length} deals.`);
}

async function upsertDeal(
  deal: Awaited<ReturnType<typeof fetchAllDeals>>[number],
  managerIdByKommoUserId: Map<number, number>
): Promise<void> {
  const managerId = managerIdByKommoUserId.get(deal.responsible_user_id) ?? null;

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

if (import.meta.url === `file://${process.argv[1]}`) {
  syncKommo()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
