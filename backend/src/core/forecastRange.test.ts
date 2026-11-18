import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expectedInRange } from "./forecast.js";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #7894…#7894d — «З ОЧІКУВАННЯМИ» У ПЛИТЦІ «КОМАНДА» (18.11.2026).
 *
 * 🧭 ЗВІДКИ. TOP Weekly 16.11.2026, Сергій: «з очікуваннями скільки ми виконали» — і для місяця, і для
 * тижня. Роман: «такої циферки немає». План `meeting-1611-2-plan.md`, «роби» Романа 18.11.
 *
 * 📐 ЩО СТВЕРДЖУЄМО.
 *  - `#7894`  межі періоду: планова дата в перший і в останній день — входить, на день раніше/пізніше — ні.
 *  - `#7894b` рядок складається з факту + очікувань ТОГО САМОГО режиму (місяць → «цей міс», тиждень →
 *             «в межах періоду»), а бекенд бере тижневе з того самого джерела днів, що й «цей міс».
 *  - `#7894c` дзеркало: лише для ПОТОЧНОГО періоду. У минулому нічого не очікується.
 *  - `#7894d` (прод) у поточному місяці «з очікуваннями» команди = Σ «прогнозів» карток (+ гроші
 *             звільнених, які входять у факт плитки), і очікування періоду = «цей міс». Один виклик.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const codeOnly = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const read = (rel: string) => codeOnly(readFileSync(path.join(ROOT, rel), "utf8"));
const PLAN = "frontend/src/pages/dashboard/sections/ReportPlanSection.tsx";
const glanceBody = () => read(PLAN).split("function Glance(")[1]?.split("\nfunction ")[0] ?? "";

test("#7894 очікування в межах періоду: обидва кінці входять, сусідні дні — ні", () => {
  const rows = [
    { managerId: 1, day: "2026-11-15", sum: 1 },    // неділя ДО тижня
    { managerId: 1, day: "2026-11-16", sum: 10 },   // понеділок — перший день
    { managerId: 1, day: "2026-11-19", sum: 100 },  // середина
    { managerId: 2, day: "2026-11-22", sum: 1000 }, // неділя — останній день
    { managerId: 2, day: "2026-11-23", sum: 5 },    // понеділок ПІСЛЯ
  ];
  const m = expectedInRange(rows, "2026-11-16", "2026-11-22");
  assert.equal(m.get(1), 110, "🔴 менеджер 1: перший день і середина тижня (10 + 100), неділя ДО — ні");
  assert.equal(m.get(2), 1000, "🔴 менеджер 2: останній день тижня входить, понеділок ПІСЛЯ — ні");
  // Без меж — порожньо, а не «усе»: інакше тиждень без дат намалював би всю зону.
  assert.equal(expectedInRange(rows, null, "2026-11-22").size, 0);
  assert.equal(expectedInRange(rows, "2026-11-16", null).size, 0);
});

test("#7894b рядок «з очікуваннями» = факт + очікування ТОГО САМОГО режиму, тижневе — з тих самих днів, що «цей міс»", () => {
  const g = glanceBody();
  assert.match(g, /const expNow = monthInProgress \? g\.expectThisMonth : weekInProgress \? g\.expectInPeriod : null;/,
    "🔴 місяць мусить брати «цей міс», тиждень — очікування в межах періоду");
  assert.match(g, /const withExp = expNow == null \? null : g\.fact \+ expNow;/, "🔴 «з очікуваннями» = факт плитки + очікування");
  assert.match(g, /з очікуваннями <b>\{fmt\(withExp\)\} ₴<\/b>/, "🔴 рядок «з очікуваннями» не малюється");
  const be = read("backend/src/routes/dashboard.ts");
  assert.match(be, /const expRangeM = forecast\.expectedInRange\(expDays, from, to\);/,
    "🔴 тижневі очікування мусять рахуватись з тих самих днів (`expDays`), що й «цей міс», і в межах обраного періоду");
  assert.match(be, /expectInPeriod: managers\.reduce\(\(s, m\) => s \+ m\.expectInPeriod, 0\)/, "🔴 команда = Σ менеджерів");
});

test("#7894c дзеркало: «з очікуваннями» лише для ПОТОЧНОГО місяця чи тижня", () => {
  const s = read(PLAN);
  assert.match(s, /monthInProgress=\{mode === "month" && data\.scope\.isCurrent\}/, "🔴 місяць — лише поточний");
  assert.match(s, /weekInProgress=\{mode === "week" && data\.scope\.isCurrent\}/, "🔴 тиждень — лише поточний");
  const g = glanceBody();
  assert.match(g, /\{withExp != null && \(/, "🔴 рядок мусить ховатись, коли період не поточний");
  assert.match(g, /\{weekInProgress && <ExpectSeg fact=\{g\.fact\} expect=\{g\.expectInPeriod\}/, "🔴 штриховка тижня — лише в поточному тижні");
});

test("#7894d (прод) поточний місяць: «з очікуваннями» команди = Σ прогнозів карток, очікування періоду = «цей міс»", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const tok = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const [y, mo] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const from = `${today.slice(0, 7)}-01`, to = `${today.slice(0, 7)}-${String(last).padStart(2, "0")}`;
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 200, "🔴 /report-plan не віддав 200 — рівність нижче нічого б не довела");
  const j = await r.json() as {
    glance: { fact: number; expectThisMonth: number; expectInPeriod: number };
    managers: { projected: number; monthInProgress: boolean }[]; dismissed?: { fact: number }[];
  };
  assert.ok(j.managers.length > 0, "🔴 порожній ростер — перевіряти нічого");
  assert.ok(j.managers.every((m) => m.monthInProgress), "🔴 поточний місяць мусить бути «у процесі» в кожній картці");
  const withExp = j.glance.fact + j.glance.expectThisMonth;
  const sumProj = j.managers.reduce((s, m) => s + m.projected, 0) + (j.dismissed ?? []).reduce((s, m) => s + m.fact, 0);
  assert.equal(withExp, sumProj, `🔴 «з очікуваннями» ${withExp} ≠ Σ прогнозів карток ${sumProj}`);
  assert.equal(j.glance.expectInPeriod, j.glance.expectThisMonth,
    "🔴 для повного поточного місяця очікування періоду мусять дорівнювати «цей міс» — інакше два правила");
});
