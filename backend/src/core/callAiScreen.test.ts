import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./adCallFacts.js";
import { aiCallState, AI_CALL_STATES, TRANSCRIPT_ROLES, transcriptAllowed, FIRST_TOUCH_TRANSCRIPT_ROLES } from "./callAiScreen.js";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";

/**
 * 🎯 #830–#834 — ЕКРАН «ПЕРШИЙ ДОТИК · AI», прохід 1 (лише перегляд, рішення Романа 28.09.2026).
 * Живі гейти — на scratch-базі (свій кластер на файл, сесія в UTC); фронт — транспіляцією `.ts`,
 * як у `#462`: правила ВИКОНУЮТЬСЯ, регулярками по TSX перевіряється лише проводка.
 */

const NOW = new Date("2026-09-28T09:00:00Z");
const FAKE_AD = { predicate: (r: string) => `(d.client_source = ANY(${r}))`, adSources: ["uts.ua"] };
const SRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url));

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
    await seed(c);
    dispose = async () => { await c.end().catch(() => {}); s.dispose(); };
    return { db: c as unknown as Db, raw: c };
  })();
  const r = await ctxP;
  if ("unavailable" in r) { t.skip(r.unavailable); return null; }
  return r;
}

const RESULT = {
  conversation_type: "cargo_request", type_confidence: 0.95, type_reason: "клієнт питає ціну перевезення", price_value: "",
  summary: "Клієнт питає ціну тенту Київ–Львів", manager_channel: "1", client_request: "тент 20 т", next_step: "передзвонити з ціною",
  price: { discussed: true, quote: "скільки коштує", quote_found: true },
  objections: [{ what: "дорого", quote: "у конкурентів дешевше", quote_found: false }],
  promises: [
    { who: "manager", what: "порахувати", deadline_text: "до обіду", quote: "порахую до обіду", quote_found: true, channel: "call", deadline_kind: "day", deadline_minutes: 0, deadline_date: "2026-09-20", conditional: false },
    { who: "manager", what: "надіслати договір", deadline_text: "", quote: "надішлю договір", quote_found: true, channel: "message", deadline_kind: "none", deadline_minutes: 0, deadline_date: "", conditional: false },
  ],
};

async function seed(c: import("pg").Client): Promise<void> {
  await c.query("INSERT INTO teams(id,name) VALUES (901,'AI-Т1'),(902,'AI-Т2')");
  await c.query("INSERT INTO managers(id,name,team_id) VALUES (9011,'Олена Т1',901),(9021,'Петро Т2',902)");
  const deal = (id: number, key: string, created: string) => c.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel)
    VALUES ($1,$2,8921932,1,$3,$4,'ad')`, [id, `D${String(id)}`, created, key]);
  await deal(8801, "0508800001", "2026-09-20 10:00:00+03");
  await deal(8802, "0508800002", "2026-09-21 10:00:00+03");
  await deal(8803, "0508800003", "2026-09-22 10:00:00+03");
  const call = (u: string, at: string, type: string, sec: number, mgr: number | null, phone: string) =>
    c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,manager_id,client_phone,recording)
      VALUES ($1,$2,$3,'ANSWERED',$4,$5,$6,$7,'https://rec/x')`, [u, at, type, sec, sec + 5, mgr, phone]);
  await call("x1", "2026-09-20 10:30:00+03", "out", 40, 9011, "380508800001");
  await call("x1b", "2026-09-20 14:00:00+03", "out", 10, 9011, "380508800001");   // наш наступний вихідний
  await call("x2", "2026-09-21 10:30:00+03", "in", 60, 9021, "380508800002");
  await call("x3", "2026-09-22 10:30:00+03", "out", 30, null, "380508800003");    // хто дзвонив — невідомо
  const tid = (await c.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ('x1','elevenlabs','scribe_v2','done',$1::jsonb) RETURNING id`,
  [JSON.stringify([{ channel: 1, start: 0, end: 2, text: "Скільки коштує, порахую до обіду", lang: "ukr" }])])).rows[0].id;
  await c.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result)
    VALUES ($1,'google','gemini-3.8-flash','first-touch-v2','done',$2::jsonb)`, [tid, JSON.stringify(RESULT)]);
  await c.query("INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES ('x2','elevenlabs','scribe_v2','capped')");
}

/**
 * #830 — СПИСОК: рівно перші розмови реклами за період (та сама вибірка, що в джобі), кожна зі
 * СВОЇМ станом (готово / стеля / ще не в черзі — не нуль і не пропуск); «проаналізовано» == рядків
 * `done` у базі; тімлід бачить лише свою команду й не бачить дзвінка без відомого менеджера;
 * менеджер без привʼязки (кламп −1) — нікого.
 * 🧨 Червоніє, якщо прибрати фільтр скоупу, підставити 0 замість −1 чи злити стани.
 */
test("#830 ЕКРАН AI · ЖИВА СХЕМА: список = вибірка джоби, чесні стани, скоуп тімліда й менеджера", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { aiCallsList } = await import("./callAiScreen.js");
  const { missedScopeFor } = await import("./missedCallsRules.js");
  const all = await aiCallsList(c.db, FAKE_AD, "2026-09-01", "2026-09-30", NOW, {});
  assert.deepEqual(all.rows.map((r) => [r.uniqueid, r.state]).sort(), [["x1", "done"], ["x2", "capped"], ["x3", "not_queued"]],
    "🔴 список — не перші розмови з чесними станами");
  const x1 = all.rows.find((r) => r.uniqueid === "x1")!;
  assert.deepEqual([x1.priceDiscussed, x1.objections, x1.promises, x1.promisesWithDeadline, x1.unverifiedQuotes], [true, 1, 2, 1, 1]);
  const doneInDb = (await c.raw.query<{ n: number }>("SELECT count(*)::int n FROM call_analyses WHERE status='done'")).rows[0].n;
  assert.equal(all.rows.filter((r) => r.state === "done").length, doneInDb, "🔴 «проаналізовано» на екрані ≠ рядків done у базі");

  const t1 = await aiCallsList(c.db, FAKE_AD, "2026-09-01", "2026-09-30", NOW, missedScopeFor({ role: "team_lead", managerId: null, teamId: 901 }, {}));
  assert.deepEqual(t1.rows.map((r) => r.uniqueid), ["x1"], "🔴 тімлід бачить чужу команду або дзвінок без менеджера");
  const t2 = await aiCallsList(c.db, FAKE_AD, "2026-09-01", "2026-09-30", NOW, missedScopeFor({ role: "team_lead", managerId: null, teamId: 902 }, {}));
  assert.deepEqual(t2.rows.map((r) => r.uniqueid), ["x2"], "дзеркало: інший тімлід бачить СВОЮ команду");
  const m = await aiCallsList(c.db, FAKE_AD, "2026-09-01", "2026-09-30", NOW, missedScopeFor({ role: "manager", managerId: null, teamId: null }, {}));
  assert.equal(m.rows.length, 0, "🔴 менеджер без привʼязки побачив дзвінки всієї компанії — порожній скоуп виражено нулем");
  const sep = await aiCallsList(c.db, FAKE_AD, "2026-09-21", "2026-09-21", NOW, {});
  assert.deepEqual(sep.rows.map((r) => r.uniqueid), ["x2"], "🔴 період — не за датою створення угоди (Київ)");
});

/**
 * #832 — КАРТКА: повний текст — лише admin і kvp; тімліду — витяг із цитатами без тексту (дзеркало:
 * КВП текст отримує); чужий дзвінок — `null` (404), а не порожня картка; «наш наступний вихідний» —
 * перший вихідний після розмови з Ringostat.
 * 🧨 Червоніє, якщо віддати текст усім, сховати його від КВП, чи відкрити картку поза скоупом.
 */
test("#860 ЕКРАН AI · ЖИВА СХЕМА: картка — текст тімліду своєї команди й менеджеру своїх; чужий дзвінок 404; наступний вихідний", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { aiCallCard, transcriptAllowed, FIRST_TOUCH_TRANSCRIPT_ROLES: R } = await import("./callAiScreen.js");
  const kvp = await aiCallCard(c.db, "x1", transcriptAllowed({ roleKey: "kvp" }, R), {});
  assert.ok(kvp && kvp.turns && kvp.turns.length === 1 && !kvp.transcriptHidden, "дзеркало: КВП мусить бачити текст");
  const admin = await aiCallCard(c.db, "x1", transcriptAllowed({ roleKey: "admin" }, R), {});
  assert.ok(admin?.turns, "дзеркало: адмін мусить бачити текст");
  const lead = await aiCallCard(c.db, "x1", transcriptAllowed({ roleKey: "team_lead" }, R), { teamId: 901 });
  assert.ok(lead, "🔴 тімлід не відкрив картку своєї команди");
  assert.ok(lead.turns, "🔴 тімлід своєї команди не отримав повного тексту (ТЗ 30.09.2026)");
  assert.equal(lead.transcriptHidden, false);
  const own = await aiCallCard(c.db, "x1", transcriptAllowed({ roleKey: "manager" }, R), { managerId: 9011 });
  assert.ok(own?.turns, "🔴 менеджер не отримав тексту СВОЄЇ розмови");
  assert.equal(await aiCallCard(c.db, "x1", true, { managerId: 9021 }), null, "🔴 менеджер відкрив чужу розмову");
  assert.equal(lead.result?.promises.length, 2, "🔴 тімлід не бачить витягу з цитатами");
  for (const role of ["ceo", "opdir"]) assert.ok((await aiCallCard(c.db, "x1", transcriptAllowed({ role: "admin", roleKey: role }, R), {}))?.turns, `🔴 ${role} не отримав повного тексту (рішення 29.09.2026)`);
  assert.equal((await aiCallCard(c.db, "x1", transcriptAllowed({ role: "admin", roleKey: "financier" }, R), {}))?.turns, null, "🔴 фінансист отримав повний текст");
  assert.equal(await aiCallCard(c.db, "x2", false, { teamId: 901 }), null, "🔴 тімлід відкрив картку чужої команди");
  assert.equal(await aiCallCard(c.db, "x3", false, { teamId: 901 }), null, "🔴 тімлід відкрив дзвінок без відомого менеджера");
  assert.equal(kvp.nextOutboundAt, new Date("2026-09-20T11:00:00Z").toISOString(), "🔴 наступний вихідний — не перший після розмови");
  assert.deepEqual(kvp.row.kommoIds, [8801]);
  assert.equal(kvp.managerChannel, 1);
});

/**
 * #833 — СТАНИ: кожне поєднання «розпізнавання × аналіз» дає свій стан, усі дев’ять досяжні, і фронт
 * має підпис рівно для кожного з них — жодного «0» замість стану.
 * 🧨 Червоніє, якщо злити два стани в один або додати стан на бекенді без підпису на фронті.
 */
test("#799 СТАНИ: розпізнавання × аналіз × порожній текст → десять станів, «Розмова без тексту» окремо, фронт підписує кожен", async () => {
  const stt = [null, "not_enabled", "queued", "working", "capped", "recording_unavailable", "failed", "done"];
  const llm = [null, "queued", "working", "not_enabled", "capped", "failed", "done"];
  const seen = new Set<string>();
  for (const a of stt) for (const b of llm) for (const e of [false, true]) seen.add(aiCallState(a, b, e));
  assert.deepEqual([...seen].sort(), [...AI_CALL_STATES].sort(), "🔴 не всі стани досяжні або зʼявився зайвий");
  assert.equal(aiCallState(null, null), "not_queued");
  assert.equal(aiCallState("capped", null), "capped");
  assert.equal(aiCallState("done", "capped"), "capped");
  assert.equal(aiCallState("done", "failed"), "llm_failed");
  assert.equal(aiCallState("failed", null), "stt_failed");
  assert.equal(aiCallState("done", null), "llm_pending");
  assert.equal(aiCallState("done", null, true), "no_text", "🔴 розмова без тексту висить «Аналіз у черзі» назавжди");
  assert.equal(aiCallState("queued", null, true), "queued", "порожнеча має сенс лише для ГОТОВОГО розпізнавання");
  const V = await loadView();
  assert.deepEqual(Object.keys(V.STATE_UI).sort(), [...AI_CALL_STATES].sort(), "🔴 фронт і бекенд знають різні стани");
  const labels = Object.values(V.STATE_UI).map((x) => x.label);
  assert.equal(new Set(labels).size, labels.length, "🔴 два стани з однаковим підписом — причина злилась");
});

/**
 * #831 — ДОСТУП: ролі в матриці для кожного роута екрана == ролі в сиді вкладки (admin, kvp, ceo,
 * opdir, team_lead); менеджер, фінансист і HR — у deny; межа роутів — вкладка `ai-calls`; ролі з
 * правом на повний текст — підмножина ролей вкладки.
 * 🧨 Червоніє, якщо розвести сид і матрицю або прибрати межу роута.
 */
test("#861 ДОСТУП: матриця читання = сид вкладки (з менеджером), межа роута — ai-calls, текст — усім ролям вкладки у своєму скоупі", async () => {
  const schema = SRC("db/schema.sql");
  const m = /UPDATE roles SET screen_access = screen_access \|\| '\{"ai-calls":true\}'::jsonb\s+WHERE key IN \(([^)]+)\)/.exec(schema);
  assert.ok(m, "🔴 сиду вкладки ai-calls у схемі немає — вкладку не побачить ніхто, навіть адмін");
  const seeded = m[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  assert.deepEqual(seeded, ["admin", "ceo", "kvp", "manager", "opdir", "team_lead"]);
  const rows = ACCESS_MATRIX.filter((r) => r.path.startsWith("/api/dashboard/ai-calls") && r.method === "GET");
  assert.equal(rows.length, 5, "🔴 не всі роути читання екрана в матриці (список, meta, звіт тімліда, картка, запис)");
  for (const r of rows) {
    assert.deepEqual([...r.allow].sort(), seeded, `🔴 ${r.path}: матриця ≠ сид вкладки`);
    for (const d of ["financier", "hr"]) assert.ok(r.deny.includes(d as never), `🔴 ${r.path}: ${d} не в deny`);
  }
  const { tabsForPath } = await import("../auth/routeTab.js");
  for (const p of ["/api/dashboard/ai-calls", "/api/dashboard/ai-calls/meta", "/api/dashboard/ai-calls/123.45"])
    assert.deepEqual(tabsForPath(p), ["ai-calls"], `🔴 ${p} без межі вкладки`);
  for (const role of TRANSCRIPT_ROLES) assert.ok(seeded.includes(role), `🔴 ${role} бачить текст, але не бачить вкладки`);
  assert.deepEqual([...TRANSCRIPT_ROLES].sort(), ["admin", "kvp"]);
  assert.deepEqual([...FIRST_TOUCH_TRANSCRIPT_ROLES].sort(), seeded, "🔴 текст «Першого дотику» не збігається з ролями вкладки (ТЗ 30.09.2026)");
  assert.match(SRC("routes/dashboard.ts"), /const canSeeExcluded = req\.auth!\.roleKey !== "manager";/, "🔴 менеджер бачить «Виключені» (ТЗ 30.09.2026 п.7: лише тімлід і адмін)");
});

