import { pool } from "../db/pool.js";
import { lardiUsersByPhone } from "../core/lardiCheck.js";
import { lookupMissedPhones, type LookupReport } from "../core/lardiPhoneLookup.js";
import { rebuildCarrierPhones } from "./rebuildCarrierPhones.js";

/**
 * 🔎 ПОШУК НОМЕРІВ ПРОПУЩЕНИХ НА ЛАРДІ (Роман 25.11.2026: «якщо ларді каже що такий номер знайдено це автоматом
 * перевізник»). Кожні 5 хв (Роман 25.11: «давай цю джобу частіше ранити»); знайшли номер — одразу перебудовуємо
 * довідник, щоб він зник із «Чекають» за хвилини, а не о :22. Правила — `core/lardiPhoneLookup.ts`. Під наглядом (`monitoredJobs.ts`): мовчання = нові перевізники з Ларді рахуються
 * пропущеними клієнтів.
 */
export async function lardiPhoneLookup(): Promise<LookupReport> {
  return lookupMissedPhones(pool, lardiUsersByPhone, { onFound: () => rebuildCarrierPhones() });
}
