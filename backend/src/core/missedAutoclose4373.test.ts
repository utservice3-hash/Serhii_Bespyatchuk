import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsDb } from "../testMode.js";

/**
 * 📵 ЗАДАЧА 4373 «АВТОЗАКРИТТЯ ПРОПУЩЕНИХ», БЛОК 2 (ТЗ Юлії 17.09.2026; рішення Романа 02.10.2026).
 *
 * Правило ТЗ: «якщо по Ringostat з будь-якого номера компанії є вихідний на цей номер після пропущеного
 * і розмова від 10 секунд — задача закривається сама… Не закривати, якщо вихідний без зʼєднання або
 * коротший 10 секунд, або був раніше за пропущений». Норматив «передзвон» рахується до ПЕРШОГО УСПІШНОГО
 * вихідного. Висячих задач по передзвонених — 0 (тому межі давності 7 днів більше немає).
 *
 * Поведінку ганяємо на СВОЄМУ порожньому кластері (як `#457`), з керованим «зараз»: кожне твердження —
 * з обох боків межі (9 с / 10 с, до / після пропущеного, 0 с як спроба).
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const D = "2026-09-15"; // вівторок

type Client = { query<R = Record<string, unknown>>(q: string, p?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>; end(): Promise<void> };
let ready: Promise<Client | string> | null = null;
/** Один кластер на файл: схема з нуля один раз, кожен гейт — на своїх номерах. */
function db(): Promise<Client | string> {
  ready ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const scratch = provisionScratch();
    if ("unavailable" in scratch) return skipReason(scratch);
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: scratch.url });
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES (1,'Яцик',1,true),(2,'Дмитрук',1,true) ON CONFLICT DO NOTHING`);
    return c as unknown as Client;
  })();
  return ready;
}
after(async () => { const c = await ready; if (c && typeof c !== "string") await c.end(); });

let seq = 0;
const call = (c: Client, at: string, type: string, disp: string | null, sec: number, mgr: number | null, phone: string, fio: string | null = null) =>
  c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,manager_id,client_phone,employee_fio)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [`x${String(++seq)}`, at, type, disp, sec, mgr, phone, fio]);
const taskOf = async (c: Client, phone: string) => (await c.query<{ id: number; status: string; close_reason: string | null; description: string }>(
  "SELECT id, status, close_reason, description FROM tasks WHERE title LIKE $1 ORDER BY id", [`%+${phone}`])).rows;

test("#1300 ЗАКРИВАЄ ЛИШЕ РОЗМОВА ВІД 10 С ПІСЛЯ ПРОПУЩЕНОГО: 0 с і 9 с — спроби, дзвінок «до» — не передзвін", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { applyMissedCallSignals } = await import("./missedCallSignal.js");
  const tick = (at: string) => applyMissedCallSignals(c, new Date(at));
  const A = "380671300001", B = "380671300002";
  await call(c, `${D} 09:50:00+03`, "out", "ANSWERED", 30, 1, B);        // розмова ДО пропущеного
  await call(c, `${D} 10:00:00+03`, "in", "NO ANSWER", 0, 1, A);
  await call(c, `${D} 10:00:00+03`, "in", "NO ANSWER", 0, 1, B);
  await tick(`${D} 10:05:00+03`);
  assert.equal((await taskOf(c, A)).length, 1);
  assert.equal((await taskOf(c, B)).length, 1, "🔴 розмова ДО пропущеного погасила сигнал — ТЗ: «або був раніше за пропущений»");

  await call(c, `${D} 10:06:00+03`, "out", "NO ANSWER", 0, 1, A);         // без зʼєднання
  await call(c, `${D} 10:07:00+03`, "out", "ANSWERED", 9, 1, A);          // коротше 10 с
  await tick(`${D} 10:08:00+03`);
  assert.equal((await taskOf(c, A))[0].status, "not_started", "🔴 задачу закрила спроба (0 с / 9 с), а не передзвін — ТЗ: лише розмова від 10 с");
  await call(c, `${D} 10:09:00+03`, "out", "ANSWERED", 10, 2, A);         // рівно 10 с — межа включно
  const s = await tick(`${D} 10:10:00+03`);
  assert.equal(s.closed, 1, "🔴 розмова рівно 10 с не закрила задачу — межа «від 10 с» включна");
  assert.equal((await taskOf(c, A))[0].status, "done");
  assert.equal((await taskOf(c, B))[0].status, "not_started", "🔴 розмова ДО пропущеного закрила задачу");
});

test("#1300b ВИСЯЧИХ ПО ПЕРЕДЗВОНЕНИХ — 0: задачу 20-денної давності закриває передзвін від 10 с", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { applyMissedCallSignals } = await import("./missedCallSignal.js");
  const P = "380671300010";
  await call(c, "2026-08-26 10:00:00+03", "in", "NO ANSWER", 0, 1, P);
  await applyMissedCallSignals(c, new Date("2026-08-26 10:05:00+03"));
  assert.equal((await taskOf(c, P)).length, 1);
  await call(c, `${D} 11:00:00+03`, "out", "ANSWERED", 30, null, P, "Петренко Іван");
  await applyMissedCallSignals(c, new Date(`${D} 11:01:00+03`));
  const [x] = await taskOf(c, P);
  assert.equal(x.status, "done", "🔴 задачу старшу за тиждень не закрито передзвоном — повернулась межа давності, а критерій ТЗ «висячих 0»");
});

test("#1300c СПРОБА 0 С НЕ ГАСИТЬ СИГНАЛ: набрали й не додзвонились — задача однаково ставиться", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { applyMissedCallSignals } = await import("./missedCallSignal.js");
  const P = "380671300020", Q = "380671300021";
  await call(c, `${D} 12:00:00+03`, "in", "NO ANSWER", 0, 1, P);
  await call(c, `${D} 12:02:00+03`, "out", "NO ANSWER", 0, 1, P);         // спроба в межах 5 хв
  await call(c, `${D} 12:00:00+03`, "in", "NO ANSWER", 0, 1, Q);
  await call(c, `${D} 12:02:00+03`, "out", "ANSWERED", 45, 1, Q);         // передзвін у межах 5 хв
  await applyMissedCallSignals(c, new Date(`${D} 12:05:00+03`));
  assert.equal((await taskOf(c, P)).length, 1, "🔴 спроба без розмови погасила сигнал — клієнт, до якого не додзвонились, лишився без задачі");
  assert.equal((await taskOf(c, Q)).length, 0, "🔴 після передзвону від 10 с задача однаково поставлена");
});

test("#1301 ТЕКСТ АВТОЗАКРИТТЯ: КОЛИ, ХТО І СКІЛЬКИ — менеджер, ПІБ із Ringostat або чесне «з номера компанії»", async (t) => {
  const { autoCloseReason } = await import("./missedCallSignal.js");
  const a = autoCloseReason("15.09 10:09", "Дмитрук", 10);
  for (const part of ["Закрито автоматично:", "Дмитрук", "15.09 10:09", "розмова 10 с"]) {
    assert.ok(a.includes(part), `🔴 у причині закриття немає «${part}»: ${a}`);
  }
  assert.ok(autoCloseReason("15.09 10:09").includes("з номера компанії"), "🔴 невідомий передзвонювач — порожнє місце замість «з номера компанії»");
  const c = await db(); if (typeof c === "string") return t.skip(c);
  // Ті самі задачі, що закрили `#1300` (менеджер) і `#1300b` (ПІБ без менеджера) — у причині справжні люди.
  const [byMgr] = await taskOf(c, "380671300001");
  const [byFio] = await taskOf(c, "380671300010");
  assert.ok(byMgr?.close_reason?.includes("Дмитрук") && byMgr.close_reason.includes("розмова 10 с"),
    `🔴 причина не називає менеджера, що передзвонив: ${String(byMgr?.close_reason)}`);
  assert.ok(byFio?.close_reason?.includes("Петренко Іван"), `🔴 без менеджера в базі не взято ПІБ із Ringostat: ${String(byFio?.close_reason)}`);
});

