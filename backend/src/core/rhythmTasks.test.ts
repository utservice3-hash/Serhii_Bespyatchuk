import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rhythmOf, workVerdict, TALK_MIN_SEC, type WorkFacts } from "./clientLeadRules.js";
import {
  planRhythmTasks, rhythmVerdict, targetFor, packTitle, closeReasonFor, episodeKey, RHYTHM_TASK_DAYS, RHYTHM_SKIPS,
  CLOSE_GONE, CLOSE_PACK, CLOSE_WITH_PACK,
  type ExistingRow, type OpenPack, type RhythmRow, type RhythmTargets,
} from "./rhythmTaskRules.js";

/**
 * ⏱ ЗАДАЧА 11229: ЗАДАЧА ТІМЛІДУ, КОЛИ ПОСТІЙНИЙ ПРОПУСТИВ СВІЙ РИТМ І З НИМ НЕ ПРАЦЮЮТЬ (рішення Романа 27.11.2026:
 * 3 календарні дні; клієнтів із вкладки «Реактивація» не брати). Назви клієнтів і людей у фікстурах вигадані.
 */
const SRC = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url).href.replace("/dist/", "/src/")), "utf8");
const FE = (p: string) => readFileSync(fileURLToPath(new URL(`../../../frontend/src/${p}`, import.meta.url).href.replace("/dist/", "/src/")), "utf8");

const TODAY = "2026-11-27";
/** Рядок екрана через СПРАВЖНІ правила ритму й роботи: звичайний інтервал 20 днів, сегмент «регулярний» (вікно 30 днів). */
function row(o: Partial<{ key: string; managerId: number; teamId: number | null; orderDays: number; median: number | null; off: boolean;
  work: WorkFacts; debt: boolean; tab: RhythmRow["tabGroup"]; problem: unknown; lastOrder: string }> = {}): RhythmRow {
  const orderDays = o.orderDays ?? 23;
  const off = o.off ?? false;
  const none: WorkFacts = { talk10: null, stage: null, comment: null, contact: null, payment: null };
  const managerId = o.managerId ?? 7;
  return {
    clientKey: o.key ?? "pryklad", clientName: `ТОВ ${o.key ?? "Приклад"}`, managerId, managerName: `Менеджер ${String(managerId)}`,
    teamId: o.teamId === undefined ? 1 : o.teamId, teamName: "Команда Зразок", debtHold: o.debt ?? false, tabGroup: o.tab ?? "yellow",
    lead: {
      lastOrder: o.lastOrder ?? "2026-11-04", orderDays,
      rhythm: rhythmOf(orderDays, o.median === undefined ? 20 : o.median, off),
      works: off ? { yes: true, by: "season", at: null } : workVerdict(o.work ?? none, "regular", TODAY),
      talk10: o.work?.talk10 ?? null, problem: o.problem ?? null,
    },
  };
}
const TARGETS: RhythmTargets = { leadByTeam: new Map([[1, 100]]), userByManager: new Map([[7, 70], [8, 100]]), headUserId: 900 };
const plan = (rows: RhythmRow[], existing: ExistingRow[] = [], packs: OpenPack[] = [], targets = TARGETS) =>
  planRhythmTasks({ rows, existing, packs, targets });

/**
 * #11264 — МЕЖА 3 КАЛЕНДАРНИХ ДНІВ, ПО ОБИДВА БОКИ. Звичайний інтервал 20 днів: на 22-й день (на 2 довше) задачі немає,
 * на 23-й (на 3 довше) є. У межах ритму й сезонний не в сезоні — ні. Ритм рахує `rhythmOf`, те саме, що колір на екрані.
 * 🧨 Червоніє, якщо поріг стане іншим (7 днів чи «одразу») або правило перестане читати ритм екрана.
 */
