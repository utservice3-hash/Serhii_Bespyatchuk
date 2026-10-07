import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSurveyText, ENPS_TEXT } from "./surveyParser.js";
import { aggregateQuestion, enpsOf, questionMetric, fmtMetric, trend, closeSummary, csvFor, type Question, type ResponseRow } from "./surveyResults.js";
import { reminderMoments, nextLaunch } from "./surveyScheduler.js";
import { validateSurvey, hasValue, cleanImage } from "./surveyRules.js";

/**
 * 📋 ОПИТУВАННЯ КОМАНДИ (30.09.2026) — пакет Сергія `roman-package-opytuvannya`.
 *
 * #1130–#1132 — ПОРТ його vitest-файлів (surveyParser / surveyResults / surveyScheduler) на `node:test`, фікстури —
 * як є (`surveys/fixtures`, зняті програмно з затвердженого макета; імена в них — демо-люди макета).
 * #1133 — замість його `tick.integration.ts` (ручний прогін проти чиєїсь бази): СПРАВЖНІЙ роут на тимчасовій базі
 * через HTTP із токенами різних ролей — від створення до автозакриття, серії й нагадувань, з анонімністю.
 */

const FIX = (f: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "src", "surveys", "fixtures", f), "utf8"));

/** #1130 — розумна вставка поводиться ЯК ЕТАЛОН на 8 текстах + регрес-страховки (кирилиця й `\b`). */
test("#1130 ПАРСЕР ОПИТУВАНЬ: 8 текстів як у макеті; кирилиця без межі слова; eNPS за замовчуванням", () => {
  const ref = FIX("parser-ref.json") as Record<string, { in: string; out: unknown }>;
  assert.ok(Object.keys(ref).length >= 8, "🔴 фікстура порожня — перевірці нічого порівнювати");
  for (const [name, c] of Object.entries(ref)) assert.deepEqual(parseSurveyText(c.in), c.out, `🔴 «${name}» розібрано не так, як у макеті`);
  assert.equal(parseSurveyText("Розставте за пріоритетом\n- А\n- Б").questions[0].type, "rank");
  assert.equal(parseSurveyText("Q1. Rate 1-5").questions[0].type, "scale");
  assert.deepEqual(parseSurveyText("**Питання 1:** Так чи ні? (так/ні)").questions[0].options, ["Так", "Ні"]);
  assert.equal(parseSurveyText("1. " + ENPS_TEXT + " Оцініть від 0 до 10").questions[0].type, "enps");
});

type Ref = Record<string, {
  survey: { title: string; issue: number; status: string; closedAt: string | null; anon: boolean; assigned: string[]; responded: string[]; questions: Question[] };
  responses: ResponseRow[];
  blocks: Array<{ typ: string; bars: Array<{ lb: string; vl: string }>; avg: string | null; seg: string[]; hist: string[]; texts: number }>;
  metrics: Array<{ v: number; lbl: string; out: string } | null>;
  summary: string; csv: string;
}>;

