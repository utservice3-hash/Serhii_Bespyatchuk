import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  timesUk, phoneForTask, signalTitle, signalDescription, autoCloseReason,
} from "./missedCallSignal.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");

/**
 * #456 — ТЕКСТ ЗАДАЧІ: повний номер (рішення власника), скільки разів — українською по
 * обидва боки кожної межі відмінка, і коли саме.
 */
test("#456 ТЕКСТ СИГНАЛУ: повний номер, «раз/рази/разів» на межах, час і відро доби", () => {
  const cases: [number, string][] = [
    [1, "1 раз"], [2, "2 рази"], [4, "4 рази"], [5, "5 разів"], [11, "11 разів"], [12, "12 разів"],
    [14, "14 разів"], [21, "21 раз"], [22, "22 рази"], [25, "25 разів"], [111, "111 разів"], [112, "112 разів"],
  ];
  for (const [n, want] of cases) assert.equal(timesUk(n), want, `🔴 ${String(n)} → «${timesUk(n)}», а треба «${want}»`);

  assert.equal(phoneForTask("380671234567"), "+380671234567", "🔴 міжнародний номер без плюса");
  assert.equal(phoneForTask("0671234567"), "0671234567", "🔴 плюс перед місцевим номером дає неіснуючий номер");
  assert.ok(signalTitle("380671234567").includes("+380671234567"),
    "🔴 у заголовку не ПОВНИЙ номер — рішення власника 16.09.2026");

  const d = signalDescription({ missedTotal: 3, dayLabel: "15.09", lastHhmm: "14:32", lastBucket: "evening" });
  for (const part of ["3 рази", "15.09", "14:32", "вечір", "закриється сама"]) {
    assert.ok(d.includes(part), `🔴 в описі задачі немає «${part}»:\n${d}`);
  }
  assert.ok(autoCloseReason("15.09 10:12").includes("15.09 10:12"), "🔴 причина автозакриття не називає, коли був вихідний");
});

/**
 * #457 — ПОВЕДІНКА ДЖОБИ НА ЖИВІЙ СХЕМІ, з керованим «зараз». Кожне рішення власника —
 * з обох боків межі:
 *  · поріг 5 хв: 4:59 — ні, 5:00 — так; межа пошуку 3 год: 3:00:00 — так, 3:00:01 — ні;
 *  · «нічиїм», неактивним, голосовій пошті і тим, кому передзвонили за 3 хв, — ні;
 *  · клієнт сам передзвонив і поговорили — ТАК (гасить лише вихідний);
 *  · дубль склеєного плеча — один дзвінок, а не два; другий пропущений того ж дня — та сама задача;
 *  · повторний тік не дублює; вихідний закриває; новий пропущений після нього перевідкриває;
 *  · закриту менеджером не чіпаємо; видалену не відроджуємо без нового пропущеного;
 *  · день — київський, і новий день — нова задача.
 * Кластер свій, через `pg.Client` (не `db/pool.js`). На проді бінарів PostgreSQL немає →
 * чесний skip, записаний у реєстр одразу.
 */
