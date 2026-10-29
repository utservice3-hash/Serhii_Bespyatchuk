import type { OrsQuota } from "./orsClient.js";

/**
 * 📊 ЗАЛИШОК ЗАПИТІВ СЕРВІСУ МАРШРУТІВ НА СЬОГОДНІ — у «Калькулятор → Статистика» (Роман 29.10.2026: «лише в статистиці,
 * попередження при менше 200»). Число бере сервіс сам у кожній відповіді; окремо його НЕ питаємо, щоб не витрачати ліміт.
 * Тому воно оновлюється, лише коли рахується НОВИЙ маршрут (з кешу — ліміт не витрачається й число не міняється).
 */
export const QUOTA_LOW = 200; // Роман 29.10.2026: попередження, коли лишилось менше 200
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export const QUOTA_SAVE_SQL = `INSERT INTO service_quota (service, quota_limit, remaining, reset_at, seen_at)
  VALUES ('ors', $1, $2, $3, now())
  ON CONFLICT (service) DO UPDATE SET quota_limit = EXCLUDED.quota_limit, remaining = EXCLUDED.remaining,
    reset_at = EXCLUDED.reset_at, seen_at = EXCLUDED.seen_at`;
export const QUOTA_LOAD_SQL = `SELECT quota_limit, remaining, reset_at, seen_at FROM service_quota WHERE service = 'ors'`;

export async function saveQuota(db: Db, q: OrsQuota): Promise<void> {
  await db.query(QUOTA_SAVE_SQL, [q.limit, q.remaining, q.resetAt]);
}

export interface QuotaView { limit: number; remaining: number; reset_at: string | null; seen_at: string; renewed: boolean; low: boolean }

/** Останнє, що сказав сервіс → що показати зараз. Минув час оновлення — ліміт уже повний, а не вчорашній залишок (#2796). */
export function quotaView(row: { quota_limit: unknown; remaining: unknown; reset_at: unknown; seen_at: unknown } | undefined, now: Date): QuotaView | null {
  if (!row) return null;
  const limit = Number(row.quota_limit), left = Number(row.remaining);
  if (!Number.isFinite(limit) || !Number.isFinite(left)) return null;
  const reset = row.reset_at ? new Date(row.reset_at as string | Date) : null;
  const renewed = !!reset && reset.getTime() <= now.getTime();
  const remaining = renewed ? limit : left;
  return { limit, remaining, reset_at: reset ? reset.toISOString() : null, seen_at: new Date(row.seen_at as string | Date).toISOString(),
    renewed, low: remaining < QUOTA_LOW };
}

export async function loadQuota(db: Db, now: Date = new Date()): Promise<QuotaView | null> {
  const r = await db.query(QUOTA_LOAD_SQL);
  return quotaView(r.rows[0] as Parameters<typeof quotaView>[0], now);
}
