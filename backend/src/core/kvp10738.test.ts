import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 📂 ЗАДАЧА 10738 (23.11.2026, ручний список правок Романа «remkaedashboard»): «Детальний звіт» у Звіті КВП
 * не згортати, лишити тільки плашку. Кнопка «Показати ▾ / Згорнути ▴» (з 20.11, `#9518`) і памʼять стану
 * `kvpDetails` прибрані; плашка «📂 Детальний звіт» лишилась заголовком розділу, вміст під нею видно завжди.
 *
 * Прибрано саме ЗГОРТАННЯ, а не вміст: тому заборона (`#10738`) має дзеркало «вміст на місці й без умови»
 * (`#10738b`). `#10738c` — наступник `#1850b`: те саме твердження про ядро, але «детальний» тепер не згорнутий.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = (() => {
  for (const p of [path.resolve(here, "../../src"), path.resolve(here, "../../../backend/src")]) {
    try { statSync(path.join(p, "routes/dashboard.ts")); return p; } catch { /* далі */ }
  }
  assert.fail("не знайдено backend/src — гейт не має права мовчки пропускатись");
})();
const FE_ROOT = path.join(SRC, "../../frontend/src");
const FE = (rel: string): string => readFileSync(path.join(FE_ROOT, rel), "utf8");
const KVP = "pages/dashboard/sections/KvpReportSection.tsx";
/** Коментарі JSX/TS не рахуються: у коментарі про прибране згортання слова `kvpDetails` законно лишаються. */
const code = (s: string): string => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PLATE = "📂 Детальний звіт";
const PACE = "📍 {rep.scope.label} — темп і життєвий цикл грошей";

/**
 * #10738 — «ДЕТАЛЬНИЙ ЗВІТ» НЕ ЗГОРТАЄТЬСЯ: на плашці немає кнопки й клікабельного рядка, стану згортання немає.
 * 🧨 Червоніє, якщо повернути кнопку «Показати / Згорнути», `role="button"` на плашці або стан `showDetails`/`kvpDetails`.
 */
test("#10738 ЗВІТ КВП: «Детальний звіт» без кнопки «Показати / Згорнути» і без стану згортання", () => {
  const src = code(FE(KVP));
  const a = src.indexOf(PLATE), b = src.indexOf(PACE);
  assert.ok(a > 0 && b > a, "🔴 плашку «Детальний звіт» або блок «темп і життєвий цикл» не знайдено — перевіряти нема що");
  const plate = src.slice(src.lastIndexOf("<div className=\"chart-card\"", a), b);
  assert.doesNotMatch(plate, /<button\b/, "🔴 на плашці «Детальний звіт» знову кнопка");
  assert.doesNotMatch(plate, /role="button"|onClick=/, "🔴 плашка «Детальний звіт» знову клікабельна (згортання)");
  assert.ok(!src.includes("Згорнути ▴") && !src.includes("Показати ▾"), "🔴 повернувся підпис «Показати ▾ / Згорнути ▴»");
  assert.doesNotMatch(src, /\bshowDetails\b|\btoggleDetails\b/, "🔴 повернувся стан згортання детального звіту");
  assert.doesNotMatch(src, /"kvpDetails"/, "🔴 знову читається / пишеться памʼять згортання kvpDetails");
});

/**
 * #10738b — ДЗЕРКАЛО: ПЛАШКА Є, І ВМІСТ ПІД НЕЮ ВИДНО ЗАВЖДИ. Від показників місяця до блоку «📍 … темп і життєвий
 * цикл грошей» немає жодної умови рендеру; у блоці — «Зміна до мин. періоду», «При поточному темпі», «Життєвий цикл
 * грошей» і три плитки «Відправлено / Очікуємо / Отримано».
 * 🧨 Червоніє, якщо разом із кнопкою прибрати вміст або сховати його за будь-якою умовою.
 */
test("#10738b ДЗЕРКАЛО 10738: плашка «Детальний звіт» є, під нею без умови — зміна, темп, життєвий цикл грошей", () => {
  const src = code(FE(KVP));
  const m = src.indexOf("<MonthMetrics rep={rep} plans={plans} />"), a = src.indexOf(PLATE), b = src.indexOf(PACE);
  assert.ok(m > 0 && a > m && b > a, "🔴 порядок «показники місяця → плашка → темп і життєвий цикл» порушено або плашку прибрано");
  const between = src.slice(m, b);
  assert.doesNotMatch(between, /&&|\?\s*\(|\(<>/, "🔴 між показниками місяця і блоком «темп і життєвий цикл» знову є умова — вміст можна сховати");
  const body = src.slice(b, b + 6000);
  for (const lbl of ["label=\"Зміна до мин. періоду\"", "label=\"При поточному темпі\"", "Життєвий цикл грошей<InfoHint", "[\"Відправлено\"", "[\"Очікуємо\"", "[\"Отримано\""]) {
    assert.ok(body.includes(lbl), `🔴 у «Детальному звіті» зник елемент ${lbl}`);
  }
});

/**
 * #10738c — НА ЕКРАНІ ОДНА ТАБЛИЦЯ КОМАНД, І ВОНА В ЯДРІ (наступник `#1850b`, задача 6442). Порядок: 4 картки грошей →
 * таблиця команд → «Перший дотик» → плашка «Детальний звіт» (тепер відкритий завжди). Верхнього блоку «Команди: тиждень
 * і місяць» немає НІДЕ у фронті; кожна з 4 карток — рівно один раз і в ядрі.
 * 🧨 Червоніє, якщо повернути другий блок команд, поставити таблицю нижче «Детального звіту» або дублювати картку грошей.
 */
test("#10738c ЗВІТ КВП — ОДНА ТАБЛИЦЯ КОМАНД У ЯДРІ: гроші → команди → перший дотик → детальний (відкритий); 4 картки без дубля", () => {
  const src = FE(KVP);
  const TEAMS = "🏅 Команди — план / факт";
  assert.equal(src.split(TEAMS).length - 1, 1, "🔴 таблиця команд на екрані не рівно один раз");
  assert.equal(src.split("🏅 Команди").length - 1, 1, "🔴 на екрані знову два блоки команд — той самий дубль, який прибирали");
  const all: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) all.push(p); } };
  walk(FE_ROOT);
  assert.ok(all.length > 50, `фронт не знайдено (${String(all.length)} файлів) — гейт нічого не перевіряє`);
  const dup = all.filter((p) => /Команди: тиждень і місяць|KvpTeamsWeekMonth/.test(readFileSync(p, "utf8")));
  assert.deepEqual(dup, [], "🔴 верхній блок «Команди: тиждень і місяць» повернувся");
  const iMoney = src.indexOf("💰 Гроші за "), iTeams = src.indexOf(TEAMS),
    iFt = src.indexOf("{canSeeFirstTouch && <KvpFirstTouchBlock"), iDet = src.indexOf(PLATE);
  assert.ok(iMoney > 0 && iMoney < iTeams && iTeams < iFt && iFt < iDet,
    "🔴 порядок ядра не «гроші → команди → перший дотик → детальний» (таблицю сховали під «Детальний звіт»?)");
  for (const lbl of ["Отримані кошти", "Стратегічний план 🔒", "Прогноз місяця", "Робочі дні"]) {
    const n = src.split(`label="${lbl}"`).length - 1;
    assert.equal(n, 1, `🔴 картка «${lbl}» на екрані ${String(n)} разів — дві копії одного числа`);
    assert.ok(src.indexOf(`label="${lbl}"`) < iTeams, `🔴 картка «${lbl}» не в ядрі`);
  }
});