interface ViewMod {
  sortManagerLines: (ls: readonly Record<string, unknown>[], s: { key: string; dir: string }) => { name: string }[];
  nextMgrSort: (cur: { key: string; dir: string }, key: string) => { key: string; dir: string };
  parseMgrSort: (raw: string | null) => { key: string; dir: string };
  MGR_SORT_DEFAULT: { key: string; dir: string };
  STATE_UI: Record<string, { label: string; tone: string; hint: string }>;
  matchesFilter: (r: { state: string; priceDiscussed: boolean | null; objections: number; promises: number; promisesWithDeadline: number }, f: string) => boolean;
  speakerOf: (channel: number, managerChannel: number | null) => string;
  afterLabel: (fromIso: string, toIso: string | null) => string;
  jobErrorIsCurrent: (job: { lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null } | null) => boolean;
  parseCallParam: (search: string) => string | null;
  withCallParam: (href: string, uniqueid: string | null) => string;
  drawerTabs: (transcriptHidden: boolean, turns: number | null) => string[];
  promisesLabel: (promises: number, withDeadline: number) => string;
  blobErrorBody: (data: unknown) => Promise<unknown>;
  quoteTurnIndex: (turns: readonly { text: string }[] | null, quote: string) => number;
  managerChecklist: (rows: readonly unknown[]) => { name: string; calls: number; score: number | null; request: number | null; price: number | null; promise: number | null }[];
  avgScore3: (s: readonly ({ yes: number; total: number } | null)[]) => number | null;
  markPct: (cls: readonly (Record<string, string> | null)[], key: string) => number | null;
  aiDefaultPeriod: (today: string) => { mode: string; anchor: string };
  avgScorePct: (s: readonly ({ yes: number; total: number } | null)[]) => number | null;
  tileStats: (rows: readonly unknown[]) => { noCall: { n: number; of: number }; price: { yes: number; of: number; pct: number | null }; objection: { handled: number; of: number; pct: number | null }; lost: number; success: { n: number; of: number } };
  TILE_MATCH: Record<string, (r: unknown) => boolean>;
  priceSuccessSplit: (rows: readonly unknown[]) => { named: { n: number; of: number }; notNamed: { n: number; of: number }; enough: boolean };
  queueRows: (rows: readonly { needsReview: boolean; reviewReason: string | null; calledAt: string; uniqueid?: string }[]) => { uniqueid?: string }[];
}
async function transpile(rel: string, deps: Record<string, string> = {}): Promise<string> {
  const ts = (await import("typescript")).default;
  let js = ts.transpileModule(readFileSync(FE(rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [spec, url] of Object.entries(deps)) js = js.split(`from "${spec}"`).join(`from "${url}"`);
  return `data:text/javascript,${encodeURIComponent(js)}`;
}
async function loadView(): Promise<ViewMod> {
  const period = await transpile("pages/dashboard/periodRules.ts");
  return await import(await transpile("pages/dashboard/aiCallsView.ts", { "./periodRules": period })) as ViewMod;
}

/**
 * #834 — ПРОВОДКА ФРОНТУ: пункт меню `ai-calls` у групі «Продаж», секція рендериться статичним
 * імпортом (не lazy — #225), кличе всі три роути, а правила вигляду виконуються: хто говорить на
 * каналі, фільтр «обіцянка без строку», підпис «вихідних не було».
 * 🧨 Червоніє, якщо відʼєднати секцію від меню чи роутів або зламати правило каналу.
 */
test("#834 ПРОВОДКА ФРОНТУ: меню → секція → три роути, правила вигляду виконуються", async () => {
  const layout = readFileSync(FE("components/Layout.tsx"), "utf8");
  assert.match(layout, /label: "Продаж",\s*items: \[\s*\{ key: "ai-calls"/, "🔴 пункту «Перший дотик · AI» у групі «Продаж» немає");
  const dash = readFileSync(FE("pages/Dashboard.tsx"), "utf8");
  assert.match(dash, /import \{ AiCallsSection \} from "\.\/dashboard\/sections\/AiCallsSection";/, "🔴 секція не імпортована статично");
  assert.match(dash, /section === "ai-calls" && \([\s\S]{0,200}<AiCallsSection \/>/, "🔴 секція не рендериться на своєму ключі");
  assert.doesNotMatch(dash, /lazy\([^)]*AiCallsSection/, "🔴 lazy-імпорт розбив би бандл (#225)");
  // Картку з 29.09.2026 вантажить панель `AiCallDrawer.tsx` — секція разом із нею кличе всі три роути.
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8")
    + readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  for (const fn of ["fetchAiCalls(", "fetchAiCallCard(", "fetchAiCallsMeta("]) assert.ok(sec.includes(fn), `🔴 секція не кличе ${fn}`);
  const api = readFileSync(FE("api.ts"), "utf8");
  for (const p of ['"/dashboard/ai-calls"', '"/dashboard/ai-calls/meta"', "`/dashboard/ai-calls/${"]) assert.ok(api.includes(p), `🔴 api не ходить на ${p}`);
  const V = await loadView();
  assert.equal(V.speakerOf(1, 1), "Менеджер");
  assert.equal(V.speakerOf(0, 1), "Клієнт");
  assert.equal(V.speakerOf(0, null), "Канал 0", "🔴 невідомий канал менеджера видано за відомий");
  const r = { state: "done", priceDiscussed: true, objections: 0, promises: 2, promisesWithDeadline: 1 };
  assert.equal(V.matchesFilter(r, "noDeadline"), true);
  assert.equal(V.matchesFilter({ ...r, promisesWithDeadline: 2 }, "noDeadline"), false, "дзеркало: усі зі строком — не під фільтром");
  assert.match(V.afterLabel("2026-09-20T07:30:00Z", null), /не було/);
  assert.match(V.afterLabel("2026-09-20T07:30:00Z", "2026-09-20T11:00:00Z"), /3 год 30 хв/);
});

/**
 * #835 — ПРАВО НА ПОВНИЙ ТЕКСТ — ЗА КЛЮЧЕМ РОЛІ, А НЕ ЗА СУМІСНОЮ РОЛЛЮ. Приймання 28.09.2026: у
 * токені CEO й опдира `role === "admin"`, і роут, що перевіряв `auth.role`, віддав би їм повний
 * текст розмов. Тепер роут кличе `transcriptAllowed(auth)`, а та дивиться лише на `roleKey`.
 * 🧨 Червоніє, якщо роут знову передасть `auth.role` або функція гляне на `role`.
 */
test("#859 ПОВНИЙ ТЕКСТ «ПЕРШОГО ДОТИКУ» ЗА КЛЮЧЕМ РОЛІ: усі ролі вкладки — так (у своєму скоупі); фінансист і HR — ні", () => {
  const R = FIRST_TOUCH_TRANSCRIPT_ROLES;
  for (const key of ["financier", "hr"])
    assert.equal(transcriptAllowed({ role: "admin", roleKey: key }, R), false, `🔴 ${key} із сумісною роллю admin бачить повний текст`);
  for (const key of ["admin", "kvp", "ceo", "opdir", "team_lead", "manager"])
    assert.equal(transcriptAllowed({ role: "admin", roleKey: key }, R), true, `дзеркало: ${key} мусить бачити текст (ТЗ 30.09.2026: тімлід — команда, менеджер — свої)`);
  assert.equal(transcriptAllowed({ role: "admin" }, R), false, "🔴 токен без roleKey отримав текст за сумісною роллю");
  // «Перевізники за розмовою» ділять `transcriptAllowed` — їхній набір рішення 29.09 НЕ розширило.
  assert.equal(transcriptAllowed({ roleKey: "ceo" }), false, "🔴 розширення для «Першого дотику» протекло на типовий набір (Перевізники)");
  const seeded = ["admin", "kvp", "ceo", "opdir", "team_lead", "manager"];
  for (const r of R) assert.ok(seeded.includes(r), `🔴 ${r} бачить текст, але не бачить вкладки`);
  const route = SRC("routes/dashboard.ts");
  const at = route.indexOf('dashboardRouter.get("/ai-calls/:uniqueid"');
  assert.ok(at > 0, "🔴 роут картки не знайдено");
  const body = route.slice(at, route.indexOf("});", at));
  assert.match(body, /aiCallCard\(pool, [^,]+, transcriptAllowed\(auth, FIRST_TOUCH_TRANSCRIPT_ROLES\),/, "🔴 роут картки вирішує право на текст не через transcriptAllowed(auth, FIRST_TOUCH_TRANSCRIPT_ROLES)");
});

/**
 * #836 — ОДИН ДЗВІНОК = ОДИН РЯДОК. Розмова буває першою відразу для двох угод одного клієнта
 * (заміряно 28.09.2026: 19 із 1 100), і список показував її двічі, а шапка рахувала 1 119 замість
 * 1 100. Тепер рядок — дзвінок, і в ньому всі його угоди. Живий шматок спершу доводить, що вибірка
 * справді дає ДВІ пари (інакше гейт нічого б не перевіряв), потім — що на екрані рядок один.
 * 🧨 Червоніє, якщо прибрати згортання в `aiCallsList` або губити другу угоду.
 */
test("#836 ОДИН ДЗВІНОК = ОДИН РЯДОК: розмова, перша для двох угод, у списку раз і з обома угодами", async (t) => {
  const { collapseByCall } = await import("./callAiScreen.js");
  const base = { uniqueid: "u", calledAt: "2026-09-23T07:30:00.000Z", direction: "out" as const, billsec: 40,
    managerId: 1, managerName: "М", teamId: 1, teamName: "Т", state: "not_queued" as const, failure: null, summary: null,
    priceDiscussed: null, objections: 0, promises: 0, promisesWithDeadline: 0, unverifiedQuotes: 0,
    pipelineGroup: "full" as const, rejectReason: null, promiseState: null, managerPromises: 0, silentBeforeClose: null,
    conversationType: null, typeConfidence: null, typeReason: null, priceValue: null, inReport: true, typeCheck: false, typeOverride: null,
    priceNote: null, missedNote: null, offlineNote: null, reviewNote: null, hasRequest: false, objection: null, dealOutcome: null, clientPhone: null, firstOutboundAt: null, reactionMin: null, reactionOffHours: false };
  const got = collapseByCall([
    { ...base, kommoId: 9, dealCreatedAt: "2026-09-23T07:00:00.000Z" },
    { ...base, kommoId: 5, dealCreatedAt: "2026-09-22T07:00:00.000Z" },
    { ...base, uniqueid: "v", kommoId: 7, dealCreatedAt: "2026-09-23T07:00:00.000Z" },
  ]);
  assert.deepEqual(got.map((r) => [r.uniqueid, r.kommoIds, r.dealCreatedAt]),
    [["u", [5, 9], "2026-09-22T07:00:00.000Z"], ["v", [7], "2026-09-23T07:00:00.000Z"]],
    "🔴 дзвінок двох угод не згорнуто в один рядок або загублено угоду");

  const c = await ctx(t); if (!c) return;
  const { aiCallsList } = await import("./callAiScreen.js");
  for (const id of [8804, 8805])
    await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel)
      VALUES ($1,$2,8921932,1,'2026-09-23 09:00:00+03','0508800004','ad')`, [id, `D${String(id)}`]);
  await c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,manager_id,client_phone,recording)
    VALUES ('x4','2026-09-23 10:30:00+03','out','ANSWERED',40,45,9011,'380508800004','https://rec/x')`);
  const { adDealFirstTalksSql } = await import("./adCallFactsRules.js");
  const { FIRST_TOUCH_RULE } = await import("./callAiTick.js");
  const q = adDealFirstTalksSql({ from: "2026-09-23", to: "2026-09-23", now: NOW, talkMinSec: FIRST_TOUCH_RULE.talkMinSec,
    windowBefore: FIRST_TOUCH_RULE.windowBefore, adDealPredicate: FAKE_AD.predicate, adSources: FAKE_AD.adSources }, FIRST_TOUCH_RULE.flag, 100);
  const pairs = (await c.raw.query<{ uniqueid: string }>(q.sql, q.params)).rows.filter((r) => r.uniqueid === "x4").length;
  assert.equal(pairs, 2, "фікстура: вибірка мусить дати ДВІ пари угода→розмова, інакше гейт нічого не перевіряє");
  const list = await aiCallsList(c.db, FAKE_AD, "2026-09-23", "2026-09-23", NOW, {});
  assert.deepEqual(list.rows.map((r) => [r.uniqueid, r.kommoIds]), [["x4", [8804, 8805]]], "🔴 дзвінок двох угод у списку двічі");
});

/**
 * #837 — СТАРА ПОМИЛКА НЕ ЧЕРВОНІЄ ПІСЛЯ УСПІХУ. 29.09.2026 екран о 07:45 показував червоним помилку
 * квоти з 23:45 попереднього дня, хоча після неї джоба відпрацювала успішно вісім разів. `job_runs`
 * помилку свідомо не стирає, тож рішення «актуальна чи минула» — за часом: червона лише без пізнішого успіху.
 * 🧨 Червоніє, якщо показувати червоним будь-яку помилку або ховати свіжу, чи якщо секція обійде правило.
 */
test("#837 ПЛАШКА КОНВЕЄРА: помилка до останнього успіху — минуле, після — червона, невідомий час — червона", async () => {
  const V = await loadView();
  const job = (ok: string | null, errAt: string | null) => ({ lastSuccessAt: ok, lastError: "квота", lastErrorAt: errAt });
  assert.equal(V.jobErrorIsCurrent(job("2026-09-29T04:45:00Z", "2026-09-28T20:45:00Z")), false, "🔴 стара помилка після успіху показана як актуальна");
  assert.equal(V.jobErrorIsCurrent(job("2026-09-28T20:00:00Z", "2026-09-28T20:45:00Z")), true, "🔴 свіжа помилка після успіху схована");
  assert.equal(V.jobErrorIsCurrent(job(null, "2026-09-28T20:45:00Z")), true, "🔴 помилка без жодного успіху схована");
  assert.equal(V.jobErrorIsCurrent(job("2026-09-29T04:45:00Z", null)), true, "🔴 помилка з невідомим часом схована");
  assert.equal(V.jobErrorIsCurrent({ lastSuccessAt: "x", lastError: null, lastErrorAt: null }), false);
  assert.equal(V.jobErrorIsCurrent(null), false);
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /meta\.job\?\.lastError && \(jobErrorIsCurrent\(meta\.job\)\s*\?/, "🔴 секція показує помилку, не питаючи jobErrorIsCurrent");
});

/**
 * #838 — КАРТКА ДЗВІНКА ПАНЕЛЛЮ СПРАВА (прохання Романа 29.09.2026, макет «6 · Картка дзвінка»). Клік по
 * рядку відкриває панель саме цього дзвінка, а не розгортає рядок; `?call=` відкриває її одразу й
 * пересилається; вкладки «Розшифровка» немає, коли сервер тексту не віддав (усі, крім адміна й КВП),
 * і вона є, коли віддав.
 * 🧨 Червоніє, якщо повернути розгортання, показати вкладку тексту всім, чи ігнорувати `?call=`.
 */
test("#838 КАРТКА ДЗВІНКА: рядок відкриває панель, ?call= відкриває її одразу, розшифровка — лише з текстом", async () => {
  const V = await loadView();
  assert.equal(V.parseCallParam("?call=de5_-1790664194.4245365"), "de5_-1790664194.4245365");
  assert.equal(V.parseCallParam("?tab=x&call=%3Cscript%3E"), null, "🔴 сміття з адреси пішло б запитом на сервер");
  assert.equal(V.parseCallParam(""), null);
  assert.equal(V.withCallParam("https://d.uts.ua/ai-calls?x=1", "u1.2"), "/ai-calls?x=1&call=u1.2");
  assert.equal(V.withCallParam("https://d.uts.ua/ai-calls?x=1&call=u1.2", null), "/ai-calls?x=1", "🔴 закриття картки лишило ?call= в адресі");
  assert.deepEqual(V.drawerTabs(true, null), ["analysis"], "🔴 вкладка розшифровки для ролі без права на текст");
  assert.deepEqual(V.drawerTabs(true, 14), ["analysis"], "🔴 текст прийшов, але права немає — вкладка все одно не показується");
  assert.deepEqual(V.drawerTabs(false, 14), ["analysis", "transcript"], "дзеркало: КВП мусить бачити вкладку розшифровки");
  assert.deepEqual(V.drawerTabs(false, 0), ["analysis"], "порожня розшифровка — без порожньої вкладки");
  assert.equal(V.promisesLabel(2, 1), "обіцянки: 1 з 2 зі строком");
  assert.equal(V.promisesLabel(0, 0), "обіцянок немає");

  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /onClick=\{\(\) => setOpen\(r\.uniqueid\)\}/, "🔴 клік по рядку не відкриває картку цього дзвінка");
  assert.match(sec, /<AiCallDrawer uniqueid=\{open\} onClose=\{closeCard\}[\s\S]{0,120}?\/>/, "🔴 секція не малює панель картки");
  assert.ok(!/colSpan=\{7\}/.test(sec), "🔴 повернулось розгортання рядка замість панелі");
  assert.match(sec, /useState<string \| null>\(\(\) => parseCallParam\(window\.location\.search\)\)/, "🔴 ?call= не відкриває картку при завантаженні");
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw, /const tabs = c \? drawerTabs\(c\.transcriptHidden, c\.turns\?\.length \?\? null\) : \[\];/, "🔴 вкладки картки не з правила drawerTabs");
  assert.match(drw, /const turns = c && tabs\.includes\("transcript"\) \? c\.turns : null;/, "🔴 розшифровка показується без перевірки права");
});

/**
 * #792 — ОБІЦЯНКИ, ВОРОНКА, НЕЦІЛЬОВІ, ТИША — ЖИВА СХЕМА (рішення Романа 29.09.2026). Прапорець «не передзвонив»
 * — на тому, хто ОБІЦЯВ (менеджер розмови), а не на відповідальному угоди (П7); дзвінок колеги до терміну —
 * «передзвонив» (П6-Б); Кваліфікація — своя група, «Дубль» — причина відмови з CRM (П8-Б); «тиша перед
 * закриттям» — межа 24 год ПО ОБИДВА боки: 29 год — так, 23 год — ні (П3).
 * 🧨 Червоніє, якщо прапорець піде на відповідального, дзвінок колеги не зарахується чи зсунеться поріг тиші.
 */
test("#851 ЕКРАН AI · ЖИВА СХЕМА: не передзвонив — на тому, хто обіцяв; колега НЕ рятує, сам — рятує; Кваліфікація й «Дубль»; тиша 24 год", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { aiCallsList } = await import("./callAiScreen.js");
  const deal = (id: number, key: string, pipeline: number, status: number, closed: string | null, reject: string | null) =>
    c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,closed_at_kommo,client_key,lead_channel,manager_id,reject_reason)
      VALUES ($1,$2,$3,$4,'2026-09-24 09:00:00+03',$5,$6,'ad',9021,$7)`, [id, `D${String(id)}`, pipeline, status, closed, key, reject]);
  const call = (u: string, at: string, sec: number, mgr: number, phone: string) =>
    c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,manager_id,client_phone,recording)
      VALUES ($1,$2,'out','ANSWERED',$3,$4,$5,$6,'https://rec/x')`, [u, at, sec, sec + 5, mgr, phone]);
  const analysed = async (u: string, minutes: number) => {
    const tid = (await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
      VALUES ($1,'elevenlabs','scribe_v2','done','[{"channel":1,"start":0,"end":2,"text":"передзвоню за пів години","lang":"ukr"}]'::jsonb) RETURNING id`, [u])).rows[0].id;
    const res = { ...RESULT, objections: [], promises: [{ who: "manager", what: "передзвонити", deadline_text: "за пів години", quote: "q", quote_found: true,
      channel: "call", deadline_kind: "minutes", deadline_minutes: minutes, deadline_date: "", conditional: false }] };
    await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result)
      VALUES ($1,'google','gemini-3.8-flash','first-touch-v2','done',$2::jsonb)`, [tid, JSON.stringify(res)]);
  };
  await deal(8810, "0508800010", 8921932, 1, null, null);
  await call("y1", "2026-09-24 10:00:00+03", 60, 9011, "380508800010");                 // обіцяла Олена, угода Петра
  await analysed("y1", 30);
  await deal(8811, "0508800011", 8921928, 143, "2026-09-25 16:00:00+03", "Дубль");
  await call("y2", "2026-09-24 10:00:00+03", 60, 9011, "380508800011");
  await call("y2b", "2026-09-24 10:10:00+03", 30, 9021, "380508800011");                // передзвонив колега — не рахується (30.09)
  await analysed("y2", 30);
  await deal(8812, "0508800012", 8921932, 143, "2026-09-25 09:00:00+03", null);          // 23 год після розмови
  await call("y3", "2026-09-24 10:00:00+03", 60, 9011, "380508800012");

  const rows = (await aiCallsList(c.db, FAKE_AD, "2026-09-24", "2026-09-24", NOW, {})).rows;
  const by = new Map(rows.map((r) => [r.uniqueid, r]));
  assert.deepEqual([by.get("y1")?.promiseState, by.get("y1")?.managerId], ["broken", 9011], "🔴 «не передзвонив» — не на тій, хто обіцяла");
  assert.equal(by.get("y2")?.promiseState, "broken", "🔴 дзвінок колеги до терміну виконав чужу обіцянку (рішення 30.09.2026: лише той, хто обіцяв)");
  assert.deepEqual([by.get("y2")?.pipelineGroup, by.get("y2")?.rejectReason], ["qualification", "Дубль"], "🔴 Кваліфікація чи причина відмови загубились");
  assert.equal(by.get("y1")?.pipelineGroup, "full");
  assert.equal(by.get("y2")?.silentBeforeClose, true, "🔴 29 год без нашого дзвінка — не «тиша перед закриттям»");
  assert.equal(by.get("y3")?.silentBeforeClose, false, "🔴 23 год — уже «тиша» (поріг 24 год зсунувся)");
  assert.equal(by.get("y1")?.silentBeforeClose, null, "відкрита угода — не застосовно, а не «тиші немає»");

  // на живій схемі: синк Ringostat застряг до терміну → «чекає», а не «не передзвонив».
  await c.raw.query(`INSERT INTO job_runs(name, last_success_at) VALUES ('syncRingostatCalls', '2026-09-24 10:20:00+03')
    ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`);
  const lag = new Map((await aiCallsList(c.db, FAKE_AD, "2026-09-24", "2026-09-24", NOW, {})).rows.map((r) => [r.uniqueid, r]));
  assert.equal(lag.get("y1")?.promiseState, "pending", "🔴 дзвінки ще не синхронізовано за межу, а вже «не передзвонив»");
  await c.raw.query("DELETE FROM job_runs WHERE name = 'syncRingostatCalls'");
  // дзеркало: та, що обіцяла, передзвонила через добу — «запізнилась» (без межі), а не «не передзвонила».
  await call("y1b", "2026-09-25 11:00:00+03", 40, 9011, "380508800010");
  const late = new Map((await aiCallsList(c.db, FAKE_AD, "2026-09-24", "2026-09-24", NOW, {})).rows.map((r) => [r.uniqueid, r]));
  assert.equal(late.get("y1")?.promiseState, "late", "🔴 передзвін того, хто обіцяв, через добу — не «запізнився»");

  // #799 на живій схемі: розпізнано, слів немає → «Розмова без тексту», а не вічне «Аналіз у черзі».
  await c.raw.query(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments) VALUES ('y3','elevenlabs','scribe_v2','done','[]'::jsonb)`);
  const empty = (await aiCallsList(c.db, FAKE_AD, "2026-09-24", "2026-09-24", NOW, {})).rows.find((r) => r.uniqueid === "y3");
  assert.equal(empty?.state, "no_text", "🔴 порожня розшифровка на живій схемі — не «Розмова без тексту»");
});

/**
 * #793 — ОБІЦЯНКИ НА ЕКРАНІ: кожен стан має підпис; фільтр «Не передзвонив»; нецільові сховані за замовчуванням
 * і видно, скільки прибрано; Кваліфікація — окрема група; секція й картка беруть стан із сервера, а не рахують самі.
 * 🧨 Червоніє, якщо показати нецільові за замовчуванням, прибрати фільтр чи картка перестане показувати термін.
 */
test("#793 ОБІЦЯНКИ НА ЕКРАНІ: підписи станів, фільтр «Не передзвонив», нецільові сховані з лічильником, Кваліфікація окремо", async () => {
  const V = await loadView() as unknown as ViewMod & {
    PROMISE_UI: Record<string, { label: string }>;
    applyListFilter: (rows: { pipelineGroup: string; teamId: number | null; managerId: number | null; nonTarget: boolean }[], f: Record<string, unknown>) => unknown[];
    deadlineBasisLabel: (b: string) => string;
  };
  for (const s of ["kept_talk", "kept_attempt_only", "client_called", "late", "pending", "broken", "unverifiable"]) assert.ok(V.PROMISE_UI[s]?.label, `🔴 стан ${s} без підпису`);
  assert.equal(V.matchesFilter({ state: "done", promiseState: "broken", priceDiscussed: null, objections: 0, promises: 1, promisesWithDeadline: 1 } as never, "broken"), true);
  assert.equal(V.matchesFilter({ state: "done", promiseState: "kept_talk", priceDiscussed: null, objections: 0, promises: 1, promisesWithDeadline: 1 } as never, "broken"), false);
  const rows = [
    { pipelineGroup: "full", teamId: 1, managerId: 11, nonTarget: false },
    { pipelineGroup: "qualification", teamId: 1, managerId: 11, nonTarget: true },
    { pipelineGroup: "qualification", teamId: 2, managerId: 21, nonTarget: false },
  ];
  const f = { group: "all", teamId: null, managerId: null, showNonTarget: false };
  assert.equal(V.applyListFilter(rows, f).length, 2, "🔴 нецільові показано за замовчуванням");
  assert.equal(V.applyListFilter(rows, { ...f, showNonTarget: true }).length, 3, "дзеркало: перемикач показує нецільові");
  assert.equal(V.applyListFilter(rows, { ...f, group: "qualification" }).length, 1);
  assert.equal(V.applyListFilter(rows, { ...f, teamId: 2 }).length, 1);
  assert.match(V.deadlineBasisLabel("default_minutes"), /20 хв/);
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /applyListFilter\(d\.rows, lf\)/, "🔴 список не проходить через фільтр воронки/команди/нецільових");
  assert.match(sec, /PROMISE_UI\[r\.promiseState\]/, "🔴 колонка «Обіцянка» не з серверного стану");
  assert.match(sec, /прибрано: \$\{String\(nonTargetHidden\)\}/, "🔴 не видно, скільки нецільових прибрано");
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw, /c\.promiseChecks\[i\]/, "🔴 картка не показує термін і стан обіцянки");
});


/**
 * #855 — «У ЗВІТ ЧИ У ВИКЛЮЧЕНІ» (ТЗ «звіт тімліда» 30.09.2026, п.2): запит на перевезення — у звіті; інший тип з
 * упевненістю < 0.85 — у звіті з «Перевірити тип»; ≥ 0.85 — у «Виключених»; ще не розібрано — у звіті; ручна
 * позначка важить більше за модель в ОБИДВА боки. Змінювати тип — лише адмін і тімлід.
 * 🧨 Червоніє, якщо зсунути 0.85, сховати непевне, дати моделі перебити людину чи відкрити зміну типу CEO.
 */
test("#855 ТИП РОЗМОВИ: вантаж — у звіт, непевне (< 0.85) — у звіт із «Перевірити тип», решта — у Виключені, ручна позначка сильніша", async () => {
  const { typeVerdict, TYPE_CONFIDENCE_MIN, canEditType } = await import("./callAiType.js");
  assert.equal(TYPE_CONFIDENCE_MIN, 0.85);
  assert.deepEqual(typeVerdict("cargo_request", 0.3, null), { inReport: true, typeCheck: false, source: "model" });
  assert.deepEqual(typeVerdict("carrier", 0.84, null), { inReport: true, typeCheck: true, source: "model" }, "🔴 непевне сміття сховано — ризик втратити клієнта");
  assert.deepEqual(typeVerdict("carrier", 0.86, null), { inReport: false, typeCheck: false, source: "model" }, "🔴 упевнене сміття лишилось у звіті");
  assert.deepEqual(typeVerdict(null, null, null), { inReport: true, typeCheck: false, source: "none" }, "🔴 ще не розібране сховано");
  const ov = (isCargo: boolean) => ({ isCargo, byName: "Т", at: "2026-09-30T10:00:00Z" });
  assert.equal(typeVerdict("vendor", 0.99, ov(true)).inReport, true, "🔴 «Це вантаж» тімліда не повернуло розмову у звіт");
  assert.equal(typeVerdict("cargo_request", 0.99, ov(false)).inReport, false, "🔴 «Це не вантаж» тімліда не прибрало розмову зі звіту");
  for (const k of ["admin", "team_lead"]) assert.equal(canEditType(k), true, `дзеркало: ${k} мусить змінювати тип`);
  for (const k of ["ceo", "opdir", "kvp", "manager", "financier", "hr", null]) assert.equal(canEditType(k), false, `🔴 ${String(k)} може змінювати тип`);
});

/**
 * #856 — ТИП НА ЖИВІЙ СХЕМІ (ТЗ 30.09.2026): розмова з упевненим «перевізником» — у «Виключених», з типом і причиною;
 * ручне «Це вантаж» повертає її у звіт, «Це не вантаж» — знову прибирає, і ОБИДВІ зміни лишаються в журналі з
 * автором (діє остання). Роут: право — першим оператором, скоуп тімліда — тим самим, що в картки (чужий → 404).
 * 🧨 Червоніє, якщо журнал перезаписується, остання позначка не діє чи роут пише без перевірки права.
 */
test("#856 ТИП · ЖИВА СХЕМА: «Виключені» з причиною, ручна позначка в обидва боки, журнал з автором; роут — право першим", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { aiCallsList, aiCallCard, setCallType } = await import("./callAiScreen.js");
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel) VALUES (8856,'D8856',8921932,1,'2026-09-27 09:00:00+03','0508856001','ad')`);
  await c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,manager_id,client_phone,recording)
    VALUES ('z1','2026-09-27 10:00:00+03','in','ANSWERED',40,45,9011,'380508856001','https://rec/x')`);
  const tid = (await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ('z1','elevenlabs','scribe_v2','done','[{"channel":0,"start":0,"end":2,"text":"маю вільну фуру","lang":"ukr"}]'::jsonb) RETURNING id`)).rows[0].id;
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result) VALUES ($1,'google','gemini-3.8-flash','first-touch-v2','done',$2::jsonb)`,
    [tid, JSON.stringify({ ...RESULT, conversation_type: "carrier", type_confidence: 0.97, type_reason: "перевізник пропонує фуру", promises: [], objections: [] })]);
  const row = async () => (await aiCallsList(c.db, FAKE_AD, "2026-09-27", "2026-09-27", NOW, {})).rows.find((r) => r.uniqueid === "z1")!;
  const r0 = await row();
  assert.deepEqual([r0.inReport, r0.conversationType, r0.typeReason], [false, "carrier", "перевізник пропонує фуру"], "🔴 упевнений перевізник не у «Виключених» або без причини");
  await setCallType(c.db, "z1", true, { userId: 1, name: "Тімлід Т" }, new Date("2026-09-30T10:00:00Z"));
  assert.equal((await row()).inReport, true, "🔴 «Це вантаж» не повернуло розмову у звіт");
  await setCallType(c.db, "z1", false, { userId: 2, name: "Адмін А" }, new Date("2026-09-30T11:00:00Z"));
  const r2 = await row();
  assert.deepEqual([r2.inReport, r2.typeOverride?.byName], [false, "Адмін А"], "🔴 діє не остання позначка");
  const card = await aiCallCard(c.db, "z1", true, {});
  assert.deepEqual(card?.typeHistory.map((h) => [h.isCargo, h.byName]), [[false, "Адмін А"], [true, "Тімлід Т"]], "🔴 журнал змін типу перезаписано або без автора");
  assert.equal(await aiCallCard(c.db, "z1", false, { teamId: 902 }), null, "🔴 тімлід чужої команди дістав дзвінок — роут записав би тип");

  const route = SRC("routes/dashboard.ts");
  const at = route.indexOf('dashboardRouter.post("/ai-calls/:uniqueid/type"');
  assert.ok(at > 0, "🔴 роуту зміни типу немає");
  const next = route.indexOf("dashboardRouter.", at + 10);
  const body = route.slice(at, next > at ? next : undefined);
  assert.ok(body.includes("setCallType("), "🔴 роут зміни типу не пише журнал");
  assert.match(body, /const auth = req\.auth!;\s*if \(!canEditType\(auth\.roleKey\)\) \{ res\.status\(403\)/, "🔴 право на зміну типу — не першим оператором");
  assert.match(body, /const card = await aiCallCard\([^;]+;\s*if \(!card\) \{ res\.status\(404\)[\s\S]*setCallType\(/, "🔴 тип пишеться без відмови 404 поза скоупом");
});

/**
 * #857 — ТИП НА ЕКРАНІ: вкладки «Звіт» / «Виключені» з лічильниками, фільтр за типом у «Виключених», плитки рахуються
 * лише по звіту, кожен тип має підпис, у картці — тип із причиною й кнопки лише з дозволу сервера.
 * 🧨 Червоніє, якщо плитки рахувати по всіх розмовах, показати кнопки всім чи загубити тип без підпису.
 */
test("#857 ТИП НА ЕКРАНІ: вкладки «Звіт / Виключені», плитки лише по звіту, підпис кожного типу, кнопки з дозволу сервера", async () => {
  const V = await loadView() as unknown as { TYPE_LABEL: Record<string, string>; tabRows: (r: { inReport: boolean; conversationType: string | null }[], tab: string, type?: string) => unknown[] };
  for (const k of ["cargo_request", "carrier", "vendor", "job_seeker", "wrong_number", "no_dialog", "other"]) assert.ok(V.TYPE_LABEL[k], `🔴 тип ${k} без підпису`);
  const rows = [{ inReport: true, conversationType: "cargo_request" }, { inReport: false, conversationType: "carrier" }, { inReport: false, conversationType: "vendor" }];
  assert.equal(V.tabRows(rows, "report").length, 1);
  assert.equal(V.tabRows(rows, "excluded").length, 2);
  assert.equal(V.tabRows(rows, "excluded", "vendor").length, 1, "🔴 фільтр за типом у «Виключених» не працює");
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /const rows = tabRows\(scopedAll, "report"\);/, "🔴 плитки рахуються не лише по звіту");
  assert.match(sec, /Виключені · \{excludedCount\}/, "🔴 вкладки «Виключені» з лічильником немає");
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw, /\{c\.canEditType && \(/, "🔴 кнопки зміни типу показуються без дозволу сервера");
  assert.match(drw, /setAiCallType\(r\.uniqueid, isCargo\)/, "🔴 кнопки не пишуть тип");
});

/**
 * #862 — ЗВІТ ТІМЛІДА: ЯДРО (ТЗ «звіт тімліда» 30.09.2026, п.6). Рахуються лише розмови у звіті; відсоток ціни — від
 * РОЗІБРАНИХ (нерозібране не читається як «не назвав»); «без ціни й коментаря» зникає, щойно написали «чому»;
 * «виконано / запізнився / не передзвонив» — окремо; «Разом» = сума менеджерів; банер — лише «не передзвонив» без
 * «Опрацьовано»; пул за кожним фільтром = рівно ті рядки, з яких пораховано клітинку.
 * 🧨 Червоніє, якщо рахувати «Виключені», ділити на нерозібрані, лишати в банері опрацьоване чи розвести пул і клітинку.
 */
test("#862 ЗВІТ ТІМЛІДА · ЯДРО: лише звіт, відсоток від розібраних, коментар гасить «без ціни», банер — лише не передзвонив без «опрацьовано»", async () => {
  const { teamReport, poolRows } = await import("./firstTouchTeamReport.js");
  const r = (id: string, mgr: number, o: Record<string, unknown>) => ({ uniqueid: id, calledAt: "2026-09-29T08:00:00Z", managerId: mgr, managerName: `M${String(mgr)}`,
    teamName: "T", inReport: true, state: "done", priceDiscussed: true, promiseState: null, typeCheck: false, priceNote: null, missedNote: null, ...o });
  const rows = [
    r("a", 1, { priceDiscussed: true, promiseState: "kept_talk" }),
    r("b", 1, { priceDiscussed: false, promiseState: "broken" }),
    r("c", 1, { priceDiscussed: false, priceNote: { text: "клієнт поклав слухавку" }, promiseState: "broken", missedNote: { text: "набрав сам" } }),
    r("d", 1, { state: "llm_pending", priceDiscussed: null }),
    r("e", 2, { priceDiscussed: true, promiseState: "late", typeCheck: true }),
    r("f", 2, { inReport: false, priceDiscussed: false, promiseState: "broken" }),
    r("g", 2, { priceDiscussed: true, promiseState: "unverifiable" }),
  ] as never[];
  const t = teamReport(rows);
  const m1 = t.managers.find((x) => x.managerId === 1)!;
  assert.deepEqual([m1.accepted, m1.analysed, m1.priceVoiced, m1.pricePct, m1.noPriceNoComment, m1.agreements, m1.done, m1.late, m1.missed],
    [4, 3, 1, 33.3, 1, 3, 1, 0, 2], "🔴 рядок менеджера порахований не за правилами ТЗ");
  const m2 = t.managers.find((x) => x.managerId === 2)!;
  assert.deepEqual([m2.accepted, m2.agreements, m2.late, m2.missed], [2, 1, 1, 0], "🔴 «Виключені» чи обіцянка в месенджер потрапили в звіт тімліда");
  for (const k of ["accepted", "analysed", "priceVoiced", "noPriceNoComment", "agreements", "done", "late", "missed"] as const)
    assert.equal(t.total[k], m1[k] + m2[k], `🔴 «Разом» ≠ сумі менеджерів у колонці ${k}`);
  assert.deepEqual([t.banner.total, t.banner.byManager.map((x) => [x.managerId, x.count])], [1, [[1, 1]]], "🔴 банер показує опрацьоване або не лише «не передзвонив»");
  assert.equal(poolRows(rows, 1, "noComment").length, m1.noPriceNoComment, "🔴 пул «без коментаря» ≠ клітинці");
  assert.equal(poolRows(rows, 1, "missed").length, m1.missed, "🔴 пул «не передзвонив» ≠ клітинці");
  assert.equal(poolRows(rows, 2, "typeCheck").length, 1);
  assert.equal(poolRows(rows, "all", "all").length, t.total.accepted, "🔴 пул «усі» ≠ «прийнято заявок»");
});

/**
 * #863 — КОМЕНТАРІ, ЗАПИС, РОУТ ЗВІТУ (ТЗ 30.09.2026, п.5–7). «Чому не озвучено ціну» пишуть менеджер, тімлід, адмін;
 * «Опрацьовано» — лише тімлід і адмін; CEO не пише нічого. Коментар замінюється, порожній — прибирається. Роути:
 * право — першим оператором, скоуп картки — до запису чи завантаження; звіт — з тих самих рядків вкладки.
 * 🧨 Червоніє, якщо відкрити «Опрацьовано» менеджеру, писати без скоупу чи рахувати звіт окремим SQL.
 */
test("#863 КОМЕНТАРІ Й ЗАПИС: права за видом коментаря, заміна й прибирання, роути — право першим, скоуп до запису", async (t) => {
  const { canWriteNote } = await import("./callAiScreen.js");
  for (const k of ["admin", "team_lead", "manager"]) assert.equal(canWriteNote(k, "price"), true, `дзеркало: ${k} пише «чому не озвучено ціну»`);
  for (const k of ["ceo", "opdir", "kvp", "financier", "hr"]) assert.equal(canWriteNote(k, "price"), false, `🔴 ${k} пише коментар до ціни`);
  for (const k of ["admin", "team_lead"]) assert.equal(canWriteNote(k, "missed"), true, `дзеркало: ${k} пише «Опрацьовано»`);
  for (const k of ["manager", "ceo"]) assert.equal(canWriteNote(k, "missed"), false, `🔴 ${k} пише «Опрацьовано» — банер гасив би сам собі`);
  assert.equal(canWriteNote("admin", "other"), false);
  const route = SRC("routes/dashboard.ts");
  const body = (head: string) => { const at = route.indexOf(head); assert.ok(at > 0, `🔴 роуту ${head} немає`); const nx = route.indexOf("dashboardRouter.", at + 10); return route.slice(at, nx > at ? nx : undefined); };
  const note = body('dashboardRouter.put("/ai-calls/:uniqueid/note"');
  assert.match(note, /const kind = String\(req\.body\?\.kind \?\? ""\);\s*if \(!canWriteNote\(auth\.roleKey, kind\)\) \{ res\.status\(403\)/, "🔴 право на коментар — не першим оператором");
  assert.match(note, /const card = await aiCallCard\([^;]+;\s*if \(!card\) \{ res\.status\(404\)[\s\S]*setCallNote\(/, "🔴 коментар пишеться без відмови 404 поза скоупом");
  const rec = body('dashboardRouter.get("/ai-calls/:uniqueid/recording"');
  assert.match(rec, /const auth = req\.auth!;\s*if \(!transcriptAllowed\(auth, FIRST_TOUCH_TRANSCRIPT_ROLES\)\) \{ res\.status\(403\)/, "🔴 право на запис — не першим оператором");
  assert.match(rec, /const card = await aiCallCard\([^;]+;\s*if \(!card\) \{ res\.status\(404\)[\s\S]*fetchCallRecording\(/, "🔴 запис віддається без відмови 404 поза скоупом");
  const rep = body('dashboardRouter.get("/ai-calls/team-report"');
  assert.match(rep, /aiCallsList\(pool,[\s\S]*teamReport\(rows\)/, "🔴 звіт тімліда рахується не з рядків вкладки");
  assert.match(rep, /missedScopeFor\(req\.auth!, req\.query\)/, "🔴 звіт тімліда без клампу скоупу");

  const c = await ctx(t); if (!c) return;
  const { setCallNote, aiCallCard } = await import("./callAiScreen.js");
  await setCallNote(c.db, "x1", "price", "  клієнт поспішав  ", { userId: 1, name: "Менеджер М" }, new Date("2026-09-30T09:00:00Z"));
  assert.deepEqual([(await aiCallCard(c.db, "x1", true, {}))?.row.priceNote?.text, (await aiCallCard(c.db, "x1", true, {}))?.row.priceNote?.byName], ["клієнт поспішав", "Менеджер М"]);
  await setCallNote(c.db, "x1", "price", "інша причина", { userId: 2, name: "Тімлід Т" }, new Date("2026-09-30T10:00:00Z"));
  assert.equal((await aiCallCard(c.db, "x1", true, {}))?.row.priceNote?.text, "інша причина", "🔴 коментар не замінився");
  await setCallNote(c.db, "x1", "price", "   ", { userId: 2, name: "Тімлід Т" }, new Date("2026-09-30T11:00:00Z"));
  assert.equal((await aiCallCard(c.db, "x1", true, {}))?.row.priceNote, null, "🔴 порожній текст не прибрав коментар");
});

/**
 * #864 — ЗВІТ ТІМЛІДА НА ЕКРАНІ (ТЗ 30.09.2026, п.6–7): блок стоїть у «Звіті» з тим самим періодом і командою; пул і банер
 * фільтруються ПРАПОРЦЯМИ СЕРВЕРА (жодної другої копії предикатів на фронті); у картці коментарі й запис — лише з дозволу
 * сервера; менеджер «Виключених» не бачить.
 * 🧨 Червоніє, якщо переписати фільтр пулу на фронті, показати кнопку запису без дозволу чи вкладку «Виключені» менеджеру.
 */
test("#864 ЗВІТ ТІМЛІДА НА ЕКРАНІ: блок у «Звіті» з тим самим періодом, пул і банер — прапорці сервера, коментарі й запис — з дозволу сервера", () => {
  const rp = readFileSync(FE("pages/dashboard/sections/ReportPlanSection.tsx"), "utf8");
  assert.match(rp, /<FirstTouchReportCard from=\{selectedPeriod\.from\} to=\{selectedPeriod\.to\} teamId=\{teamIds\.length === 1 \? teamIds\[0\] : undefined\} \/>/, "🔴 блоку «Перший дотик» у «Звіті» немає або період інший");
  const card = readFileSync(FE("pages/dashboard/sections/FirstTouchReportCard.tsx"), "utf8");
  for (const f of ["r.flags.noPrice", "r.flags.noComment", "r.flags.missed", "r.flags.banner"]) assert.ok(card.includes(f), `🔴 фільтр пулу чи банер не з прапорця сервера: ${f}`);
  assert.ok(!/priceDiscussed === false|promiseState === "broken"/.test(card), "🔴 предикат звіту переписано на фронті — друга копія правила");
  assert.match(card, /fetchAiTeamReport\(\{ from, to, teamId \}\)/);
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw, /const listen = c != null && c\.canListen && c\.durationSec != null;/, "🔴 запис показується без дозволу сервера");
  const lAt = drw.indexOf("{listen && (");
  const listenBlock = lAt < 0 ? "" : drw.slice(lAt, drw.indexOf("\n            )}", lAt)); // до закриття саме цього блоку
  assert.ok(listenBlock.includes("<CallConversation "), "🔴 плеєр не за дозволом listen");
  assert.match(drw, /const can = c\.noteRights\[kind\];/, "🔴 право писати коментар — не з сервера");
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /\{d\.canSeeExcluded && <button type="button" role="tab"/, "🔴 менеджер бачить вкладку «Виключені»");
});


/**
 * #866 — «ПОЗА ТЕЛЕФОНІЄЮ» · ЖИВА СХЕМА: CHECK приймає `offline` і не приймає сміття; на справжній обіцянці без дзвінка
 * позначка дає `kept_offline` і в списку, і в картці (по кожній обіцянці); зняли позначку — знову «немає дзвінка».
 * 🧨 Червоніє, якщо забути CHECK, джойн позначки чи застосувати її лише в списку, а не в картці.
 */
test("#866 ПОЗА ТЕЛЕФОНІЄЮ · ЖИВА СХЕМА: позначка приймається, список і картка — kept_offline, зняття повертає «немає дзвінка»", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { aiCallsList, aiCallCard, setCallNote } = await import("./callAiScreen.js");
  await assert.rejects(c.raw.query("INSERT INTO first_touch_notes(uniqueid, kind, note) VALUES ('z0', 'bogus', 'x')"), /check/i, "🔴 CHECK виду позначки зник");
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel,manager_id)
    VALUES (8830,'D8830',8921932,1,'2026-09-26 09:00:00+03','0508800030','ad',9011)`);
  await c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,manager_id,client_phone,recording)
    VALUES ('of1','2026-09-26 10:00:00+03','out','ANSWERED',60,65,9011,'380508800030','https://rec/x')`);
  const tid = (await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ('of1','elevenlabs','scribe_v2','done','[{"channel":1,"start":0,"end":2,"text":"передзвоню за пів години","lang":"ukr"}]'::jsonb) RETURNING id`)).rows[0].id;
  const res = { ...RESULT, objections: [], promises: [{ who: "manager", what: "передзвонити", deadline_text: "за пів години", quote: "q", quote_found: true,
    channel: "call", deadline_kind: "minutes", deadline_minutes: 30, deadline_date: "", conditional: false }] };
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result)
    VALUES ($1,'google','gemini-3.8-flash','first-touch-v2','done',$2::jsonb)`, [tid, JSON.stringify(res)]);
  const state = async () => (await aiCallsList(c.db, FAKE_AD, "2026-09-26", "2026-09-26", NOW, {})).rows.find((r) => r.uniqueid === "of1")?.promiseState;
  assert.equal(await state(), "broken", "передумова: без дзвінка в телефонії — «немає дзвінка»");
  await setCallNote(c.db, "of1", "offline", "передзвонила з мобільного о 10:20", { userId: 1, name: "Олена Т1" }, new Date("2026-09-26T08:00:00Z"));
  assert.equal(await state(), "kept_offline", "🔴 позначка «поза телефонією» не дійшла до списку");
  const card = await aiCallCard(c.db, "of1", true, {});
  assert.deepEqual([card?.row.offlineNote?.text, card?.promiseChecks.map((x) => x?.state)], ["передзвонила з мобільного о 10:20", ["kept_offline"]], "🔴 картка показує «немає дзвінка» поруч із позначкою");
  await setCallNote(c.db, "of1", "offline", "", { userId: 1, name: "Олена Т1" }, new Date("2026-09-26T09:00:00Z"));
  assert.equal(await state(), "broken", "🔴 зняту позначку не прибрано — стан застряг у «виконано»");
});

/**
 * #867 — НАЛАШТУВАННЯ «ПЕРШОГО ДОТИКУ» · ЯДРО І ПРОВОДКА (рішення власника 05.10.2026). Термін зараховується до
 * `max(обіцяне, кінець + мінімум) + допуск`; мінімум — лише для обіцянок у хвилинах; межа включно з обох боків;
 * нулі = поточна поведінка. Ввід адміна — лише цілі в межах і всі чотири поля; вікно повторного — у ТІЙ САМІЙ умові
 * для джоби й екрана; роут налаштувань — лише адмін за ключем ролі, першим оператором.
 * 🧨 Червоніє, якщо допуск застосувати двічі, мінімум зачепить «завтра», `<=` стане `<`, нулі щось зрушать, вікно
 * піде лише в екран чи лише в джобу, або змінювати налаштування зможе CEO.
 */
test("#867 НАЛАШТУВАННЯ ПЕРШОГО ДОТИКУ · ЯДРО: мінімум і допуск з обох боків межі, нулі = як було, ввід суворий, вікно — одна умова", async () => {
  const { countingDeadline, promiseState } = await import("./callAiPromise.js");
  const end = new Date("2026-10-02T10:00:00Z"), at = (m: number) => new Date(end.getTime() + m * 60_000);
  const on = { callbackGraceMin: 10, callbackMinDeadlineMin: 20 }, off = { callbackGraceMin: 0, callbackMinDeadlineMin: 0 };
  assert.equal(countingDeadline(at(2), "minutes", end, on).toISOString(), at(30).toISOString(), "🔴 «дві хвилини» не стали 20 + 10 хв допуску");
  assert.equal(countingDeadline(at(20), "default_minutes", end, on).toISOString(), at(30).toISOString(), "🔴 допуск застосовано двічі або не застосовано");
  assert.equal(countingDeadline(at(45), "minutes", end, on).toISOString(), at(55).toISOString(), "🔴 мінімум укоротив довшу обіцянку");
  const eod = new Date("2026-10-03T20:59:59Z");
  assert.equal(countingDeadline(eod, "day", end, on).toISOString(), new Date(eod.getTime() + 10 * 60_000).toISOString(), "🔴 «завтра» — мінімум чи допуск не так");
  // по інший бік: розмова о 23:55 Києва, «сьогодні» до 23:59:59 — мінімум 20 хв тягнув би термін у завтра.
  const late = new Date("2026-10-02T20:55:00Z"), today = new Date("2026-10-02T20:59:59Z");
  assert.equal(countingDeadline(today, "day", late, on).toISOString(), new Date(today.getTime() + 10 * 60_000).toISOString(), "🔴 мінімум дедлайну зачепив «сьогодні»");
  for (const b of ["minutes", "default_minutes", "day", "conditional_next_workday"] as const)
    assert.equal(countingDeadline(at(2), b, end, off).toISOString(), at(2).toISOString(), `🔴 нулі зсунули термін (${b}) — викат змінив би цифри`);
  const call = (m: number) => [{ at: at(m), billsec: 30, callType: "out", managerId: 7 }];
  const st = (m: number) => promiseState({ channel: "call" }, end, countingDeadline(at(2), "minutes", end, on), call(m), at(120), 7);
  assert.deepEqual([st(30), st(31)], ["kept_talk", "late"], "🔴 межа зарахування не включна або зсунута");

  const { parseTunables, CURRENT_BEHAVIOUR } = await import("./firstTouchTunables.js");
  assert.deepEqual(CURRENT_BEHAVIOUR, { repeatWindowDays: null, callbackGraceMin: 0, callbackMinDeadlineMin: 0, bannerTone: "neutral", priceTargetPct: 50 }, "🔴 старт ≠ поточна поведінка (ціль ціни — 50 % за ТЗ 08.10.2026)");
  const ok = { repeatWindowDays: 30, callbackGraceMin: 10, callbackMinDeadlineMin: 20, bannerTone: "alert" };
  assert.deepEqual(parseTunables(ok), { ok: true, value: { ...ok, priceTargetPct: 50 } }, "без поля цілі — ціль за замовчуванням 50 %, а не помилка");
  assert.equal(parseTunables({ ...ok, repeatWindowDays: null }).ok, true, "дзеркало: «без обмеження» — законне значення");
  for (const bad of [{ repeatWindowDays: 0 }, { repeatWindowDays: 366 }, { callbackGraceMin: 121 }, { callbackGraceMin: -1 }, { callbackGraceMin: "10" },
    { callbackMinDeadlineMin: 2.5 }, { bannerTone: "red" }, { bannerTone: undefined }])
    assert.equal(parseTunables({ ...ok, ...bad }).ok, false, `🔴 прийнято неприпустиме: ${JSON.stringify(bad)}`);

  const { firstTouchExclusionSql } = await import("./callAiTick.js");
  assert.doesNotMatch(firstTouchExclusionSql("ft", "p", null), /interval/, "🔴 «без обмеження» обмежує");
  assert.match(firstTouchExclusionSql("ft", "p", 30), /e\.calldate >= ft\.calldate - interval '30 days'/, "🔴 вікно не включне або не те");
  const tick = SRC("core/callAiTick.ts"), scr = SRC("core/callAiScreen.ts");
  assert.match(tick, /firstTouchExclusionSql\("ft", "rcx\.client_phone", \(await loadTunables\(db\)\)\.repeatWindowDays\)/, "🔴 джоба не бере вікно з налаштувань");
  assert.match(scr, /firstTouchExclusionSql\("ft", "rcx\.client_phone", tun\.repeatWindowDays\)/, "🔴 екран не бере вікно з налаштувань — розійдеться з джобою");
  assert.match(scr, /const until = countingDeadline\(deadline, basis, end, t\);[\s\S]{0,200}promiseState\(mp, end, until,/, "🔴 стан рахується не до терміну зарахування");

  const set = SRC("routes/settings.ts");
  for (const m of ["get", "put"]) {
    const at0 = set.indexOf(`settingsRouter.${m}("/first-touch"`); assert.ok(at0 > 0, `🔴 немає ${m} /first-touch`);
    assert.match(set.slice(at0, at0 + 300), /async \(req, res\) => \{\s*if \(req\.auth!\.roleKey !== "admin"\) \{ res\.status\(403\)/, `🔴 ${m} /first-touch — право не першим або не за ключем ролі`);
  }
  assert.match(set, /const parsed = parseTunables\(req\.body\);\s*if \(!parsed\.ok\) \{ res\.status\(400\)[\s\S]{0,300}saveTunables\(/, "🔴 збереження без перевірки вводу");
});

/**
 * #868 — НАЛАШТУВАННЯ «ПЕРШОГО ДОТИКУ» · ЖИВА СХЕМА. Порожній журнал = поточна поведінка; чинне — останній рядок;
 * вікно 30 днів: попередня розмова рівно 30 днів тому — повторна, 30 днів і хвилина — ні (з обох боків межі);
 * допуск переводить «пізно» у «вчасно» і в списку, і в картці, де видно обидва терміни. CHECK тримає межі в базі.
 * 🧨 Червоніє, якщо читати не останній рядок, межа вікна зсунеться, допуск піде лише в список чи картку.
 */
test("#868 НАЛАШТУВАННЯ ПЕРШОГО ДОТИКУ · ЖИВА СХЕМА: вікно з обох боків межі, допуск у списку й картці, останній рядок чинний", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { aiCallsList, aiCallCard } = await import("./callAiScreen.js");
  const { loadTunables, saveTunables, CURRENT_BEHAVIOUR } = await import("./firstTouchTunables.js");
  const by = { userId: 1, name: "Адмін А" };
  const put = (o: Record<string, unknown>) => saveTunables(c.db, { ...CURRENT_BEHAVIOUR, ...o }, by, new Date());
  assert.deepEqual(await loadTunables(c.db), CURRENT_BEHAVIOUR, "🔴 порожній журнал ≠ поточна поведінка");
  await assert.rejects(c.raw.query("INSERT INTO first_touch_settings_log (callback_grace_min, callback_min_deadline_min, banner_tone) VALUES (500, 0, 'neutral')"), /check/i, "🔴 CHECK меж зник");

  const deal = (id: number, key: string) => c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel,manager_id)
    VALUES ($1,$2,8921932,1,'2026-09-27 09:00:00+03',$3,'ad',9011)`, [id, `D${String(id)}`, key]);
  const call = (u: string, at: string, sec: number, phone: string) => c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,manager_id,client_phone,recording)
    VALUES ($1,$2,'out','ANSWERED',$3,$4,9011,$5,'https://rec/x')`, [u, at, sec, sec + 5, phone]);
  await deal(8840, "0508800040"); await call("w30", "2026-09-27 10:00:00+03", 60, "380508800040"); await call("w30p", "2026-08-28 10:00:00+03", 40, "380508800040");
  await deal(8841, "0508800041"); await call("w31", "2026-09-27 10:00:00+03", 60, "380508800041"); await call("w31p", "2026-08-28 09:59:00+03", 40, "380508800041");
  const ids = async () => (await aiCallsList(c.db, FAKE_AD, "2026-09-27", "2026-09-27", NOW, {})).rows.map((r) => r.uniqueid).filter((u) => u === "w30" || u === "w31").sort();
  assert.deepEqual(await ids(), [], "передумова: без обмеження обидві — повторні");
  await put({ repeatWindowDays: 30 });
  assert.deepEqual(await ids(), ["w31"], "🔴 межа вікна: рівно 30 днів має лишитись повторною, 30 днів і хвилина — повернутись");

  await deal(8842, "0508800042"); await call("g1", "2026-09-27 10:00:00+03", 60, "380508800042");
  const tid = (await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ('g1','elevenlabs','scribe_v2','done','[{"channel":1,"start":0,"end":2,"text":"передзвоню за дві хвилини","lang":"ukr"}]'::jsonb) RETURNING id`)).rows[0].id;
  const res = { ...RESULT, objections: [], promises: [{ who: "manager", what: "передзвонити", deadline_text: "за дві хвилини", quote: "q", quote_found: true,
    channel: "call", deadline_kind: "minutes", deadline_minutes: 2, deadline_date: "", conditional: false }] };
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result) VALUES ($1,'google','gemini-3.8-flash','first-touch-v2','done',$2::jsonb)`, [tid, JSON.stringify(res)]);
  await call("g1b", "2026-09-27 10:25:00+03", 30, "380508800042");   // кінець розмови 10:01, обіцяно до 10:03, передзвонив о 10:25
  const st = async () => (await aiCallsList(c.db, FAKE_AD, "2026-09-27", "2026-09-27", NOW, {})).rows.find((r) => r.uniqueid === "g1")?.promiseState;
  await put({});
  assert.equal(await st(), "late", "передумова: без допуску — «пізно»");
  await put({ callbackGraceMin: 10, callbackMinDeadlineMin: 20 });
  assert.equal(await st(), "kept_talk", "🔴 допуск і мінімум не дійшли до списку");
  const chk = (await aiCallCard(c.db, "g1", true, {}))?.promiseChecks[0];
  assert.deepEqual([chk?.state, chk?.deadline, chk?.countUntil], ["kept_talk", "2026-09-27T07:03:00.000Z", "2026-09-27T07:31:00.000Z"],
    "🔴 картка не показує обидва терміни або рахує інакше, ніж список");
  await put({});
  assert.deepEqual(await loadTunables(c.db), CURRENT_BEHAVIOUR, "🔴 чинним узято не останній рядок журналу");
  assert.equal(await st(), "late", "дзеркало: повернули нулі — знову «пізно»");
});

/**
 * #885 — ВТРАЧЕНИЙ ЛІД І ПРАВИЛО ПЕРЕДЗВОНУ · ЯДРО (рішення власника 05.10.2026). `lead_lost` — у звіті за будь-якої
 * впевненості; «інше» і «без розмови» з домовленістю ПЕРЕДЗВОНИТИ — у звіті (правило), а перевізник, продавець, пошук
 * роботи й помилка номером — ні, навіть з обіцянкою; обіцянка в месенджер правила не вмикає; ручна позначка сильніша.
 * У звіті тімліда втрачений — у «прийнято» й у своїй колонці, але НЕ в знаменнику ціни й не в «без ціни»; пул
 * «Втрачені» = клітинці; медіана хвилин реакції — лише по втрачених. Хвилини — від заявки до першого вихідного, з
 * межами робочого часу з обох боків.
 * 🧨 Червоніє, якщо втрачений піде у «Виключені» чи в знаменник ціни, перевізник з обіцянкою зайде у звіт, межа
 * робочого часу зсунеться або медіана рахуватиме не тих.
 */
test("#885 ВТРАЧЕНИЙ ЛІД І ПЕРЕДЗВІН · ЯДРО: lead_lost у звіті поза ціною, правило передзвону лише для «інше»/«без розмови», медіана реакції", async () => {
  const { typeVerdict } = await import("./callAiType.js");
  assert.deepEqual(typeVerdict("lead_lost", 0.5, null), { inReport: true, typeCheck: false, source: "model" }, "🔴 втрачений лід виключено або позначено «перевірити»");
  for (const ty of ["other", "no_dialog"] as const) {
    assert.deepEqual(typeVerdict(ty, 0.95, null, true), { inReport: true, typeCheck: false, source: "rule" }, `🔴 «${ty}» з домовленістю передзвонити не у звіті`);
    assert.equal(typeVerdict(ty, 0.95, null, false).inReport, false, `дзеркало: «${ty}» без домовленості — у «Виключених»`);
  }
  for (const ty of ["carrier", "vendor", "job_seeker", "wrong_number"] as const)
    assert.equal(typeVerdict(ty, 0.95, null, true).inReport, false, `🔴 «${ty}» з обіцянкою передзвонити зайшов у звіт`);
  assert.equal(typeVerdict("other", 0.95, { isCargo: false, byName: "Т", at: "" }, true).inReport, false, "🔴 правило перебило ручну позначку");
  const scr = SRC("core/callAiScreen.ts");
  assert.match(scr, /const callback = \(res\?\.promises \?\? \[\]\)\.some\(\(p\) => p\.who === "manager" && p\.channel === "call"\);\s*const v = typeVerdict\(type, conf, override, callback\);/,
    "🔴 правило вмикає не домовленість менеджера ПЕРЕДЗВОНИТИ");

  const { teamReport, poolRows } = await import("./firstTouchTeamReport.js");
  const r = (id: string, o: Record<string, unknown>) => ({ uniqueid: id, calledAt: "2026-09-29T08:00:00Z", managerId: 1, managerName: "M1",
    teamName: "T", inReport: true, state: "done", priceDiscussed: true, promiseState: null, typeCheck: false, priceNote: null, missedNote: null,
    conversationType: "cargo_request", reactionMin: 5, ...o });
  const rows = [
    r("a", { priceDiscussed: true }), r("b", { priceDiscussed: false }),
    r("l1", { conversationType: "lead_lost", priceDiscussed: false, reactionMin: 20 }),
    r("l2", { conversationType: "lead_lost", priceDiscussed: false, reactionMin: 3525 }),
    r("l3", { conversationType: "lead_lost", priceDiscussed: false, reactionMin: 65 }),
    r("l4", { conversationType: "lead_lost", priceDiscussed: false, reactionMin: null }),
  ] as never[];
  const m = teamReport(rows).managers[0];
  assert.deepEqual([m.accepted, m.analysed, m.priceVoiced, m.pricePct, m.noPriceNoComment, m.lost, m.lostReactionMedianMin], [6, 6, 1, 50, 1, 4, 65],
    "🔴 втрачений лід зіпсував ціну або колонка/медіана пораховані не так");
  assert.equal(poolRows(rows, 1, "lost").length, m.lost, "🔴 пул «Втрачені» ≠ клітинці");
  assert.equal(poolRows(rows, 1, "noPrice").length, 1, "🔴 втрачений лід у «без ціни»");

  const { reactionMinutes, offHours, median } = await import("./leadReaction.js");
  assert.deepEqual([reactionMinutes("2026-09-28T07:00:00Z", "2026-09-28T07:20:00Z"), reactionMinutes("2026-09-28T07:00:00Z", null),
    reactionMinutes("2026-09-28T07:00:00Z", "2026-09-28T06:59:00Z")], [20, null, 0]);
  // пн 28.09: 08:59 і 18:00 Києва — поза, 09:00 і 17:59 — у робочий час; субота — поза.
  assert.deepEqual(["2026-09-28T05:59:00Z", "2026-09-28T06:00:00Z", "2026-09-28T14:59:00Z", "2026-09-28T15:00:00Z", "2026-09-26T09:00:00Z"].map(offHours),
    [true, false, false, true, true], "🔴 межі робочого часу зсунулись");
  assert.deepEqual([median([]), median([20, 3525, 65]), median([10, 20])], [null, 65, 15]);
});

/**
 * #886 — РЕАКЦІЯ І ПЕРЕАНАЛІЗ · ЖИВА СХЕМА. Перший вихідний рахується від створення угоди: спроба без відповіді —
 * рахується, вхідний клієнта — ні, наш дзвінок ДО створення угоди — ні. Поки v3 у черзі, список показує готовий v2
 * (а не «у черзі»); щойно v3 готовий — показує його (тут: втрачений лід, у звіті).
 * 🧨 Червоніє, якщо рахувати до розмови, брати вхідні чи дзвінки до заявки, або список порожніє під час переаналізу.
 */
test("#886 РЕАКЦІЯ І ПЕРЕАНАЛІЗ · ЖИВА СХЕМА: перший вихідний після заявки (спроба — так, вхідний — ні), v2 видно, поки v3 у черзі", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { aiCallsList } = await import("./callAiScreen.js");
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel,manager_id)
    VALUES (8850,'D8850',8921932,1,'2026-09-28 10:00:00+03','0508800050','ad',9011)`);
  const call = (u: string, at: string, type: string, sec: number) => c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,manager_id,client_phone,recording)
    VALUES ($1,$2,$3,$4,$5,$6,9011,'380508800050','https://rec/x')`, [u, at, type, sec > 0 ? "ANSWERED" : "NO ANSWER", sec, sec + 5]);
  await call("re0", "2026-09-28 09:50:00+03", "out", 0);      // до заявки — не рахується
  await call("re1", "2026-09-28 10:05:00+03", "in", 0);       // вхідний клієнта — не реакція
  await call("re2", "2026-09-28 10:20:00+03", "out", 0);      // перша спроба — це і є реакція
  await call("re3", "2026-09-28 10:40:00+03", "out", 60);     // сама розмова
  const tid = (await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ('re3','elevenlabs','scribe_v2','done','[{"channel":1,"start":0,"end":2,"text":"вже не актуально","lang":"ukr"}]'::jsonb) RETURNING id`)).rows[0].id;
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result) VALUES ($1,'google','gemini-3.8-flash','first-touch-v2','done',$2::jsonb)`,
    [tid, JSON.stringify({ ...RESULT, promises: [], conversation_type: "other", type_confidence: 0.95 })]);
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status) VALUES ($1,'google','gemini-3.8-flash','first-touch-v3','queued')`, [tid]);
  const row = async () => (await aiCallsList(c.db, FAKE_AD, "2026-09-28", "2026-09-28", NOW, {})).rows.find((r) => r.uniqueid === "re3");
  const a = await row();
  assert.deepEqual([a?.state, a?.conversationType, a?.inReport], ["done", "other", false], "🔴 поки v3 у черзі, список не показує готовий v2");
  assert.deepEqual([a?.reactionMin, a?.reactionOffHours], [20, false], "🔴 реакція — не від заявки до першого вихідного (спроба рахується, вхідний і дзвінок до заявки — ні)");
  await c.raw.query(`UPDATE call_analyses SET status = 'done', result = $2::jsonb WHERE transcript_id = $1 AND rubric_version = 'first-touch-v3'`,
    [tid, JSON.stringify({ ...RESULT, conversation_type: "lead_lost", type_confidence: 0.9 })]);
  const b = await row();
  assert.deepEqual([b?.conversationType, b?.inReport], ["lead_lost", true], "🔴 готовий v3 не взято або втрачений лід не у звіті");
});

