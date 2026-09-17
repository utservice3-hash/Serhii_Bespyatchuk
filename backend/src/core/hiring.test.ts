import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizePhone, hiringAccess, canTransition, cleanUrl, dailyTotals, attendancePct, validRange,
  type DailyRow,
  refusalVerdict, TRANSITIONS, LEAD_TRANSITIONS, HIRING_STATUSES, messengerLinks, sniffFileMime, hiringStoredName, vacancyCloseStatus,
} from "./hiringRules.js";

/**
 * 🧑‍💼 НАЙМ, прохід 1 (17.09.2026) — гейти `#500`–`#506`.
 * Номери взято з запасом над `#490` (найвищий у `main` на момент початку); борг 17 —
 * перед мержем перемірити перетин.
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");

/**
 * #500 — ОДИН НОМЕР У РІЗНИХ ЗАПИСАХ — ОДИН КЛЮЧ. Саме на цьому стоїть «повторний відгук»:
 * без нормалізації «066 166 97 04» і «+380661669704» — дві різні людини в базі.
 * 🧨 Червоніє, якщо прибрати зведення до 380… або перестати викидати нецифри.
 */
test("#500 ТЕЛЕФОН: один номер у різних записах дає один ключ дублів", () => {
  const same = ["066 166 97 04", "+38 (066) 166-97-04", "380661669704", "0661669704", "661669704", "8 066 166 97 04"];
  const keys = new Set(same.map(normalizePhone));
  assert.equal(keys.size, 1, `🔴 один номер дав ${keys.size} ключі: ${[...keys].join(", ")}`);
  assert.equal([...keys][0], "380661669704");
});

