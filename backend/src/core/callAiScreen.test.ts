import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    priceNote: null, missedNote: null, offlineNote: null, clientPhone: null };
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
  assert.match(drw, /tab === "transcript" && tabs\.includes\("transcript"\)/, "🔴 розшифровка показується без перевірки права");
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
  assert.match(drw, /\{c\.canListen && c\.durationSec != null && <RecordingPlayer/, "🔴 запис показується без дозволу сервера");
  assert.match(drw, /const can = c\.noteRights\[kind\];/, "🔴 право писати коментар — не з сервера");
  const sec = readFileSync(FE("pages/dashboard/sections/AiCallsSection.tsx"), "utf8");
  assert.match(sec, /\{d\.canSeeExcluded && <button type="button" role="tab"/, "🔴 менеджер бачить вкладку «Виключені»");
});

/**
 * #869 — «ПЕРЕДЗВОНИВ ПОЗА ТЕЛЕФОНІЄЮ» · ЯДРО Й ЕКРАН (Юля й Андрій 01.10.2026). Звірка 30 «не передзвонив» з Ringostat:
 * у 25 нашого дзвінка в телефонії немає зовсім, а передзвони були з мобільного чи в месенджер. Тому: ручна позначка
 * переводить «немає дзвінка», «запізнився» й «чекає» у виконане й рахується в «виконано», а не в «немає дзвінка» чи
 * банер; ставлять її менеджер (свої), тімлід, адмін; стан у таблиці — без червоного й з чесним «за даними телефонії».
 * 🎛 05.10.2026 (замінює #865): колір БЛОКУ тепер перемикає адмін у «Налаштуваннях» — червоний лише за `bannerTone
 * === "alert"`, заголовок і підпис «перевіряється» в обох кольорах однакові (рішення власника: «перемикач тільки кольору»).
 * 🧨 Червоніє, якщо позначка не гасить банер, не рахується виконаною, перебиває «Передзвонив» з телефонії, відкрита
 * CEO, якщо стан у таблиці знову червоний або блок червоніє без налаштування.
 */
test("#869 ПОЗА ТЕЛЕФОНІЄЮ І КОЛІР БЛОКУ: позначка = виконано, гасить банер; блок червоний лише з «Налаштувань» адміна, заголовок той самий; у картці обидва терміни", async () => {
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
  for (const k of ["admin", "team_lead", "manager"]) assert.equal(canWriteNote(k, "offline"), true, `дзеркало: ${k} позначає «поза телефонією»`);
  for (const k of ["ceo", "opdir", "kvp", "financier", "hr"]) assert.equal(canWriteNote(k, "offline"), false, `🔴 ${k} позначає «поза телефонією»`);

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
  assert.deepEqual(CURRENT_BEHAVIOUR, { repeatWindowDays: null, callbackGraceMin: 0, callbackMinDeadlineMin: 0, bannerTone: "neutral" }, "🔴 старт ≠ поточна поведінка");
  const ok = { repeatWindowDays: 30, callbackGraceMin: 10, callbackMinDeadlineMin: 20, bannerTone: "alert" };
  assert.deepEqual(parseTunables(ok), { ok: true, value: ok });
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