test("#11264 ПОРІГ 3 ДНІ: на 2 дні довше за звичайний інтервал — задачі немає, на 3 — є; у ритмі й не в сезоні — ні", () => {
  assert.equal(RHYTHM_TASK_DAYS, 3, "🔴 поріг — рішення Романа 27.11.2026, не міняється без нього");
  assert.deepEqual(rhythmVerdict(row({ orderDays: 22 })), { due: false, why: "days" }, "🔴 на 2 дні довше — уже задача");
  assert.deepEqual(rhythmVerdict(row({ orderDays: 23 })), { due: true }, "🔴 на 3 дні довше — задачі немає");
  assert.deepEqual(rhythmVerdict(row({ orderDays: 20 })), { due: false, why: "rhythm" }, "🔴 клієнт у своєму ритмі потрапив у задачу");
  assert.deepEqual(rhythmVerdict(row({ orderDays: 90, off: true })), { due: false, why: "rhythm" }, "🔴 сезонний не в сезоні потрапив у задачу");
  assert.deepEqual(rhythmVerdict(row({ orderDays: 90, median: null })), { due: false, why: "rhythm" }, "🔴 клієнт без відомого інтервалу потрапив у задачу");
  assert.match(packTitle("Менеджер Приклад", 4), /^⏱ Пропустили ритм, роботи немає 3 дні \(4\) — Менеджер Приклад$/, "🔴 назва задачі не каже порогу чи числа клієнтів");
});

/**
 * #11265 — РОБОТА ЗНІМАЄ КЛІЄНТА, А БОРЖНИК, ПРОБЛЕМНИЙ І «РЕАКТИВАЦІЯ» НЕ БЕРУТЬСЯ. «Робота» — вердикт екрана
 * (`workVerdict`, вікно сегмента): подія рівно на межі вікна — робота, на день раніше — ні. Поріг розмови 10 с тримає
 * живий SQL фактів (#3447: 9 с — ні, 10 с — так); тут — що правило читає саме цей вердикт. Кожне відсіювання має власну
 * причину, і перша з них — у порядку переліку.
 * 🧨 Червоніє, якщо задача піде по клієнту, з яким працюють, по боржнику, проблемному чи клієнту з «Реактивації».
 */
test("#11265 РОБОТА Й ВИНЯТКИ: розмова у вікні знімає клієнта, поза вікном — ні; боржник, проблемний і «Реактивація» не беруться", () => {
  assert.equal(TALK_MIN_SEC, 10, "🔴 розмова від 10 с — поріг роботи з клієнтом");
  const talk = (d: string): WorkFacts => ({ talk10: d, stage: null, comment: null, contact: null, payment: null });
  assert.deepEqual(rhythmVerdict(row({ work: talk("2026-10-28") })), { due: false, why: "work" }, "🔴 розмова на межі вікна (30 днів) не рахується роботою");
  assert.deepEqual(rhythmVerdict(row({ work: talk("2026-10-27") })), { due: true }, "🔴 розмова поза вікном знімає клієнта");
  assert.deepEqual(rhythmVerdict(row({ work: { talk10: null, stage: null, comment: "2026-11-20", contact: null, payment: null } })), { due: false, why: "work" }, "🔴 коментар не рахується роботою");
  assert.deepEqual(rhythmVerdict(row({ problem: { day: "2026-11-01" } })), { due: false, why: "problem" }, "🔴 проблемний клієнт у задачі");
  assert.deepEqual(rhythmVerdict(row({ debt: true })), { due: false, why: "debt" }, "🔴 боржник у задачі");
  assert.deepEqual(rhythmVerdict(row({ tab: "react" })), { due: false, why: "react" }, "🔴 клієнт із «Реактивації» у задачі (рішення Романа: не брати)");
  assert.deepEqual(rhythmVerdict(row({ tab: "regular" })), { due: true }, "🔴 вкладка «Постійні» знімає клієнта");
  assert.deepEqual(rhythmVerdict(row({ debt: true, tab: "react", problem: {} })), { due: false, why: "problem" }, "🔴 порядок причин змінився");
  assert.deepEqual([...RHYTHM_SKIPS], ["rhythm", "days", "work", "problem", "debt", "react"], "🔴 перелік причин змінився");
  // Відсіяне назване числом: кожен рядок або підпадає, або має рівно одну причину.
  const s = plan([row({ key: "a" }), row({ key: "b", orderDays: 22 }), row({ key: "c", debt: true }), row({ key: "d", tab: "react" }), row({ key: "e", work: talk("2026-11-26") })]).stats;
  assert.deepEqual([s.onScreen, s.due, s.skipped], [5, 1, { rhythm: 0, days: 1, work: 1, problem: 0, debt: 1, react: 1 }], "🔴 відсіяні не названі числом");
  assert.equal(s.due + Object.values(s.skipped).reduce((x, y) => x + y, 0), s.onScreen, "🔴 частини не дають цілого");
});

