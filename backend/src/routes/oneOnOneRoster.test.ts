import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { inOwnWorkListsSql } from "../core/managerState.js";
import { activeManagerSql } from "../core/activeManager.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");

/**
 * #3420 🪞 — РОСТЕР 1×1 БЕЗ ЗВІЛЬНЕНИХ (задача 8249), предикат на порожньому кластері.
 * Обидва боки межі: звільнений накладкою адміна, але активний у Kommo (Шевчук Назар) — НІ; вимкнений у Kommo — НІ;
 * «завершує» — ТАК (ще працює); звичайний — ТАК; без логіна — ТАК (логіна не заводили — не звільнення).
 * Червоніє, якщо предикат знову дивиться лише на Kommo, або почне прибирати «завершує».
 */
test("#3420 🪞 1×1 · РОСТЕР: звільнений у дашборді (хоч активний у Kommo) — ні; «завершує» й звичайний — так", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (5,'Яцик Team lead') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES
      (1,'Звичайний',5,true),(2,'Звільнений, активний у Kommo',5,true),(3,'Завершує',5,true),(4,'Вимкнений у Kommo',5,false),(5,'Без логіна',5,true)`);
    await c.query(`INSERT INTO users(id,email,password_hash,role,manager_id,team_id,is_active) VALUES
      (11,'a@uts.ua','x','manager',1,5,true),(12,'b@uts.ua','x','manager',2,5,true),(13,'c@uts.ua','x','manager',3,5,true),(14,'d@uts.ua','x','manager',4,5,true)`);
    await c.query(`INSERT INTO manager_work_state(manager_id,state,since) VALUES (2,'dismissed','2026-09-08'),(3,'finishing','2026-11-01')`);
    const ids = (await c.query<{ id: number }>(
      `SELECT m.id FROM managers m WHERE ${inOwnWorkListsSql("m", activeManagerSql("m"))} ORDER BY m.id`)).rows.map((r) => r.id);
    assert.deepEqual(ids, [1, 3, 5], "🔴 ростер 1×1: звільнений або вимкнений лишився, чи зник «завершує» / людина без логіна");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #3420b — ПРОВОДКА: «кого можна провести» в 1×1 (список, запис, задачі) бере стан менеджера, а не голий Kommo-прапорець.
 * Червоніє, якщо в `conductSubjectScope` повернеться `m.is_active` замість правила стану.
 */
test("#3420b 1×1 · ПРОВОДКА: скоуп «провести» — за станом менеджера, не за голим Kommo-прапорцем", () => {
  const src = SRC("routes/oneOnOnes.ts");
  const fn = src.slice(src.indexOf("function conductSubjectScope"), src.indexOf("/** WHERE-фрагмент для VIEW-скоупу"));
  assert.ok(fn.length > 0, "🔴 conductSubjectScope не знайдено");
  assert.doesNotMatch(fn, /m\.is_active/, "🔴 скоуп 1×1 знову дивиться лише на Kommo — звільнені повернуться в ростер");
  assert.equal((fn.match(/SUBJECT_WORKS/g) ?? []).length, 4, "🔴 не кожна гілка скоупу (A, B, V, наскрізний) бере стан менеджера");
  assert.match(src, /const SUBJECT_WORKS = managerState\.inOwnWorkListsSql\("m", activeManagerSql\("m"\)\)/, "🔴 стан для 1×1 — не той, що в ростері аналітики");
});
