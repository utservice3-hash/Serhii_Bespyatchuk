/**
 * 🔁 ЦИКЛ РЕАКТИВАЦІЇ І ПУЛ ЛІДГЕНІВ — ЗАПИТИ (ТЗ Юлі 22.09.2026, блок 4; задача 4313).
 * Правило — у `reactCycleRules.ts` (чисте); тут лише читання й запис `client_react_cycles`.
 *
 * `db` передається явно (як у `hiring.ts`): гейти ганяють ці функції на одноразовому кластері
 * своїм клієнтом, а роут — пулом або клієнтом транзакції.
 *
 * 🔴 ПУЛ ЖИВЕ ЛИШЕ В ДАШБОРДІ. Відповідального в Kommo не змінюємо (масовий запис у CRM — тільки за
 * окремим словом). Поки клієнт у пулі, відповідальним лишається попередній менеджер (гроші — за
 * угодою, рішення 3). «Взяти» закріплює клієнта за лідгеном тим самим `loyalty_overrides`, що й
 * кнопка «Передати клієнта» (вид `fix` — з поточного місяця), і пише історію передачі.
 */
import {
  type CycleRow, type Decision, type PoolReason,
  inReact, cycleMonthOf, allowedDecisions, statusOf, deadlineMonth, daysLeft,
} from "./reactCycleRules.js";

export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}

export class ReactCycleError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type DbRow = {
  client_key: string; cycle_month: string; decision: Decision | null; decided_month: string | null;
  pooled: boolean; pool_reason: PoolReason | null; closed: boolean; close_reason: "invoice" | "taken" | null;
};
const ROW_COLS = `client_key, to_char(cycle_month, 'YYYY-MM') AS cycle_month, decision,
  to_char(decided_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM') AS decided_month,
  (pooled_at IS NOT NULL) AS pooled, pool_reason, (closed_at IS NOT NULL) AS closed, close_reason`;
const toRow = (r: DbRow): CycleRow => ({
  cycleMonth: r.cycle_month, decision: r.decision, decidedMonth: r.decided_month,
  pooled: r.pooled, poolReason: r.pool_reason, closed: r.closed, closeReason: r.close_reason,
});

/** Усі рядки циклів по ключах (будь-які місяці). */
export async function cyclesFor(db: Db, keys: string[]): Promise<Map<string, CycleRow[]>> {
  const out = new Map<string, CycleRow[]>();
  if (!keys.length) return out;
  const r = await db.query<DbRow>(`SELECT ${ROW_COLS} FROM client_react_cycles WHERE client_key = ANY($1)`, [keys]);
  for (const x of r.rows) {
    const arr = out.get(x.client_key) ?? [];
    arr.push(toRow(x));
    out.set(x.client_key, arr);
  }
  return out;
}

/** Рядок ПОТОЧНОГО циклу клієнта (або null — рішення ще не було). */
export function currentRow(rows: CycleRow[] | undefined, lastInvoice: string | null): CycleRow | null {
  const cm = cycleMonthOf(lastInvoice);
  return (rows ?? []).find((r) => r.cycleMonth === cm) ?? null;
}

/**
 * Кнопка 4.2. «self» — лишити за собою (раз за цикл, зі строком до кінця наступного місяця);
 * «leadgen» — у пул зараз (можна й після «self», якщо менеджер передумав).
 */
