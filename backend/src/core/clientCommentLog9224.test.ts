import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  taskSetComment, taskClosedComment, isTaskLogComment, TASK_LOG_LIKE, DEFAULT_TASK_NOTE,
} from "./clientCommentLog.js";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";

/**
 * 💬 КОМЕНТАР ПО КЛІЄНТУ В ОДНОМУ МІСЦІ (задача 9224, ТЗ Юлі 16.11.2026; Роман 18.11 «роби»).
 * Головне місце — стрічка клієнта `client_comments`. Задача реактивації дописує туди коментар постановки (📞) і
 * причину закриття (📋); задачник стрічку лише читає; «Робота з клієнтом» записів задачі не рахує.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
/** Тіло обробника від його оголошення до наступного `<router>.` на початку рядка. */
function handler(src: string, decl: string): string {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `🔴 обробник не знайдено: ${decl}`);
  const rest = src.slice(i + decl.length);
  const j = rest.search(/\n(dashboardRouter|tasksRouter)\./);
  return decl + (j < 0 ? rest : rest.slice(0, j));
}
/** `LIKE 'x %'` для шаблонів лише з кінцевим `%` — так, як їх розуміє Postgres. */
const like = (s: string, pat: string) => (pat.endsWith("%") ? s.startsWith(pat.slice(0, -1)) : s === pat);

/**
 * #9224 🪞 — ТЕКСТ ЗАПИСУ ЗАДАЧІ В СТРІЧКУ. Постановка з коментарем → «📞 Задача на дзвінок до ДД.ММ: текст»;
 * без коментаря (порожньо або підставлене «Подзвонити клієнту») → нічого. Закриття → «📋 … — причина[: пояснення]».
 * 🧨 Червоніє, якщо в стрічку піде підставлений текст (затре справжній останній коментар у рядку) або загубиться
 * текст людини, дата чи причина.
 */
test("#9224 🪞 ЗАПИС ЗАДАЧІ: 📞 лише зі словами людини; 📋 завжди з причиною", () => {
  assert.equal(taskSetComment("2026-11-20", "Немає перевезень до кінця року"), "📞 Задача на дзвінок до 20.11: Немає перевезень до кінця року");
  assert.equal(taskSetComment(null, " З ВЕСНИ "), "📞 Задача на дзвінок: З ВЕСНИ", "🔴 без дедлайну дата вигадана або текст не обрізано");
  assert.equal(taskSetComment("2026-11-20", DEFAULT_TASK_NOTE), null, "🔴 підставлене «Подзвонити клієнту» пішло в стрічку клієнта");
  assert.equal(taskSetComment("2026-11-20", "  "), null, "🔴 порожній коментар пішов у стрічку");
  assert.equal(taskSetComment("2026-11-20", null), null);
  assert.equal(taskSetComment("сміття", "текст"), "📞 Задача на дзвінок: текст", "🔴 дата зі сміття");
  assert.equal(taskClosedComment("Ціна", "дорожче за конкурента"), "📋 Задачу реактивації закрито — Ціна: дорожче за конкурента");
  assert.equal(taskClosedComment("Конкурент", ""), "📋 Задачу реактивації закрито — Конкурент", "🔴 без пояснення лишилась двокрапка");
});

/**
 * #9224b 🪞 — «РОБОТА З КЛІЄНТОМ» НЕ РАХУЄ ЗАПИС ЗАДАЧІ, І ЛИШЕ ЙОГО. Шаблони `TASK_LOG_LIKE` ловлять обидва записи
 * задачі; слова людини (навіть ті, що починаються зі смайлика без пробілу) — ні; `isTaskLogComment` == шаблони.
 * 🧨 Червоніє, якщо шаблон розійдеться з текстом запису (тоді постановка задачі тімлідом запалить «працюють»)
 * або почне ловити звичайні коментарі (тоді «працюють · коментар» згасне людям, що справді писали).
 */
test("#9224b 🪞 ФІЛЬТР «РОБОТИ»: записи задачі — так; слова людини — ні; SQL-шаблон == функція", () => {
  const logs = [taskSetComment("2026-11-20", "передано в роботу Міші")!, taskClosedComment("Інше", "немає потреби")];
  const human = ["не буде замовляти до весни", "📞передзвонити в понеділок", "дзвонила 📞 — не бере", "📋"];
  for (const s of logs) {
    assert.ok(TASK_LOG_LIKE.some((p) => like(s, p)), `🔴 запис задачі не відфільтровано з «роботи»: ${s}`);
    assert.equal(isTaskLogComment(s), true);
  }
  for (const s of human) {
    assert.equal(TASK_LOG_LIKE.some((p) => like(s, p)), false, `🔴 слова людини відфільтровано з «роботи»: ${s}`);
    assert.equal(isTaskLogComment(s), false);
  }
});

/**
 * #9224c — ПРОВОДКА СЕРВЕРА. `/reactivation-task` пише 📞 у `client_comments` через `taskSetComment`; `/close` — 📋 через
 * `taskClosedComment` з людською назвою причини; `/client-plans` віддає «роботі» дату коментаря БЕЗ записів задачі
 * (`withoutTaskLog`), а рядку — останній будь-який; фільтр бере шаблони з ядра, а не копію.
 * 🧨 Червоніє, якщо будь-який запис зникне (коментар знову живе лише в задачнику) або «робота» повернеться на `lastComment`.
 */
