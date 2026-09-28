import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { workuaUrl, parseResponses, parseJobs, responseComment } from "./workua.js";

/**
 * 💼 ВІДГУКИ З WORK.UA → «КАНДИДАТИ» (28.09.2026, прохід 7) — гейти `#770`–`#773`.
 * Номери з запасом над `#752` (у main зайнято до #752) — борг 17: перед мержем перемірити перетин.
 */
const SRC = (...p: string[]) => path.join(import.meta.dirname, "..", "..", "..", "backend", "src", ...p);

/**
 * #770 — РОЗБІР ВІДГУКУ на всіх трьох типах (резюме з сайту / файл / без резюме): id, вакансія, ПІБ, телефон,
 * пошта, файл; рядок без id викидається; коментар картки — супровідний лист + резюме без HTML, обрізаний.
 * 🧨 Червоніє, якщо не читати `job_id`/`with_file` або тягнути HTML у коментар.
 */
test("#770 work.ua: розбір відгуку — усі три типи, коментар без HTML і обрізаний", () => {
  const r = parseResponses({ status: "ok", items: [
    { id: 11, job_id: 7542760, date: "2026-09-28T10:10:49+03:00", fio: "Олефіренко Катерина", email: "k@x.ua", phone: "050 111-22-33", type: "resume", with_file: 0, text: "<p>Досвід</p><br /><b>логістика</b>", cover: "Хочу працювати" },
    { id: 12, job_id: "7542760", fio: "", phone: "+380671112233", type: "file", with_file: "1", text: null },
    { id: 13, type: "easy", cover: "Без резюме" },
    { fio: "без id" },
  ] });
  assert.deepEqual(r.map((x) => [x.id, x.jobId, x.type, x.withFile]), [[11, 7542760, "resume", false], [12, 7542760, "file", true], [13, null, "easy", false]]);
  assert.equal(r[1].fio, null, "🔴 порожнє ПІБ (конфіденційне резюме) не стало null");
  // Фікстура несе і `<br>`, і справжні теги (`<p>`, `<b>`): лише `<br>` лишав гейт зеленим на зламаному вирізанні тегів (саботаж 28.09).
  assert.equal(responseComment(r[0]), "Супровідний лист: Хочу працювати\n\nРезюме: Досвід\nлогістика", "🔴 HTML потрапив у коментар");
  assert.equal(responseComment({ ...r[0], cover: null, text: "а".repeat(5000) })!.length, 3001, "🔴 резюме не обрізано");
  assert.equal(responseComment({ ...r[0], cover: null, text: null }), null, "дзеркало: порожнє — не коментар");
  assert.deepEqual(parseJobs({ items: [{ id: 1, name: "Менеджер", active: 1 }, { id: 2, active: 0 }] }).map((j) => [j.id, j.name, j.active]),
    [[1, "Менеджер", true], [2, "без назви", false]]);
  assert.deepEqual(parseResponses({}), [], "дзеркало: порожня відповідь — порожній список");
});

/**
 * #772 — ПЛАТНІ ВІДКРИТТЯ КОНТАКТІВ НЕ ВИТРАЧАЮТЬСЯ: `workuaUrl` відкидає `/resumes` і `/resume` (з параметрами й
 * без), а в жодному файлі бекенду немає прямого звернення до цих шляхів повз `workuaUrl`.
 * 🧨 Червоніє, якщо прибрати заборону або десь написати `fetch(".../resumes")` напряму.
 */
test("#772 work.ua: /resumes і /resume заборонені — платні відкриття контактів не витрачаються", () => {
  for (const bad of ["/resumes", "/resume", "/resumes?search=логіст", "/resume?resume_id=1", "resumes", "/resume/"])
    assert.throws(() => workuaUrl(bad), /заборонено/, `🔴 ${bad} пропущено`);
  for (const ok of ["/jobs/my?all=1", "/jobs/responses?limit=50", "/response_files/1/2"])
    assert.equal(workuaUrl(ok), `https://api.work.ua${ok}`, "дзеркало: дозволені запити проходять");
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) files.push(p); } };
  walk(SRC());
  const hits = files.filter((f) => /api\.work\.ua\/resumes?\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, [], "🔴 пряме звернення до платних шляхів work.ua: " + hits.join(", "));
  assert.ok(files.length > 50, "дзеркало: обхід бачить файли бекенду");
});

