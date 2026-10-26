/**
 * 🔁 «Ліміти клієнтів» ↔ нинішня дебіторка (пакет Сергія 23–24.10, ТЗ §0 22.10 і §6.3).
 *
 * 1. ПЕРЕНОС (одноразово, idempotent за debtorKey): кожен рядок `client_credit_limits` (82 на 24.10: дні в усіх, сума в 50)
 *    стає лімітом `src='debt'` через `importLimit` пакета — з подією «перенесено» в історії. «Від чого рахувати» — ВІД
 *    РАХУНКУ: так ці ліміти діяли на екрані («узгоджена відстрочка N дн. від дати рахунку»), тож прострочка в них не зміниться.
 *    Юрособи — ЄДРПОУ з рахунків 1С клієнта. 0 днів («у відстрочці відмовлено») переноситься як 0.
 *
 * 2. ДЗЕРКАЛО (після кожної дії в «Узгодженні» / «Лімітах» і раз на 10 хв): «Ліміти клієнтів» — джерело, а
 *    `client_credit_limits` + `receivables.limit_days/limit_amount` — його відбиток, з яким уже вміють працювати «Активна
 *    дебіторка», плитки, фільтр «Прострочені», синк і звіти. Дні — ЕФЕКТИВНІ від дати рахунку: «від оригіналів» = дні + 10
 *    (`lag.orig`, рахунку дату оригіналів дебіторка не знає), «від вивантаження» / «від рахунку» = дні (рахунок ≈ вивантаження).
 *    Знятий ліміт (запит повернуто / відхилено після призупинення) — прибирається з дебіторки («не узгоджено»).
 *    Боржник без рядка в «Лімітах» — не чіпаємо (його ліміт, якщо є, лишається як був).
 */
import type { Pool, PoolClient } from "pg";
import { DEFAULT_LAG } from "./shared/cpCalc.js";
import { matches } from "./shared/clientLimits.js";
import type { From } from "./shared/counterparty.js";
import { importLimit, type ImportRow } from "./server/limitsStore.js";
import type { DebtSource } from "./server/debtSource.js";

export const MIRROR_NOTE = "з «Лімітів клієнтів»";

/**
 * Рядки для переносу: ліміти дебіторки, ще не перенесені, — лише боржників, що Є в дебіторці зараз. Заміряно 24.10: 56 із 82
 * лімітів — клієнти без боргу; назви в них немає ніде надійно (у `deals.client_name` трапляється імʼя контакту), а
 * «Відповідальним» став би той, хто ставив ліміт. Тож вони переносяться, щойно зʼявляться в дебіторці (джоба раз на 10 хв);
 * до того їхній ліміт діє як був — у `client_credit_limits`, звідки його бере синк.
 */
export const LEGACY_LIMITS_SQL = `
  SELECT l.client_key, l.limit_days, l.limit_amount::numeric AS limit_amount, l.note, l.set_at,
         r.client_name AS name,
         COALESCE(u.id::text, '0') AS manager_id, COALESCE(m.name, 'без відповідального') AS manager_name,   -- не «хто ставив ліміт»
         COALESCE((SELECT json_agg(json_build_object('code', c.edrpou, 'name', c.nm) ORDER BY c.edrpou)
                     FROM (SELECT ri.edrpou, max(COALESCE(ri.client_name, '')) AS nm FROM receivable_invoices ri
                            WHERE ri.client_key = l.client_key AND ri.edrpou ~ '^[0-9]{8}([0-9]{2})?$' GROUP BY ri.edrpou) c), '[]') AS members
    FROM client_credit_limits l
    JOIN receivables r ON r.client_key = l.client_key
    LEFT JOIN managers m ON m.id = r.manager_id
    LEFT JOIN LATERAL (SELECT id FROM users WHERE manager_id = r.manager_id ORDER BY is_active DESC, id LIMIT 1) u ON true
   WHERE NOT EXISTS (SELECT 1 FROM client_limits cl WHERE cl.debtor_key = l.client_key)
     AND (l.note IS DISTINCT FROM '${MIRROR_NOTE}')
   ORDER BY l.client_key`;

