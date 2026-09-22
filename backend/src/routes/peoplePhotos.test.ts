import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #630 — ФОТО СПІВРОБІТНИКА ПРОТИ БАЗИ З НУЛЯ, ЧЕРЕЗ СПРАВЖНІЙ HTTP (22.09.2026). Роутер разом із
 * `requireAuth` і `requirePerm` — не лише останній обробник, бо межа запису стоїть саме в мідлварі.
 * Перевіряє по обидва боки кожної межі:
 *  · HR завантажує → будь-хто залогінений (менеджер) отримує ТІ САМІ байти; без токена — 401;
 *  · тімлід і менеджер НЕ пишуть і НЕ бачать списку (403), HR і адмін — пишуть і бачать;
 *  · «Замінити» → «Повернути попереднє» віддає старі байти; «Прибрати» → 404 → «Повернути» — знову ті самі;
 *  · не-фото (PDF) — 400, звільненому — 400 на завантаження;
 *  · файл лежить у КОРЕНІ теки документів (під нічним бекапом), з префіксом `photo-`, і жоден не видаляється;
 *  · `managerPhotos`: привʼязаний із фото — у мапі, без фото чи без звʼязку — ні.
 */
test("#630 ДИМ: фото — HR завантажує, усі бачать, тімлід не пише; кожна дія скасовна", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const docs = mkdtempSync(path.join(tmpdir(), "photo-docs-"));
  process.env.DATABASE_URL = scratch.url;
  process.env.DOCS_DIR = docs;
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
    await c.query(`INSERT INTO managers (id, name, team_id) VALUES (101, 'Фото Менеджер', 13), (102, 'Без Фото', 13), (103, 'Без Звʼязку', 13)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, full_name) VALUES
      (1, 'admin@uts.ua', 'x', 'admin', 'Адмін'), (5, 'hr@uts.ua', 'x', 'manager', 'Даша')`);
    await c.query(`INSERT INTO employees (id, full_name, import_key, manager_id, status) VALUES
      (11, 'Фото Менеджер', 'k11', 101, 'active'), (12, 'Без Фото', 'k12', 102, 'active'), (13, 'Звільнений Тест', 'k13', NULL, 'dismissed')`);

    const { default: express } = await import("express");
    const { peopleRouter } = await import("./people.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    await refreshRoles();
    const app = express();
    app.use(express.json({ limit: "20mb" }));
    app.use("/api/people", peopleRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/people`;
    const TOK: Record<string, string> = {
      admin: signToken({ userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null } as never),
      hr: signToken({ userId: 5, role: "manager", roleKey: "hr", managerId: null, teamId: null } as never),
      lead: signToken({ userId: 3, role: "team_lead", roleKey: "team_lead", managerId: 103, teamId: 13 } as never),
      manager: signToken({ userId: 4, role: "manager", roleKey: "manager", managerId: 102, teamId: 13 } as never),
    };
    const req = async (method: string, p: string, who: string | null, body?: unknown) => {
      const r = await fetch(base + p, { method, headers: { ...(who ? { authorization: `Bearer ${TOK[who]}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, buf, json: () => JSON.parse(buf.toString("utf8")) };
    };
    const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
    const A = jpeg("фото-A"), B = jpeg("фото-B");
    const up = (who: string, id: number, buf: Buffer) => req("POST", `/photo/${id}`, who, { dataBase64: `data:image/jpeg;base64,${buf.toString("base64")}` });

    // Межі запису й списку: заборона ↔ дозвіл.
    for (const who of ["lead", "manager"]) {
      assert.equal((await up(who, 11, A)).status, 403, `🔴 ${who} завантажив фото`);
      assert.equal((await req("DELETE", "/photo/11", who)).status, 403, `🔴 ${who} прибрав фото`);
      assert.equal((await req("POST", "/photo/11/restore", who)).status, 403, `🔴 ${who} повернув фото`);
      assert.equal((await req("GET", "/photos", who)).status, 403, `🔴 ${who} бачить список реєстру`);
    }
    assert.equal((await req("GET", "/photo/11", null)).status, 401, "🔴 фото віддається без входу");
    assert.equal((await req("GET", "/photo/11", "manager")).status, 404, "до завантаження фото немає — 404, а не порожні 200");

    assert.equal((await up("hr", 11, A)).status, 201, "🔴 HR не може завантажити фото");
    const gotA = await req("GET", "/photo/11", "manager");
    assert.equal(gotA.status, 200, "🔴 менеджер не бачить фото");
    assert.deepEqual(gotA.buf, A, "🔴 віддано не ті байти, що завантажено");
    assert.equal((await req("GET", "/photo/11", "lead")).status, 200, "🔴 тімлід не бачить фото");

    // Заміна → повернення попереднього → ті самі байти A; ще раз — знову B.
    assert.equal((await up("admin", 11, B)).status, 201, "🔴 адмін не може замінити фото");
    assert.deepEqual((await req("GET", "/photo/11", "manager")).buf, B);
    type Row = { employeeId: number; hasPhoto: boolean; hasPrev: boolean; updatedBy: string | null; updatedAt: string | null };
    const row = async (id: number) => ((await req("GET", "/photos", "hr")).json().people as Row[]).find((x) => x.employeeId === id)!;
    const afterReplace = await row(11);
    assert.deepEqual([afterReplace.hasPhoto, afterReplace.hasPrev, afterReplace.updatedBy], [true, true, "Адмін"], "🔴 після заміни список не каже, що є попереднє і хто замінив");
    assert.equal((await req("POST", "/photo/11/restore", "hr")).status, 200);
    assert.deepEqual((await req("GET", "/photo/11", "manager")).buf, A, "🔴 «Повернути попереднє» не повернуло старе фото");
    // Прибрати → 404 → повернути → A.
    assert.equal((await req("DELETE", "/photo/11", "hr")).status, 200);
    assert.equal((await req("GET", "/photo/11", "manager")).status, 404, "🔴 прибране фото досі показується");
    assert.equal((await req("POST", "/photo/11/restore", "hr")).status, 200);
    assert.deepEqual((await req("GET", "/photo/11", "manager")).buf, A, "🔴 прибране фото не повертається");

    // Не-фото і звільнений.
    const pdf = await req("POST", "/photo/12", "hr", { dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") });
    assert.equal(pdf.status, 400, "🔴 PDF прийнято як фото");
    assert.equal((await up("hr", 13, A)).status, 400, "🔴 звільненому завантажено фото");
    assert.equal((await up("hr", 999, A)).status, 404, "🔴 фото для неіснуючої людини");
    assert.equal((await req("GET", "/photo/abc", "manager")).status, 400);

    // Файли — у корені теки документів, з префіксом, жоден не видалено (A, B — обидва на місці).
    const files = readdirSync(docs);
    assert.ok(files.length >= 2 && files.every((f) => /^photo-[0-9a-f-]{36}\.jpg$/.test(f)), `🔴 файли фото не в корені або не того виду: ${files.join(", ")}`);
    assert.equal(files.length, 2, "🔴 зайвий файл: відхилене завантаження лишило слід на диску, або файл видалено");

    // Список для HR: хто з фото, з підписом «хто і коли». «Попереднє» — на один крок: після
    // «Прибрати → Повернути» попереднім було саме прибране фото, і воно вже повернулось.
    const p11 = await row(11);
    assert.deepEqual([p11.hasPhoto, p11.hasPrev, p11.updatedBy], [true, false, "Даша"], "🔴 список не каже, що фото є і хто його поставив");
    assert.match(p11.updatedAt ?? "", /^\d{2}\.\d{2}\.\d{4}$/);
    assert.equal((await row(12)).hasPhoto, false);

    // managerPhotos: лише привʼязані з фото.
    const { managerPhotos } = await import("../core/people.js");
    const mp = await managerPhotos();
    assert.deepEqual(Object.keys(mp), ["101"], "🔴 у мапі фото не рівно привʼязаний менеджер із фото");
    assert.equal(mp["101"].id, 11);
    assert.deepEqual(await managerPhotos([102, 103]), {}, "🔴 фото з'явилось у менеджера без фото / без звʼязку");
  } finally {
    if (server) await new Promise((r) => server!.close(r));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
