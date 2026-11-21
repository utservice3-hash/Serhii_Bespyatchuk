import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tasksSetAtMeeting, type O2OTaskRow } from "../oneOnOne/meetingTasks.js";

/**
 * 🧷 #9991–#9993b — 1×1: ЗАПИСАНЕ НА ЗУСТРІЧІ НЕ ЗНИКАЄ ПІСЛЯ ПЕРЕЗАВАНТАЖЕННЯ (Сергій 19.11.2026: «зроби, щоб
 * відповідь, яка фіксується і записується, після перезавантаження сторінки нічого не зникало»).
 *
 * Заміряно в коді й на проді 19.11 (лише читання): рішення по задачах (`task_reviews`, 20 зустрічей) і задачі,
 * поставлені на зустрічі, лежать у базі, але на формі не показувались; рев'ю задачі посувало час запису, і браузерна
 * чернетка після цього не відновлювалась; місяць екран памʼятав назавжди.
 *
 * Правила ганяються СПРАВЖНІМИ модулями (бекенд — імпортом, фронт — транспіляцією на льоту), межі підключення —
 * по джерелу секції з вирізаними коментарями (той самий прийом, що `#140`/`#1761b`).
 */

const FE_ROOT = new URL("../../../frontend/src/", import.meta.url);
const SAVE_TS = fileURLToPath(new URL("pages/dashboard/sections/oneOnOneSave.ts", FE_ROOT));
const SECTION = fileURLToPath(new URL("pages/dashboard/sections/OneOnOneSection.tsx", FE_ROOT));
const ROUTE = fileURLToPath(new URL("./oneOnOnes.ts", import.meta.url).href.replace("/dist/", "/src/"));

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

