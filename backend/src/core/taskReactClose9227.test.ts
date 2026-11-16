import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";
import { tabsForPath } from "../auth/routeTab.js";

/**
 * 📋 ЗАДАЧНИК: «ГОТОВО» НА ЗАДАЧІ РЕАКТИВАЦІЇ (задача 9227, 16.11.2026). База дозволяє закрити таку задачу лише з
 * причиною закриття; звичайне «Готово» причини не несло, запис відхилявся помилкою сервера, і статус відкочувався на
 * «Готово на затвердження» (на проді так зависло 89 задач). Гейт стереже, що задачник спершу питає причину.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

test("#4022 🪞 «ГОТОВО» НА ЗАДАЧІ РЕАКТИВАЦІЇ ПИТАЄ ПРИЧИНУ: задачник не шле голе «Готово», сервер відповідає словами, а не помилкою бази", () => {
  const t = src("backend/src/routes/tasks.ts");
  const at = t.indexOf('tasksRouter.patch("/:id"');
  const body = t.slice(at, t.indexOf("\n});", at));
  const guard = body.indexOf('before.taskType === REACTIVATION_CLIENT_TASK_TYPE && parsed.data.status === "done"'), upd = body.indexOf("UPDATE tasks SET");
  assert.ok(guard > 0 && guard < upd, "🔴 «Готово» на задачі реактивації доходить до бази без причини — CHECK відповість голою помилкою сервера");
  assert.match(body, /status\(400\)\.json\(\{ error: REACTIVATION_DONE_NEEDS_REASON \}\)/);
  assert.match(t, /REACTIVATION_CLIENT_TASK_TYPE = "reactivation_client"/);
  // Той самий тип — у правилі фронту й у CHECK бази: розійдуться — діалог причини перестане відкриватись.
  const rule = src("frontend/src/pages/dashboard/reactCloseRule.ts");
  assert.match(rule, /REACTIVATION_CLIENT_TASK = "reactivation_client"/, "🔴 тип задачі у правилі фронту не той, що на сервері");
  assert.match(rule, /return taskType === REACTIVATION_CLIENT_TASK && status === "done";/, "🔴 правило питає причину не лише на «Готово» задачі реактивації");
  assert.match(src("backend/src/db/schema.sql"), /task_type <> 'reactivation_client' OR status <> 'done' OR length\(btrim\(coalesce\(close_reason,''\)\)\) > 0/, "еталон: CHECK причини в базі не той");

  const ui = src("frontend/src/pages/dashboard/sections/TasksSection.tsx");
  // Усі чотири місця зміни статусу задачі йдуть через changeStatus; прямого `commitTask(…, { status })` для самої задачі немає.
  assert.equal((ui.match(/changeStatus\(/g) ?? []).length, 3, "🔴 місць зміни статусу через changeStatus не три (таблиця, картка, галочка «виконано»)");
  // Четверте місце — меню статусу в рядку «Що горить»: «Готово» з нього йде через галочку (`onDone`), тримає #1967.
  assert.match(src("frontend/src/pages/dashboard/sections/TasksFocusView.tsx"), /st === "done" \? onDone\(t\) : onStatus\(t, st\)/,
    "🔴 «Готово» з меню рядка йде повз галочку - задача реактивації закриється без причини");
  assert.doesNotMatch(ui, /commitTask\((task|openTask)\.id, \{ status \}\)/, "🔴 лишилось місце, де статус задачі пишеться повз перевірку причини");
  assert.match(ui, /if \(needsCloseReason\(t\.taskType, "done"\)\) \{ changeStatus\(t, "done"\); return; \}/, "🔴 галочка «виконано» закриває задачу реактивації без причини");
  assert.match(ui, /await closeReactivationTask\(\{ taskId: reactClose\.id, reason, note \}\)/, "🔴 причина з задачника не йде в роут закриття з причиною");

  const row = ACCESS_MATRIX.filter((x) => x.method === "GET" && x.path === "/api/dashboard/reactivation-task/close-reasons");
  assert.equal(row.length, 1, "🔴 довідник причин без рядка матриці");
  assert.ok(row[0].allow.includes("manager") && row[0].deny.includes("hr"), "🔴 менеджер не може прочитати причини або HR може");
  assert.deepEqual(tabsForPath("/api/dashboard/reactivation-task/close-reasons"), ["loyalty"], "🔴 довідник причин без вкладкової межі");
});