/**
 * #11266 — ОДНА ЗАДАЧА НА МЕНЕДЖЕРА, РЯДОК НА КЛІЄНТА, БЕЗ ДУБЛІВ. Перший прохід: задача на менеджера з усіма його
 * клієнтами. Другий прохід на тих самих даних — нічого нового. Новий клієнт — рядком у відкриту задачу. Той самий пропуск
 * удруге не ставиться, навіть коли рядок закрито; нове замовлення і новий пропуск — новий рядок.
 * 🧨 Червоніє, якщо прибрати перевірку наявних рядків (дублі щоранку) чи ставити по задачі на клієнта.
 */
test("#11266 БЕЗ ДУБЛІВ: одна задача на менеджера; другий прохід нічого не додає; новий клієнт — рядком; той самий пропуск удруге не ставиться", () => {
  const a = row({ key: "a" }), b = row({ key: "b" }), other = row({ key: "c", managerId: 9 });
  const first = plan([a, b, other]);
  assert.deepEqual(first.create.map((c) => [c.managerId, c.userId, c.rows.map((r) => r.clientKey)]), [[7, 100, ["a", "b"]], [9, 100, ["c"]]], "🔴 не одна задача на менеджера з його клієнтами");
  assert.deepEqual([first.add, first.closeRows, first.closePacks], [[], [], []], "🔴 перший прохід щось закрив чи додав");
  const ex = (id: number, key: string, o: Partial<ExistingRow> = {}): ExistingRow =>
    ({ id, packId: 50, packOpen: true, open: true, clientKey: key, managerId: 7, lastOrder: "2026-11-04", ...o });
  const pack: OpenPack = { id: 50, managerId: 7, assigneeUserId: 100, title: packTitle("Менеджер 7", 2), via: "lead" };
  const second = plan([a, b], [ex(1, "a"), ex(2, "b")], [pack]);
  assert.deepEqual([second.create, second.add, second.closeRows, second.closePacks, second.update], [[], [], [], [], []], "🔴 другий прохід на тих самих даних щось змінив");
  assert.deepEqual([second.stats.due, second.stats.covered, second.refresh.map((r) => r.id)], [2, 2, [1, 2]], "🔴 наявні рядки не впізнано");
  const third = plan([a, b, row({ key: "new" })], [ex(1, "a"), ex(2, "b")], [pack]);
  assert.deepEqual([third.create, third.add.map((x) => [x.packId, x.rows.map((r) => r.clientKey)])], [[], [[50, ["new"]]]], "🔴 новий клієнт не рядком у відкриту задачу");
  assert.deepEqual(third.update.map((u) => u.title), [packTitle("Менеджер 7", 3)], "🔴 число клієнтів у назві не оновлено");
  // Рядок закрито (тімлідом чи сам), роботи так і немає: той самий пропуск удруге не ставимо.
  const closed = plan([a], [ex(1, "a", { open: false, packOpen: false })], []);
  assert.deepEqual([closed.create, closed.add, closed.stats.covered], [[], [], 1], "🔴 закритий рядок повернувся наступного ранку");
  // Клієнт замовив і знову пропустив ритм — це новий пропуск.
  const again = plan([row({ key: "a", lastOrder: "2026-11-10" })], [ex(1, "a", { open: false, packOpen: false })], []);
  assert.deepEqual(again.create.map((c) => c.rows.map((r) => r.clientKey)), [["a"]], "🔴 новий пропуск ритму не дав рядка");
  assert.notEqual(episodeKey("a", 7, "2026-11-04"), episodeKey("a", 8, "2026-11-04"), "🔴 пропуск не розрізняє менеджера");
});

