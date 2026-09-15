/**
 * Живий стан офер-гейта з БД (правило — у `core/offerGate.ts`, без БД).
 * Кеш 60 с на користувача: гейт стоїть у `requireAuth` на КОЖНОМУ запиті, без кешу це
 * плюс один запит до Neon на кожен клік. Підпис офера скидає кеш (`invalidateOfferGate`),
 * тож після підпису доступ відкривається без релогіну і без очікування хвилини.
 */
import { pool } from "../db/pool.js";
import { offerPending } from "../core/offerGate.js";

const TTL_MS = 60_000;
const cache = new Map<number, { pending: boolean; until: number }>();

const SQL = `
  SELECT COALESCE(u.role_override, u.role) AS role_key, u.created_at,
         EXISTS (
           SELECT 1 FROM doc_files f
             JOIN doc_signatures s ON s.file_id = f.id AND s.version = f.version AND s.sha256 = f.sha256
            WHERE f.section = 'offer' AND f.addressee_user_id = u.id AND f.archived_at IS NULL
         ) AS has_signed_offer
    FROM users u WHERE u.id = $1`;

export async function offerPendingFor(userId: number): Promise<boolean> {
  const hit = cache.get(userId);
  const now = Date.now();
  if (hit && hit.until > now) return hit.pending;
  const r = await pool.query<{ role_key: string; created_at: string; has_signed_offer: boolean }>(SQL, [userId]);
  const row = r.rows[0];
  // Невідомий користувач → не обмежуємо: 401/403 йому дасть інший шар, а хибне «чекає офер»
  // закрило б екран людині, якої в базі немає з іншої причини.
  const pending = row ? offerPending({ roleKey: row.role_key, createdAt: row.created_at, hasSignedOffer: row.has_signed_offer }) : false;
  cache.set(userId, { pending, until: now + TTL_MS });
  return pending;
}

export function invalidateOfferGate(userId: number): void { cache.delete(userId); }