test("#1304 НОРМАТИВ ВКЛАДКИ: передзвін — перша розмова від 10 с; спроба 0 с — окремо й у «що сталось далі»", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const R = await import("./missedCallsRules.js");
  const day = "2026-09-16";
  const OK = "380671304001", TRY = "380671304002", NONE = "380671304003";
  for (const p of [OK, TRY, NONE]) await call(c, `${day} 10:00:00+03`, "in", "NO ANSWER", 0, 1, p);
  await call(c, `${day} 10:03:00+03`, "out", "NO ANSWER", 0, 1, OK);       // спроба, потім успіх
  await call(c, `${day} 10:20:00+03`, "out", "ANSWERED", 15, 1, OK);
  await call(c, `${day} 10:04:00+03`, "out", "ANSWERED", 5, 2, TRY);       // лише коротка спроба
  const S = R.missedSummarySql(day, day, {});
  const sum = (await c.query<{ missed: number; callback: number; callback_attempt: number; median_min: string | null }>(S.sql, S.params)).rows[0];
  assert.equal(sum.missed, 3);
  assert.equal(sum.callback, 1, "🔴 спробу без розмови від 10 с пораховано передзвоном — норматив ТЗ рахує до ПЕРШОГО УСПІШНОГО");
  assert.equal(sum.callback_attempt, 1, "🔴 «лише спроба» зникла з підсумку — «не передзвонили» сховало тих, кому набирали");
  assert.equal(Number(sum.median_min), 20, "🔴 медіана рахується до першої спроби (3 хв), а не до першої розмови від 10 с (20 хв)");
  const L = R.missedListSql(day, {});
  const rows = (await c.query<{ client_phone: string; cb_min: string | null; cb_talked: boolean | null; cs_min: string | null }>(L.sql, L.params)).rows;
  const step = (p: string) => { const r = rows.find((x) => x.client_phone === p)!;
    return R.nextStep({ cbMin: r.cb_min == null ? null : Number(r.cb_min), cbTalked: r.cb_talked, csMin: r.cs_min == null ? null : Number(r.cs_min) }); };
  assert.deepEqual(step(OK), { kind: "callback_talked", minutes: 20 }, "🔴 «що сталось далі» показує спробу, хоча потім була розмова");
  assert.deepEqual(step(TRY), { kind: "callback_no_answer", minutes: 4 }, "🔴 спроба без розмови в списку стала «нічого не сталось»");
  assert.equal(step(NONE).kind, "nothing");
});