/**
 * #11267 — РЯДОК ЗАКРИВАЄТЬСЯ САМ ІЗ ВЛАСНОЮ ПРИЧИНОЮ, ЗАДАЧА — КОЛИ ЗАКРИТІ ВСІ РЯДКИ. Попрацювали — «попрацювали
 * (розмова 26.11)»; клієнт замовив — «замовив 25.11»; перейшов у «Реактивацію», зник зі списку, задачу закрили — кожне
 * своїми словами. Поки є хоч один відкритий рядок, задача стоїть.
 * 🧨 Червоніє, якщо рядок не закривається, коли з'явилась робота, якщо причини злити в одну, чи якщо задача закриється
 * з відкритим рядком (або не закриється без жодного).
 */
test("#11267 АВТОЗАКРИТТЯ: рядок — із власною причиною (попрацювали, замовив, реактивація, зник зі списку); задача — коли закриті всі рядки", () => {
  const talk: WorkFacts = { talk10: "2026-11-26", stage: null, comment: null, contact: null, payment: null };
  const ex = (id: number, key: string, o: Partial<ExistingRow> = {}): ExistingRow =>
    ({ id, packId: 50, packOpen: true, open: true, clientKey: key, managerId: 7, lastOrder: "2026-11-04", ...o });
  const pack: OpenPack = { id: 50, managerId: 7, assigneeUserId: 100, title: packTitle("Менеджер 7", 5), via: "lead" };
  const rows = [row({ key: "worked", work: talk }), row({ key: "ordered", orderDays: 2, lastOrder: "2026-11-25" }),
    row({ key: "react", tab: "react" }), row({ key: "still" })];
  const p = plan(rows, [ex(1, "worked"), ex(2, "ordered"), ex(3, "react"), ex(4, "gone"), ex(5, "still")], [pack]);
  assert.deepEqual(p.closeRows, [
    { id: 1, reason: "Закрито автоматично: з клієнтом попрацювали (розмова 26.11)." },
    { id: 2, reason: "Закрито автоматично: клієнт замовив 25.11." },
    { id: 3, reason: "Закрито автоматично: клієнт перейшов у «Реактивацію»." },
    { id: 4, reason: CLOSE_GONE },
  ], "🔴 причини автозакриття не ті чи злиті в одну");
  assert.deepEqual([p.refresh.map((r) => r.id), p.closePacks], [[5], []], "🔴 задача закрита з відкритим рядком, або відкритий рядок не оновлено");
  assert.equal(closeReasonFor(row({ key: "still" }), "2026-11-04"), null, "🔴 рядок, що далі підпадає, закривається");
  const last = plan([row({ key: "worked", work: talk })], [ex(1, "worked"), ex(2, "x", { open: false })], [pack]);
  assert.deepEqual(last.closePacks, [{ id: 50, reason: CLOSE_PACK }], "🔴 задача без відкритих рядків не закрилась");
  // Тімлід закрив саму задачу — її відкриті рядки закриваються разом із нею, а не висять.
  const byLead = plan([row({ key: "still" })], [ex(5, "still", { packOpen: false })], []);
  assert.deepEqual(byLead.closeRows, [{ id: 5, reason: CLOSE_WITH_PACK }], "🔴 рядок закритої задачі лишився відкритим");
});

/**
 * #11268 — КОМУ ЙДЕ ЗАДАЧА. Тімліду команди менеджера. У менеджера немає команди чи тімліда, або він сам тімлід —
 * керівнику відділу продажу. Немає й керівника — нікому, і це назване числом, а не тиша. Відкрита задача їде за
 * сьогоднішнім тімлідом.
 * 🧨 Червоніє, якщо клієнти менеджера без тімліда зникнуть, або тімлід отримає задачу про самого себе.
 */