export async function decide(db: Db, a: {
  clientKey: string; decision: Decision; userId: number; managerId: number | null;
  lastInvoice: string | null; nowYm: string;
}): Promise<{ cycleMonth: string; status: string }> {
  if (!inReact(a.lastInvoice, a.nowYm)) {
    throw new ReactCycleError(409, "Клієнт не в реактивації: рахунок за останні 3 місяці є");
  }
  const cm = cycleMonthOf(a.lastInvoice);
  const rows = (await cyclesFor(db, [a.clientKey])).get(a.clientKey);
  const row = currentRow(rows, a.lastInvoice);
  if (!allowedDecisions(row).includes(a.decision)) {
    throw new ReactCycleError(409, a.decision === "self"
      ? "«Реактивую сам» уже натискали в цьому циклі — строк не продовжується"
      : "Клієнт уже в пулі лідгенів або взятий лідгеном");
  }
  const pool = a.decision === "leadgen";
  try {
    // 🔴 Одним запитом і вставка, і оновлення «сам → лідгенам»: CHECK-и крос-колонкові, тож поле й
    // його пара їдуть разом (правило про ON CONFLICT і CHECK, `.claude/rules/db-sql.md`).
    const r = await db.query(
      `INSERT INTO client_react_cycles (client_key, cycle_month, decision, decided_by, decided_at,
                                        pooled_at, pool_reason, from_manager_id)
       VALUES ($1, ($2 || '-01')::date, $3, $4, now(),
               CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN 'manager' END, $6)
       ON CONFLICT (client_key, cycle_month) DO UPDATE
          SET decision = EXCLUDED.decision, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at,
              pooled_at = EXCLUDED.pooled_at, pool_reason = EXCLUDED.pool_reason, from_manager_id = EXCLUDED.from_manager_id
        WHERE client_react_cycles.pooled_at IS NULL AND client_react_cycles.closed_at IS NULL AND $5`,
      [a.clientKey, cm, a.decision, a.userId, pool, a.managerId]);
    if (!r.rowCount) throw new ReactCycleError(409, "Рішення вже є — оновіть сторінку");
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new ReactCycleError(409, "Клієнт уже в пулі лідгенів");
    throw e;
  }
  return { cycleMonth: cm, status: pool ? "pool" : "self" };
}

export interface PoolItem {
  clientKey: string; cycleMonth: string; pooledAt: string; poolReason: PoolReason;
  fromManagerId: number | null; fromManagerName: string | null;
}

/** Відкриті рядки пулу — сирі. Роут ще звіряє кожен з рахунками (4.4), бо ніч могла не дійти. */
export async function openPool(db: Db): Promise<PoolItem[]> {
  const r = await db.query<{ client_key: string; cycle_month: string; pooled_at: string; pool_reason: PoolReason;
    from_manager_id: number | null; from_name: string | null }>(
    `SELECT c.client_key, to_char(c.cycle_month, 'YYYY-MM') AS cycle_month,
            to_char(c.pooled_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS pooled_at, c.pool_reason,
            c.from_manager_id, m.name AS from_name
       FROM client_react_cycles c LEFT JOIN managers m ON m.id = c.from_manager_id
      WHERE c.pooled_at IS NOT NULL AND c.closed_at IS NULL
      ORDER BY c.pooled_at, c.client_key`);
  return r.rows.map((x) => ({ clientKey: x.client_key, cycleMonth: x.cycle_month, pooledAt: x.pooled_at,
    poolReason: x.pool_reason, fromManagerId: x.from_manager_id, fromManagerName: x.from_name }));
}

/** Закрити відкриті рядки пулу, бо клієнт ожив (є рахунок). Ідемпотентно. */
export async function closeRevived(db: Db, items: { clientKey: string; cycleMonth: string }[]): Promise<number> {
  let n = 0;
  for (const it of items) {
    const r = await db.query(
      `UPDATE client_react_cycles SET closed_at = now(), close_reason = 'invoice'
        WHERE client_key = $1 AND cycle_month = ($2 || '-01')::date AND pooled_at IS NOT NULL AND closed_at IS NULL`,
      [it.clientKey, it.cycleMonth]);
    n += r.rowCount ?? 0;
  }
  return n;
}

/** Автопередача (4.3). Ідемпотентно: рядок, що вже в пулі чи закритий, не чіпається. */
export async function poolAuto(db: Db, items: { clientKey: string; cycleMonth: string; reason: PoolReason; fromManagerId: number | null }[]): Promise<number> {
  let n = 0;
  for (const it of items) {
    try {
      const r = await db.query(
        `INSERT INTO client_react_cycles (client_key, cycle_month, pooled_at, pool_reason, from_manager_id)
         VALUES ($1, ($2 || '-01')::date, now(), $3, $4)
         ON CONFLICT (client_key, cycle_month) DO UPDATE
            SET pooled_at = EXCLUDED.pooled_at, pool_reason = EXCLUDED.pool_reason, from_manager_id = EXCLUDED.from_manager_id
          WHERE client_react_cycles.pooled_at IS NULL AND client_react_cycles.closed_at IS NULL`,
        [it.clientKey, it.cycleMonth, it.reason, it.fromManagerId]);
      n += r.rowCount ?? 0;
    } catch (e) {
      if ((e as { code?: string }).code !== "23505") throw e;   // уже в пулі іншим рядком — не дублюємо
    }
  }
  return n;
}