/** #500b — ДЗЕРКАЛО: різні номери лишаються різними, сміття ключем не стає. */
test("#500b ДЗЕРКАЛО: різні номери — різні ключі; короткий чи порожній — не ключ", () => {
  assert.notEqual(normalizePhone("0661669704"), normalizePhone("0661669705"), "🔴 різні номери злиплись");
  assert.equal(normalizePhone("48576029412"), "48576029412", "закордонний номер лишається своїми цифрами");
  assert.equal(normalizePhone("123"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(undefined), null);
});

/**
 * #501 — МЕЖА ДОСТУПУ ВСЕРЕДИНІ РОЗДІЛУ, у ОБИДВА боки.
 * 🧨 Червоніє, якщо тімліду дозволити переходи рекрутера, або рекрутеру (HR) — забрати їх,
 * або відкрити «none» ролям, яким адмін дав вкладку тумблером.
 */
test("#501 ДОСТУП: HR і адмін-рівень редагують, тімлід — лише свій етап, решта — нічого", () => {
  assert.equal(hiringAccess({ roleKey: "hr", adminScope: false }), "edit");
  assert.equal(hiringAccess({ roleKey: "opdir", adminScope: true }), "edit");
  assert.equal(hiringAccess({ roleKey: "team_lead", adminScope: false }), "lead");
  assert.equal(hiringAccess({ roleKey: "manager", adminScope: false }), "none", "🔴 менеджер отримав доступ до кандидатів");
  assert.equal(hiringAccess({ roleKey: "candidate", adminScope: false }), "none");

  // рекрутер: шлях макета проходить, стрибок через етапи — ні
  assert.equal(canTransition("planned", "done", "edit", null).ok, true);
  assert.equal(canTransition("planned", "manager", "edit", null).ok, false, "🔴 рекрутер перестрибнув етапи");
  // тімлід: свій етап так, рекрутерський — ні
  assert.equal(canTransition("lead", "candidate", "lead", null).ok, true, "🔴 тімлід не може взяти кандидата");
  assert.equal(canTransition("training", "manager", "lead", null).ok, true, "🔴 тімлід не може перевести в менеджери");
  assert.equal(canTransition("planned", "done", "lead", null).ok, false, "🔴 тімлід веде графік рекрутера");
  assert.equal(canTransition("lead", "candidate", "none", null).ok, false);
});

/**
 * #501b — СКАСОВНІСТЬ (правило власника 06.08.2026). Кінцеві статуси («чорний список»,
 * «менеджер») без цього не виправити нічим. Повернення дозволене РІВНО в попередній статус.
 * 🧨 Червоніє, якщо прибрати гілку `lastFrom === to` або дозволити повернення в будь-який.
 */
test("#501b СКАСОВНІСТЬ: останню зміну можна повернути, але лише в попередній статус", () => {
  // Фікстура оновлена в проході 1a (17.09): «не підходить» злито у «відмову» з причиною. Твердження те саме.
  assert.equal(canTransition("black", "refused", "edit", "refused").ok, true, "🔴 помилковий «чорний список» не скасувати");
  assert.equal(canTransition("black", "planned", "edit", "refused").ok, false, "🔴 «скасування» веде куди завгодно");
  assert.equal(canTransition("manager", "training", "lead", "training").ok, true, "🔴 тімлід не скасує власне «менеджер»");
  assert.equal(canTransition("lead", "done", "lead", "done").ok, false, "🔴 тімлід повернув кандидата в етап рекрутера");
});

/** #502 — ПОСИЛАННЯ ЛИШЕ http/https. `javascript:` у клітинці = чужий код у сесії того, хто клікне. */
test("#502 ПОСИЛАННЯ: лише http/https, javascript: відхиляється", () => {
  assert.equal(cleanUrl("https://tldv.io/app/meetings/1"), "https://tldv.io/app/meetings/1");
  assert.equal(cleanUrl("javascript:alert(1)"), undefined, "🔴 javascript:-посилання пройшло");
  assert.equal(cleanUrl("data:text/html,x"), undefined);
  assert.equal(cleanUrl(""), null, "порожнє — це «прибрати посилання», а не помилка");
});

/**
 * #502b — ЯВКА НЕ СКЛАДАЄТЬСЯ: разом = Σ прийшли ÷ Σ заплановано, а не середнє відсотків.
 * Фікстура з днями РІЗНОЇ ваги: 1/1 = 100 % і 1/9 = 11 %; середнє дало б 56 %, правда — 20 %.
 * 🧨 Червоніє, якщо рахувати явку середнім або порожній знаменник показувати як 0 %.
 */
test("#502b ЯВКА ПЕРІОДУ — з сум, а не середнє відсотків; нуль заплановано — «нема з чого»", () => {
  const z = { booked: 0, noshow: 0, toLead: 0, toCandidate: 0, toTraining: 0, toManager: 0, resumes: 0, coldSearch: 0 };
  const rows: DailyRow[] = [{ day: "2026-09-01", planned: 1, done: 1, ...z }, { day: "2026-09-02", planned: 9, done: 1, ...z }];
  assert.equal(dailyTotals(rows).attendancePct, 20, "🔴 явка періоду — середнє відсотків, а не з сум");
  assert.equal(dailyTotals(rows).planned, 10);
  assert.equal(attendancePct(0, 0), null, "🔴 нуль заплановано показано як 0 %");
  assert.equal(validRange("2026-09-02", "2026-09-01"), null);
  assert.equal(validRange("2025-01-01", "2026-09-01"), null, "🔴 період понад 400 днів пропущено");
});

/**
 * #503 — ЖИВИЙ SQL НА СХЕМІ З НУЛЯ: графік → кандидат → явка → статуси → звіт.
 *
 * Одна фікстура, кожне твердження — по обидва боки своєї межі:
 *  • другий запис того самого номера (інший формат) → той самий кандидат, дубля немає;
 *  • «проведено» — за днем ПОЗНАЧКИ за Києвом: 00:30 12.09 за Києвом = 21:30 11.09 за UTC;
 *  • Σ днів звіту == разом, «заплановано» — за датою співбесіди;
 *  • тімлід бачить лише свою команду і лише після етапу «з тімлідом»;
 *  • видалити → відновити повертає рядок до байта;
 *  • номер іншого кандидата при редагуванні — 409, а не мовчазне злиття.
 *
 * ⚠️ На ПРОД-сервері бінарів PostgreSQL немає → `skip` через `skipReason()` і запис у
 * `ALLOWED_PROD_SKIPS`. У `npm test` гейт ОБОВʼЯЗКОВИЙ.
 */
test("#503 ЖИВИЙ SQL: графік, дублі, явка за Києвом, звіт, межа тімліда, відновлення", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const h = await import("./hiring.js");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  const db = c as unknown as import("./hiring.js").Db;
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК · Дмитрук'),(2,'РНК · Безпамʼятний') ON CONFLICT DO NOTHING");

    // ── рядок графіка → кандидат
    const i1 = await h.createInterview(db, null, { interviewDate: "2026-09-11", interviewTime: "10:30" });
    const r1 = await h.updateInterview(db, null, i1, { fullName: "Левчук Софія", phone: "066 000 01 01", source: "work.ua" });
    assert.ok(r1.candidateId, "🔴 ПІБ у графіку не створив кандидата");
    const i2 = await h.createInterview(db, null, { interviewDate: "2026-09-12" });
    const r2 = await h.updateInterview(db, null, i2, { fullName: "Софія (повторно)", phone: "+380660000101" });
    assert.equal(r2.candidateId, r1.candidateId, "🔴 той самий номер в іншому форматі створив дубль");
    assert.ok(r2.repeat, "🔴 повторний відгук не позначено");
    assert.equal((await c.query("SELECT count(*)::int n FROM hiring_candidates")).rows[0].n, 1);

    // ── явка: позначка о 00:30 12.09 за Києвом (= 21:30 11.09 UTC) мусить лягти в 12.09
    await h.updateInterview(db, null, i1, { attended: true });
    await c.query("UPDATE hiring_interviews SET attended_at = '2026-09-12 00:30:00+03' WHERE id = $1", [i1]);
    const st = (await c.query("SELECT status FROM hiring_candidates WHERE id = $1", [r1.candidateId])).rows[0].status;
    assert.equal(st, "done", "🔴 позначка «прийшов» не зсунула статус «заплановано» → «проведено»");

    const rep = await h.dailyReport(db, "2026-09-11", "2026-09-12");
    const d11 = rep.find((r) => r.day === "2026-09-11")!, d12 = rep.find((r) => r.day === "2026-09-12")!;
    assert.equal(d11.planned, 1, "🔴 «заплановано» не за датою співбесіди");
    assert.equal(d12.planned, 1);
    assert.equal(d11.done, 0, "🔴 позначку 00:30 за Києвом зараховано в попередній день (межа UTC)");
    assert.equal(d12.done, 1, "🔴 «проведено» не за днем позначки за Києвом");
    const tot = dailyTotals(rep);
    assert.equal(tot.planned, rep.reduce((s, r) => s + r.planned, 0), "🔴 Σ днів ≠ разом");
    assert.equal(tot.done, 1);

    // ── статуси: коментар обовʼязковий, команда обовʼязкова на «з тімлідом»
    const id = r1.candidateId!;
    await assert.rejects(h.changeStatus(db, null, id, { to: "lead", comment: "" }, "edit", null), /Коментар/);
    await assert.rejects(h.changeStatus(db, null, id, { to: "lead", comment: "ок" }, "edit", null), /команду/);
    await h.changeStatus(db, null, id, { to: "lead", comment: "до Дмитрука", teamId: 1 }, "edit", null);
    const trainDay = (await c.query("SELECT (now() AT TIME ZONE 'Europe/Kyiv')::date::text d")).rows[0].d as string;

    // ── межа тімліда: своя команда після етапу «з тімлідом» — так; чужа — ні; до етапу — ні
    // прохід 1a: форма кандидата вимагає вакансію — фікстура її дає, твердження гейта незмінне
    const vacOther = await h.createVacancy(db, null, { title: "Менеджер з продажу (РПК)" });
    const other = await h.createCandidate(db, null, { fullName: "Інший Кандидат", phone: "0660000202", vacancyId: vacOther });
    await c.query("UPDATE hiring_candidates SET team_id = 1 WHERE id = $1", [other]); // команда є, етапу немає
    const mine = await h.listCandidates(db, {}, "lead", 1);
    assert.deepEqual(mine.rows.map((r) => (r as { id: number }).id), [id], "🔴 тімлід бачить не рівно своїх після етапу «з тімлідом»");
    assert.equal((await h.listCandidates(db, {}, "lead", 2)).total, 0, "🔴 тімлід бачить кандидата чужої команди");
    assert.equal((await h.listCandidates(db, {}, "edit", null)).total, 2, "🔴 рекрутер бачить не всіх");
    await assert.rejects(h.candidateCard(db, other, "lead", 1), /не знайдено/, "🔴 тімлід відкрив картку до свого етапу");

    await h.changeStatus(db, null, id, { to: "candidate", comment: "беремо" }, "lead", 1);
    await h.changeStatus(db, null, id, { to: "training", comment: "на навчання" }, "lead", 1);
    const rep2 = await h.dailyReport(db, trainDay, trainDay);
    assert.equal(rep2[0].toTraining, 1, "🔴 перехід «на навчанні» не зарахований у день переходу");
    assert.equal(rep2[0].toCandidate, 1);

    // ── номер іншого кандидата при редагуванні — 409
    await assert.rejects(h.updateCandidateFields(db, null, other, { phone: "066-000-01-01" }),
      (e: unknown) => (e as { status?: number }).status === 409, "🔴 номер іншого кандидата прийнято мовчки");

    // ── видалити → відновити = рядок до байта
    const snap = async () => (await c.query("SELECT row_to_json(i)::text j FROM hiring_interviews i WHERE id = $1", [i2])).rows[0].j;
    const before = await snap();
    await h.setInterviewDeleted(db, null, i2, true);
    assert.equal((await h.scheduleRows(db, "2026-09-12", "2026-09-12")).length, 0, "🔴 видалений рядок лишився в графіку");
    await h.setInterviewDeleted(db, null, i2, false);
    assert.equal(await snap(), before, "🔴 відновлений рядок відрізняється від того, що видалили");

    // ── ручні числа: часткове збереження не затирає друге поле
    await h.setDailyManual(db, null, "2026-09-11", { resumes: 30 });
    await h.setDailyManual(db, null, "2026-09-11", { coldSearch: 7 });
    const m = (await h.dailyReport(db, "2026-09-11", "2026-09-11"))[0];
    assert.equal(m.resumes, 30, "🔴 збереження холодного пошуку затерло резюме");
    assert.equal(m.coldSearch, 7);
  } finally { await c.end(); scratch.dispose(); }
});