test("#1306 ПЕРЕРАХУНОК СТАРИХ: перевідкриває лише закриті ДЖОБОЮ без розмови від 10 с; людей не чіпає; повтор — 0", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { recountMissedTasks, RECOUNT_NOTE } = await import("./missedCallSignal.js");
  const OLD = "Закрито автоматично: вихідний дзвінок на номер 10.09 10:01.";
  const mk = async (phone: string, closeReason: string | null) => {
    const id = (await c.query<{ id: number }>(
      `INSERT INTO tasks (title, description, status, assignee_id, priority, task_type, closed_at, close_reason)
       VALUES ($1, 'опис', 'done', 1, 'high', 'simple', now(), $2) RETURNING id`, [`📵 Передзвонити клієнту: +${phone}`, closeReason])).rows[0].id;
    await c.query(`INSERT INTO missed_call_tasks (manager_id, client_phone, kday, task_id, missed_count, last_signal_at, closed_at)
                   VALUES (1, $1, '2026-09-10', $2, 1, '2026-09-10 10:00:00+03', now())`, [phone, id]);
    return id;
  };
  const SHORT = "380671306001", TALK = "380671306002", HUMAN = "380671306003";
  const idShort = await mk(SHORT, OLD);
  await call(c, "2026-09-10 10:01:00+03", "out", "NO ANSWER", 0, 1, SHORT);       // закрила спроба
  const idTalk = await mk(TALK, OLD);
  await call(c, "2026-09-10 10:01:00+03", "out", "ANSWERED", 40, 1, TALK);        // закрив справжній передзвін
  const idHuman = await mk(HUMAN, null);                                            // закрила людина
  await call(c, "2026-09-10 10:01:00+03", "out", "NO ANSWER", 0, 1, HUMAN);

  const dry = await recountMissedTasks(c, false);
  const ids = dry.rows.map((r) => r.task_id).filter((id) => [idShort, idTalk, idHuman].includes(id));
  assert.deepEqual(ids, [idShort], "🔴 перерахунок бере не ті задачі: лише закриту джобою спробою, без передзвону й без закритих людьми");
  assert.equal((await c.query<{ s: string }>("SELECT status AS s FROM tasks WHERE id = $1", [idShort])).rows[0].s, "done", "🔴 --dry записав зміни");

  const run = await recountMissedTasks(c, true);
  assert.ok(run.reopened >= 1);
  const after1 = (await c.query<{ id: number; status: string; close_reason: string | null; description: string }>(
    "SELECT id, status, close_reason, description FROM tasks WHERE id = ANY($1) ORDER BY id", [[idShort, idTalk, idHuman]])).rows;
  assert.deepEqual(after1.map((r) => r.status), ["not_started", "done", "done"], "🔴 перевідкрито не ту задачу");
  assert.ok(after1[0].description.includes(RECOUNT_NOTE), "🔴 перевідкрита задача не пояснює, чому вона знову відкрита");
  const log = (await c.query<{ from_status: string; to_status: string }>(
    "SELECT from_status, to_status FROM task_status_log WHERE task_id = $1", [idShort])).rows;
  assert.deepEqual(log, [{ from_status: "done", to_status: "not_started" }], "🔴 перевідкриття не лишило сліду в історії статусів");
  const led = (await c.query<{ open: boolean }>("SELECT closed_at IS NULL AS open FROM missed_call_tasks WHERE task_id = $1", [idShort])).rows[0];
  assert.equal(led.open, true, "🔴 журнал сигналу лишився закритим — передзвін пізніше вже не закриє задачу");
  const again = await recountMissedTasks(c, true);
  assert.equal(again.rows.filter((r) => [idShort, idTalk, idHuman].includes(r.task_id)).length, 0, "🔴 повторний прогін знову щось перевідкриває — не ідемпотентно");
});

