import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { problemActive, cleanProblemNote, PROBLEM_REASONS, PROBLEM_REASON_KEYS, PROBLEM_NOTE_MIN, problemLabel } from "./problemClient.js";
import { workFlags } from "./repeatScreenRules.js";
import { skipReason } from "../db/scratchDb.js";

/**
 * ⚠️ «ПРОБЛЕМНИЙ КЛІЄНТ» (задача 8350; ТЗ Юлі 06.11 зі слів Віки; макет погоджено, Роман 11.11.2026 «викочуй»).
 * Позначка з причиною й обовʼязковим коментарем: клієнт видно окремою групою, але не в «Немає роботи», «Без задачі»,
 * «передати», сплячих і реактивації; позначка перестає діяти сама, щойно клієнт знову замовить.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SECTIONS = "frontend/src/pages/dashboard/sections";
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * #3811 🪞 — ПОЗНАЧКА ДІЄ ДО ЗАМОВЛЕННЯ ПІСЛЯ НЕЇ; ПРИЧИНИ ЗІ СЛОВНИКА == CHECK; КОМЕНТАР ОБОВʼЯЗКОВИЙ.
 * Замовлення того ж дня (до позначки) не знімає; наступного дня — знімає; без замовлень — діє.
 * 🧨 Червоніє, якщо позначку знімуть старі замовлення (тоді вона не діятиме ніколи), або словник і CHECK розійдуться.
 */
test("#3811 🪞 ПРОБЛЕМНИЙ: діє до замовлення ПІСЛЯ позначки; причини == CHECK; коментар обовʼязковий", () => {
  assert.equal(problemActive("2026-11-11", null), true, "🔴 без замовлень позначка не діє");
  assert.equal(problemActive("2026-11-11", "2026-10-02"), true, "🔴 старе замовлення зняло позначку");
  assert.equal(problemActive("2026-11-11", "2026-11-11"), true, "🔴 замовлення того ж дня (до конфлікту) зняло позначку");
  assert.equal(problemActive("2026-11-11", "2026-11-12"), false, "🔴 клієнт знову замовив, а позначка діє");
  assert.equal(problemActive("2026-11-11", "2026-11-12T08:00:00Z"), false, "дата з часом — по дню");
  assert.deepEqual(PROBLEM_REASONS.map((r) => r.label), ["Конфлікт", "Контакт втрачено", "Відмовився працювати", "Інше"], "🔴 причини не з ТЗ");
  assert.equal(problemLabel("conflict"), "Конфлікт");
  const schema = read("backend/src/db/schema.sql");
  const m = /loyalty_overrides_problem_chk[\s\S]*?problem_reason IN \(([^)]*)\)/.exec(schema);
  assert.ok(m, "🔴 CHECK причин «Проблемний» не знайдено");
  assert.deepEqual([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), [...PROBLEM_REASON_KEYS], "🔴 CHECK у БД і словник причин розійшлися");
  assert.equal(cleanProblemNote("x".repeat(PROBLEM_NOTE_MIN - 1)), null, "🔴 прийнято закороткий коментар");
  assert.equal(cleanProblemNote(`  ${"x".repeat(PROBLEM_NOTE_MIN)} `), "x".repeat(PROBLEM_NOTE_MIN));
  assert.equal(cleanProblemNote(null), null);
});

/**
 * #3812 🪞 — «НЕМАЄ РОБОТИ» І «БЕЗ ЗАДАЧІ» НЕ ГОРЯТЬ НА ПРОБЛЕМНОМУ, і лише на ньому. Той самий клієнт без роботи й задачі:
 * з позначкою — обидва `false`; без — обидва `true` (дзеркало: правило 8333 не зачеплене).
 * 🧨 Червоніє, якщо позначку перестане бачити `workFlags` або вона почне гасити прапорці всім.
 */
test("#3812 🪞 «НЕМАЄ РОБОТИ» / «БЕЗ ЗАДАЧІ»: проблемний — ні; той самий без позначки — так", () => {
  const base = { works: false, stepOpen: false, stepDue: null, taskOpen: false, taskDue: null, today: "2026-11-11" };
  assert.deepEqual(workFlags({ ...base, problem: true }), { noWork: false, noTask: false, overdue: false }, "🔴 проблемний горить «Немає роботи» / «Без задачі»");
  assert.deepEqual(workFlags(base), { noWork: true, noTask: true, overdue: false }, "🔴 позначка погасила прапорці звичайному клієнту");
  assert.deepEqual(workFlags({ ...base, problem: false }), workFlags(base));
});