/**
 * #504 — РОЛІ ВКЛАДКИ В МАТРИЦІ Й У СИДІ — ОДИН СПИСОК (та сама форма, що `#440`).
 * 🧨 Червоніє, якщо дописати роль лише в матрицю або лише в сид.
 */
test("#504 НАЙМ: ролі в матриці й у сиді вкладки — один і той самий список", () => {
  const row = /path: "\/api\/hiring\/candidates", cls: "GET",\s*\n\s*allow: \[([^\]]*)\]/.exec(SRC("auth/accessMatrix.ts"));
  assert.ok(row, "🔴 рядок матриці для /api/hiring/candidates не знайдено");
  const inMatrix = [...row[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const seed = /screen_access \|\| '\{"hiring":true\}'::jsonb\s*\n\s*WHERE key IN \(([^)]*)\)/.exec(SRC("db/schema.sql"));
  assert.ok(seed, "🔴 сид ключа екрана `hiring` не знайдено в schema.sql");
  const inSeed = [...seed[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(inMatrix, inSeed, `🔴 матриця: ${inMatrix.join(",")} · сид: ${inSeed.join(",")}`);
  assert.ok(!inSeed.includes("candidate"), "🔴 кандидат отримав вкладку найму (#443: рівно два екрани)");
});

/**
 * #505 — ПЕРСОНАЛЬНІ ДАНІ КАНДИДАТІВ ЗАКРИТІ ВІД МОДЕЛІ НА ДВОХ РУБЕЖАХ.
 * `GRANT SELECT ON ALL TABLES TO ai_readonly` накриває кожну нову таблицю, тож REVOKE мусить
 * стояти ПІСЛЯ нього й після CREATE — інакше на кожній міграції доступ повертається.
 * 🧨 Червоніє, якщо прибрати таблицю з REVOKE, поставити REVOKE вище GRANT чи CREATE,
 * або прибрати її з `FORBIDDEN_TABLES`.
 */
test("#505 НАЙМ: таблиці кандидатів відібрані в ai_readonly після GRANT і в FORBIDDEN_TABLES", () => {
  const TABLES = ["hiring_candidates", "hiring_interviews", "hiring_events", "hiring_daily_manual"];
  const sql = SRC("db/schema.sql");
  const grantAt = sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;");
  assert.ok(grantAt > 0, "🔴 не знайдено GRANT для ai_readonly");
  for (const tb of TABLES) {
    const createAt = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tb} (`);
    assert.ok(createAt > 0, `🔴 не знайдено CREATE ${tb}`);
    const revokes = [...sql.matchAll(/REVOKE ALL ON ([^;]*?) FROM ai_readonly;/g)]
      .filter((m) => new RegExp(`\\b${tb}\\b`).test(m[1]) && m.index! > grantAt && m.index! > createAt);
    assert.ok(revokes.length > 0, `🔴 ${tb}: немає REVOKE від ai_readonly після GRANT і CREATE`);
  }
  const list = /FORBIDDEN_TABLES\s*=\s*\[([\s\S]*?)\]/.exec(SRC("ai/metricTools.ts"));
  assert.ok(list, "🔴 FORBIDDEN_TABLES не знайдено");
  const missing = TABLES.filter((tb) => !list[1].includes(`"${tb}"`));
  assert.deepEqual(missing, [], `🔴 не в FORBIDDEN_TABLES: ${missing.join(", ")}`);
});

/**
 * #506 — МЕЖА ПЕРШИМ ОПЕРАТОРОМ КОЖНОГО ОБРОБНИКА. На цьому стоїть безпека проб `deny-only`
 * у матриці: тімлід із пробою POST мусить отримати 403 ДО будь-якого запису. Запис графіка,
 * бази й звіту — лише `onlyEdit`; статус і коментар — `anyAccess` (тімлід у своїх межах).
 * 🧨 Червоніє, якщо переставити перевірку нижче `tx(` або дати запису графіка `anyAccess`.
 */
test("#506 НАЙМ: перевірка доступу — перший оператор кожного обробника", () => {
  const src = SRC("routes/hiring.ts");
  const handlers = [...src.matchAll(/hiringRouter\.(get|post|patch|delete|put)\("([^"]+)", async \(req, res\) => \{\s*try \{\s*([^\n;]+);/g)];
  assert.ok(handlers.length >= 14, `🔴 знайдено лише ${handlers.length} обробників — гейт нічого не перевіряє`);
  // Прохід 1a: відмова — теж запис тімліда (свої кандидати, свій етап).
  // Прохід 2a: запрошення, продовження доступу, рішення й відповідь — теж для тімліда своєї команди.
  const LEAD_WRITES = new Set(["/candidates/:id/status", "/candidates/:id/comment", "/candidates/:id/refuse",
    "/candidates/:id/invite", "/candidates/:id/access/extend", "/candidates/:id/promote", "/candidates/:id/questions/:questionId/answer"]);
  for (const [, method, p, first] of handlers) {
    const isWrite = method !== "get";
    const expected = isWrite && !LEAD_WRITES.has(p) ? /^onlyEdit\(req\)$/ : /^(onlyEdit\(req\)|const access = anyAccess\(req\))$/;
    assert.match(first.trim(), expected, `🔴 ${method.toUpperCase()} ${p}: першим стоїть «${first.trim()}»`);
  }
  for (const p of ["/schedule", "/daily"])
    assert.ok(handlers.some(([, m, hp, first]) => m === "get" && hp === p && /onlyEdit/.test(first)), `🔴 GET ${p} відкритий не лише рекрутеру`);
});

/* ═════════ ПРОХІД 1a (17.09.2026): гейти #520–#527 ═════════
 * Номери з запасом над #510 (найвищий у `main` і гілках на момент початку) — борг 17. */

/** Спільна фікстура: схема з нуля, дві команди, клієнт напряму (не пул). */
async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК · Дмитрук'),(2,'РНК · Безпамʼятний') ON CONFLICT DO NOTHING");
  return { c, db: c as unknown as import("./hiring.js").Db, done: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #520 — ВІДМОВА ЛИШЕ З ПРИЧИНОЮ. Загальна зміна статусу у «відмову» чи «чорний список» не веде;
 * чорний список — лише відмова компанії; тімлід відмовляє лише зі своїх етапів.
 * 🧨 Червоніє, якщо пустити відмову без причини, загальним переходом або кандидатською стороною в чорний список.
 */
test("#520 ВІДМОВА: без причини — ні; загальним переходом — ні; чорний список — лише відмова компанії", () => {
  assert.equal(refusalVerdict({ from: "planned", access: "edit", reasonSide: null, blacklist: false }).ok, false, "🔴 відмова без причини пройшла");
  assert.deepEqual(refusalVerdict({ from: "planned", access: "edit", reasonSide: "candidate", blacklist: false }), { ok: true, status: "refused" });
  assert.equal(refusalVerdict({ from: "done", access: "edit", reasonSide: "candidate", blacklist: true }).ok, false, "🔴 кандидатська відмова в чорний список");
  assert.deepEqual(refusalVerdict({ from: "done", access: "edit", reasonSide: "company", blacklist: true }), { ok: true, status: "black" });
  assert.equal(canTransition("planned", "refused", "edit", null).ok, false, "🔴 «відмова» пройшла загальним переходом без причини");
  assert.equal(canTransition("new", "black", "edit", null).ok, false, "🔴 «чорний список» пройшов загальним переходом");
  assert.equal(refusalVerdict({ from: "lead", access: "lead", reasonSide: "company", blacklist: false }).ok, true, "🔴 тімлід не може відмовити на своєму етапі");
  assert.equal(refusalVerdict({ from: "planned", access: "lead", reasonSide: "company", blacklist: false }).ok, false, "🔴 тімлід відмовив на етапі рекрутера");
  assert.equal(refusalVerdict({ from: "lead", access: "lead", reasonSide: "company", blacklist: true }).ok, false, "🔴 тімлід веде чорний список");
});

/**
 * #520b — ЖИВИЙ SQL ВІДМОВИ: причина задає сторону, подія пише причину, резерв — тією ж транзакцією;
 * повернення з відмови знімає поточну відмову з картки, а в історії вона лишається.
 */
test("#520b ЖИВИЙ SQL ВІДМОВИ: причина → сторона й подія; резерв разом; повернення знімає відмову з картки", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  try {
    const vac = await h.createVacancy(s.db, null, { title: "Менеджер з продажу (РНК)" });
    const id = await h.createCandidate(s.db, null, { fullName: "Білик Яна", phone: "0970000102", vacancyId: vac });
    const stavka = (await s.c.query("SELECT id FROM hiring_refusal_reasons WHERE side='candidate' AND label='Ставка'")).rows[0].id;
    await assert.rejects(h.refuseCandidate(s.db, null, id, {}, "edit", null), (e: { status?: number }) => e.status === 400, "🔴 відмова без причини збереглась");
    await assert.rejects(h.changeStatus(s.db, null, id, { to: "refused", comment: "так" }, "edit", null), (e: { status?: number }) => e.status === 403);
    await h.refuseCandidate(s.db, null, id, { reasonId: stavka, note: "хоче 25 тис.", reserve: true }, "edit", null);
    const row = (await s.c.query("SELECT status, refusal_side, refusal_reason_id, reserved_at IS NOT NULL AS res FROM hiring_candidates WHERE id=$1", [id])).rows[0];
    assert.deepEqual([row.status, row.refusal_side, row.refusal_reason_id, row.res], ["refused", "candidate", stavka, true], "🔴 відмова не записала сторону, причину чи резерв");
    const ev = (await s.c.query("SELECT comment FROM hiring_events WHERE candidate_id=$1 AND kind='status' AND to_status='refused'", [id])).rows;
    assert.ok(ev.length === 1 && ev[0].comment.includes("Ставка"), "🔴 в історії немає причини відмови");
    await h.changeStatus(s.db, null, id, { to: "planned", comment: "повернули з резерву" }, "edit", null);
    const back = (await s.c.query("SELECT status, refusal_reason_id FROM hiring_candidates WHERE id=$1", [id])).rows[0];
    assert.deepEqual([back.status, back.refusal_reason_id], ["planned", null], "🔴 повернення з відмови лишило відмову на картці");
  } finally { await s.done(); }
});

/**
 * #521 — ЛАНЦЮЖОК ПРОХОДУ 1a. «Перше повідомлення» між «новий» і «призначено»; старих `declined/nofit`
 * немає; кожен статус має рядок у мапі; тімлід не бачить етапів рекрутера.
 * 🧨 Червоніє, якщо повернути старі статуси, прибрати «перше повідомлення» або дати тімліду графік.
 */
test("#521 ЛАНЦЮЖОК: перше повідомлення, без старих статусів, тімлід — лише свої етапи", () => {
  assert.ok(TRANSITIONS.new.includes("contacted") && TRANSITIONS.contacted.includes("planned"), "🔴 «перше повідомлення» випало з ланцюжка");
  assert.ok(!(HIRING_STATUSES as readonly string[]).includes("declined") && !(HIRING_STATUSES as readonly string[]).includes("nofit"), "🔴 старі статуси повернулись");
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...HIRING_STATUSES].sort(), "🔴 статус без рядка в мапі переходів");
  assert.deepEqual(Object.keys(LEAD_TRANSITIONS).sort(), ["candidate", "lead", "training"], "🔴 тімлід отримав етапи рекрутера");
});

/**
 * #522 — ПЕРЕНОС СТАРИХ СТАТУСІВ І ПОСАД — ЖИВИЙ SQL, ПОВТОРНИЙ ПРОГІН СХЕМИ.
 * Рядки зі старими `declined/nofit` і «посадою» → повторна міграція → «відмова» (сторона лише там, де
 * статус її називав), подія зберігає старе значення, вакансія з посади й повʼязка; щоденний звіт за
 * той день ДО == ПІСЛЯ; третій прогін нічого не дублює.
 */
test("#522 ЖИВИЙ SQL: перенос declined/nofit і посад повторною міграцією, звіт не зсувається, ідемпотентно", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  try {
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    // стан «до проходу 1a»: старі статуси дозволені, маркера посад немає
    await s.c.query("ALTER TABLE hiring_candidates DROP CONSTRAINT hiring_candidates_status_check");
    await s.c.query("DELETE FROM hiring_migrations WHERE key='1a_positions'");
    const ins = async (name: string, status: string, pos: string) => (await s.c.query(
      "INSERT INTO hiring_candidates (full_name, status, position) VALUES ($1,$2,$3) RETURNING id", [name, status, pos])).rows[0].id as number;
    const a = await ins("Поліщук Матвій", "declined", "Сейлз РНК");
    const b = await ins("Шаповал Микола", "nofit", "Сейлз РНК");
    const c3 = await ins("Кушнір Олеся", "planned", "Бухгалтерія");
    await s.c.query("INSERT INTO hiring_events (candidate_id, kind, from_status, to_status, at) VALUES ($1,'status','done','lead','2026-09-10 12:00+03')", [c3]);
    const before = await h.dailyReport(s.db, "2026-09-10", "2026-09-10");

    await s.c.query(schema);
    const rows = (await s.c.query("SELECT id, status, refusal_side FROM hiring_candidates ORDER BY id")).rows;
    assert.deepEqual(rows.map((r) => [r.status, r.refusal_side]), [["refused", null], ["refused", "company"], ["planned", null]],
      "🔴 перенос статусів неправильний (сторона вигадана або статус не перенесено)");
    const moved = (await s.c.query("SELECT candidate_id, from_status FROM hiring_events WHERE to_status='refused' ORDER BY candidate_id")).rows;
    assert.deepEqual(moved.map((r) => [r.candidate_id, r.from_status]), [[a, "declined"], [b, "nofit"]], "🔴 подія переносу не зберегла старе значення");
    const vacs = (await s.c.query("SELECT v.position, count(cv.candidate_id)::int n FROM hiring_vacancies v LEFT JOIN hiring_candidate_vacancies cv ON cv.vacancy_id=v.id GROUP BY v.position ORDER BY v.position")).rows;
    assert.deepEqual(vacs.map((r) => [r.position, r.n]), [["Бухгалтерія", 1], ["Сейлз РНК", 2]], "🔴 вакансії з посад не створені чи не привʼязані");
    assert.deepEqual(await h.dailyReport(s.db, "2026-09-10", "2026-09-10"), before, "🔴 міграція зсунула щоденний звіт за минулий день");

    await ins("Новий Кандидат", "new", "Юрист"); // нова посада ПІСЛЯ маркера — вакансії не народжує
    await s.c.query(schema);
    assert.equal((await s.c.query("SELECT count(*)::int n FROM hiring_events WHERE to_status='refused'")).rows[0].n, 2, "🔴 повторна міграція задублювала події");
    assert.equal((await s.c.query("SELECT count(*)::int n FROM hiring_vacancies")).rows[0].n, 2, "🔴 посада після маркера створила вакансію");
  } finally { await s.done(); }
});

/**
 * #523 — ВАКАНСІЇ: лічильник == різні кандидати в повʼязках; кандидат на двох вакансіях — одна картка;
 * закриття лише з результатом, статус визначає результат; повернення знімає результат.
 */
test("#523 ВАКАНСІЇ: лічильник з повʼязок, одна картка на дві вакансії, закриття з результатом", async (t) => {
  assert.equal(vacancyCloseStatus("Успішно закрита"), "closed");
  assert.equal(vacancyCloseStatus("Скасував замовник"), "cancelled");
  assert.equal(vacancyCloseStatus(""), null, "🔴 закриття без результату");
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  try {
    const v1 = await h.createVacancy(s.db, null, { title: "РНК", need: 4 });
    const v2 = await h.createVacancy(s.db, null, { title: "РПК", need: 3 });
    await assert.rejects(h.createCandidate(s.db, null, { fullName: "Без Вакансії" }), (e: { status?: number }) => e.status === 400, "🔴 кандидат без вакансії створився з форми");
    const id = await h.createCandidate(s.db, null, { fullName: "Гнатюк Анастасія", phone: "0980000103", vacancyIds: [v1] });
    await h.setCandidateVacancies(s.db, null, id, [v1, v2]);
    await h.setCandidateVacancies(s.db, null, id, [v1, v2]); // повтор — без дублів
    assert.equal((await s.c.query("SELECT count(*)::int n FROM hiring_candidates")).rows[0].n, 1, "🔴 друга вакансія створила дубль кандидата");
    const list = await h.listVacancies(s.db, "active") as { id: number; candidates: number }[];
    assert.deepEqual(list.map((v) => v.candidates), [1, 1], "🔴 лічильник кандидатів вакансії не з повʼязок");
    await assert.rejects(h.updateVacancy(s.db, v2, { status: "closed" }), (e: { status?: number }) => e.status === 400, "🔴 вакансію закрито без результату");
    await h.updateVacancy(s.db, v2, { closeResult: "Скасував замовник" });
    assert.equal((await s.c.query("SELECT status FROM hiring_vacancies WHERE id=$1", [v2])).rows[0].status, "cancelled");
    await h.updateVacancy(s.db, v2, { status: "in_work" });
    const re = (await s.c.query("SELECT status, close_result, closed_on FROM hiring_vacancies WHERE id=$1", [v2])).rows[0];
    assert.deepEqual([re.status, re.close_result, re.closed_on], ["in_work", null, null], "🔴 повернення в роботу лишило результат закриття");
    await h.setCandidateVacancies(s.db, null, id, [v1]);
    assert.deepEqual((await h.listVacancies(s.db, "active") as { candidates: number }[]).map((v) => v.candidates), [1, 0], "🔴 прибрана вакансія лишилась у лічильнику");
  } finally { await s.done(); }
});

/**
 * #524 — РЕЗЕРВ І ФАЙЛИ СКАСОВНІ; ФАЙЛ ПІД БЕКАПОМ. Увімк./вимк. резерву повертає рядок до байта;
 * видалений файл не віддається, «відновити» повертає; тімлід чужої команди файл не бачить; імʼя на
 * диску — у КОРЕНІ теки документів (бекап копіює лише корінь).
 */
test("#524 РЕЗЕРВ І ФАЙЛИ: цикли скасовні, чужий не бачить, файл лягає туди, де його бере бекап", async (t) => {
  const stored = hiringStoredName("0f8fad5b-d9cb-469f-a165-70867728950e", "image/png");
  assert.match(stored, /^hiring-[0-9a-f-]+\.png$/, "🔴 імʼя файлу на диску не в корені або без префікса");
  const { copyDocuments } = await import("../jobs/backupDocuments.js");
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const src = mkdtempSync(path.join(tmpdir(), "hdocs-")), dst = mkdtempSync(path.join(tmpdir(), "hbak-"));
  try {
    writeFileSync(path.join(src, stored), "x");
    assert.equal(copyDocuments(src, dst).copied, 1);
    assert.ok(existsSync(path.join(dst, "documents", stored)), "🔴 файл-доказ не потрапляє в нічний бекап");
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
  const route = SRC("routes/hiring.ts");
  assert.match(route, /const DOCS_DIR = path\.join\(UPLOAD_DIR, "\.\.", "documents"\);/, "🔴 файли найму пишуться не в теку документів");

  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  try {
    const vac = await h.createVacancy(s.db, null, { title: "РНК" });
    const id = await h.createCandidate(s.db, null, { fullName: "Мазур Іванна", phone: "0500000106", vacancyId: vac });
    const snap = async () => (await s.c.query("SELECT row_to_json(c)::text j FROM hiring_candidates c WHERE id=$1", [id])).rows[0].j;
    const before = await snap();
    await h.setReserve(s.db, null, id, { on: true, note: "пів ставки" });
    assert.equal((await h.listCandidates(s.db, { reserve: "yes" }, "edit", null)).total, 1, "🔴 фільтр «У резерві» не бачить кандидата");
    await h.setReserve(s.db, null, id, { on: false });
    assert.equal(await snap(), before, "🔴 цикл резерву не повернув рядок до байта");

    const fid = await h.insertFile(s.db, null, id, { name: "переписка.png", storedName: stored, mime: "image/png", size: 10 });
    await h.fileForDownload(s.db, id, fid, "edit", null);
    await h.setFileDeleted(s.db, null, id, fid, true);
    await assert.rejects(h.fileForDownload(s.db, id, fid, "edit", null), (e: { status?: number }) => e.status === 404, "🔴 видалений файл віддається");
    await h.setFileDeleted(s.db, null, id, fid, false);
    await h.fileForDownload(s.db, id, fid, "edit", null);
    await assert.rejects(h.fileForDownload(s.db, id, fid, "lead", 2), (e: { status?: number }) => e.status === 404, "🔴 тімлід чужої команди бачить файл");
  } finally { await s.done(); }
});

/** #525 — ПОСИЛАННЯ «НАПИСАТИ»: з будь-якого запису номера — однакові; нік має пріоритет для Telegram; сміття — null. */
test("#525 МЕСЕНДЖЕРИ: один номер у різних форматах — однакові посилання; @нік і t.me/нік — один Telegram", () => {
  const a = messengerLinks("066 000 01 01", null), b = messengerLinks("+38 (066) 000-01-01", "");
  assert.deepEqual(a, b, "🔴 різний запис номера дав різні посилання");
  assert.equal(a.whatsapp, "https://wa.me/380660000101");
  assert.equal(a.viber, "viber://chat?number=%2B380660000101");
  assert.equal(messengerLinks("0660000101", "@yana_bilyk").telegram, "https://t.me/yana_bilyk");
  assert.equal(messengerLinks(null, "https://t.me/yana_bilyk").telegram, "https://t.me/yana_bilyk", "🔴 посилання t.me не розпізнано");
  assert.deepEqual(messengerLinks("123", "не нік!"), { telegram: null, viber: null, whatsapp: null }, "🔴 зі сміття зроблено посилання");
});

/** #526 — СКРИНШОТИ ПЕРЕПИСКИ ЗАКРИТІ ВІД МОДЕЛІ: REVOKE після GRANT і CREATE + FORBIDDEN_TABLES. */
test("#526 НАЙМ: hiring_files відібрана в ai_readonly після GRANT і CREATE і є в FORBIDDEN_TABLES", () => {
  const sql = SRC("db/schema.sql");
  const grantAt = sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;");
  const createAt = sql.indexOf("CREATE TABLE IF NOT EXISTS hiring_files (");
  assert.ok(grantAt > 0 && createAt > 0, "🔴 не знайдено GRANT або CREATE hiring_files");
  const ok = [...sql.matchAll(/REVOKE ALL ON ([^;]*?) FROM ai_readonly;/g)]
    .some((m) => /\bhiring_files\b/.test(m[1]) && m.index! > grantAt && m.index! > createAt);
  assert.ok(ok, "🔴 hiring_files не відібрана в ai_readonly після GRANT і CREATE");
  const list = /FORBIDDEN_TABLES\s*=\s*\[([\s\S]*?)\]/.exec(SRC("ai/metricTools.ts"));
  assert.ok(list && list[1].includes('"hiring_files"'), "🔴 hiring_files не в FORBIDDEN_TABLES");
});

/** #527 — ТИП ФАЙЛУ ЗА БАЙТАМИ, А НЕ ЗА СЛОВОМ КЛІЄНТА. */
test("#527 ФАЙЛИ: тип за першими байтами — PNG/JPG/WEBP/PDF так, виконуваний файл і текст — ні", () => {
  const b = (...x: number[]) => Uint8Array.from([...x, ...new Array(16).fill(0)]);
  assert.equal(sniffFileMime(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(sniffFileMime(b(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(sniffFileMime(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0])), "image/webp");
  assert.equal(sniffFileMime(b(0x25, 0x50, 0x44, 0x46, 0x2d)), "application/pdf");
  assert.equal(sniffFileMime(b(0x4d, 0x5a, 0x90, 0x00)), null, "🔴 виконуваний файл (MZ) пройшов");
  assert.equal(sniffFileMime(new TextEncoder().encode("image/png але насправді текст")), null, "🔴 текст пройшов як картинка");
});
