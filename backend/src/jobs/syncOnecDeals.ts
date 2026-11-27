/**
 * 🔄 `syncOnecDeals` — 1С по угодах щогодини о :45 (задача #5583, прохід 2, 23.10.2026): реалізації (`costinvoice`) і
 * оплати клієнтів (`paydata`) з того самого сервісу 1С, звідки береться дебіторка (адреса — поруч із
 * `RECEIVABLES_1C_URL`). Це рівно те, що в таблиці Тетяни робить кнопка «Оновити витрати 1С» і вкладка «1С», — тепер
 * без кнопки. Відмова (немає відповіді, порожньо, масове зникнення) нічого не міняє: екран показує останні добрі дані,
 * причина — у стані; мовчання понад 2 тіки піднімає тривогу (`MONITORED_JOBS`). Лише ЧИТАЄ 1С (~20 с на сервіс).
 * 🛡 З 27.11.2026 тим самим проходом пишеться знімок рядків БЕЗ номера угоди (вкладка «Безпека»): окремою транзакцією
 * після угод, тож його збій запис угод не зупиняє (`writeOnec`).
 * ⏱ Прапорець «уже працює» має СТЕЛЮ (правило зони jobs-sync: завислий проміс не виконує `finally`).
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { parseInvoices, parsePayments, parseNoDeal } from "../core/dealLedger.js";
import { writeOnec, saveOnecError, type DbPool } from "../core/onecSync.js";
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

async function once(): Promise<{ invoices: number; payments: number; noDeal: number | null; noDealError?: string }> {
  try {
    const invJson = await getJson("costinvoice");
    const payJson = await getJson("paydata");
    // 🛡 Ті самі дві відповіді 1С, без третього запиту: рядки без номера угоди — у знімок «Безпеки» (задача 11231).
    const noDeal = [...parseNoDeal("invoice", invJson), ...parseNoDeal("payment", payJson)];
    const out = await writeOnec(pool as unknown as DbPool, parseInvoices(invJson), parsePayments(payJson), noDeal);
    if (out.noDealError) console.error(`syncOnecDeals: знімок «без угоди» не записано — ${out.noDealError}`);
    return out;
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
