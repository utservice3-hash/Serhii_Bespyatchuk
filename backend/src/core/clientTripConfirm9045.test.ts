import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  canConfirmTrip, cleanTripNote, tripDayError, reactInvoiceDate, TRIP_NOTE_MIN, TRIP_MAX_AGE_DAYS, TRIP_CLEARS_REACT,
} from "./clientTripConfirm.js";
import { lastOrderDate, colorOf, daysBetween } from "./clientLeadRules.js";
import { inReact } from "./reactCycleRules.js";
import { skipReason } from "../db/scratchDb.js";

/**
 * 🧾 «ПОЇЗДКА БУЛА (ПОЗА CRM)» (задача 9045; ТЗ Юлі 16.11.2026; Роман 18.11.2026 «роби»). Тімлід підтверджує поїздку,
 * якої немає в Kommo: дата + обовʼязковий коментар. Дата рахується замовленням для кольору й рахунком для циклу
 * реактивації (вимикач `TRIP_CLEARS_REACT`); у гроші не йде нічого.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * #9045 🪞 — ПОЇЗДКА = ЗАМОВЛЕННЯ ДЛЯ КОЛЬОРУ, У МЕЖАХ РИТМУ; РЕАКТИВАЦІЯ ЗА ВИМИКАЧЕМ; ДАТА Й КОМЕНТАР ПЕРЕВІРЕНІ.
 * Епізодичний (ритм 60 дн.) з оплатою 109 днів тому — жовтий; свіжа поїздка робить зеленим; поїздка 62 дні тому — знову
 * жовтий (жовтіє сам, як після звичайного замовлення); поїздка старша за оплату нічого не змінює.
 * 🧨 Червоніє, якщо `lastOrderDate` ігнорує третю дату, або поїздка «вічна», або вимикач перестане діяти.
 */
test("#9045 🪞 ПОЇЗДКА ПОЗА CRM: колір у межах ритму в обидва боки, реактивація, дата, коментар, роль", () => {
  const today = "2026-11-18", paid = "2026-08-01", inv = "2026-07-25";
  const color = (trip: string | null) => {
    const d = lastOrderDate(paid, inv, trip);
    return colorOf("episodic", d ? daysBetween(d, today) : null);
  };
  assert.equal(color(null), "yellow", "фікстура: без поїздки клієнт жовтий");
  assert.equal(color("2026-11-05"), "green", "🔴 свіжа підтверджена поїздка не зробила клієнта зеленим");
  assert.equal(color("2026-09-17"), "yellow", "🔴 поїздка поза ритмом (62 дн.) лишила клієнта зеленим — поїздка «вічна»");
  assert.equal(color("2026-09-20"), "green", "поїздка в межах ритму (59 дн.) — зелений");
  assert.equal(lastOrderDate(paid, inv, "2026-06-01"), paid, "🔴 давня поїздка перекрила свіжішу оплату");
  assert.equal(lastOrderDate(paid, inv), paid, "🔴 без поїздки дата замовлення змінилась");
  assert.equal(lastOrderDate(null, null, "2026-11-05"), "2026-11-05", "🔴 клієнт без замовлень у CRM не побачив поїздки");
  assert.equal(lastOrderDate("2026-08-01T10:00:00Z", "2026-07-25", null), paid, "дата з часом — по дню");

  // 🔁 Реактивація: рахунок 25.07 → у листопаді клієнт у вкладці; поїздка 05.11 знімає (вимикач), стара — ні.
  assert.equal(TRIP_CLEARS_REACT, true, "🔴 вимикач реактивації вимкнений без рішення");
  assert.equal(inReact(reactInvoiceDate(inv, null), "2026-11"), true, "фікстура: без поїздки клієнт у реактивації");
  assert.equal(inReact(reactInvoiceDate(inv, "2026-11-05"), "2026-11"), false, "🔴 підтверджена поїздка не зняла клієнта з реактивації");
  assert.equal(reactInvoiceDate("2026-10-01", "2026-06-01"), "2026-10-01", "🔴 давня поїздка перекрила свіжіший рахунок");
  assert.equal(reactInvoiceDate(null, "2026-11-05"), "2026-11-05");
  assert.equal(reactInvoiceDate("2026-10-01", null), "2026-10-01");

  // 📅 Дата: формат, справжній день, не в майбутньому, не старша за TRIP_MAX_AGE_DAYS — межа по обидва боки.
  assert.equal(tripDayError(today, today), null, "🔴 сьогоднішню поїздку не прийнято");
  assert.match(String(tripDayError("2026-11-19", today)), /майбутньому/, "🔴 прийнято поїздку з майбутнього");
  assert.equal(TRIP_MAX_AGE_DAYS, 180);
  assert.equal(tripDayError("2026-05-22", today), null, "🔴 поїздку рівно 180 днів тому не прийнято");
  assert.ok(tripDayError("2026-05-21", today), "🔴 прийнято поїздку 181 день тому");
  for (const bad of ["2026-02-30", "18.11.2026", "", null, 20261118, "2026-11-5"]) {
    assert.equal(tripDayError(bad, today), "Вкажіть дату поїздки", `🔴 прийнято дату ${String(bad)}`);
  }
  // 💬 Коментар: «№8996» уже досить, «ок» — ні.
  assert.equal(TRIP_NOTE_MIN, 5);
  assert.equal(cleanTripNote("  №8996 "), "№8996", "🔴 не прийнято коментар із номером рахунку");
  assert.equal(cleanTripNote("ок"), null, "🔴 прийнято порожній коментар");
  assert.equal(cleanTripNote(undefined), null);
  assert.equal(cleanTripNote("x".repeat(2000))?.length, 1000, "коментар обрізано до 1000");
  // 🔒 Роль: лише тімлід (ТЗ); керівництву — рішення Сергія.
  assert.equal(canConfirmTrip("team_lead"), true, "🔴 тімлід не може подати");
  for (const r of ["manager", "admin", "company", "kvp", "ceo", "opdir", "financier", "hr", "candidate"]) {
    assert.equal(canConfirmTrip(r), false, `🔴 подати може ${r}`);
  }
});

