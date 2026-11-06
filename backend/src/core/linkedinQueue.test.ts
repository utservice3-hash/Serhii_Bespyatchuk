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
  assert.equal(routes.length, 3, "🔴 роутів черги не три (екран, список, пауза) — новий роут без межі або межа не першим middleware");
  for (const m of routes) assert.equal(m[3], 'requirePerm("manage_linkedin_queue")', `🔴 ${m[1]} ${m[2]} без права першим`);
  const matrix = read("backend/src/auth/accessMatrix.ts");
  for (const p of ['method: "GET", path: "/api/linkedin-queue"', 'method: "PUT", path: "/api/linkedin-queue/members"', 'method: "PUT", path: "/api/linkedin-queue/pause"']) {
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

test("#3407 вкладка «LinkedIn» у «Клієнтах»: межа — вкладка linkedin (керівництво, КВП, тімліди, менеджери; без фінансиста); редактор черги — там, а не в Налаштуваннях", () => {
  const rt = read("backend/src/auth/routeTab.ts");
  assert.match(rt, /\{ test: pre\("\/api\/linkedin"\), tabs: \["linkedin"\] \}/, "🔴 /api/linkedin не привʼязано до вкладки");
  const schema = read("backend/src/db/schema.sql");
  assert.match(schema, /'\{"linkedin":true\}'::jsonb\s+WHERE key IN \('admin', 'ceo', 'opdir', 'kvp', 'team_lead', 'manager'\)/);
  const grant = schema.indexOf(`'{"linkedin":true}'`), drop = schema.indexOf("screen_access - 'linkedin'");
  const sync = schema.lastIndexOf("financier");
  assert.ok(drop > grant && drop > 0, "🔴 фінансисту не знято вкладку LinkedIn після сиду");
  assert.ok(schema.slice(drop - 40, drop + 60).includes("financier") && sync > 0);
  assert.ok(read("backend/src/auth/accessMatrix.ts").includes('{ method: "GET", path: "/api/linkedin/stats", cls: "GET",\n    allow: ["admin", "ceo", "opdir", "kvp", "team_lead", "manager"], deny: ["financier", "hr"] }'));
  assert.match(read("frontend/src/components/Layout.tsx"), /\{ key: "linkedin", label: "LinkedIn", icon: "🔗" \}/);
  assert.match(read("frontend/src/pages/Dashboard.tsx"), /section === "linkedin" && <LinkedinSection \/>/);
  // Парне твердження «а де воно тепер»: редактор живе у вкладці, з Налаштувань прибрано.
  assert.match(read("frontend/src/pages/dashboard/sections/LinkedinSection.tsx"), /tab === "queue" && canEdit \? <LinkedinQueueTab /);
  assert.doesNotMatch(read("frontend/src/pages/dashboard/sections/SettingsSection.tsx"), /LinkedinQueueTab|Черга LinkedIn/);
});

test("#3408 «Зупинити бота»: на паузі тік нічого не робить (навіть у Kommo не ходить); після запуску поточні пропозиції — свіжі 15 хв, а не «проігнорував»", async (t) => {
  const c = await ctx(t);
  if (!c) return;
  const { setQueuePaused } = await import("./linkedinQueue.js");
  const q = (sql: string, p: unknown[] = []) => c.raw.query(sql, p);
  await q(`TRUNCATE linkedin_queue_items, linkedin_queue_log, linkedin_queue_members, linkedin_queue_settings`);
  const m = (await q(`INSERT INTO managers (name, is_active, kommo_user_id) VALUES ('LQ пауза', true, 909090) RETURNING id`)).rows[0].id as number;
  const uid = (await q(`INSERT INTO users (email, password_hash, role) VALUES ('lq-pause@uts.test', 'x', 'admin') RETURNING id`)).rows[0].id as number;
  await q(`INSERT INTO linkedin_queue_members (manager_id, position) VALUES ($1, 1)`, [m]);
  await q(`INSERT INTO deals (kommo_id, name, pipeline_id, status_id, client_key) VALUES (7101, 'LinkedIn 7101', $1, $2, 'k-pause')
           ON CONFLICT (kommo_id) DO NOTHING`, [LINKEDIN_STAGE.pipelineId, LINKEDIN_STAGE.statusId]);
  let calls = 0;
  const stage: StageLead[] = [{ id: 7101, name: "LinkedIn 7101", createdAt: Z("2026-11-04T08:01:00Z"), responsibleUserId: 1 }];
  const tick = (iso: string) => runLinkedinQueueTick({ db: c.db, mode: "dry", now: () => new Date(iso), stageLeads: async () => { calls++; return stage; }, ownerOf: async () => null });
  await tick("2026-11-04T08:00:00Z");
  await tick("2026-11-04T08:02:00Z");
  assert.equal((await q(`SELECT state FROM linkedin_queue_items WHERE kommo_id = 7101`)).rows[0].state, "offered");
  await setQueuePaused(c.db, true, uid, new Date("2026-11-04T08:05:00Z"));
  const before = calls;
  const r = await tick("2026-11-04T09:00:00Z"); // дедлайн 08:17 давно минув — на паузі це нічого не значить
  assert.equal(r.paused, true);
  assert.equal(calls, before, "🔴 на паузі тік усе одно ходить у Kommo");
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM linkedin_queue_log WHERE kind = 'ignored'`)).rows[0].n, 0, "🔴 пауза записала менеджеру «проігнорував»");
  await setQueuePaused(c.db, false, uid, new Date("2026-11-04T09:10:00Z"));
  const dl = (await q(`SELECT deadline_at FROM linkedin_queue_items WHERE kommo_id = 7101`)).rows[0].deadline_at as Date;
  assert.equal(new Date(dl).toISOString(), "2026-11-04T09:25:00.000Z", "🔴 після запуску пропозиція не отримала свіжих 15 хв");
  await tick("2026-11-04T09:12:00Z");
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM linkedin_queue_log WHERE kind = 'ignored'`)).rows[0].n, 0, "🔴 одразу після запуску — «проігнорував»");
});