/**
 * «Взяти» з пулу. Викликати ВСЕРЕДИНІ транзакції (`db` — клієнт після BEGIN): закриття рядка й
 * закріплення за лідгеном мають статись разом або не статись зовсім.
 * Двоє тиснуть одночасно → UPDATE … WHERE closed_at IS NULL пропускає рівно одного.
 */
export async function take(db: Db, a: {
  clientKey: string; managerId: number; userId: number; lastInvoice: string | null; nowYm: string; effectiveFrom: string;
}): Promise<{ fromManagerId: number | null; cycleMonth: string }> {
  if (!inReact(a.lastInvoice, a.nowYm)) {
    // 4.4: у клієнта є рахунок за 3 місяці — лідгену його не можна; рядок пулу закриваємо тут же.
    await db.query(
      `UPDATE client_react_cycles SET closed_at = now(), close_reason = 'invoice'
        WHERE client_key = $1 AND pooled_at IS NOT NULL AND closed_at IS NULL`, [a.clientKey]);
    throw new ReactCycleError(409, "Клієнт ожив: є рахунок за останні 3 місяці — він лишається за менеджером");
  }
  const r = await db.query<{ cycle_month: string; from_manager_id: number | null }>(
    `UPDATE client_react_cycles SET taken_by_manager_id = $2, taken_at = now(), closed_at = now(), close_reason = 'taken'
      WHERE client_key = $1 AND pooled_at IS NOT NULL AND closed_at IS NULL
      RETURNING to_char(cycle_month, 'YYYY-MM') AS cycle_month, from_manager_id`, [a.clientKey, a.managerId]);
  if (!r.rowCount) throw new ReactCycleError(409, "Клієнта вже взяли або його немає в пулі");
  const cur = await db.query<{ pinned_manager_id: number | null }>(
    `SELECT pinned_manager_id FROM loyalty_overrides WHERE client_key = $1`, [a.clientKey]);
  await db.query(
    `INSERT INTO loyalty_overrides (client_key, pinned_manager_id, pinned_from_month, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (client_key) DO UPDATE SET pinned_manager_id = EXCLUDED.pinned_manager_id,
       pinned_from_month = EXCLUDED.pinned_from_month, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [a.clientKey, a.managerId, a.effectiveFrom, a.userId]);
  await db.query(
    `INSERT INTO client_manager_history (client_key, from_manager_id, to_manager_id, effective_from, reason, changed_by, kind)
     VALUES ($1, $2, $3, $4, $5, $6, 'fix')`,
    [a.clientKey, cur.rows[0]?.pinned_manager_id ?? r.rows[0].from_manager_id, a.managerId, a.effectiveFrom,
     "Взято з пулу лідгенів (реактивація)", a.userId]);
  return { fromManagerId: r.rows[0].from_manager_id, cycleMonth: r.rows[0].cycle_month };
}

/** Чи є менеджер лідгеном: активний член дашбордної команди «Лідогенерація». */
export async function isLeadgenManager(db: Db, managerId: number | null | undefined, leadgenTeamId: number): Promise<boolean> {
  if (!managerId) return false;
  const r = await db.query(`SELECT 1 FROM managers WHERE id = $1 AND team_id = $2 AND is_active`, [managerId, leadgenTeamId]);
  return (r.rowCount ?? 0) > 0;
}

/** Показ циклу в рядку/картці — лише для клієнтів у реактивації. */
export function cycleView(lastInvoice: string | null, rows: CycleRow[] | undefined, todayYmd: string) {
  const cm = cycleMonthOf(lastInvoice);
  const row = currentRow(rows, lastInvoice);
  const dl = deadlineMonth(cm, row);
  return {
    cycleMonth: cm,
    lastInvoice,
    status: statusOf(row),
    poolReason: row?.poolReason ?? null,
    deadline: dl,
    daysLeft: dl ? Math.max(0, daysLeft(dl, todayYmd)) : null,
    allowed: allowedDecisions(row),
  };
}