/** #1131 — агрегації = екран результатів макета: бари, середні, eNPS-сегменти, матриця, ранжування, підсумок, CSV. */
test("#1131 РЕЗУЛЬТАТИ ЯК У МАКЕТІ: 4 опитування — бари, середні, eNPS, матриця, ранжування, підсумок, CSV посимвольно", () => {
  const ref = FIX("results-ref.json") as Ref;
  const USERS: Record<string, string> = { u1: "Сергій Беспятчук", u2: "Олена Кравець", u3: "Андрій Мельник", u4: "Марина Коваль", u5: "Ігор Ткаченко", u6: "Дарина Шевчук", u7: "Юлія Сидоренко", u8: "Олексій Бондар", u9: "Наталя Романюк", u10: "Віталій Гнатюк", u11: "Максим Лисенко" };
  const ROLE: Record<string, string> = { admin: "адмін", lead: "тім-лід", manager: "менеджер" };
  // Еталон знято в UTC (13:58Z → «13:58»: браузер макета бігав без поясу), а формат часу в `csvFor` — параметр.
  // Фіксуємо той самий пояс явно: гейт стереже склеювання CSV, а не пояс машини (Варшава й Київ давали різне).
  const TZ = "UTC";
  const fmtDue = (iso: string) => { const d = new Date(iso); return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: TZ }) + " " + d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: TZ }); };
  assert.equal(enpsOf([10, 9, 7, 3, 5]).score, 0);
  assert.equal(enpsOf([10, 10, 8, 2]).score, 25);
  assert.equal(enpsOf([]).score, null);
  let checked = 0;
  for (const sid of ["s1a", "s1b", "s1", "s2"]) {
    const r = ref[sid];
    r.survey.questions.forEach((q, i) => {
      const a = aggregateQuestion(q, r.responses); const b = r.blocks[i]; const where = `${sid} п.${i + 1} (${q.type})`;
      if (a.type === "choice") a.bars.forEach((bar, k) => { assert.equal(b.bars[k].lb, bar.label, where); assert.equal(b.bars[k].vl, `${bar.pct}% · ${bar.count}`, where); });
      if (a.type === "scale") { assert.equal(b.avg, (a.avg ?? 0).toFixed(1), where); assert.deepEqual(b.hist, a.bins.map((x) => (x.count ? String(x.count) : "")), where); }
      if (a.type === "enps") { assert.equal(b.avg, (a.score! > 0 ? "+" : "") + a.score, where); assert.ok(b.seg[0].includes(`критики 0–6: ${a.d}`), where); assert.ok(b.seg[2].includes(`прихильники 9–10: ${a.p}`), where); }
      if (a.type === "matrix") a.rows.forEach((row, k) => { assert.equal(b.bars[k].lb, row.label, where); assert.ok(b.bars[k].vl.startsWith(row.avg!.toFixed(1)), where); });
      if (a.type === "rank") a.order.forEach((o, k) => { assert.equal(b.bars[k].lb, `${k + 1}. ${o.label}`, where); assert.ok(b.bars[k].vl.startsWith(o.avgPos!.toFixed(1)), where); });
      if (a.type === "text") assert.equal(b.texts, a.items.length, where);
      const m = questionMetric(q, r.responses); const e = r.metrics[i];
      if (!e) assert.equal(m, null, where);
      else { assert.ok(m, where); assert.equal(m!.lbl, e.lbl, where); assert.equal(fmtMetric(m!), e.out, where); assert.ok(Math.abs(m!.v - e.v) < 1e-9, where); }
      checked++;
    });
    assert.equal(closeSummary(r.survey.title, r.survey.questions, r.responses, r.survey.assigned.length, r.survey.responded.length), r.summary, `🔴 ${sid}: підсумок закриття не слово в слово`);
    assert.equal(csvFor(r.survey.anon, r.survey.questions, r.responses, (id) => USERS[id || ""] || "", (x) => ROLE[x || ""] || "", fmtDue), r.csv, `🔴 ${sid}: CSV не посимвольно`);
  }
  assert.ok(checked >= 20, "🔴 питань у фікстурі замало — перевірка беззуба");
});

