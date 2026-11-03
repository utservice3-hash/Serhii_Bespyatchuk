import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { addWorkMinutes, nextInRing, workedMonth, runLinkedinQueueTick, LINKEDIN_STAGE, type StageLead, type QueueOwner } from "./linkedinQueue.js";
import type { Db } from "./adCallFacts.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const Z = (iso: string) => new Date(iso).getTime();

/**
 * 🔗 ЧЕРГА LINKEDIN (задача 7361; рішення Юлі 03.11.2026). Листопад 2026 — Київ = UTC+2.
 * Гейти стережуть кожне речення рішення по обидва боки межі: коло, 15 хв робочого часу, «хто проігнорував —
 * пропускає чергу», «двоє підряд — Даші», дубль клієнта, відсутність за календарем, старі угоди не йдуть у чергу.
 */

test("#3400 15 хв рахуються лише в робочий час пн–пт 8–18: 17:55 → 08:10 наступного робочого дня", () => {
  assert.equal(addWorkMinutes(Z("2026-11-04T08:00:00Z"), 15), Z("2026-11-04T08:15:00Z"), "середа 10:00 → 10:15");
  assert.equal(addWorkMinutes(Z("2026-11-05T15:55:00Z"), 15), Z("2026-11-06T06:10:00Z"), "четвер 17:55 → пʼятниця 08:10");
  assert.equal(addWorkMinutes(Z("2026-11-06T15:55:00Z"), 15), Z("2026-11-09T06:10:00Z"), "пʼятниця 17:55 → понеділок 08:10");
  assert.equal(addWorkMinutes(Z("2026-11-07T10:00:00Z"), 15), Z("2026-11-09T06:15:00Z"), "субота — черга закрита до понеділка 08:00");
  assert.equal(addWorkMinutes(Z("2026-11-04T04:00:00Z"), 15), Z("2026-11-04T06:15:00Z"), "06:00 будня — відлік із 08:00 того ж дня");
  assert.equal(addWorkMinutes(Z("2026-11-04T16:00:00Z"), 15), Z("2026-11-05T06:15:00Z"), "після 18:00 — чекає ранку");
});

test("#3401 коло: наступний за списком після останнього, по колу; недоступних пропускає; нікого — null", () => {
  const all = () => true;
  assert.equal(nextInRing([10, 20, 30], 20, all), 30);
  assert.equal(nextInRing([10, 20, 30], 30, all), 10, "після останнього — знову перший");
  assert.equal(nextInRing([10, 20, 30], null, all), 10, "початок — з першого");
  assert.equal(nextInRing([10, 20, 30], 99, all), 10, "колишнього учасника вже немає — з першого");
  assert.equal(nextInRing([10, 20, 30], 10, (id) => id !== 20), 30, "відсутнього пропускає");
  assert.equal(nextInRing([10, 20, 30], 10, () => false), null);
  assert.equal(nextInRing([], null, all), null);
});

test("#3402 «від 1 місяця»: рівно місяць тому — так, на день менше — ні, невідома дата — ні", () => {
  assert.equal(workedMonth("2026-10-03", "2026-11-03"), true);
  assert.equal(workedMonth("2026-10-04", "2026-11-03"), false);
  assert.equal(workedMonth(null, "2026-11-03"), false);
});

// ── Тік на scratch-базі ──────────────────────────────────────────────────────────────────────────────────────
let ctxP: Promise<{ db: Db; raw: import("pg").Client } | { unavailable: string }> | null = null;
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });
async function ctx(t: { skip: (m: string) => void }) {
  ctxP ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const s = provisionScratch();
    if ("unavailable" in s) return { unavailable: skipReason(s) };
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: s.url });
    await c.connect();
    await c.query("SET TIME ZONE 'UTC'");
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "..", "src", "db", "schema.sql"), "utf8"));
    dispose = async () => { await c.end().catch(() => {}); s.dispose(); };
    return { db: c as unknown as Db, raw: c };
  })();
  const r = await ctxP;
  if ("unavailable" in r) { t.skip(r.unavailable); return null; }
  return r;
}

