import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { LOGIN_LOOKUP_SQL, loginEnabledFor, stateOf, type StateOverride } from "./managerState.js";

/**
 * 🚪 ЗВІЛЬНЕННЯ У ДВА КРОКИ + 📎 ДОКУМЕНТИ ЛЮДИНИ В HR (21.09.2026) — гейти `#620`–`#624`.
 * Номери з запасом над `#611b` (у main уже #610–#611b іншого проходу) — борг 17: перед мержем перемірити перетин.
 */

async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const hr = (await c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ('ivan@uts.ua','x','manager','hr','Іван') RETURNING id`)).rows[0].id as number;
  // Менеджер Kommo з акаунтом, бухгалтер без картки менеджера, людина без акаунта.
  await c.query(`INSERT INTO managers (id, name, kommo_user_id) VALUES (7, 'Шевчук Назар', 700)`);
  const mgrUser = (await c.query(`INSERT INTO users (email, password_hash, role, manager_id, full_name) VALUES ('nazar@uts.ua','x','manager',7,'Шевчук Назар') RETURNING id`)).rows[0].id as number;
  const accUser = (await c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ('buh@uts.ua','x','manager','financier','Бухгалтер Олена') RETURNING id`)).rows[0].id as number;
  const ins = async (name: string, key: string, userId: number | null, managerId: number | null) =>
    (await c.query(`INSERT INTO employees (full_name, import_key, user_id, manager_id, hired_at) VALUES ($1, $2, $3, $4, '2024-01-10') RETURNING id`, [name, key, userId, managerId])).rows[0].id as number;
  const eMgr = await ins("Шевчук Назар", "шевчук назар", mgrUser, 7);
  const eAcc = await ins("Бухгалтер Олена", "бухгалтер олена", accUser, null);
  const eNo = await ins("Без Акаунта", "без акаунта", null, null);
  const db = c as unknown as import("./secrets.js").Db;
  const off = await import("./offboarding.js");
  /** Чи пустить логін — той самий запит і те саме правило, що в `routes/auth.ts`. */
  const canLogin = async (email: string) => {
    const u = (await c.query(LOGIN_LOOKUP_SQL, [email])).rows[0];
    return u.is_active && loginEnabledFor(stateOf({ crmActive: u.is_active, override: u.work_state as StateOverride | null }));
  };
  return { c, db, hr, off, eMgr, eAcc, eNo, mgrUser, accUser, canLogin, done: async () => { await c.end(); s.dispose(); } };
}
const mws = async (s: NonNullable<Awaited<ReturnType<typeof scratch>>>) =>
  (await s.c.query(`SELECT state FROM manager_work_state WHERE manager_id = 7`)).rows[0]?.state ?? null;
const emp = async (s: NonNullable<Awaited<ReturnType<typeof scratch>>>, id: number) =>
  (await s.c.query(`SELECT status, dismissed_at::text AS d, dismiss_reason AS r FROM employees WHERE id = $1`, [id])).rows[0];

/**
 * #620 — ДВА КРОКИ: «Звільнити…» → реєстр «завершує», менеджер «завершує», вхід ПРАЦЮЄ; «Завершити звільнення»
 * → «звільнений», вхід ЗАКРИТО (менеджеру — станом, бухгалтеру без картки менеджера — `is_active`).
 * Крок 2 без кроку 1 — 409. 🧨 Червоніє, якщо крок 1 закриває вхід або крок 2 його не закриває.
 */