/**
 * #887 — ВТРАЧЕНІ ЛІДИ НА ЕКРАНІ: колонка «Втрачені ліди» з медіаною хвилин, фільтр пулу з прапорця сервера, у рядку
 * пулу — «перший наш дзвінок через …» і «заявка поза робочим часом»; тип має підпис; роут віддає прапорець і хвилини.
 * 🧨 Червоніє, якщо фільтр перепишуть на фронті, колонку чи підпис приберуть, або роут не віддасть хвилини.
 */
test("#887 ВТРАЧЕНІ ЛІДИ НА ЕКРАНІ: колонка з медіаною, фільтр пулу з прапорця сервера, хвилини й «поза робочим часом» у рядку", async () => {
  const card = readFileSync(FE("pages/dashboard/sections/FirstTouchReportCard.tsx"), "utf8");
  assert.match(card, /\{ key: "lost", label: "Втрачені ліди"/, "🔴 колонки «Втрачені ліди» немає");
  assert.match(card, /\{ key: "lost", label: "Втрачені ліди", match: \(r\) => r\.flags\.lost \}/, "🔴 фільтр пулу не з прапорця сервера");
  assert.ok(!/conversationType === "lead_lost"/.test(card), "🔴 правило «втрачений» переписано на фронті");
  assert.match(card, /l\.lostReactionMedianMin == null \? "" : ` · \$\{fmtMinutes\(l\.lostReactionMedianMin\)\}`/, "🔴 медіану реакції не показано поруч");
  assert.match(card, /перший наш дзвінок через \$\{fmtMinutes\(r\.reactionMin\)\}/);
  assert.match(card, /r\.reactionOffHours \? " · заявка поза робочим часом" : ""/, "🔴 вихідні читатимуться як лінь");
  const V = await loadView() as unknown as { TYPE_LABEL: Record<string, string>; fmtMinutes: (m: number) => string };
  assert.match(V.TYPE_LABEL.lead_lost ?? "", /Втрачений лід/, "🔴 тип без підпису");
  assert.deepEqual([45, 190, 3525].map(V.fmtMinutes), ["45 хв", "3 год 10 хв", "2 дн 10 год"]);
  const rep = SRC("routes/dashboard.ts");
  const at0 = rep.indexOf('dashboardRouter.get("/ai-calls/team-report"'), nx = rep.indexOf("dashboardRouter.", at0 + 10);
  assert.match(rep.slice(at0, nx), /reactionMin: r\.reactionMin, reactionOffHours: r\.reactionOffHours,[\s\S]*lost: isLost\(r\)/, "🔴 роут не віддає хвилини чи прапорець «втрачений»");
});

/**
 * #888 — КАРТКА ЗНАЄ СТАН ОБІЦЯНКИ (знайдено 06.10.2026 на демо-стенді): `aiCallCard` мусить віддавати в `row.promiseState`
 * той самий стан, що й список (найгірша обіцянка + позначка «поза телефонією»). Саме за ним картка показує поля
 * «Передзвонив поза телефонією» й «Опрацьовано»; поки він був null, полів не бачив ніхто, і за 6 днів на проді не
 * зʼявилось жодної такої позначки.
 * 🧨 Червоніє, якщо картка знову віддасть null, порахує стан інакше, ніж список, чи забуде позначку «поза телефонією».
 */
test("#888 КАРТКА ЗНАЄ СТАН ОБІЦЯНКИ: row.promiseState картки = стан у списку, з позначкою «поза телефонією»", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { aiCallsList, aiCallCard, setCallNote } = await import("./callAiScreen.js");
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel,manager_id)
    VALUES (8860,'D8860',8921932,1,'2026-09-25 09:00:00+03','0508800060','ad',9011)`);
  await c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,manager_id,client_phone,recording)
    VALUES ('cs1','2026-09-25 10:00:00+03','out','ANSWERED',60,65,9011,'380508800060','https://rec/x')`);
  const tid = (await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ('cs1','elevenlabs','scribe_v2','done','[{"channel":1,"start":0,"end":2,"text":"наберу за пів години","lang":"ukr"}]'::jsonb) RETURNING id`)).rows[0].id;
  const res = { ...RESULT, objections: [], promises: [{ who: "manager", what: "передзвонити", deadline_text: "за пів години", quote: "q", quote_found: true,
    channel: "call", deadline_kind: "minutes", deadline_minutes: 30, deadline_date: "", conditional: false }] };
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result) VALUES ($1,'google','gemini-3.8-flash','first-touch-v3','done',$2::jsonb)`,
    [tid, JSON.stringify(res)]);
  const both = async () => [(await aiCallsList(c.db, FAKE_AD, "2026-09-25", "2026-09-25", NOW, {})).rows.find((r) => r.uniqueid === "cs1")?.promiseState,
    (await aiCallCard(c.db, "cs1", true, {}))?.row.promiseState];
  assert.deepEqual(await both(), ["broken", "broken"], "🔴 картка не знає «немає дзвінка» — поля «поза телефонією» й «Опрацьовано» не зʼявляться");
  await setCallNote(c.db, "cs1", "offline", "з мобільного", { userId: 1, name: "Олена Т1" }, new Date("2026-09-25T09:00:00Z"));
  assert.deepEqual(await both(), ["kept_offline", "kept_offline"], "🔴 картка й список розходяться після позначки «поза телефонією»");
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw, /const needMissed = c\.row\.promiseState === "broken";/, "🔴 картка показує «Опрацьовано» не за станом рядка");
});

