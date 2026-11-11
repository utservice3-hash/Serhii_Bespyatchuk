import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { DEFAULT_LIMIT_EDITOR_IDS, cpApproverIds, cpLimitEditorIds, cpRoleOf } from "./roles.js";
import { editsLimits, limitActions, type AnyRow } from "./shared/clientLimits.js";

/**
 * ✍️ ХТО ЗМІНЮЄ «ЛІМІТИ КЛІЄНТІВ» (Сергій 11.11.2026). Роман: «Сергій, коли давав це ДЗ, написав, що тільки він може змінювати
 * ліміти». Сергій: «може робити Дар'я, додати у вкладку Ліміти клієнтів — історію змін». Окремий файл, бо наскрізний `#3830`
 * піднімає свою scratch-БД, а пул `db/pool.js` — один на процес (так само, як `addClient.test.ts`).
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");

/**
 * #3833 — СПИСОК «ХТО ЗМІНЮЄ ЛІМІТИ» ОКРЕМИЙ ВІД ПОГОДЖУВАЧІВ. За замовчуванням — Дарʼя (users.id 52); `.env` замінює список.
 * Дарʼя як адмін лишається для «Узгодження» переглядачем: список погоджувачів її не містить, тобто контрагентів вона не погоджує
 * (цього не просили). Права в інтерфейсі — ті самі, що в Сергія, лише коли сервер поставив `limitEditor`; переглядач без нього
 * не має жодної дії. 🧨 Червоніє, якщо Дарʼю прибрати зі списку, покласти її в погоджувачі або відкрити дії всім переглядачам.
 */
test("#3833 ХТО ЗМІНЮЄ ЛІМІТИ: Дарʼя за замовчуванням, .env замінює; погоджувачем не стає; дії — лише з limitEditor", () => {
  assert.deepEqual(DEFAULT_LIMIT_EDITOR_IDS, ["52"], "Дарʼї (users.id 52) немає серед тих, хто змінює ліміти");
  assert.deepEqual(cpLimitEditorIds(undefined), ["52"]);
  assert.deepEqual(cpLimitEditorIds(""), ["52"], "порожній рядок у .env забрав право в Дарʼї");
  assert.deepEqual(cpLimitEditorIds(" 52, 77 "), ["52", "77"]);
  const saved = { cp: process.env.CP_APPROVER_IDS, minus: process.env.MINUS_APPROVER_IDS };
  delete process.env.CP_APPROVER_IDS; delete process.env.MINUS_APPROVER_IDS;
  try {
    assert.deepEqual(cpApproverIds(), ["1"], "погоджувачі змінились разом зі списком лімітів");
    assert.equal(cpRoleOf({ userId: 52, roleKey: "admin" }, cpApproverIds()), "viewer", "Дарʼя стала погоджувачем «Узгодження»");
    assert.equal(cpRoleOf({ userId: 1, roleKey: "opdir" }, cpApproverIds()), "approver");
  } finally {
    if (saved.cp === undefined) delete process.env.CP_APPROVER_IDS; else process.env.CP_APPROVER_IDS = saved.cp;
    if (saved.minus === undefined) delete process.env.MINUS_APPROVER_IDS; else process.env.MINUS_APPROVER_IDS = saved.minus;
  }
  const lim = { src: "set", managerId: "2", suspended: false } as unknown as AnyRow;
  const susp = { src: "set", managerId: "2", suspended: true, flag: { at: "", what: "" } } as unknown as AnyRow;
  const none = { src: "none", managerId: "2" } as unknown as AnyRow;
  const darya = { id: "52", name: "Дарʼя", role: "viewer" as const, limitEditor: true };
  const viewer = { id: "5", name: "Інший адмін", role: "viewer" as const };
  assert.ok(editsLimits(darya) && editsLimits({ id: "1", name: "Сергій", role: "approver" }));
  assert.ok(!editsLimits(viewer), "переглядач без limitEditor змінює ліміти");
  assert.deepEqual([limitActions(darya, lim), limitActions(darya, susp), limitActions(darya, none)], [["edit"], ["keep", "edit"], ["set"]]);
  assert.deepEqual([limitActions(viewer, lim), limitActions(viewer, susp), limitActions(viewer, none)], [[], [], []], "переглядач отримав дії");
  // сервер ставить прапорець лише тим, хто бачить ліміти, і не погоджувачу (той і так змінює)
  assert.match(SRC("counterparty/server/routes/clientLimits.ts"),
    /if \(u\.role !== 'approver' && seesRequests\(u\.role\) && \(opts\.limitEditorIds\?\.\(\) \?\? \[\]\)\.includes\(u\.id\)\) u\.limitEditor = true;/);
  assert.match(SRC("counterparty/mount.ts"), /limitEditorIds: cpLimitEditorIds,/, "роутер лімітів не отримує список тих, хто змінює");
});

