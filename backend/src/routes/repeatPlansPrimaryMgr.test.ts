import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #9962 — «ПЛАНИ ПО ПОСТІЙНИХ»: ОСНОВНИЙ МЕНЕДЖЕР КЛІЄНТА == НЕЗАЛЕЖНИЙ ПЕРЕРАХУНОК.
 *
 * 18.11.2026 запит `/repeat-plans-grid` переписано: основний менеджер рахується в тому самому
 * проході, що й агрегат клієнта (було — окремий підзапит із ROW_NUMBER, який плановик
 * перераховував на кожного клієнта: 0,9–1,6 с, з «замовклими» понад 10 с). Правило не мінялось:
 * менеджер із найбільшою кількістю оплачених угод клієнта, при рівності — з найсвіжішою.
 *
 * Оракул — СТАРА форма правила окремим запитом, а не той самий вираз: інакше це було б «A = A».
 * Клієнтів, де двоє менеджерів рівні і за кількістю, і за датою, оракул позначає `tie` — там
 * відповідь довільна в обох формах, і порівнювати її означало б ловити шум.
 */
export interface OracleRow { client_key: string; manager_id: number; tie: boolean; mgrs: number }
export interface GridJson { teams: { managers: { managerId: number; clients: { clientKey: string }[] }[] }[] }

/** Чиста звірка: що екран показав не там, де каже правило. */
export function primaryMgrMismatches(grid: GridJson, oracle: OracleRow[]): { seen: number; dup: string[]; wrong: string[]; missing: string[] } {
  const want = new Map(oracle.map((o) => [o.client_key, o]));
  const got = new Map<string, number>(); const dup: string[] = [];
  for (const t of grid.teams) for (const m of t.managers) for (const c of m.clients) {
    if (got.has(c.clientKey)) dup.push(c.clientKey);
    got.set(c.clientKey, m.managerId);
  }
  const wrong: string[] = [], missing: string[] = [];
  for (const [k, mgr] of got) {
    const o = want.get(k);
    if (!o) { missing.push(k); continue; }
    if (!o.tie && o.manager_id !== mgr) wrong.push(`${k}: екран ${mgr} ≠ правило ${o.manager_id}`);
  }
  return { seen: got.size, dup, wrong, missing };
}

test("#9962 ЧИСТА ЗВІРКА основного менеджера ловить чужого, дубль і невідомого — і мовчить на рівних", () => {
  const oracle: OracleRow[] = [
    { client_key: "а", manager_id: 1, tie: false, mgrs: 2 }, { client_key: "б", manager_id: 2, tie: false, mgrs: 1 },
    { client_key: "рівні", manager_id: 1, tie: true, mgrs: 2 },
  ];
  const ok: GridJson = { teams: [{ managers: [{ managerId: 1, clients: [{ clientKey: "а" }] }, { managerId: 2, clients: [{ clientKey: "б" }, { clientKey: "рівні" }] }] }] };
  assert.deepEqual(primaryMgrMismatches(ok, oracle), { seen: 3, dup: [], wrong: [], missing: [] });
  const swapped: GridJson = { teams: [{ managers: [{ managerId: 2, clients: [{ clientKey: "а" }] }, { managerId: 1, clients: [{ clientKey: "б" }, { clientKey: "а" }, { clientKey: "чужий" }] }] }] };
  const r = primaryMgrMismatches(swapped, oracle);
  assert.equal(r.wrong.length, 1, "🔴 клієнт «б» у чужого менеджера не спійманий");
  assert.deepEqual(r.dup, ["а"], "🔴 клієнт під двома менеджерами не спійманий");
  assert.deepEqual(r.missing, ["чужий"], "🔴 клієнт, якого правило не знає, не спійманий");
});

test("#9962b ЖИВИЙ: основний менеджер на екрані «Плани по постійних» == правило, поіменно", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js"); const rbac = await import("../auth/rbac.js");
  const { pool } = await import("../db/pool.js");
  await rbac.refreshRoles();
  const token = signToken({ userId: 0, role: rbac.scopeCompatRole("admin", rbac.getRoleDef("admin")), roleKey: "admin", managerId: null, teamId: null });
  const month = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 7);
  const res = await fetch(`${API_BASE}/api/dashboard/repeat-plans-grid?month=${month}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const grid = await res.json() as GridJson;
  const o = await pool.query<{ client_key: string; manager_id: number; tie: boolean; mgrs: string }>(
    `WITH cm AS (
       SELECT d.client_key, d.manager_id, COUNT(*) AS c, MAX(d.created_at_kommo) AS mx
         FROM deals d
         JOIN managers m ON m.id = d.manager_id AND m.is_active
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE d.client_key IS NOT NULL AND psm.funnel_stage = 'paid'
        GROUP BY d.client_key, d.manager_id),
     r AS (SELECT cm.*, ROW_NUMBER() OVER (PARTITION BY client_key ORDER BY c DESC, mx DESC) AS rn,
                  COUNT(*) OVER (PARTITION BY client_key) AS mgrs,
                  COUNT(*) OVER (PARTITION BY client_key, c, mx) AS same FROM cm)
     SELECT client_key, manager_id, (same > 1) AS tie, mgrs FROM r WHERE rn = 1`);
  const oracle = o.rows.map((x) => ({ ...x, mgrs: Number(x.mgrs) }));
  const r = primaryMgrMismatches(grid, oracle);
  assert.ok(r.seen >= 100, `🔴 на екрані лише ${r.seen} клієнтів — звіряти нема чого, це провал, а не успіх`);
  const multi = oracle.filter((x) => x.mgrs > 1 && !x.tie).length;
  assert.ok(multi >= 50, `🔴 клієнтів із кількома менеджерами лише ${multi} — правило вибору нічим перевірити`);
  assert.deepEqual(r.dup, [], "🔴 клієнт стоїть під двома менеджерами");
  assert.deepEqual(r.missing, [], "🔴 на екрані клієнти, яких правило не знає");
  assert.deepEqual(r.wrong, [], "🔴 основний менеджер на екрані не той, що за правилом «більше оплачених угод, при рівності — свіжіша»");
});
