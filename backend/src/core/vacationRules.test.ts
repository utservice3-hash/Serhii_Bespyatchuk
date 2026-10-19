import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { vacationIssues, issueText, canApproveVacationRules, calendarDays, VACATION_MAX_DAYS, type VacationSpan } from "./vacationRules.js";

const span = (o: Partial<VacationSpan>): VacationSpan => ({ id: null, userId: null, managerId: null, teamId: 13,
  start: "2026-11-02", end: "2026-11-06", status: "approved", ...o });

/**
 * #1804 — П.5 РЕГЛАМЕНТУ «МЕНЕДЖЕР У ВІДПУСТЦІ» (5149): межі правила ПО ОБИДВА БОКИ.
 * 9 календарних днів — без КВП, 10 — з КВП; накладка на один день — порушення, сусідні дні — ні; відхилена відпустка,
 * інша команда, та сама людина (за будь-яким із двох ключів), сама відпустка й безкомандний акаунт — не накладка.
 * Червоніє, якщо зсунути межу днів, рахувати відхилені, порівнювати не по команді або «накладати» людину саму на себе.
 */
test("#1804 ВІДПУСТКА: довше 9 днів і накладка в команді — межі по обидва боки", () => {
  assert.equal(VACATION_MAX_DAYS, 9);
  assert.equal(calendarDays("2026-11-01", "2026-11-09"), 9);
  assert.deepEqual(vacationIssues(span({ start: "2026-11-01", end: "2026-11-09" }), []), [], "9 днів — у межах правила");
  assert.deepEqual(vacationIssues(span({ start: "2026-11-01", end: "2026-11-10" }), []), [{ kind: "long", days: 10 }], "10 днів не позначено");

  const cand = span({ userId: 8, managerId: 101 });
  const peer = (o: Partial<VacationSpan>) => span({ id: 50, userId: 9, managerId: 102, ownerName: "Колега", ...o });
  assert.equal(vacationIssues(cand, [peer({ start: "2026-11-06", end: "2026-11-10" })]).length, 1, "накладка на один день не спіймана");
  assert.equal(vacationIssues(cand, [peer({ start: "2026-11-07", end: "2026-11-10" })]).length, 0, "сусідні дні — не накладка");
  assert.equal(vacationIssues(cand, [peer({ start: "2026-10-30", end: "2026-11-01" })]).length, 0, "сусідні дні зліва — не накладка");
  assert.equal(vacationIssues(cand, [peer({ status: "pending" })]).length, 1, "відпустка на погодженні теж претендує на дати");
  assert.equal(vacationIssues(cand, [peer({ status: "rejected" })]).length, 0, "відхилена відпустка рахується накладкою");
  assert.equal(vacationIssues(cand, [peer({ teamId: 14 })]).length, 0, "інша команда рахується накладкою");
  assert.equal(vacationIssues(cand, [peer({ userId: 8, managerId: null })]).length, 0, "та сама людина (за акаунтом) накладена сама на себе");
  assert.equal(vacationIssues(cand, [peer({ userId: null, managerId: 101 })]).length, 0, "та сама людина (за менеджером) накладена сама на себе");
  assert.equal(vacationIssues(span({ id: 50, userId: 9, managerId: 102 }), [peer({})]).length, 0, "відпустка накладена сама на себе");
  assert.equal(vacationIssues(span({ teamId: null, userId: 8 }), [peer({ teamId: null })]).length, 0, "безкомандні акаунти — не одна команда");

  const ov = vacationIssues(cand, [peer({})])[0];
  assert.match(issueText(ov, true), /Колега у відпустці 02\.11–06\.11/);
  assert.doesNotMatch(issueText(ov, false), /Колега/, "менеджер бачить імʼя колеги, хоча календар колег йому закритий");
});

/**
 * #1804b — ХТО ПОГОДЖУЄ ПОРУШЕННЯ: КВП, Операційний директор і адмін (Роман 19.10.2026). Дзеркало: фінансист теж має
 * адмінський рівень (`admin_scope`), але відпусток із порушенням не погоджує; тімлід — тим паче.
 * Червоніє, якщо замінити явний перелік на `isAdminScope` або загубити ОД.
 */
test("#1804b ВІДПУСТКА: порушення погоджують КВП, ОД і адмін — не фінансист і не тімлід", () => {
  for (const k of ["kvp", "opdir", "admin"]) assert.equal(canApproveVacationRules(k), true, `${k} мусить погоджувати`);
  for (const k of ["financier", "ceo", "team_lead", "hr", "manager"]) assert.equal(canApproveVacationRules(k), false, `${k} не мусить погоджувати`);
});