async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const db = c as unknown as import("./secrets.js").Db;
  const h = await import("./hiring.js");
  const vac = await h.createVacancy(db as never, null, { title: "Менеджер з продажу" });
  return { c, db, h, vac, store: await import("./workuaStore.js"), done: async () => { await c.end(); s.dispose(); } };
}

/**
 * #771 — ЖИВИЙ SQL: новий телефон → кандидат «новий» з джерелом work.ua і вакансією (якщо привʼязано); ТОЙ САМИЙ
 * телефон, що Іван уже вніс руками, → подія «повторний відгук» у наявній картці, статус і коментар не зачеплено;
 * повторний прогін тих самих відгуків нічого не додає; файл PDF лягає у «Файли», DOC — лише примітка в історії.
 * 🧨 Червоніє, якщо той самий телефон створює другого кандидата або повтор дублює.
 */
test("#771 ЖИВИЙ SQL: відгуки → кандидати без дублів за телефоном; ручна картка Івана не зачеплена", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    const manual = await s.h.createCandidate(s.db as never, null, { fullName: "Бойко Кирило", phone: "0501110001", vacancyId: s.vac, source: "work.ua", comment: "дзвонив Іван" });
    await s.c.query(`UPDATE hiring_candidates SET status = 'planned' WHERE id = $1`, [manual]);
    await s.store.setVacancyWorkuaJob(s.db, s.vac, 7542760);
    const resp = parseResponses({ items: [
      { id: 101, job_id: 7542760, date: "2026-09-27T10:00:00+03:00", fio: "Олефіренко Катерина", phone: "050 222-33-44", email: "k@x.ua", type: "resume", cover: "Хочу" },
      { id: 102, job_id: 7542760, date: "2026-09-28T10:00:00+03:00", fio: "Бойко Кирило", phone: "+38 (050) 111-00-01", type: "file", with_file: 1 },
      { id: 103, job_id: 999, date: "2026-09-28T11:00:00+03:00", fio: "Інша Вакансія", phone: "0503334455", type: "file", with_file: 1 },
    ] });
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100)]), doc = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]);
    const files = { fetch: async (r: { id: number }) => (r.id === 102 ? pdf : doc), store: async () => "hiring-test.pdf" };
    const r1 = await s.store.absorbResponses(s.db, resp, files);
    assert.deepEqual([r1.created, r1.repeat, r1.files], [2, 1, 1], "🔴 не той підсумок: " + JSON.stringify(r1));
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM hiring_candidates WHERE phone_norm = (SELECT phone_norm FROM hiring_candidates WHERE id = $1)`, [manual])).rows[0].n, 1, "🔴 той самий телефон створив другого кандидата");
    const m = (await s.c.query(`SELECT status, comment FROM hiring_candidates WHERE id = $1`, [manual])).rows[0];
    assert.deepEqual(m, { status: "planned", comment: "дзвонив Іван" }, "🔴 ручну картку Івана зачеплено");
    assert.ok((await s.c.query(`SELECT 1 FROM hiring_events WHERE candidate_id = $1 AND kind = 'repeat' AND comment LIKE 'повторний відгук з work.ua%'`, [manual])).rowCount, "🔴 немає події «повторний відгук»");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM hiring_files WHERE candidate_id = $1`, [manual])).rows[0].n, 1, "🔴 PDF не лягло у «Файли»");
    const kat = (await s.c.query(`SELECT id, source, status, comment FROM hiring_candidates WHERE full_name = 'Олефіренко Катерина'`)).rows[0];
    assert.deepEqual([kat.source, kat.status, kat.comment], ["work.ua", "new", "Супровідний лист: Хочу"]);
    assert.ok((await s.c.query(`SELECT 1 FROM hiring_candidate_vacancies WHERE candidate_id = $1 AND vacancy_id = $2`, [kat.id, s.vac])).rowCount, "🔴 вакансію не привʼязано");
    const other = (await s.c.query(`SELECT id FROM hiring_candidates WHERE full_name = 'Інша Вакансія'`)).rows[0].id;
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM hiring_candidate_vacancies WHERE candidate_id = $1`, [other])).rows[0].n, 0, "🔴 неприв'язана вакансія work.ua дала вакансію");
    assert.ok((await s.c.query(`SELECT 1 FROM hiring_events WHERE candidate_id = $1 AND comment LIKE '%не PDF%'`, [other])).rowCount, "🔴 DOC зник мовчки");
    // Повтор — нічого не додає.
    const r2 = await s.store.absorbResponses(s.db, resp, files);
    assert.deepEqual([r2.created, r2.repeat, r2.skipped], [0, 0, 3], "🔴 повторний прогін дублює");
    assert.equal(await s.store.lastResponseId(s.db), 103);
    const sum = await s.store.workuaSummary(s.db);
    assert.deepEqual([sum.total, sum.created, sum.repeat, sum.novac], [3, 2, 1, 1]);
    // Одна вакансія work.ua — одна наша.
    const v2 = await s.h.createVacancy(s.db as never, null, { title: "Логіст" });
    await assert.rejects(s.store.setVacancyWorkuaJob(s.db, v2, 7542760), (e: unknown) => (e as { status?: number }).status === 409, "🔴 одну вакансію work.ua привʼязано двічі");
  } finally { await s.done(); }
});

/**
 * #773 — БЕЗ ЛОГІНА — ЧЕСНИЙ ПРОПУСК, А НЕ «НУЛЬ ВІДГУКІВ»; перший запуск бере рівно 14 днів, далі — лише нове
 * (зупинка на обробленому id); `workua_responses` закрита для AI.
 * 🧨 Червоніє, якщо без логіна джоба «успішно» нічого не робить або перший запуск тягне всю історію.
 */
test("#773 work.ua: без логіна — пропуск; 14 днів при першому запуску, далі лише нове; таблиця закрита для AI", async () => {
  const prev = [process.env.WORKUA_LOGIN, process.env.WORKUA_PASSWORD];
  delete process.env.WORKUA_LOGIN; delete process.env.WORKUA_PASSWORD;
  const job = await import("../jobs/syncWorkua.js");
  try {
    assert.deepEqual(await job.syncWorkua(), { skipped: true, reason: "немає WORKUA_LOGIN / WORKUA_PASSWORD — відгуки з work.ua не забираємо" }, "🔴 без логіна — тихий успіх");
    assert.equal(job.getWorkuaStatus().configured, false);
  } finally { if (prev[0]) process.env.WORKUA_LOGIN = prev[0]; if (prev[1]) process.env.WORKUA_PASSWORD = prev[1]; }
  // Межі вибірки — на підміненому fetch: дві порції, 20 днів відгуків.
  const now = Date.parse("2026-09-28T12:00:00+03:00");
  const all = Array.from({ length: 80 }, (_, i) => ({ id: 1000 - i, job_id: 1, date: new Date(now - i * 6 * 3600_000).toISOString(), phone: `05000${String(i).padStart(5, "0")}` }));
  const orig = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (u: string) => {
    asked.push(u);
    const before = Number(new URL(u).searchParams.get("before_id") ?? Infinity);
    const page = all.filter((x) => x.id < before).slice(0, 50);
    return new Response(JSON.stringify({ items: page }), { status: page.length ? 200 : 404 });
  }) as typeof fetch;
  try {
    const first = await job.fetchNewResponses({}, null, now);
    assert.equal(first.length, 57, "🔴 перший запуск взяв не 14 днів: " + first.length); // 14 днів × 4 відгуки/день + сьогоднішній
    assert.ok(first.every((r) => Date.parse(r.date!) >= now - 14 * 86_400_000), "🔴 узято старіше 14 днів");
    const next = await job.fetchNewResponses({}, 995, now);
    assert.deepEqual(next.map((r) => r.id), [1000, 999, 998, 997, 996], "🔴 не зупинилось на обробленому id");
    assert.ok(asked.every((u) => !/\/resumes?\b/.test(u)), "🔴 ходили в платні шляхи");
  } finally { globalThis.fetch = orig; }
  const sql = readFileSync(SRC("db", "schema.sql"), "utf8");
  assert.ok(sql.indexOf("REVOKE ALL ON workua_responses FROM ai_readonly;") > sql.indexOf("CREATE TABLE IF NOT EXISTS workua_responses ("), "🔴 REVOKE немає або вище за CREATE");
  assert.match(readFileSync(SRC("ai", "metricTools.ts"), "utf8"), /"workua_responses",/, "🔴 немає у FORBIDDEN_TABLES");
});