test("#620 ЖИВИЙ SQL: звільнення у два кроки — «завершує» лишає вхід, «завершити» закриває", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    const conflict = (e: unknown) => (e as { status?: number }).status === 409;
    await assert.rejects(s.off.finishDismissal(s.db, s.hr, s.eMgr), conflict, "🔴 крок 2 без кроку 1 прийнято");
    await s.off.startDismissal(s.db, s.hr, s.eMgr, { lastDay: "30.09.2026", reason: "власне бажання" });
    assert.deepEqual(await emp(s, s.eMgr), { status: "finishing", d: "2026-09-30", r: "власне бажання" });
    assert.equal(await mws(s), "finishing", "🔴 менеджер не став «завершує»");
    assert.equal(await s.canLogin("nazar@uts.ua"), true, "🔴 «завершує» закрило вхід — людина ще доводить угоди");
    await assert.rejects(s.off.startDismissal(s.db, s.hr, s.eMgr, { lastDay: "30.09.2026", reason: "ще раз" }), conflict, "🔴 крок 1 двічі");
    await s.off.finishDismissal(s.db, s.hr, s.eMgr);
    assert.equal((await emp(s, s.eMgr)).status, "dismissed");
    assert.equal(await mws(s), "dismissed", "🔴 менеджер не став «звільнений»");
    assert.equal(await s.canLogin("nazar@uts.ua"), false, "🔴 звільнений менеджер заходить");
    // Дзеркало: акаунт без картки менеджера закривається прапорцем, не станом.
    await s.off.startDismissal(s.db, s.hr, s.eAcc, { lastDay: "2026-09-25", reason: "переїзд" });
    assert.equal(await s.canLogin("buh@uts.ua"), true);
    const r = await s.off.finishDismissal(s.db, s.hr, s.eAcc);
    assert.equal(r.accountOff, true);
    assert.equal(await s.canLogin("buh@uts.ua"), false, "🔴 звільнений бухгалтер заходить");
    assert.equal(await s.canLogin("ivan@uts.ua"), true, "дзеркало: чужий вхід не зачеплено");
  } finally { await s.done(); }
});

/**
 * #621 — «ПОВЕРНУТИ» ДО БАЙТА: після обох кроків реєстр, стан менеджера (разом із тим, що стояв ДО) і акаунт
 * повертаються рівно такими, як були; записи сейфу й документи людини за весь час не зникають.
 * 🧨 Червоніє, якщо «Повернути» лишає стан менеджера чи вимкнений акаунт або звільнення щось видаляє.
 */
test("#621 ЖИВИЙ SQL: «Повернути» — реєстр, стан менеджера й акаунт до байта; сейф і документи не чіпаються", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    // Менеджер уже мав рядок стану (скажімо, «завершує» з Налаштувань) — його й має повернути.
    await s.c.query(`INSERT INTO manager_work_state (manager_id, state, since, note, set_by, set_at) VALUES (7, 'finishing', '2026-08-01T10:00:00+03', 'з налаштувань', $1, '2026-08-01T10:00:00+03')`, [s.hr]);
    await s.c.query(`INSERT INTO employee_secrets (user_id, kind, service, cipher, iv, tag, created_by) VALUES ($1, 'password', 'kommo', 'c', 'i', 't', $2)`, [s.accUser, s.hr]);
    await s.c.query(`INSERT INTO doc_files (name, stored_name, section, addressee_user_id, created_by) VALUES ('NDA.pdf', 'x.pdf', 'personal', $1, $2)`, [s.accUser, s.hr]);
    const snap = async () => JSON.stringify({
      e: (await s.c.query(`SELECT id, status, dismissed_at, dismiss_reason FROM employees ORDER BY id`)).rows,
      m: (await s.c.query(`SELECT * FROM manager_work_state ORDER BY manager_id`)).rows,
      u: (await s.c.query(`SELECT id, is_active, deactivated_at, deactivated_reason FROM users ORDER BY id`)).rows,
    });
    const count = async () => (await s.c.query(`SELECT (SELECT count(*) FROM employee_secrets)::int + (SELECT count(*) FROM doc_files WHERE deleted_at IS NULL)::int AS n`)).rows[0].n as number;
    const before = await snap(), kept = await count();
    for (const id of [s.eMgr, s.eAcc]) {
      await s.off.startDismissal(s.db, s.hr, id, { lastDay: "2026-09-30", reason: "скорочення" });
      await s.off.finishDismissal(s.db, s.hr, id);
    }
    assert.equal(await count(), kept, "🔴 звільнення видалило записи сейфу чи документи");
    assert.notEqual(await snap(), before, "дзеркало: звільнення взагалі щось змінило");
    for (const id of [s.eMgr, s.eAcc]) await s.off.revertDismissal(s.db, s.hr, id);
    assert.equal(await snap(), before, "🔴 «Повернути» не відновило стан до байта");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employee_offboarding`)).rows[0].n, 0);
    // Повернення з кроку 1 — теж до байта, і вдруге повертати нічого.
    await s.off.startDismissal(s.db, s.hr, s.eNo, { lastDay: "2026-09-30", reason: "x" });
    await s.off.revertDismissal(s.db, s.hr, s.eNo);
    assert.equal(await snap(), before, "🔴 повернення з «завершує» не до байта");
    await assert.rejects(s.off.revertDismissal(s.db, s.hr, s.eNo), (e: unknown) => (e as { status?: number }).status === 409);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM access_audit WHERE action LIKE 'employees.dismiss_%'`)).rows[0].n, 8, "🔴 кроки не записано в журнал (2×старт+2×завершити+2×повернути+старт+повернути)");
  } finally { await s.done(); }
});