/**
 * #3830 — 🪞 ДАРʼЯ ЗМІНЮЄ ЛІМІТИ НАСКРІЗНО через наш вхід (scratch-БД). Дарʼя (users.id 52, роль «адмін»): олівці в колонці
 * дебіторки; задає ліміт боржнику, змінює його, лишає після нової справи, шукає й додає клієнта з бази — кожна дія з її імʼям в
 * історії. Імпорт — лише Сергій. ДЗЕРКАЛО: інший адмін і менеджер на тих самих діях — 403 і без олівців; Сергій — як і був.
 * 🧨 Червоніє, якщо Дарʼю прибрати зі списку (усі її дії → 403), якщо дати дії всім адмінам (інший адмін → 200) або якщо
 * подія піде без її імені.
 */
test("#3830 🪞 ДАРʼЯ ЗМІНЮЄ ЛІМІТИ НАСКРІЗНО: задати, змінити, лишити, додати з бази — з її іменем; інший адмін і менеджер — 403", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  delete process.env.MINUS_APPROVER_IDS; delete process.env.CP_APPROVER_IDS; delete process.env.CP_LIMIT_EDITOR_IDS;
  delete process.env.YOUCONTROL_API_KEY; delete process.env.YOUSCORE_API_KEY;
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  let server: import("node:http").Server | null = null;
  try {
    await c.query(SRC("db/schema.sql"));
    await c.query(`INSERT INTO teams (id, name) VALUES (1, 'Команда Ірини') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id) VALUES (10, 'Марина Коваль', 1)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, role_override, full_name, is_active, manager_id) VALUES
      (1, 'utservice3@gmail.com', 'x', 'admin', 'opdir', 'Сергій', true, NULL),
      (52, 'darya@t', 'x', 'admin', 'admin', 'Дарʼя Протас', true, NULL),
      (5, 'admin2@t', 'x', 'admin', NULL, 'Інший адмін', true, NULL),
      (2, 'marina@t', 'x', 'manager', NULL, 'Марина Коваль', true, 10)`);
    await c.query(`INSERT INTO receivables (client_key, client_name, manager_id, amount, overdue_days) VALUES ('k-rivne', 'ТОВ Рівне Агро', 10, 120000, 5)`);
    await c.query(`INSERT INTO receivable_invoices (client_key, client_name, manager_id, invoice_no, invoice_date, amount, edrpou) VALUES
      ('k-rivne', 'ТОВ Рівне Агро', 10, 'R-1', CURRENT_DATE - 5, 120000, '41234567')`);
    await c.query(`INSERT INTO deals (kommo_id, client_key, client_name, manager_id, created_at_kommo) VALUES (201, 'юмо', 'ЮМО ТОВ', 10, '2026-07-01')`);

    await import("../lib/asyncRoutes.js");
    const { default: express } = await import("express");
    const { buildClientLimitsRouter } = await import("./mount.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    await refreshRoles();
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/client-limits", buildClientLimitsRouter());
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/client-limits`;
    const TOK: Record<string, string> = {
      serhii: signToken({ userId: 1, role: "admin", roleKey: "opdir", managerId: null, teamId: null } as never),
      darya: signToken({ userId: 52, role: "admin", roleKey: "admin", managerId: null, teamId: null } as never),
      admin2: signToken({ userId: 5, role: "admin", roleKey: "admin", managerId: null, teamId: null } as never),
      marina: signToken({ userId: 2, role: "manager", roleKey: "manager", managerId: 10, teamId: 1 } as never),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (who: string, method: string, p: string, body?: unknown): Promise<{ s: number; j: any }> => {
      const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOK[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      let j: unknown = null; try { j = await r.json(); } catch { /* порожньо */ }
      return { s: r.status, j };
    };
    const body = { limit: 100000, days: 10, from: "inv", reason: "погодили з клієнтом" };
    const byOf = async (limitId: string, type: string) =>
      (await c.query(`SELECT by_id, by_name, note FROM client_limit_events WHERE limit_id = $1 AND type = $2 ORDER BY id DESC LIMIT 1`, [limitId, type])).rows[0];

    // ---------- олівці ----------
    for (const [who, can] of [["darya", true], ["serhii", true], ["admin2", false], ["marina", false]] as const) {
      const r = await call(who, "GET", "/by-debtor");
      assert.equal(r.s, 200, `${who}: ${JSON.stringify(r.j)}`);
      assert.equal(r.j.canEdit, can, `${who}: олівці ${can ? "не показано" : "показано"}`);
    }
    assert.equal((await call("darya", "GET", "")).j.me.limitEditor, true, "сервер не позначив Дарʼю тією, хто змінює ліміти");
    assert.ok(!(await call("admin2", "GET", "")).j.me.limitEditor, "іншого адміна позначено тим, хто змінює ліміти");

    // ---------- задати ліміт боржнику ----------
    for (const who of ["admin2", "marina"]) assert.equal((await call(who, "POST", "/set", { ...body, debtorKey: "k-rivne" })).s, 403, `${who} задає ліміт`);
    let r = await call("darya", "POST", "/set", { ...body, debtorKey: "k-rivne" });
    assert.equal(r.s, 201, JSON.stringify(r.j));
    const id = String(r.j.id);
    assert.deepEqual(await byOf(id, "limitSet"), { by_id: "52", by_name: "Дарʼя Протас", note: "100 000 грн, 10 днів від дати рахунку\nПричина: погодили з клієнтом" },
      "у історії не Дарʼя або не те, що вона задала");

    // ---------- змінити ----------
    for (const who of ["admin2", "marina"]) assert.equal((await call(who, "POST", `/${id}/edit`, { ...body, limit: 150000 })).s, 403, `${who} змінює ліміт`);
    r = await call("darya", "POST", `/${id}/edit`, { ...body, limit: 150000, days: 14, reason: "обсяги зросли" });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.deepEqual([r.j.limit, r.j.days], [150000, 14]);
    const ch = await byOf(id, "limitChanged");
    assert.deepEqual([ch.by_id, ch.by_name], ["52", "Дарʼя Протас"]);
    assert.match(ch.note, /^100 000 грн, 10 днів від дати рахунку → 150 000 грн, 14 днів від дати рахунку\nПричина: обсяги зросли$/, "немає «було → стало» або причини");

    // ---------- лишити після нової справи ----------
    await c.query(`UPDATE client_limits SET flag = '{"at":"2026-11-10T00:00:00Z","what":"Справа 910/1/26","kind":"court"}' WHERE id = $1`, [id]);
    assert.equal((await call("admin2", "POST", `/${id}/keep`, {})).s, 403, "інший адмін лишає ліміт");
    r = await call("darya", "POST", `/${id}/keep`, {});
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.equal((await byOf(id, "kept")).by_id, "52");

    // ---------- клієнт із бази ----------
    assert.equal((await call("admin2", "GET", "/search?q=юмо")).s, 403, "інший адмін шукає по базі");
    r = await call("darya", "GET", "/search?q=юмо");
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.hits.map((h: { key: string }) => h.key), ["юмо"]);
    assert.equal((await call("admin2", "POST", "/add", { ...body, clientKey: "юмо" })).s, 403, "інший адмін додає клієнта");
    r = await call("darya", "POST", "/add", { ...body, clientKey: "юмо" });
    assert.equal(r.s, 201, JSON.stringify(r.j));
    assert.equal((await byOf(String(r.j.id), "limitSet")).by_name, "Дарʼя Протас");

    // ---------- імпорт — лише Сергій ----------
    assert.equal((await call("darya", "POST", "/import", { rows: [] })).s, 403, "Дарʼя імпортує ліміти — цього не просили");
    assert.equal((await call("serhii", "POST", "/import", { rows: [] })).s, 200, "Сергій втратив імпорт");
    // Сергій — як і був
    assert.equal((await call("serhii", "POST", `/${id}/edit`, { ...body, limit: 160000, reason: "Сергій" })).s, 200, "Сергій більше не змінює ліміти");
  } finally {
    await new Promise((res) => (server ? server.close(() => res(null)) : res(null)));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
