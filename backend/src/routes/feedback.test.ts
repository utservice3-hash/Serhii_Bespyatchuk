import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import {
  FEEDBACK_CLOSED_STATUSES, FEEDBACK_PURGE_WHERE, FEEDBACK_RETENTION_DAYS, imageKind, isClosedStatus, purgeDate,
} from "../core/feedbackRetention.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

/**
 * #495 — ПРАВИЛА ЗВОРОТНОГО ЗВʼЯЗКУ: ЩО ТАКЕ «ЗАКРИТЕ», КОЛИ ВИДАЛЯЄТЬСЯ, ЩО ТАКЕ ФОТО.
 *
 * Рішення Романа 05.10.2026: закрите = «вирішено» або «відхилено»; через 30 днів — безповоротно
 * разом із фото. Фото — лише JPG/PNG/WEBP, і тип визначається БАЙТАМИ.
 *
 * 🧨 Червоніє, якщо: «схвалено» стане закритим (видалятимуться звернення в роботі); строк у
 * предикаті й у підписі «видалиться ДД.ММ» розійдуться; текст із розширенням .png пройде як фото.
 */
test("#495 ЗВОРОТНИЙ ЗВʼЯЗОК: закрите = вирішено/відхилено, 30 днів, фото — за байтами", () => {
  assert.deepEqual([...FEEDBACK_CLOSED_STATUSES].sort(), ["rejected", "resolved"], "🔴 склад «закритих» змінився");
  assert.equal(isClosedStatus("approved"), false, "🔴 «схвалено» (ще в роботі) стало закритим — його видалятимуть");
  assert.equal(isClosedStatus("pending"), false);
  assert.equal(isClosedStatus("resolved"), true);
  assert.equal(FEEDBACK_RETENTION_DAYS, 30, "🔴 строк зберігання не 30 днів");
  assert.match(FEEDBACK_PURGE_WHERE, /interval '30 days'/, "🔴 предикат видалення не на тому строку, що підпис");
  assert.match(FEEDBACK_PURGE_WHERE, /'resolved'/);
  assert.match(FEEDBACK_PURGE_WHERE, /'rejected'/);
  assert.doesNotMatch(FEEDBACK_PURGE_WHERE, /'approved'|'pending'/, "🔴 предикат зачепить відкриті звернення");
  assert.equal(purgeDate(new Date("2026-10-05T10:00:00Z"))!.toISOString(), "2026-11-04T10:00:00.000Z");
  assert.equal(purgeDate(null), null, "🔴 відкрите звернення отримало дату видалення");

  assert.equal(imageKind(PNG), "image/png");
  assert.equal(imageKind(JPG), "image/jpeg");
  assert.equal(imageKind(WEBP), "image/webp");
  assert.equal(imageKind(Buffer.from("MZ\x90\x00 not an image, renamed to .png")), null, "🔴 не-картинка пройшла як фото");
  assert.equal(imageKind(Buffer.from("%PDF-1.7")), null, "🔴 PDF пройшов як фото");
  assert.equal(imageKind(Buffer.from([0x89, 0x50])), null, "🔴 обрізаний заголовок пройшов як PNG");
});

/**
 * #496 — ФОТО ЗВОРОТНОГО ЗВʼЯЗКУ ЗАКРИТІ ВІД AI: REVOKE після GRANT і CREATE, і є у FORBIDDEN_TABLES.
 *
 * Скриншот може містити що завгодно з екрана — клієнтів, суми, переписку. `GRANT SELECT ON ALL
 * TABLES` вище в схемі накриває кожну нову таблицю, тож без REVOKE вона відкрилась би моделі сама.
 * 🧨 Червоніє, якщо REVOKE прибрати або поставити ДО створення таблиці.
 */
test("#496 ЗВОРОТНИЙ ЗВʼЯЗОК: feedback_files відібрана в ai_readonly після GRANT і CREATE і є у FORBIDDEN_TABLES", () => {
  const sql = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
  const grantAt = sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly");
  const createAt = sql.indexOf("CREATE TABLE IF NOT EXISTS feedback_files (");
  assert.ok(grantAt > 0 && createAt > 0, "🔴 не знайдено GRANT або CREATE feedback_files");
  const ok = [...sql.matchAll(/REVOKE ALL ON ([^;]+?) FROM ai_readonly/g)]
    .some((m) => /\bfeedback_files\b/.test(m[1]) && m.index! > grantAt && m.index! > createAt);
  assert.ok(ok, "🔴 feedback_files не відібрана в ai_readonly після GRANT і CREATE");
  const tools = readFileSync(path.join(import.meta.dirname, "..", "ai", "metricTools.js"), "utf8");
  const list = tools.match(/FORBIDDEN_TABLES = \[([\s\S]*?)\];/);
  assert.ok(list && list[1].includes('"feedback_files"'), "🔴 feedback_files не в FORBIDDEN_TABLES");
});