test("#457 ЖИВА ДЖОБА СИГНАЛУ: поріг, межі, одна задача на номер за день, закриття й перевідкриття", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { applyMissedCallSignals } = await import("./missedCallSignal.js");
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES
      (1,'Яцик',1,true),(2,'Дмитрук',1,true),(3,'Звільнений',1,false) ON CONFLICT DO NOTHING`);
    let seq = 0;
    const call = (at: string, type: string, disp: string | null, sec: number, mgr: number | null, phone: string) =>
      c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,manager_id,client_phone)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`, [`u${String(++seq)}`, at, type, disp, sec, mgr, phone]);
    const tick = (at: string) => applyMissedCallSignals(c, new Date(at));
    const P = (n: number) => `38067000000${String(n).padStart(1, "0")}`.slice(-12);
    const tasksOf = async (phone: string) => (await c.query<{ id: number; status: string; assignee_id: number; priority: string;
      task_type: string; deadline: string; description: string; close_reason: string | null; title: string }>(
      `SELECT id, status, assignee_id, priority, task_type, to_char(deadline,'YYYY-MM-DD') AS deadline,
              description, close_reason, title
         FROM tasks WHERE title LIKE $1 ORDER BY id`, [`%+${phone}`])).rows;
    const D = "2026-09-15";   // вівторок

    await call(`${D} 10:00:00+03`, "in", "NO ANSWER", 0, 1, P(1));            // базовий
    await call(`${D} 10:00:00+03`, "in", "NO ANSWER", 0, null, P(2));         // нічий
    await call(`${D} 10:00:00+03`, "in", "NO ANSWER", 0, 1, P(3));
    await call(`${D} 10:03:00+03`, "out", "ANSWERED", 30, 1, P(3));           // передзвонили за 3 хв
    await call(`${D} 10:00:00+03`, "in", "NO ANSWER", 0, 3, P(4));            // неактивний менеджер
    await call(`${D} 10:00:00+03`, "in", "NO ANSWER", 0, 2, P(5));
    await call(`${D} 10:00:40+03`, "transitin", "NO ANSWER", 0, 2, P(5));     // плече того самого дзвінка
    await call(`${D} 10:00:00+03`, "in", "VOICEMAIL", 0, 1, P(6));            // не пропущений за означенням
    await call(`${D} 10:00:00+03`, "in", "NO ANSWER", 0, 1, P(7));
    await call(`${D} 10:02:00+03`, "in", "ANSWERED", 40, 1, P(7));            // клієнт сам, поговорили

    // ── поріг: за мить до 5 хв — нічого
    const s0 = await tick(`${D} 10:04:59+03`);
    assert.equal(s0.created, 0, "🔴 задача зʼявилась раніше за 5 хв — порушено поріг власника");

    // Межа пошуку — ПІСЛЯ першого тіку: на 10:04:59 обидва були б ще всередині вікна, і
    // перевірка межі на 10:05 нічого б не доводила.
    await call(`${D} 07:04:59+03`, "in", "NO ANSWER", 0, 1, P(8));            // на 10:05 — 3:00:01, поза межею
    await call(`${D} 07:05:00+03`, "in", "NO ANSWER", 0, 1, P(9));            // на 10:05 — рівно 3:00:00, в межі

    // ── рівно 5 хв
    const s1 = await tick(`${D} 10:05:00+03`);
    const all1 = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks")).rows[0].n;
    assert.equal(s1.created, 4, `🔴 створено ${String(s1.created)} задач, а мало бути 4 (P1, P5, P7, P9)`);
    assert.equal(all1, 4);
    for (const [n, why] of [[2, "нічийому"], [3, "тому, кому передзвонили за 3 хв"], [4, "неактивному менеджеру"],
      [6, "по голосовій пошті"], [8, "по дзвінку, старшому за межу пошуку"]] as const) {
      assert.equal((await tasksOf(P(n))).length, 0, `🔴 задача пішла ${why}`);
    }
    const [t1] = await tasksOf(P(1));
    assert.ok(t1, "🔴 базовий пропущений без задачі");
    assert.deepEqual([t1.assignee_id, t1.status, t1.priority, t1.task_type, t1.deadline],
      [1, "not_started", "high", "simple", D], "🔴 задача не того виконавця / статусу / пріоритету / дедлайну");
    assert.equal((await tasksOf(P(7))).length, 1, "🔴 клієнт передзвонив сам — і задачу не створено; власник вирішив: гасить лише вихідний");
    assert.equal((await tasksOf(P(9))).length, 1, "🔴 пропущений рівно на межі пошуку загубився");
    const [t5] = await tasksOf(P(5));
    assert.ok(t5.description.includes("1 раз ") || t5.description.includes("1 раз за"),
      `🔴 склеєне плече пораховано окремим дзвінком:\n${t5.description}`);

    // ── повторний тік не дублює
    const s2 = await tick(`${D} 10:10:00+03`);
    assert.equal(s2.created, 0, "🔴 другий тік створив дубль");
    assert.equal((await c.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks")).rows[0].n, 4);

    // ── вихідний від БУДЬ-КОГО закриває
    await call(`${D} 10:12:00+03`, "out", "ANSWERED", 60, 2, P(1));
    const s3 = await tick(`${D} 10:13:00+03`);
    assert.equal(s3.closed, 1, "🔴 вихідний на номер не закрив задачу");
    const [t1c] = await tasksOf(P(1));
    assert.equal(t1c.status, "done");
    assert.ok(t1c.close_reason?.includes("15.09 10:12"), `🔴 причина закриття не називає вихідний: ${String(t1c.close_reason)}`);
    const log = (await c.query<{ from_status: string; to_status: string }>(
      "SELECT from_status, to_status FROM task_status_log WHERE task_id = $1 ORDER BY id", [t1.id])).rows;
    assert.deepEqual(log, [{ from_status: "not_started", to_status: "done" }], "🔴 автозакриття не лишило сліду в історії статусу");
    const s4 = await tick(`${D} 10:14:00+03`);
    assert.deepEqual([s4.closed, s4.reopened, s4.created], [0, 0, 0], "🔴 закрита задача сама смикнулась без нового дзвінка");

    // ── новий пропущений після вихідного: до порогу — ні, на порозі — перевідкриття ТІЄЇ Ж задачі
    await call(`${D} 10:20:00+03`, "in", "BUSY", 0, 1, P(1));
    assert.equal((await tick(`${D} 10:24:59+03`)).reopened, 0, "🔴 перевідкрито раніше за 5 хв");
    const s5 = await tick(`${D} 10:25:00+03`);
    assert.equal(s5.reopened, 1, "🔴 новий пропущений після вихідного не перевідкрив задачу");
    const t1r = await tasksOf(P(1));
    assert.equal(t1r.length, 1, "🔴 замість перевідкриття створено ДРУГУ задачу на той самий номер за день");
    assert.equal(t1r[0].status, "not_started");
    assert.ok(t1r[0].description.includes("2 рази"), `🔴 лічильник не зріс:\n${t1r[0].description}`);

    // ── другий пропущений того ж дня при відкритій задачі — та сама задача, лічильник 2
    await call(`${D} 10:30:00+03`, "in", "BUSY", 0, 2, P(5));
    await tick(`${D} 10:35:00+03`);
    const t5b = await tasksOf(P(5));
    assert.equal(t5b.length, 1, "🔴 другий пропущений того ж дня дав другу задачу");
    assert.ok(t5b[0].description.includes("2 рази"), `🔴 лічильник не зріс:\n${t5b[0].description}`);

    // ── видалену задачу без нового пропущеного не відроджуємо; з новим — нова задача
    const [t7] = await tasksOf(P(7));
    await c.query("DELETE FROM tasks WHERE id = $1", [t7.id]);
    assert.equal((await tick(`${D} 10:36:00+03`)).created, 0, "🔴 видалена руками задача відродилась сама");
    await call(`${D} 10:40:00+03`, "in", "NO ANSWER", 0, 1, P(7));
    assert.equal((await tick(`${D} 10:45:00+03`)).created, 1, "🔴 новий пропущений після видалення не дав сигналу");
    const led7 = (await c.query<{ task_id: number | null }>(
      "SELECT task_id FROM missed_call_tasks WHERE client_phone = $1", [P(7)])).rows;
    assert.equal(led7.length, 1);
    assert.notEqual(led7[0].task_id, null, "🔴 журнал не привʼязав нову задачу");

    // ── закриту менеджером задачу вихідний не переписує
    const [t9] = await tasksOf(P(9));
    await c.query("UPDATE tasks SET status = 'done' WHERE id = $1", [t9.id]);
    await call(`${D} 10:50:00+03`, "out", "ANSWERED", 20, 1, P(9));
    assert.equal((await tick(`${D} 10:51:00+03`)).closed, 0, "🔴 закриту менеджером задачу закрито вдруге");
    const [t9b] = await tasksOf(P(9));
    assert.equal(t9b.close_reason, null, "🔴 причину закриття менеджера переписано автоматичною");
    const led9 = (await c.query<{ closed: boolean }>(
      "SELECT closed_at IS NOT NULL AS closed FROM missed_call_tasks WHERE client_phone = $1", [P(9)])).rows[0];
    assert.equal(led9.closed, true, "🔴 журнал лишився відкритим — сигнал висітиме вічно");

    // ── київський день: 23:58 → день пропущеного, дедлайн — день тіку
    await call(`${D} 23:58:00+03`, "in", "NO ANSWER", 0, 1, P(10) + "0");
    await tick("2026-09-16 00:03:00+03");
    const led10 = (await c.query<{ kday: string }>(
      "SELECT to_char(kday,'YYYY-MM-DD') AS kday FROM missed_call_tasks WHERE client_phone = $1", [P(10) + "0"])).rows;
    assert.deepEqual(led10, [{ kday: D }], "🔴 день сигналу не київський");
    assert.equal((await tasksOf(P(10) + "0"))[0]?.deadline, "2026-09-16", "🔴 дедлайн не київське «сьогодні» тіку");
    // 00:30 за Києвом — ще 15.09 за UTC: день пропущеного мусить бути 16.09.
    await call("2026-09-16 00:30:00+03", "in", "NO ANSWER", 0, 1, "380670000011");
    await tick("2026-09-16 00:35:00+03");
    const led11 = (await c.query<{ kday: string }>(
      "SELECT to_char(kday,'YYYY-MM-DD') AS kday FROM missed_call_tasks WHERE client_phone = '380670000011'")).rows;
    assert.deepEqual(led11, [{ kday: "2026-09-16" }], "🔴 день пропущеного рахується не за Києвом — після опівночі задача ляже у вчора");

    // ── новий день — нова задача на той самий номер
    await call("2026-09-16 09:00:00+03", "in", "NO ANSWER", 0, 2, P(5));
    assert.equal((await tick("2026-09-16 09:05:00+03")).created, 1, "🔴 новий день не дав нової задачі");
    assert.equal((await tasksOf(P(5))).length, 2, "🔴 на номер за два дні має бути дві задачі");
  } finally {
    await c.end();
  }
});