test("#9224c ПРОВОДКА: постановка й закриття пишуть у стрічку; «робота» — без записів задачі", () => {
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const set = handler(dash, 'dashboardRouter.post("/reactivation-task", ');
  assert.match(set, /clientCommentLog\.taskSetComment\(deadline, note\)/, "🔴 постановка не будує запис для стрічки");
  assert.match(set, /INSERT INTO client_comments \(client_key, author_id, body\)[\s\S]*?\[clientKey, auth\.userId, logged\]/, "🔴 постановка не пише в стрічку клієнта");
  const close = handler(dash, 'dashboardRouter.post("/reactivation-task/close", ');
  assert.match(close, /clientCommentLog\.taskClosedComment\(reasonLabel, note\)/, "🔴 закриття не будує запис для стрічки");
  assert.match(close, /reactivation\.CLOSE_REASONS\.find/, "🔴 у стрічку йде ключ причини замість назви");
  assert.match(close, /INSERT INTO client_comments/, "🔴 закриття не пише в стрічку клієнта");
  assert.ok(close.indexOf("INSERT INTO client_comments") > close.indexOf("UPDATE tasks SET status = 'done'"), "🔴 запис у стрічку раніше за саме закриття");
  assert.match(dash, /latestCommentByClient\(\{ withoutTaskLog: true \}\)/, "🔴 «робота» не має коментаря без записів задачі");
  assert.match(dash, /comment: lastWorkComment\.get\(c\.client_key\)\?\.createdAt/, "🔴 «робота» рахує запис задачі як коментар");
  assert.match(dash, /lastComment: lastComment\.get\(c\.client_key\)/, "🔴 рядок списку втратив останній коментар");
  assert.match(dash, /c\.body LIKE ANY\(\$1::text\[\]\)[\s\S]{0,200}clientCommentLog\.TASK_LOG_LIKE/, "🔴 фільтр «роботи» — копія шаблонів, а не ядро");
});

/**
 * #9224d — СТРІЧКА В ЗАДАЧІ: МЕЖА — ВИДИМІСТЬ ЗАДАЧІ, ЛИШЕ ЧИТАННЯ. `GET /tasks/:id/client-comments` першим
 * оператором відкриває задачу в режимі «see» (чужа — 404), віддає лише для `reactivation_client`, тільки SELECT;
 * у матриці є і лише GET (POST-а немає — писати з задачника не можна).
 * 🧨 Червоніє, якщо межу знімуть або послаблять до читання без перевірки задачі, або роут почне писати.
 */
test("#9224d СТРІЧКА В ЗАДАЧІ: «see» першим, лише реактивація, лише читання, рядок матриці", () => {
  const tasks = codeOnly(read("backend/src/routes/tasks.ts"));
  const h = handler(tasks, 'tasksRouter.get("/:id/client-comments", ');
  const body = h.slice(h.indexOf("{") + 1).trim();
  assert.match(body, /^const t = await openTask\(req, res, "see"\);\s*if \(!t\) return;/, "🔴 межа видимості задачі не перша");
  assert.match(h, /t\.meta\.taskType !== REACTIVATION_CLIENT_TASK_TYPE/, "🔴 стрічку віддає будь-якій задачі");
  assert.match(h, /FROM client_comments c/, "🔴 читає не стрічку клієнта");
  assert.doesNotMatch(h, /\b(INSERT|UPDATE|DELETE)\b/, "🔴 роут читання щось пише");
  const rows = ACCESS_MATRIX.filter((r) => r.path === "/api/tasks/:id/client-comments");
  assert.deepEqual(rows.map((r) => r.method), ["GET"], "🔴 у матриці немає роуту або зʼявився запис");
});

/**
 * #9224e — ФРОНТ. Задача реактивації показує «💬 Коментарі по клієнту» (лише читання) замість поля «Короткий
 * коментар»; решта задач — поле як було (дзеркало). Рядок «Клієнтів» показує дату й автора, не лише в підказці.
 * 🧨 Червоніє, якщо поле повернеться в задачу реактивації, зникне в інших задачах, або дата й автор зникнуть з рядка.
 */
test("#9224e ФРОНТ: задача реактивації — стрічка клієнта; інші — «Короткий коментар»; дата й автор у рядку", () => {
  const ts = codeOnly(read("frontend/src/pages/dashboard/sections/TasksSection.tsx"));
  assert.match(ts, /openTask\.taskType === "reactivation_client" \? \(\s*<div[^>]*><ReactClientFeed task=\{openTask\} \/><\/div>\s*\) : <div/, "🔴 задача реактивації не показує стрічку клієнта");
  const feed = ts.slice(ts.indexOf("function ReactClientFeed"), ts.indexOf("function SubtasksEditor"));
  assert.match(feed, /fetchTaskClientComments\(task\.id\)/, "🔴 стрічка в задачі не з сервера");
  assert.doesNotMatch(feed, /<textarea|<input|commitTask|addClientComment/, "🔴 у задачі знову пишуть коментар — третє місце");
  const after = ts.slice(ts.indexOf('openTask.taskType === "reactivation_client" ? ('));
  assert.match(after.slice(0, 3000), /Короткий коментар[\s\S]*?onBlur=\{\(e\) => commitTask\(openTask\.id, \{ comments: e\.target\.value \}\)\}/, "🔴 інші задачі втратили «Короткий коментар»");
  const rc = codeOnly(read("frontend/src/pages/dashboard/sections/RowComment.tsx"));
  assert.match(rc, /\{text && value && \([\s\S]*?value\.createdAt[\s\S]*?value\.author/, "🔴 дата й автор знову лише в підказці");
});
