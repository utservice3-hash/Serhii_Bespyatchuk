/**
 * 🔄 `syncApprovals` — «UTS Утверждение оплат» (вкладка «На оплату») → `fin_approvals` кожні 30 хв (+ «Оновити з
 * таблиці» у «Фінансах»). Звідси з жовтня 2026 — факт «План/факт» і операційні «Тиждень і місяць» (задача Тетяни #5607).
 * Відмова (немає доступу, змінилась шапка, порожньо, масове зникнення) нічого не міняє: екрани показують останні добрі
 * дані, а причину — у плашці; мовчання понад 2 тіки піднімає тривогу (`MONITORED_JOBS`). Лише ЧИТАЄ таблицю.
 * ⏱ Прапорець «уже працює» має СТЕЛЮ (правило зони jobs-sync: завислий проміс не виконує `finally`).
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { readSheetRange } from "../bankSources/googleSheets.js";
import { parseApprovalRows } from "../core/paymentApprovals.js";
import { replaceApprovals, saveApprovalsError } from "../core/approvalsSync.js";
import { jobSkip } from "./jobRuns.js";
import type { Db } from "../core/finance.js";

const CEILING_MS = 10 * 60_000;
let running: number | null = null;
const configured = () => Boolean(config.ga4.serviceAccountJsonPath && config.approvalsSheet.spreadsheetId);

async function once(): Promise<{ rows: number }> {
  try {
    const lines = parseApprovalRows(await readSheetRange(config.approvalsSheet.spreadsheetId, `'${config.approvalsSheet.tab}'!A1:R`));
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await replaceApprovals(c as unknown as Db, lines);
      await c.query("COMMIT");
      return out;
    } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  } catch (e) {
    await saveApprovalsError(pool as unknown as Db, (e as Error).message).catch(() => undefined);
    throw e;
  }
}

/** Для крона: пропуск — це пропуск (`jobSkip`), а не успіх; обсяг — у підсумку («рядків N»). */
export async function syncApprovals(): Promise<unknown> {
  if (!configured()) return jobSkip("Таблиця оплат: не налаштовано ключ Google чи id таблиці");
  if (running && Date.now() - running < CEILING_MS) return jobSkip("Таблиця оплат: попередній синк ще йде");
  running = Date.now();
  try { return await once(); } finally { running = null; }
}

/** «Оновити з таблиці»: та сама дорога з відповіддю людині. Зайнято — `busy`, відмова — причина словами. */
export async function runApprovalsSyncNow(): Promise<{ ok: boolean; busy?: boolean; error?: string; rows?: number }> {
  if (!configured()) return { ok: false, error: "Синк таблиці оплат не налаштовано на сервері" };
  if (running && Date.now() - running < CEILING_MS) return { ok: false, busy: true, error: "Синк уже йде — спробуйте за хвилину" };
  running = Date.now();
  try { return { ok: true, ...(await once()) }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
  finally { running = null; }
}
