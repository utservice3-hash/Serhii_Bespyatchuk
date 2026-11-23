import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { hasPlanSql, stateJoinSql } from "./managerState.js";
import { teamAtSql, sqlDate } from "./teamAt.js";
import { monthEndOf } from "./dates.js";
import { receivedByMgr } from "./money.js";
import { transferVerdict, type TransferMode, type TransferPart } from "./planTransferRules.js";

/**
 * 🔁 ПУЛ «НЕ РОЗПОДІЛЕНО» І ПЕРЕДАЧА ПЛАНУ (задача 10477). Правила - `planTransferRules.ts`, тут лише база.
 *
 * Де лежить стан. Окремої «таблиці пулу» немає: пул = рядок `plans` того, кому план більше не ставиться
 * (той самий предикат `hasPlanSql`, що в `core/plans.ts`), мінус те, що свідомо лишено за ним (`keep`).
 * Передача пише в сакральний `plans` двома боками одразу - плюс отримувачам, мінус тому, хто пішов, - тож
 * Σ планів місяця не рухається, а кожен екран, що читає `plans`, бачить нове число без окремої правки.
 * `plan_transfers` - це журнал (хто, коли, від кого, кому, скільки) і позначка «лишено за ним».
 */

type Db = { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

export interface GonePlan {
  managerId: number; name: string; teamId: number;
  /** що зараз лежить у `plans` на його імʼя за цей місяць */
  plan: number;
  /** з цього - свідомо лишено за ним як уже виконане (режим «тільки залишок») */
  kept: number;
  /** не розподілено: plan - kept */
  pool: number;
  /** факт місяця (② отримано, `core/money.ts`): лишається в команді, ні на кого не переноситься */
  fact: number;
}

/** Ті, кому план більше не ставиться, але за місяць він на них лежить (або вже передавався). */
export async function gonePlans(month: string, teamId: number | null, db: Db = pool): Promise<GonePlan[]> {
  const mo = `${month.slice(0, 7)}-01`;
  const TEAM = teamAtSql("m", sqlDate(mo));
  const params: unknown[] = [mo];
  if (teamId) params.push(teamId);
  const rows = (await db.query<{ id: number; name: string; team_id: number; plan: string; kept: string }>(
    `SELECT m.id, m.name, ${TEAM} AS team_id,
            COALESCE(SUM(p.planned_value), 0) AS plan,
            COALESCE((SELECT SUM(t.amount) FROM plan_transfers t
                       WHERE t.from_manager_id = m.id AND t.month = $1::date AND t.kind = 'keep'), 0) AS kept
       FROM managers m ${stateJoinSql("m")}
       LEFT JOIN plans p ON p.manager_id = m.id AND p.metric = 'payment_amount'
                        AND date_trunc('month', p.plan_date) = $1::date
      WHERE NOT (${hasPlanSql("m", "m.is_active")}) AND ${TEAM} IS NOT NULL ${teamId ? `AND ${TEAM} = $2` : ""}
      GROUP BY m.id, m.name, 3
     HAVING COALESCE(SUM(p.planned_value), 0) > 0
         OR EXISTS (SELECT 1 FROM plan_transfers t WHERE t.from_manager_id = m.id AND t.month = $1::date)
      ORDER BY m.name`, params)).rows;
  if (rows.length === 0) return [];
  const facts = new Map((await receivedByMgr({ from: mo, to: monthEndOf(mo) })).map((r) => [r.managerId, Math.round(r.revenue)]));
  return rows.map((r) => {
    const plan = Math.round(Number(r.plan)), kept = Math.min(plan, Math.round(Number(r.kept)));
    return { managerId: r.id, name: r.name, teamId: r.team_id, plan, kept, pool: Math.max(0, plan - kept), fact: facts.get(r.id) ?? 0 };
  });
}

/** Σ «не розподілено» по командах за місяць - для підсумків екранів. */
export async function unassignedByTeam(month: string, teamId: number | null, db: Db = pool): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const g of await gonePlans(month, teamId, db)) if (g.pool > 0) out.set(g.teamId, (out.get(g.teamId) ?? 0) + g.pool);
  return out;
}