test("#3409 повідомлення менеджеру: назва, контакт, «взяти до» (з датою, якщо 15 хв переходять на інший день), посилання; HTML екранується", async () => {
  const { offerText } = await import("./linkedinQueue.js");
  const same = offerText({ dealName: "LinkedIn №30 <ТОВ & Ко>", contact: "Іван", phone: "+380671112233", url: "https://k/leads/detail/1",
    deadlineMs: Z("2026-11-04T08:15:00Z"), nowMs: Z("2026-11-04T08:00:00Z") });
  assert.match(same, /LinkedIn №30 &lt;ТОВ &amp; Ко&gt;/, "🔴 назва угоди не екранована — Telegram відкине HTML");
  assert.match(same, /👤 Іван · 📞 \+380671112233/);
  assert.match(same, /Взяти до <b>10:15<\/b>/);
  assert.match(same, /<a href="https:\/\/k\/leads\/detail\/1">/);
  const next = offerText({ dealName: null, contact: null, phone: null, url: "u", deadlineMs: Z("2026-11-05T06:10:00Z"), nowMs: Z("2026-11-04T15:55:00Z") });
  assert.match(next, /Взяти до <b>05\.11 08:10<\/b>/, "🔴 дедлайн наступного дня без дати — менеджер подумає, що вже пізно");
  assert.doesNotMatch(next, /👤|📞/, "🔴 порожні контакт і телефон дали порожній рядок");
});