/**
 * #889 — ЧЕРВОНИЙ РЕЖИМ БЕЗ «НЕ ДЛЯ РОЗБОРІВ» (ТЗ п.5.4, Роман 07.10.2026): коли адмін вмикає червоний колір блоку, дані
 * вже звірено людьми, тож застереження «перевіряється, не для розборів» зникає; у сірому режимі воно лишається, а
 * заголовок «дзвінка в телефонії немає» однаковий в обох.
 * 🧨 Червоніє, якщо застереження показувати й у червоному режимі або сховати його в сірому.
 */
test("#889 ЧЕРВОНИЙ РЕЖИМ БЕЗ «НЕ ДЛЯ РОЗБОРІВ»: застереження лише в сірому режимі, заголовок той самий", () => {
  const card = readFileSync(FE("pages/dashboard/sections/FirstTouchReportCard.tsx"), "utf8");
  assert.match(card, /\{!alert && <div style=\{\{ fontSize: 13, \.\.\.muted \}\}>За даними Ringostat\.[^\n]*перевіряється, не для розборів/, "🔴 застереження «не для розборів» не залежить від режиму");
  assert.equal((card.match(/не для розборів/g) ?? []).length, 1, "🔴 застереження продубльоване поза перемикачем");
  assert.equal((card.match(/Обіцяв передзвонити — дзвінка в телефонії немає/g) ?? []).length, 1, "дзеркало: заголовок один для обох режимів");
});

/**
 * #893 — ПОМИЛКА ЗАПИСУ ВИДНА НА ЕКРАНІ (Роман 07.10.2026): запис тягнеться як Blob, і серверний `{ error }` приходив
 * у Blob — кнопка «Прослухати запис» показувала безлике «Request failed with status code 404». Blob з JSON-помилкою
 * мусить стати обʼєктом із текстом; Blob не-JSON і JSON без `error` лишаються як були (запасний текст), не-Blob — теж.
 * 🧨 Червоніє, якщо прибрати читання Blob або підставляти розібране без перевірки, що там є текст `error`.
 */
test("#893 ПОМИЛКА ЗАПИСУ ВИДНА: Blob із серверним JSON стає текстом помилки, решта лишається як була", async () => {
  const v = await loadView();
  const json = new Blob([JSON.stringify({ error: "Запис недоступний: Ringostat не віддав запис (не знайдено)" })], { type: "application/json" });
  assert.deepEqual(await v.blobErrorBody(json), { error: "Запис недоступний: Ringostat не віддав запис (не знайдено)" }, "🔴 серверний текст із Blob не дістається");
  const html = new Blob(["<html>404</html>"], { type: "text/html" });
  assert.equal(await v.blobErrorBody(html), html, "дзеркало: не-JSON лишається Blob-ом — тоді спрацює запасний текст");
  const noError = new Blob([JSON.stringify({ ok: false })]);
  assert.equal(await v.blobErrorBody(noError), noError, "🔴 JSON без тексту error підставлено як помилку");
  const plain = { error: "вже обʼєкт" };
  assert.equal(await v.blobErrorBody(plain), plain, "дзеркало: звичайне тіло не чіпається");
  const api = readFileSync(FE("api.ts"), "utf8");
  assert.match(api, /export async function fetchAiCallRecording[\s\S]{0,400}?res\.data = await blobErrorBody\(res\.data\);\s*throw e;/, "🔴 fetchAiCallRecording не розбирає тіло помилки");
});

/**
 * #893b — СЕРВЕР НАЗИВАЄ ПРИЧИНУ (Роман 07.10.2026): відмова Ringostat віддавалась однією фразою «Запису в Ringostat
 * немає» на всі шість причин; тепер текст — із словника `RECORDING_UNAVAILABLE_UA` за самою причиною.
 * 🧨 Червоніє, якщо повернути одну фразу на всі випадки.
 */
test("#893b ЗАПИС · СЕРВЕР НАЗИВАЄ ПРИЧИНУ: 404 запису несе причину зі словника, а не одну фразу", () => {
  const routes = readFileSync(fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)), "utf8");
  const at = routes.indexOf('dashboardRouter.get("/ai-calls/:uniqueid/recording"');
  assert.ok(at > 0, "🔴 роут запису не знайдено");
  const body = routes.slice(at, routes.indexOf("\n});", at)); // кінець обробника — рядок, що починається з «});»
  assert.match(body, /if \(!d\.ok\) \{ res\.status\(404\)\.json\(\{ error: `Запис недоступний: \$\{RECORDING_UNAVAILABLE_UA\[d\.unavailable\]\}` \}\)/, "🔴 причина відмови не передається");
  assert.doesNotMatch(body, /Запису в Ringostat немає/, "🔴 повернулась одна фраза на всі причини");
});

