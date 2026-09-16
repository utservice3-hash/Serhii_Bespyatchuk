import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tabsForPath } from "./routeTab.js";
import { ACCESS_MATRIX } from "./accessMatrix.js";

/**
 * #423 — ПЕРЕЛІК МЕНЕДЖЕРІВ ДОСТУПНИЙ ТОМУ, ХТО СТАВИТЬ ЗАДАЧІ.
 *
 * Скріншот власника 16.09.2026: у менеджера селект «Виконавець» — лише «—». 14.09 зняли
 * заборони на ЗАПИС задач, а ЧИТАННЯ списку лишилось закритим у трьох місцях: tab-гейт
 * (`/api/teams/*` → вкладка teams, якої в менеджера нема), зліпок матриці (`deny: manager`),
 * гард у Dashboard.tsx і гілка роуту «менеджер бачить лише себе». Чотири місця — одне
 * твердження, тому гейт один: прибрати будь-яке — селект знову порожній.
 *
 * 🧨 Червоніє, якщо: повернути гард у Dashboard; повернути `m.id = $` для manager;
 * прибрати окреме правило routeTab (роут провалиться під `teams`); повернути deny.
 */
test("#423 СПИСОК МЕНЕДЖЕРІВ: під вкладкою tasks, дозволений усім ролям, без гарду у фронті й без «лише себе» у роуті", () => {
  const tabs = tabsForPath("/api/teams/managers") ?? [];
  assert.ok(tabs.includes("tasks"), `🔴 /api/teams/managers не під вкладкою tasks (${tabs.join(",")}) — менеджер отримає 403 від tab-гейта`);
  const row = ACCESS_MATRIX.find((r) => r.method === "GET" && r.path === "/api/teams/managers");
  assert.ok(row, "🔴 рядка зліпка для /api/teams/managers немає");
  assert.deepEqual(row!.deny, [], `🔴 у зліпку хтось заборонений: ${row!.deny.join(",")} — селект виконавця в нього порожній`);
  assert.ok(row!.allow.includes("manager") && row!.allow.includes("hr"), "🔴 manager/hr не в allow");

  const dash = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "Dashboard.tsx"), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");
  assert.doesNotMatch(dash, /if \(auth\?\.role === "manager"\) return; fetchManagerOptions\(\)/,
    "🔴 гард по ролі перед fetchManagerOptions повернувся — менеджер не завантажує список узагалі");

  const teams = readFileSync(path.join(import.meta.dirname, "..", "routes", "teams.js"), "utf8");
  const h = teams.slice(teams.indexOf('"/managers"'), teams.indexOf('"/managers"') + 1500);
  assert.doesNotMatch(h, /auth\.role === "manager"/, "🔴 роут знову дає менеджеру лише себе");
  assert.doesNotMatch(h, /auth\.role === "team_lead"/, "🔴 роут знову ріже тімліда по команді");
});