/**
 * #622 — ЗАПОБІЖНИКИ: без дати чи причини — 400; себе не звільнити; під час звільнення форма не міняє статус
 * і дату (обійшла б стан менеджера); повторний імпорт таблиці не перемикає людину назад у «працює».
 * 🧨 Червоніє, якщо дозволити правку статусу формою під час звільнення або імпорт затре «завершує».
 */
test("#622 ЖИВИЙ SQL: під час звільнення форма й повторний імпорт не міняють статус; себе не звільнити", async (t) => {
  const s = await scratch(t); if (!s) return;
  const e = await import("./employees.js");
  try {
    const bad = (x: unknown) => (x as { status?: number }).status === 400;
    await assert.rejects(s.off.startDismissal(s.db, s.hr, s.eNo, { reason: "x" }), bad, "🔴 без дати прийнято");
    await assert.rejects(s.off.startDismissal(s.db, s.hr, s.eNo, { lastDay: "2026-09-30", reason: "  " }), bad, "🔴 без причини прийнято");
    await assert.rejects(s.off.startDismissal(s.db, s.mgrUser, s.eMgr, { lastDay: "2026-09-30", reason: "x" }), bad, "🔴 себе звільнив");
    await s.off.startDismissal(s.db, s.hr, s.eNo, { lastDay: "2026-09-30", reason: "x" });
    await assert.rejects(e.updateEmployee(s.db, s.hr, s.eNo, { status: "active" }), (x: unknown) => (x as { status?: number }).status === 409, "🔴 форма повернула статус в обхід кнопок");
    await assert.rejects(e.updateEmployee(s.db, s.hr, s.eNo, { dismissed_at: "2026-10-05" }), (x: unknown) => (x as { status?: number }).status === 409);
    assert.deepEqual((await e.updateEmployee(s.db, s.hr, s.eNo, { position: "логіст" })).changed, ["position"], "дзеркало: решта полів редагується");
    // Повторний імпорт: людина на аркуші «працюючі» з іншою датою звільнення.
    const csv = "ПІБ,Дата звільнення\nБез Акаунта,\n";
    await e.commitImport(s.db, randomBytes(32), s.hr, csv, ["full_name", "dismissed_at"], "active");
    assert.deepEqual(await emp(s, s.eNo), { status: "finishing", d: "2026-09-30", r: "x" }, "🔴 імпорт перемкнув людину, яку звільняють кнопками");
    // Дзеркало: без звільнення кнопками імпорт статус міняє, як і раніше.
    await e.commitImport(s.db, randomBytes(32), s.hr, "ПІБ,Дата звільнення\nБухгалтер Олена,01.09.2026\n", ["full_name", "dismissed_at"], "active");
    assert.equal((await emp(s, s.eAcc)).status, "dismissed");
  } finally { await s.done(); }
});