test("#1305 СИНК ДЗВІНКІВ І СИГНАЛ — НЕ РІДШЕ НІЖ РАЗ НА 3 ХВ (ТЗ: «не рідше ніж раз на 2-3 хвилини»)", async () => {
  const src = SRC("index.ts");
  const fresh = src.indexOf('runJob("syncCallsFresh"');
  const spec = [...src.slice(0, fresh).matchAll(/cron\.schedule\("([^"]+)"/g)].pop()?.[1];
  assert.ok(spec, "🔴 не знайдено розкладу частого синку");
  const { createRequire } = await import("node:module");
  const TimeMatcher = createRequire(import.meta.url)("node-cron/src/time-matcher.js") as new (p: string) => { match(d: Date): boolean };
  const tm = new TimeMatcher(`0 ${spec}`);
  const minutes = Array.from({ length: 60 }, (_, i) => i).filter((i) => tm.match(new Date(2026, 9, 2, 10, i, 0)));
  const maxGap = Math.max(...minutes.map((x, i) => ((minutes[(i + 1) % minutes.length] - x + 60) % 60) || 60));
  assert.ok(maxGap <= 3, `🔴 найбільший проміжок синку ${String(maxGap)} хв — ТЗ вимагає не рідше ніж раз на 2-3 хв [${minutes.join(",")}]`);
  assert.equal(minutes.includes(30), false, "🔴 синк дзвінків на :30 — разом із syncKommo");
});

/**
 * #1307 — КРИТЕРІЙ ТЗ НА ЖИВІЙ БАЗІ: «висячих задач по передзвонених 0». Одним запитом (правило 18).
 * Передзвін, свіжіший за 10 хв, не рахується: джоба ходить раз на 3 хв, і задача, закрита на наступному тіку,
 * не висить, а чекає тіку — без цього запасу гейт червонів би за календарем, а не за дефектом.
 */
test("#1307 ЖИВА БД: відкритих задач «передзвони», по яких уже була розмова від 10 с, — 0", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const { CALLBACK_MIN_TALK_SEC, OUTBOUND_TYPES } = await import("./missedCallsRules.js");
  const r = await pool.query<{ n: number; sample: string | null }>(
    `SELECT count(*)::int AS n, min(l.client_phone || ' (' || to_char(l.kday,'DD.MM') || ')') AS sample
       FROM missed_call_tasks l JOIN tasks t ON t.id = l.task_id
      WHERE t.status <> 'done'
        AND EXISTS (SELECT 1 FROM ringostat_calls o
                     WHERE o.client_phone = l.client_phone
                       AND o.call_type = ANY($1::text[])
                       AND o.billsec >= $2
                       AND o.calldate > l.last_signal_at
                       AND o.calldate < now() - interval '10 minutes')`, [[...OUTBOUND_TYPES], CALLBACK_MIN_TALK_SEC]);
  assert.equal(r.rows[0].n, 0, `🔴 висять ${String(r.rows[0].n)} задач по вже передзвонених (напр. ${String(r.rows[0].sample)}) — критерій ТЗ не виконано`);
});

