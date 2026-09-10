import { test } from "node:test";
import assert from "node:assert/strict";
import { needsBackendEnv } from "../testMode.js";
import { clientsListSql } from "./clientPlansList.js";

/**
 * #396 — СКОУП НАКЛАДАЄТЬСЯ НА МАТЕРІАЛІЗОВАНУ БАЗУ, а не всередині запиту.
 * Саме внутрішня умова `pm.manager_id = $2` давала планувальнику привід на вкладений
 * цикл ×838 і 21,7 с для менеджера (10.09.2026). Червоніє, якщо прибрати MATERIALIZED
 * або повернути умову всередину (тоді `${cond}` стоятиме ДО `FROM base`).
 */
test("#396 СПИСОК КЛІЄНТІВ: умова скоупу стоїть ПІСЛЯ матеріалізованої бази", () => {
  const sql = clientsListSql("AND b.primary_manager_id = $2");
  assert.match(sql, /base AS MATERIALIZED \(/, "база більше не матеріалізована — планувальник знову вільний обирати вкладений цикл");
  const fromBase = sql.indexOf("FROM base b");
  const cond = sql.indexOf("AND b.primary_manager_id = $2");
  assert.ok(fromBase > 0 && cond > fromBase, "умова скоупу стоїть не після FROM base — вона знову всередині запиту");
  assert.match(sql, /pm\.manager_id AS primary_manager_id/, "колонка скоупу мусить бути ТА САМА, що була в умові (основний за оплатами)");
  // 🪞 Без умови — та сама база, без хвоста.
  assert.match(clientsListSql(""), /WHERE 1=1 \s*ORDER BY b\.revenue DESC/);
});

/**
 * #396b ЖИВИЙ 🪞 — на проді: список менеджера == адмінський список, відфільтрований по тому
 * самому менеджеру (склад і порядок), і обидва відповідають швидше за вартового.
 * Стереже, що перф-правка не змінила, КОГО бачить менеджер. Червоніє, якщо розійдуться
 * рядки або час перевищить 5 с (вартовий роуту — 20 с; запас навмисно ×4).
 */
test("#396b ЖИВИЙ 🪞: список менеджера == адмінський, звужений по ньому; обидва < 5 с",
  { ...needsBackendEnv() }, async () => {
  const { pool } = await import("../db/pool.js");
  const metrics = await import("./metrics.js");
  const G = metrics.GENERIC_CLIENT_KEYS;
  const t0 = Date.now();
  const admin = await pool.query<{ client_key: string; primary_manager_id: number }>(clientsListSql(""), [G]);
  const tAdmin = Date.now() - t0;
  assert.ok(admin.rowCount && admin.rowCount > 0, "простір порожній — перевірці нема що знаходити");
  // Менеджер із найбільшою кількістю клієнтів — найважчий випадок для планувальника.
  const counts = new Map<number, number>();
  for (const r of admin.rows) counts.set(r.primary_manager_id, (counts.get(r.primary_manager_id) ?? 0) + 1);
  const [mgr] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const t1 = Date.now();
  const own = await pool.query<{ client_key: string }>(clientsListSql("AND b.primary_manager_id = $2"), [G, mgr]);
  const tMgr = Date.now() - t1;
  // Порівнюємо СКЛАД, а не порядок: ORDER BY revenue DESC без другого ключа дає довільний
  // порядок серед рівних сум (заміряно 10.09: множини рівні, порядок серед ties плаває).
  const expected = admin.rows.filter((r) => r.primary_manager_id === mgr).map((r) => r.client_key).sort();
  assert.deepEqual(own.rows.map((r) => r.client_key).sort(), expected, `менеджер ${mgr}: склад рядків розійшовся з адмінським`);
  assert.ok(tMgr < 5000, `менеджер ${mgr}: ${tMgr} мс — знову повільно (адмін ${tAdmin} мс)`);
  assert.ok(tAdmin < 5000, `адмін: ${tAdmin} мс`);
});