export interface TransferEvent {
  batchId: string; at: string; by: string | null;
  fromManagerId: number; fromName: string; teamId: number | null;
  kind: "transfer" | "drop";
  /** передано або знято */
  amount: number;
  /** лишено за тим, хто пішов (режим «тільки залишок») */
  keep: number;
  parts: { managerId: number; name: string; amount: number }[];
}

/** Журнал передач місяця, новіші зверху. Одна дія = один запис, скільки б отримувачів не було. */
export async function transferHistory(month: string, teamId: number | null, db: Db = pool): Promise<TransferEvent[]> {
  const mo = `${month.slice(0, 7)}-01`;
  const TEAM = teamAtSql("f", sqlDate(mo));
  const params: unknown[] = [mo];
  if (teamId) params.push(teamId);
  const rows = (await db.query<{ batch_id: string; at: string; by: string | null; from_id: number; from_name: string; team_id: number | null;
    kind: string; amount: string; to_id: number | null; to_name: string | null }>(
    `SELECT t.batch_id, to_char(t.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD"T"HH24:MI') AS at,
            COALESCE(um.name, u.full_name, u.email) AS by,
            f.id AS from_id, f.name AS from_name, ${TEAM} AS team_id,
            t.kind, t.amount, r.id AS to_id, r.name AS to_name
       FROM plan_transfers t
       JOIN managers f ON f.id = t.from_manager_id
       LEFT JOIN managers r ON r.id = t.to_manager_id
       LEFT JOIN users u ON u.id = t.created_by LEFT JOIN managers um ON um.id = u.manager_id
      WHERE t.month = $1::date ${teamId ? `AND ${TEAM} = $2` : ""}
      ORDER BY t.created_at DESC, t.id`, params)).rows;
  const byBatch = new Map<string, TransferEvent>();
  for (const r of rows) {
    let e = byBatch.get(r.batch_id);
    if (!e) {
      e = { batchId: r.batch_id, at: r.at, by: r.by, fromManagerId: r.from_id, fromName: r.from_name, teamId: r.team_id,
        kind: "transfer", amount: 0, keep: 0, parts: [] };
      byBatch.set(r.batch_id, e);
    }
    const a = Math.round(Number(r.amount));
    if (r.kind === "keep") e.keep += a;
    else if (r.kind === "drop") { e.kind = "drop"; e.amount += a; }
    else { e.amount += a; e.parts.push({ managerId: r.to_id as number, name: r.to_name ?? "", amount: a }); }
  }
  return [...byBatch.values()];
}

export type TransferResult = { ok: true; amount: number; keep: number } | { ok: false; status: number; error: string };

/** Ростер отримувачів: кому ставиться план у тій самій команді на 1-ше число місяця. */
async function rosterOf(db: Db, month: string, teamId: number): Promise<Set<number>> {
  const TEAM = teamAtSql("m", sqlDate(month));
  const r = await db.query<{ id: number }>(
    `SELECT m.id FROM managers m ${stateJoinSql("m")} WHERE ${hasPlanSql("m", "m.is_active")} AND ${TEAM} = $1`, [teamId]);
  return new Set(r.rows.map((x) => x.id));
}

/**
 * Передати план. Один виклик - одна транзакція: або змінились усі рядки, або жоден.
 * Рядок того, хто пішов, блокується ПЕРШИМ, і пул перечитується вже під замком: двоє КВП, що тиснуть
 * «Зберегти» одночасно, не роздадуть той самий план двічі.
 */
