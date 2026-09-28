import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #668 — СПИСОК ВИКОНАВЦІВ НАЗИВАЄ ЛЮДИНУ ПІБ МЕНЕДЖЕРА, а не логіном: `full_name` у
 * CRM-акаунтів порожнє свідомо (веде синк, редагувати заборонено), тож імʼя береться
 * ланцюжком `full_name → managers.name → логін`, і «логін» позначається лише коли немає
 * ОБОХ. JOIN до менеджера без умови активності в CRM — інакше вимкнений у Kommo адмін
 * знову став би `drv`. Читає джерело роуту. Червоніє, якщо прибрати JOIN, повернути
 * старий COALESCE або додати `m.is_active` в умову.
 */
test("#668 /tasks/assignees: імʼя = full_name → ПІБ менеджера → логін; JOIN менеджера без умови активності", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "tasks.ts"), "utf8");
  const i = src.indexOf('tasksRouter.get("/assignees"'); assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("\n});", i));
  assert.match(body, /COALESCE\(NULLIF\(btrim\(u\.full_name\), ''\), NULLIF\(btrim\(m\.name\), ''\), split_part\(u\.email, '@', 1\)\) AS name/);
  assert.match(body, /LEFT JOIN managers m ON m\.id = u\.manager_id\s*\n\s*WHERE u\.is_active/, "JOIN менеджера має бути без m.is_active");
  assert.doesNotMatch(body, /m\.is_active/);
  assert.match(body, /\(u\.full_name IS NULL OR btrim\(u\.full_name\) = ''\) AND \(m\.name IS NULL OR btrim\(m\.name\) = ''\)\) AS "nameIsLogin"/, "«логін» лише коли немає обох імен");
});
