import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import {
  lastOrderDate, colorOf, workVerdict, handOverDue, becameRepeatIn, lostIn, repeatSource, daysBetween,
  type WorkFacts,
} from "./clientLeadRules.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * #3443 🪞 — КОЛІР ЛИШЕ ВІД ЗАМОВЛЕННЯ (задача 7360, ТЗ Юлі 28.10, етап 2): по обидва боки кожної межі сегмента
 * (ВІП 14, регулярний 30, епізодичний і без історії 60, червоний 180), і замовлення = свіжіше з рахунку й оплати —
 * випадок СМАР ТЕКС із ТЗ: оплата давня, рахунок 20.10 → зелений.
 * 🧨 Червоніє, якщо колір рахуватиметься від самої оплати (СМАР ТЕКС стане жовтим) або з’їде будь-яка межа.
 */
test("#3443 🪞 КОЛІР: межі сегментів по обидва боки; замовлення = свіжіше з рахунку й оплати (СМАР ТЕКС — зелений)", () => {
  for (const [seg, lim] of [["vip", 14], ["regular", 30], ["episodic", 60], ["unknown", 60]] as const) {
    assert.equal(colorOf(seg, lim - 1), "green", `🔴 ${seg}: ${lim - 1} дн. уже не зелений`);
    assert.equal(colorOf(seg, lim), "yellow", `🔴 ${seg}: ${lim} дн. ще не жовтий`);
    assert.equal(colorOf(seg, 179), "yellow");
    assert.equal(colorOf(seg, 180), "red", `🔴 ${seg}: 180 дн. не червоний`);
  }
  assert.equal(colorOf("regular", null), "red", "🔴 клієнт без жодного замовлення не червоний");
  assert.equal(lastOrderDate("2026-06-01", "2026-10-20"), "2026-10-20", "🔴 рахунок свіжіший за оплату, а колір бере оплату");
  assert.equal(lastOrderDate("2026-10-25", "2026-10-20"), "2026-10-25");
  assert.equal(lastOrderDate(null, "2026-10-20"), "2026-10-20");
  assert.equal(lastOrderDate(null, null), null);
  const smar = daysBetween(lastOrderDate("2026-06-01", "2026-10-20")!, "2026-11-06");
  assert.equal(colorOf("regular", smar), "green", "🔴 СМАР ТЕКС із рахунком у жовтні — не зелений (ТЗ «Готово, коли»)");
  assert.equal(colorOf("regular", daysBetween("2026-06-01", "2026-11-06")), "yellow", "фікстура: від самої оплати він був би жовтим");
});

const none: WorkFacts = { talk10: null, stage: null, comment: null, contact: null, payment: null };

/**
 * #3444 🪞 — «ПРАЦЮЮТЬ З КЛІЄНТОМ» ЗА ВІКНО СЕГМЕНТА: кожен із п'яти доказів рахується (розмова від 10 с, рух угоди,
 * коментар, контакт, оплата у Виписці); подія на межі вікна — у вікні, на день старша — ні; найсвіжіший доказ
 * названо; майбутня дата не рахується; вікно — за сегментом (ВІП 14 проти епізодичного 60).
 * 🧨 Червоніє, якщо будь-який доказ випаде, межа вікна зсунеться або вікно перестане залежати від сегмента.
 */
test("#3444 🪞 «ПРАЦЮЮТЬ»: п'ять доказів, межа вікна по обидва боки, найсвіжіший доказ, вікно за сегментом", () => {
  const T = "2026-11-06";
  assert.deepEqual(workVerdict(none, "regular", T), { yes: false, by: null, at: null, windowDays: 30 });
  for (const k of ["talk10", "stage", "comment", "contact", "payment"] as const) {
    assert.equal(workVerdict({ ...none, [k]: "2026-11-01" }, "regular", T).yes, true, `🔴 доказ «${k}» не рахується як робота`);
  }
  assert.equal(workVerdict({ ...none, talk10: "2026-10-07" }, "regular", T).yes, true, "🔴 подія рівно на межі 30 дн. — поза вікном");
  assert.equal(workVerdict({ ...none, talk10: "2026-10-06" }, "regular", T).yes, false, "🔴 подія 31 дн. тому — досі «працюють»");
  assert.equal(workVerdict({ ...none, talk10: "2026-11-10" }, "regular", T).yes, false, "🔴 майбутня дата рахується як робота");
  const v = workVerdict({ ...none, talk10: "2026-10-20", comment: "2026-11-03", stage: "2026-10-30" }, "regular", T);
  assert.deepEqual([v.by, v.at], ["comment", "2026-11-03"], "🔴 названо не найсвіжіший доказ");
  assert.equal(workVerdict({ ...none, stage: "2026-10-01" }, "vip", T).yes, false, "🔴 ВІП: 36 дн. тому — досі «працюють» (вікно 14)");
  assert.equal(workVerdict({ ...none, stage: "2026-10-01" }, "episodic", T).yes, true, "🔴 епізодичний: вікно не 60");
});