/**
 * #623 — ДОКУМЕНТИ ЛЮДИНИ: без акаунта документ належить людині (`employee_id`), з акаунтом — адресат-акаунт;
 * розділ завжди `personal` (офер без нагадувань); у картці видно й особисті документи акаунта з «Документів»;
 * чужий документ — 404; «прибрати» → не відкривається, у списку позначений; «повернути» → знову відкривається.
 * 🧨 Червоніє, якщо показати чужий документ, покласти офер у розділ `offer` або видаляти фізично.
 */
test("#623 ЖИВИЙ SQL: документи людини — власник, розділ, чужий 404, прибрати й повернути", async (t) => {
  const s = await scratch(t); if (!s) return;
  const d = await import("./employeeDocs.js");
  const dir = mkdtempSync(path.join(tmpdir(), "uts-empdoc-"));
  const store = async (display: string, buf: Buffer) => {
    const storedName = `${createHash("sha1").update(buf).update(display).digest("hex")}.pdf`;
    writeFileSync(path.join(dir, storedName), buf);
    return { storedName, sha256: createHash("sha256").update(buf).digest("hex") };
  };
  try {
    const nda = await d.attachEmployeeDoc(s.db, s.hr, s.eNo, { filename: "NDA Без Акаунта.pdf", mime: "application/pdf", kind: "NDA", buffer: Buffer.from("nda") }, store);
    const offer = await d.attachEmployeeDoc(s.db, s.hr, s.eAcc, { filename: "Офер.pdf", kind: "Офер", buffer: Buffer.from("offer") }, store);
    const row = async (id: number) => (await s.c.query(`SELECT section, category, description, addressee_user_id, employee_id FROM doc_files WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(await row(nda.id), { section: "personal", category: "Інше", description: "NDA", addressee_user_id: null, employee_id: s.eNo }, "🔴 документ людини без акаунта не на ній");
    assert.deepEqual(await row(offer.id), { section: "personal", category: "Офер", description: null, addressee_user_id: s.accUser, employee_id: s.eAcc }, "🔴 офер не в особистих або не адресату");
    // Особистий документ акаунта, завантажений через «Документи», — теж у картці; загальний — ні.
    const viaDocs = (await s.c.query(`INSERT INTO doc_files (name, stored_name, section, addressee_user_id, created_by) VALUES ('Наказ.pdf','n.pdf','personal',$1,$2) RETURNING id`, [s.accUser, s.hr])).rows[0].id;
    await s.c.query(`INSERT INTO doc_files (name, stored_name, section, created_by) VALUES ('Регламент.pdf','r.pdf','general',$1)`, [s.hr]);
    assert.deepEqual((await d.listEmployeeDocs(s.db, s.eAcc)).map((f) => f.id).sort(), [offer.id, viaDocs].sort(), "🔴 список картки не той");
    assert.deepEqual((await d.listEmployeeDocs(s.db, s.eNo)).map((f) => f.id), [nda.id]);
    const notFound = (e: unknown) => (e as { status?: number }).status === 404;
    await assert.rejects(d.employeeDoc(s.db, s.eAcc, nda.id), notFound, "🔴 чужий документ відкрився");
    await assert.rejects(d.attachEmployeeDoc(s.db, s.hr, s.eNo, { filename: "x", buffer: null }, store), (e: unknown) => (e as { status?: number }).status === 400);
    await d.setEmployeeDocDeleted(s.db, s.hr, s.eNo, nda.id, true);
    assert.ok((await d.employeeDoc(s.db, s.eNo, nda.id)).deleted_at, "🔴 не прибрано");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM doc_files WHERE id = $1`, [nda.id])).rows[0].n, 1, "🔴 документ видалено фізично");
    await d.setEmployeeDocDeleted(s.db, s.hr, s.eNo, nda.id, false);
    assert.equal((await d.employeeDoc(s.db, s.eNo, nda.id)).deleted_at, null, "🔴 «повернути» не повернуло");
  } finally { await s.done(); }
});