/**
 * #497 — ДИМ ПРОТИ БАЗИ З НУЛЯ: ВАРІАНТ А, ВИДАЛЕННЯ ЧЕРЕЗ 30 ДНІВ І РОУТИ ФОТО ВИКОНУЮТЬСЯ.
 *
 * SQL у шаблонному рядку не типізується, тож tsc про ці запити не знає нічого. Тут вони біжать:
 *  · ВАРІАНТ А: «вирішене» без `closed_at` і зі старим `updated_at` (стан проду до викату) після
 *    повторного застосування схеми отримує `closed_at = now()` і НЕ видаляється першою ж ніччю;
 *  · джоба видаляє рівно закрите понад 30 днів — разом із рядками фото й байтами на диску;
 *    закрите 29 днів тому, «схвалене» й «на розгляді» (навіть старі) лишаються, їхні байти теж;
 *  · PATCH ставить `closed_at` при закритті й знімає при поверненні на розгляд;
 *  · фото: PNG → 201, текст → 400, понад 5 МБ → 413, шосте → 409; чуже звернення → 404.
 *
 * 🧨 Червоніє, якщо: бекфіл візьме `updated_at`; предикат зачепить відкриті; джоба забуде байти;
 * PATCH не скине `closed_at` при поверненні; межа «своє або адмін» відкриється.
 */