/**
 * #3445 🪞 — ПРАВИЛО СЕРГІЯ «ПЕРЕДАТИ ІНШОМУ»: лише жовтий/червоний, лише з відкритою задачею, лише коли дедлайн
 * МИНУВ, і лише коли розмови від 10 с ПІСЛЯ постановки задачі не було. Кожна умова — по обидва боки.
 * 🧨 Червоніє, якщо позначка зʼявиться в зеленого, без задачі, у день дедлайну, або якщо давня розмова (до задачі)
 * її гаситиме.
 */
test("#3445 🪞 «ПЕРЕДАТИ ІНШОМУ»: жовтий/червоний + задача + дедлайн минув + розмови після задачі не було", () => {
  const base = { color: "yellow" as const, taskOpen: true, taskDeadline: "2026-11-05", taskCreated: "2026-11-01", talk10: null, today: "2026-11-06" };
  assert.equal(handOverDue(base), true, "🔴 дедлайн минув, розмови не було — позначки немає");
  assert.equal(handOverDue({ ...base, color: "red" }), true);
  assert.equal(handOverDue({ ...base, color: "green" }), false, "🔴 зелений позначений «передати»");
  assert.equal(handOverDue({ ...base, taskOpen: false }), false, "🔴 без задачі позначено «передати»");
  assert.equal(handOverDue({ ...base, taskDeadline: null }), false);
  assert.equal(handOverDue({ ...base, taskDeadline: "2026-11-06" }), false, "🔴 у день дедлайну вже «передати»");
  assert.equal(handOverDue({ ...base, talk10: "2026-11-02" }), false, "🔴 подзвонили після задачі, а позначка лишилась");
  assert.equal(handOverDue({ ...base, talk10: "2026-11-01" }), false, "🔴 розмова в день постановки задачі не рахується");
  assert.equal(handOverDue({ ...base, talk10: "2026-10-30" }), true, "🔴 давня розмова (до задачі) гасить позначку");
});

/**
 * #3446 🪞 — ЛІЧИЛЬНИКИ ВГОРІ: новий постійний = друга оплата в цьому місяці; втрачений за місяць = 180-й день без
 * замовлення в цьому місяці; звідки — лідогенерація першою, далі реклама за каналом першої оплати, решта — менеджер.
 * 🧨 Червоніє, якщо межа місяця зсунеться або лідогенерацію перекриє канал «реклама».
 */
test("#3446 🪞 ЛІЧИЛЬНИКИ: новий постійний, втратили за місяць, звідки — по обидва боки", () => {
  assert.equal(becameRepeatIn("2026-11-01", "2026-11"), true);
  assert.equal(becameRepeatIn("2026-10-31", "2026-11"), false, "🔴 друга оплата в жовтні — «новий постійний листопада»");
  assert.equal(becameRepeatIn(null, "2026-11"), false);
  assert.equal(lostIn("2026-05-05", "2026-11"), true, "🔴 180-й день 01.11 — не «втратили в листопаді»");
  assert.equal(lostIn("2026-05-04", "2026-11"), false, "🔴 180-й день 31.10 — уже «втратили в листопаді»");
  assert.equal(lostIn("2026-06-03", "2026-11"), true, "фікстура: 180-й день 30.11 — ще листопад");
  assert.equal(lostIn("2026-06-04", "2026-11"), false);
  assert.equal(lostIn(null, "2026-11"), false);
  assert.equal(repeatSource(true, "ad"), "leadgen", "🔴 лідогенерацію перекрив канал «реклама»");
  assert.equal(repeatSource(false, "ad"), "ad");
  assert.equal(repeatSource(false, "leadgen"), "manager", "мітка каналу без реєстру LTV — не доказ лідогенерації");
  assert.equal(repeatSource(false, null), "manager");
});

/**
 * #3447 — ЖИВИЙ SQL фактів на порожньому кластері: розмова від 10 с рахується, 9 с — ні, номер перевізника — ні;
 * суть — з останньої розібраної AI розмови; рух угоди; друга оплата й канал першої; клієнт із реєстру LTV лідгенів.
 * 🧨 Червоніє, якщо поріг 10 с, фільтр перевізника чи вибір «другої» оплати зламаються в SQL.
 */
