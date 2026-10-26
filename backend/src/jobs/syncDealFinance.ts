/**
 * 🔄 `syncDealFinance` — фінансові поля успішних угод «Повного циклу» з Kommo в `deal_fin_fields` кожні 30 хв (о :05 і
 * :35) — задача #5583, 26.10.2026. Інкремент за датою зміни в Kommo (з запасом 10 хв), лише етап «Успішна» обох воронок
 * «Повного циклу», без контактів: за годину таких змін одиниці (заміряно: 6 угод, 1,8 с). Разовий бекфіл —
 * `--backfill=2026-01-01` (за датою закриття). «Оновити з Kommo» на екрані кличе той самий інкремент. Пропуск —
 * `jobSkip`, не успіх; помилка — у стані. Лише ЧИТАЄ Kommo.
 * ⏱ Прапорець «уже працює» має СТЕЛЮ (правило зони jobs-sync: завислий проміс не виконує `finally`).
 */
import { pool } from "../db/pool.js";
import { fetchLeadsLean } from "../kommo/client.js";
import { upsertDealFin, incrementQuery, backfillQuery, OVERLAP_S } from "../core/dealFinSync.js";
import { jobSkip } from "./jobRuns.js";
import type { Db } from "../core/finance.js";

const CEILING_MS = 20 * 60_000;
let running: number | null = null;

async function once(mode: { backfillFrom?: string }): Promise<{ deals: number; since: string }> {
  const db = pool as unknown as Db;
  try {
    const st = (await db.query(`SELECT watermark FROM deal_fin_state WHERE id = 1`)).rows[0];
    let query: string, since: string;
    if (mode.backfillFrom) {
      since = mode.backfillFrom;
      query = backfillQuery(mode.backfillFrom);
    } else {
      const wm = st?.watermark ? new Date(st.watermark).getTime() / 1000 : Date.now() / 1000 - 2 * 3600;
      since = new Date((wm - OVERLAP_S) * 1000).toISOString();
      query = incrementQuery(wm);
    }
    const deals = await fetchLeadsLean(query, mode.backfillFrom ? 80 : 20);
    await upsertDealFin(db, deals);
    const maxUpd = deals.reduce((m, d) => Math.max(m, d.updated_at ?? 0), 0);
    await db.query(`INSERT INTO deal_fin_state (id, watermark, synced_at, last_count, error, error_at) VALUES (1, $1, now(), $2, NULL, NULL)
      ON CONFLICT (id) DO UPDATE SET watermark = GREATEST(deal_fin_state.watermark, EXCLUDED.watermark), synced_at = now(), last_count = EXCLUDED.last_count, error = NULL, error_at = NULL`,
    [maxUpd ? new Date(maxUpd * 1000) : (st?.watermark ?? new Date()), deals.length]);
    return { deals: deals.length, since };
  } catch (e) {
    await db.query(`INSERT INTO deal_fin_state (id, error, error_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error, error_at = now()`,
      [(e as Error).message.slice(0, 500)]).catch(() => undefined);
    throw e;
  }
}

/** Для крона й кнопки «Оновити з Kommo»: пропуск — `jobSkip`, не успіх; обсяг — у підсумку. */
export async function syncDealFinance(mode: { backfillFrom?: string } = {}): Promise<unknown> {
  if (running && Date.now() - running < CEILING_MS) return jobSkip("Фінансові поля угод: попередній синк ще йде");
  running = Date.now();
  try { return await once(mode); } finally { running = null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.find((a) => a.startsWith("--backfill="));
  syncDealFinance(arg ? { backfillFrom: arg.slice(11, 21) } : {}).then((r) => console.log("syncDealFinance:", JSON.stringify(r)))
    .catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
