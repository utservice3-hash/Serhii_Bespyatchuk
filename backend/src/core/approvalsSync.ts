/**
 * 🗄 ЗАПИС ДЗЕРКАЛА «UTS Утверждение оплат» у `fin_approvals` (21.10.2026). Окремо від `paymentApprovals.ts`, який лише
 * читає (тримає #1277d). Вміст замінюється ЦІЛКОМ в одній транзакції — і лише після перевірок: розбір таблиці вже
 * звірив шапку; порожньо — відмова; зникло понад 10% рядків проти минулого синку — відмова (так само, як у Сейфу:
 * обрізана вкладка не має тихо стерти жовтень). Відмова нічого не пише, крім причини в `fin_approvals_state`.
 */
import type { Db } from "./finance.js";
import type { ApprovalLine } from "./paymentApprovals.js";

export const MAX_DROP_SHARE = 0.1;

/** Чи можна замінити `prev` рядків на `next`: не порожньо і зникло не більше 10%. Відмова — причина словами. */
export function replaceVerdict(prev: number | null, next: number): string | null {
  if (next <= 0) return "Таблиця «Утверждение оплат»: у вкладці немає жодного рядка — нічого не змінено";
  if (prev != null && prev > 0 && next < prev * (1 - MAX_DROP_SHARE))
    return `Таблиця «Утверждение оплат»: рядків стало ${next} замість ${prev} (зникло понад 10%) — нічого не змінено, перевірте вкладку`;
  return null;
}

/** Замінює дзеркало на `lines` (у відкритій транзакції `db`) і пише стан. Відмова — `Error` з причиною. */
export async function replaceApprovals(db: Db, lines: readonly ApprovalLine[]): Promise<{ rows: number }> {
  const prev = (await db.query(`SELECT rows FROM fin_approvals_state WHERE id = 1`)).rows[0]?.rows ?? null;
  const why = replaceVerdict(prev, lines.length);
  if (why) throw new Error(why);
  await db.query(`DELETE FROM fin_approvals`);
  for (let i = 0; i < lines.length; i += 1000) {
    const part = lines.slice(i, i + 1000);
    await db.query(`INSERT INTO fin_approvals (row_no, entry_date, pay_date, pay_raw, what, category, amount, direction, paid)
      SELECT * FROM unnest($1::int[], $2::date[], $3::date[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::bool[])`,
    [part.map((l) => l.row), part.map((l) => l.entryDate), part.map((l) => l.payDate), part.map((l) => l.payRaw), part.map((l) => l.what),
      part.map((l) => l.category), part.map((l) => l.amount), part.map((l) => l.direction), part.map((l) => l.paid)]);
  }
  await db.query(`INSERT INTO fin_approvals_state (id, synced_at, rows, error, error_at) VALUES (1, now(), $1, NULL, NULL)
    ON CONFLICT (id) DO UPDATE SET synced_at = now(), rows = EXCLUDED.rows`, [lines.length]);
  return { rows: lines.length };
}

/** Відмова синку — причина в стані; останні добрі дані лишаються. */
export async function saveApprovalsError(db: Db, message: string): Promise<void> {
  await db.query(`INSERT INTO fin_approvals_state (id, error, error_at) VALUES (1, $1, now())
    ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error, error_at = now()`, [message.slice(0, 500)]);
}
