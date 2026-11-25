import { pool } from "../db/pool.js";
import { lardiUsersByPhone } from "../core/lardiCheck.js";
import { lookupMissedPhones, type LookupReport } from "../core/lardiPhoneLookup.js";

/**
 * 🔎 ПОШУК НОМЕРІВ ПРОПУЩЕНИХ НА ЛАРДІ (Роман 25.11.2026: «якщо ларді каже що такий номер знайдено це автоматом
 * перевізник»). Щогодини о :07 — до перебудови довідника о :22, осторонь живого скану Ларді (:04/:19/:34/:49). Правила —
 * `core/lardiPhoneLookup.ts`. Під наглядом (`monitoredJobs.ts`): мовчання = нові перевізники з Ларді рахуються
 * пропущеними клієнтів.
 */
export async function lardiPhoneLookup(): Promise<LookupReport> {
  return lookupMissedPhones(pool, lardiUsersByPhone);
}
