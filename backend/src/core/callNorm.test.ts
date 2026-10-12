import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { callNormCell, elapsedTo, CALLS_NORM_BOUNDS } from "./callNorm.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * 📞 #710–#710c — ДНІ З НОРМОЮ ДЗВІНКІВ (ТЗ 23.09.2026, п.2).
 * Норми в коді немає свідомо (рішення власника) — гейти стережуть, що «не задано»
 * лишається станом, а не нулем, і що число рахується ТИМ САМИМ `n`, що «Дзвінки того дня».
 */

test("#710 callNormCell: день з нормою — по обидва боки порога; без норми — null, а не 0; знаменник — робочі дні до сьогодні", () => {
  const days = [
    { day: "2026-09-01", talks: 20, attempts: 10 },  // 30 ≥ 30 → так
    { day: "2026-09-02", talks: 19, attempts: 10 },  // 29 < 30 → ні
    { day: "2026-09-05", talks: 30, attempts: 0 },   // субота з нормою → рахується
    { day: "2026-09-30", talks: 99, attempts: 99 },  // ПІСЛЯ сьогодні → не рахується
  ];
  const c = callNormCell(days, 30, "2026-09-01", "2026-09-30", "2026-09-23");
  assert.equal(c.norm, 30);
  assert.equal(c.daysWithNorm, 2, "🔴 поріг або межа «до сьогодні» зламані (чекали 01.09 і 05.09)");
  assert.equal(c.workDays, 17, "🔴 робочих днів Пн–Пт 01–23.09.2026 має бути 17");
  // Спроби ВХОДЯТЬ у поріг (те саме n, що «Дзвінки того дня»): лише розмовами 19 — ні.
  assert.equal(callNormCell([{ day: "2026-09-01", talks: 19, attempts: 11 }], 30, "2026-09-01", "2026-09-30", "2026-09-23").daysWithNorm, 1,
    "🔴 спроби перестали входити в поріг — число розійдеться з колонкою «Дзвінки того дня»");
  // Без норми — СТАН «не задано», а не 0 днів (правило 7: порожнє не виражати нулем).
  const none = callNormCell(days, null, "2026-09-01", "2026-09-30", "2026-09-23");
  assert.equal(none.daysWithNorm, null, "🔴 без норми показано 0 днів — це брехня про людину");
  assert.equal(none.workDays, 17, "знаменник є і без норми — він від норми не залежить");
  // Період у майбутньому — знаменник 0, а не відʼємний.
  assert.equal(callNormCell([], 30, "2026-10-01", "2026-10-31", "2026-09-23").workDays, 0);
  assert.equal(elapsedTo("2026-09-01", "2026-09-10", "2026-09-23"), "2026-09-10", "🔴 знаменник вилазить за кінець періоду");
  assert.equal(CALLS_NORM_BOUNDS.min, 1, "🔴 норма 0 дозволена — тоді кожен день «з нормою»");
});