test("#11268 КОМУ: тімліду команди; без тімліда чи сам тімлід — керівнику відділу продажу; нікому — назване числом", () => {
  assert.deepEqual(targetFor(7, 1, TARGETS), { userId: 100, via: "lead" }, "🔴 не тімліду команди");
  assert.deepEqual(targetFor(7, null, TARGETS), { userId: 900, via: "head" }, "🔴 менеджер без команди — не керівнику відділу продажу");
  assert.deepEqual(targetFor(7, 2, TARGETS), { userId: 900, via: "head" }, "🔴 команда без тімліда — не керівнику відділу продажу");
  assert.deepEqual(targetFor(8, 1, TARGETS), { userId: 900, via: "head" }, "🔴 тімлід отримав задачу про самого себе");
  assert.equal(targetFor(7, null, { ...TARGETS, headUserId: null }), null, "🔴 без тімліда й керівника задача комусь пішла");
  const none = plan([row({ teamId: null })], [], [], { ...TARGETS, headUserId: null });
  assert.deepEqual([none.create, none.stats.due, none.stats.noTarget], [[], 1, 1], "🔴 клієнт без адресата зник без числа");
  const head = plan([row({ teamId: null })]);
  assert.deepEqual(head.create.map((c) => [c.userId, c.via]), [[900, "head"]], "🔴 без тімліда задача не керівнику відділу продажу");
  // Тімліда команди змінили: відкрита задача переїжджає до нового.
  const pack: OpenPack = { id: 50, managerId: 7, assigneeUserId: 55, title: packTitle("Менеджер 7", 1), via: "lead" };
  const moved = plan([row()], [{ id: 1, packId: 50, packOpen: true, open: true, clientKey: "pryklad", managerId: 7, lastOrder: "2026-11-04" }], [pack]);
  assert.deepEqual(moved.update.map((u) => [u.packId, u.userId]), [[50, 100]], "🔴 задача лишилась у попереднього тімліда");
});

async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  try {
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  } catch (e) { await c.end().catch(() => undefined); scratch.dispose(); throw e; }
  return { c, dispose: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #11269 — ЖИВИЙ SQL: ДВА ПРОХОДИ ПОСПІЛЬ ДАЮТЬ ОДНУ ЗАДАЧУ. Перший прохід: задача тімліду (виконавець-акаунт, без
 * менеджера-виконавця) і рядок на клієнта з ключем клієнта. Другий на тих самих даних — ті самі рядки. Робота з'явилась —
 * рядок закрито з причиною й записом у журналі статусів; останній рядок — закрито й задачу. Порожній список клієнтів —
 * відмова, і нічого не змінено. Задачі не KPI і не реактивація: їх не бачать ні Звіт, ні автозакриття «клієнт повернувся».
 * 🧨 Червоніє, якщо другий прохід плодить дублі, порожнє читання екрана закриває всі рядки, чи тип задач зіллється з KPI
 * або реактивацією.
 */