test("#3447 ЖИВИЙ SQL: факти екрана тімліда — 10 с, перевізник, суть AI, рух угоди, друга оплата, лідоген", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO pipeline_stage_map(pipeline_id,status_id,funnel_stage) VALUES (1,142,'paid'),(1,10,'lead_taken') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO deals(kommo_id,client_key,pipeline_id,status_id,closed_at_kommo,lead_channel) VALUES
      (1,'а',1,142,'2026-03-01T10:00:00Z','ad'),(2,'а',1,142,'2026-11-02T10:00:00Z','other'),(3,'а',1,10,NULL,NULL),
      (4,'б',1,142,'2026-01-01T10:00:00Z','ad')`);
    await c.query(`INSERT INTO deal_stage_events(kommo_id,status_id,pipeline_id,changed_at) VALUES (3,10,1,'2026-11-04T09:00:00Z')`);
    await c.query(`INSERT INTO carrier_phones(p9,via_lardi,via_history) VALUES ('987654321',true,false)`);
    await c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,billsec,client_key,client_phone) VALUES
      ('u1','2026-11-03T08:00:00Z','out',10,'а','380501112233'),
      ('u2','2026-11-05T08:00:00Z','out',9,'а','380501112233'),
      ('u3','2026-11-05T09:00:00Z','out',300,'а','380987654321'),
      ('u4','2026-10-01T08:00:00Z','in',60,'б','380671112233')`);
    await c.query(`INSERT INTO call_transcripts(id,uniqueid,provider,model,status) VALUES (1,'u1','p','m','done'),(2,'u3','p','m','done')`);
    await c.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result) VALUES
      (1,'p','m','v1','done','{"summary":"Клієнт чекає ціну на Київ–Львів"}'),(2,'p','m','v1','done','{"summary":"перевізник"}')`);
    await c.query(`INSERT INTO leadgen_ltv_clients(client_key,pz_id,handoff_day,first_deal_id,first_day,deals,ltv) VALUES ('б',9,'2025-12-01',4,'2026-01-01',1,0)`);
    const { leadFactsFor } = await import("./clientLeadFacts.js");
    const f = await leadFactsFor(c, ["а", "б", "в"], 100000);
    const a = f.get("а")!, b = f.get("б")!;
    assert.equal(a.talk10, "2026-11-03", "🔴 розмова 9 с або з перевізником рахується як розмова від 10 с");
    assert.deepEqual(a.summary, { at: "2026-11-03", text: "Клієнт чекає ціну на Київ–Львів" }, "🔴 суть узято не з тієї розмови");
    assert.equal(a.stage, "2026-11-04", "🔴 рух угоди не видно");
    assert.equal(a.secondPaid, "2026-11-02", "🔴 «друга оплата» — не друга за часом");
    assert.equal(a.firstPaidChannel, "ad");
    assert.equal(a.leadgen, false);
    assert.equal(b.secondPaid, null, "🔴 одна оплата дала «другу»");
    assert.equal(b.leadgen, true, "🔴 клієнт із реєстру LTV лідгенів не позначений");
    assert.equal(b.talk10, "2026-10-01");
    assert.equal(f.has("в"), false);
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #3448 — ПРОВОДКА: рядок `/client-plans` несе `lead` з ядра (колір, «працюють», «передати», лічильники); вкладка
 * «З ким говорити» — перша й типова; екран не має власного правила (колір і доказ — з `row.lead`, порогів у ньому немає).
 * 🧨 Червоніє, якщо роут почне рахувати колір сам, вкладка зникне з типової, або фронт зашиє межі сегментів.
 */
test("#3448 ПРОВОДКА: lead у рядку /client-plans з ядра; вкладка «З ким говорити» типова; фронт без власного правила", () => {
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const route = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'), dash.indexOf("\ndashboardRouter.", dash.indexOf('dashboardRouter.get("/client-plans"') + 10));
  for (const fn of ["lastOrderDate(", "colorOf(", "workVerdict(", "handOverDue(", "becameRepeatIn(", "repeatSource(", "lostIn("]) {
    assert.ok(route.includes(`clientLeadRules.${fn}`), `🔴 /client-plans не кличе clientLeadRules.${fn}`);
  }
  assert.match(route, /clientLeadRules\.lastOrderDate\(c\.last_paid, lastInvByKey\.get\(c\.client_key\) \?\? null\)/,
    "🔴 колір рахується без рахунку — СМАР ТЕКС із рахунком у жовтні знову не зелений");
  assert.match(route, /const leadFacts = await clientLeadFacts\.leadFactsFor\(pool, rosterRows\.map/, "🔴 факти беруться не для всього ростеру");
  const loy = codeOnly(read("frontend/src/pages/dashboard/sections/LoyaltySection.tsx"));
  assert.match(loy, /\{ key: "lead", label: "З ким говорити" \},\n\s*\{ key: "plan"/, "🔴 вкладка «З ким говорити» не перша");
  assert.match(loy, /: "lead";\n\}/, "🔴 типова вкладка — не «З ким говорити»");
  assert.match(loy, /if \(t === "react"\) return "plan";/, "🔴 старе посилання ?tab=react більше не веде на таблицю");
  const fe = codeOnly(read("frontend/src/pages/dashboard/sections/ClientLeadSection.tsx"));
  assert.match(fe, /c\.lead\.color === k/, "🔴 групи не за кольором із сервера");
  assert.doesNotMatch(fe, /(>=|<=|>|<)\s*(14|30|60|180)\b/, "🔴 фронт рахує межі сегментів сам");
});
