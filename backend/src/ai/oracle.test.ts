import { test } from "node:test";
import assert from "node:assert/strict";
import { needsAi } from "../testMode.js";

/**
 * ГЕЙТ ЯКОСТІ AI у ЄДИНОМУ наборі. Платний (кожен кейс — RUNS звернень до моделі),
 * тому за замовчуванням пропускається; вмикається `npm run test:ai`.
 *
 * Стандарт зеленого (рішення власника 31.07.2026): 2 прогони · ІДЕНТИЧНІ числа ·
 * числа == ЯДРУ. Один прогін не доказ — у замірі Q2 проходив 2 рази з 3.
 * Еталон рахує ядро в момент прогону, а не зашитий текст: зашитий протухає мовчки.
 */
const load = () => import("./oracle.js");

test("AI-оракул: усі кейси стабільні між прогонами і збігаються з ядром", needsAi(), async (t) => {
  const { CASES, evaluateCase } = await load();
  const red: string[] = [];
  for (const c of CASES) {
    const v = await evaluateCase(c);
    t.diagnostic(`${v.green ? "✅" : "❌"} ${v.id} · ${v.note} · витків ${v.iters.join("/")}${v.why ? " · " + v.why : ""}`);
    if (!v.green) red.push(`${v.id}: ${v.why}`);
  }
  assert.deepEqual(red, [], `червоні кейси:\n  ${red.join("\n  ")}`);
});

test.after(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db/pool.js");
  await pool.end();
});
