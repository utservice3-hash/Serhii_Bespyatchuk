/**
 * 📤 `exportDataSheet` — щодня о 07:10 (Київ) дописує у вкладку «Data» фінансів «💰UTS (CF, PL, BS)» банківські операції,
 * яких там ще немає (18.11.2026, Роман; погоджено з фінансистом Олександром). Правило рядка й склад запиту —
 * `core/dataSheetRows.ts`; запис — `insertDataRows` (вставка після останнього рядка, один атомарний batchUpdate).
 *
 * Облік «що вже в Data» — `data_sheet_exports`, У ДВА КРОКИ, бо дубль у фінансах гірший за пропуск:
 *   1) перед записом — `pending`; 2) Google відповів успіхом — `done`; Google відмовив — `pending` прибираються (запит
 *   атомарний, нічого не лягло); запит обірвався без відповіді — `pending` ЛИШАЮТЬСЯ, і кожен наступний прогін падає
 *   з переліком id, доки людина не звірить Data й не вирішить (рядки могли лягти, а могли ні — вгадувати не можна).
 * Невідомий рахунок (новий у «Виписці») — НЕ мовчки: решта пишеться, а прогін завершується помилкою з переліком.
 *
 * Режим `DATA_SHEET_MODE`: `dry` (за замовчуванням) — рахує й звітує в `job_runs`, у таблицю й облік НЕ пише;
 * `on` — пише; `off` — пропуск. ⏱ Прапорець «уже працює» має стелю (правило зони jobs-sync).
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { jobSkip } from "./jobRuns.js";
import { EXPORT_SELECT_SQL, DATA_SHEET_FROM, DATA_SHEET_MAX_ROWS, splitForExport, type ExportTx } from "../core/dataSheetRows.js";
import { insertDataRows, DataSheetWriteError } from "../bankSources/googleSheetsWrite.js";

const CEILING_MS = 15 * 60_000;
let running: number | null = null;

export async function exportDataSheet(): Promise<unknown> {
  const { mode } = config.dataSheet;
  if (mode === "off") return jobSkip("Data: вимкнено (DATA_SHEET_MODE=off)");
  if (mode !== "dry" && mode !== "on") throw new Error(`Data: невідомий режим DATA_SHEET_MODE «${mode}» — очікую off | dry | on`);
  if (running && Date.now() - running < CEILING_MS) return jobSkip("Data: попередній прогін ще йде");
  running = Date.now();
  try { return await once(mode); }
  finally { running = null; }
}

async function once(mode: "dry" | "on"): Promise<Record<string, unknown>> {
  const stuck = (await pool.query<{ tx_id: number; run_at: Date }>(
    `SELECT tx_id, run_at FROM data_sheet_exports WHERE status = 'pending' ORDER BY tx_id LIMIT 50`)).rows;
  if (stuck.length) {
    throw new Error(`Data: ${stuck.length >= 50 ? "50+" : stuck.length} операцій «у процесі» з прогону ${stuck[0].run_at.toISOString()} — `
      + "запит до Google обірвався без відповіді, рядки могли лягти, а могли ні. Звірте Data вручну; далі — або позначити "
      + `done, або прибрати pending. id: ${stuck.map((s) => s.tx_id).join(", ")}`);
  }
  const txs = (await pool.query<ExportTx>(EXPORT_SELECT_SQL, [DATA_SHEET_FROM])).rows;
  const split = splitForExport(txs);
  const rows = split.rows.slice(0, DATA_SHEET_MAX_ROWS);
  const byAccount: Record<string, number> = {};
  for (const r of rows) byAccount[r.m] = (byAccount[r.m] ?? 0) + 1;
  const summary: Record<string, unknown> = {
    mode, rows: rows.length, deferred: split.rows.length - rows.length, byAccount,
    excluded: split.excluded, unmapped: split.unmapped,
    days: rows.length ? [rows[0].e, rows[rows.length - 1].e] : null,
  };

  if (mode === "on" && rows.length) {
    const { spreadsheetId, tab } = config.dataSheet;
    if (!spreadsheetId) throw new Error("Data: не задано DATA_SHEET_ID");
    if (!config.ga4.serviceAccountJsonPath) throw new Error("Data: немає ключа сервісного акаунта Google (GA4_SERVICE_ACCOUNT_JSON)");
    const ids = rows.map((r) => r.txId);
    // Ключ прогону — перелік id, а не run_at: позначка часу втрачає мікросекунди дорогою в JS і перестає збігатися (#9984).
    await pool.query(`INSERT INTO data_sheet_exports (tx_id, status, run_at) SELECT unnest($1::int[]), 'pending', now()`, [ids]);
    let out: { lastRow: number; inserted: number };
    try { out = await insertDataRows(spreadsheetId, tab, rows); }
    catch (e) {
      if (e instanceof DataSheetWriteError && e.applied === "no") {
        await pool.query(`DELETE FROM data_sheet_exports WHERE status = 'pending' AND tx_id = ANY($1::int[])`, [ids]);
      }
      throw e;
    }
    await pool.query(
      `UPDATE data_sheet_exports x SET status = 'done', sheet_row = v.r
         FROM unnest($1::int[], $2::int[]) AS v(id, r)
        WHERE x.tx_id = v.id AND x.status = 'pending'`,
      [ids, ids.map((_, i) => out.lastRow + 1 + i)]);
    summary.firstRow = out.lastRow + 1;
  }

  if (split.unmapped.length) {
    throw new Error(`Data: ${mode === "on" ? `записано ${rows.length}, але ` : ""}операції рахунків, яких немає у відповідності Data, `
      + `НЕ записано — ${split.unmapped.map((u) => `рахунок ${u.accountId}: ${u.count}`).join("; ")}. Впишіть рахунок у `
      + "DATA_SHEET_ACCOUNTS (core/dataSheetRows.ts) або в DATA_SHEET_EXCLUDED із причиною");
  }
  return summary;
}
