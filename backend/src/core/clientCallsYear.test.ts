import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SECTIONS = "frontend/src/pages/dashboard/sections";
/** Код без коментарів: гейт стереже ВИКЛИК, а пояснення «чому не window.open» у доккоментарі — не виклик (правило 9). */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * 📎 #711–#711b — ЗАДАЧА 4310 (ТЗ Юлі 22.09.2026, блок 1): скрин відкривається.
 * ⚠️ Гейти дзвінків `#712`/`#712b`/`#712c` («за рік») зняті 28.09.2026: блок 3 переніс
 * лічильник на МІСЯЦЬ і прибрав «Дзвінки по роках» — їх заміна `#814`–`#814c`
 * у `core/clientsBlock3.test.ts`.
 *
 * Обидва дефекти були видимі лише оком: сервер віддавав скрин із 200, а «📞 0» було
 * текстом у верстці. Жоден API-гейт їх не бачив, тому гейти тут читають ДЖЕРЕЛО фронта
 * і структуру роутів, а властивість підрахунку — на власній фікстурі.
 */

test("#711 СКРИН У КАРТЦІ: перегляд на місці, без window.open після очікування; є «Завантажити» і відкликання blob", () => {
  const card = read(`${SECTIONS}/ClientCardPanel.tsx`);
  assert.doesNotMatch(codeOnly(card), /window\.open\(/,
    "🔴 картка знову відкриває скрин новою вкладкою — після await блокувальник її мовчки гасить (так «не клікалось» у Юлі й Дмитрука)");
  assert.match(card, /onClick=\{\(\) => setFileId\(k\.id\)\}>📎 скрин<\/button>/,
    "🔴 кнопка «📎 скрин» у картці не відкриває перегляд на місці");
  assert.match(card, /<ClientContactFileViewer [^>]*initialId=\{fileId\}/, "🔴 перегляд у картці не рендериться для обраного скрину");
  const viewer = read(`${SECTIONS}/ClientContactFileViewer.tsx`);
  assert.doesNotMatch(codeOnly(viewer), /window\.open\(/, "🔴 перегляд сам відкриває вкладку — повернули той самий блокувальник");
  assert.match(viewer, /URL\.revokeObjectURL\(/, "🔴 blob скрину не відкликається — кожне відкриття лишає копію в памʼяті вкладки");
  assert.match(viewer, /<a href=\{blobUrl!\} download=/, "🔴 немає «Завантажити» — ТЗ вимагає «відкривається й качається»");
  assert.match(viewer, /setErr\(errText\(e, "скрин не відкрився"\)\)/, "🔴 відмова сервера не показується — порожнє вікно читалось би як «скрину немає»");
});

test("#711b 🪞 СКРИН ІЗ РЯДКА: 📎 — кнопка, що відкриває той самий перегляд, а не мертва позначка", () => {
  const list = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.match(list, /c\.lastContactHasFile && \(\s*<button[\s\S]{0,200}onClick=\{\(\) => setViewingFiles\(/,
    "🔴 📎 у рядку знову лише позначка — відкрити скрин зі списку нічим");
  assert.match(list, /\{viewingFiles && \(\s*<ClientContactFileViewer /, "🔴 перегляд скринів зі списку не рендериться");
  assert.doesNotMatch(codeOnly(list), /window\.open\(/, "🔴 список відкриває вкладку — блокувальник");
});