async function liveSeed(c: { raw: import("pg").Client }) {
  const q = (sql: string, p: unknown[] = []) => c.raw.query(sql, p);
  await q(`TRUNCATE linkedin_queue_items, linkedin_queue_log, linkedin_queue_members, linkedin_queue_settings`);
  // Повторюване: кожен гейт сіє свіжий склад (той самий кластер на весь файл).
  await q(`DELETE FROM users WHERE email LIKE 'live-%@uts.test'`);
  await q(`DELETE FROM managers WHERE kommo_user_id BETWEEN 910000 AND 910002`);
  const ids: number[] = [];
  for (const [i, n] of ["ЛА", "ЛБ", "ЛВ"].entries()) {
    const m = (await q(`INSERT INTO managers (name, is_active, kommo_user_id) VALUES ($1, true, $2) RETURNING id`, [`Live ${n}`, 910000 + i])).rows[0].id as number;
    await q(`INSERT INTO linkedin_queue_members (manager_id, position) VALUES ($1, $2)`, [m, i + 1]);
    ids.push(m);
  }
  // ЛА і ЛВ підключили бота, ЛБ — ні (йому «нічого не даємо»).
  for (const [i, m] of ids.entries()) {
    await q(`INSERT INTO users (email, password_hash, role, manager_id, leads_bot_chat_id) VALUES ($1, 'x', 'manager', $2, $3)`,
      [`live-${String(m)}@uts.test`, m, i === 1 ? null : 5000 + i]);
  }
  await q(`INSERT INTO deals (kommo_id, name, pipeline_id, status_id, client_key) VALUES (7201, 'LinkedIn 7201', $1, $2, 'k-live')
           ON CONFLICT (kommo_id) DO UPDATE SET client_key = 'k-live'`, [LINKEDIN_STAGE.pipelineId, LINKEDIN_STAGE.statusId]);
  return { ids, q };
}

test("#3410 бойовий режим: заявка лише тому, хто підключив бота; повідомлення з «Взяти»; 15 хв минули — кнопка гасне, заявка наступному з ботом", async (t) => {
  const c = await ctx(t);
  if (!c) return;
  const { ids: [A, , C], q } = await liveSeed(c);
  const sent: { chat: string; html: string; data: string }[] = [], edited: { chat: string; id: number; html: string }[] = [];
  let msg = 100;
  const live = {
    send: async (chat: string, html: string, b: { text: string; callback_data: string }[]) => { sent.push({ chat, html, data: b[0]?.callback_data }); return ++msg; },
    edit: async (chat: string, id: number, html: string) => { edited.push({ chat, id, html }); return true; },
    leadCard: async () => ({ contact: "Олена", phone: "+380500000000" }),
    leadUrl: (id: number) => `https://k/leads/detail/${String(id)}`,
  };
  const stage: StageLead[] = [{ id: 7201, name: "LinkedIn 7201", createdAt: Z("2026-11-04T08:01:00Z"), responsibleUserId: 1 }];
  const tick = (iso: string) => runLinkedinQueueTick({ db: c.db, mode: "live", live, now: () => new Date(iso), stageLeads: async () => stage, ownerOf: async () => null });
  await tick("2026-11-04T08:00:00Z");
  await tick("2026-11-04T08:02:00Z");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, "5000", "🔴 перша заявка пішла не першому з ботом");
  assert.equal(sent[0].data, "lq:take:7201", "🔴 кнопка «Взяти» без id угоди — натиск нічого не знайде");
  assert.match(sent[0].html, /Олена · 📞 \+380500000000/);
  await tick("2026-11-04T08:17:00Z");
  assert.deepEqual(edited.map((e) => [e.chat, e.id]), [["5000", 101]], "🔴 у того, хто не взяв, кнопка не погасла");
  assert.match(edited[0].html, /Час минув/);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].chat, "5002", "🔴 заявка пішла менеджеру без бота (ЛБ) замість наступного з ботом (ЛВ)");
  const it = (await q(`SELECT manager_id, offer_chat_id::text, offer_message_id::text FROM linkedin_queue_items WHERE kommo_id = 7201`)).rows[0];
  assert.deepEqual([it.manager_id, it.offer_chat_id, it.offer_message_id], [C, "5002", "102"]);
  assert.deepEqual((await q(`SELECT DISTINCT mode FROM linkedin_queue_log`)).rows.map((r) => r.mode), ["live"]);
  // Ніхто з ботом більше недоступний (ЛВ проігнорує, ЛА вже пробували) → «двоє не взяли» → Даші; кнопка в ЛВ гасне.
  await tick("2026-11-04T08:33:00Z");
  assert.equal((await q(`SELECT state FROM linkedin_queue_items WHERE kommo_id = 7201`)).rows[0].state, "dispatcher");
  assert.equal(edited.at(-1)?.chat, "5002");
  assert.ok(A > 0);
});

