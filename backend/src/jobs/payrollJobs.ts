/**
 * 💰 Фонові задачі «Зарплати» (ТЗ §5.6). Обгортки над `payroll/service.ts`, щоб `index.ts` не тягнув сервіс напряму й кожна
 * мала власне імʼя в `job_runs` / `monitoredJobs`.
 *  - payrollMonthClose — 1-го: закриття ПОПЕРЕДНЬОГО місяця (idempotent: повторний прогін нічого не робить);
 *  - payrollTtnTick — кожні 15 хв: дата появи ТТН по угодах «Успішно реалізовано» + «утримання знято»;
 *  - payrollBirthdays — 1-го: сповіщення про дні народження місяця (раз на місяць).
 */
import { pool } from "../db/pool.js";
import { closeMonth, ttnTick, birthdaysTick } from "../payroll/service.js";
import { kyivNow } from "../payroll/state.js";
import { prevMonth } from "../payroll/engine/zarplata-engine.mjs";

export async function payrollMonthClose() {
  const mk = prevMonth(kyivNow().slice(0, 7));
  const r = await closeMonth(pool, mk);
  if (r.closed) console.log(`[payroll] ${mk} закрито: записів ${r.records}`);
}
export async function payrollTtnTick() {
  const n = await ttnTick(pool);
  if (n) console.log(`[payroll] ТТН: нових ${n}`);
}
export async function payrollBirthdays() {
  await birthdaysTick(pool, kyivNow().slice(0, 7));
}