/** #1131b — динаміка серії «Пульс» №1–№3: участь і метрики з дельтами ↑↓ як у таблиці макета. */
test("#1131b ДИНАМІКА ПО ВИПУСКАХ: участь і дельти ↑↓ по кожному питанню як у макеті", () => {
  const ref = FIX("results-ref.json") as Ref & { "trend-s1": Array<{ q: string; cells: string[] }> };
  const issues = ["s1a", "s1b", "s1"].map((id) => ({ issue: ref[id].survey.issue, status: ref[id].survey.status, closedAt: ref[id].survey.closedAt,
    assignedCount: ref[id].survey.assigned.length, respondedCount: ref[id].survey.responded.length, questions: ref[id].survey.questions, responses: ref[id].responses }));
  const t = trend(ref.s1.survey.questions, issues);
  const exp = ref["trend-s1"];
  assert.deepEqual(t.participation.map((p) => `${p.pct}%${p.responded}/${p.assigned}`), exp[0].cells);
  assert.equal(t.rows.length, exp.length - 1);
  t.rows.forEach((row, i) => {
    const cells = row!.cells.map((c) => (c ? c.out + (c.delta === null ? "" : (c.delta > 0 ? "↑ " : "↓ ") + c.deltaOut) : "—"));
    assert.deepEqual(cells, exp[i + 1].cells, `🔴 рядок динаміки ${i + 1}`);
  });
});

/** #1132 — моменти нагадувань і наступний запуск серії (чисті функції пакета). */
test("#1132 ПЛАНУВАЛЬНИК: нагадування за день і в день дедлайну; наступний випуск — найближчий заданий день", () => {
  const d = (s: string) => new Date(s);
  const m = reminderMoments(d("2026-10-12T18:00:00"), { on: true, days: 1, time: "10:00", dayOf: true });
  assert.equal(m.before?.toISOString(), d("2026-10-11T10:00:00").toISOString());
  assert.equal(m.dayOf?.toISOString(), d("2026-10-12T10:00:00").toISOString());
  assert.deepEqual(reminderMoments(d("2026-10-12T18:00:00"), { on: false, days: 1, time: "10:00", dayOf: true }), { before: null, dayOf: null });
  assert.equal(reminderMoments(d("2026-10-12T09:00:00"), { on: true, days: 1, time: "10:00", dayOf: true }).dayOf, null, "🔴 нагадування «в день» після дедлайну");
  assert.equal(nextLaunch(d("2026-10-07T18:00:00"), { on: true, per: "week", day: 1, time: "09:00" }).toISOString(), d("2026-10-12T09:00:00").toISOString());
  assert.equal(nextLaunch(d("2026-10-07T18:00:00"), { on: true, per: "2week", day: 1, time: "09:00" }).toISOString(), d("2026-10-19T09:00:00").toISOString());
  assert.equal(nextLaunch(d("2026-10-12T18:00:00"), { on: true, per: "week", day: 1, time: "09:00" }).toISOString(), d("2026-10-19T09:00:00").toISOString(), "🔴 наступний випуск — той самий понеділок");
});