const ddmmyyyy = (d: Date) => `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;

export function legacyRow(r: { client_key: string; limit_days: number | null; limit_amount: string | null; note: string; set_at: Date;
  name: string; manager_id: string; manager_name: string; members: Array<{ code: string; name: string }> }): ImportRow | null {
  const days = r.limit_days == null ? null : Number(r.limit_days);
  const limit = r.limit_amount == null || Number(r.limit_amount) <= 0 ? null : Number(r.limit_amount);
  if (days == null && limit == null) return null;
  if (days != null && (days < 0 || days > 365)) return null;              // поза межами таблиці пакета — лишаємо як було
  return {
    debtorKey: r.client_key, name: r.name, members: r.members.map((x) => ({ code: x.code, name: x.name || r.name })),
    limit, days, from: "inv", managerId: r.manager_id, managerName: r.manager_name,
    note: `діяв у дебіторці з ${ddmmyyyy(new Date(r.set_at))}${r.note ? ` (${r.note})` : ""}`, at: new Date(r.set_at).toISOString(),
  };
}

export async function migrateLegacyLimits(pool: Pool): Promise<{ inserted: number; skipped: number }> {
  const q = await pool.query(LEGACY_LIMITS_SQL);
  let inserted = 0, skipped = 0;
  for (const r of q.rows) {
    const row = legacyRow(r);
    if (!row) { skipped++; continue; }
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      (await importLimit(c, row)) === "inserted" ? inserted++ : skipped++;
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  }
  return { inserted, skipped };
}

/** Ефективні дні від дати рахунку для нинішнього екрана. */
export function effectiveDays(days: number | null, from: From): number | null {
  if (days == null) return null;
  return days + (from === "orig" ? DEFAULT_LAG.orig : from === "inv" ? DEFAULT_LAG.inv : DEFAULT_LAG.od);
}

interface LimitForMirror { id: string; debtorKey: string | null; active: boolean; limit: number | null; days: number | null; from: From; members: Array<{ code: string }> }

/** Знімок дзеркала: який ліміт дебіторки має стояти в кожного боржника, що має рядок у «Лімітах клієнтів». */
export function mirrorPlan(limits: LimitForMirror[], debtors: Array<{ key: string; codes: string[] }>):
  Map<string, { days: number | null; amount: number | null } | null> {
  const plan = new Map<string, { days: number | null; amount: number | null } | null>();
  for (const l of limits) {
    const keys = new Set<string>();
    if (l.debtorKey) keys.add(l.debtorKey);
    for (const d of debtors) if (matches({ debtorKey: l.debtorKey, members: l.members.map((m) => ({ code: m.code, name: "" })) }, d)) keys.add(d.key);
    for (const k of keys) {
      if (!l.active) { if (!plan.has(k)) plan.set(k, null); continue; }      // активний ліміт сильніший за знятий
      plan.set(k, { days: effectiveDays(l.days, l.from), amount: l.limit });
    }
  }
  return plan;
}

export async function mirrorToReceivables(pool: Pool, debts: DebtSource): Promise<{ set: number; cleared: number }> {
  const lim = await pool.query<{ id: string; debtor_key: string | null; active: boolean; limit_sum: string | null; days: number | null; count_from: From; codes: string[] | null }>(
    `SELECT l.id::text, l.debtor_key, l.active, l.limit_sum::numeric AS limit_sum, l.days, l.count_from,
            (SELECT array_agg(m.code) FROM client_limit_members m WHERE m.limit_id = l.id) AS codes
       FROM client_limits l`);
  const { list } = await debts.debtors();
  const plan = mirrorPlan(lim.rows.map((r) => ({ id: r.id, debtorKey: r.debtor_key, active: r.active, limit: r.limit_sum == null ? null : Number(r.limit_sum),
    days: r.days, from: r.count_from, members: (r.codes ?? []).map((code) => ({ code })) })), list);
  let set = 0, cleared = 0;
  const c: PoolClient = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const [key, v] of plan) {
      if (v == null) {
        const d = await c.query(`DELETE FROM client_credit_limits WHERE client_key = $1`, [key]);
        await c.query(`UPDATE receivables SET limit_days = NULL, limit_amount = NULL WHERE client_key = $1`, [key]);
        cleared += d.rowCount ?? 0;
        continue;
      }
      if (v.days != null) {
        await c.query(`INSERT INTO client_credit_limits (client_key, limit_days, limit_amount, note, set_by, set_at)
                       VALUES ($1, $2, $3, $4, NULL, now())
                       ON CONFLICT (client_key) DO UPDATE SET limit_days = EXCLUDED.limit_days, limit_amount = EXCLUDED.limit_amount, note = EXCLUDED.note
                        WHERE client_credit_limits.limit_days IS DISTINCT FROM EXCLUDED.limit_days
                           OR client_credit_limits.limit_amount IS DISTINCT FROM EXCLUDED.limit_amount`,
          [key, v.days, v.amount, MIRROR_NOTE]);
      } else {
        await c.query(`UPDATE client_credit_limits SET limit_amount = $2, note = $3 WHERE client_key = $1 AND limit_amount IS DISTINCT FROM $2`, [key, v.amount, MIRROR_NOTE]);
      }
      const u = await c.query(`UPDATE receivables SET limit_days = COALESCE($2, limit_days), limit_amount = $3
                                WHERE client_key = $1 AND (limit_days IS DISTINCT FROM COALESCE($2, limit_days) OR limit_amount IS DISTINCT FROM $3)`,
        [key, v.days, v.amount]);
      set += u.rowCount ?? 0;
    }
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  return { set, cleared };
}
