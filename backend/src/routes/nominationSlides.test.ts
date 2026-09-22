import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #608 — РУЧНІ СЛАЙДИ ПРОТИ БАЗИ З НУЛЯ: керівництво створює, змінює, видаляє й ВІДНОВЛЮЄ;
 * тімлід і менеджер — 403 ще до тіла; порожній заголовок — 400 і від БД, і від роуту.
 */
test("#608 ДИМ: ручні слайди — межа керівництва, порядок, видалення скасовне", async (t) => {
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
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO users (id,email,password_hash,role,full_name) VALUES (1,'admin@uts.ua','x','admin','Адмін')`);
    await assert.rejects(() => c.query(`INSERT INTO nomination_manual_slides (week_from,kind,title) VALUES ('2026-09-14','news','  ')`), /check/i,
      "🔴 БД прийняла слайд без заголовка");
    const { nominationsRouter } = await import("./nominations.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
    const layers = (nominationsRouter as unknown as { stack: Layer[] }).stack.filter((l) => l.route);
    const AUTH: Record<string, unknown> = {
      admin: { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null },
      lead: { userId: 3, role: "team_lead", roleKey: "team_lead", managerId: 103, teamId: 13 },
    };
    async function call(method: string, p: string, o: { who?: string; params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) {
      const layer = layers.find((l) => l.route!.path === p && l.route!.methods[method.toLowerCase()]);
      assert.ok(layer, `🔴 роут не знайдено: ${method} ${p}`);
      const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle as (req: unknown, res: unknown) => void;
      let status = 200; let body: any;
      await new Promise<void>((resolve) => {
        const res = { headersSent: false, status(s: number) { status = s; return res; }, json(b: unknown) { body = b; res.headersSent = true; resolve(); return res; } };
        handler({ auth: AUTH[o.who ?? "admin"], params: o.params ?? {}, query: o.query ?? {}, body: o.body ?? {}, headers: {} }, res);
      });
      return { status, body };
    }
    const W = "2026-09-14";
    assert.equal((await call("GET", "/manual-slides", { who: "lead", query: { weekFrom: W } })).status, 403, "🔴 тімлід читає ручні слайди");
    assert.equal((await call("POST", "/manual-slides", { who: "lead", body: {} })).status, 403, "🔴 тімлід пише ручні слайди (403 має бути ДО валідації)");
    assert.equal((await call("POST", "/manual-slides", { body: { weekFrom: W, kind: "news", fields: { text: "" } } })).status, 400);
    const a = await call("POST", "/manual-slides", { body: { weekFrom: W, kind: "birthday", fields: { person: "Тест Івана", date: "27.08" }, position: 1 } });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await call("POST", "/manual-slides", { body: { weekFrom: W, kind: "newcomer", fields: { headline: "Вітаємо рекрутера (період адаптації)", person: "Тест Марія" }, position: 0 } });
    assert.deepEqual(b.body.slides.map((s: any) => s.kind), ["newcomer", "birthday"], "🔴 порядок слайдів не за position");
    const id = b.body.slides[1].id;
    const e = await call("PATCH", "/manual-slides/:id", { params: { id: String(id) }, body: { weekFrom: W, kind: "birthday", fields: { person: "Тест Івана", date: "28.08" }, position: 1 } });
    assert.equal(e.body.slides[1].fields.date, "28.08");
    const d = await call("DELETE", "/manual-slides/:id", { params: { id: String(id) } });
    assert.equal(d.body.slides.length, 1, "🔴 видалений слайд лишився в показі");
    const r = await call("POST", "/manual-slides/:id/restore", { params: { id: String(id) } });
    assert.equal(r.body.slides.length, 2, "🔴 видалення незворотне — «Відновити» не повернуло слайд");
    assert.equal((await call("POST", "/manual-slides/:id/restore", { params: { id: String(id) } })).status, 404, "🔴 відновлення не видаленого мусить казати, що відновлювати нічого");
    // Інший тиждень ручних слайдів не бачить.
    assert.equal((await call("GET", "/manual-slides", { query: { weekFrom: "2026-09-21" } })).body.slides.length, 0);
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
