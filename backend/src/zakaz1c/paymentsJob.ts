/**
 * ⏱ Джоба «ТЕСТ ЗАКАЗ 1С: оплати → угоди» — щогодини о :50, одразу після `syncOnecDeals` (:45), що привозить оплати.
 * Прапорець «уже працює» має СТЕЛЮ (правило зони jobs-sync: завислий проміс не виконує `finally`); пропуск — `jobSkip`.
 * Поки `ZAKAZ1C_FIELDS_MODE=off`, у Kommo не пише нічого — лише план у `zakaz_onec_pay_plan` (див. `payments.ts`).
 */
import { pool } from "../db/pool.js";
import { jobSkip } from "../jobs/jobRuns.js";
import { runPayments } from "./payments.js";

const CEILING_MS = 15 * 60_000;
let running: number | null = null;

export async function zakaz1cPayments(): Promise<unknown> {
  if (running && Date.now() - running < CEILING_MS) return jobSkip("оплати → угоди: попередній прохід ще йде");
  running = Date.now();
  try {
    return await runPayments(pool);
  } finally { running = null; }
}