/**
 * #1786 — ЗАДАЧА «📵» ЗАКРИВАЄТЬСЯ, КОЛИ З КЛІЄНТОМ УЖЕ ПОГОВОРИЛИ (задача 5824, 19.10.2026): клієнт сам передзвонив і
 * розмова від 10 с — закриває (9 с — ні); угода номера ввійшла в «Успішно реалізовано» ПІСЛЯ сигналу — закриває (до — ні);
 * з кількох подій — найраніша й своя причина; перерахунок 02.10 такі закриття не перевідкриває.
 * 🧨 Червоніє, якщо вхідна розмова не закриває, 9 с закриває, «успіх» до пропущеного закриває, або перерахунок їх відкриває.
 */
test("#1786 КЛІЄНТ САМ / УСПІХ: вхідна розмова від 10 с і «Успіх» після сигналу закривають задачу; 9 с і «Успіх» до — ні", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { applyMissedCallSignals, recountCandidatesSql } = await import("./missedCallSignal.js");
  const { AUTO_CLOSE_CLIENT_SELF_PREFIX, AUTO_CLOSE_SUCCESS_PREFIX, AUTO_CLOSE_CALLBACK_PREFIX } = await import("./missedCallsRules.js");
  const tick = (at: string) => applyMissedCallSignals(c, new Date(at));
  const DAY = "2026-09-22"; // понеділок
  const A = "380671786001", B = "380671786002", C = "380671786003", E = "380671786004";
  for (const p of [A, B, C, E]) await call(c, `${DAY} 10:00:00+03`, "in", "NO ANSWER", 0, 1, p);
  // «Успіх» ДО пропущеного (давній постійний клієнт) — не закриває; ПІСЛЯ — закриває.
  await c.query("INSERT INTO deals(kommo_id, name, status_id, pipeline_id) VALUES (178601, $1, 142, 8921932), (178602, $2, 142, 8921932)", [`+${B}`, E]);
  await c.query(`INSERT INTO deal_stage_events(kommo_id, status_id, pipeline_id, changed_at) VALUES (178601, 142, 8921932, '${DAY} 09:00:00+03')`);
  await tick(`${DAY} 10:05:00+03`);
  for (const p of [A, B, C, E]) assert.equal((await taskOf(c, p)).length, 1, `🔴 задачу на ${p} не поставлено`);
  await call(c, `${DAY} 10:20:00+03`, "in", "ANSWERED", 9, 1, A);                 // клієнт сам, 9 с — спроба
  await tick(`${DAY} 10:21:00+03`);
  assert.equal((await taskOf(c, A))[0].status, "not_started", "🔴 вхідна розмова 9 с закрила задачу — межа «від 10 с»");
  assert.equal((await taskOf(c, B))[0].status, "not_started", "🔴 «Успіх» ДО пропущеного закрив задачу — це давній клієнт, а не відповідь на дзвінок");
  await call(c, `${DAY} 10:30:00+03`, "transitin", "ANSWERED", 10, 1, A);          // клієнт сам, рівно 10 с
  await call(c, `${DAY} 10:30:00+03`, "in", "ANSWERED", 40, 1, C);                // клієнт сам раніше…
  await call(c, `${DAY} 10:40:00+03`, "out", "ANSWERED", 50, 2, C);               // …за наш передзвін
  await c.query(`INSERT INTO deal_stage_events(kommo_id, status_id, pipeline_id, changed_at) VALUES (178602, 142, 8921932, '${DAY} 11:00:00+03')`);
  const s = await tick(`${DAY} 11:05:00+03`);
  assert.equal(s.closed, 3, "🔴 закрито не три задачі (клієнт сам ×2 і «Успіх»)");
  const [a] = await taskOf(c, A), [b] = await taskOf(c, B), [cc] = await taskOf(c, C), [e] = await taskOf(c, E);
  assert.equal(a.status, "done");
  assert.ok(a.close_reason?.startsWith(AUTO_CLOSE_CLIENT_SELF_PREFIX) && a.close_reason.includes("розмова 10 с"), `🔴 причина не «клієнт передзвонив сам»: ${String(a.close_reason)}`);
  assert.ok(cc.close_reason?.startsWith(AUTO_CLOSE_CLIENT_SELF_PREFIX), "🔴 з двох подій взято не найранішу — клієнт сам був раніше за наш передзвін");
  assert.ok(!cc.close_reason?.startsWith(AUTO_CLOSE_CALLBACK_PREFIX), "🔴 «клієнт сам» зараховано як наш передзвін");
  assert.ok(e.close_reason?.startsWith(AUTO_CLOSE_SUCCESS_PREFIX) && e.close_reason.includes("№178602"), `🔴 причина не «угода в Успіху»: ${String(e.close_reason)}`);
  assert.equal(b.status, "not_started", "🔴 задача без розмови й без нового «Успіху» закрилась");
  // Разовий перерахунок 02.10 такі закриття НЕ перевідкриває.
  const rc = (await c.query<{ task_id: number }>(recountCandidatesSql())).rows.map((r) => r.task_id);
  assert.ok(![a.id, cc.id, e.id].some((id) => rc.includes(id)), "🔴 перерахунок перевідкрив би задачу, закриту «клієнт сам» / «Успіх»");
});