/**
 * #9045b — ПРОВОДКА: список, картка, нічний добір, роути (роль і межа ПЕРШИМИ), матриця, вкладка, фронт; у гроші — ніде.
 * 🧨 Червоніє, якщо поїздку перестане читати колір / «Проблемний» / цикл, роут перевірить тіло до доступу, або поїздка
 * зʼявиться в `core/money.ts`.
 */
test("#9045b ПРОВОДКА: колір, «Проблемний», цикл, нічний добір, роути, матриця, фронт; гроші не чіпає", () => {
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const plans = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'), dash.indexOf('dashboardRouter.post("/client-plans/submit"'));
  assert.match(plans, /const tripByKey = await clientTripConfirm\.tripsFor\(pool, clientKeys\);/, "🔴 список не читає підтверджень");
  assert.match(plans, /clientLeadRules\.lastOrderDate\(c\.last_paid, lastInvByKey\.get\(c\.client_key\) \?\? null, tripDayOf\(c\.client_key\)\)/,
    "🔴 колір / «днів тому» без поїздки");
  assert.equal((plans.match(/lastOrderDate\(/g) ?? []).length, 2, "🔴 у списку є виклик lastOrderDate без поїздки");
  assert.match(plans, /reactCycleRules\.inReact\(reactInv\(key\), nowYm\)/, "🔴 вкладка «Реактивація» без поїздки");
  assert.match(plans, /reactCycle\.cycleView\(reactInv\(c\.client_key\)/, "🔴 вигляд циклу без поїздки");
  assert.match(plans, /trip: tripByKey\.get\(c\.client_key\) \?\? null,/, "🔴 рядок не віддає підтвердження");
  assert.match(plans, /canConfirmTrip: clientTripConfirm\.canConfirmTrip\(auth\.role\),/, "🔴 право не віддається фронту");
  const card = dash.slice(dash.indexOf('dashboardRouter.get("/client-card"'));
  assert.match(card, /lastOrderDate\(h\?\.last_paid \?\? null, cardLastInv, cardTripDay\)/, "🔴 картка: «Проблемний» без поїздки");
  assert.match(card, /reactCycleRules\.inReact\(cardReactInv,/, "🔴 картка: цикл без поїздки");
  const sweep = codeOnly(read("backend/src/jobs/reactCycleSweep.ts"));
  assert.match(sweep, /lastInvoice: reactInvoiceDate\(inv\.get\(r\.client_key\) \?\? null, trips\.get\(r\.client_key\)\?\.day \?\? null\)/,
    "🔴 нічний добір реактивації без поїздки — клієнт пішов би лідгенам");

  for (const p of ["/client-trip-confirm", "/client-trip-confirm/clear"]) {
    const i = dash.indexOf(`dashboardRouter.post("${p}"`);
    assert.ok(i > 0, `🔴 роуту ${p} немає`);
    const body = dash.slice(i, dash.indexOf("dashboardRouter.", i + 10));
    const first = body.split("\n").slice(1).map((x) => x.trim()).filter((x) => x && !x.startsWith("const auth") && !x.startsWith("const clientKey"))[0];
    assert.match(first, /^if \(!clientTripConfirm\.canConfirmTrip\(auth\.role\) \|\| !clientKey \|\| !\(await canSeeClient\(auth, clientKey\)\)\) \{$/,
      `🔴 ${p}: роль і межа — не перший оператор (403 = гейт, не валідація)`);
  }
  const post = dash.slice(dash.indexOf('dashboardRouter.post("/client-trip-confirm"'));
  const iD = post.indexOf("tripDayError("), iN = post.indexOf("cleanTripNote("), iW = post.indexOf("clientTripConfirm.confirmTrip(");
  assert.ok(iD > 0 && iN > iD && iW > iN, "🔴 дата й коментар не перевірені до запису");

  const mx = read("backend/src/auth/accessMatrix.ts");
  for (const p of ["/api/dashboard/client-trip-confirm", "/api/dashboard/client-trip-confirm/clear"]) {
    assert.match(mx, new RegExp(`path: "${p.replace(/\//g, "\\/")}", cls: "deny-only",\\n\\s*allow: \\[\\], deny: \\["hr", "manager"\\] \\}`),
      `🔴 ${p}: немає в матриці або deny не той`);
  }
  assert.match(read("backend/src/auth/routeTab.ts"), /pre\("\/api\/dashboard\/client-trip-confirm"\), tabs: \["loyalty"\]/, "🔴 роут без вкладки");

  // 💰 Гроші рахує лише ядро — і поїздки там немає.
  for (const f of ["backend/src/core/money.ts", "backend/src/core/metrics.ts"]) {
    assert.doesNotMatch(read(f), /client_trip_confirms|clientTripConfirm/, `🔴 поїздка поза CRM потрапила в гроші (${f})`);
  }

  const fe = codeOnly(read("frontend/src/pages/dashboard/sections/ClientLeadSection.tsx"));
  assert.match(fe, /<TripBox row=\{c\} canConfirm=\{data\.canConfirmTrip === true\} onDone=\{load\} \/>/, "🔴 на «З ким говорити» немає кнопки / позначки");
  assert.match(fe, /confirmClientTrip\(row\.clientKey, day, note\)/, "🔴 «Подати» не шле дату й коментар");
  assert.match(fe, /clearClientTrip\(row\.clientKey\)/, "🔴 немає «зняти»");
});

/**
 * #9045c 🪞 — ЖИВИЙ: роути на справжній схемі. Тімлід своєї команди — 200 (дзеркало); чужої — 403; менеджер і адмін — 403;
 * без коментаря / з майбутньою датою — 400; запис із автором, коментар у коментарях клієнта; гроші клієнта до і після —
 * байт у байт; CHECK не пускає порожній коментар; «зняти» лишає рядок в історії, повторне — 409.
 * 🧨 Червоніє, якщо SQL зламається на справжній БД, межа пропустить чужого, або поїздка підмішається в гроші.
 */
test("#9045c 🪞 ЖИВИЙ «ПОЇЗДКА ПОЗА CRM»: права з дзеркалом, валідація, запис, гроші без змін, зняття", async (t) => {
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
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК-1'),(2,'РПК-2') ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage) VALUES (8921932,142,'paid') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'Менеджер',1,true),(20,'Яцик',1,true),(21,'Інший тімлід',2,true) ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,is_active) VALUES
      (1,'m@x','x','manager',10,true),(2,'l@x','x','team_lead',20,true),(3,'o@x','x','team_lead',21,true),(4,'a@x','x','admin',null,true)`);
    for (const [id, ago] of [[1, "100 days"], [2, "140 days"]] as const) {
      await c.query(`INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,created_at_kommo,closed_at_kommo)
                     VALUES ($1,'ЕЙДІВІПІ',10,8921932,142,1000,'ейдівіпі','ейдівіпі','ЕЙДІВІПІ', now() - interval '${ago}' - interval '5 days', now() - interval '${ago}')`, [id]);
    }
    const { dashboardRouter } = await import("../routes/dashboard.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const route = (p: string) => (dashboardRouter as any).stack.find((l: any) => l.route?.path === p && l.route.methods.post);
    type U = { id: number; role: string; managerId: number | null; teamId: number | null };
    const call = async (p: string, u: U, body: Record<string, unknown>) => {
      let status = 200, json: Record<string, unknown> = {};
      const res = { status(x: number) { status = x; return res; }, json(b: Record<string, unknown>) { json = b; return res; }, setHeader() {} };
      const req = { auth: { userId: u.id, role: u.role, roleKey: u.role, managerId: u.managerId, teamId: u.teamId }, body };
      for (const l of route(p).route.stack) await l.handle(req, res, () => {});
      return { status, json };
    };
    const manager: U = { id: 1, role: "manager", managerId: 10, teamId: 1 };
    const lead: U = { id: 2, role: "team_lead", managerId: 20, teamId: 1 };
    const otherLead: U = { id: 3, role: "team_lead", managerId: 21, teamId: 2 };
    const admin: U = { id: 4, role: "admin", managerId: null, teamId: null };
    const { kyivToday } = await import("./dates.js");
    const today = kyivToday();
    const body = { clientKey: "ейдівіпі", day: today, note: "рахунок №8996, готівка" };

    const M = await import("./money.js");
    const scope = { from: "2026-01-01", to: "2027-12-31" };
    const money = async () => JSON.stringify([await M.fromInvoiceByClientKey(scope), await M.successByClientKey(scope), await M.receivedByClientKey(scope),
      [...(await M.lastInvoiceByClientKey(["ейдівіпі"])).entries()]]);
    const before = await money();

    assert.equal((await call("/client-trip-confirm", otherLead, body)).status, 403, "🔴 тімлід чужої команди подав поїздку");
    assert.equal((await call("/client-trip-confirm", manager, body)).status, 403, "🔴 менеджер подав поїздку");
    assert.equal((await call("/client-trip-confirm", admin, body)).status, 403, "🔴 адмін подав поїздку (доступ керівництву — рішення Сергія)");
    assert.equal((await call("/client-trip-confirm", lead, { ...body, note: "ок" })).status, 400, "🔴 прийнято поїздку без коментаря");
    assert.equal((await call("/client-trip-confirm", lead, { ...body, day: "2099-01-01" })).status, 400, "🔴 прийнято поїздку з майбутнього");
    assert.equal((await call("/client-trip-confirm/clear", lead, { clientKey: "ейдівіпі" })).status, 409, "🔴 зняття без підтвердження — не 409");
    const ok = await call("/client-trip-confirm", lead, body);
    assert.equal(ok.status, 200, `🔴 тімлід своєї команди не зміг подати: ${String(ok.json.error ?? "")}`);

    const T = await import("./clientTripConfirm.js");
    const { pool } = await import("../db/pool.js");
    const tr = (await T.tripsFor(pool, ["ейдівіпі", "нікого"]));
    assert.deepEqual(tr.get("ейдівіпі") && { day: tr.get("ейдівіпі")!.day, note: tr.get("ейдівіпі")!.note, byName: tr.get("ейдівіпі")!.byName, at: tr.get("ейдівіпі")!.at },
      { day: today, note: body.note, byName: "Яцик", at: today }, "🔴 підтвердження не з тією датою / коментарем / автором");
    assert.equal(tr.has("нікого"), false, "🔴 підтвердження в клієнта, якому не подавали");
    const cm = (await c.query<{ body: string }>(`SELECT body FROM client_comments WHERE client_key = 'ейдівіпі'`)).rows.map((x) => x.body);
    assert.deepEqual(cm, [`🧾 Поїздка поза CRM ${today.split("-").reverse().join(".")}: ${body.note}`], "🔴 коментар не ліг у коментарі клієнта");
    assert.equal(await money(), before, "🔴 поїздка поза CRM змінила гроші клієнта");
    await assert.rejects(c.query(`INSERT INTO client_trip_confirms (client_key, trip_day, note, created_by) VALUES ('x', now()::date, '  ', 2)`),
      /client_trip_confirms_note_chk/, "🔴 БД пустила підтвердження без коментаря");

    assert.equal((await call("/client-trip-confirm/clear", otherLead, { clientKey: "ейдівіпі" })).status, 403, "🔴 тімлід чужої команди зняв підтвердження");
    assert.equal((await call("/client-trip-confirm/clear", lead, { clientKey: "ейдівіпі" })).status, 200);
    assert.equal((await T.tripsFor(pool, ["ейдівіпі"])).has("ейдівіпі"), false, "🔴 зняте підтвердження далі діє");
    const hist = (await c.query<{ n: string; by: number }>(`SELECT COUNT(*) AS n, MAX(revoked_by) AS by FROM client_trip_confirms WHERE revoked_at IS NOT NULL`)).rows[0];
    assert.deepEqual([Number(hist.n), Number(hist.by)], [1, 2], "🔴 «зняти» не лишило рядок в історії з автором");
    assert.equal((await call("/client-trip-confirm/clear", lead, { clientKey: "ейдівіпі" })).status, 409, "🔴 повторне зняття — не 409");
    await pool.end().catch(() => {});
  } finally {
    await c.end();
    scratch.dispose();
  }
});