/**
 * Реєстрації роутів (`<router>.get/post/put/patch/delete/all/use(...)`), що стоять НЕ на верхньому рівні файла. Роутер —
 * змінна, ініціалізована `Router()`. Вкладена реєстрація виконується лише тоді, коли спрацьовує обгортка, — і до того
 * Express відповідає «Cannot GET».
 */
async function nestedRouteRegistrations(file: string, src: string): Promise<string[]> {
  const ts = (await import("typescript")).default;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const routers = new Set<string>();
  const out: string[] = [];
  const visit = (n: import("typescript").Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)
      && /(^|\.)Router$/.test(n.initializer.expression.getText(sf))) routers.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const find = (n: import("typescript").Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
      && routers.has(n.expression.expression.text) && /^(get|post|put|patch|delete|all|use)$/.test(n.expression.name.text)) {
      const top = ts.isExpressionStatement(n.parent) && n.parent.parent === sf;
      if (!top) out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.expression.getText(sf)}(${n.arguments[0]?.getText(sf) ?? ""})`);
    }
    ts.forEachChild(n, find);
  };
  find(sf);
  return out;
}

/**
 * #894 — РОУТ РЕЄСТРУЄТЬСЯ НА ВЕРХНЬОМУ РІВНІ (Роман 07.10.2026, «нажимаю — нічого»): коміт f2dbef98 (30.09) вклав три
 * роути — тип розмови, коментар, запис — усередину гілки `if (!card)` обробника картки. Express їх не знав, доки хтось не
 * відкрив чужу/неіснуючу картку («Cannot GET …/recording»), а потім реєстрував повторно на кожній такій події. Гейт
 * читає КОЖЕН файл `routes/*.ts` деревом TypeScript, а не регуляркою.
 * 🧨 Червоніє, якщо будь-яку реєстрацію роуту поставити всередину іншого обробника чи функції.
 */