type Review = { taskId: number; title: string; outcome: string; at: string; byName?: string | null };
async function loadSave(): Promise<{
  draftKey: (d: unknown) => string;
  draftToRestore: (stored: { at: string; draft: unknown; base?: string } | null, serverKey: string, serverUpdatedAt: string | null, now: Date) => unknown;
  parseStoredDraft: (raw: string | null) => { at: string; draft: unknown; base?: string } | null;
  selStillFresh: (at: string | null | undefined, now: Date) => boolean;
  SEL_FRESH_HOURS: number;
  reviewsOfMeeting: (r: readonly Review[] | null | undefined) => Review[];
}> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(SAVE_TS, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const row = (p: Partial<O2OTaskRow> & { id: number }): O2OTaskRow => ({
  title: `задача ${p.id}`, deadline: null, status: "not_started", o2o_resolution: null, created_by: 47, meeting_date: "2026-11-19", ...p,
});

/**
 * #9991 — «ПОСТАВЛЕНО НА ЦІЙ ЗУСТРІЧІ»: рівно цієї дати, і лише ті, що глядачу можна бачити.
 * Червоніє, якщо прибрати фільтр дати (задачі з інших зустрічей полізуть у цю), якщо тімлід побачить задачі,
 * поставлені іншим (межа історії 1×1), або якщо роут перестане віддавати поле в одній із двох гілок.
 */
test("#9991 1×1 ЗАДАЧІ ЗУСТРІЧІ: лише цієї дати; тімлід — свої, наскрізний — усі; роут віддає в обох гілках", () => {
  const rows = [
    row({ id: 3, meeting_date: "2026-11-19", created_by: 47 }),
    row({ id: 1, meeting_date: "2026-11-19", created_by: 104 }),
    row({ id: 2, meeting_date: "2026-11-18", created_by: 47 }),   // попередня зустріч — НЕ ця
    row({ id: 4, meeting_date: "2026-11-20", created_by: 47 }),   // наступна — теж НЕ ця
    row({ id: 5, meeting_date: null, created_by: 47 }),
  ];
  // 1. Дата — по обидва боки: сусідні дні не потрапляють.
  const own = tasksSetAtMeeting(rows, { date: "2026-11-19", viewerId: 47, crossview: false });
  assert.deepEqual(own.map((t) => t.id), [3], "🔴 тімлід бачить чужі задачі або задачі інших зустрічей");
  // 2. Наскрізний перегляд — усі задачі ЦІЄЇ зустрічі, у порядку постановки.
  const all = tasksSetAtMeeting(rows, { date: "2026-11-19", viewerId: 50, crossview: true });
  assert.deepEqual(all.map((t) => t.id), [1, 3], "🔴 наскрізний перегляд не бачить усіх задач зустрічі");
  // 3. 🪞 Дзеркало межі: автор бачить СВОЮ задачу (заборона без дозволу зеленіла б і на порожньому блоці).
  assert.deepEqual(tasksSetAtMeeting(rows, { date: "2026-11-19", viewerId: 104, crossview: false }).map((t) => t.id), [1]);
  // 4. Інша дата — інший набір (фільтр справді по даті, а не «будь-що непорожнє»).
  assert.deepEqual(tasksSetAtMeeting(rows, { date: "2026-11-18", viewerId: 47, crossview: false }).map((t) => t.id), [2]);
  // 5. Підсумок задачі доходить до екрана.
  const done = tasksSetAtMeeting([row({ id: 9, status: "done", o2o_resolution: "done" })], { date: "2026-11-19", viewerId: 47, crossview: false });
  assert.deepEqual(done[0], { id: 9, title: "задача 9", deadline: null, status: "done", resolution: "done" });

  // 6. Роут віддає поле І для наявного запису, І для порожнього шаблону (задачу ставлять і до збереження анкети).
  const route = stripComments(readFileSync(ROUTE, "utf8"));
  assert.equal((route.match(/tasks_set: await tasksSet\(\)/g) ?? []).length, 2, "🔴 /record віддає задачі зустрічі не в обох гілках");
  assert.match(route, /tasksSetAtMeeting\(\(await pool\.query<O2OTaskRow>\(/, "🔴 /record відбирає задачі повз tasksSetAtMeeting");
});

/**
 * #9992 — ЧЕРНЕТКА ПОВЕРТАЄТЬСЯ ПІСЛЯ РЕВ'Ю ЗАДАЧІ. Рев'ю пише в той самий запис і посуває його час, відповідей не
 * чіпаючи. Червоніє, якщо повернути правило «лише новіша за сервер» для чернетки, що знає свою базу.
 */
test("#9992 1×1 ЧЕРНЕТКА: рев'ю задачі посунуло час запису, відповіді ті самі — набране повертається", async () => {
  const { draftKey, draftToRestore, parseStoredDraft } = await loadSave();
  const server = { answers: { a1: { score: 7 } }, enpsScore: null, enpsReason: "", satisfaction: 6, notes: {} };
  const typed = { ...server, answers: { a1: { score: 7, text: "хоче перейти на міжнародку" } } };
  const now = new Date("2026-11-19T12:00:00Z");
  const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const sk = draftKey(server);
  // Набрав о 11:40, о 11:50 позначив задачу — сервер «новіший», а відповіді ті самі.
  assert.deepEqual(draftToRestore({ at: at(20), draft: typed, base: sk }, sk, at(10), now), typed,
    "🔴 рев'ю задачі зʼїло набране: чернетка не відновилась");
  // Запису ще не було — рев'ю створило кістяк із порожніми відповідями; база чернетки — теж порожня.
  const empty = { answers: {}, enpsScore: null, enpsReason: "", satisfaction: null, notes: {} };
  assert.deepEqual(draftToRestore({ at: at(20), draft: typed, base: draftKey(empty) }, draftKey(empty), at(10), now), typed,
    "🔴 кістяк запису від рев'ю зʼїв чернетку нової зустрічі");
  // `base` переживає запис у сховище й читання назад.
  assert.equal(parseStoredDraft(JSON.stringify({ at: at(20), draft: typed, base: sk }))?.base, sk, "🔴 база чернетки губиться в сховищі");
  // Секція пише базу — інакше правило вище ніколи не спрацює.
  const src = stripComments(readFileSync(SECTION, "utf8"));
  assert.match(src, /const base = serverDraft\.current \? draftKey\(serverDraft\.current\) : undefined;/, "🔴 секція не пише базу чернетки");
});

/**
 * #9992b — 🪞 ДЗЕРКАЛО: ЧЕРНЕТКА НЕ ЗАТИРАЄ ЧУЖЕ ЗБЕРЕЖЕННЯ. Якщо відповіді на сервері вже не ті, від яких почали
 * набирати, — хтось зберіг інше, і перемагає сервер, навіть коли чернетка новіша за часом. Червоніє, якщо базу
 * ігнорувати (тоді стара чернетка з цього компʼютера перезаписала б чужу роботу).
 */
test("#9992b 1×1 ЧЕРНЕТКА: відповіді на сервері змінились після початку набору — чернетка не підставляється", async () => {
  const { draftKey, draftToRestore } = await loadSave();
  const before = { answers: { a1: { score: 7 } }, enpsScore: null, enpsReason: "", satisfaction: 6, notes: {} };
  const otherSaved = { ...before, answers: { a1: { score: 9, text: "зберіг з іншого пристрою" } } };
  const typed = { ...before, answers: { a1: { score: 7, text: "мій незбережений текст" } } };
  const now = new Date("2026-11-19T12:00:00Z");
  const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  // Чернетка НОВІША за час запису — і однаково не перемагає: відповіді на сервері вже інші.
  assert.equal(draftToRestore({ at: at(5), draft: typed, base: draftKey(before) }, draftKey(otherSaved), at(30), now), null,
    "🔴 чернетка затерла відповіді, які хтось зберіг після початку набору");
  // Старі чернетки без бази — за старим правилом (сервер новіший → перемагає сервер).
  assert.equal(draftToRestore({ at: at(30), draft: typed }, draftKey(before), at(5), now), null, "🔴 стара чернетка без бази перемогла новіше збереження");
});

/**
 * #9993 — «НА ЦІЙ ЗУСТРІЧІ ВИРІШИЛИ ПО ЗАДАЧАХ» ВИДНО Й ПІСЛЯ ПЕРЕЗАВАНТАЖЕННЯ. Червоніє, якщо брати перше рішення
 * замість останнього (позначку змінили — показали б стару), дублювати задачу, або якщо секція перестане брати блок
 * із запису / оновлювати його після позначки.
 */
test("#9993 1×1 РІШЕННЯ ЗУСТРІЧІ: останнє по кожній задачі, без дублів; береться з запису й оновлюється після позначки", async () => {
  const { reviewsOfMeeting } = await loadSave();
  const r = (taskId: number, outcome: string, at: string): Review => ({ taskId, title: `t${taskId}`, outcome, at });
  const out = reviewsOfMeeting([
    r(7, "carried", "2026-11-19T10:00:00Z"),
    r(5, "done", "2026-11-19T10:05:00Z"),
    r(7, "done", "2026-11-19T10:10:00Z"),   // передумали: та сама задача — тепер «виконано»
  ]);
  assert.deepEqual(out.map((x) => [x.taskId, x.outcome]), [[5, "done"], [7, "done"]], "🔴 показано не останнє рішення або задача задвоїлась");
  assert.deepEqual(reviewsOfMeeting(null), []);
  assert.deepEqual(reviewsOfMeeting([null as unknown as Review, { title: "без id" } as unknown as Review]), [], "🔴 сміття в task_reviews ламає блок");

  const src = stripComments(readFileSync(SECTION, "utf8"));
  assert.match(src, /setReviews\(reviewsOfMeeting\(r\.task_reviews\)\); setTasksSet\(r\.tasks_set \?\? \[\]\);/, "🔴 блоки не беруться з запису зустрічі");
  assert.match(src, /reviewO2OTask\(id, outcome, dateSel\); await Promise\.all\(\[loadOpenTasks\(selId, dateSel\), loadMeetingExtras\(selId, dateSel\)\]\)/,
    "🔴 після позначки рішення не зʼявляється в блоці");
  assert.match(src, /setNewTask\(""\); setNewTaskDue\(""\);\s*await loadMeetingExtras\(selId, dateSel\);/, "🔴 поставлена задача не зʼявляється в блоці");
  assert.match(src, /\{reviews\.length > 0 && \(/, "🔴 блок рішень не рендериться");
  assert.match(src, /\{tasksSet\.length > 0 && \(/, "🔴 блок поставлених задач не рендериться");
});

/**
 * #9993b — ПІСЛЯ ПЕРЕЗАВАНТАЖЕННЯ — СЬОГОДНІ, А НЕ МІСЯЦЬ, ЯКИЙ КОЛИСЬ ГЛЯНУЛИ. Місце повертається лише свіжим.
 * Червоніє, якщо межу свіжості зсунути в будь-який бік, якщо запис без часу вважати свіжим, або якщо місяць знову
 * читатиметься зі сховища окремо від місця.
 */
test("#9993b 1×1 ВІДКРИТТЯ: свіже місце повертається, старе — ні; місяць окремо не памʼятається", async () => {
  const { selStillFresh, SEL_FRESH_HOURS } = await loadSave();
  const now = new Date("2026-11-19T12:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  assert.equal(SEL_FRESH_HOURS, 12);
  assert.equal(selStillFresh(ago(11.9), now), true, "🔴 щойно відкрите місце не повертається");
  assert.equal(selStillFresh(ago(12.1), now), false, "🔴 вчорашнє місце повертається — знову старий місяць");
  assert.equal(selStillFresh(undefined, now), false, "🔴 запис старого формату (без часу) вважається свіжим");
  assert.equal(selStillFresh("вчора", now), false);

  const src = stripComments(readFileSync(SECTION, "utf8"));
  assert.doesNotMatch(src, /getItem\("o2oMonth"\)/, "🔴 місяць знову читається зі сховища назавжди");
  assert.match(src, /&& selStillFresh\(v\.at, new Date\(\)\) \? v : null;/, "🔴 місце повертається без перевірки свіжості");
  assert.match(src, /date: dateSel, at: new Date\(\)\.toISOString\(\) \}\)/, "🔴 місце пишеться без часу — свіжість не перевірити");
});
