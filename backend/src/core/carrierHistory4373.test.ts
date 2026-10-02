import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openTasksPath, closeTasksBody, carrierTaskCloseReason, AUTO_CARRIER_TAG, NOT_CLIENT_PIPELINES } from "./carrierHistory.js";
import { AUTO_CLOSE_CALLBACK_PREFIX, AUTO_CLOSE_CARRIER_PREFIX } from "./missedCallsRules.js";

/**
 * 🚚 ЗАДАЧА 4373, БЛОК 1 — «ПЕРЕВІЗНИК» ЗА ІСТОРІЄЮ CRM (ТЗ Юлії 17.09.2026; рішення Романа 02.10.2026).
 *
 * ТЗ: номер уже закривали як «Перевізник» → нова угода закривається з тією ж причиною й тегом «авто-перевізник»,
 * задача менеджеру не ставиться. Виняток: по номеру є угода в «Успіх» або в роботі (перевізник як замовник).
 * Кожне твердження — по обидва боки межі; поведінку ганяємо на СВОЄМУ кластері з керованим «зараз».
 */
const FRONT = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "signalTaskNotify.ts"), "utf8");
const D = "2026-09-15";
const STAGE = { p: 8921928, s: 70419108 };

type Client = { query<R = Record<string, unknown>>(q: string, p?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>; end(): Promise<void> };
let ready: Promise<Client | string> | null = null;
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
    await c.query(`INSERT INTO managers(id,name,team_id,is_active,kommo_user_id) VALUES (1,'Яцик',1,true,501),(2,'Дмитрук',1,true,502) ON CONFLICT DO NOTHING`);
    return c as unknown as Client;
  })();
  return ready;
}
after(async () => { const c = await ready; if (c && typeof c !== "string") await c.end(); });

let seq = 0;
const deal = (c: Client, id: number, name: string, pipeline: number, status: number, reject: string | null = null) =>
  c.query("INSERT INTO deals(kommo_id,name,pipeline_id,status_id,reject_reason) VALUES ($1,$2,$3,$4,$5)", [id, name, pipeline, status, reject]);
const call = (c: Client, at: string, type: string, disp: string | null, sec: number, mgr: number | null, phone: string) =>
  c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,manager_id,client_phone) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [`h${String(++seq)}`, at, type, disp, sec, mgr, phone]);
const hist = async (c: Client, phone: string, self: number | null = null) => {
  const { carrierHistorySql } = await import("./carrierHistory.js");
  return (await c.query<{ v: string | null }>(`SELECT ${carrierHistorySql("$1::text", "$2::bigint")}::text AS v`, [phone, self])).rows[0].v;
};

test("#1302 ІСТОРІЯ CRM: «Перевізник» у минулому → так; угода замовника в «Успіх» чи в роботі → ні; воронки перевізника й етап фільтра — не виняток", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const P = { plain: "380671302001", success: "380671302002", open: "380671302003", payment: "380671302004", stage: "380671302005", contact: "380671302006", none: "380671302007" };
  await deal(c, 9001, P.plain, STAGE.p, 143, "Перевізник");
  await deal(c, 9002, P.success, STAGE.p, 143, "Перевізник"); await deal(c, 9003, P.success, 8921932, 142);          // замовник, «Успіх»
  await deal(c, 9004, P.open, STAGE.p, 143, "Перевізник"); await deal(c, 9005, P.open, 8921932, 61234567);            // угода в роботі
  await deal(c, 9006, P.payment, STAGE.p, 143, "Перевізник"); await deal(c, 9007, P.payment, NOT_CLIENT_PIPELINES[0], 142); // оплата перевізнику
  await deal(c, 9008, P.stage, STAGE.p, 143, "Перевізник"); await deal(c, 9009, P.stage, STAGE.p, STAGE.s);          // свіжа угода фільтра
  await deal(c, 9010, "ТОВ Вантаж", STAGE.p, 143, "Перевізник");                                                  // номер — лише в контакті
  await c.query("INSERT INTO deal_contacts(deal_kommo_id, contact_id) VALUES (9010, 77)");
  await c.query("INSERT INTO contact_phones(contact_id, phone) VALUES (77, $1)", [P.contact]);
  await deal(c, 9011, P.none, STAGE.p, 143, "Дубль");                                                            // інша причина

  assert.equal(await hist(c, P.plain), "9001", "🔴 номер, який закривали як «Перевізник», не впізнано");
  assert.equal(await hist(c, P.success), null, "🔴 перевізник, що став ЗАМОВНИКОМ (угода в «Успіх»), — закрили б живого клієнта; ТЗ: виняток");
  assert.equal(await hist(c, P.open), null, "🔴 по номеру є угода в роботі — однаково «перевізник»; ТЗ: виняток");
  assert.equal(await hist(c, P.payment), "9006", "🔴 угода «оплата перевізнику» зарахована як угода замовника — перевізника не закрито");
  assert.equal(await hist(c, P.stage), "9008", "🔴 свіжа угода етапу фільтра (її створив сам дзвінок) зарахована винятком");
  assert.equal(await hist(c, P.contact), "9010", "🔴 номер лише в телефоні контакту — історію не знайдено");
  assert.equal(await hist(c, P.none), null, "🔴 закрита з ІНШОЮ причиною угода зарахована «перевізником»");
  assert.equal(await hist(c, P.plain, 9001), null, "🔴 угода перевіряє сама себе — власна закрита угода стала «історією»");
});

