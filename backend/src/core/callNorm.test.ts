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

test("#710b налаштування: норма їде трьома станами (нема поля → лишити; порожньо → не задано; число → 1..500)", () => {
  const be = read("backend/src/routes/settings.ts");
  const next = /const next: AppSettings = \{([\s\S]*?)\n  \};/.exec(be);
  assert.ok(next, "🔴 блок `next` не впізнано");
  assert.match(next![1], /callsDailyNorm:[\s\S]{0,120}wireState\(body\.callsDailyNorm\)[\s\S]{0,80}current\.callsDailyNorm/,
    "🔴 норма не читається через wireState з фолбеком на current — стерте поле стане нулем або зникне");
  assert.match(next![1], /callsDailyNorm:[\s\S]{0,400}CALLS_NORM_BOUNDS/, "🔴 норма без меж — хибний ввід 99999 проїде");
  assert.match(be, /callsDailyNorm: null,/, "🔴 дефолт норми більше не «не задано» — хтось вигадав число за власника");
  // Фронт шле те саме поле трьома станами: порожній інпут → null, а не Number("") = 0.
  const fe = read("frontend/src/pages/dashboard/sections/SettingsSection.tsx");
  assert.match(fe, /callsDailyNorm: e\.target\.value\.trim\(\) === "" \? null : Number\(e\.target\.value\)/,
    "🔴 поле норми на екрані шле нуль за порожнє — дивись коментар до межі плану поруч");
});

test("#710c ростер Звіту несе callNorm з денних комірок; таблиця має колонку з чесним «норму не задано»", () => {
  const dash = read("backend/src/routes/dashboard.ts");
  const i = dash.indexOf("callNorm: callNorm.callNormCell(");
  assert.ok(i > 0, "🔴 рядок менеджера в /report-plan більше не несе callNorm");
  // Межа змістова (правило 9): від початку ЦЬОГО обробника, а не N символів назад.
  const handlerStart = dash.lastIndexOf('.get("/report-plan"', i);
  assert.ok(handlerStart > 0 && handlerStart < i, "🔴 обробник /report-plan не впізнано");
  const around = dash.slice(handlerStart, i);
  assert.match(around, /reportCuts\.callsByManagerDay\(from, to, \{ managerId, teamId \}\)/,
    "🔴 дні з нормою беруться не з тих самих денних комірок (callsByManagerDay зі скоупом команди)");
  assert.match(dash.slice(i, i + 200), /appSettings\.callsDailyNorm/, "🔴 норма береться не з Налаштувань");
  const cols = read("frontend/src/pages/dashboard/reportTableCols.ts");
  assert.match(cols, /key: "normDays"[\s\S]{0,120}m\.callNorm\?\.daysWithNorm \?\? null/, "🔴 колонка сортує не за daysWithNorm або зникла");
  const table = read("frontend/src/pages/dashboard/sections/ReportTableSection.tsx");
  assert.match(table, /case "normDays":[\s\S]{0,300}норму не задано/, "🔴 клітинка без норми не називає стан — покаже порожнє або 0");
  assert.match(table, /case "normDays":[\s\S]{0,600}c\.workDays/, "🔴 знаменник (робочі дні) зник із клітинки");
});