test("#1786b «ЛИШЕ НЕПЕРЕДЗВОНЕНІ»: рядок, після якого клієнт сам поговорив від 10 с, у фільтрі не показується; 9 с — показується", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { missedListSql, missedAutomationSql } = await import("./missedCallsRules.js");
  const DAY = "2026-09-23";
  const T = "380671786101", N = "380671786102", O = "380671786103";
  for (const p of [T, N, O]) await call(c, `${DAY} 12:00:00+03`, "in", "NO ANSWER", 0, 1, p);
  await call(c, `${DAY} 12:10:00+03`, "in", "ANSWERED", 25, 1, T);   // клієнт сам поговорив
  await call(c, `${DAY} 12:10:00+03`, "in", "ANSWERED", 9, 1, N);    // 9 с — не розмова
  await call(c, `${DAY} 12:15:00+03`, "out", "ANSWERED", 30, 1, O);  // наш передзвін
  const run = async (only: boolean) => {
    const q = missedListSql(DAY, {}, only);
    return (await c.query<{ client_phone: string }>(q.sql, q.params)).rows.map((r) => r.client_phone).filter((p) => [T, N, O].includes(p)).sort();
  };
  assert.deepEqual(await run(false), [T, N, O].sort(), "🔴 без фільтра список загубив пропущені — розкриття сперечається з числом");
  assert.deepEqual(await run(true), [N], "🔴 «лише непередзвонені» показує тих, з ким уже поговорили (або сховав того, з ким ні)");
  const q = missedAutomationSql("2026-09-22", {});
  const x = (await c.query<{ closed_client_self: number; closed_success: number }>(q.sql, q.params)).rows[0];
  assert.ok(x.closed_client_self >= 2 && x.closed_success >= 1, "🔴 «Автоматика за 7 днів» не рахує закриття «клієнт сам» / «Успіх»");
});
