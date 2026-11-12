import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { promiseState, withOfflineMark, worstPromiseState, traceCounts, type CallFact, type TraceFact } from "./callAiPromise.js";
import { writeShare, isNoTrace, poolRows, checklist, hasAgreement, type ReportRowIn } from "./firstTouchTeamReport.js";
import { MONITORED_JOBS } from "../jobs/monitoredJobs.js";

/**
 * ✍️ ОБІЦЯНКА «НАПИШУ» ПЕРЕВІРЯЄТЬСЯ ЗА СЛІДОМ У CRM (задача 7240, ТЗ Юлі 30.10.2026).
 *
 * Дві помилки тут коштують по-різному. «Є слід», якого не було, — менеджер знову поза контролем (те, заради чого
 * задача). «Немає сліду», коли він є або коли ми ще НЕ ЗНАЄМО, — тімлід іде з претензією до людини, яка все зробила.
 * Тому гейти стоять по обидва боки терміну, по обидва боки «чия нотатка», і окремо на «синку ще не було».
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const MADE = new Date("2026-11-10T09:00:00Z"), DL = new Date("2026-11-10T09:20:00Z"), LATER = new Date("2026-11-11T00:00:00Z");
const at = (min: number) => new Date(MADE.getTime() + min * 60_000);
const tr = (min: number, kind: TraceFact["kind"], managerId?: number | null): TraceFact => ({ at: at(min), kind, managerId });
const call = (min: number, callType: string, billsec: number, managerId: number | null = 7): CallFact => ({ at: at(min), callType, billsec, managerId });
const st = (traces: TraceFact[], calls: CallFact[] = [], known = LATER, promiser: number | null = 7) =>
  promiseState({ channel: "message" }, MADE, DL, calls, known, promiser, traces);

test("#3911 🪞 СЛІД «НАПИШУ»: до терміну — є слід; після терміну чи до розмови — ні; нотатка лише того, хто обіцяв; синку ще не було — «чекає»", () => {
  assert.equal(st([tr(10, "note", 7)]), "kept_trace", "🔴 нотатка того, хто обіцяв, до терміну — не слід");
  assert.equal(st([tr(21, "note", 7)]), "no_trace", "🔴 нотатка ПІСЛЯ терміну зарахована як слід");
  assert.equal(st([tr(-5, "note", 7)]), "no_trace", "🔴 нотатка ДО розмови зарахована як слід");
  assert.equal(st([tr(10, "note", 8)]), "no_trace", "🔴 нотатка КОЛЕГИ закрила чужу обіцянку");
  assert.equal(st([tr(10, "note", null)]), "no_trace", "🔴 нотатка без відомого автора закрила обіцянку");
  assert.equal(st([tr(10, "note", 8)], [], LATER, null), "kept_trace", "🔴 обіцяльник невідомий — нотатку нема з ким звіряти, а її відкинуто");
  assert.equal(st([tr(10, "stage")]), "kept_trace", "🔴 зміна етапу до терміну — не слід (у ТЗ вона є)");
  assert.equal(st([tr(10, "screen")]), "kept_trace", "🔴 скрін переписки в угоді — не слід");
  assert.equal(st([], [call(10, "out", 0)]), "kept_trace", "🔴 вихідний дзвінок того, хто обіцяв (навіть спроба), — не слід");
  assert.equal(st([], [call(10, "out", 30, 8)]), "no_trace", "🔴 дзвінок колеги закрив чужу обіцянку написати");
  assert.equal(st([], [call(10, "in", 60)]), "no_trace", "🔴 вхідний дзвінок клієнта зарахований як наш слід");
  assert.equal(st([], [call(30, "out", 60)]), "no_trace", "🔴 дзвінок після терміну зарахований");
  // Ще не знаємо: синк не дійшов до терміну — «чекає», а не вирок.
  assert.equal(st([], [], at(5)), "pending", "🔴 до терміну вже «немає сліду»");
  assert.equal(st([], [], new Date(0)), "pending", "🔴 синку нотаток ще не було, а обіцянка вже «немає сліду» — порожня таблиця нічого не доводить");
  assert.equal(traceCounts(tr(1, "stage"), 7), true);
  // Дзвінки як були: обіцянка ПЕРЕДЗВОНИТИ слідом не закривається.
  assert.equal(promiseState({ channel: "call" }, MADE, DL, [], LATER, 7, [tr(10, "note", 7), tr(10, "stage")]), "broken", "🔴 нотатка закрила обіцянку передзвонити");
});

test("#3912 🪞 СТАН РЯДКА Й ПОЗНАЧКИ: «немає сліду» гірший за «запізнився»; ручна позначка його знімає, «є слід» не чіпає; чек-лист — як дзвінки", () => {
  assert.equal(worstPromiseState(["kept_trace", "no_trace", "late"]), "no_trace");
  assert.equal(worstPromiseState(["broken", "no_trace"]), "broken");
  assert.equal(worstPromiseState(["kept_trace", "unverifiable"]), "kept_trace");
  assert.equal(withOfflineMark("no_trace", true), "kept_offline", "🔴 «написав, позначив вручну» не знімає «немає сліду»");
  assert.equal(withOfflineMark("no_trace", false), "no_trace");
  assert.equal(withOfflineMark("kept_trace", true), "kept_trace", "🔴 позначка перебила вже знайдений слід");
  const r = (o: Partial<ReportRowIn>): ReportRowIn => ({ uniqueid: "u", calledAt: "2026-11-10T09:00:00Z", managerId: 7, managerName: "М", teamName: null,
    inReport: true, state: "done", priceDiscussed: true, promiseState: null, typeCheck: false, priceNote: null, missedNote: null, hasRequest: true, ...o });
  assert.equal(checklist(r({ promiseState: "kept_trace" }))?.promise, "y", "🔴 «є слід» не виконана обіцянка в чек-листі");
  assert.equal(checklist(r({ promiseState: "no_trace" }))?.promise, "n", "🔴 «немає сліду» не рахується невиконаною обіцянкою");
  assert.equal(checklist(r({ promiseState: "unverifiable" }))?.promise, "o");
  assert.deepEqual([isNoTrace(r({ promiseState: "no_trace" })), isNoTrace(r({ promiseState: "kept_trace" })), isNoTrace(r({ promiseState: "no_trace", state: "queued" }))],
    [true, false, false], "🔴 «немає сліду» рахується не там");
  assert.equal(hasAgreement(r({ promiseState: "no_trace" })), false, "🔴 обіцянка написати потрапила в «Домовленостей» (це колонка про передзвін)");
  const rows = [r({ uniqueid: "a", promiseState: "no_trace" }), r({ uniqueid: "b", promiseState: "kept_trace" }), r({ uniqueid: "c", promiseState: "broken" })];
  assert.deepEqual(poolRows(rows, "all", "noTrace").map((x) => x.uniqueid), ["a"], "🔴 фільтр «Немає сліду в CRM» бере не ті розмови");
});

test("#3913 🪞 ЧАСТКА «ОБІЦЯВ НАПИСАТИ»: від УСІХ обіцянок менеджера; без обіцянок — «немає», не нуль", () => {
  const r = (all: number, write: number): ReportRowIn => ({ uniqueid: "u", calledAt: "", managerId: 7, managerName: "М", teamName: null, inReport: true, state: "done",
    priceDiscussed: null, promiseState: null, typeCheck: false, priceNote: null, missedNote: null, managerPromises: all, managerWritePromises: write });
  assert.deepEqual(writeShare([r(2, 1), r(1, 0), r(1, 1)]), { promises: 4, writePromises: 2, writePct: 50 });
  assert.deepEqual(writeShare([r(3, 0)]), { promises: 3, writePromises: 0, writePct: 0 }, "🔴 менеджер без жодної обіцянки написати не дав чесного нуля");
  assert.deepEqual(writeShare([r(0, 0)]), { promises: 0, writePromises: 0, writePct: null }, "🔴 без обіцянок частка — нуль, а має бути «немає»");
  assert.equal(writeShare([r(3, 1)]).writePct, 33.3);
});

test("#3914 ПРОВОДКА 7240: сліди доходять до списку й картки; джоба нотаток під наглядом; підписи, фільтр і колонки на екрані", () => {
  const scr = src("backend/src/core/callAiScreen.ts");
  assert.match(scr, /traces\.get\(Number\(x\.kommo_id\)\) \?\? \[\], tracesKnown\)/, "🔴 список рахує обіцянки без слідів");
  assert.match(scr, /dealTraces, await tracesKnownUntil\(db, callsKnown\)\)/, "🔴 картка рахує обіцянки без слідів — розійдеться зі списком");
  assert.match(scr, /const known = mp\.channel === "message" \? tracesKnown : knownUntil;/, "🔴 «відомо до» для «напишу» — не за синком нотаток");
  assert.match(scr, /e\.created_by <> 0/, "🔴 нотатки роботів рахуються слідом менеджера");
  assert.match(scr, /c\.channel = 'kommo' AND c\.ai_kind = 'chat'/, "🔴 слідом рахується будь-яке фото з угоди, а не лише переписка");
  assert.match(src("backend/src/index.ts"), /cron\.schedule\("12,42 \* \* \* \*", \(\) => \{\s+if \(isKommoPaused\(\)\) return;\s+void runJob\("syncKommoNoteEvents"/, "🔴 джоба нотаток не в розкладі");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "syncKommoNoteEvents")?.everyMin, 30, "🔴 нагляд за джобою нотаток не збігається з кроном");
  const job = src("backend/src/jobs/syncKommoNoteEvents.ts");
  assert.match(job, /ON CONFLICT \(event_id\) DO NOTHING/, "🔴 повтор вікна двоїть нотатки");
  assert.match(job, /UPDATE sync_state SET kommo_note_events_at = \$1 WHERE id = 1/, "🔴 вотермарк нотаток не рухається");
  const view = src("frontend/src/pages/dashboard/aiCallsView.ts");
  assert.match(view, /no_trace: \{ label: "Немає сліду в CRM", tone: "warn"/, "🔴 новий стан без підпису");
  assert.match(view, /kept_trace: \{ label: "Є слід у CRM", tone: "ok"/);
  assert.match(view, /if \(f === "noTrace"\) return r\.promiseState === "no_trace";/, "🔴 фільтра «Немає сліду в CRM» у списку немає");
  const card = src("frontend/src/pages/dashboard/sections/FirstTouchReportCard.tsx");
  assert.match(card, /\{ key: "writePct", label: "Обіцяв написати, %"/, "🔴 колонки частки в таблиці менеджерів немає");
  assert.match(card, /\{ key: "noTrace", label: "Немає сліду в CRM", match: \(r\) => r\.flags\.noTrace === true \}/, "🔴 фільтра пулу для тімліда немає");
  assert.match(src("backend/src/routes/dashboard.ts"), /noTrace: ftNoTrace\(r\) \}/, "🔴 прапорець «немає сліду» не доходить до пулу");
});

// ── Живий SQL на scratch-кластері ───────────────────────────────────────────────────────────────
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });

test("#3915 🪞 ЖИВІ СЛІДИ: нотатка людини, зміна етапу, скрін-переписка й контакт із картки — так; нотатка робота, фото документа, чужа угода — ні", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  dispose = async () => { const { pool } = await import("../db/pool.js"); await pool.end(); await c.end(); scratch.dispose(); };
  await c.query(src("backend/src/db/schema.sql"));
  await c.query(`INSERT INTO managers (id, name, is_active, kommo_user_id) VALUES (7, 'М', true, 700)`);
  await c.query(`INSERT INTO deals (kommo_id, name, pipeline_id, status_id, price, client_key) VALUES (1, 'у', 8921932, 69693668, 0, 'k1'), (2, 'у2', 8921932, 69693668, 0, 'k2')`);
  const T = "2026-11-10T09:10:00Z";
  await c.query(`INSERT INTO kommo_note_events (event_id, lead_id, created_by, created_at) VALUES ('e1', 1, 700, $1), ('e2', 1, 0, $1), ('e3', 2, 700, $1)`, [T]);
  await c.query(`INSERT INTO deal_stage_events (kommo_id, pipeline_id, status_id, changed_at) VALUES (1, 8921932, 69693672, $1)`, [T]);
  await c.query(`INSERT INTO client_contacts (client_key, channel, kommo_note_id, kommo_deal_id, kommo_file_uuid, ai_status, ai_kind, created_at)
                 VALUES ('k1', 'kommo', 11, 1, 'f1', 'done', 'chat', $1), ('k1', 'kommo', 12, 1, 'f2', 'done', 'document', $1)`, [T]);
  await c.query(`INSERT INTO client_contacts (client_key, channel, note, created_at) VALUES ('k1', 'viber', 'написав', $1)`, [T]);
  const { tracesByDeal, tracesKnownUntil } = await import("./callAiScreen.js");
  const { pool } = await import("../db/pool.js");
  const m = await tracesByDeal(pool, [1], new Date("2026-11-10T09:00:00Z"));
  const kinds = (m.get(1) ?? []).map((x) => `${x.kind}:${String(x.managerId)}`).sort();
  assert.deepEqual(kinds, ["note:7", "screen:null", "screen:null", "stage:null"], "🔴 набір слідів угоди не той: робот, документ або чужа угода потрапили — або щось загубилось");
  assert.equal((await tracesByDeal(pool, [1], new Date("2026-11-10T09:30:00Z"))).size, 0, "🔴 сліди до початку вікна не відсічено");
  assert.equal((await tracesByDeal(pool, [], new Date(0))).size, 0);
  const callsKnown = new Date("2026-11-10T12:00:00Z");
  assert.equal((await tracesKnownUntil(pool, callsKnown)).getTime(), 0, "🔴 синку нотаток ще не було, а «відомо до» вже не нуль");
  await c.query(`INSERT INTO sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await c.query(`UPDATE sync_state SET kommo_note_events_at = '2026-11-10T11:00:00Z' WHERE id = 1`);
  assert.equal((await tracesKnownUntil(pool, callsKnown)).toISOString(), "2026-11-10T11:00:00.000Z", "🔴 «відомо до» — не раніший із двох синків");
  await c.query(`UPDATE sync_state SET kommo_note_events_at = '2026-11-10T13:00:00Z' WHERE id = 1`);
  assert.equal((await tracesKnownUntil(pool, callsKnown)).toISOString(), callsKnown.toISOString());
});