test("#497 ДИМ: зворотний звʼязок проти бази з нуля — варіант А, видалення через 30 днів, роути фото", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const filesDir = mkdtempSync(path.join(tmpdir(), "fb-files-"));
  process.env.DATABASE_URL = scratch.url;
  process.env.FEEDBACK_FILES_DIR = filesDir;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await c.query(schema);
    await c.query(`INSERT INTO users (id,email,password_hash,role,full_name) VALUES
        (1,'admin@uts.ua','x','admin','Адмін'), (4,'mgr@uts.ua','x','manager','Менеджер'), (5,'other@uts.ua','x','manager','Інший')`);

    // ── ВАРІАНТ А: стан проду ДО викату — закрите без closed_at, змінене 60 днів тому.
    await c.query(`INSERT INTO feedback (id, author_user_id, message, status, updated_at, closed_at) VALUES
        (100, 4, 'старе вирішене до викату', 'resolved', now() - interval '60 days', NULL)`);
    await c.query(schema); // повторне застосування = крок migrate на викаті
    const legacy = (await c.query(`SELECT closed_at > now() - interval '1 minute' AS fresh FROM feedback WHERE id = 100`)).rows[0];
    assert.equal(legacy.fresh, true, "🔴 варіант А: лічильник старого закритого стартував не з дня викату");

    await c.query(`INSERT INTO feedback (id, author_user_id, message, status, closed_at, created_at) VALUES
        (1, 4, 'закрите 31 день тому', 'resolved', now() - interval '31 days', now() - interval '40 days'),
        (2, 4, 'відхилене 31 день тому', 'rejected', now() - interval '31 days', now() - interval '40 days'),
        (3, 4, 'закрите 29 днів тому', 'resolved', now() - interval '29 days', now() - interval '40 days'),
        (4, 4, 'схвалене давно', 'approved', NULL, now() - interval '90 days'),
        (5, 4, 'на розгляді давно', 'pending', NULL, now() - interval '90 days')`);
    for (const [fid, fb] of [[1, 1], [2, 3], [3, 4]]) {
      writeFileSync(path.join(filesDir, `f${fid}.png`), PNG);
      await c.query(`INSERT INTO feedback_files (feedback_id, name, stored_name, mime, size_bytes, created_by)
                     VALUES ($1, 'shot.png', $2, 'image/png', 12, 4)`, [fb, `f${fid}.png`]);
    }

    const { purgeFeedback } = await import("../jobs/purgeFeedback.js");
    const r = await purgeFeedback(c as unknown as import("pg").PoolClient, filesDir);
    assert.deepEqual(r, { deleted: 2, files: 1, unlinkFailed: 0 }, "🔴 джоба видалила не рівно закрите понад 30 днів");
    const left = (await c.query(`SELECT id FROM feedback ORDER BY id`)).rows.map((x) => x.id);
    assert.deepEqual(left, [3, 4, 5, 100], "🔴 видалено не те: мали лишитись 29-денне, схвалене, на розгляді й старе до викату");
    assert.equal((await c.query(`SELECT count(*)::int n FROM feedback_files WHERE feedback_id = 1`)).rows[0].n, 0, "🔴 рядки фото пережили звернення");
    assert.equal(existsSync(path.join(filesDir, "f1.png")), false, "🔴 байти фото лишились на диску");
    assert.deepEqual(readdirSync(filesDir).sort(), ["f2.png", "f3.png"], "🔴 джоба зачепила байти звернень, що лишились");

    // ── Роути.
    const { feedbackRouter } = await import("./feedback.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
    const layers = (feedbackRouter as unknown as { stack: Layer[] }).stack.filter((l) => l.route);
    const AUTH: Record<string, unknown> = {
      admin: { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null },
      mgr: { userId: 4, role: "manager", roleKey: "manager", managerId: null, teamId: null },
      other: { userId: 5, role: "manager", roleKey: "manager", managerId: null, teamId: null },
    };
    async function call(method: string, p: string, o: { who?: string; params?: Record<string, string>; body?: unknown } = {}) {
      const layer = layers.find((l) => l.route!.path === p && l.route!.methods[method.toLowerCase()]);
      assert.ok(layer, `🔴 роут не знайдено: ${method} ${p}`);
      const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle as
        (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void>;
      const req = { auth: AUTH[o.who ?? "admin"], params: o.params ?? {}, body: o.body ?? {}, query: {}, headers: {} };
      let code = 200;
      let payload: unknown;
      const res = {
        headersSent: false,
        status(x: number) { code = x; return res; },
        json(b: unknown) { payload = b; return res; },
        send(b: unknown) { payload = b; return res; },
        type() { return res; },
        setHeader() { /* стрім не потрібен */ },
        sendFile(f: string, cb?: (e?: Error) => void) { payload = f; cb?.(); },
      };
      await handler(req, res, (e?: unknown) => { if (e) throw e; });
      return { code, payload: payload as Record<string, unknown> };
    }

    // PATCH: закриття ставить closed_at, повернення на розгляд — знімає.
    await call("PATCH", "/:id", { params: { id: "5" }, body: { status: "resolved" } });
    assert.ok((await c.query(`SELECT closed_at FROM feedback WHERE id = 5`)).rows[0].closed_at, "🔴 закриття не поставило closed_at");
    const list = await call("GET", "/", { who: "mgr" });
    const item5 = (list.payload.feedback as { id: number; purgeAt: string | null; files: unknown[] }[]).find((x) => x.id === 5)!;
    assert.ok(item5.purgeAt, "🔴 у видачі немає дати видалення закритого звернення");
    assert.ok(Array.isArray(item5.files), "🔴 у видачі немає переліку фото");
    await call("PATCH", "/:id", { params: { id: "5" }, body: { status: "pending" } });
    assert.equal((await c.query(`SELECT closed_at FROM feedback WHERE id = 5`)).rows[0].closed_at, null,
      "🔴 повернення на розгляд не зняло closed_at — відкрите звернення видалиться");

    const b64 = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
    const up = await call("POST", "/:id/files", { who: "mgr", params: { id: "4" }, body: { filename: "a.png", dataBase64: b64(PNG) } });
    assert.equal(up.code, 201, `🔴 PNG не прийнято: ${JSON.stringify(up.payload)}`);
    assert.equal((await call("POST", "/:id/files", { who: "mgr", params: { id: "4" }, body: { filename: "x.png", dataBase64: b64(Buffer.from("not an image at all")) } })).code, 400, "🔴 не-картинка прийнята");
    assert.equal((await call("POST", "/:id/files", { who: "mgr", params: { id: "4" }, body: { filename: "big.png", dataBase64: b64(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])) } })).code, 413, "🔴 понад 5 МБ прийнято");
    assert.equal((await call("POST", "/:id/files", { who: "other", params: { id: "4" }, body: { filename: "a.png", dataBase64: b64(PNG) } })).code, 404, "🔴 чуже звернення прийняло фото");
    for (let i = 0; i < 3; i++) await call("POST", "/:id/files", { who: "mgr", params: { id: "4" }, body: { filename: `p${i}.png`, dataBase64: b64(PNG) } });
    assert.equal((await call("POST", "/:id/files", { who: "mgr", params: { id: "4" }, body: { filename: "six.png", dataBase64: b64(PNG) } })).code, 409, "🔴 шосте фото прийнято");

    const fileId = String((up.payload as { id: number }).id);
    assert.equal((await call("GET", "/:id/files/:fileId", { who: "mgr", params: { id: "4", fileId } })).code, 200, "🔴 автор не бачить свого фото");
    assert.equal((await call("GET", "/:id/files/:fileId", { who: "admin", params: { id: "4", fileId } })).code, 200, "🔴 адмін не бачить фото звернення");
    assert.equal((await call("GET", "/:id/files/:fileId", { who: "other", params: { id: "4", fileId } })).code, 404, "🔴 чуже фото видно");
    assert.equal((await call("DELETE", "/:id/files/:fileId", { who: "other", params: { id: "4", fileId } })).code, 404, "🔴 чуже фото можна прибрати");
    assert.equal((await call("DELETE", "/:id/files/:fileId", { who: "mgr", params: { id: "4", fileId } })).code, 204, "🔴 автор не може прибрати своє фото");

    const { pool } = await import("../db/pool.js");
    await pool.end();
  } finally {
    await c.end();
    scratch.dispose();
    rmSync(filesDir, { recursive: true, force: true });
  }
});