/**
 * #625 — ДОКУМЕНТИ В ТАБЛИЦІ РЕЄСТРУ: лічильник == довжині списку картки без прибраних; «NDA» і «офер» —
 * за типом (офер і з розділу «Офери»); файл із «nda» в назві, але іншого типу, NDA не вважається; прибраний
 * документ зникає з лічильника й прапорців. 🧨 Червоніє, якщо лічильник рахує інакше, ніж картка, або чужі.
 */
test("#625 ЖИВИЙ SQL: таблиця реєстру — лічильник документів і «є NDA / є офер» збігаються з карткою", async (t) => {
  const s = await scratch(t); if (!s) return;
  const d = await import("./employeeDocs.js");
  const e = await import("./employees.js");
  const dir = mkdtempSync(path.join(tmpdir(), "uts-empdoc-"));
  const store = async (display: string, buf: Buffer) => {
    const storedName = `${createHash("sha1").update(buf).update(display).digest("hex")}.pdf`;
    writeFileSync(path.join(dir, storedName), buf);
    return { storedName, sha256: createHash("sha256").update(buf).digest("hex") };
  };
  try {
    const nda = await d.attachEmployeeDoc(s.db, s.hr, s.eAcc, { filename: "NDA.pdf", kind: "NDA", buffer: Buffer.from("1") }, store);
    await d.attachEmployeeDoc(s.db, s.hr, s.eAcc, { filename: "Agenda-заява.pdf", kind: "Заява", buffer: Buffer.from("2") }, store);
    // Офер, сформований із шаблону, — розділ «Офери» на акаунт людини.
    await s.c.query(`INSERT INTO doc_files (name, stored_name, section, category, addressee_user_id, created_by) VALUES ('Офер.docx','o.docx','offer','Офер',$1,$2)`, [s.accUser, s.hr]);
    await d.attachEmployeeDoc(s.db, s.hr, s.eNo, { filename: "Договір.pdf", kind: "Договір", buffer: Buffer.from("3") }, store);
    const row = async (id: number) => (await e.listEmployees(s.db)).find((r) => r.id === id) as { docs: number; has_nda: boolean; has_offer: boolean };
    const live = async (id: number) => (await d.listEmployeeDocs(s.db, id)).filter((f) => !f.deleted_at).length;
    let a = await row(s.eAcc);
    assert.deepEqual([a.docs, a.has_nda, a.has_offer], [await live(s.eAcc), true, true], "🔴 таблиця розходиться з карткою");
    assert.equal(a.docs, 3);
    const n = await row(s.eNo);
    assert.deepEqual([n.docs, n.has_nda, n.has_offer], [1, false, false], "🔴 «nda» в назві чи чужий документ зарахувались");
    assert.deepEqual([(await row(s.eMgr)).docs, (await row(s.eMgr)).has_nda], [0, false], "дзеркало: у людини без документів — нуль");
    await d.setEmployeeDocDeleted(s.db, s.hr, s.eAcc, nda.id, true);
    a = await row(s.eAcc);
    assert.deepEqual([a.docs, a.has_nda], [2, false], "🔴 прибраний документ досі рахується");
  } finally { await s.done(); }
});

/**
 * #624 — `employee_offboarding` (причини звільнення, хто звільняв) відібрана в ai_readonly ПІСЛЯ створення
 * і є у FORBIDDEN_TABLES. 🧨 Червоніє, якщо прибрати REVOKE чи поставити його вище CREATE.
 */
test("#624 ЗВІЛЬНЕННЯ: employee_offboarding відібрана в ai_readonly і є в FORBIDDEN_TABLES", () => {
  const sql = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", "db", "schema.sql"), "utf8");
  assert.ok(sql.indexOf("REVOKE ALL ON employee_offboarding FROM ai_readonly;") > sql.indexOf("CREATE TABLE IF NOT EXISTS employee_offboarding ("), "🔴 REVOKE немає або вище за CREATE");
  assert.match(readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", "ai", "metricTools.ts"), "utf8"), /"employee_offboarding",/, "🔴 немає у FORBIDDEN_TABLES");
});