test("#1302b СИГНАЛ: на номер перевізника задачу не ставимо (слід у журналі — раз), відкриту закриваємо; клієнту — ставимо", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { applyMissedCallSignals } = await import("./missedCallSignal.js");
  const CAR = "380671302101", CLI = "380671302102", OPEN = "380671302103";
  await deal(c, 9101, CAR, STAGE.p, 143, "Перевізник");
  await call(c, `${D} 10:00:00+03`, "in", "NO ANSWER", 0, 1, CAR);
  await call(c, `${D} 10:00:00+03`, "in", "NO ANSWER", 0, 1, CLI);
  await call(c, `${D} 10:00:00+03`, "in", "NO ANSWER", 0, 2, OPEN);
  const s1 = await applyMissedCallSignals(c, new Date(`${D} 10:05:00+03`));
  const tasks = async (p: string) => (await c.query<{ status: string; close_reason: string | null }>(
    "SELECT status, close_reason FROM tasks WHERE title LIKE $1", [`%+${p}`])).rows;
  assert.equal((await tasks(CAR)).length, 0, "🔴 перевізнику поставлено задачу «передзвони» — ТЗ: «задача менеджеру не створюється»");
  assert.equal((await tasks(CLI)).length, 1, "🔴 клієнту задачу не поставлено — перевірка гасить усіх");
  assert.equal(s1.skippedCarrier, 1);
  assert.equal((await applyMissedCallSignals(c, new Date(`${D} 10:08:00+03`))).skippedCarrier, 0, "🔴 пропуск записується щотіку — звіт контролю роздуто");
  // Номер став перевізником ПІСЛЯ того, як задачу поставили (угоду закрили «Перевізник») — відкриту задачу закриваємо.
  await deal(c, 9102, OPEN, STAGE.p, 143, "Перевізник");
  const s2 = await applyMissedCallSignals(c, new Date(`${D} 10:11:00+03`));
  const [o] = await tasks(OPEN);
  assert.equal(s2.closedCarrier, 1);
  assert.equal(o.status, "done", "🔴 відкриту задачу на номер перевізника не закрито");
  assert.ok(o.close_reason?.includes("9102") && o.close_reason.startsWith(AUTO_CLOSE_CARRIER_PREFIX), `🔴 причина не називає угоду-джерело: ${String(o.close_reason)}`);
  assert.equal((await tasks(CLI))[0].status, "not_started", "🔴 задачу клієнта закрито як перевізника");
});

test("#1302c ПЕРЕРАХУНОК НЕ ПЕРЕВІДКРИВАЄ ПЕРЕВІЗНИКА: блок 1 однаково закрив би задачу", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { recountMissedTasks } = await import("./missedCallSignal.js");
  const mk = async (phone: string) => {
    const id = (await c.query<{ id: number }>(`INSERT INTO tasks (title, description, status, assignee_id, priority, task_type, closed_at, close_reason)
      VALUES ($1, 'опис', 'done', 1, 'high', 'simple', now(), 'Закрито автоматично: вихідний дзвінок на номер 10.09 10:01.') RETURNING id`,
      [`📵 Передзвонити клієнту: +${phone}`])).rows[0].id;
    await c.query(`INSERT INTO missed_call_tasks (manager_id, client_phone, kday, task_id, missed_count, last_signal_at, closed_at)
                   VALUES (1, $1, '2026-09-10', $2, 1, '2026-09-10 10:00:00+03', now())`, [phone, id]);
    await call(c, "2026-09-10 10:01:00+03", "out", "NO ANSWER", 0, 1, phone);
    return id;
  };
  const car = await mk("380671302201"), cli = await mk("380671302202");
  await deal(c, 9201, "380671302201", STAGE.p, 143, "Перевізник");
  const ids = (await recountMissedTasks(c, false)).rows.map((r) => r.task_id);
  assert.ok(ids.includes(cli), "🔴 клієнтську задачу, закриту спробою, не перевідкрито");
  assert.ok(!ids.includes(car), "🔴 перевідкрито задачу перевізника — наступний тік закрив би її знову");
});