test("#3403 тік: нова угода → першому в колі; 15 хв минули → наступному; двоє не взяли → відповідальній; відсутніх і дубль клієнта — за правилом", async (t) => {
  const c = await ctx(t);
  if (!c) return;
  const q = (sql: string, p: unknown[] = []) => c.raw.query(sql, p);
  await q(`TRUNCATE linkedin_queue_items, linkedin_queue_log, linkedin_queue_members, linkedin_queue_settings`);
  const mids: number[] = [];
  for (const n of ["Аа", "Бб", "Вв", "Гг"]) {
    mids.push((await q(`INSERT INTO managers (name, is_active, kommo_user_id) VALUES ($1, true, $2) RETURNING id`, [`LQ ${n}`, 900000 + mids.length])).rows[0].id as number);
  }
  const [A, B, Cm, D] = mids;
  for (const [i, id] of [A, B, Cm].entries()) await q(`INSERT INTO linkedin_queue_members (manager_id, position) VALUES ($1, $2)`, [id, i + 1]);
  // Б сьогодні у відпустці (погоджено) — коло його пропускає.
  await q(`INSERT INTO team_calendar_absences (manager_id, kind, start_date, end_date, status) VALUES ($1, 'vacation', '2026-11-02', '2026-11-06', 'approved')`, [B]);
  // Дві угоди в базі (синк уже приніс client_key); третя — клієнт уже в D (дубль).
  for (const [id, key] of [[7001, "k-new-1"], [7002, "k-new-2"], [7003, "k-dup"]] as const) {
    await q(`INSERT INTO deals (kommo_id, name, pipeline_id, status_id, client_key) VALUES ($1, $2, $3, $4, $5)`, [id, `LinkedIn ${String(id)}`, LINKEDIN_STAGE.pipelineId, LINKEDIN_STAGE.statusId, key]);
  }
  let stage: StageLead[] = [];
  const owner = async (k: string): Promise<QueueOwner | null> => (k === "k-dup" ? { managerId: D, managerName: "LQ Гг" } : null);
  const tick = (iso: string, mode: "dry" | "off" = "dry") => runLinkedinQueueTick({ db: c.db, mode, now: () => new Date(iso), stageLeads: async () => stage, ownerOf: owner });

  // Запуск у середу 10:00: угода, створена ДО запуску, у чергу не йде.
  stage = [{ id: 6999, name: "стара", createdAt: Z("2026-11-04T07:00:00Z"), responsibleUserId: 1 }];
  await tick("2026-11-04T08:00:00Z");
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM linkedin_queue_items`)).rows[0].n, 0, "🔴 угода до запуску потрапила в чергу");
  // «off» — нічого не пише.
  stage.push({ id: 7001, name: "LinkedIn 7001", createdAt: Z("2026-11-04T08:01:00Z"), responsibleUserId: 1 });
  const off = await tick("2026-11-04T08:02:00Z", "off");
  assert.equal(off.seen, 0);
  // Нова угода → А (перший); у журналі mode='dry'.
  await tick("2026-11-04T08:02:00Z");
  let it = (await q(`SELECT state, manager_id, deadline_at FROM linkedin_queue_items WHERE kommo_id = 7001`)).rows[0];
  assert.equal(it.state, "offered");
  assert.equal(it.manager_id, A, "🔴 нова заявка пішла не першому в колі");
  assert.equal(new Date(it.deadline_at).toISOString(), "2026-11-04T08:17:00.000Z", "🔴 дедлайн не 15 хв робочого часу");
  assert.deepEqual((await q(`SELECT DISTINCT mode FROM linkedin_queue_log`)).rows.map((r) => r.mode), ["dry"]);
  // До дедлайну — нічого не рухається.
  await tick("2026-11-04T08:10:00Z");
  assert.equal((await q(`SELECT manager_id FROM linkedin_queue_items WHERE kommo_id = 7001`)).rows[0].manager_id, A);
  // Дедлайн минув → А проігнорував, Б у відпустці → В.
  await tick("2026-11-04T08:17:00Z");
  it = (await q(`SELECT state, manager_id, misses FROM linkedin_queue_items WHERE kommo_id = 7001`)).rows[0];
  assert.equal(it.manager_id, Cm, "🔴 після «не взяв» заявка не пішла наступному доступному (Б у відпустці)");
  assert.equal(it.misses, 1);
  // Друга нова угода: коло стоїть на В → наступний доступний А («хто проігнорував, пропускає чергу» — коло вже рушило).
  stage.push({ id: 7002, name: "LinkedIn 7002", createdAt: Z("2026-11-04T08:20:00Z"), responsibleUserId: 1 });
  await tick("2026-11-04T08:21:00Z");
  assert.equal((await q(`SELECT manager_id FROM linkedin_queue_items WHERE kommo_id = 7002`)).rows[0].manager_id, A);
  // Дедлайн В по 7001 → другий підряд не взяв → відповідальній.
  await tick("2026-11-04T08:33:00Z");
  it = (await q(`SELECT state, reason FROM linkedin_queue_items WHERE kommo_id = 7001`)).rows[0];
  assert.equal(it.state, "dispatcher", "🔴 двоє підряд не взяли, а заявка не пішла відповідальній");
  assert.match(String(it.reason), /не взяли/);
  // Дубль: клієнт уже в Г → відповідальній, у коло не потрапляє.
  stage.push({ id: 7003, name: "LinkedIn 7003", createdAt: Z("2026-11-04T08:40:00Z"), responsibleUserId: 1 });
  await tick("2026-11-04T08:41:00Z");
  it = (await q(`SELECT state, reason, offered_ids FROM linkedin_queue_items WHERE kommo_id = 7003`)).rows[0];
  assert.equal(it.state, "dispatcher");
  assert.match(String(it.reason), /LQ Гг/);
  assert.deepEqual(it.offered_ids, [], "🔴 дубль усе одно отримав пропозицію");
  // Без client_key (синк ще не приніс) — чекає, не пропонує.
  stage.push({ id: 7004, name: "LinkedIn 7004", createdAt: Z("2026-11-04T08:42:00Z"), responsibleUserId: 1 });
  const r = await tick("2026-11-04T08:43:00Z");
  assert.equal(r.waitingSync, 1);
  assert.equal((await q(`SELECT state FROM linkedin_queue_items WHERE kommo_id = 7004`)).rows[0].state, "waiting");
  // Поза робочим часом нова угода чекає ранку; відповідального змінили вручну — пішла з черги.
  stage = stage.map((l) => (l.id === 7002 ? { ...l, responsibleUserId: 555 } : l));
  await q(`UPDATE deals SET client_key = 'k-new-4' WHERE kommo_id = 7004`);
  const late = await tick("2026-11-04T17:00:00Z");
  assert.equal(late.offHours, true);
  assert.equal((await q(`SELECT state FROM linkedin_queue_items WHERE kommo_id = 7002`)).rows[0].state, "gone", "🔴 угода, яку роздали вручну, лишилась у черзі");
  assert.equal((await q(`SELECT state FROM linkedin_queue_items WHERE kommo_id = 7004`)).rows[0].state, "waiting", "🔴 поза робочим часом заявку запропонували");
  // Угода пішла з етапу — пішла з черги.
  stage = stage.filter((l) => l.id !== 7004);
  await tick("2026-11-05T06:01:00Z");
  assert.equal((await q(`SELECT state FROM linkedin_queue_items WHERE kommo_id = 7004`)).rows[0].state, "gone");
});

test("#3404 джоба: крон кожні 2 хв (непарні хвилини), під наглядом із тією ж частотою; режим за замовчуванням — пробний", async () => {
  const idx = read("backend/src/index.ts");
  const at = idx.indexOf('runJob("linkedinQueueJob"');
  assert.ok(at > 0, "🔴 linkedinQueueJob не запускається з index.ts");
  const spec = /cron\.schedule\("([^"]+)"[^]*?$/.exec(idx.slice(Math.max(0, idx.lastIndexOf("cron.schedule(", at)), at))?.[1];
  assert.equal(spec, Array.from({ length: 30 }, (_, i) => 2 * i + 1).join(",") + " * * * *", "🔴 частота черги не 2 хв або збігається з :00/:30 синку");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((x) => x.name === "linkedinQueueJob")?.everyMin, 2, "🔴 джоба не під наглядом із частотою крону");
  const { closeModeOf } = await import("./carrierClose.js");
  assert.equal(closeModeOf(""), "dry", "🔴 порожній LINKEDIN_QUEUE має бути пробним режимом");
  assert.match(read("backend/src/config.ts"), /linkedinQueue: \{ mode: process\.env\.LINKEDIN_QUEUE \?\? ""/);
});

test("#3405 межа: кожен роут черги — право manage_linkedin_queue першим; у матриці; право мають лише адмін і КВП", () => {
  const r = read("backend/src/routes/linkedinQueue.ts");
  const routes = [...r.matchAll(/linkedinQueueRouter\.(get|put|post|delete|patch)\("([^"]+)",\s*([a-zA-Z]+\("[a-z_]+"\))/g)];
  assert.equal(routes.length, 3, "🔴 роутів черги не три — новий роут без межі або межа не першим middleware");
  for (const m of routes) assert.equal(m[3], 'requirePerm("manage_linkedin_queue")', `🔴 ${m[1]} ${m[2]} без права першим`);
  const matrix = read("backend/src/auth/accessMatrix.ts");
  for (const p of ['method: "GET", path: "/api/linkedin-queue"', 'method: "PUT", path: "/api/linkedin-queue/members"', 'method: "PUT", path: "/api/linkedin-queue/settings"']) {
    assert.ok(matrix.includes(p), `🔴 у матриці немає ${p}`);
  }
  const schema = read("backend/src/db/schema.sql");
  assert.match(schema, /SET permissions = permissions \|\| '\{"manage_linkedin_queue": true\}'::jsonb\s+WHERE key IN \('admin', 'kvp'\);/);
  assert.match(schema, /SET permissions = permissions - 'manage_linkedin_queue'\s+WHERE key NOT IN \('admin', 'kvp'\);/);
});

test("#3406 статистика за період — з журналу: отримав / проігнорував по менеджерах, дублі окремо від «ніхто не взяв», межі дат включно", async (t) => {
  const c = await ctx(t);
  if (!c) return;
  // Стан лишив #3403 (той самий файл, тести йдуть по черзі): 04.11 — 4 нові угоди. А: 7001 (сплило 08:17) і 7002
  // (сплило 08:36, помічено тіком 08:41) — отримав 2, проігнорував 2. В: 7001 (сплило 08:33) і 7002 (08:41, пішла з черги
  // поза ботом до дедлайну) — отримав 2, проігнорував 1. Відповідальній — 7001 («двоє не взяли») і 7003 (дубль).
  const n = (await c.raw.query(`SELECT COUNT(*)::int AS n FROM linkedin_queue_log WHERE kind = 'offer'`)).rows[0].n as number;
  if (n === 0) { t.skip("журнал порожній — #3403 не відпрацював, рахувати нема з чого"); return; }
  const { loadLinkedinStats } = await import("./linkedinStats.js");
  const s = await loadLinkedinStats(c.db, "2026-11-04", "2026-11-04", "", new Date("2026-11-05T08:00:00Z"));
  assert.equal(s.kpi.created, 4);
  assert.equal(s.kpi.dispatcher, 2);
  assert.equal(s.kpi.dispatcherDup, 1, "🔴 дубль клієнта не відрізнено від «ніхто не взяв»");
  assert.equal(s.kpi.dispatcherNobody, 1);
  const by = new Map(s.perManager.map((m) => [m.name, m]));
  assert.deepEqual([by.get("LQ Аа")?.received, by.get("LQ Аа")?.ignored], [2, 2], "🔴 А: отримав / проігнорував");
  assert.deepEqual([by.get("LQ Вв")?.received, by.get("LQ Вв")?.ignored], [2, 1], "🔴 В: отримав / проігнорував");
  assert.equal(by.has("LQ Бб"), false, "🔴 Б був у відпустці, а в статистиці значиться як той, кому пропонували");
  // По той бік межі дат: наступний день — порожньо.
  const next = await loadLinkedinStats(c.db, "2026-11-05", "2026-11-05", "", new Date("2026-11-05T08:00:00Z"));
  assert.deepEqual([next.kpi.created, next.perManager.length], [0, 0], "🔴 події 04.11 потрапили в 05.11");
  // Рядок черги: коло стоїть на В (остання пропозиція 08:41), далі по колу А; Б ще у відпустці.
  assert.equal(s.queue.nextName, "LQ Аа");
  await assert.rejects(loadLinkedinStats(c.db, "2026-11-05", "2026-11-04", ""), /Початок періоду пізніше/);
});

test("#3407 вкладка «LinkedIn» у «Клієнтах»: межа — вкладка linkedin (керівництво й КВП, без фінансиста); редактор черги — там, а не в Налаштуваннях", () => {
  const rt = read("backend/src/auth/routeTab.ts");
  assert.match(rt, /\{ test: pre\("\/api\/linkedin"\), tabs: \["linkedin"\] \}/, "🔴 /api/linkedin не привʼязано до вкладки");
  const schema = read("backend/src/db/schema.sql");
  assert.match(schema, /'\{"linkedin":true\}'::jsonb\s+WHERE key IN \('admin', 'ceo', 'opdir', 'kvp'\)/);
  const grant = schema.indexOf(`'{"linkedin":true}'`), drop = schema.indexOf("screen_access - 'linkedin'");
  const sync = schema.lastIndexOf("financier");
  assert.ok(drop > grant && drop > 0, "🔴 фінансисту не знято вкладку LinkedIn після сиду");
  assert.ok(schema.slice(drop - 40, drop + 60).includes("financier") && sync > 0);
  assert.ok(read("backend/src/auth/accessMatrix.ts").includes('{ method: "GET", path: "/api/linkedin/stats", cls: "GET",\n    allow: ["admin", "ceo", "opdir", "kvp"], deny: ["financier", "hr", "team_lead", "manager"] }'));
  assert.match(read("frontend/src/components/Layout.tsx"), /\{ key: "linkedin", label: "LinkedIn", icon: "🔗" \}/);
  assert.match(read("frontend/src/pages/Dashboard.tsx"), /section === "linkedin" && <LinkedinSection \/>/);
  // Парне твердження «а де воно тепер»: редактор живе у вкладці, з Налаштувань прибрано.
  assert.match(read("frontend/src/pages/dashboard/sections/LinkedinSection.tsx"), /canEdit && editing && <LinkedinQueueTab /);
  assert.doesNotMatch(read("frontend/src/pages/dashboard/sections/SettingsSection.tsx"), /LinkedinQueueTab|Черга LinkedIn/);
});
