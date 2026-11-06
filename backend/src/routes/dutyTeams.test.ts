import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #3353 🪞 — ХТО З ТІМЛІДІВ СТАВИТЬ ЧЕРГОВИХ (06.11.2026, рішення Романа: «треба зробити Віці Хомік доступ до цього»).
 * Через роут на порожньому кластері. Тімлід команди з переліку чергування (тут — команда Хомік, 36284) ставить СВОЮ
 * людину → 200 і бачить у списку для призначення лише своїх; людину чужої команди — 403. Тімлід команди поза переліком
 * → 400. Червоніє, якщо прибрати команду Хомік із `DUTY_TEAM_IDS` або відкрити чергування будь-якій команді.
 */
test("#3353 🪞 ЧЕРГУВАННЯ: тімлід команди Хомік ставить своїх; чужих — ні; тімлід команди поза переліком — ні", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  let server: import("node:http").Server | null = null;
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id, name) VALUES (13, 'Рекламна'), (36284, 'Хомік Team Lead'), (99, 'Інша') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id, is_active, kommo_user_id) VALUES
      (201, 'Своя Хомік', 36284, true, '201'), (202, 'З іншої команди', 99, true, '202'), (203, 'Рекламна', 13, true, '203')`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, role_override, manager_id, team_id) VALUES
      (14, 'khomik@t', 'x', 'manager', 'team_lead', NULL, 36284), (15, 'other-tl@t', 'x', 'team_lead', NULL, NULL, 99)`);

    const { default: express } = await import("express");
    const { dutyRouter } = await import("./duty.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    await refreshRoles();
    const app = express();
    app.use(express.json());
    app.use("/api/duty", dutyRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/duty`;
    const tok = (userId: number, teamId: number) => signToken({ userId, role: "team_lead", roleKey: "team_lead", managerId: null, teamId } as never);
    const KHOMIK = tok(14, 36284), OTHER = tok(15, 99);
    const call = async (who: string, method: string, p: string, body?: unknown) => {
      const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${who}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() as any };
    };
    const duty = (managerId: number) => ({ date: "2026-11-08", managerId, shift: "day" });

    const own = await call(KHOMIK, "POST", "/", duty(201));
    assert.equal(own.status, 200, `тімлід Хомік не зміг поставити свою людину: ${JSON.stringify(own.body)}`);
    assert.equal((await call(KHOMIK, "POST", "/", duty(203))).status, 403, "тімлід Хомік поставив людину чужої команди");
    const other = await call(OTHER, "POST", "/", duty(202));
    assert.equal(other.status, 400, `тімлід команди поза переліком поставив чергового: ${JSON.stringify(other.body)}`);

    const list = await call(KHOMIK, "GET", "/?from=2026-11-01&to=2026-11-30");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.managers.map((m: { id: number }) => m.id), [201], "у списку для призначення не лише своя команда Хомік");
    assert.deepEqual((await call(OTHER, "GET", "/?from=2026-11-01&to=2026-11-30")).body.managers, [], "тімлід поза переліком бачить кого призначати");
  } finally {
    if (server) await new Promise((r) => server!.close(r));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
