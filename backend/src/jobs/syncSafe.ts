/**
 * 🔄 `syncSafe` — Сейф із Google-таблиці кожні 30 хв (+ «Оновити зараз» у вікні Сейфу). Ядро — `core/safeSync.ts`.
 * Відмова (немає доступу, змінилась шапка, порожньо, масове зникнення) нічого не пише: дашборд показує останні
 * збережені дані й плашку з причиною; мовчання понад 2 тіки (1 год) піднімає наявну тривогу в Telegram
 * (`MONITORED_JOBS`).
 * ⏱ Прапорець «уже працює» має СТЕЛЮ (правило зони jobs-sync: завислий проміс не виконує `finally`).
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { getRate } from "../bankSources/fx.js";
import { readSheetRange, sheetsConfigured } from "../bankSources/googleSheets.js";
import { parseSafeSheet, reconcileSafe, saveSafeSyncState, type ReconcileResult } from "../core/safeSync.js";
import { jobSkip } from "./jobRuns.js";
import type { Db } from "../core/finance.js";

const CEILING_MS = 10 * 60_000;
let running: number | null = null;

async function once(): Promise<{ result: ReconcileResult; sheetBalances: Record<string, number> }> {
  const acc = (await pool.query<{ id: number }>(`SELECT id FROM bank_accounts WHERE bank = 'manual' AND label = 'Сейф' ORDER BY id LIMIT 1`)).rows[0];
  if (!acc) throw new Error("Рахунку «Сейф» немає");
  try {
    const sheet = parseSafeSheet(await readSheetRange(config.safeSheet.spreadsheetId, `${config.safeSheet.tab}!A1:J`));
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await reconcileSafe(c as unknown as Db, acc.id, sheet, (ccy, day) => getRate(ccy, new Date(`${day}T12:00:00Z`)));
      await saveSafeSyncState(c as unknown as Db, { result, sheetBalances: sheet.sheetBalances });
      await c.query("COMMIT");
      return { result, sheetBalances: sheet.sheetBalances };
    } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  } catch (e) {
    await saveSafeSyncState(pool as unknown as Db, { error: (e as Error).message }).catch(() => undefined);
    throw e;
  }
}

/** Для крона: пропуск — це пропуск (`jobSkip`), а не успіх; обсяг — у підсумку («прочитано N»). */
export async function syncSafe(): Promise<unknown> {
  if (!sheetsConfigured()) return jobSkip("Сейф: не налаштовано ключ Google чи id таблиці");
  if (running && Date.now() - running < CEILING_MS) return jobSkip("Сейф: попередній синк ще йде");
  running = Date.now();
  try { const out = await once(); return { seen: out.result.seen, inserted: out.result.inserted, vanished: out.result.vanished }; }
  finally { running = null; }
}

/** «Оновити зараз»: та сама дорога, але з відповіддю людині. Зайнято — 409, відмова — причина словами. */
export async function runSafeSyncNow(): Promise<{ ok: boolean; busy?: boolean; error?: string; result?: ReconcileResult }> {
  if (!sheetsConfigured()) return { ok: false, error: "Синк Сейфу не налаштовано на сервері" };
  if (running && Date.now() - running < CEILING_MS) return { ok: false, busy: true, error: "Синк уже йде — спробуйте за хвилину" };
  running = Date.now();
  try { const out = await once(); return { ok: true, result: out.result }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
  finally { running = null; }
}