test("#1303 «ВІДСІВ»: історія CRM — вердикт без розмови; «лише журнал» нічого не пише; «наживо» — задачі Kommo ПЕРШИМИ, тег додається, не замінює", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { resolveCarrierDeals } = await import("./carrierCalls.js");
  const { runCarrierClose, closePayload } = await import("./carrierClose.js");
  const NOW = new Date(`${D} 12:00:00+03`);
  const PH = "380671303001";
  await deal(c, 9301, PH, STAGE.p, 143, "Перевізник");
  await deal(c, 9302, PH, STAGE.p, STAGE.s);
  await c.query(`INSERT INTO carrier_call_deals(kommo_id,phone,deal_created_at,seen_at,state) VALUES (9302,$1,$2,$2,'waiting')`, [PH, `${D} 11:50:00+03`]);
  const rep = await resolveCarrierDeals(c, NOW);
  assert.equal(rep.history, 1, "🔴 угода номера-перевізника не отримала вердикт «історія CRM»");
  const st = (await c.query<{ state: string; history_from: string }>("SELECT state, history_from::text FROM carrier_call_deals WHERE kommo_id = 9302")).rows[0];
  assert.deepEqual(st, { state: "history", history_from: "9301" }, "🔴 стан/джерело історії не записано");
  assert.equal((await c.query("SELECT 1 FROM carrier_call_deals WHERE kommo_id = 9302 AND uniqueid IS NOT NULL")).rowCount, 0, "🔴 угоду з історії поставлено на розпізнавання — платимо за відомого перевізника");

  const order: string[] = [];
  const patches: unknown[][] = [];
  const kommo = {
    patchLeads: async (b: unknown[]) => { order.push("lead"); patches.push(b); return {}; },
    addNotes: async () => { order.push("note"); return {}; },
    openTaskIds: async () => { order.push("tasks?"); return [555]; },
    closeTasks: async () => { order.push("tasks!"); return {}; },
  };
  const onStage = new Set([9302]);
  const dry = await runCarrierClose(c, NOW, "live", onStage, kommo, "dry", "dry");
  assert.equal(dry.closed, 0, "🔴 історію закрито в Kommo в режимі «лише журнал» — запис у CRM без слова Романа");
  assert.equal(patches.length, 0);
  assert.equal((await c.query<{ mode: string }>("SELECT mode FROM carrier_close_log WHERE kommo_id = 9302")).rows[0]?.mode, "dry", "🔴 журнал не записав «кого закрили б»");

  const live = await runCarrierClose(c, NOW, "live", onStage, kommo, "dry", "live");
  assert.equal(live.closed, 1);
  assert.deepEqual(order.slice(0, 3), ["tasks?", "tasks!", "lead"], "🔴 угоду закрито РАНІШЕ за її задачі — задача «передзвоніть» лишилась би на закритій угоді");
  const body = patches[0][0] as Record<string, unknown>;
  assert.deepEqual(body.tags_to_add, [{ name: AUTO_CARRIER_TAG }], "🔴 тег «авто-перевізник» не поставлено");
  assert.equal("_embedded" in body, false, "🔴 тег через _embedded.tags — це ЗАМІНА всіх тегів угоди");
  assert.equal(body.status_id, 143);
  // Дзеркало: AI-закриття тегу не отримує (тег — ознака саме історії CRM).
  assert.equal("tags_to_add" in (closePayload([1], "carrier")[0] as Record<string, unknown>), false, "🔴 тег історії ставиться й на AI-закриття");
});

