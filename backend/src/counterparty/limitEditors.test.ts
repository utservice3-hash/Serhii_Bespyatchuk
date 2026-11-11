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
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

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
    await c.query(`INSERT INTO managers (id, name, team_id) VALUES (10, 'Марина Коваль', 1), (11, 'Олег Ткачук', 1)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, role_override, full_name, is_active, manager_id) VALUES
      (1, 'utservice3@gmail.com', 'x', 'admin', 'opdir', 'Сергій', true, NULL),
      (52, 'darya@t', 'x', 'admin', 'admin', 'Дарʼя Протас', true, NULL),
      (5, 'admin2@t', 'x', 'admin', NULL, 'Інший адмін', true, NULL),
      (2, 'marina@t', 'x', 'manager', NULL, 'Марина Коваль', true, 10), (3, 'oleh@t', 'x', 'manager', NULL, 'Олег Ткачук', true, 11),
      (4, 'hr@t', 'x', 'manager', 'hr', 'HR', true, NULL)`);
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
      hr: signToken({ userId: 4, role: "company", roleKey: "hr", managerId: null, teamId: null } as never),
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

    /**
     * #3831 — 🪞 «ІСТОРІЯ ЗМІН» (Сергій 11.11.2026: «додати у вкладку Ліміти клієнтів — історію змін»). Події всіх лімітів
     * свіжими першими: хто (Дарʼя / Сергій), «було → стало» з причиною; автоматична подія — без імені; знятий ліміт лишається в
     * історії. Менеджер бачить події лише своїх клієнтів (тих самих, що в списку), HR — 403. 🧨 Червоніє, якщо віддати
     * менеджеру всі події, загубити автоматичні чи знятий ліміт, переставити порядок або втратити імʼя.
     */
    await t.test("#3831 🪞 ІСТОРІЯ ЗМІН: усі події всіх лімітів свіжими першими — хто, «було → стало», автоматичні без імені, знятий ліміт лишається; менеджер — лише свої", async () => {
      const yumo = (await c.query(`SELECT id::text FROM client_limits WHERE debtor_key = 'юмо'`)).rows[0].id;
      await c.query(`UPDATE client_limits SET active = false WHERE id = $1`, [yumo]);
      await c.query(`INSERT INTO client_limits (src, debtor_key, name, limit_sum, days, manager_id, manager_name) VALUES ('set', 'k-oleh', 'ТОВ Олегів', 50000, 7, '3', 'Олег Ткачук')`);
      const oleh = (await c.query(`SELECT id::text FROM client_limits WHERE debtor_key = 'k-oleh'`)).rows[0].id;
      await c.query(`INSERT INTO client_limit_events (limit_id, type, by_id, by_name, note, at) VALUES ($1, 'planned', NULL, NULL, 'Планова перевірка: змін немає', now() + interval '1 minute')`, [oleh]);
      let h = await call("serhii", "GET", "/history");
      assert.equal(h.s, 200, JSON.stringify(h.j));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev: any[] = h.j.events;
      assert.deepEqual(ev.map((e) => e.at), [...ev.map((e) => e.at)].sort().reverse(), "не свіжі першими");
      assert.deepEqual([ev[0].limitId, ev[0].type, ev[0].by, ev[0].byName, ev[0].managerId], [oleh, "planned", null, null, "3"], "автоматична подія з імʼям або не першою");
      const mine = ev.filter((e) => e.limitId === id);
      assert.deepEqual(mine.map((e) => [e.type, e.byName]), [
        ["limitChanged", "Сергій"], ["kept", "Дарʼя Протас"], ["limitChanged", "Дарʼя Протас"], ["limitSet", "Дарʼя Протас"],
      ], "історія ліміту не та або без імен");
      assert.match(mine[2].note, /→ 150 000 грн, 14 днів від дати рахунку\nПричина: обсяги зросли/, "немає «було → стало»");
      assert.deepEqual([mine[0].name, mine[0].code, mine[0].managerName], ["ТОВ Рівне Агро", "41234567", "Марина Коваль"]);
      const gone = ev.filter((e) => e.limitId === yumo);
      assert.ok(gone.length === 1 && gone[0].active === false, "знятий ліміт зник з історії або позначений діючим");
      // менеджер — лише свої; HR — немає доступу; інший адмін бачить усе
      h = await call("marina", "GET", "/history");
      assert.equal(h.s, 200);
      assert.ok(h.j.events.length > 0 && h.j.events.every((e: { managerId: string }) => e.managerId === "2"), "менеджер бачить події чужих клієнтів");
      assert.ok(h.j.events.some((e: { limitId: string }) => e.limitId === id), "менеджер не бачить подій свого клієнта");
      assert.equal((await call("admin2", "GET", "/history")).j.events.length, ev.length, "інший адмін бачить не все");
      assert.equal((await call("hr", "GET", "/history")).s, 403, "HR бачить історію лімітів");
    });
  } finally {
    await new Promise((res) => (server ? server.close(() => res(null)) : res(null)));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

/**
 * #3834 ФРОНТ ІСТОРІЯ ЗМІН — ФРОНТ «ІСТОРІЇ ЗМІН»: кнопка «Історія змін» перемикає вкладку на другий вигляд (і назад), дані — через
 * наш api (`/client-limits/history`), у рядку — хто змінив або «автоматично» і текст «було → стало»; фільтр «Усі / Зміни людей /
 * Автоматичні»; після власної дії історія перечитується (інакше Дарʼя не побачила б щойно зробленого). 🧨 Червоніє на кожному
 * з цих відступів.
 */
test("#3834 ФРОНТ ІСТОРІЯ ЗМІН: другий вигляд вкладки через наш api, хто / «автоматично», фільтр ручні-автоматичні, свіжа після власної дії", () => {
  const f = FRONT("minusRegistry/client/clientLimits/limits.ts");
  assert.match(FRONT("minusRegistry/client/counterparty/api.ts"), /history: \(\) => call\(api\.get\(`\$\{CL\}\/history`\)\),/, "історія не через наш api");
  assert.match(f, /id="\$\{P\}vbtn" data-view aria-pressed="false">Історія змін<\/button>/, "немає кнопки «Історія змін»");
  assert.match(f, /view = view === 'hist' \? 'list' : 'hist'; render\(\); if \(view === 'hist'\) void loadHist\(\);/, "перемикач не вантажить свіжу історію");
  assert.match(f, /if \(view === 'hist'\) \{ renderHist\(\); return; \}/);
  const r = f.slice(f.indexOf("function renderHist()"), f.indexOf("async function loadHist()"));
  assert.ok(r.length > 300, "renderHist не знайдено — гейт нічого не перевіряє");
  assert.match(r, /e\.by \? `<div class="cp-mgr">\$\{esc\(e\.byName \|\| '—'\)\}<\/div>` : '<span class="cp-sub">автоматично<\/span>'/, "не видно, хто змінив");
  assert.match(r, /e\.note \? `<div class="cp-hnote">\$\{esc\(e\.note\)\}<\/div>`/, "не видно, що змінилось");
  assert.match(r, /hist\.filter\(e => histIn\(e, histKind\)/, "фільтр ручні / автоматичні не застосовується");
  assert.match(f, /replace\(r\); afterId\?\.\(r\); histStale\(\);/, "після зміни ліміту історія не оновлюється");
  assert.match(f, /replace\(r\); showFresh\(r\.id\); openPanel\(r\.id\); histStale\(\);/, "після «＋ Додати клієнта» історія не оновлюється");
});
