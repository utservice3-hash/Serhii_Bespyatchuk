import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ✏️ HR РЕДАГУЄ НАВЧАННЯ (01.10.2026) — гейт `#774`. Роман: «так, дай hr редагування навчання».
 *
 * Права `manage_training` HR замало: «бачить чернетки» в навчанні до цього дня вирішував адмін-рівень, а HR не
 * адмін — він отримав би кнопки редактора над списком без чернеток (на проді 11 із 12 курсів — чернетки). Тому
 * правило одне — `seesDrafts` у `routes/training.ts`, — і тут воно ганяється обробниками роутера РАЗОМ із межею
 * `requirePerm` на живій схемі, по обидва боки межі (правило 11):
 *   • HR — бачить курс-чернетку й чернетку уроку, створює урок;
 *   • тімлід — не бачить чернеток і на запис дістає 403 (розширення не розтеклось);
 *   • фінансист — бачить чернетки, як і досі (адмін-рівень), але редагувати не може (рішення 14.09.2026).
 * Окремий файл — свій scratch-кластер і свій пул (правило «один кластер на прогін файлу»).
 */
const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

test("#774 ЖИВИЙ SQL: HR бачить чернетки й редагує навчання; тімлід — ні; фінансист бачить, але не редагує", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) return t.skip(skipReason(s));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  try {
    await c.connect();
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`UPDATE training_courses SET published = false`);
    const course = (await c.query(`INSERT INTO training_courses (title, audience, published) VALUES ('Чернетка курсу','manager',false) RETURNING id`)).rows[0].id as number;
    const mod = (await c.query(`INSERT INTO training_folders (name, course_id, position) VALUES ('Тема', $1, 1) RETURNING id`, [course])).rows[0].id as number;
    const draft = (await c.query(`INSERT INTO training_materials (folder_id, title, kind, position, content, status) VALUES ($1,'Чернетка уроку','text',1,'т','draft') RETURNING id`, [mod])).rows[0].id as number;
    const uid = (await c.query(`INSERT INTO users (email, password_hash, role) VALUES ('x@x.ua','x','manager') RETURNING id`)).rows[0].id as number;

    Object.assign(process.env, { DATABASE_URL: s.url, JWT_SECRET: "scratch-only", KOMMO_BASE_URL: "http://127.0.0.1:9", KOMMO_API_TOKEN: "scratch" });
    const { trainingRouter } = await import("../routes/training.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();   // без кешу ролей `roleHasPerm` fail-closed — усі стали б «без права»
    type Handler = (req: unknown, res: unknown, next: () => void) => unknown;
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } };
    const AS = {
      hr: { userId: uid, roleKey: "hr", role: "company", managerId: null, teamId: null },
      lead: { userId: uid, roleKey: "team_lead", role: "team_lead", managerId: null, teamId: 1 },
      fin: { userId: uid, roleKey: "financier", role: "admin", managerId: null, teamId: null },
    };
    /** Увесь ланцюг роуту — межа `requirePerm` теж, — а не лише останній обробник. */
    const call = async (who: keyof typeof AS, method: string, p: string, params: Record<string, string> = {}, body: Record<string, unknown> = {}) => {
      const layer = (trainingRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === p && l.route.methods[method]);
      assert.ok(layer, `🔴 роуту ${method.toUpperCase()} ${p} немає`);
      const out: { code: number; body: Record<string, unknown> } = { code: 200, body: {} };
      let done = false;
      const res = { status(x: number) { out.code = x; return res; }, json(b: Record<string, unknown>) { out.body = b; done = true; return res; } };
      for (const h of layer!.route!.stack) {
        let next = false;
        await h.handle({ auth: AS[who], params, body }, res, () => { next = true; });
        if (done || !next) break;
      }
      return out;
    };
    const titles = (r: { body: Record<string, unknown> }) => ((r.body.courses ?? []) as { title: string }[]).map((x) => x.title);
    try {
      // HR — редактор: бачить чернетки й пише.
      assert.ok(titles(await call("hr", "get", "/courses")).includes("Чернетка курсу"), "🔴 HR-редактор не бачить курсу-чернетки");
      assert.equal((await call("hr", "get", "/material/:id", { id: String(draft) })).code, 200, "🔴 HR-редактор не відкриває чернетку уроку");
      const tree = await call("hr", "get", "/tree");
      assert.ok((tree.body.materials as { id: number }[]).some((m) => m.id === draft), "🔴 у бібліотеці HR немає чернетки");
      const made = await call("hr", "post", "/material", {}, { folderId: mod, title: "Новий урок від HR", kind: "text", content: "т" });
      assert.equal(made.code, 200, `🔴 HR не може створити урок: ${JSON.stringify(made.body)}`);

      // 🪞 Тімлід — ні: розширення не розтеклось.
      assert.ok(!titles(await call("lead", "get", "/courses")).includes("Чернетка курсу"), "🔴 тімлід бачить курс-чернетку");
      assert.equal((await call("lead", "get", "/material/:id", { id: String(draft) })).code, 404, "🔴 тімлід відкриває чернетку уроку");
      assert.equal((await call("lead", "post", "/material", {}, { folderId: mod, title: "x", kind: "text", content: "т" })).code, 403, "🔴 тімлід створює урок");

      // 🪞 Фінансист — бачить, як і досі (адмін-рівень), але не редагує (рішення 14.09.2026).
      assert.equal((await call("fin", "get", "/material/:id", { id: String(draft) })).code, 200, "🔴 фінансист утратив перегляд чернеток — правило звузило більше, ніж вирішено");
      assert.equal((await call("fin", "post", "/material", {}, { folderId: mod, title: "x", kind: "text", content: "т" })).code, 403, "🔴 фінансист створює урок");
    } finally { (await import("../db/pool.js")).pool.end().catch(() => undefined); }
  } finally {
    await c.end().catch(() => {});
    s.dispose();
  }
});