test("#1303b ЗАДАЧІ KOMMO: фільтр «відкриті» — СКАЛЯРОМ (масив Kommo мовчки ігнорує); закриття — з результатом", () => {
  const p = openTasksPath([11, 12]);
  assert.match(p, /filter\[is_completed\]=0(&|$)/, "🔴 немає фільтра відкритих задач");
  assert.doesNotMatch(p, /filter\[is_completed\]\[\]/, "🔴 фільтр масивом — Kommo віддасть і завершені задачі (пастка Espo 03.09)");
  assert.match(p, /filter\[entity_type\]=leads/);
  assert.ok(p.includes("filter[entity_id][]=11") && p.includes("filter[entity_id][]=12"), "🔴 не всі угоди в запиті");
  assert.deepEqual(closeTasksBody([5], "x"), [{ id: 5, is_completed: true, result: { text: "x" } }], "🔴 задачу закрито без результату — Kommo відмовить для деяких типів");
});

test("#1308 ПРЕФІКСИ АВТОЗАКРИТТЯ — ОДИН КОНТРАКТ для фронта, звіту контролю й задачі", async () => {
  const { autoCloseReason } = await import("./missedCallSignal.js");
  const FRONT_PREFIX = FRONT.match(/AUTO_CLOSE_PREFIX = "([^"]+)"/)?.[1];
  assert.ok(FRONT_PREFIX, "🔴 не знайдено префікс фронту");
  for (const r of [autoCloseReason("15.09 10:09", "Дмитрук", 30), autoCloseReason("15.09 10:09")]) {
    assert.ok(r.startsWith(AUTO_CLOSE_CALLBACK_PREFIX), `🔴 причина передзвону не рахується звітом контролю: ${r}`);
    assert.ok(r.startsWith(FRONT_PREFIX), "🔴 причина передзвону не впізнається фронтом");
  }
  const car = carrierTaskCloseReason(9101);
  assert.ok(car.startsWith(AUTO_CLOSE_CARRIER_PREFIX), `🔴 причина «перевізник» не рахується звітом контролю: ${car}`);
  assert.ok(car.startsWith(FRONT_PREFIX), "🔴 причина «перевізник» не впізнається фронтом — тост «пропущений» на закриту задачу");
  assert.equal(car.startsWith(AUTO_CLOSE_CALLBACK_PREFIX), false, "🔴 закриття перевізника рахується як «передзвонили»");
});

test("#1309 КОНТРОЛЬ ТЗ: «не поставлено / закрито передзвоном / закрито як перевізник» за 7 днів — з фактів, у скоупі", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  const { missedAutomationSql } = await import("./missedCallsRules.js");
  const run = async (s: { managerId?: number | null; teamId?: number | null }) => {
    const q = missedAutomationSql(D, s);
    return (await c.query<{ skipped_carrier: number; closed_callback: number; closed_carrier: number; deals_history: number | null }>(q.sql, q.params)).rows[0];
  };
  // Факти з попередніх гейтів (кластер спільний): `#1302b` — 1 пропуск і 1 закриття перевізника (менеджер 1 і 2);
  // `#1303` — 1 угода історії. Закриття передзвоном за ці дні — додаємо свій факт.
  await c.query(`UPDATE tasks SET closed_at = $1 WHERE close_reason LIKE $2`, [`${D} 10:11:00+03`, `${AUTO_CLOSE_CARRIER_PREFIX}%`]);
  const id = (await c.query<{ id: number }>(`INSERT INTO tasks (title, status, assignee_id, priority, task_type, closed_at, close_reason)
    VALUES ('📵 Передзвонити клієнту: +380671309001', 'done', 1, 'high', 'simple', $1, $2) RETURNING id`,
    [`${D} 11:00:00+03`, `${AUTO_CLOSE_CALLBACK_PREFIX} Яцик 15.09 10:59, розмова 30 с.`])).rows[0].id;
  await c.query(`INSERT INTO missed_call_tasks (manager_id, client_phone, kday, task_id, missed_count, last_signal_at, closed_at)
                 VALUES (1, '380671309001', $1, $2, 1, $3, $3)`, [D, id, `${D} 10:50:00+03`]);
  const all = await run({});
  assert.deepEqual([all.skipped_carrier, all.closed_callback, all.closed_carrier], [1, 1, 1], "🔴 звіт контролю рахує не ті факти");
  assert.equal(all.deals_history, 1, "🔴 угоди історії CRM не пораховано");
  const m2 = await run({ managerId: 2 });
  assert.deepEqual([m2.skipped_carrier, m2.closed_callback, m2.closed_carrier, m2.deals_history], [0, 0, 1, null],
    "🔴 скоуп не звужує звіт: менеджер бачить чужі задачі або угоди фільтра");
});