/** #1132b — гейти форми: тексти макета; шкала/eNPS у межах; картинка — лише dataURL JPEG/PNG до межі. */
test("#1132b ПРАВИЛА ФОРМИ: запуск без адресатів/дедлайну — відмова словами; шкала в межах; картинка лише JPEG/PNG", () => {
  const now = new Date("2026-10-01T10:00:00Z");
  const q: Question = { id: 1, type: "scale", text: "Оцініть", options: [], rows: [], min: 1, max: 10, required: true };
  const base = { title: "Пульс", questions: [q], audience: { kind: "all" as const }, due: "2026-10-05T18:00:00Z" };
  assert.equal(validateSurvey(base, true, now), null);
  assert.equal(validateSurvey({ ...base, title: " " }, false, now), "Вкажіть назву опитування.");
  assert.equal(validateSurvey({ ...base, audience: { kind: "custom", ids: [] } }, true, now), "Оберіть, кому надіслати.");
  assert.equal(validateSurvey({ ...base, audience: { kind: "team" } }, true, now), "Оберіть команду.");
  assert.equal(validateSurvey({ ...base, due: null }, true, now), "Вкажіть дедлайн.");
  assert.equal(validateSurvey({ ...base, due: "2026-09-30T10:00:00Z" }, true, now), "Дедлайн уже минув — оберіть майбутню дату.");
  assert.equal(validateSurvey({ ...base, questions: [{ ...q, type: "single", options: ["Так"] }] }, true, now), "Питання 1: потрібно щонайменше два варіанти.");
  assert.equal(hasValue(q, 7), true);
  assert.equal(hasValue(q, 11), false, "🔴 оцінка поза шкалою прийнята");
  assert.equal(hasValue({ ...q, type: "rank", options: ["a", "b"] }, ["a"]), false, "🔴 ранжування не всіх варіантів прийнято");
  assert.equal(cleanImage("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(cleanImage("data:image/svg+xml;base64,PHN2Zz4="), null, "🔴 SVG (зі скриптами) прийнято як картинку");
  assert.equal(cleanImage("javascript:alert(1)"), null);
  assert.equal(cleanImage("data:image/png;base64," + "A".repeat(800_000)), null, "🔴 картинку понад межу прийнято");
});

/**
 * #1133 — ЖИВИЙ ЦИКЛ ЧЕРЕЗ HTTP на тимчасовій базі: справжній роут, справжні токени ролей.
 *  - HR (право `manage_surveys`) створює й запускає анонімне; адресати «усі» — БЕЗ адмінів і кандидата;
 *  - менеджер: результати — 403; відповідь — ок; повтор в анонімному — 409;
 *  - 🔒 в анонімному: `user_id` NULL, а обидва часи (подача й «відповів») — рівно початок доби;
 *  - розріз «менеджери» з 1 відповіддю в анонімному — 403; кандидат — 403 на вкладці;
 *  - планувальник: минулий дедлайн → закрито «auto», підсумок HR, наступний випуск серії «scheduled» на понеділок
 *    09:00; тик у момент запуску — запущено; нагадування — рівно один раз.
 * 🧨 Червоніє, якщо записати в анонімну відповідь `user_id`, повернути точний час, пустити менеджера в результати,
 * адресувати адміна «усім» або продублювати нагадування.
 */
test("#1133 ЖИВИЙ ЦИКЛ ОПИТУВАННЯ через HTTP: доступ, анонімність до дня, автозакриття, серія, нагадування один раз", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  process.env.DATABASE_URL = scratch.url;
  for (const k of ["JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  const { pool } = await import("../db/pool.js");
  const { default: express } = await import("express");
  let server: import("node:http").Server | null = null;
  try {
    await pool.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await pool.query(`INSERT INTO teams (id, name) VALUES (9101, 'Тестова А') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO users (id, email, password_hash, role, role_override, team_id, full_name, is_active) VALUES
      (901, 'hr@t', 'x', 'manager', 'hr', NULL, 'Ольга HR', true),
      (902, 'm1@t', 'x', 'manager', NULL, 9101, 'Марко Перший', true),
      (903, 'm2@t', 'x', 'manager', NULL, 9101, 'Марта Друга', true),
      (904, 'tl@t', 'x', 'team_lead', NULL, 9101, 'Тарас Лід', true),
      (905, 'c@t', 'x', 'manager', 'candidate', NULL, 'Кандидат', true),
      (906, 'ad@t', 'x', 'admin', 'admin', NULL, 'Адмін', true)`);
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();
    const { signToken } = await import("../auth/auth.js");
    const tok = (userId: number, roleKey: string, role: "admin" | "team_lead" | "manager" | "company" = "manager") =>
      signToken({ userId, role, roleKey, managerId: null, teamId: roleKey === "team_lead" ? 9101 : null });
    const HR = tok(901, "hr", "company"), M1 = tok(902, "manager"), M2 = tok(903, "manager"), TL = tok(904, "team_lead", "team_lead"), CAND = tok(905, "candidate");
    const { surveysRouter } = await import("../routes/surveys.js");
    const app = express(); app.use(express.json({ limit: "5mb" })); app.use("/api/surveys", surveysRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server!.address() as import("node:net").AddressInfo).port;
    const call = async (token: string, method: string, url: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/surveys${url}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const txt = await r.text(); let json: any = null; try { json = JSON.parse(txt); } catch { json = txt; }
      return { status: r.status, json };
    };

    // ── створення й запуск (HR) ──
    const draft = { title: "Пульс команди", desc: "", anon: true, allowEdit: false, due: new Date(Date.now() + 3 * 86400000).toISOString(),
      remind: { on: true, days: 1, time: "10:00", dayOf: true }, recur: { on: true, per: "week", day: 1, time: "09:00", days: 2 }, audience: { kind: "all" },
      questions: [{ type: "scale", text: "Оцініть навантаження", options: [], rows: [], min: 1, max: 10, required: true },
                  { type: "enps", text: "Порекомендуєте UTS?", options: [], rows: [], min: 0, max: 10, required: true }] };
    assert.equal((await call(M1, "POST", "", draft)).status, 403, "🔴 менеджер створив опитування");
    const c = await call(HR, "POST", "", draft); assert.equal(c.status, 200, JSON.stringify(c.json));
    const sid = c.json.id as number;
    const l = await call(HR, "POST", `/${sid}/launch`); assert.equal(l.status, 200, JSON.stringify(l.json));
    const asg = (await pool.query(`SELECT user_id FROM survey_assignments WHERE survey_id=$1 ORDER BY user_id`, [sid])).rows.map((r) => r.user_id);
    assert.deepEqual(asg, [902, 903, 904], "🔴 «усі» — не рівно працівники без адмінів і кандидата");
    assert.equal((await call(CAND, "GET", "/badge")).status, 403, "🔴 кандидат дістав вкладку опитувань");
    assert.deepEqual((await call(M1, "GET", "/badge")).json, { canManage: false, assigned: 1, unread: 1, fresh: 1 });

    // ── відповідь менеджера й анонімність ──
    const qs = (await call(M1, "GET", `/${sid}`)).json.questions as Array<{ id: number }>;
    assert.equal((await call(M1, "GET", `/${sid}/results`)).status, 403, "🔴 менеджер бачить результати");
    assert.equal((await call(M1, "POST", `/${sid}/respond`, { answers: { [qs[0].id]: 8 } })).status, 422, "🔴 пропуск обовʼязкового прийнято");
    assert.equal((await call(M1, "POST", `/${sid}/respond`, { answers: { [qs[0].id]: 8, [qs[1].id]: 9 } })).status, 200);
    assert.equal((await call(M1, "POST", `/${sid}/respond`, { answers: { [qs[0].id]: 2, [qs[1].id]: 1 } })).status, 409, "🔴 в анонімному відповідь змінено");
    const resp = (await pool.query(`SELECT user_id, submitted_at = date_trunc('day', submitted_at) AS day_only, updated_at = submitted_at AS same FROM survey_responses WHERE survey_id=$1`, [sid])).rows;
    assert.deepEqual(resp, [{ user_id: null, day_only: true, same: true }], "🔴 анонімна відповідь несе людину або точний час");
    const mark = (await pool.query(`SELECT responded_at = date_trunc('day', responded_at) AS day_only FROM survey_assignments WHERE survey_id=$1 AND user_id=902`, [sid])).rows[0];
    assert.equal(mark.day_only, true, "🔴 «відповів» з точним часом — звʼязується з анонімною відповіддю");
    const sl = await call(HR, "GET", `/${sid}/results?slice=managers`);
    assert.equal(sl.status, 403, "🔴 анонімний розріз з 1 відповіді відкрито");
    const res = await call(HR, "GET", `/${sid}/results`);
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.participation.responded, res.json.participation.respondedList, res.json.enps.score], [1, [], 100], "🔴 анонімне показує, хто відповів");

    // ── автозакриття, підсумок, серія, запуск, нагадування ──
    const { tickSurveys } = await import("./surveyScheduler.js");
    await pool.query(`UPDATE surveys SET due = now() - interval '1 minute' WHERE id=$1`, [sid]);
    const t1 = await tickSurveys(pool, new Date());
    assert.equal(t1.closed, 1);
    const closed = (await pool.query(`SELECT status, closed_by FROM surveys WHERE id=$1`, [sid])).rows[0];
    assert.deepEqual(closed, { status: "closed", closed_by: "auto" });
    const sum = (await pool.query(`SELECT user_id, text FROM survey_notifications WHERE kind='summary' ORDER BY user_id`)).rows;
    assert.deepEqual(sum.map((x) => x.user_id), [901, 906], "🔴 підсумок не тим, хто керує опитуваннями");
    assert.match(sum[0].text, /відповіли 1\/3 \(33%\).*eNPS \+100/, "🔴 підсумок не той");
    const next = (await pool.query(`SELECT id, status, launch_at, due FROM surveys WHERE series_id=$1 AND issue=2`, [sid])).rows[0];
    assert.ok(next && next.status === "scheduled" && new Date(next.launch_at).getDay() === 1 && new Date(next.launch_at).getHours() === 9, "🔴 наступний випуск не заплановано на понеділок 09:00");
    const t2 = await tickSurveys(pool, new Date(next.launch_at));
    assert.equal(t2.launched, 1, "🔴 запланований випуск не запущено");
    const before = new Date(next.due); before.setDate(before.getDate() - 1); before.setHours(10, 5, 0, 0);
    const t3 = await tickSurveys(pool, before);
    const t4 = await tickSurveys(pool, new Date(before.getTime() + 60_000));
    assert.deepEqual([t3.reminded, t4.reminded], [3, 0], "🔴 нагадування не рівно один раз");
    void M2; void TL;
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

/**
 * #1134 — ФРОНТ ОПИТУВАНЬ: пункт меню, статичний імпорт (#225), пункт лише тим, кому є що відповідати або хто керує;
 * CSV — через api з токеном; CSS макета ізольований під `.srvx`.
 */
test("#1134 ФРОНТ ОПИТУВАНЬ: пункт меню за бейджем, статичний імпорт, CSV через api, CSS під .srvx", () => {
  const REPO = path.join(import.meta.dirname, "..", "..", "..");
  const FE = (rel: string) => readFileSync(path.join(REPO, "frontend", "src", rel), "utf8");
  assert.match(FE("components/Layout.tsx"), /\{ key: "surveys", label: "Опитування"/, "🔴 немає пункту меню");
  const dash = FE("pages/Dashboard.tsx");
  assert.match(dash, /import \{ SurveysSection \} from "\.\/dashboard\/sections\/SurveysSection";/, "🔴 імпорт не статичний");
  assert.match(dash, /section === "surveys" && <SurveysSection \/>/);
  const sec = FE("pages/dashboard/sections/SurveysSection.tsx");
  assert.doesNotMatch(sec, /href=\{?["'`]?\/api\/surveys/, "🔴 CSV через голе посилання — 401 без токена");
  assert.doesNotMatch(sec, /React\.lazy|import\(/, "🔴 динамічний імпорт — другий чанк (#225)");
  assert.match(FE("components/Layout.tsx"), /surveysBadge/, "🔴 пункт меню не зважає, чи є людині що відповідати");
  const css = FE("pages/dashboard/sections/surveys.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const sels = [...css.matchAll(/([^{}@]+)\{[^{}]*\}/g)].map((m) => m[1].trim()).filter((s) => s && !s.startsWith("@") && !/^\d/.test(s) && !/^(from|to)$/.test(s));
  assert.ok(sels.length > 60, "🔴 CSS макета порожній");
  const leak = sels.flatMap((s) => s.split(",").map((x) => x.trim())).filter((x) => !/^(:root\[data-theme="dark"\] )?\.srvx\b/.test(x));
  assert.deepEqual(leak, [], "🔴 правило макета опитувань діє поза розділом");
});