test("#896 РОУТ НА ВЕРХНЬОМУ РІВНІ: жодна реєстрація роуту в теці routes не вкладена в обробник", async () => {
  const fixture = 'import { Router } from "express";\nexport const r = Router();\nr.get("/a", (q, s) => { if (!q) { s.end();\nr.put("/b", () => {}); return; } s.end(); });\n';
  assert.deepEqual(await nestedRouteRegistrations("fixture.ts", fixture), ['fixture.ts:4 r.put("/b")'], "фікстура: вкладену реєстрацію не помічено");
  assert.deepEqual(await nestedRouteRegistrations("ok.ts", 'import { Router } from "express";\nexport const r = Router();\nr.get("/a", (q, s) => { s.end(); });\n'), [], "дзеркало: верхній рівень не скаржиться");
  const dir = fileURLToPath(new URL("../../src/routes/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length >= 30, `перелік файлів роутів підозріло малий: ${files.length}`);
  const nested: string[] = [];
  for (const f of files) nested.push(...await nestedRouteRegistrations(f, readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(nested, [], "🔴 реєстрація роуту вкладена в інший код — Express її не знає до спрацювання обгортки");
  const dash = readFileSync(path.join(dir, "dashboard.ts"), "utf8");
  for (const route of ['dashboardRouter.post("/ai-calls/:uniqueid/type"', 'dashboardRouter.put("/ai-calls/:uniqueid/note"', 'dashboardRouter.get("/ai-calls/:uniqueid/recording"'])
    assert.ok(dash.includes("\n" + route), `дзеркало: ${route} існує і починає рядок`);
});

/**
 * #895 — РОЗМОВА ЯК У «ПЕРЕВІЗНИКАХ» (Роман 07.10.2026): у картці «Першого дотику» плеєр і репліки — одна система з
 * «Перевізниками за розмовою»: ▶, смуга з перемоткою, швидкість, клік по репліці перемотує, жовтим — фрази з розбору,
 * а цитата в розборі має «▶ час». Цитата шукається в репліках ДОСЛІВНО (без регістру й пробілів); не знайдена — −1,
 * і тоді ні підсвітки, ні перемотки: не вгадуємо місце.
 * 🧨 Червоніє, якщо вгадувати репліку для не знайденої цитати, прибрати перемотку кліком чи вантажити запис не нашим роутом.
 */
test("#895 РОЗМОВА ЯК У «ПЕРЕВІЗНИКАХ»: плеєр і репліки разом, клік перемотує, цитата з розбору — лише дослівна", async () => {
  const V = await loadView();
  const turns = [{ text: "Транспортна компанія UTS, добрий день" }, { text: "Маємо 8 тонн труб у Дніпрі" }, { text: "Ціна буде   38 тисяч гривень." }];
  assert.equal(V.quoteTurnIndex(turns, "ціна буде 38 тисяч"), 2, "🔴 дослівна цитата (інший регістр, інші пробіли) не знайдена");
  assert.equal(V.quoteTurnIndex(turns, "ціна буде 40 тисяч"), -1, "🔴 не знайдену цитату прив’язано до випадкової репліки");
  assert.equal(V.quoteTurnIndex(turns, ""), -1, "порожня цитата — без місця");
  assert.equal(V.quoteTurnIndex(null, "ціна"), -1, "без тексту — без місця");
  const conv = readFileSync(FE("pages/dashboard/sections/CallConversation.tsx"), "utf8");
  assert.match(conv, /onClick=\{\(\) => \{ if \(t\.start != null\) seekRef\.current\?\.\(t\.start\); \}\}/, "🔴 клік по репліці не перемотує");
  assert.match(conv, /setSpeed\(speed === 1 \? 1\.5 : speed === 1\.5 \? 2 : 1\)/, "🔴 немає перемикача швидкості");
  assert.match(conv, /quoted\.has\(i\) \? <mark/, "🔴 фрази з розбору не підсвічено");
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw, /<CallConversation load=\{\(\) => fetchAiCallRecording\(c\.row\.uniqueid\)\}/, "🔴 запис вантажиться не через наш роут");
  assert.match(drw, /<QuoteSeek\.Provider value=\{listen && turns && !mixed \? seekQuote : null\}>/, "🔴 «▶ час» біля цитати без запису чи тексту");
  assert.ok(!/function RecordingPlayer|<audio controls/.test(drw), "🔴 повернувся старий плеєр браузера");
});

/**
 * #897 — МОНО-ЗАПИС ЧЕСНО (Роман 08.10.2026, «чому тут немає каналів»): ~5% записів Ringostat — один канал, і вся
 * розмова приходила однією реплікою з підписом «Менеджер», повністю жовта й без перемотки. Тепер: (1) моно-файл
 * розпізнається з розділенням за ГОЛОСОМ (два мовці), стерео — як і було, по каналах; (2) картка називає стан:
 * `mixed` — не розділено (підпис «Обидва голоси», без підсвітки й «▶ час»), `voices` — розділено за звучанням.
 * 🧨 Червоніє, якщо слати моно-файл по каналах, змінити поля стерео, читати `speaker_id` поверх `channel_index`, чи
 * підписувати змішаний текст «Менеджером».
 */
test("#897 МОНО-ЗАПИС ЧЕСНО: моно — розділення за голосом, стерео без змін; картка називає «не розділено» / «за голосом»", async () => {
  const P = await import("./callAiProviders.js");
  assert.deepEqual({ ...P.STT_MONO_FORM_FIELDS }, { model_id: "scribe_v2", use_multi_channel: "false", diarize: "true", num_speakers: "2",
    timestamps_granularity: "word", tag_audio_events: "false" }, "🔴 моно не розділяється за голосом");
  assert.equal(P.STT_FORM_FIELDS.use_multi_channel, "true", "дзеркало: стерео — по каналах, як і було");
  assert.equal(P.STT_FORM_FIELDS.diarize, "false", "дзеркало: стерео без розділення за голосом");
  // Розділена за голосом відповідь — плоска форма, мовець у `speaker_id`.
  const flat = P.parseSttResponse({ words: [
    { type: "word", text: "Добрий", start: 0, end: 0.4, speaker_id: "speaker_0" },
    { type: "word", text: "день", start: 0.4, end: 0.7, speaker_id: "speaker_0" },
    { type: "word", text: "Вітаю", start: 1.0, end: 1.4, speaker_id: "speaker_1" },
  ] });
  assert.deepEqual(P.toTurns(flat).map((t) => [t.channel, t.text]), [[0, "Добрий день"], [1, "Вітаю"]], "🔴 мовці не стали репліками");
  // Стерео: канал із `channel_index` сильніший за випадковий `speaker_id`.
  const stereo = P.parseSttResponse({ transcripts: [
    { channel_index: 0, words: [{ type: "word", text: "Алло", start: 0, end: 0.3, channel_index: 0, speaker_id: "speaker_1" }] },
    { channel_index: 1, words: [{ type: "word", text: "Так", start: 0.5, end: 0.7, channel_index: 1, speaker_id: "speaker_0" }] },
  ] });
  assert.deepEqual(P.toTurns(stereo).map((t) => t.channel), [0, 1], "🔴 speaker_id перебив канал стерео");
  // Виклик: моно-файл їде полями моно, стерео — полями стерео.
  const sent: Record<string, string>[] = [];
  const deps = { sleep: async () => {}, nowMs: () => 0,
    fetch: (async (_u: string, init: RequestInit) => { const fd = init.body as FormData; const o: Record<string, string> = {};
      for (const [k, v] of fd.entries()) if (typeof v === "string") o[k] = v; sent.push(o);
      return new Response(JSON.stringify({ words: [] }), { status: 200, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch };
  const pol = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 1000 };
  await P.elevenLabsTranscribe(deps, "k", { bytes: new Uint8Array([1]), contentType: "audio/wav" }, pol, { mono: true });
  await P.elevenLabsTranscribe(deps, "k", { bytes: new Uint8Array([1]), contentType: "audio/wav" }, pol);
  assert.equal(sent[0].diarize, "true", "🔴 моно-файл пішов без розділення за голосом");
  assert.equal(sent[1].use_multi_channel, "true", "дзеркало: без прапорця — по каналах");
  const pipe = readFileSync(fileURLToPath(new URL("../../src/core/callAiPipeline.ts", import.meta.url)), "utf8");
  assert.match(pipe, /w\.transcribe\(w\.apiKey, \{ bytes: got\.bytes, contentType: "audio\/wav" \}, \{ mono: got\.info\.channels === 1 \}\)/, "🔴 конвеєр не каже, що файл моно");
  const tick = readFileSync(fileURLToPath(new URL("../../src/core/callAiTick.ts", import.meta.url)), "utf8");
  assert.match(tick, /transcribe: \(key, audio, opts\) => elevenLabsTranscribe\(env\.http, key, audio, STT_POLICY, opts\)/, "🔴 «Перший дотик» не передає моно далі");
  // Картка: стан моно.
  const S = await import("./callAiScreen.js");
  assert.equal(S.monoKind(1, [{ channel: 0 }]), "mixed", "🔴 нерозділений моно не названо");
  assert.equal(S.monoKind(1, [{ channel: 0 }, { channel: 1 }]), "voices", "🔴 розділений за голосом не названо");
  assert.equal(S.monoKind(2, [{ channel: 0 }]), null, "дзеркало: стерео — не моно");
  assert.equal(S.monoKind(null, null), null, "невідомо — не моно");
  const conv = readFileSync(FE("pages/dashboard/sections/CallConversation.tsx"), "utf8");
  assert.match(conv, /const who = mixed \? "Обидва голоси" : speakerOf\(t\.channel, managerChannel\);/, "🔴 змішаний текст підписано «Менеджером»");
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw, /const all = r && !mixed \? \[r\.price, \.\.\.r\.objections, \.\.\.r\.promises\] : \[\];/, "🔴 змішаний моно весь підсвічено");
});




/**
 * #899 — ЕКРАН D ПІСЛЯ ПЕРШОГО ДНЯ (Роман 08.10.2026, список зауважень): (1) блок менеджерів рахується по всій команді,
 * без фільтра «менеджер», — після кліку по менеджеру решта не зникає, повторний клік чи чіп «✕» знімають вибір;
 * (2) блок згортається й памʼятає це; (3) запис тягнеться одразу при відкритті картки, а грає лише після ▶; один плеєр
 * за раз; згорнута черга ставить запис на паузу, кожна розмова — свій плеєр; (4) у черзі — розбір AI і текст розмови тим
 * самим компонентом, що в боковій картці; (5) обіцянка написати в месенджер не підписується «не було».
 * 🧨 Червоніє, якщо блок менеджерів знову фільтрувати за вибраним, прибрати паузу згорнутої черги чи попереднє
 * завантаження, повернути в чергу лише підсумок або писати «не було» при обіцянці у Viber.
 */
test("#899 ЕКРАН D: менеджери не зникають і вибір знімається, плеєр не грає у фоні, у черзі є розбір і розмова", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /const lines = managerChecklist\(tabRows\(applyListFilter\(d\.rows, \{ \.\.\.lf, managerId: null \}\), "report"\)\);/, "🔴 блок менеджерів фільтрується за вибраним менеджером");
  assert.match(sec, /managerId: lf\.managerId === l\.managerId \? null : l\.managerId/, "🔴 повторний клік не знімає вибір менеджера");
  assert.match(sec, /onClick=\{\(\) => setLf\(\{ \.\.\.lf, managerId: null \}\)\} aria-label=\{`Зняти фільтр: \$\{pickedName\}`\}/, "🔴 немає чіпа, що знімає вибір менеджера");
  assert.match(sec, /localStorage\.getItem\("ftd\.mgrCollapsed"\)/, "🔴 блок менеджерів не згортається або не памʼятає цього");
  const conv = readFileSync(FE("pages/dashboard/sections/CallConversation.tsx"), "utf8");
  assert.match(conv, /useEffect\(\(\) => \{ if \(preload && state === "idle"\) void start\(\); \}, \[\]\);/, "🔴 запис не тягнеться одразу при відкритті");
  assert.match(conv, /useEffect\(\(\) => \{ if \(!active\) \{ want\(false\); audio\.current\?\.pause\(\); \} \}, \[active\]\);/, "🔴 схований плеєр грає далі");
  assert.match(conv, /if \(\(e as CustomEvent<number>\)\.detail !== myId\.current\) audio\.current\?\.pause\(\);/, "🔴 два записи можуть грати одночасно");
  assert.match(conv, /if \(state === "ready" && audio\.current && wantPlay\.current\)/, "🔴 попередньо завантажений запис грає сам, без ▶");
  const qx = readFileSync(FE("pages/dashboard/sections/FirstTouchQueue.tsx"), "utf8");
  assert.match(qx, /<CallConversation key=\{c\.row\.uniqueid\}[\s\S]{0,400}?active=\{open\} \/>/, "🔴 черга: старий запис грає після переходу чи закриття");
  assert.match(qx, /<Analysis c=\{c\} \/>/, "🔴 у черзі немає розбору AI");
  assert.match(qx, /import \{ Analysis, QuoteSeek \} from "\.\/AiCallDrawer";/, "🔴 розбір у черзі — копія, а не той самий компонент");
  const chk = readFileSync(FE("pages/dashboard/sections/FirstTouchChecklist.tsx"), "utf8"); // текст переїхав у спільний чек-лист (#899b)
  assert.match(chk, /обіцянка написати: \$\{msgPromise\.what\} — перевірити нічим, Ringostat месенджерів не бачить/, "🔴 обіцянка у Viber підписана «не було»");
});

/**
 * #899b — ОДНА КАРТКА З БУДЬ-ЯКОГО РЯДКА (Роман 08.10.2026: «на розібраний показує так, на нерозібраний — інакше»).
 * Клік по рядку завжди відкриває бічну картку; режим «Розбір» — окремо, лише кнопкою в смузі. Чек-лист у картці й у
 * черзі — один компонент; стан пунктів і «потребує розбору» картка бере з сервера (ті самі функції ядра, що й список);
 * кнопка «Розібрано» — лише коли сервер каже `needsReview && canReview`.
 * 🧨 Червоніє, якщо рядок знову відкриватиме різне, черга й картка намалюють чек-лист кожна своїм кодом, чи кнопка
 * «Розібрано» зʼявиться без прапорців сервера.
 */
test("#899b ОДНА КАРТКА: рядок завжди відкриває картку, чек-лист спільний, «Розібрано» — за прапорцями сервера", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.ok(!/r\.needsReview \? openQueue/.test(sec), "🔴 рядок з черги знову відкриває інший вигляд");
  assert.match(sec, /onClick=\{\(\) => openQueue\(\)\}>\{reviewedN > 0 \? "Продовжити розбір ›" : "Почати розбір ›"\}/, "🔴 режим «Розбір» не відкривається зі смуги");
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  const qx = readFileSync(FE("pages/dashboard/sections/FirstTouchQueue.tsx"), "utf8");
  for (const [name, src] of [["картка", drw], ["черга", qx]] as const) {
    assert.match(src, /import \{ ChecklistBlock \} from "\.\/FirstTouchChecklist";/, `🔴 ${name}: чек-лист не спільний`);
    assert.ok(!/CHECK_ITEMS\.map/.test(src), `🔴 ${name}: чек-лист намальовано власним кодом`);
  }
  assert.match(drw, /if \(!c\.needsReview \|\| !c\.canReview\) return null;/, "🔴 «Розібрано» без прапорців сервера");
  const routes = readFileSync(fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)), "utf8");
  assert.match(routes, /checklist: checklist\(card\.row\), checkScore: checklistScore\(checklist\(card\.row\)\), reviewReason: reviewReason\(card\.row\),\s*needsReview: needsReview\(card\.row\), canReview: canWriteNote\(auth\.roleKey, "review"\),/, "🔴 картка рахує чек-лист не ядром");
});

/**
 * #900 — «ПЕРЕДЗВОНИВ ПОЗА ТЕЛЕФОНІЄЮ» · ЯДРО Й ЕКРАН (Юля й Андрій 01.10.2026). Звірка 30 «не передзвонив» з Ringostat:
 * у 25 нашого дзвінка в телефонії немає зовсім, а передзвони були з мобільного чи в месенджер. Тому: ручна позначка
 * переводить «немає дзвінка», «запізнився» й «чекає» у виконане й рахується в «виконано», а не в «немає дзвінка» чи
 * банер; ставлять її менеджер (свої), тімлід, адмін; стан у таблиці — без червоного й з чесним «за даними телефонії».
 * 🎛 05.10.2026 (замінює #865): колір БЛОКУ тепер перемикає адмін у «Налаштуваннях» — червоний лише за `bannerTone
 * === "alert"`, заголовок і підпис «перевіряється» в обох кольорах однакові (рішення власника: «перемикач тільки кольору»).
 * 08.10.2026 (ТЗ «фінальні доробки»): менеджеру позначку вимкнено — без редагування, спершу фідбек тімлідів. Замінює `#869`.
 * 🧨 Червоніє, якщо позначка не гасить банер, не рахується виконаною, перебиває «Передзвонив» з телефонії, відкрита
 * CEO, якщо стан у таблиці знову червоний або блок червоніє без налаштування.
 */
test("#900 ПОЗА ТЕЛЕФОНІЄЮ: позначка = виконано, гасить банер; ставлять тімлід і адмін, менеджеру вимкнено; блок червоний лише з «Налаштувань»", async () => {
  const { withOfflineMark } = await import("./callAiPromise.js");
  for (const s of ["broken", "late", "pending"] as const) assert.equal(withOfflineMark(s, true), "kept_offline", `🔴 позначка не перевела «${s}» у виконане`);
  for (const s of ["broken", "late", "pending"] as const) assert.equal(withOfflineMark(s, false), s, "дзеркало: без позначки стан не міняється");
  for (const s of ["kept_talk", "kept_attempt_only", "client_called", "unverifiable"] as const) assert.equal(withOfflineMark(s, true), s, `🔴 позначка перебила стан з телефонії «${s}»`);
  assert.equal(withOfflineMark(null, true), null, "🔴 позначка вигадала обіцянку там, де її немає");

  const { teamReport } = await import("./firstTouchTeamReport.js");
  const r = (id: string, o: Record<string, unknown>) => ({ uniqueid: id, calledAt: "2026-09-29T08:00:00Z", managerId: 1, managerName: "M1",
    teamName: "T", inReport: true, state: "done", priceDiscussed: true, promiseState: null, typeCheck: false, priceNote: null, missedNote: null, ...o });
  const t = teamReport([r("a", { promiseState: "kept_offline" }), r("b", { promiseState: "broken" })] as never[]);
  assert.deepEqual([t.total.agreements, t.total.done, t.total.missed, t.banner.total], [2, 1, 1, 1], "🔴 «поза телефонією» не рахується виконаним або лишилось у банері");

  const { canWriteNote } = await import("./callAiScreen.js");
  for (const k of ["admin", "team_lead"]) assert.equal(canWriteNote(k, "offline"), true, `дзеркало: ${k} позначає «поза телефонією»`);
  for (const k of ["manager", "ceo", "opdir", "kvp", "financier", "hr"]) assert.equal(canWriteNote(k, "offline"), false, `🔴 ${k} позначає «поза телефонією» (менеджеру вимкнено 08.10.2026)`);

  const V = await loadView() as unknown as { PROMISE_UI: Record<string, { label: string; tone: string }> };
  assert.equal(V.PROMISE_UI.broken.tone === "bad", false, "🔴 «немає дзвінка в телефонії» знову червоне — вирок до звірки людиною");
  assert.match(V.PROMISE_UI.broken.label, /телефоні/, "🔴 підпис знову звучить як вирок, а не як стан даних");
  assert.deepEqual([V.PROMISE_UI.kept_offline?.label, V.PROMISE_UI.kept_offline?.tone], ["Передзвонив поза телефонією", "ok"]);
  const card = readFileSync(FE("pages/dashboard/sections/FirstTouchReportCard.tsx"), "utf8");
  assert.ok(!/role="alert"/.test(card), "🔴 блок «немає дзвінка» знову тривога для скрінрідера");
  assert.match(card, /const alert = rep\.bannerTone === "alert";/, "🔴 колір блоку не з налаштування сервера");
  assert.equal((card.match(/--danger-bg/g) ?? []).length, 1, "🔴 червоний фон зʼявився поза перемикачем");
  assert.match(card, /background: alert \? "var\(--danger-bg, #fde8e8\)" : "var\(--surface-2, #f4f5f7\)"/, "🔴 червоний фон не залежить від налаштування");
  assert.equal((card.match(/Обіцяв передзвонити — дзвінка в телефонії немає/g) ?? []).length, 1, "🔴 заголовок залежить від кольору — а мав лишитись чесним в обох");
  assert.match(card, /перевіряється, не для розборів/, "🔴 блок не каже, що дані перевіряються");
  const rep = SRC("routes/dashboard.ts");
  const at0 = rep.indexOf('dashboardRouter.get("/ai-calls/team-report"'), nx = rep.indexOf("dashboardRouter.", at0 + 10);
  assert.match(rep.slice(at0, nx), /const \{ bannerTone \} = await loadTunables\(pool\);[\s\S]*truncated, bannerTone,/, "🔴 колір блоку не з налаштувань сервера");
  const setUi = readFileSync(FE("pages/dashboard/sections/SettingsSection.tsx"), "utf8");
  assert.match(setUi, /\{sub === "Загальні" && roleKey === "admin" && <FirstTouchSettingsCard \/>\}/, "🔴 блок налаштувань видно не лише адміну (чи за сумісною role, де CEO теж «admin»)");
  assert.match(readFileSync(FE("pages/Dashboard.tsx"), "utf8"), /role=\{auth\?\.role\}\s*roleKey=\{auth\?\.roleKey\}/, "🔴 ключ ролі не доходить до «Налаштувань»");
  const drw0 = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw0, /обіцяв до \{fmtFull\(chk\.deadline\)\}[\s\S]{0,160}chk\.countUntil !== chk\.deadline && <> · <b>зараховуємо до \{fmtFull\(chk\.countUntil\)\}/, "🔴 картка не показує обидва терміни");
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw, /<NoteField c=\{c\} kind="offline"/, "🔴 у картці немає позначки «Передзвонив поза телефонією»");
  assert.match(drw, /const needOffline = c\.row\.promiseState === "broken" \|\| c\.row\.promiseState === "late" \|\| c\.row\.offlineNote != null;/, "🔴 позначку не видно там, де вона потрібна");
});

/**
 * #904 — ЧЕК-ЛИСТ З 3 ПУНКТІВ І ЧЕРГА РОЗБОРУ (екран D, Роман 08.10.2026 «роби D з 3 пунктів»). Ядро вирішує стан
 * кожного пункту: запит (є/немає), ціна (втрачений лід — не рахується), обіцянка (виконано · запізнився/немає дзвінка ·
 * не було/ще не час — не рахується); бал = виконані ÷ ті, що рахуються; нерозібрана розмова чек-листа НЕ має. Черга:
 * немає дзвінка → втрачений → без ціни → запізнився; «Розібрано» чи «Опрацьовано» виводять з черги.
 * 08.10.2026 (ТЗ «фінальні доробки», критерій 4): четвертий пункт — заперечення; рахується лише коли воно було. Замінює `#898`.
 * 🧨 Червоніє, якщо втрачений лід рахувати як «ціну не назвали», «обіцянки не було» — як «ні», нерозібране — як нуль,
 * чи лишати розібране в черзі. Право «Розібрано» — лише тімлід і адмін.
 */
test("#904 ЧЕК-ЛИСТ D: 4 пункти й бал від ядра (заперечення — лише коли було), черга розбору, розібране виходить з черги", async () => {
  const R = await import("./firstTouchTeamReport.js");
  const S = await import("./callAiScreen.js");
  const base = { uniqueid: "u", calledAt: "2026-10-05T10:00:00.000Z", managerId: 1, managerName: "М", teamName: "Т", inReport: true, state: "done",
    priceDiscussed: true, promiseState: null, typeCheck: false, priceNote: null, missedNote: null, conversationType: "cargo_request", hasRequest: true, reviewNote: null };
  assert.deepEqual(R.checklist({ ...base }), { request: "y", price: "y", promise: "o", objection: "o" }, "🔴 без обіцянки й заперечення пункти мусять не рахуватись");
  assert.equal(R.checklist({ ...base, objection: { present: true, handled: "handled" } })?.objection, "y", "🔴 опрацьоване заперечення — не «так»");
  assert.equal(R.checklist({ ...base, objection: { present: true, handled: "not_handled" } })?.objection, "n", "🔴 неопрацьоване заперечення — не «ні»");
  assert.equal(R.checklist({ ...base, objection: { present: false, handled: "n/a" } })?.objection, "o", "🔴 заперечення не було, а пункт рахується");
  assert.equal(R.checklist({ ...base, objection: null })?.objection, "o", "🔴 рубрика ще не пройшла, а пункт рахується як «ні»");
  assert.deepEqual(R.checklistScore(R.checklist({ ...base, objection: { present: true, handled: "not_handled" } })), { yes: 2, total: 3 }, "🔴 заперечення не входить у бал");
  assert.deepEqual(R.checklistScore(R.checklist({ ...base })), { yes: 2, total: 2 });
  const lost = R.checklist({ ...base, conversationType: "lead_lost", priceDiscussed: false });
  assert.equal(lost?.price, "o", "🔴 втрачений лід рахується як «ціну не назвали»");
  assert.equal(lost?.request, "o", "🔴 втрачений лід рахується як «запит не зʼясовано» (рішення Романа 08.10.2026)");
  assert.equal(R.checklist({ ...base, priceDiscussed: false })?.price, "n", "дзеркало: звичайна розмова без ціни — «ні»");
  assert.equal(R.checklist({ ...base, hasRequest: false })?.request, "n", "дзеркало: запиту немає — «ні»");
  for (const st of ["kept_talk", "kept_attempt_only", "kept_offline", "client_called"] as const) assert.equal(R.checklist({ ...base, promiseState: st })?.promise, "y", `🔴 ${st} — не «виконано»`);
  for (const st of ["late", "broken"] as const) assert.equal(R.checklist({ ...base, promiseState: st })?.promise, "n", `🔴 ${st} — не «ні»`);
  assert.equal(R.checklist({ ...base, promiseState: "pending" })?.promise, "o", "🔴 термін ще не настав, а пункт уже «ні»");
  assert.equal(R.checklist({ ...base, state: "queued" }), null, "🔴 нерозібрана розмова отримала чек-лист (нуль замість «не знаємо»)");
  assert.equal(R.checklistScore(null), null);
  // Черга
  assert.equal(R.reviewReason({ ...base, promiseState: "broken", priceDiscussed: false }), "noCall", "🔴 «немає дзвінка» не перша причина");
  assert.equal(R.reviewReason({ ...base, conversationType: "lead_lost" }), "lost");
  assert.equal(R.reviewReason({ ...base, priceDiscussed: false }), "noPrice");
  assert.equal(R.reviewReason({ ...base, promiseState: "late" }), "late");
  assert.equal(R.reviewReason({ ...base, promiseState: "kept_talk" }), null, "дзеркало: усе виконано — у черзі нема що робити");
  assert.equal(R.needsReview({ ...base, priceDiscussed: false }), true);
  assert.equal(R.needsReview({ ...base, priceDiscussed: false, reviewNote: { text: "Розібрано" } }), false, "🔴 розібране лишилось у черзі");
  assert.equal(R.needsReview({ ...base, promiseState: "broken", missedNote: { text: "ок" } }), false, "🔴 «Опрацьовано» не виводить з черги");
  const q = R.reviewQueue([{ ...base, priceDiscussed: false }, { ...base, uniqueid: "v", priceDiscussed: false, reviewNote: { text: "x" } }, { ...base, uniqueid: "w" }]);
  assert.deepEqual(q, { total: 2, reviewed: 1, left: 1, byReason: { noCall: 0, late: 0, noPrice: 1, lost: 0 } }, "🔴 лічильник смуги черги");
  assert.equal(S.canWriteNote("manager", "review"), false, "🔴 менеджер ставить собі «Розібрано»");
  assert.equal(S.canWriteNote("team_lead", "review"), true, "дзеркало: тімлід розбирає");
  assert.equal(S.canWriteNote("admin", "review"), true);
  const schema = readFileSync(fileURLToPath(new URL("../../src/db/schema.sql", import.meta.url)), "utf8");
  assert.match(schema, /first_touch_notes_kind_check CHECK \(kind IN \('price', 'missed', 'offline', 'review'\)\);/, "🔴 база не приймає позначку «Розібрано»");
});

