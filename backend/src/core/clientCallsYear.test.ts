import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { yearCell, CALLS_BY_YEAR_SQL, type CallYear } from "./clientCallsYear.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SECTIONS = "frontend/src/pages/dashboard/sections";
/** Код без коментарів: гейт стереже ВИКЛИК, а пояснення «чому не window.open» у доккоментарі — не виклик (правило 9). */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * 📎📞 #711–#712c — ЗАДАЧА 4310 (ТЗ Юлі 22.09.2026, блок 1): скрин відкривається, дзвінки
 * в рядку — справжні.
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

test("#712 «📞» У РЯДКУ — ЧИСЛО З СЕРВЕРА, А НЕ ТЕКСТ У ВЕРСТЦІ; застарілої панелі «перелік не побудований» немає", () => {
  const list = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.doesNotMatch(list, /📞 0 ·/, "🔴 «📞 0» знову зашито текстом — Energy Group показуватиме 0 при 33 дзвінках у картці");
  assert.match(list, /📞 \{c\.callsYear\.talks\}\/\{c\.callsYear\.calls\}/, "🔴 рядок не показує розмови/дзвінки з сервера");
  assert.doesNotMatch(list, /CallsPanel|callsUnavailable/, "🔴 повернулась панель із текстом «перелік дзвінків ще не побудований» — під карткою, яка їх показує");
  const dash = read("backend/src/routes/dashboard.ts");
  assert.doesNotMatch(dash, /callsUnavailable/, "🔴 сервер знову віддає неправдивий текст про дзвінки");
  assert.match(dash, /callsYear: clientCallsYear\.yearCell\(callsYearByKey\.get\(c\.client_key\), callsYearNow\)/,
    "🔴 рядок /client-plans не несе дзвінків за рік із ядра");
});

test("#712b КАРТКА І РЯДОК РАХУЮТЬ ДЗВІНКИ ОДНИМ ЯДРОМ; yearCell — по обидва боки (рік є / року немає)", () => {
  const dash = read("backend/src/routes/dashboard.ts");
  const card = dash.slice(dash.indexOf('dashboardRouter.get("/client-card"'));
  assert.ok(card.length > 0 && dash.includes('dashboardRouter.get("/client-card"'), "🔴 обробник /client-card не впізнано");
  const cardBody = card.slice(0, card.indexOf("\ndashboardRouter.", 10));
  assert.match(cardBody, /clientCallsYear\.callsByYear\(\[clientKey\]\)/, "🔴 картка рахує дзвінки не ядром — розійдеться з рядком");
  assert.match(cardBody, /callsByYear: cardCallsByYear,/, "🔴 картка віддає не те, що порахувало ядро");
  assert.doesNotMatch(cardBody, /FROM ringostat_calls WHERE client_key = \$1\s+GROUP BY/,
    "🔴 у картці знову власний SQL по роках — другий підрахунок поруч із ядром");
  const plans = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'));
  assert.match(plans.slice(0, plans.indexOf("\ndashboardRouter.", 10)), /clientCallsYear\.callsByYear\(clientKeys\)/,
    "🔴 список рахує дзвінки не тим самим ядром, що картка");
  const ys: CallYear[] = [{ year: 2026, calls: 52, talks: 33, totalSec: 900, lastAt: null }, { year: 2025, calls: 7, talks: 2, totalSec: 60, lastAt: null }];
  assert.deepEqual(yearCell(ys, 2026), { year: 2026, calls: 52, talks: 33 }, "🔴 взято не той рік або переплутано розмови з дзвінками");
  assert.deepEqual(yearCell(ys, 2027), { year: 2027, calls: 0, talks: 0 }, "🔴 рік без дзвінків дає не нуль");
  assert.deepEqual(yearCell(undefined, 2026), { year: 2026, calls: 0, talks: 0 }, "🔴 клієнт без жодного дзвінка ламає рядок");
});

/**
 * #712c — ЖИВИЙ SQL на порожньому кластері: рік — ЗА КИЄВОМ (межа 31.12/01.01 по обидва
 * боки), розмова — `billsec > 0`, ключі — лише передані. Фікстура, а не прод: на живих
 * даних межа року трапляється раз на рік і гейт зеленів би, нічого не доводячи.
 */
test("#712c ЖИВИЙ SQL: рік за Києвом по обидва боки межі, розмова = billsec>0, чужі ключі не рахуються", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    // Грудень у Києві — UTC+2. Межа року по обидва боки: 23:30 31.12 і 00:30 01.01 за Києвом.
    await c.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, client_key) VALUES
      ('a1', '2025-12-31T22:30:00Z', 'out', 40, 'k1'),  -- 01.01.2026 00:30 Київ → 2026, розмова (за UTC був би 2025)
      ('a2', '2025-12-31T21:30:00Z', 'out', 0,  'k1'),  -- 31.12.2025 23:30 Київ → 2025, спроба
      ('a3', '2026-06-01T10:00:00Z', 'in',  0,  'k1'),  -- 2026, спроба
      ('a4', '2026-06-02T10:00:00Z', 'out', 12, 'k1'),  -- 2026, розмова
      ('b1', '2026-06-01T10:00:00Z', 'out', 99, 'k2')`); // чужий ключ
    const r = await c.query<{ client_key: string; year: number; calls: number; talks: number }>(CALLS_BY_YEAR_SQL, [["k1"]]);
    const got = r.rows.map((x) => `${x.client_key}:${x.year}:${x.talks}/${x.calls}`);
    assert.deepEqual(got, ["k1:2026:2/3", "k1:2025:0/1"],
      "🔴 рік рахується не за Києвом, розмови переплутано зі спробами або підмішано чужий ключ");
  } finally {
    await c.end();
    scratch.dispose();
  }
});
