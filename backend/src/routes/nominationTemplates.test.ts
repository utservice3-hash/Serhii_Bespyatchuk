import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #615 — КОЖЕН ШАБЛОН ПРОХОДИТЬ ЧЕРЕЗ РОУТ І БАЗУ: слайд шаблону з полями за замовчуванням
 * створюється, читається назад із тими самими полями й підписом у переліку. Червоніє, якщо
 * `CHECK` типу в схемі відстане від реєстру шаблонів (новий шаблон не збережеться) або поля
 * загубляться дорогою до `fields`.
 */
test("#615 ДИМ: слайд кожного шаблону зберігається й читається назад з тими самими полями", async (t) => {
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
    const { nominationsRouter } = await import("./nominations.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { SLIDE_TEMPLATES } = await import("../core/nominationRules.js");
    await refreshRoles();
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
    const layer = (nominationsRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === "/manual-slides" && l.route.methods.post)!;
    const handler = layer.route!.stack[layer.route!.stack.length - 1].handle as (req: unknown, res: unknown) => void;
    const post = (body: unknown) => new Promise<{ status: number; body: any }>((resolve) => {
      let status = 200;
      const res = { headersSent: false, status(s: number) { status = s; return res; }, json(b: unknown) { res.headersSent = true; resolve({ status, body: b }); return res; } };
      handler({ auth: { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null }, params: {}, query: {}, body, headers: {} }, res);
    });
    let pos = 0;
    for (const tpl of SLIDE_TEMPLATES) {
      const fields = Object.fromEntries(tpl.fields.map((f) => [f.key, f.default ?? `${f.label} · тест`]));
      const r = await post({ weekFrom: "2026-09-14", kind: tpl.key, fields, position: pos++ });
      assert.equal(r.status, 201, `🔴 шаблон «${tpl.label}» не зберігся: ${JSON.stringify(r.body)}`);
      const got = r.body.slides.find((s: any) => s.kind === tpl.key);
      assert.ok(got, `🔴 «${tpl.label}» зберігся, але в переліку його немає`);
      for (const f of tpl.fields) assert.equal(got.fields[f.key], fields[f.key].slice(0, f.max), `🔴 «${tpl.label}»: поле «${f.label}» загубилось`);
      assert.ok(got.title.length > 0, `🔴 «${tpl.label}»: порожній підпис у переліку`);
    }
    assert.deepEqual((await post({ weekFrom: "2026-09-14", kind: "newcomer", fields: {} })).status, 400, "🔴 порожній шаблон зберігся");
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