/**
 * #3813 — ПРОВОДКА: діюча позначка (до замовлення після неї) прибирає клієнта з реактивації, «передати» й прапорців
 * роботи і їде в рядок `lead.problem`; роути — межа `canSeeClient` ПЕРШОЮ, причина й коментар ДО запису; картка — стан і
 * право; матриця й вкладка; фронт — блок у картці, група «⚠️ Проблемні» на обох екранах і поза кольоровими лічильниками;
 * старий підпис 6455 над «В роботі» прибрано.
 * 🧨 Червоніє, якщо будь-яка ланка випаде — тоді проблемний знову сплячий, у реактивації або в «Немає роботи».
 */
test("#3813 ПРОВОДКА: список, реактивація, «передати», прапорці, роути, картка, матриця, фронт", () => {
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const plans = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'));
  assert.match(plans, /problemClient\.problemActive\(m\.day, clientLeadRules\.lastOrderDate\(c\.last_paid, lastInvByKey\.get\(c\.client_key\) \?\? null\)\)/,
    "🔴 позначка діє без огляду на замовлення після неї");
  assert.match(plans, /const inReactNow = \(key: string\) => !factsFor\(seg, key\)\.offSeason && !activeProblem\.has\(key\)/, "🔴 проблемний у реактивації");
  assert.match(plans, /handOver: !activeProblem\.has\(c\.client_key\) && clientLeadRules\.handOverDue\(/, "🔴 проблемного пропонують «передати іншому»");
  assert.match(plans, /problem: activeProblem\.get\(c\.client_key\) \?\? null,/, "🔴 позначка не доходить до рядка");
  assert.match(plans, /problem: activeProblem\.has\(c\.client_key\),\s*\}\),/, "🔴 «Немає роботи» не знає про позначку");
  for (const r of ['dashboardRouter.post("/client-problem"', 'dashboardRouter.post("/client-problem/clear"']) {
    const body = dash.slice(dash.indexOf(r));
    assert.match(body, /^dashboardRouter\.post\("[^"]+", async \(req, res\) => \{\s*const auth = req\.auth!;\s*const clientKey = [^\n]+\n\s*if \(!clientKey \|\| !\(await canSeeClient\(auth, clientKey\)\)\) return res\.status\(403\)/,
      `🔴 ${r}: межа не першою дією`);
  }
  const mark = dash.slice(dash.indexOf('dashboardRouter.post("/client-problem"'), dash.indexOf('dashboardRouter.post("/client-problem/clear"'));
  const iR = mark.indexOf("PROBLEM_REASON_KEYS.includes(reason)"), iN = mark.indexOf("cleanProblemNote("), iW = mark.indexOf("problemClient.markProblem(");
  assert.ok(iR > 0 && iN > iR && iW > iN, "🔴 причина й коментар не перевірені до запису");
  const card = dash.slice(dash.indexOf('dashboardRouter.get("/client-card"'));
  assert.match(card, /problem: problemOn \? problemMark : null,/, "🔴 картка показує недіючу позначку");
  assert.match(card, /canProblem: true,/);
  const mx = read("backend/src/auth/accessMatrix.ts");
  for (const p of ["/api/dashboard/client-problem", "/api/dashboard/client-problem/clear"]) assert.match(mx, new RegExp(`path: "${p.replace(/\//g, "\\/")}", cls: "deny-only"`), `🔴 ${p} немає в матриці`);
  assert.match(read("backend/src/auth/routeTab.ts"), /pre\("\/api\/dashboard\/client-problem"\), tabs: \["loyalty"\]/, "🔴 роут без вкладки");
  assert.match(codeOnly(read(`${SECTIONS}/ClientCardPanel.tsx`)), /<ClientProblemBlock card=\{card\}/, "🔴 у картці немає блоку «Проблемний»");
  const lead = codeOnly(read(`${SECTIONS}/ClientLeadSection.tsx`));
  assert.match(lead, /if \(r\.lead\.problem\) \{ s\.problem\+\+; continue; \}/, "🔴 проблемні рахуються в кольорах / «передати» / «працюють»");
  assert.match(lead, /\["yellow", "red", "problem", "green"\]/, "🔴 на «З ким говорити» немає групи «Проблемні»");
  const pl = codeOnly(read(`${SECTIONS}/ClientPlansSection.tsx`));
  assert.match(pl, /const problemRows = sorted\.filter\(\(c\) => !c\.work\.noWork && c\.lead\.problem\);/, "🔴 на «Плані місяця» немає групи «Проблемні»");
  assert.match(pl, /const workRows = sorted\.filter\(\(c\) => !c\.work\.noWork && !c\.lead\.problem\);/, "🔴 проблемні в групі «В роботі»");
  assert.doesNotMatch(pl, /є угода з рахунком \(або в роботі після рахунку\) чи оплата/, "🔴 над «В роботі» лишився підпис скасованого правила 6455");
});