/**
 * #1805 🪞 — НА ПОРОЖНЬОМУ КЛАСТЕРІ, ЧЕРЕЗ РОУТ: тімлід ставить 10-денну відпустку → 409 з причиною; з підтвердженням →
 * «на погодженні»; тімлід погодити не може (403), фінансист теж (403), КВП — так. Накладку погоджує ОД. Дзеркало:
 * звичайну відпустку тімлід ставить одразу погодженою, як і раніше. Відхилена відпустка накладки не дає. «Хто у
 * відпустці сьогодні» віддає погоджену з кінцем, а менеджер бачить лише себе.
 * Червоніє, якщо прибрати перевірку в постановці чи погодженні, або віддати `on-vacation` без роль-скоупу.
 */
test("#1805 🪞 ВІДПУСТКА ЧЕРЕЗ РОУТ: попередження, погоджує КВП / ОД, тімлід і фінансист — ні; хто у відпустці", async (t) => {
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
    await c.query(`INSERT INTO teams (id, name) VALUES (13, 'РНК - Тест'), (14, 'РПК - Тест') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id, is_active, kommo_user_id) VALUES
      (101, 'Перша', 13, true, '101'), (102, 'Друга', 13, true, '102'), (103, 'Третя', 13, true, '103'), (104, 'Інша команда', 14, true, '104')`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, role_override, manager_id, team_id) VALUES
      (2, 'kvp@t', 'x', 'manager', 'kvp', NULL, NULL), (3, 'od@t', 'x', 'manager', 'opdir', NULL, NULL),
      (4, 'fin@t', 'x', 'manager', 'financier', NULL, NULL), (7, 'tl@t', 'x', 'team_lead', NULL, NULL, 13),
      (8, 'm1@t', 'x', 'manager', NULL, 101, 13), (9, 'm2@t', 'x', 'manager', NULL, 102, 13),
      (10, 'm3@t', 'x', 'manager', NULL, 103, 13), (11, 'm4@t', 'x', 'manager', NULL, 104, 14)`);

    const { default: express } = await import("express");
    const { dutyRouter } = await import("../routes/duty.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    await refreshRoles();
    const app = express();
    app.use(express.json());
    app.use("/api/duty", dutyRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/duty`;
    const tok = (userId: number, role: string, roleKey: string, managerId: number | null, teamId: number | null) =>
      signToken({ userId, role, roleKey, managerId, teamId } as never);
    const KVP = tok(2, "admin", "kvp", null, null), OD = tok(3, "admin", "opdir", null, null), FIN = tok(4, "admin", "financier", null, null);
    const TL = tok(7, "team_lead", "team_lead", null, 13), M1 = tok(8, "manager", "manager", 101, 13);
    const call = async (who: string, method: string, p: string, body?: unknown) => {
      const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${who}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() as any };
    };
    const vac = (userId: number, startDate: string, endDate: string, confirmRules?: boolean) =>
      ({ userId, kind: "vacation", startDate, endDate, ...(confirmRules ? { confirmRules } : {}) });

    // Дзеркало: звичайна відпустка від тімліда — одразу погоджена, як і до 5149.
    const ok = await call(TL, "POST", "/absences", vac(8, "2026-11-02", "2026-11-06"));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "approved", "звичайну відпустку тімлід уже не ставить погодженою");

    // 10 днів: спершу 409 з причиною, з підтвердженням — «на погодженні», навіть від тімліда.
    const long = await call(TL, "POST", "/absences", vac(10, "2026-12-01", "2026-12-10"));
    assert.equal(long.status, 409, `довга відпустка пройшла без попередження: ${JSON.stringify(long.body)}`);
    assert.equal(long.body.needsConfirm, true);
    assert.match(long.body.issues.join(" "), /10 днів/);
    const longOk = await call(TL, "POST", "/absences", vac(10, "2026-12-01", "2026-12-10", true));
    assert.equal(longOk.body.status, "pending", "довгу відпустку тімлід поставив одразу погодженою");
    assert.equal((await call(TL, "POST", `/absences/${longOk.body.id}/approve`)).status, 403, "тімлід погодив відпустку з порушенням");
    assert.equal((await call(FIN, "POST", `/absences/${longOk.body.id}/approve`)).status, 403, "фінансист погодив відпустку з порушенням");
    const byKvp = await call(KVP, "POST", `/absences/${longOk.body.id}/approve`);
    assert.equal(byKvp.status, 200, `КВП не зміг погодити: ${JSON.stringify(byKvp.body)}`);

    // Накладка з погодженою відпусткою Першої (02–06.11): Друга з 05.11 → 409, далі погоджує ОД.
    const ov = await call(TL, "POST", "/absences", vac(9, "2026-11-05", "2026-11-09"));
    assert.equal(ov.status, 409, `накладка пройшла без попередження: ${JSON.stringify(ov.body)}`);
    assert.match(ov.body.issues.join(" "), /Перша у відпустці 02\.11–06\.11/);
    const ovOk = await call(TL, "POST", "/absences", vac(9, "2026-11-05", "2026-11-09", true));
    assert.equal(ovOk.body.status, "pending");
    const list = await call(TL, "GET", "/?from=2026-11-01&to=2026-11-30");
    const row = list.body.absences.find((a: { id: number }) => a.id === ovOk.body.id);
    assert.match((row?.rulesIssues ?? []).join(" "), /Перша/, "календар не каже, чому відпустка чекає КВП / ОД");
    assert.equal((await call(OD, "POST", `/absences/${ovOk.body.id}/approve`)).status, 200, "ОД не зміг погодити накладку");

    // Відхилена відпустка накладки не дає: Третя на ті самі дати, відпустку відхилено → Перша-2 не конфліктує з нею.
    const r3 = await call(TL, "POST", "/absences", vac(10, "2027-01-11", "2027-01-15"));
    assert.equal(r3.body.status, "approved");
    await call(KVP, "POST", `/absences/${r3.body.id}/reject`);
    const after = await call(TL, "POST", "/absences", vac(8, "2027-01-12", "2027-01-14"));
    assert.equal(after.status, 200, `відхилена відпустка дала накладку: ${JSON.stringify(after.body)}`);
    // Інша команда — не накладка.
    assert.equal((await call(KVP, "POST", "/absences", vac(11, "2026-11-03", "2026-11-04"))).status, 200, "інша команда дала накладку");

    // Хто у відпустці 04.11: Перша (до 06.11), Друга (05–09.11 ще не почалась), Інша команда (до 04.11).
    const onv = await call(KVP, "GET", "/on-vacation?date=2026-11-04");
    assert.equal(onv.status, 200);
    const byMgr = Object.fromEntries(onv.body.items.map((x: { managerId: number; until: string }) => [x.managerId, x.until]));
    assert.deepEqual(byMgr, { 101: "2026-11-06", 104: "2026-11-04" }, `не ті люди у відпустці: ${JSON.stringify(onv.body.items)}`);
    const own = await call(M1, "GET", "/on-vacation?date=2026-11-05");
    assert.deepEqual(own.body.items.map((x: { managerId: number }) => x.managerId), [101], "менеджер бачить відпустки колег, хоча календар їх йому не показує");
  } finally {
    if (server) await new Promise((r) => server!.close(r));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
  }
});