/**
 * #458 — ПРОВОДКА: частий синк і сигнал ідуть ОДНИМ кроном, синк ПЕРЕД сигналом, із
 * межею звʼязування; обидві джоби під наглядом із частотою, що дорівнює крону.
 * Крон читаємо з ДЖЕРЕЛА: розбіжність джерела й реєстру і є предметом (як `#115b`).
 */
test("#458 ПРОВОДКА: крон частого синку → сигнал, обидва під наглядом із частотою крону", async () => {
  const src = SRC("index.ts");
  const fresh = src.indexOf('runJob("syncCallsFresh"');
  const signal = src.indexOf('runJob("missedCallTasks"');
  assert.ok(fresh > 0 && signal > 0, "🔴 частий синк або сигнал не запускаються з index.ts");
  assert.ok(fresh < signal, "🔴 сигнал іде ДО синку — задачі рахуються по даних пʼятихвилинної давності плюс годинна затримка");
  const head = src.slice(0, fresh);
  const spec = [...head.matchAll(/cron\.schedule\("([^"]+)"/g)].pop()?.[1];
  const blockEnd = src.indexOf("});", fresh);
  assert.ok(signal < blockEnd, "🔴 сигнал запускається не в тому самому кроні, що частий синк");
  assert.match(src.slice(fresh, signal), /syncCalls\(1, \{ boundLink: true \}\)/, "🔴 частий синк без межі звʼязування — два повні UPDATE щопʼять хвилин");
  assert.ok(spec, "🔴 не знайдено cron.schedule перед частим синком");
  // 🔴 ХВИЛИНИ БЕРЕМО В САМОЇ БІБЛІОТЕКИ, А НЕ З ТЕКСТУ. «2-59/5» на вигляд — «:02, :07 …»,
  // а node-cron 3.0.3 стріляє ним на :05, :10 … (заміряно 16.09.2026). Розбір тексту цю
  // різницю не бачить за побудовою. Шлях до матчера внутрішній: оновлення бібліотеки
  // зламає гейт ГОЛОСНО — і це правильно, бо тоді перевіряти розклад треба заново.
  const { createRequire } = await import("node:module");
  const TimeMatcher = createRequire(import.meta.url)("node-cron/src/time-matcher.js") as
    new (p: string) => { match(d: Date): boolean };
  const tm = new TimeMatcher(`0 ${spec}`);
  const minutes = Array.from({ length: 60 }, (_, i) => i).filter((i) => tm.match(new Date(2026, 8, 16, 10, i, 0)));
  assert.ok(minutes.length >= 2, `🔴 крон «${spec}» стріляє на хвилинах [${minutes.join(",")}] — це не частий синк`);
  const gaps = minutes.map((x, i) => ((minutes[(i + 1) % minutes.length] - x + 60) % 60) || 60);
  assert.equal(new Set(gaps).size, 1, `🔴 крон «${spec}» стріляє нерівно: [${minutes.join(",")}]`);
  const step = gaps[0];
  assert.equal(minutes.includes(0), false,
    `🔴 крон «${spec}» стріляє на :00 — разом із syncKommo і рештою годинних джоб [${minutes.join(",")}]`);

  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  for (const name of ["syncCallsFresh", "missedCallTasks"]) {
    const j = MONITORED_JOBS.find((x) => x.name === name);
    assert.ok(j, `🔴 «${name}» не під наглядом — її мовчання не побачить ніхто`);
    assert.equal(j.everyMin, step, `🔴 «${name}»: реєстр каже ${String(j.everyMin)} хв, крон — ${String(step)}`);
  }
});
