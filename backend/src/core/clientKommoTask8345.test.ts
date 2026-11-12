import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import {
  pickOpenDeal, pickOwner, dueUnix, leadBody, taskBody, closeTaskBody, REACT_PIPELINE_ID, REACT_STATUS_ID, PUSH_PER_RUN,
} from "./clientKommoTaskRules.js";
import { OPERATIONAL_STATUSES } from "./moneyBuckets.js";
import { stageName } from "./stageNames.js";
import { MONITORED_JOBS } from "../jobs/monitoredJobs.js";
import type { KommoTaskDeps, KommoLeadLite } from "./clientKommoTask.js";

/**
 * 📌 ЗАДАЧА КЛІЄНТУ → УГОДА І ЗАДАЧА В KOMMO (задача 8345, рішення Юлі 12.11.2026).
 *
 * Найдорожча помилка тут — НЕ «задача не дійшла» (це видно в картці), а ЗАЙВА угода в Kommo: друга на клієнта з
 * відкритою угодою, друга після збою посеред запису, угода на звільненого. Тому гейти стоять на цих трьох місцях,
 * і живий гейт рахує ВИКЛИКИ запису в Kommo, а не лише кінцевий стан рядка.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

test("#3906 🪞 ВІДКРИТА УГОДА: є — задача в неї (найновішу); усі закриті або видалені — нова; відповідальний — з картки, звільнений — ні", () => {
  assert.equal(pickOpenDeal([{ id: 1, statusId: 142, createdAt: 50 }, { id: 2, statusId: 69693668, createdAt: 10 }, { id: 3, statusId: 69693672, createdAt: 20 }]), 3,
    "🔴 з кількох відкритих узято не найновішу");
  assert.equal(pickOpenDeal([{ id: 1, statusId: 142, createdAt: 50 }, { id: 2, statusId: 143, createdAt: 60 }]), null, "🔴 закрита угода прийнята за відкриту");
  assert.equal(pickOpenDeal([{ id: 4, statusId: 69693668, createdAt: 5, deleted: true }]), null, "🔴 видалена угода прийнята за відкриту");
  assert.equal(pickOpenDeal([]), null);
  const card = { managerId: 1, kommoUserId: 111, active: true }, author = { managerId: 2, kommoUserId: 222, active: true };
  assert.deepEqual(pickOwner(card, author), { ok: true, kommoUserId: 111, from: "card" }, "🔴 відповідальний — не менеджер картки клієнта");
  assert.deepEqual(pickOwner({ ...card, active: false }, author), { ok: true, kommoUserId: 222, from: "author" }, "🔴 задача впала на звільненого менеджера клієнта");
  assert.deepEqual(pickOwner(null, author), { ok: true, kommoUserId: 222, from: "author" });
  assert.equal(pickOwner({ ...card, kommoUserId: null }, { ...author, active: false }).ok, false, "🔴 відповідального вигадано, коли не годиться ні картка, ні автор");
});

test("#3907 🪞 ТІЛА ЗАПИТІВ: угода — на етапі «Клієнти та реактивація» з контактом; строк — дата о 18:00 Києва, без дати — наступний робочий день", () => {
  const lead = leadBody({ clientName: "ТОВ Ромашка", clientKey: "ромашка", kommoUserId: 111, contactIds: [7, 8], companyId: 9 })[0];
  assert.deepEqual([lead.pipeline_id, lead.status_id, lead.responsible_user_id], [REACT_PIPELINE_ID, REACT_STATUS_ID, 111]);
  assert.deepEqual(lead._embedded, { contacts: [{ id: 7 }, { id: 8 }], companies: [{ id: 9 }] }, "🔴 нова угода не привʼязана до клієнта в Kommo");
  assert.equal(leadBody({ clientName: null, clientKey: "0501112233", kommoUserId: 1, contactIds: [], companyId: 9 })[0].name, "0501112233 — клієнти та реактивація");
  // 13.11.2026 18:00 за Києвом (зима, UTC+2) = 16:00 UTC.
  assert.equal(dueUnix("2026-11-13", new Date("2026-11-12T10:00:00Z")), Date.UTC(2026, 10, 13, 16, 0, 0) / 1000, "🔴 строк — не 18:00 за Києвом дати кроку");
  // Без дати: пʼятниця → понеділок.
  assert.equal(dueUnix(null, new Date("2026-11-13T10:00:00Z")), Date.UTC(2026, 10, 16, 16, 0, 0) / 1000, "🔴 крок без дати не став на наступний робочий день");
  const t = taskBody({ text: "передзвонити", due: "2026-11-13", leadId: 55, kommoUserId: 111 }, new Date("2026-11-12T10:00:00Z"))[0];
  assert.deepEqual([t.entity_id, t.entity_type, t.responsible_user_id, t.text], [55, "leads", 111, "передзвонити"]);
  assert.deepEqual(closeTaskBody(77)[0].is_completed, true);
});

test("#3908 ПРОВОДКА 8345: етап у реєстрах; створена дашбордом угода — не «робота з клієнтом»; джоба під наглядом; роут каже правду про Kommo", () => {
  assert.equal(stageName(REACT_PIPELINE_ID, REACT_STATUS_ID), "Клієнти та реактивація", "🔴 новий етап без назви");
  assert.ok(OPERATIONAL_STATUSES.includes(REACT_STATUS_ID), "🔴 новий етап не в жодному грошовому відрі");
  const facts = src("backend/src/core/clientLeadFacts.ts");
  assert.match(facts, /AND e\.status_id <> \$\{String\(REACT_STATUS_ID\)\}/, "🔴 вхід у «Клієнти та реактивація» рахується рухом угоди — поставив задачу й уже «працюють»");
  assert.match(facts, /NOT EXISTS \(SELECT 1 FROM client_next_steps ns WHERE ns\.kommo_lead_id = d\.kommo_id AND ns\.kommo_lead_created\)/,
    "🔴 угода, створена дашбордом під задачу, рахується НОВОЮ угодою клієнта");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "syncClientKommoTasks")?.everyMin, 10, "🔴 нагляд за джобою не збігається з кроном");
  assert.match(src("backend/src/index.ts"), /cron\.schedule\("5,15,25,35,45,55 \* \* \* \*", \(\) => \{\s+if \(isKommoPaused\(\)\) return;\s+void runJob\("syncClientKommoTasks"/, "🔴 джоба не в розкладі");
  const routes = src("backend/src/routes/dashboard.ts");
  assert.match(routes, /if \(!\(await canSeeClient\(auth, clientKey\)\)\) return res\.status\(403\)[^\n]+\n[^\n]+\n\s+const v = stepVerdict/, "🔴 межа клієнта вже не перша");
  assert.match(routes, /const pushed = await pushStepNow\(stepId\)\.catch\(/, "🔴 збій Kommo валить збереження кроку");
  assert.match(routes, /\{ state: "waiting" as const, error: pushed\.error \}/, "🔴 відмова Kommo не доходить до екрана");
  assert.match(src("frontend/src/pages/dashboard/sections/ClientCardPanel.tsx"), /⚠️ у Kommo не передано/, "🔴 картка не показує, що задача не дійшла до Kommo");
  assert.equal(PUSH_PER_RUN, 3);
});

// ── Живий SQL на scratch-кластері з підставним Kommo ────────────────────────────────────────────
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });

test("#3909 🪞 ЖИВИЙ ЛАНЦЮГ 8345: відкрита угода — без нової; немає — одна нова; збій на задачі не двоїть угоду; «виконано» в обидва боки; порція 3", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  dispose = async () => { const { pool } = await import("../db/pool.js"); await pool.end(); await c.end(); scratch.dispose(); };
  await c.query(src("backend/src/db/schema.sql"));
  await c.query(`INSERT INTO teams (id, name) VALUES (5, 'РПК') ON CONFLICT (id) DO NOTHING`);
  await c.query(`INSERT INTO managers (id, name, team_id, is_active, kommo_user_id) VALUES (1, 'Власник', 5, true, 111), (2, 'Звільнений', 5, false, 222), (3, 'Автор', 5, true, 333)`);
  await c.query(`INSERT INTO users (id, email, password_hash, role, manager_id) VALUES (900, 'a@x', 'x', 'manager', 3)`);
  await c.query(`INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES (8921932, 142, 'paid') ON CONFLICT DO NOTHING`);
  const deal = (id: number, ck: string, mgr: number, status: number) =>
    c.query(`INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, price, created_at_kommo, closed_at_kommo, client_key, client_name)
             VALUES ($1, 'у', $2, 8921932, $3, 0, now() - interval '40 days', now() - interval '35 days', $4, $4)`, [id, mgr, status, ck]);
  // A: оплачена угода власника 1 + ВІДКРИТА угода · B: лише оплачена (власник 1) · C: оплачена на ЗВІЛЬНЕНОМУ 2 · D, E — для порції
  await deal(10, "A", 1, 142); await deal(11, "A", 1, 69693668);
  await deal(20, "B", 1, 142); await deal(30, "C", 2, 142); await deal(40, "D", 1, 142); await deal(50, "E", 1, 142);
  const step = async (ck: string, due: string | null) => (await c.query<{ id: number }>(
    `INSERT INTO client_next_steps (client_key, text, due_date, created_by) VALUES ($1, 'набрати', $2, 900) RETURNING id`, [ck, due])).rows[0].id;
  const kommo: Record<number, KommoLeadLite> = {
    10: { id: 10, status_id: 142, created_at: 1 }, 11: { id: 11, status_id: 69693668, created_at: 2 },
    20: { id: 20, status_id: 142, created_at: 1, _embedded: { contacts: [{ id: 7 }], companies: [{ id: 9 }] } },
    30: { id: 30, status_id: 142, created_at: 1, _embedded: { contacts: [{ id: 8 }] } },
    40: { id: 40, status_id: 142, created_at: 1, _embedded: { contacts: [{ id: 6 }] } },
    50: { id: 50, status_id: 142, created_at: 1, _embedded: { contacts: [{ id: 5 }] } },
  };
  const calls = { leads: [] as { responsible_user_id: number; _embedded: unknown }[], tasks: [] as { entity_id: number; responsible_user_id: number }[], closed: [] as number[] };
  let failTask = false; const completed = new Set<number>();
  const deps: KommoTaskDeps = {
    fetchLeads: async (ids) => ids.flatMap((id) => (kommo[id] ? [kommo[id]] : [])),
    createLead: async (body) => { calls.leads.push((body as typeof calls.leads)[0]); return 1000 + calls.leads.length; },
    createTask: async (body) => { if (failTask) throw new Error("Kommo 500"); calls.tasks.push((body as typeof calls.tasks)[0]); return 2000 + calls.tasks.length; },
    closeTasks: async (body) => { calls.closed.push((body as { id: number }[])[0].id); },
    fetchTasks: async (ids) => ids.map((id) => ({ id, is_completed: completed.has(id) })),
  };
  const { pushStep, syncClientTasks } = await import("./clientKommoTask.js");
  const { pool } = await import("../db/pool.js");
  const now = new Date("2026-11-12T10:00:00Z");
  const row = async (id: number) => (await c.query<{ kommo_lead_id: string | null; kommo_task_id: string | null; kommo_lead_created: boolean; kommo_attempts: number; kommo_error: string | null; done_at: Date | null; kommo_task_closed_at: Date | null }>(
    `SELECT kommo_lead_id::text, kommo_task_id::text, kommo_lead_created, kommo_attempts, kommo_error, done_at, kommo_task_closed_at FROM client_next_steps WHERE id = $1`, [id])).rows[0];

  // A — відкрита угода є: задача в неї, нової угоди НЕ створено.
  const a = await step("A", "2026-11-13");
  await pushStep(pool, deps, a, now);
  assert.equal(calls.leads.length, 0, "🔴 клієнту з відкритою угодою створено ще одну");
  assert.deepEqual([calls.tasks[0].entity_id, calls.tasks[0].responsible_user_id, (await row(a)).kommo_lead_created], [11, 111, false], "🔴 задача не у відкритій угоді або не на менеджері картки");

  // B — відкритої немає; задача падає → угода збережена, повтор НЕ створює другу.
  const b = await step("B", null);
  failTask = true;
  const r1 = await pushStep(pool, deps, b, now);
  assert.equal(r1.ok, false);
  assert.deepEqual([calls.leads.length, (await row(b)).kommo_lead_id, (await row(b)).kommo_attempts, (await row(b)).kommo_error], [1, "1001", 1, "Kommo 500"],
    "🔴 угода не збережена до задачі або помилка Kommo загубилась");
  assert.deepEqual(calls.leads[0]._embedded, { contacts: [{ id: 7 }], companies: [{ id: 9 }] }, "🔴 нова угода без контакту клієнта");
  failTask = false;
  await pushStep(pool, deps, b, now);
  assert.equal(calls.leads.length, 1, "🔴 повтор після збою створив ДРУГУ угоду");
  assert.deepEqual([(await row(b)).kommo_task_id != null, (await row(b)).kommo_lead_created, (await row(b)).kommo_error], [true, true, null]);
  await pushStep(pool, deps, b, now);
  assert.equal(calls.tasks.length, 2, "🔴 повторний виклик для перенесеного кроку поставив другу задачу");

  // C — менеджер клієнта звільнений: угода йде на автора задачі, не на звільненого.
  const cc = await step("C", "2026-11-14");
  await pushStep(pool, deps, cc, now);
  assert.equal(calls.leads[1].responsible_user_id, 333, "🔴 угода впала на звільненого менеджера");

  // Порція: у черзі 2 (D, E) + ще один F без угод → за прохід не більше PUSH_PER_RUN, помилка названа.
  const d = await step("D", null), e = await step("E", null), f = await step("F", null);
  const rep = await syncClientTasks(pool, deps, now);
  assert.equal(rep.pushed + rep.failed, 3, "🔴 прохід узяв не порцію");
  assert.deepEqual([(await row(d)).kommo_task_id != null, (await row(e)).kommo_task_id != null], [true, true]);
  assert.match((await row(f)).kommo_error ?? "", /немає жодної угоди/, "🔴 клієнт без угод не дав названої причини");

  // «Виконано» в дашборді → закрити в Kommo; «виконано» в Kommo → закрити крок.
  await c.query(`UPDATE client_next_steps SET done_at = now(), done_by = 900 WHERE id = $1`, [a]);
  completed.add(Number((await row(d)).kommo_task_id));
  const rep2 = await syncClientTasks(pool, deps, now);
  assert.deepEqual([rep2.closedInKommo, calls.closed.length, (await row(a)).kommo_task_closed_at != null], [1, 1, true], "🔴 закритий у дашборді крок не закрив задачу в Kommo");
  assert.deepEqual([rep2.doneFromKommo, (await row(d)).done_at != null, (await row(e)).done_at], [1, true, null], "🔴 закрита в Kommo задача не закрила крок — або закрила чужий");
  const rep3 = await syncClientTasks(pool, deps, now);
  assert.equal(rep3.closedInKommo, 0, "🔴 задачу в Kommo закривають повторно");
});
