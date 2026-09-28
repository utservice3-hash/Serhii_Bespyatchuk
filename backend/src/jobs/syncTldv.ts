/**
 * 🎥 ДЖОБА: ЗАПИСИ СПІВБЕСІД З tl;dv (23.09.2026, прохід 7). Раз на 15 хв бере зустрічі за останні дні й
 * привʼязує певні збіги до рядків графіка; решта чекає рішення людини в «Графіку».
 *
 * 🔴 БЕЗ КЛЮЧА — ЧЕСНИЙ ПРОПУСК, А НЕ «НУЛЬ ЗУСТРІЧЕЙ». Порожній список і «нема доступу» — різні стани, і
 * плутати їх не можна: перший означає «сьогодні не було співбесід», другий — «інтеграція не працює».
 * `jobSkip` веде лічильник пропусків, тож мовчазна смерть інтеграції стане видимою (правило «успіх за 0 мс»).
 */
import type { JobSkip } from "./jobRuns.js";
import { TLDV_BASE, parseMeetings } from "../core/tldv.js";
import { absorb, slotRows } from "../core/tldvStore.js";
import type { Db } from "../core/secrets.js";

export interface TldvStatus { configured: boolean; lastRunAt: string | null; lastError: string | null; seen: number; linked: number; pending: number }
const status: TldvStatus = { configured: false, lastRunAt: null, lastError: null, seen: 0, linked: 0, pending: 0 };
export const getTldvStatus = (): TldvStatus => ({ ...status, configured: !!process.env.TLDV_API_KEY });

const kyivDay = (shiftDays = 0) =>
  new Date(Date.now() + shiftDays * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

/** Днів назад: перезапис бере вчорашні зустрічі, якщо tl;dv обробляв запис довго. */
export const LOOKBACK_DAYS = 3;

export async function syncTldv(days = LOOKBACK_DAYS) {
  const key = process.env.TLDV_API_KEY;
  // ⚠️ `jobSkip` — ЛИШЕ тип: `jobRuns.js` тягне `db/pool.js`, який кидає на відсутньому `DATABASE_URL` ще на
  // імпорті. Форма пропуску та сама, яку читає `runJob` (`{ skipped, reason }`), і саме її звіряє #733.
  if (!key) return { skipped: true, reason: "немає TLDV_API_KEY — записи співбесід не забираємо" } satisfies JobSkip;
  const from = kyivDay(-days), to = kyivDay(1);
  const url = `${TLDV_BASE}/v1alpha1/meetings?from=${from}&to=${to}&limit=100`;
  const res = await fetch(url, { headers: { "x-api-key": key } });
  if (!res.ok) {
    status.lastError = `tl;dv ${res.status}`;
    throw new Error(`tl;dv API ${res.status}`);
  }
  const meetings = parseMeetings(await res.json());
  // 🔴 Пул імпортуємо ПІСЛЯ перевірки ключа: `db/pool.js` кидає на відсутньому `DATABASE_URL` ще на імпорті,
  // і тоді «немає ключа» падало б помилкою оточення замість чесного пропуску (той самий клас, що ліниві
  // імпорти в БД-тестах).
  const { pool } = await import("../db/pool.js");
  const db = pool as unknown as Db;
  const out = await absorb(db, meetings, await slotRows(db, from, to));
  Object.assign(status, { lastRunAt: new Date().toISOString(), lastError: null, ...out });
  return out;
}
