/**
 * 🔄 `syncUnpaidInvoices` — неоплачені рахунки 1С з 2026 року щогодини о :15 (задача #5297, 26.10.2026; рішення Романа
 * «лише 2026 рік і щоб можна було глянути, що там не так»). Той самий сервіс 1С, що дебіторка 361 (адреса — поруч із
 * `RECEIVABLES_1C_URL`), кінцівка `unpaid-invoices?from=2026-01-01`. Пише список рахунків і підсумок «Валютної
 * дебіторки» в журнал однією транзакцією. Відмова (немає відповіді, `state: false`, нуль рахунків) нічого не міняє:
 * екран показує останнє добре число й причину; мовчання понад 2 тіки піднімає тривогу (`MONITORED_JOBS`). Лише ЧИТАЄ 1С
 * (~15–22 с). Курси НБУ — лише для гривневого еквівалента; недоступні — валюта лишається у своєму числі.
 * ⏱ Прапорець «уже працює» має СТЕЛЮ (правило зони jobs-sync: завислий проміс не виконує `finally`).
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { getRate } from "../bankSources/fx.js";
import { parseUnpaid, UNPAID_FROM } from "../core/unpaidInvoices.js";
import { replaceUnpaid, saveUnpaidError } from "../core/unpaidSync.js";
import { jobSkip } from "./jobRuns.js";
import type { Db } from "../core/finance.js";

const CEILING_MS = 10 * 60_000;
let running: number | null = null;
/** `…/hs/service/debit-balance-account-361` → `…/hs/service/unpaid-invoices?from=2026-01-01`. */
export const unpaidUrl = () => `${new URL("unpaid-invoices", config.receivables1cUrl).toString()}?from=${UNPAID_FROM}`;

async function once(): Promise<{ rows: number; fx: number }> {
  try {
    const res = await fetch(unpaidUrl(), { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`1С, неоплачені рахунки: HTTP ${res.status}`);
    const rows = parseUnpaid(await res.json());
    const now = new Date();
    const nbu = { USD: await getRate("USD", now).catch(() => undefined), EUR: await getRate("EUR", now).catch(() => undefined) };
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await replaceUnpaid(c as unknown as Db, rows, nbu);
      await c.query("COMMIT");
      return out;
    } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  } catch (e) {
    await saveUnpaidError(pool as unknown as Db, (e as Error).message).catch(() => undefined);
    throw e;
  }
}

/** Для крона: пропуск — `jobSkip`, не успіх; обсяг — у підсумку. */
export async function syncUnpaidInvoices(): Promise<unknown> {
  if (running && Date.now() - running < CEILING_MS) return jobSkip("Неоплачені рахунки 1С: попередній синк ще йде");
  running = Date.now();
  try { return await once(); } finally { running = null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncUnpaidInvoices().then((r) => console.log("syncUnpaidInvoices:", JSON.stringify(r))).catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