/**
 * #1806 — ОДНЕ ДЖЕРЕЛО ЗНАЧКА «У ВІДПУСТЦІ»: до `/duty/on-vacation` звертається лише `api.ts`, `fetchOnVacation` кличе
 * лише `VacationMark.tsx`, а кожен екран зі значком бере саме `VacationMark`. Множина файлів — від предмета (усі, хто
 * звертається до джерела), а не від слова в тілі. Червоніє, якщо екран заведе свій запит чи свою копію значка, або
 * значок зникне з одного з пʼяти місць.
 */
test("#1806 ВІДПУСТКА: значок з одного джерела — один запит, один компонент, пʼять екранів", () => {
  const FE = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src");
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p); } };
  walk(FE);
  assert.ok(files.length > 50, `фронт не знайдено (${String(files.length)} файлів) — гейт нічого не перевіряє`);
  const rel = (p: string) => path.relative(FE, p).split(path.sep).join("/");
  const src = new Map(files.map((p) => [rel(p), readFileSync(p, "utf8")]));
  const touching = [...src].filter(([, s]) => /["'`]\/duty\/on-vacation\b/.test(s)).map(([f]) => f);
  assert.deepEqual(touching, ["api.ts"], "до джерела відпусток звертається не лише api.ts");
  const callers = [...src].filter(([f, s]) => f !== "api.ts" && /fetchOnVacation\s*\(/.test(s)).map(([f]) => f);
  assert.deepEqual(callers, ["pages/dashboard/VacationMark.tsx"], "відпустки тягне ще хтось, окрім VacationMark");
  for (const f of ["ReportPlanSection", "ReportTableSection", "KvpTeamsWeekMonth", "MissedCallsTzBlocks", "ManagerReportSection"]) {
    assert.match(src.get(`pages/dashboard/sections/${f}.tsx`) ?? "", /<VacationMark\s+managerId=/, `${f}: значка «у відпустці» немає`);
  }
});
