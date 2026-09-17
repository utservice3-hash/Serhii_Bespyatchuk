import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizePhone, hiringAccess, canTransition, cleanUrl, dailyTotals, attendancePct, validRange,
  type DailyRow,
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
  assert.equal(canTransition("black", "nofit", "edit", "nofit").ok, true, "🔴 помилковий «чорний список» не скасувати");
  assert.equal(canTransition("black", "planned", "edit", "nofit").ok, false, "🔴 «скасування» веде куди завгодно");
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
    const other = await h.createCandidate(db, null, { fullName: "Інший Кандидат", phone: "0660000202" });
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
  const LEAD_WRITES = new Set(["/candidates/:id/status", "/candidates/:id/comment"]);
  for (const [, method, p, first] of handlers) {
    const isWrite = method !== "get";
    const expected = isWrite && !LEAD_WRITES.has(p) ? /^onlyEdit\(req\)$/ : /^(onlyEdit\(req\)|const access = anyAccess\(req\))$/;
    assert.match(first.trim(), expected, `🔴 ${method.toUpperCase()} ${p}: першим стоїть «${first.trim()}»`);
  }
  for (const p of ["/schedule", "/daily"])
    assert.ok(handlers.some(([, m, hp, first]) => m === "get" && hp === p && /onlyEdit/.test(first)), `🔴 GET ${p} відкритий не лише рекрутеру`);
});
