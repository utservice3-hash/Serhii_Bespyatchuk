import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./adCallFacts.js";
import { aiCallState, AI_CALL_STATES, TRANSCRIPT_ROLES, transcriptAllowed } from "./callAiScreen.js";
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
    VALUES ($1,'google','gemini-3.8-flash','first-touch-v1','done',$2::jsonb)`, [tid, JSON.stringify(RESULT)]);
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
test("#832 ЕКРАН AI · ЖИВА СХЕМА: картка — текст лише адміну й КВП, чужий дзвінок 404, наступний вихідний", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { aiCallCard, transcriptAllowed } = await import("./callAiScreen.js");
  const kvp = await aiCallCard(c.db, "x1", transcriptAllowed({ roleKey: "kvp" }), {});
  assert.ok(kvp && kvp.turns && kvp.turns.length === 1 && !kvp.transcriptHidden, "дзеркало: КВП мусить бачити текст");
  const admin = await aiCallCard(c.db, "x1", transcriptAllowed({ roleKey: "admin" }), {});
  assert.ok(admin?.turns, "дзеркало: адмін мусить бачити текст");
  const lead = await aiCallCard(c.db, "x1", transcriptAllowed({ roleKey: "team_lead" }), { teamId: 901 });
  assert.ok(lead, "🔴 тімлід не відкрив картку своєї команди");
  assert.equal(lead.turns, null, "🔴 тімлід отримав повний текст розмови");
  assert.equal(lead.transcriptHidden, true);
  assert.equal(lead.result?.promises.length, 2, "🔴 тімлід не бачить витягу з цитатами");
  for (const role of ["ceo", "opdir"]) assert.equal((await aiCallCard(c.db, "x1", transcriptAllowed({ role: "admin", roleKey: role }), {}))?.turns, null, `🔴 ${role} отримав повний текст`);
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
test("#833 СТАНИ: розпізнавання × аналіз → дев’ять різних станів, фронт підписує кожен", async () => {
  const stt = [null, "not_enabled", "queued", "working", "capped", "recording_unavailable", "failed", "done"];
  const llm = [null, "queued", "working", "not_enabled", "capped", "failed", "done"];
  const seen = new Set<string>();
  for (const a of stt) for (const b of llm) seen.add(aiCallState(a, b));
  assert.deepEqual([...seen].sort(), [...AI_CALL_STATES].sort(), "🔴 не всі стани досяжні або зʼявився зайвий");
  assert.equal(aiCallState(null, null), "not_queued");
  assert.equal(aiCallState("capped", null), "capped");
  assert.equal(aiCallState("done", "capped"), "capped");
  assert.equal(aiCallState("done", "failed"), "llm_failed");
  assert.equal(aiCallState("failed", null), "stt_failed");
  assert.equal(aiCallState("done", null), "llm_pending");
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
test("#831 ДОСТУП: матриця = сид вкладки, межа роута — ai-calls, текст — вужче за вкладку", async () => {
  const schema = SRC("db/schema.sql");
  const m = /UPDATE roles SET screen_access = screen_access \|\| '\{"ai-calls":true\}'::jsonb\s+WHERE key IN \(([^)]+)\)/.exec(schema);
  assert.ok(m, "🔴 сиду вкладки ai-calls у схемі немає — вкладку не побачить ніхто, навіть адмін");
  const seeded = m[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  assert.deepEqual(seeded, ["admin", "ceo", "kvp", "opdir", "team_lead"]);
  const rows = ACCESS_MATRIX.filter((r) => r.path.startsWith("/api/dashboard/ai-calls"));
  assert.equal(rows.length, 3, "🔴 не всі роути екрана в матриці");
  for (const r of rows) {
    assert.deepEqual([...r.allow].sort(), seeded, `🔴 ${r.path}: матриця ≠ сид вкладки`);
    for (const d of ["manager", "financier", "hr"]) assert.ok(r.deny.includes(d as never), `🔴 ${r.path}: ${d} не в deny`);
  }
  const { tabsForPath } = await import("../auth/routeTab.js");
  for (const p of ["/api/dashboard/ai-calls", "/api/dashboard/ai-calls/meta", "/api/dashboard/ai-calls/123.45"])
    assert.deepEqual(tabsForPath(p), ["ai-calls"], `🔴 ${p} без межі вкладки`);
  for (const role of TRANSCRIPT_ROLES) assert.ok(seeded.includes(role), `🔴 ${role} бачить текст, але не бачить вкладки`);
  assert.deepEqual([...TRANSCRIPT_ROLES].sort(), ["admin", "kvp"]);
});

interface ViewMod {
  STATE_UI: Record<string, { label: string; tone: string; hint: string }>;
  matchesFilter: (r: { state: string; priceDiscussed: boolean | null; objections: number; promises: number; promisesWithDeadline: number }, f: string) => boolean;
  speakerOf: (channel: number, managerChannel: number | null) => string;
  afterLabel: (fromIso: string, toIso: string | null) => string;
  jobErrorIsCurrent: (job: { lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null } | null) => boolean;
  parseCallParam: (search: string) => string | null;
  withCallParam: (href: string, uniqueid: string | null) => string;
  drawerTabs: (transcriptHidden: boolean, turns: number | null) => string[];
  promisesLabel: (promises: number, withDeadline: number) => string;
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
test("#835 ПОВНИЙ ТЕКСТ ЗА КЛЮЧЕМ РОЛІ: CEO й опдир із сумісною роллю admin тексту не бачать", () => {
  for (const key of ["ceo", "opdir", "team_lead", "financier", "hr", "manager"])
    assert.equal(transcriptAllowed({ role: "admin", roleKey: key }), false, `🔴 ${key} із сумісною роллю admin бачить повний текст`);
  assert.equal(transcriptAllowed({ role: "admin", roleKey: "kvp" }), true, "дзеркало: КВП мусить бачити текст");
  assert.equal(transcriptAllowed({ role: "admin", roleKey: "admin" }), true, "дзеркало: адмін мусить бачити текст");
  assert.equal(transcriptAllowed({ role: "admin" }), false, "🔴 токен без roleKey отримав текст за сумісною роллю");
  const route = SRC("routes/dashboard.ts");
  const at = route.indexOf('dashboardRouter.get("/ai-calls/:uniqueid"');
  assert.ok(at > 0, "🔴 роут картки не знайдено");
  const body = route.slice(at, route.indexOf("});", at));
  assert.match(body, /aiCallCard\(pool, [^,]+, transcriptAllowed\(auth\),/, "🔴 роут картки вирішує право на текст не через transcriptAllowed(auth)");
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
    pipelineGroup: "full" as const, rejectReason: null, promiseState: null, managerPromises: 0, silentBeforeClose: null };
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
  assert.match(sec, /<AiCallDrawer uniqueid=\{open\} onClose=\{closeCard\} \/>/, "🔴 секція не малює панель картки");
  assert.ok(!/colSpan=\{7\}/.test(sec), "🔴 повернулось розгортання рядка замість панелі");
  assert.match(sec, /useState<string \| null>\(\(\) => parseCallParam\(window\.location\.search\)\)/, "🔴 ?call= не відкриває картку при завантаженні");
  const drw = readFileSync(FE("pages/dashboard/sections/AiCallDrawer.tsx"), "utf8");
  assert.match(drw, /const tabs = c \? drawerTabs\(c\.transcriptHidden, c\.turns\?\.length \?\? null\) : \[\];/, "🔴 вкладки картки не з правила drawerTabs");
  assert.match(drw, /tab === "transcript" && tabs\.includes\("transcript"\)/, "🔴 розшифровка показується без перевірки права");
});

/**
 * #792 — ОБІЦЯНКИ, ВОРОНКА, НЕЦІЛЬОВІ, ТИША — ЖИВА СХЕМА (рішення Романа 29.09.2026). Прапорець «не передзвонив»
 * — на тому, хто ОБІЦЯВ (менеджер розмови), а не на відповідальному угоди (П7); дзвінок колеги до терміну —
 * «передзвонив» (П6-Б); Кваліфікація — своя група, «Дубль» — причина відмови з CRM (П8-Б); «тиша перед
 * закриттям» — межа 24 год ПО ОБИДВА боки: 29 год — так, 23 год — ні (П3).
 * 🧨 Червоніє, якщо прапорець піде на відповідального, дзвінок колеги не зарахується чи зсунеться поріг тиші.
 */
test("#792 ЕКРАН AI · ЖИВА СХЕМА: не передзвонив — на тому, хто обіцяв; колега рятує; Кваліфікація й «Дубль»; тиша 24 год", async (t) => {
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
      VALUES ($1,'elevenlabs','scribe_v2','done','[]'::jsonb) RETURNING id`, [u])).rows[0].id;
    const res = { ...RESULT, objections: [], promises: [{ who: "manager", what: "передзвонити", deadline_text: "за пів години", quote: "q", quote_found: true,
      channel: "call", deadline_kind: "minutes", deadline_minutes: minutes, deadline_date: "", conditional: false }] };
    await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result)
      VALUES ($1,'google','gemini-3.8-flash','first-touch-v1','done',$2::jsonb)`, [tid, JSON.stringify(res)]);
  };
  await deal(8810, "0508800010", 8921932, 1, null, null);
  await call("y1", "2026-09-24 10:00:00+03", 60, 9011, "380508800010");                 // обіцяла Олена, угода Петра
  await analysed("y1", 30);
  await deal(8811, "0508800011", 8921928, 143, "2026-09-25 16:00:00+03", "Дубль");
  await call("y2", "2026-09-24 10:00:00+03", 60, 9011, "380508800011");
  await call("y2b", "2026-09-24 10:10:00+03", 30, 9021, "380508800011");                // передзвонив колега
  await analysed("y2", 30);
  await deal(8812, "0508800012", 8921932, 143, "2026-09-25 09:00:00+03", null);          // 23 год після розмови
  await call("y3", "2026-09-24 10:00:00+03", 60, 9011, "380508800012");

  const rows = (await aiCallsList(c.db, FAKE_AD, "2026-09-24", "2026-09-24", NOW, {})).rows;
  const by = new Map(rows.map((r) => [r.uniqueid, r]));
  assert.deepEqual([by.get("y1")?.promiseState, by.get("y1")?.managerId], ["broken", 9011], "🔴 «не передзвонив» — не на тій, хто обіцяла");
  assert.equal(by.get("y2")?.promiseState, "kept_talk", "🔴 дзвінок колеги до терміну не зараховано");
  assert.deepEqual([by.get("y2")?.pipelineGroup, by.get("y2")?.rejectReason], ["qualification", "Дубль"], "🔴 Кваліфікація чи причина відмови загубились");
  assert.equal(by.get("y1")?.pipelineGroup, "full");
  assert.equal(by.get("y2")?.silentBeforeClose, true, "🔴 29 год без нашого дзвінка — не «тиша перед закриттям»");
  assert.equal(by.get("y3")?.silentBeforeClose, false, "🔴 23 год — уже «тиша» (поріг 24 год зсунувся)");
  assert.equal(by.get("y1")?.silentBeforeClose, null, "відкрита угода — не застосовно, а не «тиші немає»");

  // #795 на живій схемі: синк Ringostat застряг до межі «термін + 2 год» → «чекає», а не «не передзвонив».
  await c.raw.query(`INSERT INTO job_runs(name, last_success_at) VALUES ('syncRingostatCalls', '2026-09-24 11:30:00+03')
    ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`);
  const lag = new Map((await aiCallsList(c.db, FAKE_AD, "2026-09-24", "2026-09-24", NOW, {})).rows.map((r) => [r.uniqueid, r]));
  assert.equal(lag.get("y1")?.promiseState, "pending", "🔴 дзвінки ще не синхронізовано за межу, а вже «не передзвонив»");
  await c.raw.query("DELETE FROM job_runs WHERE name = 'syncRingostatCalls'");
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
 * #796 — ПОРЯДОК КОЛОНОК (прохання Романа 29.09.2026): «Обіцянка» — третя, одразу за менеджером; «Стан» — у
 * кінці й порожній для проаналізованих («Проаналізовано» — норма, а не новина). Інші стани лишаються видимими:
 * «У черзі», «Запису немає» — це причина, чому розбору немає.
 * 🧨 Червоніє, якщо повернути «Стан» третьою колонкою чи знову показувати «Проаналізовано» в рядку.
 */
test("#796 ТАБЛИЦЯ: «Обіцянка» третя, «Стан» у кінці й порожній для проаналізованих", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  const heads = [...sec.matchAll(/<th style=\{cell\}>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ["Розмова", "Менеджер", "Обіцянка", "Про що", "Ціна", "Заперечення", "Стан"], `🔴 порядок колонок: ${heads.join(" · ")}`);
  assert.match(sec, /<td style=\{cell\}>\{r\.state === "done" \? null : <StateChip state=\{r\.state\} \/>\}<\/td>/, "🔴 «Проаналізовано» знову видно в рядку або стан інших рядків сховано");
});