/**
 * #3814 🪞 — ЖИВИЙ: роути на справжній схемі. Чужий менеджер — 403; причина не зі словника — 400; короткий коментар —
 * 400; позначка лягла з причиною, автором і коментарем у коментарях клієнта; CHECK не пускає позначку без коментаря чи з
 * чужою причиною; «зняти» знімає всі чотири поля, повторне — 409.
 * 🧨 Червоніє, якщо SQL позначки зламається на справжній БД або межа пропустить чужого.
 */
test("#3814 🪞 ЖИВИЙ «ПРОБЛЕМНИЙ»: права, причина, коментар, запис, CHECK, зняття", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  try {
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК') ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage) VALUES (8921932,142,'paid') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'Свій',1,true),(11,'Чужий',1,true) ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,is_active) VALUES (1,'m@x','x','manager',10,true),(2,'n@x','x','manager',11,true)`);
    for (const [id, ago] of [[1, "40 days"], [2, "80 days"]] as const) {
      await c.query(`INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,created_at_kommo,closed_at_kommo)
                     VALUES ($1,'Інтеграл',10,8921932,142,1000,'інтеграл','інтеграл','Інтеграл', now() - interval '${ago}' - interval '5 days', now() - interval '${ago}')`, [id]);
    }
    const { dashboardRouter } = await import("../routes/dashboard.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const route = (p: string) => (dashboardRouter as any).stack.find((l: any) => l.route?.path === p && l.route.methods.post);
    const call = async (p: string, user: { id: number; managerId: number }, body: Record<string, unknown>) => {
      let status = 200, json: Record<string, unknown> = {};
      const res = { status(x: number) { status = x; return res; }, json(b: Record<string, unknown>) { json = b; return res; }, setHeader() {} };
      const req = { auth: { userId: user.id, role: "manager", roleKey: "manager", managerId: user.managerId, teamId: 1 }, body };
      for (const l of route(p).route.stack) await l.handle(req, res, () => {});
      return { status, json };
    };
    const own = { id: 1, managerId: 10 }, other = { id: 2, managerId: 11 };
    const note = "кидають трубку після конфлікту по оплаті";
    assert.equal((await call("/client-problem", other, { clientKey: "інтеграл", reason: "conflict", note })).status, 403, "🔴 чужий менеджер позначив клієнта");
    assert.equal((await call("/client-problem", own, { clientKey: "інтеграл", reason: "price", note })).status, 400, "🔴 прийнято причину не зі словника");
    assert.equal((await call("/client-problem", own, { clientKey: "інтеграл", reason: "conflict", note: "ой" })).status, 400, "🔴 прийнято закороткий коментар");
    const ok = await call("/client-problem", own, { clientKey: "інтеграл", reason: "conflict", note });
    assert.equal(ok.status, 200, `🔴 позначка не лягла: ${String(ok.json.error ?? "")}`);
    const P = await import("./problemClient.js");
    const { pool } = await import("../db/pool.js");
    const m = (await P.problemsFor(pool, ["інтеграл"])).get("інтеграл");
    assert.deepEqual(m && { reason: m.reason, label: m.label, note: m.note, byName: m.byName }, { reason: "conflict", label: "Конфлікт", note, byName: "Свій" },
      "🔴 позначка не з тією причиною / коментарем / автором");
    const cm = (await c.query<{ body: string }>(`SELECT body FROM client_comments WHERE client_key = 'інтеграл'`)).rows.map((x) => x.body);
    assert.deepEqual(cm, [`⚠️ Проблемний клієнт — Конфлікт: ${note}`], "🔴 причина не лягла в коментарі клієнта");
    await assert.rejects(c.query(`UPDATE loyalty_overrides SET problem_note = ' ' WHERE client_key = 'інтеграл'`), /loyalty_overrides_problem_chk/, "🔴 БД пустила позначку без коментаря");
    await assert.rejects(c.query(`UPDATE loyalty_overrides SET problem_reason = 'price' WHERE client_key = 'інтеграл'`), /loyalty_overrides_problem_chk/, "🔴 БД пустила чужу причину");
    assert.equal((await call("/client-problem/clear", own, { clientKey: "інтеграл" })).status, 200);
    const left = (await c.query<{ a: boolean }>(`SELECT (problem_at IS NULL AND problem_by IS NULL AND problem_reason IS NULL AND problem_note IS NULL) AS a FROM loyalty_overrides WHERE client_key = 'інтеграл'`)).rows[0];
    assert.equal(left.a, true, "🔴 «зняти» лишило частину полів");
    assert.equal((await call("/client-problem/clear", own, { clientKey: "інтеграл" })).status, 409, "🔴 повторне зняття — не 409");
    await pool.end().catch(() => {});
  } finally {
    await c.end();
    scratch.dispose();
  }
});