export async function applyTransfer(i: { month: string; fromManagerId: number; mode: TransferMode; parts: TransferPart[]; userId: number | null }): Promise<TransferResult> {
  const mo = `${i.month.slice(0, 7)}-01`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = (await client.query<{ planned_value: string }>(
      `SELECT planned_value FROM plans WHERE manager_id = $1 AND plan_date = $2::date AND metric = 'payment_amount' FOR UPDATE`,
      [i.fromManagerId, mo])).rows[0];
    const gone = (await gonePlans(mo, null, client as unknown as Db)).find((g) => g.managerId === i.fromManagerId);
    if (!gone || !locked) { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "У цього менеджера немає плану, який можна передати" }; }
    if (Math.round(Number(locked.planned_value)) !== gone.plan) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, error: "План цього менеджера лежить не одним місячним рядком - передачу зупинено, потрібен розбір" };
    }
    const v = transferVerdict({ pool: gone.pool, fact: gone.fact, mode: i.mode, parts: i.parts, roster: await rosterOf(client as unknown as Db, mo, gone.teamId) });
    if (!v.ok) { await client.query("ROLLBACK"); return { ok: false, status: 400, error: v.error }; }
    const batch = randomUUID();
    for (const p of v.parts) {
      await client.query(
        `INSERT INTO plans (manager_id, plan_date, metric, planned_value) VALUES ($1, $2::date, 'payment_amount', $3)
         ON CONFLICT (manager_id, plan_date, metric) DO UPDATE SET planned_value = plans.planned_value + EXCLUDED.planned_value`,
        [p.managerId, mo, p.amount]);
      await client.query(
        `INSERT INTO plan_transfers (batch_id, month, from_manager_id, to_manager_id, amount, kind, created_by)
         VALUES ($1, $2::date, $3, $4, $5, 'transfer', $6)`, [batch, mo, i.fromManagerId, p.managerId, p.amount, i.userId]);
    }
    await client.query(
      `UPDATE plans SET planned_value = planned_value - $3 WHERE manager_id = $1 AND plan_date = $2::date AND metric = 'payment_amount'`,
      [i.fromManagerId, mo, v.amount]);
    if (v.keep > 0) {
      await client.query(
        `INSERT INTO plan_transfers (batch_id, month, from_manager_id, to_manager_id, amount, kind, created_by)
         VALUES ($1, $2::date, $3, NULL, $4, 'keep', $5)`, [batch, mo, i.fromManagerId, v.keep, i.userId]);
    }
    await client.query("COMMIT");
    return { ok: true, amount: v.amount, keep: v.keep };
  } catch (e) {
    await client.query("ROLLBACK"); throw e;
  } finally {
    client.release();
  }
}

/** Зняти нерозподілений план: він зникає з плану команди. Єдина дія, що зменшує план команди, і лише свідомо. */
export async function dropPool(i: { month: string; fromManagerId: number; userId: number | null }): Promise<TransferResult> {
  const mo = `${i.month.slice(0, 7)}-01`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = (await client.query<{ planned_value: string }>(
      `SELECT planned_value FROM plans WHERE manager_id = $1 AND plan_date = $2::date AND metric = 'payment_amount' FOR UPDATE`,
      [i.fromManagerId, mo])).rows[0];
    const gone = (await gonePlans(mo, null, client as unknown as Db)).find((g) => g.managerId === i.fromManagerId);
    if (!gone || !locked || !(gone.pool > 0)) { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "У цього менеджера немає нерозподіленого плану" }; }
    if (Math.round(Number(locked.planned_value)) !== gone.plan) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, error: "План цього менеджера лежить не одним місячним рядком - зняття зупинено, потрібен розбір" };
    }
    await client.query(
      `UPDATE plans SET planned_value = planned_value - $3 WHERE manager_id = $1 AND plan_date = $2::date AND metric = 'payment_amount'`,
      [i.fromManagerId, mo, gone.pool]);
    await client.query(
      `INSERT INTO plan_transfers (batch_id, month, from_manager_id, to_manager_id, amount, kind, created_by)
       VALUES ($1, $2::date, $3, NULL, $4, 'drop', $5)`, [randomUUID(), mo, i.fromManagerId, gone.pool, i.userId]);
    await client.query("COMMIT");
    return { ok: true, amount: gone.pool, keep: 0 };
  } catch (e) {
    await client.query("ROLLBACK"); throw e;
  } finally {
    client.release();
  }
}
