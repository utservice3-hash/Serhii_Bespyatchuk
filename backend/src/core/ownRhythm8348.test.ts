import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateOf, pastOwnRhythm, OWN_RHYTHM_FLOOR_DAYS, SEGMENT_SLEEPING_DAYS, LOST_DAYS } from "./reactivationRules.js";
import { colorOf } from "./clientLeadRules.js";
import { segmentTip, stateTips, ruleNumbers } from "./categoryRules.js";

/**
 * 🧩 ЗАДАЧА 8348 (Юля 06.11, п.4: «задачу можна поставити кожному клієнту, а сегмент рахується правильно»; Роман 11.11
 * «роби кнопку, а по Марвіку А»). Дві частини: кнопка «＋ Задача» на «Плані місяця» — для БУДЬ-ЯКОГО клієнта; «Сплячий»
 * — ще й коли минув особистий ритм клієнта (медіана між оплатами), не раніше `OWN_RHYTHM_FLOOR_DAYS`.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * #3817 🪞 — ОСОБИСТИЙ РИТМ ПО ОБИДВА БОКИ. Marvic SRL (без історії, інтервал 30.1, 42 дні) — сплячий; той самий на 30-й
 * день — активний (строго «більше»). ВІП з інтервалом 0 — до 14 днів активний (мінімум), з 14 — сплячий (сегмент).
 * Епізодичний з інтервалом 45 — на 45-й активний, на 46-й сплячий (раніше за поріг 60). Без інтервалу — старе правило.
 * Втрачений — 180 для всіх. Колір іде за тим самим правилом.
 * 🧨 Червоніє, якщо особистий ритм не працює (Марвік знову «Активний»), якщо зникне мінімум (ВІП сплять наступного дня)
 * або колір розійдеться зі станом.
 */
test("#3817 🪞 ОСОБИСТИЙ РИТМ: вийшов звичний інтервал — сплячий; мінімум 14 днів; без інтервалу — як було; колір так само", () => {
  assert.equal(OWN_RHYTHM_FLOOR_DAYS, 14);
  assert.equal(stateOf(42, "unknown", 30.1), "sleeping", "🔴 Марвік (інтервал 30, 42 дні) досі «Активний»");
  assert.equal(stateOf(42, "unknown"), "active", "фікстура: без особистого ритму Марвік був би активним (поріг «без історії» 60)");
  assert.equal(stateOf(30, "unknown", 30.1), "active", "🔴 сплячий ще до того, як минув інтервал");
  assert.equal(stateOf(13, "vip", 0), "active", "🔴 ВІП із кількома оплатами на день сплячий раніше 14 днів — мінімум не працює");
  assert.equal(stateOf(14, "vip", 0), "sleeping", "🔴 поріг ВІП 14 перестав діяти");
  assert.equal(stateOf(45, "episodic", 45), "active");
  assert.equal(stateOf(46, "episodic", 45), "sleeping", "🔴 епізодичний з інтервалом 45 на 46-й день досі активний");
  assert.equal(stateOf(59, "episodic", null), "active", "🔴 без інтервалу змінилось старе правило");
  assert.equal(stateOf(SEGMENT_SLEEPING_DAYS.episodic, "episodic", 200), "sleeping", "🔴 поріг сегмента перестав діяти, коли інтервал великий");
  assert.equal(stateOf(LOST_DAYS, "unknown", 30), "lost");
  assert.equal(pastOwnRhythm(15, 10), true);
  assert.equal(pastOwnRhythm(14, 10), false, "🔴 мінімум 14 — строго «більше»");
  assert.equal(colorOf("unknown", 42, 30.1), "yellow", "🔴 колір Марвіка не за особистим ритмом");
  assert.equal(colorOf("unknown", 42), "green", "дзеркало: без інтервалу колір як був");
  assert.equal(colorOf("vip", 13, 0), "green");
  const n = ruleNumbers();
  assert.ok(segmentTip(n, "unknown").includes(`не раніше ${n.ownRhythmFloorDays} днів`), "🔴 підказка сегмента не пояснює особистий ритм");
  assert.ok(stateTips(n).sleeping.includes("звичний інтервал"), "🔴 підказка «Сплячий» не пояснює особистий ритм");
});

/**
 * #3818 — ПРОВОДКА 8348: стан ядра (`clientSegments`) і колір «З ким говорити» отримують інтервал клієнта; на «Плані
 * місяця» кнопка «＋ Задача» — для будь-якого клієнта без відкритої задачі (немає умови про «Активний» і сезонного);
 * сервер `/reactivation-task` за станом не відмовляє.
 * 🧨 Червоніє, якщо стан або колір знову рахуватимуться без інтервалу, або кнопку знову сховають від «Активних».
 */
test("#3818 ПРОВОДКА: стан і колір з інтервалом клієнта; «＋ Задача» на будь-якого клієнта", () => {
  assert.match(codeOnly(read("backend/src/core/clientSegments.ts")), /stateOf\(daysSince, segment, medianGapDays\)/, "🔴 стан ядра без особистого ритму");
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  assert.match(dash, /clientLeadRules\.colorOf\(segment, orderDays, factsFor\(seg, c\.client_key\)\.medianGapDays\)/, "🔴 колір «З ким говорити» без особистого ритму");
  const task = dash.slice(dash.indexOf('dashboardRouter.post("/reactivation-task"'), dash.indexOf('dashboardRouter.post("/reactivation-task/close"'));
  assert.ok(task.length > 100, "🔴 роуту задачі не знайдено");
  assert.doesNotMatch(task, /state\s*[!=]==\s*"active"|\.state\b/, "🔴 сервер відмовляє в задачі за станом клієнта");
  const pl = codeOnly(read("frontend/src/pages/dashboard/sections/ClientPlansSection.tsx"));
  assert.doesNotMatch(pl, /c\.state !== "active" && !c\.seasonal \?/, "🔴 «＋ Задача» знову схована від «Активних» і сезонних");
  assert.match(pl, /\) : \(\s*<button disabled=\{busy\}[^>]*\n[^>]*\n\s*onClick=\{\(\) => setCreating\(\{ clientKey: c\.clientKey, name: c\.clientName \}\)\}>/,
    "🔴 без відкритої задачі кнопки «＋ Задача» немає");
});