test("#3411 «Взяти»: лише той, кому запропоновано, і поки 15 хв не минули; Kommo не прийняв — пропозиція лишається; повторний натиск нічого не міняє", async (t) => {
  const c = await ctx(t);
  if (!c) return;
  const { ids: [A, , C], q } = await liveSeed(c);
  const { takeOffer } = await import("./linkedinQueue.js");
  await q(`INSERT INTO linkedin_queue_items (kommo_id, deal_name, state, manager_id, offered_ids, offered_at, deadline_at)
           VALUES (7201, 'LinkedIn 7201', 'offered', $1, ARRAY[$1]::int[], '2026-11-04T08:02:00Z', '2026-11-04T08:17:00Z')`, [A]);
  const assigned: [number, number][] = [];
  const ok = (id: number, uid: number) => { assigned.push([id, uid]); return Promise.resolve(); };
  // Чужий (ЛВ) тисне — не його заявка.
  assert.deepEqual(await takeOffer(c.db, { kommoId: 7201, chatId: 5002, now: new Date("2026-11-04T08:05:00Z"), assign: ok }), { ok: false, why: "not_yours" });
  // Незнайомий чат.
  assert.deepEqual(await takeOffer(c.db, { kommoId: 7201, chatId: 99999, now: new Date("2026-11-04T08:05:00Z"), assign: ok }), { ok: false, why: "not_linked" });
  // Kommo впав — заявка лишається запропонованою А.
  const r1 = await takeOffer(c.db, { kommoId: 7201, chatId: 5000, now: new Date("2026-11-04T08:05:00Z"), assign: () => Promise.reject(new Error("502")) });
  assert.deepEqual(r1, { ok: false, why: "kommo_failed" });
  assert.equal((await q(`SELECT state FROM linkedin_queue_items WHERE kommo_id = 7201`)).rows[0].state, "offered", "🔴 Kommo не прийняв, а заявка в дашборді вже «взята»");
  // Після дедлайну — «час минув».
  assert.deepEqual(await takeOffer(c.db, { kommoId: 7201, chatId: 5000, now: new Date("2026-11-04T08:18:00Z"), assign: ok }), { ok: false, why: "expired" });
  // Вчасно — взяв; Kommo отримав відповідального А; у журналі «taken».
  const r2 = await takeOffer(c.db, { kommoId: 7201, chatId: 5000, now: new Date("2026-11-04T08:10:00Z"), assign: ok });
  assert.deepEqual(r2, { ok: true, dealName: "LinkedIn 7201" });
  assert.deepEqual(assigned, [[7201, 910000]], "🔴 у Kommo відповідальним поставлено не того менеджера");
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM linkedin_queue_log WHERE kind = 'taken' AND manager_id = $1`, [A])).rows[0].n, 1);
  // Повторний натиск (подвійний клік) — нічого.
  assert.deepEqual(await takeOffer(c.db, { kommoId: 7201, chatId: 5000, now: new Date("2026-11-04T08:11:00Z"), assign: ok }), { ok: false, why: "not_yours" });
  assert.equal(assigned.length, 1, "🔴 подвійний клік вдруге писав у Kommo");
  assert.ok(C > 0);
});

test("#3412 підключення бота: код із дашборда привʼязує чат; код одноразовий і живе 10 хв; один Telegram — один акаунт", async (t) => {
  const c = await ctx(t);
  if (!c) return;
  const { createLeadsLinkCode, linkLeadsChat } = await import("./leadsBotLink.js");
  const q = (sql: string, p: unknown[] = []) => c.raw.query(sql, p);
  const u1 = (await q(`INSERT INTO users (email, password_hash, role) VALUES ('link1@uts.test', 'x', 'manager') RETURNING id`)).rows[0].id as number;
  const u2 = (await q(`INSERT INTO users (email, password_hash, role) VALUES ('link2@uts.test', 'x', 'manager') RETURNING id`)).rows[0].id as number;
  const t0 = new Date("2026-11-04T08:00:00Z");
  const code = await createLeadsLinkCode(c.db, u1, t0);
  assert.match(code, /^\d{6}$/);
  assert.match(await linkLeadsChat(c.db, `/start ${code}`, 777, new Date("2026-11-04T08:05:00Z")), /Готово/);
  assert.equal((await q(`SELECT leads_bot_chat_id::text AS c FROM users WHERE id = $1`, [u1])).rows[0].c, "777");
  assert.match(await linkLeadsChat(c.db, code, 778, new Date("2026-11-04T08:06:00Z")), /не знайдено/, "🔴 код спрацював удруге");
  const old = await createLeadsLinkCode(c.db, u2, t0);
  assert.match(await linkLeadsChat(c.db, old, 777, new Date("2026-11-04T08:11:00Z")), /не знайдено/, "🔴 код живе довше 10 хв");
  const fresh = await createLeadsLinkCode(c.db, u2, new Date("2026-11-04T08:12:00Z"));
  await linkLeadsChat(c.db, fresh, 777, new Date("2026-11-04T08:13:00Z"));
  const rows = (await q(`SELECT id, leads_bot_chat_id::text AS c FROM users WHERE id = ANY($1::int[]) ORDER BY id`, [[u1, u2]])).rows;
  assert.deepEqual(rows.map((r) => r.c), [null, "777"], "🔴 один Telegram привʼязаний до двох акаунтів — «Взяти» не знатиме, чия заявка");
  assert.match(await linkLeadsChat(c.db, "привіт", 777, t0), /код із 6 цифр/);
});

test("#3413 бот «UTS Заявки»: вебхук — секрет Telegram першим рядком; кнопка = TAKE_PREFIX; callback у allowed_updates; межі в реєстрі й матриці; старт реєструє вебхук", () => {
  const route = read("backend/src/routes/leadsBot.ts");
  const wh = route.slice(route.indexOf('leadsBotRouter.post("/webhook"'));
  assert.match(wh, /^leadsBotRouter\.post\("\/webhook", async \(req, res\) => \{\s*const secret = leadsWebhookSecret\(\);\s*if \(!secret \|\| req\.header\("X-Telegram-Bot-Api-Secret-Token"\) !== secret\) return res\.status\(401\)/,
    "🔴 вебхук бота діє раніше, ніж перевірив секрет Telegram");
  assert.match(route, /cq\.data\?\.startsWith\(TAKE_PREFIX\)/, "🔴 кнопку читають не тим префіксом, яким її шле черга");
  for (const p of ['leadsBotRouter.get("/me", requireAuth', 'leadsBotRouter.post("/link", requireAuth', 'leadsBotRouter.post("/unlink", requireAuth']) assert.ok(route.includes(p), `🔴 ${p} без requireAuth`);
  assert.match(read("backend/src/bot/leadsBot.ts"), /allowed_updates: \["message", "callback_query"\]/, "🔴 Telegram не надсилатиме натиск «Взяти»");
  const gates = read("backend/src/auth/gates.ts"), matrix = read("backend/src/auth/accessMatrix.ts");
  for (const [m, p] of [["POST", "/api/leads-bot/webhook"], ["GET", "/api/leads-bot/me"], ["POST", "/api/leads-bot/link"], ["POST", "/api/leads-bot/unlink"]]) {
    assert.ok(gates.includes(`{ method: "${m}", path: "${p}", permanent: true,`), `🔴 ${m} ${p} не в реєстрі виключень меж`);
    assert.ok(matrix.includes(`{ method: "${m}", path: "${p}", cls: "deny-only",`), `🔴 ${m} ${p} не в матриці`);
  }
  assert.match(read("backend/src/index.ts"), /\["leadsBotEnsureWebhook", \(\) => leadsBotEnsureWebhook\(\)\]/, "🔴 вебхук бота заявок не реєструється на старті");
});

test("#3414 статистика за роллю: менеджер — лише свої рядки й заявки, тімлід — своя команда, керівництво — усі; «Даші» й черга — лише керівництву", async (t) => {
  const c = await ctx(t);
  if (!c) return;
  const { linkedinScope, loadLinkedinStats } = await import("./linkedinStats.js");
  assert.deepEqual(linkedinScope({ role: "manager", managerId: 7, teamId: 5 }), { kind: "own", managerId: 7 });
  assert.deepEqual(linkedinScope({ role: "team_lead", managerId: 3, teamId: 5 }), { kind: "team", teamId: 5 });
  assert.deepEqual(linkedinScope({ role: "admin", managerId: null, teamId: null }), { kind: "all" });
  assert.deepEqual(linkedinScope({ role: "manager", managerId: null, teamId: null }), { kind: "own", managerId: -1 }, "🔴 менеджер без привʼязки побачив би всіх");
  const q = (sql: string, p: unknown[] = []) => c.raw.query(sql, p);
  await q(`TRUNCATE linkedin_queue_items, linkedin_queue_log, linkedin_queue_members, linkedin_queue_settings`);
  await q(`DELETE FROM managers WHERE kommo_user_id BETWEEN 920000 AND 920002`);
  const t1 = (await q(`INSERT INTO teams (name) VALUES ('LQ команда 1') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).rows[0].id as number;
  const t2 = (await q(`INSERT INTO teams (name) VALUES ('LQ команда 2') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).rows[0].id as number;
  const mk = async (n: string, team: number, k: number) => (await q(`INSERT INTO managers (name, is_active, kommo_user_id, team_id) VALUES ($1, true, $2, $3) RETURNING id`, [n, k, team])).rows[0].id as number;
  const A = await mk("Скоуп А", t1, 920000), B = await mk("Скоуп Б", t1, 920001), C = await mk("Скоуп В", t2, 920002);
  const at = "2026-11-04T09:00:00Z";
  for (const [id, who] of [[7301, A], [7302, B], [7303, C]] as const) {
    await q(`INSERT INTO linkedin_queue_items (kommo_id, deal_name, seen_at, state, manager_id, offered_ids) VALUES ($1, $2, $3, 'offered', $4, ARRAY[$4]::int[])`, [id, `Угода ${String(id)}`, at, who]);
    await q(`INSERT INTO linkedin_queue_log (kommo_id, kind, manager_id, mode, at) VALUES ($1, 'seen', NULL, 'live', $2), ($1, 'offer', $3, 'live', $2)`, [id, at, who]);
  }
  await q(`INSERT INTO linkedin_queue_log (kommo_id, kind, note, mode, at) VALUES (7399, 'dispatcher', 'клієнт уже в когось', 'live', $1)`, [at]);
  const day = ["2026-11-04", "2026-11-04", "", new Date(at)] as const;
  const own = await loadLinkedinStats(c.db, ...day, { kind: "own", managerId: A });
  assert.deepEqual(own.perManager.map((m) => m.name), ["Скоуп А"], "🔴 менеджер бачить чужі рядки");
  assert.deepEqual(own.items.map((i) => i.kommoId), [7301], "🔴 менеджер бачить чужі заявки");
  assert.deepEqual([own.kpi.created, own.kpi.dispatcher, own.queue.nextName, own.scope], [1, null, null, "own"]);
  const team = await loadLinkedinStats(c.db, ...day, { kind: "team", teamId: t1 });
  assert.deepEqual(team.perManager.map((m) => m.name).sort(), ["Скоуп А", "Скоуп Б"], "🔴 тімлід бачить людей з іншої команди");
  assert.deepEqual(team.items.map((i) => i.kommoId).sort(), [7301, 7302]);
  const all = await loadLinkedinStats(c.db, ...day, { kind: "all" });
  assert.deepEqual(all.perManager.map((m) => m.name).sort(), ["Скоуп А", "Скоуп Б", "Скоуп В"], "🔴 керівництво бачить не всіх");
  assert.deepEqual([all.kpi.created, all.kpi.dispatcher], [3, 1]);
  const empty = await loadLinkedinStats(c.db, ...day, { kind: "own", managerId: -1 });
  assert.deepEqual([empty.perManager.length, empty.items.length, empty.kpi.created], [0, 0, 0], "🔴 порожній скоуп показав дані");
  assert.ok(C > 0);
});

test("#3415 «Підключіть бот заявок»: менеджер і тімлід зі стажем від 1 місяця — так; менше місяця чи невідома дата — ні (хіба вже в колі); інші ролі — ні", async (t) => {
  const c = await ctx(t);
  if (!c) return;
  const { leadsBotStatus } = await import("./leadsBotLink.js");
  const q = (sql: string, p: unknown[] = []) => c.raw.query(sql, p);
  await q(`DELETE FROM users WHERE email LIKE 'elig-%@uts.test'`);
  await q(`DELETE FROM employees WHERE import_key LIKE 'Стаж %'`);
  const now = new Date("2026-11-04T09:00:00Z");
  const person = async (tag: string, role: string, hired: string | null, inQueue = false) => {
    const m = (await q(`INSERT INTO managers (name, is_active) VALUES ($1, true) RETURNING id`, [`Стаж ${tag}`])).rows[0].id as number;
    const u = (await q(`INSERT INTO users (email, password_hash, role, role_override, manager_id) VALUES ($1, 'x', 'manager', $2, $3) RETURNING id`,
      [`elig-${tag}@uts.test`, role === "manager" ? null : role, m])).rows[0].id as number;
    if (hired) await q(`INSERT INTO employees (full_name, import_key, status, hired_at, manager_id) VALUES ($1, $1, 'active', $2, $3)`, [`Стаж ${tag}`, hired, m]);
    if (inQueue) await q(`INSERT INTO linkedin_queue_members (manager_id, position) VALUES ($1, 99)`, [m]);
    return (await leadsBotStatus(c.db, u, now)).eligible;
  };
  assert.equal(await person("m-old", "manager", "2026-10-04"), true, "🔴 менеджер зі стажем місяць не бачить плашки");
  assert.equal(await person("tl-old", "team_lead", "2026-01-10"), true, "🔴 тімлід зі стажем не бачить плашки");
  assert.equal(await person("m-new", "manager", "2026-10-20"), false, "🔴 менеджер без місяця стажу бачить плашку");
  assert.equal(await person("m-unk", "manager", null), false, "🔴 невідома дата виходу = стаж є");
  assert.equal(await person("m-q", "manager", null, true), true, "🔴 Юля внесла в коло, а плашки немає — заявки не дійдуть");
  assert.equal(await person("hr", "hr", "2025-01-01"), false, "🔴 HR бачить плашку бота заявок");
});

test("#3416 «створено з початку етапу»: тік пише всі угоди етапу (і до запуску бота), без дублів; раз на добу — ті, що пішли; перенесені з іншого етапу не рахуються; межі дат по-київськи включно; лише керівництву", async (t) => {
  const c = await ctx(t);
  if (!c) return;
  const { sweepStageHistory, SWEEP_EVERY_MS } = await import("./linkedinStageDeals.js");
  const { loadLinkedinStats } = await import("./linkedinStats.js");
  const q = (sql: string, p: unknown[] = []) => c.raw.query(sql, p);
  await q(`TRUNCATE linkedin_stage_deals, linkedin_queue_items, linkedin_queue_log, linkedin_queue_members, linkedin_queue_settings`);
  const lead = (id: number, iso: string): StageLead => ({ id, name: `Етап ${String(id)}`, createdAt: Z(iso), responsibleUserId: 1 });
  // Жовтень після 25.10 — Київ = UTC+2. 8001: 30.10 00:30 (перший день — так); 8005 — на етапі, але прийшов з іншого етапу.
  const stage = [lead(8001, "2026-10-29T22:30:00Z"), lead(8005, "2026-10-30T10:00:00Z"), lead(8002, "2026-11-04T08:01:00Z")];
  const tick = (iso: string) => runLinkedinQueueTick({ db: c.db, mode: "dry", now: () => new Date(iso), stageLeads: async () => stage, ownerOf: async () => null });
  await tick("2026-11-04T08:02:00Z");
  await tick("2026-11-04T08:04:00Z");
  assert.deepEqual((await q(`SELECT kommo_id::int AS id FROM linkedin_stage_deals ORDER BY 1`)).rows.map((r) => r.id), [8001, 8002, 8005],
    "🔴 тік не записав угоди етапу (або записав двічі) — старі угоди до запуску бота мають бути в списку");
  // Пішли з етапу: 8003 — 29.10 23:30 (до періоду), 8004 — 31.10 23:30 (останній день — так), 8006 — 01.11 00:30 (після).
  const gone = new Map([lead(8003, "2026-10-29T21:30:00Z"), lead(8004, "2026-10-31T21:30:00Z"), lead(8006, "2026-10-31T22:30:00Z"), lead(8005, "2026-10-30T10:00:00Z")].map((l) => [l.id, l]));
  const deps = { leftIds: async () => [8003, 8004, 8006, 8003], movedInIds: async () => [8005], leads: async (ids: number[]) => ids.map((id) => gone.get(id)!).filter(Boolean) };
  const t0 = new Date("2026-11-04T09:00:00Z");
  assert.deepEqual(await sweepStageHistory(c.db, deps, t0), { left: 3, movedIn: 1 });
  assert.equal(await sweepStageHistory(c.db, deps, new Date(t0.getTime() + 3600_000)), null, "🔴 добір історії ходить у Kommo частіше за раз на добу");
  assert.ok(await sweepStageHistory(c.db, deps, new Date(t0.getTime() + SWEEP_EVERY_MS + 1)), "🔴 за добу добір історії не повторився");
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM linkedin_stage_deals`)).rows[0].n, 6);
  assert.equal((await q(`SELECT moved_in FROM linkedin_stage_deals WHERE kommo_id = 8005`)).rows[0].moved_in, true, "🔴 перенесену на етап угоду не позначено");
  const all = await loadLinkedinStats(c.db, "2026-10-30", "2026-10-31", "", t0, { kind: "all" });
  assert.deepEqual(all.stage, { created: 2, firstDay: "2026-10-29", byDay: [{ day: "2026-10-30", count: 1 }, { day: "2026-10-31", count: 1 }] },
    "🔴 «створено по днях»: межі періоду не по-київськи включно або перенесена угода порахована як створена");
  const own = await loadLinkedinStats(c.db, "2026-10-30", "2026-10-31", "", t0, { kind: "own", managerId: -1 });
  assert.equal(own.stage, null, "🔴 менеджер бачить усі угоди етапу");
  const team = await loadLinkedinStats(c.db, "2026-10-30", "2026-10-31", "", t0, { kind: "team", teamId: -1 });
  assert.equal(team.stage, null, "🔴 тімлід бачить усі угоди етапу");
  assert.equal(all.kpi.created, 0, "🔴 старі угоди потрапили в журнал бота — «взяли через бота» рахувався б від них");
});

