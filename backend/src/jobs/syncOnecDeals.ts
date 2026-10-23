/**
 * 🔄 `syncOnecDeals` — 1С по угодах щогодини о :45 (задача #5583, прохід 2, 23.10.2026): реалізації (`costinvoice`) і
 * оплати клієнтів (`paydata`) з того самого сервісу 1С, звідки береться дебіторка (адреса — поруч із
 * `RECEIVABLES_1C_URL`). Це рівно те, що в таблиці Тетяни робить кнопка «Оновити витрати 1С» і вкладка «1С», — тепер
 * без кнопки. Відмова (немає відповіді, порожньо, масове зникнення) нічого не міняє: екран показує останні добрі дані,
 * причина — у стані; мовчання понад 2 тіки піднімає тривогу (`MONITORED_JOBS`). Лише ЧИТАЄ 1С (~20 с на сервіс).
 * ⏱ Прапорець «уже працює» має СТЕЛЮ (правило зони jobs-sync: завислий проміс не виконує `finally`).
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { parseInvoices, parsePayments } from "../core/dealLedger.js";
import { replaceOnec, saveOnecError } from "../core/onecSync.js";
import { jobSkip } from "./jobRuns.js";
import { warmMonthResults } from "./monthResultData.js";
import type { Db } from "../core/finance.js";

const CEILING_MS = 15 * 60_000;
let running: number | null = null;
/** Адреса сервісу 1С поруч із дебіторкою: `…/hs/service/debit-balance-account-361` → `…/hs/service/<name>`. */
export const onecServiceUrl = (name: "costinvoice" | "paydata") => new URL(name, config.receivables1cUrl).toString();

async function getJson(name: "costinvoice" | "paydata"): Promise<unknown> {
  const res = await fetch(onecServiceUrl(name), { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`1С, ${name}: HTTP ${res.status}`);
  return res.json();
}

async function once(): Promise<{ invoices: number; payments: number }> {
  try {
    const inv = parseInvoices(await getJson("costinvoice"));
    const pay = parsePayments(await getJson("paydata"));
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await replaceOnec(c as unknown as Db, inv, pay);
      await c.query("COMMIT");
      return out;
    } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  } catch (e) {
    await saveOnecError(pool as unknown as Db, (e as Error).message).catch(() => undefined);
    throw e;
  }
}

/** Для крона: пропуск — це пропуск (`jobSkip`), а не успіх; обсяг — у підсумку. */
export async function syncOnecDeals(opts: { warm?: boolean } = {}): Promise<unknown> {
  if (running && Date.now() - running < CEILING_MS) return jobSkip("1С по угодах: попередній синк ще йде");
  running = Date.now();
  try {
    const out = await once();
    if (opts.warm !== false) warmMonthResults(); // свіжа 1С — перерахувати «Результат місяця» у фоні, щоб екран відкривався одразу
    return out;
  } finally { running = null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncOnecDeals({ warm: false }).then((r) => console.log("syncOnecDeals:", JSON.stringify(r))).catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
