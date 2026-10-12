import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { skipReason } from "../db/scratchDb.js";

/**
 * 🎯 #1630 — «МІСЯЧНІ ЦІЛІ» ПИШЕ ТОЙ, КОМУ ВІДКРИТО ВКЛАДКУ (Роман 12.10.2026). Привід: Іван (HR) бачив вкладку, а «Додати»
 * отримував 403 — роут пускав лише admin|team_lead. Перевіряється ПОВЕДІНКОЮ на тимчасовій базі зі справжньою схемою й
 * ролями з неї: обробники кличуться напряму (як `#12`), з усім ланцюгом роуту.
 */
let ctxP: Promise<{ raw: import("pg").Client } | { unavailable: string }> | null = null;
let dispose: (() => Promise<void>) | null = null;
after(async () => {
  if (dispose) await dispose();
  try { const { pool } = await import("../db/pool.js"); await pool.end(); } catch { /* пул не піднімався */ }
});

async function ctx(t: { skip: (m: string) => void }) {
  ctxP ??= (async () => {
    const { provisionScratch } = await import("../db/scratchDb.js");
    const s = provisionScratch();
    if ("unavailable" in s) return { unavailable: skipReason(s) };
    process.env.DATABASE_URL = s.url;
    process.env.JWT_SECRET ??= "test";
    process.env.KOMMO_BASE_URL ??= "https://x.invalid";
    process.env.KOMMO_API_TOKEN ??= "x";
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: s.url });
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO users (id, email, password_hash, role) VALUES (901, 'hr@x', 'x', 'admin'), (902, 'kvp@x', 'x', 'admin')
                   ON CONFLICT DO NOTHING`);
    dispose = async () => { await c.end().catch(() => {}); s.dispose(); };
    return { raw: c };
  })();
  const r = await ctxP;
  if ("unavailable" in r) { t.skip(r.unavailable); return null; }
  return r;
}

type Handler = (req: Request, res: Response, next: (e?: unknown) => void) => unknown;
async function call(method: string, routePath: string, auth: Record<string, unknown>, opts: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {}) {
  const { goalsRouter } = await import("./goals.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (goalsRouter as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `🔴 роуту ${method.toUpperCase()} ${routePath} немає`);
  const chain: Handler[] = layer.route.stack.map((s: { handle: Handler }) => s.handle);
  const st: { code: number; body: unknown } = { code: 200, body: null };
  const res = { status(c: number) { st.code = c; return res; }, json(b: unknown) { st.body = b; return res; }, send(b: unknown) { st.body = b; return res; } } as unknown as Response;
  const req = { auth, body: opts.body ?? {}, params: opts.params ?? {}, query: opts.query ?? {} } as unknown as Request;
  for (const h of chain) {
    let passed = false;
    await h(req, res, () => { passed = true; });
    if (!passed) break;
  }
  return st;
}

test("#1630 ЦІЛІ — ЗА ВКЛАДКОЮ: HR із вкладкою пише й бачить СВОЇ; без вкладки — 403; чуже — 403, неіснуюче — 404; «Цілі команд» лише адмін-рівню", async (t) => {
  const c = await ctx(t); if (!c) return;
  const q = (s: string, p?: unknown[]) => c.raw.query(s, p);
  const { refreshRoles } = await import("../auth/rbac.js");
  const hr = { userId: 901, role: "company", roleKey: "hr", managerId: null, teamId: null };
  const kvp = { userId: 902, role: "admin", roleKey: "kvp", managerId: null, teamId: null };
  const mgr = { userId: 903, role: "manager", roleKey: "manager", managerId: 1, teamId: 1 };

  // HR із вкладкою (так на проді з 12.10.2026) — пише свою ціль, без команди навіть якщо попросив команду.
  await q(`UPDATE roles SET screen_access = screen_access || '{"goals": true}'::jsonb WHERE key IN ('hr', 'kvp')`);
  await q(`UPDATE roles SET screen_access = screen_access || '{"goals": false}'::jsonb WHERE key = 'manager'`);
  await refreshRoles();
  const made = await call("post", "/", hr, { body: { month: "2026-10", title: "Регламент онбордингу стажера", teamId: 5 } });
  assert.equal(made.code, 201, `🔴 HR із вкладкою не може додати ціль (${made.code}) — рівно скарга Івана`);
  const hrId = (made.body as { id: number }).id;
  assert.equal((await q(`SELECT team_id FROM monthly_goals WHERE id = $1`, [hrId])).rows[0].team_id, null, "🔴 HR прив'язав ціль до команди");
  const kvpGoal = await call("post", "/", kvp, { body: { month: "2026-10", title: "Ціль КВП", teamId: null } });
  const kvpId = (kvpGoal.body as { id: number }).id;

  // Бачить лише свої — навіть попросивши «Цілі команд».
  const mine = await call("get", "/", hr, { query: { month: "2026-10", scope: "teams" } });
  assert.equal(mine.code, 200);
  const ids = (mine.body as { goals: { id: number }[] }).goals.map((g) => g.id);
  assert.deepEqual(ids, [hrId], "🔴 HR побачив чужі цілі через scope=teams");
  // ДЗЕРКАЛО: адмін-рівень у «Цілях команд» бачить ціль HR.
  const teams = await call("get", "/", kvp, { query: { month: "2026-10", scope: "teams" } });
  assert.ok((teams.body as { goals: { id: number }[] }).goals.some((g) => g.id === hrId), "🔴 «Цілі команд» адміна не бачать цілі HR");

  // Чуже — 403, неіснуюче — 404, своє — можна.
  assert.equal((await call("patch", "/:id", hr, { params: { id: String(kvpId) }, body: { title: "x" } })).code, 403, "🔴 HR змінив чужу ціль");
  assert.equal((await call("delete", "/:id", hr, { params: { id: String(kvpId) } })).code, 403, "🔴 HR видалив чужу ціль");
  assert.equal((await call("patch", "/:id", hr, { params: { id: "0" }, body: { title: "x" } })).code, 404, "🔴 неіснуюча ціль не дала 404");
  assert.equal((await call("patch", "/:id", hr, { params: { id: String(hrId) }, body: { status: "done" } })).code, 200);
  assert.equal((await q(`SELECT status FROM monthly_goals WHERE id = $1`, [hrId])).rows[0].status, "done");

  // Роль без вкладки — 403 на все, нічого не записано.
  const before = Number((await q(`SELECT count(*) AS n FROM monthly_goals`)).rows[0].n);
  assert.equal((await call("post", "/", mgr, { body: { month: "2026-10", title: "x" } })).code, 403, "🔴 менеджер без вкладки додав ціль");
  assert.equal((await call("get", "/", mgr, { query: { month: "2026-10" } })).code, 403);
  // ДЗЕРКАЛО: ВКЛАДКУ HR ЗНЯЛИ — і HR знову 403 (межа — саме вкладка, а не роль у коді).
  await q(`UPDATE roles SET screen_access = screen_access || '{"goals": false}'::jsonb WHERE key = 'hr'`);
  await refreshRoles();
  assert.equal((await call("post", "/", hr, { body: { month: "2026-10", title: "x" } })).code, 403, "🔴 HR без вкладки все одно пише цілі");
  assert.equal(Number((await q(`SELECT count(*) AS n FROM monthly_goals`)).rows[0].n), before, "🔴 відмова все одно щось записала");
});