test("#3417 екран: «Пішли на Операційного директора» — без «Даші»; «Створено» керівництву — з угод етапу; джоба черги щодня добирає історію етапу", () => {
  const ui = read("frontend/src/pages/dashboard/sections/LinkedinSection.tsx");
  assert.match(ui, /<span className="kpi-label">Пішли на Операційного директора<\/span>/, "🔴 плитку не перейменовано");
  assert.doesNotMatch(ui, /Даш/, "🔴 на екрані лишилась «Даша» (Роман 06.11.2026: «Пішли на Операційного директора»)");
  assert.match(ui, /\{s\.stage \? s\.stage\.created : k\.created\}/, "🔴 «Заявок створено» керівництву не з угод етапу");
  const job = read("backend/src/jobs/linkedinQueueJob.ts");
  const body = job.slice(job.indexOf("export async function linkedinQueueJob"), job.indexOf("async function stageEventIds"));
  assert.match(body, /\bawait sweepLinkedinStageHistory\(\)/, "🔴 джоба черги не добирає угоди, що пішли з етапу");
  assert.match(job, /filter\[\$\{side\}\]\[leads_statuses\]\[0\]\[status_id\]=\$\{String\(statusId\)\}/, "🔴 події Kommo не відфільтровано по етапу LinkedIn");
});