/**
 * #905 — ЗАПЕРЕЧЕННЯ ОКРЕМОЮ РУБРИКОЮ (ТЗ «фінальні доробки» 08.10.2026, критерій 4; «1 ок»). Відповідь моделі
 * приймається лише несуперечлива («не було» → тип «немає» і «n/a»; «було» → тип і опрацювання задані); цитату клієнта
 * звіряємо з текстом ОДНОГО каналу; конвеєр бере рубрику лише для розмов від `OBJECTION_FROM` і в межах бюджету
 * розбору — старі розмови тільки окремим запуском.
 * 🧨 Червоніє, якщо приймати суперечливу відповідь, шукати цитату склейкою двох каналів, пустити рубрику на всі старі
 * розмови чи вийти за бюджет тіку.
 */
test("#905 ЗАПЕРЕЧЕННЯ: окрема рубрика, лише несуперечлива відповідь, цитата з одного каналу, старі розмови — не самі", async () => {
  const O = await import("./callAiObjection.js");
  const ok = { present: true, type: "price" as const, client_quote: "це дорого", handled: "handled" as const, manager_action: "запропонував догруз" };
  assert.equal(O.validateObjection(ok).ok, true, "дзеркало: нормальна відповідь приймається");
  assert.equal(O.validateObjection({ present: false, type: "none", client_quote: "", handled: "n/a", manager_action: "" }).ok, true, "дзеркало: «не було» приймається");
  assert.equal(O.validateObjection({ ...ok, present: false }).ok, false, "🔴 «не було», але тип і опрацювання задані — прийнято");
  assert.equal(O.validateObjection({ ...ok, handled: "n/a" }).ok, false, "🔴 «було», але «n/a» — прийнято");
  assert.equal(O.validateObjection({ ...ok, handled: "maybe" }).ok, false, "🔴 опрацювання поза переліком — прийнято");
  const turns = [{ channel: 0, start: 0, end: 2, text: "Скільки це буде?", lang: null }, { channel: 1, start: 2, end: 4, text: "Дванадцять тисяч", lang: null },
    { channel: 0, start: 4, end: 6, text: "Ого, це дорого для нас", lang: null }];
  assert.equal(O.verifyObjectionQuote({ ...ok, client_quote: "це дорого" }, turns).quote_found, true, "🔴 справжня цитата клієнта не знайдена");
  assert.equal(O.verifyObjectionQuote({ ...ok, client_quote: "тисяч ого" }, turns).quote_found, false, "🔴 склейка з двох каналів прийнята як цитата");
  assert.equal(O.verifyObjectionQuote({ ...ok, client_quote: "" }, turns).quote_found, null, "порожня цитата — не звіряємо");
  for (const rule of ["зʼясував причину", "аргументував цінність", "запропонував альтернативу", "наступний крок із часом", "«добре, думайте»"])
    assert.ok(O.OBJECTION_SYSTEM_PROMPT.includes(rule), `🔴 у промпті немає правила ТЗ: ${rule}`);
  const tick = SRC("core/callAiTick.ts");
  assert.match(tick, /const objIds = await objectionCandidates\(env\.db, OBJECTION_FROM\);/, "🔴 рубрика заперечень бере не лише нові розмови");
  assert.match(tick, /WHERE \(rc\.calldate AT TIME ZONE 'Europe\/Kyiv'\)::date >= \$2::date/, "🔴 межа дати не за Києвом");
  assert.match(tick, /apiKey: env\.keys\.gemini, kit: OBJECTION_KIT,/, "🔴 порція заперечень іде без своєї рубрики");
  const T = await import("./callAiTick.js");
  assert.ok(T.OBJ_BUDGET_MS > 0 && T.OBJ_BUDGET_MS < T.LLM_BUDGET_MS, "🔴 бюджет заперечень поза бюджетом розбору");
  // 4631 (09.10.2026): розбір розмов про борг теж бере ЧАСТКУ того самого бюджету — твердження те саме.
  assert.match(tick, /LLM_BUDGET_MS - OBJ_BUDGET_MS(?: - DEBT_BUDGET_MS)?, env\.http\.nowMs, out\.llm\)/, "🔴 заперечення додали час до тіку замість частки розбору");
});

/**
 * #920 — УСПІХ УГОДИ = МАШИНА ПОЇХАЛА (рішення Романа 09.10.2026, задача з TOP Weekly 08.10). Успіх = ЗАРАЗ «Авто працює»
 * або далі в повному циклі (`AUTO_WENT_STATUSES`), включно з 142; 142 — лише в повному циклі (у кваліфікації це
 * «Кваліфіковано», у Продзвоні — «Відправлено у відділ продажів»). Кваліфікація — за дочірньою угодою; розмова з кількома
 * угодами — успіх, якщо поїхала хоч одна; відмова — лише коли відмовили всі.
 * 🧨 Червоніє, якщо успіх знову рахується лише від 142, якщо етап до «Авто працює» (рахунок) читається як поїздка, або якщо
 * передача з кваліфікації чи Продзвону читається як продаж.
 */
test("#920 УСПІХ = МАШИНА ПОЇХАЛА: «Авто працює» і далі в повному циклі; рахунок — ще ні; 142 лише повного циклу; кваліфікація — за дочірньою", async () => {
  const U = await import("./firstTouchOutcome.js");
  const d = (statusId: number, pipelineId = 8921932) => ({ kommoId: 1, pipelineId, statusId, rejectReason: statusId === 143 ? "дорого" : null });
  assert.deepEqual(U.outcomeOfDeal(d(69716300), []), { state: "success", lossReason: null }, "🔴 «Авто працює» не рахується успіхом — знову лише 142");
  assert.equal(U.outcomeOfDeal(d(10937178, 155304), []).state, "success", "🔴 «Авто працює» старої воронки повного циклу не рахується");
  assert.equal(U.outcomeOfDeal(d(69716460), []).state, "success", "оплата отримана — машина давно поїхала");
  assert.deepEqual(U.outcomeOfDeal(d(142), []), { state: "success", lossReason: null });
  assert.equal(U.outcomeOfDeal(d(100274340), []).state, "open", "🔴 «Виставлення рахунку» (до «Авто працює») прочитано як поїздку");
  assert.deepEqual(U.outcomeOfDeal(d(143), []), { state: "lost", lossReason: "дорого" });
  assert.equal(U.outcomeOfDeal(d(142, 8921936), []).state, "open", "🔴 «Відправлено у відділ продажів» у Продзвоні прочитано як продаж");
  assert.equal(U.outcomeOfDeal(d(142, 8921928), []).state, "open", "🔴 «Кваліфіковано» без дочірньої угоди прочитано як продаж");
  assert.equal(U.outcomeOfDeal(d(142, 8921928), [d(69716300)]).state, "success", "🔴 поїздка дочірньої угоди не дійшла до кваліфікації");
  assert.equal(U.outcomeOfDeal(d(142, 8921928), [d(143)]).state, "lost");
  assert.equal(U.outcomeOfDeal(d(143, 7336928), []).state, "lost", "дзеркало: відмова в кваліфікації без дочірньої — відмова");
  assert.equal(U.outcomeOfCall([{ state: "lost", lossReason: "x" }, { state: "success", lossReason: null }]).state, "success", "🔴 відмова однієї угоди сховала успіх іншої");
  assert.equal(U.outcomeOfCall([{ state: "lost", lossReason: "x" }, { state: "open", lossReason: null }]).state, "open", "🔴 відмова, хоча друга угода ще в роботі");
  assert.equal(U.outcomeOfCall([]).state, "open", "угод не знайдено — не «відмова»");
  const { AUTO_WENT_STATUSES } = await import("./moneyBuckets.js");
  for (const s of AUTO_WENT_STATUSES) assert.ok(U.carWent({ pipelineId: null, statusId: s }), `🔴 етап ${String(s)} «авто поїхало» не дає успіху`);
  const scr = SRC("core/callAiScreen.ts");
  assert.match(scr, /const outcomes = await dealOutcomes\(db, \[\.\.\.new Set\(out\.flatMap\(\(r\) => r\.kommoIds\)\)\]\);/, "🔴 список не рахує успіх угоди");
});

/**
 * #907 — ЦІЛЬ «ЦІНУ ОЗВУЧЕНО» В НАЛАШТУВАННЯХ І ПОЛЯ ПЛИТОК (ТЗ 08.10.2026, пункт 3). Ціль — 50 % за замовчуванням,
 * 1…100, змінює лише адмін без викату; список віддає ціль усім ролям вкладки (колір плитки), а знаменники плиток —
 * прапорцями ядра, не другою копією правил на фронті.
 * 🧨 Червоніє, якщо ціль прийме 0 чи 101, зникне з відповіді списку, або знаменники плиток рахуватимуться не ядром.
 */
test("#907 ЦІЛЬ ЦІНИ: 50 % за замовчуванням, 1…100, з налаштувань; знаменники плиток — прапорці ядра", async () => {
  const F = await import("./firstTouchTunables.js");
  const base = { repeatWindowDays: 30, callbackGraceMin: 10, callbackMinDeadlineMin: 20, bannerTone: "neutral" };
  assert.equal((F.parseTunables(base) as { value: { priceTargetPct: number } }).value.priceTargetPct, 50, "🔴 без поля ціль не 50");
  assert.equal((F.parseTunables({ ...base, priceTargetPct: 60 }) as { value: { priceTargetPct: number } }).value.priceTargetPct, 60, "дзеркало: ціль змінюється");
  for (const bad of [0, 101, 55.5, "50"]) assert.equal(F.parseTunables({ ...base, priceTargetPct: bad }).ok, false, `🔴 ціль ${JSON.stringify(bad)} прийнято`);
  const schema = readFileSync(fileURLToPath(new URL("../../src/db/schema.sql", import.meta.url)), "utf8");
  assert.match(schema, /ADD COLUMN IF NOT EXISTS price_target_pct INTEGER\s+CHECK \(price_target_pct IS NULL OR price_target_pct BETWEEN 1 AND 100\);/, "🔴 база не тримає межі цілі");
  const routes = readFileSync(fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)), "utf8");
  assert.match(routes, /priceTargetPct: \(await loadTunables\(pool\)\)\.priceTargetPct,/, "🔴 список не віддає ціль");
  assert.match(routes, /flags: \{ analysed: isAnalysed\(r\), priceable: isPriceable\(r\), agreement: hasAgreement\(r\), lost: isLost\(r\) \},/, "🔴 знаменники плиток не від ядра");
});

/**
 * #909 — ЕКРАН D ЗІБРАНО ЯК У МАКЕТІ (Роман 08.10.2026 «дизайн як на макеті майже 1 в 1»): колонки таблиці — Розмова ·
 * Менеджер · Про що (AI) · Чек-лист · Обіцянка · Реакція · Розбір; смуга черги й сама черга — лише тому, хто може
 * «Розібрано» (`canReview` від сервера); стан нерозібраної розмови видно в колонці чек-листа; черга згортається класом
 * `is-closed`, а при «зменшенні руху» — без анімації. Замінює `#796` (стара таблиця з колонкою «Стан»).
 * 08.10.2026 (ТЗ «фінальні доробки»): додано колонку «Успіх» (стан угоди в Kommo). Замінює `#898c`.
 * 🧨 Червоніє, якщо переставити колонки, показати чергу менеджеру, сховати стан «У черзі» чи прибрати анімацію/її вимкнення.
 */
