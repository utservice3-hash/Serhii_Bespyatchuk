import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #645 — ФОТО ДОХОДЯТЬ ДО НОМІНАЦІЙ І ВІТАЛЬНИХ СЛАЙДІВ ЧЕРЕЗ РОУТИ (22.09.2026), по обидва боки:
 *  · `GET /week` несе `photos`: менеджер Kommo, привʼязаний до людини З фото, — у мапі (з id людини);
 *    привʼязаний БЕЗ фото і людина з фото БЕЗ привʼязки — ні;
 *  · ручний слайд з обраною людиною З фото — `photos[id]` у відповіді редактора; людина без фото — нема.
 * Справжній HTTP разом із `requireAuth` і tab-гейтом, база з нуля.
 */
test("#645 ДИМ: фото доходять до номінацій і вітальних слайдів — лише привʼязані й обрані", async (t) => {
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
    await c.query(`INSERT INTO teams (id, name) VALUES (13, 'РНК - Тест') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id) VALUES (101, 'З Фото', 13), (102, 'Без Фото', 13)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, full_name) VALUES (1, 'admin@uts.ua', 'x', 'admin', 'Адмін')`);
    await c.query(`INSERT INTO employees (id, full_name, import_key, manager_id, photo_file, photo_updated_at) VALUES
      (11, 'З Фото', 'k11', 101, 'photo-11.jpg', '2026-09-22T08:00Z'),
      (12, 'Без Фото', 'k12', 102, NULL, NULL),
      (14, 'Новенька Без Kommo', 'k14', NULL, 'photo-14.jpg', '2026-09-22T09:00Z')`);

    const { default: express } = await import("express");
    const { nominationsRouter } = await import("./nominations.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    await refreshRoles();
    const app = express();
    app.use(express.json());
    app.use("/api/nominations", nominationsRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/nominations`;
    const tok = signToken({ userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null } as never);
    const call = async (method: string, p: string, body?: unknown) => {
      const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() as any };
    };

    const w = await call("GET", "/week?weekFrom=2026-09-14");
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.deepEqual(Object.keys(w.body.photos ?? {}), ["101"], "🔴 у мапі фото тижня не рівно привʼязаний менеджер із фото");
    assert.equal(w.body.photos["101"].id, 11, "🔴 фото менеджера веде не на ту людину");
    assert.equal(w.body.photos["101"].v, Date.parse("2026-09-22T08:00Z"), "🔴 версія фото не з часу зміни — браузер покаже старе");

    const W = "2026-09-14";
    const a = await call("POST", "/manual-slides", { weekFrom: W, kind: "newcomer", fields: { headline: "Вітаємо", person: "Новенька", employeeId: "14" } });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.photos?.["14"]?.id, 14, "🔴 фото обраної на слайді людини не дійшло до редактора");
    const b = await call("POST", "/manual-slides", { weekFrom: W, kind: "birthday", fields: { person: "Без Фото", date: "27.08", employeeId: "12" }, position: 1 });
    assert.deepEqual(Object.keys(b.body.photos), ["14"], "🔴 людина без фото зʼявилась у мапі фото слайдів");
    const g = await call("GET", `/manual-slides?weekFrom=${W}`);
    assert.deepEqual(Object.keys(g.body.photos), ["14"], "🔴 перелік слайдів не несе фото");
  } finally {
    if (server) await new Promise((r) => server!.close(r));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