test("#11269 ЖИВИЙ SQL: два проходи — одна задача й ті самі рядки; робота закриває рядок і задачу; порожній список — відмова без змін", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { sweepRhythmTasks } = await import("../jobs/rhythmTaskSweep.js");
  const db = c as unknown as import("./adCallFacts.js").Db;
  const snap = async () => (await c.query<{ type: string; status: string; n: number }>(
    `SELECT task_type AS type, status, count(*)::int AS n FROM tasks GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  try {
    await c.query(`INSERT INTO teams (id, name) VALUES (1, 'Команда Зразок')`);
    await c.query(`INSERT INTO managers (id, name, kommo_user_id, is_active, team_id) VALUES (7, 'Менеджер 7', 707, true, 1), (8, 'Тімлід Зразок', 708, true, 1)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, manager_id, team_id) VALUES
      (70, 'm7@example.test', 'x', 'manager', 7, 1), (100, 'lead@example.test', 'x', 'team_lead', 8, 1)`);
    const a = row({ key: "a" }), b = row({ key: "b" });
    const r1 = await sweepRhythmTasks(db, [a, b]);
    assert.deepEqual([r1.packsCreated, r1.rowsAdded, r1.rowsClosed, r1.packsClosed], [1, 2, 0, 0], "🔴 перший прохід");
    assert.deepEqual(await snap(), [{ type: "rhythm_client", status: "not_started", n: 2 }, { type: "rhythm_pack", status: "not_started", n: 1 }], "🔴 не одна задача з двома рядками");
    const shape = (await c.query(`SELECT count(*) FILTER (WHERE assignee_user_id = 100)::int AS lead, count(*) FILTER (WHERE assignee_id IS NOT NULL OR auto)::int AS kpi,
      count(*) FILTER (WHERE task_type = 'rhythm_client' AND client_key IS NOT NULL AND parent_id IS NOT NULL)::int AS kids FROM tasks`)).rows[0];
    assert.deepEqual(shape, { lead: 3, kpi: 0, kids: 2 }, "🔴 виконавець не тімлід, або задача схожа на KPI, або рядок без клієнта чи батька");
    const r2 = await sweepRhythmTasks(db, [a, b]);
    assert.deepEqual([r2.packsCreated, r2.rowsAdded, r2.rowsClosed, r2.packsClosed, r2.stats.covered], [0, 0, 0, 0, 2], "🔴 другий прохід щось додав чи закрив");
    assert.deepEqual(await snap(), [{ type: "rhythm_client", status: "not_started", n: 2 }, { type: "rhythm_pack", status: "not_started", n: 1 }], "🔴 другий прохід наплодив дублів");
    await assert.rejects(sweepRhythmTasks(db, []), /список постійних клієнтів порожній/, "🔴 порожній список клієнтів прийнято");
    assert.deepEqual(await snap(), [{ type: "rhythm_client", status: "not_started", n: 2 }, { type: "rhythm_pack", status: "not_started", n: 1 }], "🔴 відмова змінила задачі");
    const talk: WorkFacts = { talk10: "2026-11-26", stage: null, comment: null, contact: null, payment: null };
    const r3 = await sweepRhythmTasks(db, [row({ key: "a", work: talk }), b]);
    assert.deepEqual([r3.rowsClosed, r3.packsClosed], [1, 0], "🔴 рядок із роботою не закрито, або задачу закрито з відкритим рядком");
    const closed = (await c.query(`SELECT t.close_reason, t.closed_at IS NOT NULL AS at, (SELECT count(*)::int FROM task_status_log l WHERE l.task_id = t.id AND l.to_status = 'done') AS log
      FROM tasks t WHERE t.client_key = 'a'`)).rows[0];
    assert.deepEqual(closed, { close_reason: "Закрито автоматично: з клієнтом попрацювали (розмова 26.11).", at: true, log: 1 }, "🔴 закриття без причини, дати чи запису в журналі");
    const r4 = await sweepRhythmTasks(db, [row({ key: "a", work: talk }), row({ key: "b", work: talk })]);
    assert.deepEqual([r4.rowsClosed, r4.packsClosed, r4.packsCreated], [1, 1, 0], "🔴 останній рядок закрито, а задачу ні");
    assert.deepEqual(await snap(), [{ type: "rhythm_client", status: "done", n: 2 }, { type: "rhythm_pack", status: "done", n: 1 }], "🔴 лишились відкриті");
    // Роботи знову немає (вікно минуло), пропуск той самий — нової задачі немає.
    const r5 = await sweepRhythmTasks(db, [a, b]);
    assert.deepEqual([r5.packsCreated, r5.rowsAdded, r5.stats.covered], [0, 0, 2], "🔴 той самий пропуск поставлено вдруге");
  } finally { await s.dispose(); }
});

/**
 * #11270 — ПРОВОДКА. Прохід щодня о 08:12 за Києвом, на старті й під наглядом із добовим інтервалом; рядки бере ЗБИРАЧ
 * ЕКРАНА «З ким говорити» по всій компанії (другої копії правила ритму й роботи немає); читання наявних задач і запис —
 * однією транзакцією під замком. Типи задач свої: реактивація й KPI їх не читають. Екран задачника показує клієнтів
 * рядками і в списку, і в картці задачі (у новому вигляді рядків-дітей у списку не видно).
 * 🧨 Червоніє, якщо розвести розклад і нагляд, порахувати правило власним запитом, чи загубити рядки клієнтів на екрані.
 */
test("#11270 ПРОВОДКА: 08:12 щодня, старт і нагляд; рядки — зі збирача екрана по всій компанії; свої типи задач; клієнти видні в списку й картці", () => {
  const idx = SRC("index.ts");
  assert.match(idx, /cron\.schedule\("12 8 \* \* \*", \(\) => \{\n\s*void runJob\("rhythmTaskSweep", \(\) => runRhythmTaskSweep\(rhythmRowsNow\)\);\n\}, \{ timezone: "Europe\/Kyiv" \}\);/, "🔴 розкладу немає або він не за Києвом");
  assert.match(idx, /\["rhythmTaskSweep", \(\) => runRhythmTaskSweep\(rhythmRowsNow\)\]/, "🔴 немає стартового проходу — рестарт о 08:12 пропустить день");
  assert.match(SRC("jobs/monitoredJobs.ts"), /\{ name: "rhythmTaskSweep", everyMin: 1440,/, "🔴 нагляд не з добовим інтервалом");
  const dash = SRC("routes/dashboard.ts");
  assert.match(dash, /export async function rhythmRowsNow\(\): Promise<RhythmRow\[\]> \{\n\s*return \(await buildClientPlans\(kyivToday\(\)\.slice\(0, 7\), null, null, true, \{ canSee: false, canTake: false \}\)\)\.clients;/,
    "🔴 рядки для задачі — не зі збирача екрана або не по всій компанії");
  const rules = SRC("core/rhythmTaskRules.ts"), job = SRC("jobs/rhythmTaskSweep.ts");
  assert.doesNotMatch(rules + job, /pastOwnRhythm|workVerdict\(|ringostat_calls|FROM deals/, "🔴 правило ритму чи роботи пораховано другим кодом");
  assert.match(job, /await db\.query\("BEGIN"\);\n\s*try \{\n\s*await db\.query\("SELECT pg_advisory_xact_lock\(\$1\)", \[SWEEP_LOCK\]\);/, "🔴 читання й запис не під одним замком — два проходи дадуть дубль");
  assert.match(rules, /RHYTHM_PACK_TYPE = "rhythm_pack";\nexport const RHYTHM_CLIENT_TYPE = "rhythm_client";/, "🔴 типи задач змінились");
  // Лише код: коментарі проходу якраз і кажуть, чого він не чіпає.
  const jobCode = job.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(jobCode, /INSERT INTO tasks/, "🔴 від коду проходу нічого не лишилось — перевіряти нема чого");
  assert.doesNotMatch(jobCode, /'reactivation|kpi_period|daily_kpi|\bauto\b|telegram/i, "🔴 прохід чіпає реактивацію, KPI чи Telegram");
  for (const f of ["core/reactivation.ts", "core/reactivationClose.ts", "jobs/evaluateKpiTasks.ts", "core/plans.ts"]) {
    assert.doesNotMatch(SRC(f), /rhythm_(pack|client)/, `🔴 ${f} читає задачі тімліда про ритм`);
  }
  const fe = FE("pages/dashboard/sections/TasksSection.tsx");
  assert.match(fe, /task\.taskType === "rhythm_pack" && \(\s*<div[^>]*>\s*<RhythmPackRows pack=\{task\} kids=\{childrenOf\(task\.id\)\}/, "🔴 у списку задач клієнтів не видно");
  assert.match(fe, /openTask\.taskType === "rhythm_pack" && \([\s\S]{0,400}<RhythmPackRows pack=\{openTask\} kids=\{tasks\.filter\(\(t\) => t\.parentId === openTask\.id\)\}/, "🔴 у картці задачі клієнтів не видно");
  const rowsFe = FE("pages/dashboard/sections/RhythmPackRows.tsx");
  assert.match(rowsFe, /k\.closeReason \? shortReason\(k\.closeReason\) : "закрито вручну"/, "🔴 причини закриття рядка не видно");
  assert.match(rowsFe, /f\.usualDays != null \? `зазвичай раз на \$\{f\.usualDays\} дн\.` : "звичайний інтервал невідомий"/, "🔴 невідомий інтервал не названо словами");
});