test("#909 ЕКРАН D: колонки з «Успіх», черга лише для тімліда й адміна, згортання в смугу", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  const heads = [...sec.matchAll(/<th style=\{cell\}>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ["Розмова", "Менеджер", "Про що (AI)", "Чек-лист", "Обіцянка", "Успіх", "Реакція", "Розбір"], `🔴 колонки: ${heads.join(" · ")}`);
  assert.match(sec, /\{d\.canReview && \(\s*<section aria-label="Черга розбору"/, "🔴 смуга черги без перевірки права");
  assert.match(sec, /\{d\.canReview && \(\s*<FirstTouchQueue rows=\{queue\} open=\{queueOpen\}/, "🔴 черга без перевірки права");
  assert.match(sec, /const queue = queueRows\(rows\);/, "🔴 черга не з прапорця сервера");
  assert.match(sec, /: r\.state === "done" \? null : <StateChip state=\{r\.state\} \/>\}<\/td>/, "🔴 стан нерозібраної розмови сховано");
  const qx = readFileSync(FE("pages/dashboard/sections/FirstTouchQueue.tsx"), "utf8");
  assert.match(qx, /className=\{`ftd-queue\$\{open \? "" : " is-closed"\}`\}/, "🔴 черга не згортається класом");
  assert.match(qx, /putAiCallNote\(cur\.uniqueid, "review", note\.trim\(\) \|\| "Розібрано"\)/, "🔴 «Опрацьовано · наступна» не ставить «Розібрано»");
  const css = readFileSync(FE("pages/dashboard/sections/firstTouch.css"), "utf8");
  assert.match(css, /\.ftd-queue\.is-closed \{ transform: translateY\(-20px\) scale\(\.42, \.12\); opacity: 0;/, "🔴 немає анімації згортання в смугу");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.ftd-over, \.ftd-queue, \.ftd-strip, \.ftd-progress > i \{ transition: none; \}/, "🔴 анімацію не вимкнено для «зменшення руху»");
});

/**
 * #908 — ПЛИТКА = СПИСОК ПІСЛЯ КЛІКУ (ТЗ 08.10.2026, критерій готовності «число на кожній плитці збігається з кількістю
 * рядків у пулі після кліку»). І число, і фільтр — одне правило `TILE_MATCH`; знаменники — прапорці сервера; «успіх» —
 * числами, відсоток лише коли в обох групах «ціна → успіх» від 30 успішних.
 * 🧨 Червоніє, якщо плитка рахує одним правилом, а фільтр — іншим, «не рахується» потрапить у знаменник, або відсоток
 * «ціна → успіх» зʼявиться на кількох угодах.
 */
test("#908 ПЛИТКИ: число = рядки після кліку (одне правило), знаменники від сервера, успіх числами до 30", async () => {
  const V = await loadView();
  const f = { analysed: true, priceable: true, agreement: false, lost: false };
  const row = (o: Record<string, unknown>) => ({ promiseState: null, conversationType: "cargo_request", dealOutcome: { state: "open" }, flags: f,
    checklist: { request: "y", price: "y", promise: "o", objection: "o" }, ...o });
  const rows = [
    row({ promiseState: "broken", flags: { ...f, agreement: true }, checklist: { request: "y", price: "n", promise: "n", objection: "n" } }),
    row({ promiseState: "kept_talk", flags: { ...f, agreement: true }, checklist: { request: "y", price: "y", promise: "y", objection: "y" }, dealOutcome: { state: "success" } }),
    row({ conversationType: "lead_lost", flags: { ...f, priceable: false, lost: true }, checklist: { request: "o", price: "o", promise: "o", objection: "o" } }),
    row({ flags: { ...f, analysed: false }, checklist: null, dealOutcome: null }),
  ];
  const st = V.tileStats(rows);
  assert.deepEqual(st.noCall, { n: 1, of: 2 }, "🔴 «немає дзвінка» не з тих, хто обіцяв");
  assert.deepEqual([st.price.yes, st.price.of], [1, 2], "🔴 втрачений лід або нерозібране — у знаменнику ціни");
  assert.deepEqual([st.objection.handled, st.objection.of], [1, 2], "🔴 «заперечення не було» у знаменнику");
  assert.equal(st.lost, 1);
  assert.deepEqual(st.success, { n: 1, of: 3 }, "🔴 нерозібране у знаменнику успіху");
  for (const k of ["noCall", "noPrice", "objNotHandled", "lost", "success"]) {
    const n = rows.filter(V.TILE_MATCH[k]).length;
    assert.ok(n >= 0);
  }
  assert.equal(rows.filter(V.TILE_MATCH.noCall).length, st.noCall.n, "🔴 плитка й фільтр «немає дзвінка» розійшлись");
  assert.equal(rows.filter(V.TILE_MATCH.lost).length, st.lost, "🔴 плитка й фільтр «втрачені» розійшлись");
  assert.equal(rows.filter(V.TILE_MATCH.success).length, st.success.n, "🔴 плитка й фільтр «успіх» розійшлись");
  const sp = V.priceSuccessSplit(rows);
  assert.deepEqual([sp.named, sp.notNamed, sp.enough], [{ n: 1, of: 1 }, { n: 0, of: 1 }, false], "🔴 відсоток «ціна → успіх» на одиничних угодах");
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /const presetOk = \(r: \(typeof rows\)\[number\]\) => preset === "all" \|\| TILE_MATCH\[preset\]\(r\);/, "🔴 фільтр після кліку — не те правило, що плитка");
  assert.match(sec, /const ts = tileStats\(rows\);/, "🔴 плитки рахуються не спільними правилами");
  assert.match(sec, /<b>\{scoped\.filter\(TILE_MATCH\[k\]\)\.length\}<\/b>/, "🔴 лічильник у пігулці — не те правило");
  assert.match(sec, /goodBad\(ts\.price\.pct == null \? null : ts\.price\.pct >= target\)/, "🔴 колір плитки ціни не від цілі з налаштувань");
  assert.match(sec, /const target = d\.priceTargetPct;/, "🔴 ціль не з відповіді сервера");
});

/**
 * #910 — МЕНЕДЖЕРИ ЗА ЧЕК-ЛИСТОМ У % (ТЗ 08.10.2026): пунктів тепер 2–4 на розмову, тож бал — у відсотках, а не «з 3»;
 * у рядку менеджера — частка опрацьованих заперечень («не було» поза знаменником) і успіх «X з N». Замінює `#898b`.
 * 🧨 Червоніє, якщо бал знову масштабувати «з 3», «не було» потрапить у знаменник заперечень, або нерозібране — у рядок.
 */
test("#910 МЕНЕДЖЕРИ: бал у %, заперечення «опрац. / було», успіх X з N; лише розібрані зі звіту", async () => {
  const V = await loadView();
  assert.equal(V.avgScorePct([{ yes: 1, total: 2 }, { yes: 3, total: 3 }, null, { yes: 0, total: 0 }]), 75, "🔴 бал не у % ((0,5 + 1) / 2)");
  const lines = V.managerChecklist([
    { inReport: true, managerId: 1, managerName: "А", checklist: { request: "y", price: "n", promise: "o", objection: "n" }, checkScore: { yes: 1, total: 3 }, dealOutcome: { state: "lost" } },
    { inReport: true, managerId: 1, managerName: "А", checklist: { request: "y", price: "y", promise: "o", objection: "o" }, checkScore: { yes: 2, total: 2 }, dealOutcome: { state: "success" } },
    { inReport: true, managerId: 1, managerName: "А", checklist: null, checkScore: null, dealOutcome: null },
    { inReport: false, managerId: 2, managerName: "Б", checklist: { request: "n", price: "n", promise: "n", objection: "n" }, checkScore: { yes: 0, total: 4 }, dealOutcome: null },
  ]) as unknown as { name: string; calls: number; score: number | null; objection: number | null; objections: number; objectionsHandled: number; success: number }[];
  assert.deepEqual(lines.map((l) => [l.name, l.calls, l.score, l.objection, l.objections, l.objectionsHandled, l.success]),
    [["А", 2, 67, 0, 1, 0, 1]], "🔴 рядок менеджера: нерозібране, «не було» чи виключене пролізли в частки");
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.ok(!/avgScore3|\/ 3`/.test(sec), "🔴 бал знову «з 3»");
});

/**
 * #911 — ЗГОРТАННЯ І СКЕЛЕТ (Роман 08.10.2026: «кнопка згорнути дуже грусна… плавна анімація», «preload згідно макету»).
 * Блок менеджерів згортається іконкою-шевроном з `aria-expanded`/`aria-label` і плавною висотою (клас, а не умовний
 * рендер — інакше анімувати нічого), при «зменшенні руху» — без анімації. Поки дані вантажаться, видно скелет тієї самої
 * розкладки, а не напис «Завантаження…». Заперечень ще немає — «—» і «розбираються від 09.10», а не «0 / 0».
 * 🧨 Червоніє, якщо повернути текстову кнопку чи умовний рендер, прибрати вимкнення анімації або скелет.
 */
test("#911 ЗГОРТАННЯ І СКЕЛЕТ: шеврон з aria, плавна висота класом, без руху при «зменшенні руху», скелет замість тексту", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /className=\{`ftd-collapse\$\{mgrCollapsed \? " is-collapsed" : ""\}`\} aria-expanded=\{!mgrCollapsed\} aria-controls="ftd-mgr-body"/, "🔴 немає кнопки-шеврона з aria-expanded");
  assert.ok(!/Згорнути ▴|Розгорнути ▾/.test(sec), "🔴 повернулась текстова кнопка «Згорнути ▴»");
  assert.match(sec, /<div id="ftd-mgr-body" className=\{`ftd-collapsible\$\{mgrCollapsed \? " is-collapsed" : ""\}`\}/, "🔴 блок згортається умовним рендером — анімувати нічого");
  assert.match(sec, /if \(!d\) return <FirstTouchSkeleton header=\{header\} drawer=\{drawer\} \/>;/, "🔴 замість скелета — напис «Завантаження…»");
  assert.match(sec, /: "розбираються для розмов від 09\.10",/, "🔴 «0 з 0 заперечень» замість пояснення");
  const css = readFileSync(FE("pages/dashboard/sections/firstTouch.css"), "utf8");
  assert.match(css, /\.ftd-collapsible\.is-collapsed \{ grid-template-rows: 0fr; opacity: 0; \}/, "🔴 немає плавної висоти");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.ftd-collapse svg, \.ftd-collapsible, \.ftd-fade \{ transition: none; \}\s*\.ftd-sk \{ animation: none; \}/, "🔴 анімація не вимикається для «зменшення руху»");
});

/**
 * #912 — ПОТОЧНИЙ МІСЯЦЬ І ПЛАВНІ ЧИСЛА (Роман 08.10.2026: «плавне оновлення цифр при зміні команди, і по дефолту щоб
 * відкривався цей місяць»). Екран відкривається на місяці сьогоднішньої дати; числа на плитках перетікають від старого
 * значення до нового, перший показ — без анімації, «зменшення руху» — одразу нове значення.
 * 🧨 Червоніє, якщо за замовчуванням знову діапазон «30 днів», плитки показують сирий текст, або анімація ігнорує
 * «зменшення руху».
 */
test("#912 МІСЯЦЬ І ПЛАВНІ ЧИСЛА: за замовчуванням поточний місяць, плитки перетікають, без руху — одразу", async () => {
  const V = await loadView();
  const p = V.aiDefaultPeriod("2026-10-08");
  assert.deepEqual([p.mode, p.anchor], ["month", "2026-10-08"], "🔴 за замовчуванням не поточний місяць");
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  for (const v of ["ts.noCall.n", "ts.price.pct", "ts.objection.pct", "lost.length", "ts.success.n"])
    assert.ok(sec.includes(`<AnimatedNumber value={${v}}`), `🔴 плитка ${v} без плавного числа`);
  const an = readFileSync(FE("pages/dashboard/sections/AnimatedNumber.tsx"), "utf8");
  assert.match(an, /if \(value == null \|\| start == null \|\| start === value \|\| reducedMotion\(\)\) \{ from\.current = value; setShown\(value\); return; \}/, "🔴 «зменшення руху» чи перший показ анімуються");
  assert.match(an, /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)/, "🔴 не питає систему про «зменшення руху»");
});

/**
 * #913 — НОВИЙ ПЕРІОД НЕ СКИДАЄ ЦИФРИ (Роман 08.10.2026: «зроби щоб і при зміні періоду цифри перетікали»). Поки
 * вантажиться новий період, старі дані лишаються (приглушені, «Оновлюю…»), тож плитки перетікають від старого числа
 * до нового; скелет — лише на першому відкритті. Помилка знімає приглушення.
 * 🧨 Червоніє, якщо новий період знову обнуляє дані (тоді перетікати нема з чого) або «Оновлюю…» зникає.
 */
test("#913 ПЕРІОД ПЕРЕТІКАЄ: новий період лишає старі цифри приглушеними, поки не прийдуть нові", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /if \(periodKey\.current !== `\$\{from\}\|\$\{to\}`\) \{ setStale\(true\); periodKey\.current = `\$\{from\}\|\$\{to\}`; \}/, "🔴 новий період обнуляє дані — перетікати нема з чого");
  assert.ok(!/setD\(null\)/.test(sec), "🔴 дані знову скидаються в null");
  assert.match(sec, /\.then\(\(x\) => \{ if \(alive\) \{ setD\(x\); setStale\(false\); \} \}\)/, "🔴 нові дані не знімають приглушення");
  assert.match(sec, /\{stale && <span className="ftd-updating" role="status">Оновлюю…<\/span>\}/, "🔴 не видно, що цифри оновлюються");
  const css = readFileSync(FE("pages/dashboard/sections/firstTouch.css"), "utf8");
  assert.match(css, /\.ftd-over\.is-stale \.ftd-kpis, \.ftd-over\.is-stale \.ftd-card, \.ftd-over\.is-stale \.ftd-strip \{ opacity: \.55;/, "🔴 старі цифри не приглушено — читаються як нові");
});

/**
 * #914 — ОДНА ШАПКА ДЛЯ СКЕЛЕТА Й ЕКРАНА (Роман 08.10.2026: «на preview і фактичній картинці різне місцеположення
 * періодів… це обʼєкт, який може завжди відображатися»). Шапка (заголовок, конвеєр, період, «Команда») будується ОДИН раз
 * і вставляється і в скелет, і в екран; розкладка — колонкою, тож період не стрибає між рядками залежно від довжини
 * рядка конвеєра.
 * 🧨 Червоніє, якщо скелет знову малює власну шапку чи шапка повертається в рядок «заголовок ↔ період».
 */
test("#914 ОДНА ШАПКА: скелет і екран вставляють ту саму шапку, період завжди окремим рядком", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.equal((sec.match(/className="ftd-head"/g) ?? []).length, 1, "🔴 шапка намальована більше ніж раз — скелет і екран розійдуться");
  assert.match(sec, /function FirstTouchSkeleton\(\{ header, drawer \}/, "🔴 скелет не приймає спільну шапку");
  assert.match(sec, /aria-label="Завантаження «Першого дотику»">\n\s*\{header\}/, "🔴 скелет без спільної шапки");
  assert.match(sec, /if \(err\) return <div className="ftd">\{header\}/, "🔴 екран помилки без спільної шапки");
  assert.match(sec, /aria-busy=\{stale\}>\n\s*\{header\}/, "🔴 екран без спільної шапки");
  const css = readFileSync(FE("pages/dashboard/sections/firstTouch.css"), "utf8");
  assert.match(css, /\.ftd-head \{ display: flex; flex-direction: column; align-items: stretch; gap: 14px; \}/, "🔴 шапка знову в рядок — період стрибає");
});

/**
 * #921 — СОРТУВАННЯ БЛОКУ МЕНЕДЖЕРІВ (прохання Романа 09.10.2026): клік по назві колонки сортує, повторний — навпаки;
 * перший клік — найслабші згори; «—» завжди внизу в обидва боки; успіх — за часткою, при рівній — за кількістю;
 * екран малює ВІДСОРТОВАНІ рядки, а вибір памʼятає браузер.
 * 🧨 Червоніє, якщо порожнеча вилізе нагору, повторний клік не перевертає порядок, або екран малює несортований список.
 */
test("#921 СОРТУВАННЯ МЕНЕДЖЕРІВ: клік по колонці, ще клік — навпаки; «—» завжди внизу; успіх за часткою; екран малює відсортоване", async () => {
  const V = await loadView();
  const L = (name: string, price: number | null, objections: number, handled: number, success: number, calls: number) => ({
    managerId: name.charCodeAt(0), name, calls, score: price, request: 100, price, promise: null, objection: objections ? Math.round(handled / objections * 100) : null,
    objections, objectionsHandled: handled, success });
  const ls = [L("Б", 40, 2, 1, 1, 4), L("А", null, 0, 0, 0, 2), L("В", 70, 1, 1, 2, 8), L("Г", 10, 0, 0, 1, 4)];
  const names = (s: { key: string; dir: string }) => V.sortManagerLines(ls, s).map((l) => l.name).join("");
  assert.equal(names({ key: "price", dir: "asc" }), "ГБВА", "найслабші згори, «—» внизу");
  assert.equal(names({ key: "price", dir: "desc" }), "ВБГА", "🔴 «—» вилізло нагору при зворотному порядку");
  assert.equal(names({ key: "objection", dir: "asc" }), "БВАГ", "заперечення — за часткою опрацьованих, «не було» внизу");
  assert.equal(names({ key: "success", dir: "desc" }), "ВБГА", "🔴 успіх: 2/8 = 1/4 = 1/4 — при рівній частці вище той, у кого більше успіхів");
  assert.equal(names({ key: "name", dir: "asc" }), "АБВГ");
  assert.equal(names({ key: "name", dir: "desc" }), "ГВБА");
  assert.deepEqual(V.nextMgrSort({ key: "price", dir: "asc" }, "price"), { key: "price", dir: "desc" }, "🔴 повторний клік не перевертає порядок");
  assert.deepEqual(V.nextMgrSort({ key: "price", dir: "desc" }, "promise"), { key: "promise", dir: "asc" }, "нова колонка — найслабші згори");
  assert.deepEqual(V.parseMgrSort("price:desc"), { key: "price", dir: "desc" });
  assert.deepEqual(V.parseMgrSort("сміття"), V.MGR_SORT_DEFAULT, "зіпсований запис у браузері — порядок за замовчуванням");
  assert.deepEqual(V.MGR_SORT_DEFAULT, { key: "score", dir: "asc" }, "за замовчуванням — як було: бал, найслабші згори");
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /const shownLines = sortManagerLines\(lines, mgrSort\);/);
  assert.match(sec, /\{shownLines\.map\(\(l\) => \(/, "🔴 екран малює несортований список");
  assert.match(sec, /localStorage\.setItem\("ftd\.mgrSort"/, "🔴 вибір сортування не памʼятається");
});

/**
 * #923 — СТРОК ПРОХАННЯ КЛІЄНТА ПЕРЕДЗВОНИТИ (рішення Романа 09.10.2026): клієнт не назвав часу — до кінця НАСТУПНОГО
 * РОБОЧОГО дня за Києвом (пт → пн), а не «20 хв за замовчуванням»; назвав — названий час. Прохання стає обіцянкою
 * менеджера-дзвінком (`withClientCallback`), але НЕ дублюється, якщо менеджер і сам пообіцяв передзвонити; без прохання
 * і в старих рядках — результат той самий.
 * 🧨 Червоніє, якщо строк рахувати не до кінця наступного робочого дня, ігнорувати названий клієнтом час, губити
 * прохання або рахувати один передзвін двічі.
 */
test("#923 ПРОХАННЯ ПЕРЕДЗВОНИТИ: строк — кінець наступного робочого дня (пт → пн) або названий час; стає обіцянкою менеджера, не дублюється", async () => {
  const P = await import("./callAiPromise.js");
  const S = await import("./callAiScreen.js");
  const fri = new Date("2026-10-09T05:57:10Z"); // пт 09.10, 08:57 за Києвом
  const d = (o: Record<string, unknown>) => P.promiseDeadline({ deadline_kind: "none", deadline_minutes: 0, deadline_date: "", conditional: false, ...o } as never, fri);
  assert.deepEqual([d({ client_asked: true }).deadline.toISOString(), d({ client_asked: true }).basis], ["2026-10-12T20:59:59.000Z", "client_asked_next_workday"], "🔴 строк прохання — не кінець понеділка 12.10");
  assert.equal(d({}).basis, "default_minutes", "дзеркало: обіцянка менеджера без часу — і далі 20 хв");
  assert.equal(d({ client_asked: true, deadline_kind: "minutes", deadline_minutes: 120 }).deadline.toISOString(), "2026-10-09T07:57:10.000Z", "🔴 названий клієнтом час проігноровано");
  const tue = P.promiseDeadline({ deadline_kind: "none", deadline_minutes: 0, deadline_date: "", conditional: false, client_asked: true } as never, new Date("2026-10-06T10:00:00Z"));
  assert.equal(tue.deadline.toISOString(), "2026-10-07T20:59:59.000Z", "🔴 вівторок → не кінець середи");
  const base = { summary: "", manager_channel: "1", client_request: "", next_step: "", price: { discussed: false, quote: "" }, objections: [], promises: [] as never[],
    conversation_type: "call_later", type_confidence: 0.9, type_reason: "", price_value: "" } as const;
  const cb = { asked: true, quote: "Потом позвоните", deadline_text: "", deadline_kind: "none", deadline_minutes: 0, deadline_date: "" } as const;
  const got = S.withClientCallback({ ...base, callback_request: cb } as never);
  assert.equal(got.promises.length, 1, "🔴 прохання клієнта не стало обіцянкою");
  assert.equal(got.promises[0].who, "manager");
  assert.equal(got.promises[0].channel, "call");
  assert.equal((got.promises[0] as { client_asked?: boolean }).client_asked, true, "🔴 обіцянку з прохання не позначено — строк стане 20 хв");
  assert.equal(got.promises[0].quote, "Потом позвоните", "🔴 цитата клієнта загубилась");
  const own = { who: "manager", what: "передзвоню", deadline_text: "", quote: "наберу", channel: "call", deadline_kind: "none", deadline_minutes: 0, deadline_date: "", conditional: false };
  assert.equal(S.withClientCallback({ ...base, promises: [own], callback_request: cb } as never).promises.length, 1, "🔴 один передзвін пораховано двічі");
  const msg = { ...own, channel: "message" };
  assert.equal(S.withClientCallback({ ...base, promises: [msg], callback_request: cb } as never).promises.length, 2, "дзеркало: обіцянка написати не замінює передзвону");
  assert.equal(S.withClientCallback({ ...base, callback_request: { ...cb, asked: false } } as never).promises.length, 0, "🔴 обіцянку вигадано без прохання");
  const v3 = { ...base, conversation_type: "cargo_request" };
  assert.equal(S.withClientCallback(v3 as never), v3, "🔴 старий рядок (без поля) змінено");
});

/**
 * #924 — «НЕЗРУЧНО ГОВОРИТИ» У ЧЕК-ЛИСТІ Й ЦИФРАХ (рішення Романа 09.10.2026): тип `call_later` — у звіті; запит і ціна
 * «не рахуються»; розмова поза знаменником «Ціна озвучена» і не стоїть у черзі «Без ціни»; обіцянка (з прохання) — як
 * звичайна. Фронт: підпис типу, строку й пояснення в чек-листі.
 * 🧨 Червоніє, якщо `call_later` піде у «Виключені», якщо ціна чи запит стануть «ні», або розмова лишиться в знаменнику ціни.
 */
test("#924 НЕЗРУЧНО ГОВОРИТИ: у звіті; запит і ціна «не рахуються»; поза знаменником ціни й чергою «Без ціни»; підписи на фронті", async () => {
  const T = await import("./callAiType.js");
  const R = await import("./firstTouchTeamReport.js");
  assert.equal(T.typeVerdict("call_later" as never, 0.95, null).inReport, true, "🔴 «незручно говорити» пішло у Виключені");
  assert.equal(T.typeVerdict("carrier" as never, 0.95, null).inReport, false, "дзеркало: перевізник і далі у Виключених");
  const row = { calledAt: "2026-10-09T05:56:54Z", managerId: 1, managerName: "М", teamName: null, inReport: true, state: "done", priceDiscussed: false,
    promiseState: "broken" as const, typeCheck: false, priceNote: null, missedNote: null, conversationType: "call_later", hasRequest: false, reviewNote: null, objection: null } as unknown as Parameters<typeof R.checklist>[0];
  assert.deepEqual(R.checklist(row), { request: "o", price: "o", promise: "n", objection: "o" }, "🔴 запит чи ціна «ні» в розмові, де говорити було незручно");
  assert.equal(R.isPriceable(row), false, "🔴 «незручно говорити» тягне вниз «Ціна озвучена»");
  assert.equal(R.reviewReason(row), "noCall", "🔴 непередзвонене прохання не потрапило в чергу як «Немає дзвінка»");
  assert.equal(R.reviewReason({ ...row, promiseState: "pending" }), null, "🔴 розмова в черзі «Без ціни», хоч ціну назвати не було коли");
  const cargo: typeof row = { ...row, conversationType: "cargo_request" };
  assert.deepEqual([R.checklist(cargo)?.request, R.checklist(cargo)?.price, R.isPriceable(cargo)], ["n", "n", true], "дзеркало: звичайний запит без ціни — і далі «ні»");
  const V = await loadView() as unknown as { TYPE_LABEL: Record<string, string>; deadlineBasisLabel: (b: string) => string };
  assert.match(V.TYPE_LABEL.call_later ?? "", /Незручно говорити/, "🔴 тип без підпису на екрані");
  assert.match(V.deadlineBasisLabel("client_asked_next_workday"), /клієнт просив передзвонити — до кінця наступного робочого дня/);
  const ck = readFileSync(FE("pages/dashboard/sections/FirstTouchChecklist.tsx"), "utf8");
  assert.match(ck, /later \? "клієнтові було незручно говорити — просив передзвонити/, "🔴 у чек-листі немає пояснення, чому запит не рахується");
});

/**
 * #925 — ДЕ ЦЕ ПРАЦЮЄ І ЧОГО НЕ ЧІПАЄ (09.10.2026): прохання клієнта додається до обіцянок і в СПИСКУ, і в КАРТЦІ (інакше
 * плитка й картка розійдуться); джоба ставить v4 лише розмовам, яких v2/v3 ще не розібрали (`transcriptsWithoutLegacy`),
 * — а не всім підряд, бо інакше поява v4 переаналізувала б усе й зсунула старі цифри; заперечення беруть і v3, і v4.
 * 🧨 Червоніє, якщо повернути `enqueueAnalyses(…, null, …)` для поточної рубрики, забути прохання в списку чи картці або
 * звузити кандидатів заперечень до самої v4.
 */
test("#925 ПРОХАННЯ ПЕРЕДЗВОНИТИ — У СПИСКУ Й КАРТЦІ; v4 АВТОМАТИЧНО ЛИШЕ НОВИМ РОЗМОВАМ; заперечення — з v3 і v4", () => {
  const scr = SRC("core/callAiScreen.ts");
  assert.match(scr, /const raw = \(await db\.query<RawRow>\(sql, params\)\)\.rows;\n  for \(const x of raw\) if \(x\.result\) x\.result = withClientCallback\(x\.result\);\n  const rows = raw\.map\(foldRow\);/, "🔴 список не бачить прохання клієнта");
  assert.match(scr, /if \(!raw\) return null;\n  if \(raw\.result\) raw\.result = withClientCallback\(raw\.result\);\n  const row = foldRow\(raw\);/, "🔴 картка не бачить прохання клієнта");
  const tick = SRC("core/callAiTick.ts");
  // 4631 (09.10.2026): виняток — не лише перевізники, а й розмови про борг (`notAd`): у них своя рубрика.
  assert.match(tick, /const fresh = await transcriptsWithoutLegacy\(env\.db\);\n  if \(fresh\.length\) await enqueueAnalyses\(env\.db, \{ \.\.\.ap, now: env\.now\(\) \}, fresh, (?:carrierOnly|notAd)\);/, "🔴 джоба ставить v4 не лише новим розмовам");
  assert.doesNotMatch(tick, /enqueueAnalyses\(env\.db, \{ \.\.\.ap, now: env\.now\(\) \}, null/, "🔴 v4 у черзі для ВСІХ розшифровок — старі цифри зсунуться");
  assert.match(tick, /a\.rubric_version = ANY\(\$1::text\[\]\) AND a\.status = 'done'\)`,\n    \[\[\.\.\.FIRST_TOUCH_LEGACY_TYPED\]\]\);/, "🔴 «ще не розібрані» визначено не через v2/v3");
  assert.match(tick, /\[\[RUBRIC_CURRENT, \.\.\.FIRST_TOUCH_LEGACY_TYPED\], from\]/, "🔴 заперечення не беруть розмови, розібрані v3");
});

