import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ✂️ ЗАДАЧА 10753 (23.11.2026, ручний список правок Романа «remkaedashboard»): зі Звіту КВП прибрати легенду
 * «Закриємо поточний тиждень? Закрито / Реально / Під ризиком / Не закриється» під таблицею команд і рядок
 * «На адаптації (перші 4 тижні…)» під плитками «Першого дотику».
 *
 * Прибрано саме ТЕКСТ, а не те, що він пояснював: чип «Закриємо?» у клітинці поточного тижня лишається, значення
 * міток переїхали в підказку (i) заголовка таблиці; новачки лишаються на екрані «Перший дотик · AI». Тому кожна
 * заборона тут має дзеркало «а де воно ТЕПЕР» — інакше «прибрали легенду» мовчки стало б «прибрали й чип».
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = (() => {
  for (const p of [path.resolve(here, "../../src"), path.resolve(here, "../../../backend/src")]) {
    try { statSync(path.join(p, "routes/dashboard.ts")); return p; } catch { /* далі */ }
  }
  assert.fail("не знайдено backend/src — гейт не має права мовчки пропускатись");
})();
const FE = (rel: string): string => readFileSync(path.join(SRC, "../../frontend/src", rel), "utf8");
const KVP = "pages/dashboard/sections/KvpReportSection.tsx";
const FT = "pages/dashboard/sections/KvpFirstTouchBlock.tsx";
const AI = "pages/dashboard/sections/AiCallsSection.tsx";
/** Коментарі JSX/TS не рахуються: у коментарі про прибране слово «На адаптації» законно лишається. */
const code = (s: string): string => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Транспілює чистий фронтовий модуль без імпортів і повертає його експорти. */
async function loadFe(rel: string): Promise<any> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE(rel), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/**
 * #10753 — ЛЕГЕНДИ Й РЯДКА НОВАЧКІВ У ЗВІТІ КВП НЕМАЄ.
 * 🧨 Червоніє, якщо в Звіт КВП повернеться легенда «Закриємо поточний тиждень?» (компонент чи текст) або рядок
 * «На адаптації (перші 4 тижні…)» під плитками «Першого дотику».
 */
test("#10753 ЗВІТ КВП: без легенди «Закриємо поточний тиждень?» і без рядка «На адаптації» під «Першим дотиком»", () => {
  const kvp = code(FE(KVP)), ft = code(FE(FT));
  assert.doesNotMatch(kvp, /\bCloseLegend\b/, "🔴 у Звіт КВП повернувся компонент легенди «Закриємо?»");
  assert.ok(!kvp.includes("Закриємо поточний тиждень?"), "🔴 у Звіт КВП повернувся текст легенди «Закриємо поточний тиждень?»");
  assert.doesNotMatch(ft, /\.adaptation\b/, "🔴 блок «Першого дотику» у Звіті КВП знову перелічує новачків");
  assert.ok(!ft.includes("На адаптації (перші"), "🔴 у Звіт КВП повернувся рядок «На адаптації (перші 4 тижні…)»");
});

/**
 * #10753b — ДЗЕРКАЛО: ПРИБРАНО ТЕКСТ, А НЕ ТЕ, ЩО ВІН ПОЯСНЮВАВ. Чип «Закриємо?» малюється в клітинці тижня;
 * новачків видно на екрані «Перший дотик · AI».
 * 🧨 Червоніє, якщо разом із легендою зникне чип у клітинці або блок «На адаптації» на екрані AI.
 */
test("#10753b ДЗЕРКАЛО 10753: чип «Закриємо?» у клітинці тижня є, блок «На адаптації» на екрані AI є", () => {
  const kvp = code(FE(KVP)), ai = code(FE(AI));
  assert.match(kvp, /<CloseChip plan=\{w\.plan\} fact=\{w\.fact\} expected=\{w\.expected\} \/>/, "🔴 зник чип «Закриємо?» у клітинці поточного тижня");
  assert.match(kvp, /function CloseChip\(/, "🔴 зник сам компонент чипа «Закриємо?»");
  assert.match(ai, /<section aria-label="На адаптації"/, "🔴 на екрані «Перший дотик · AI» зник блок «На адаптації»");
  assert.match(ai, /adaptLines\.length > 0 &&/, "🔴 блок «На адаптації» на екрані AI більше не показує рядки новачків");
});

/**
 * #10753c — ЗНАЧЕННЯ МІТОК ПЕРЕЇХАЛИ В ПІДКАЗКУ (i), З ТИМИ САМИМИ ПОРОГАМИ, ЩО Й ПРАВИЛО.
 * `closeLegendText()` виконується: у ній чотири мітки з `CLOSE_LABEL` і пороги з `CLOSE_REAL_MAX`/`CLOSE_RISK_MAX`;
 * заголовок таблиці команд кличе її у своїй підказці; підказка «Першого дотику» каже, де шукати новачків.
 * 🧨 Червоніє, якщо пояснення мітки зникне, поріг у підказці розійдеться з правилом, або підказка перестане його брати.
 */
test("#10753c ПІДКАЗКА ЗАМІСТЬ ЛЕГЕНДИ: 4 мітки й пороги з правила weekCloseStatus; новачки — посилання на екран AI", async () => {
  const r = await loadFe("pages/dashboard/kvpCoreRules.ts");
  const txt: string = r.closeLegendText();
  for (const k of ["closed", "real", "risk", "no"]) {
    assert.ok(txt.includes(`«${r.CLOSE_LABEL[k] as string}» — `), `🔴 у підказці немає пояснення мітки «${r.CLOSE_LABEL[k] as string}»`);
  }
  const real = Math.round(r.CLOSE_REAL_MAX * 100), risk = Math.round(r.CLOSE_RISK_MAX * 100);
  assert.ok(txt.includes(`до ${String(real)}% очікуваних`), `🔴 поріг «Реально» у підказці не ${String(real)}% з правила`);
  assert.ok(txt.includes(`${String(real)}–${String(risk)}% очікуваного`), `🔴 межі «Під ризиком» у підказці не ${String(real)}–${String(risk)}% з правила`);
  assert.ok(txt.includes(`понад ${String(risk)}%`), `🔴 поріг «Не закриється» у підказці не ${String(risk)}% з правила`);
  // Пороги справді ведуть мітку: межа «Реально»/«Під ризиком» стоїть рівно там, де каже підказка.
  assert.equal(r.weekCloseStatus(100, 100 - real, 100).kind, "real", "🔴 частка рівно на порозі — не «Реально», підказка бреше");
  assert.equal(r.weekCloseStatus(100, 100 - real - 1, 100).kind, "risk", "🔴 частка понад поріг — не «Під ризиком», підказка бреше");
  assert.match(code(FE(KVP)), /🏅 Команди — план \/ факт[\s\S]{0,400}<InfoHint text=\{"[^"]*" \+ closeLegendText\(\)\} \/>/, "🔴 підказка заголовка таблиці команд не бере значення міток із closeLegendText()");
  assert.match(code(FE(FT)), /<InfoHint text="[^"]*Новачки в перші 4 тижні[^"]*«Перший дотик · AI», блок «На адаптації»[^"]*" \/>/, "🔴 підказка «Першого дотику» не каже, де тепер видно новачків");
});
