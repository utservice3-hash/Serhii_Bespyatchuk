import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  pickHandoffs, classifyHandoffs, aggregateHandoffMoney, handoffView, managerDealClass,
  handoffDealsScope, trendWindow, parseTrendMonths, parseLeadgenGrain, parseManagerIdParam,
  personMoneyWire, emptyHandoffMoney,
  type HandoffEntry, type DealState, type ClassRules, type LeadgenHandoffMoney,
} from "./leadgenHandoffRules.js";
import { CLOSED_STATUSES, RECEIVED_STATUSES, AWAITING_STATUSES, STATUS_LOST } from "./moneyBuckets.js";

/**
 * #670…#674, #680 — ГРОШІ З ПЕРЕДАНИХ ЛІДІВ: чисті правила (рішення власника 22.09.2026).
 *
 * Усі гейти тут біжать БЕЗ бази: правила вибору передачі, «тієї самої угоди», класу угоди
 * менеджера, скоупу й межі тімліда — чисті функції. Кожна фікстура тримає приклад по ОБИДВА
 * боки межі, яку стереже (♾ правило 11): інакше гейт доводив би лише «щось повертає».
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0);
const at = (min: number) => T0 + min * 60_000;
const e = (pzId: number, lgId: number, min: number, dealId: number | null, lgTeamId: number | null = 1): HandoffEntry =>
  ({ pzId, lgId, lgTeamId, at: at(min), day: "2026-09-01", dealId });
const st = (cls: DealState["cls"], price: number): DealState => ({ cls, price });

/**
 * #670 — ОДНА ПЕРЕДАЧА НА УГОДУ ПРОДЗВОНУ; УГОДА МЕНЕДЖЕРА — З ПЕРШОГО ЗВʼЯЗАНОГО ВХОДУ.
 *
 * Обидва боки: (а) перший вхід порожній, другий знайшов угоду → береться ДРУГИЙ (інакше
 * передача, що таки створила угоду, читалась би «без угоди менеджера»); (б) обидва входи з
 * угодами → береться ПЕРШИЙ, а не останній; (в) жодного звʼязаного → перший, без угоди.
 * 🧨 САБОТАЖ: у `pickHandoffs` брати `first` замість `linked ?? first` → червоніє (а).
 */
test("#670 ОДНА ПЕРЕДАЧА НА УГОДУ ПРОДЗВОНУ: угода менеджера — з першого ЗВʼЯЗАНОГО входу", () => {
  const picked = pickHandoffs([
    e(101, 7, 0, null), e(101, 7, 30, 9001),          // (а) порожній, потім звʼязаний
    e(102, 7, 5, 9002), e(102, 7, 40, 9003),          // (б) обидва звʼязані
    e(103, 7, 10, null), e(103, 7, 50, null),         // (в) жодного
  ]);
  assert.equal(picked.length, 3, "🔴 передач не рівно по одній на угоду Продзвону — прорахунки розійдуться з передачами");
  const by = new Map(picked.map((p) => [p.pzId, p]));
  assert.equal(by.get(101)!.dealId, 9001, "🔴 повторний вхід, що створив угоду, програв порожньому першому");
  assert.equal(by.get(102)!.dealId, 9002, "🔴 з двох звʼязаних входів узято не ПЕРШИЙ");
  assert.equal(by.get(103)!.dealId, null, "🔴 без жодної угоди менеджера передача мусить лишитись «без угоди»");
  assert.equal(by.get(103)!.at, at(10), "🔴 передача без угоди — не з першого входу");
  // Порядок — за моментом ОБРАНОГО входу: від нього залежить, хто забере «ту саму угоду».
  assert.deepEqual(picked.map((p) => p.pzId), [102, 103, 101], "🔴 порядок передач не за часом обраного входу");
});

/**
 * #670b — «ТА САМА УГОДА» І «БЕЗ УГОДИ»: гроші не двояться, підсумок сходиться до передач.
 *
 * Дві передачі ведуть в одну угоду менеджера: гроші — лише в першої за часом, друга — `same`.
 * Тотожність `handoffs = unlinked + sameDeal + lost + Σn` мусить триматись; `priced` рахує
 * лише ненульові бюджети. Дзеркало: різні угоди — жодної `same`.
 * 🧨 САБОТАЖ: у `classifyHandoffs` прибрати перевірку `seen` → сума подвоюється, червоніє.
 */
test("#670b «ТА САМА УГОДА» І «БЕЗ УГОДИ»: гроші не двояться, підсумок сходиться до передач", () => {
  const states = new Map<number, DealState>([
    [9001, st("success", 30_000)], [9004, st("work", 0)], [9005, st("lost", 12_000)], [9006, st("expect", -500)],
  ]);
  const rows = classifyHandoffs(pickHandoffs([
    e(201, 7, 0, 9001), e(202, 8, 1, 9001),          // друга передача — у вже пораховану угоду
    e(203, 7, 2, null), e(204, 7, 3, 9004), e(205, 7, 4, 9005), e(206, 7, 5, 9006),
  ]), states);
  assert.deepEqual(rows.map((r) => r.cls), ["success", "same", "none", "work", "lost", "expect"]);
  const m = aggregateHandoffMoney(rows);
  assert.equal(m.success.sum, 30_000, "🔴 гроші угоди пораховано двічі — «та сама угода» не спрацювала");
  assert.equal(m.sameDeal, 1);
  assert.equal(m.unlinked, 1);
  assert.equal(m.lost, 1, "🔴 програна угода не в «програно»");
  assert.deepEqual(m.work, { n: 1, sum: 0, priced: 0 }, "🔴 угода без бюджету порахована як «з бюджетом»");
  assert.deepEqual(m.expect, { n: 1, sum: -500, priced: 1 }, "🔴 мінусовий бюджет — теж бюджет, і він зі знаком");
  const parts = m.unlinked + m.sameDeal + m.lost + m.success.n + m.paid.n + m.expect.n + m.work.n;
  assert.equal(m.handoffs, parts, "🔴 підсумок не сходиться до числа передач — щось випало або задвоїлось");
  assert.equal(m.handoffs, 6);
  // 🪞 Дзеркало: різні угоди — жодної «тієї самої».
  const other = classifyHandoffs(pickHandoffs([e(211, 7, 0, 9001), e(212, 7, 1, 9004)]), states);
  assert.deepEqual(other.map((r) => r.cls), ["success", "work"], "🔴 «та сама угода» там, де угоди різні");
  // Угода без стану — голосна помилка, а не вигаданий «в роботі».
  assert.throws(() => classifyHandoffs([e(221, 7, 0, 7777)], states), /7777/);
});

/**
 * #671 — КЛАС УГОДИ МЕНЕДЖЕРА ЗАРАЗ (правило 4): межі з обох боків.
 *
 * Правила беруться з реєстру корзин (`moneyBuckets`), який `#45c` звіряє з константами
 * `money.ts`/`metrics.ts`, — а не з копії, написаної тут.
 * 🧨 САБОТАЖ: прибрати `&& d.closed` у гілці `success` → 142 без `closed_at` стає «успіхом», червоніє.
 */
test("#671 КЛАС УГОДИ МЕНЕДЖЕРА: успіх лише з closed_at, списане → програно, Кваліфікація 142 → в роботі", () => {
  const R: ClassRules = {
    fcPipelines: [8921932, 155304], success: CLOSED_STATUSES, paid: RECEIVED_STATUSES,
    expectZone: AWAITING_STATUSES, lostStatus: STATUS_LOST,
  };
  const c = (pipelineId: number, statusId: number, closed = false, writtenOff = false) =>
    managerDealClass({ pipelineId, statusId, closed, writtenOff }, R);
  // success: 142 повного циклу — ЛИШЕ з closed_at (як success у moneySourceSql)
  assert.equal(c(8921932, 142, true), "success");
  assert.equal(c(8921932, 142, false), "work", "🔴 142 без closed_at порахований успіхом — ядро його не рахує");
  // paid: етап 9 обох воронок
  assert.equal(c(8921932, 69716460), "paid");
  assert.equal(c(155304, 60412544), "paid");
  // expect ↔ списаний борг
  assert.equal(c(8921932, 69716312, false, false), "expect");
  assert.equal(c(8921932, 100274340, false, false), "expect", "🔴 «Виставлення рахунку» — у зоні «Очікуємо» (рішення 06.08)");
  assert.equal(c(8921932, 69716312, false, true), "lost", "🔴 списаний борг лишився «очікуваним» — як до 26.08");
  // lost: 143 будь-якої воронки; Кваліфікація
  assert.equal(c(8921932, 143), "lost");
  assert.equal(c(8921928, 143), "lost", "🔴 «Не цільові» Кваліфікації — не програш");
  assert.equal(c(7336928, 143), "lost", "🔴 «Сміття» старої Кваліфікації — не програш");
  assert.equal(c(8921928, 142, true), "work", "🔴 142 Кваліфікації — ще НЕ повний цикл, а його порахували успіхом");
  // work: відкриті стадії обох видів
  assert.equal(c(8921932, 69693668), "work");
  assert.equal(c(8921928, 69716164), "work");
  // Списаний прапорець поза зоною нічого не міняє — він лише про «очікуване».
  assert.equal(c(8921932, 142, true, true), "success");
});

/**
 * #672 — СКОУП ЗВУЖУЄ ВІДПОВІДЬ, А НЕ РОЗРАХУНОК: гроші людини однакові у відділі й у тімліда.
 *
 * Фікстура саме та, на якій фільтр ДО дедупу бреше: людина 8 (команда 2) передала лід, що
 * привів в угоду 9001, яку ПЕРШОЮ за часом уже забрала передача людини 7 (команда 1).
 * У відділі передача 8 — `same`; якби тімлід 2 фільтрував домен ДО вибору, вона стала б
 * «успішною на 30 000». Кожна відповідь окремо виглядала б правильною.
 * 🧨 САБОТАЖ: у `handoffView` фільтрувати `domain` до `pickHandoffs` → червоніє.
 */
test("#672 СКОУП ЗВУЖУЄ ВІДПОВІДЬ, А НЕ РОЗРАХУНОК: гроші людини однакові у відділі й у тімліда", () => {
  const states = new Map<number, DealState>([[9001, st("success", 30_000)], [9002, st("paid", 4_000)]]);
  const domain = [
    e(301, 7, 0, 9001, 1),     // команда 1 — перша в угоду 9001
    e(302, 8, 3, 9001, 2),     // команда 2 — друга в ту саму угоду → same
    e(303, 8, 5, 9002, 2),
  ];
  const dept = handoffView(domain, states, { teamId: null, managerId: null });
  const team2 = handoffView(domain, states, { teamId: 2, managerId: null });
  const person8 = handoffView(domain, states, { teamId: null, managerId: 8 });
  const of = (v: typeof dept, id: number): LeadgenHandoffMoney =>
    v.byPerson.find((p) => p.managerId === id)?.money ?? emptyHandoffMoney();
  assert.deepEqual(of(team2, 8), of(dept, 8),
    "🔴 гроші людини в скоупі тімліда інші, ніж у відділі — фільтр стоїть ДО вибору/дедупу");
  assert.deepEqual(person8.totals, of(dept, 8), "🔴 список однієї людини розійшовся з її рядком у відділі");
  assert.equal(of(dept, 8).sameDeal, 1, "фікстура мусить тримати «ту саму угоду» — інакше доводити нічого");
  assert.equal(of(dept, 8).success.sum, 0);
  assert.equal(team2.totals.handoffs, 2);
});

/** #672b — 🪞 ДЗЕРКАЛО: скоуп тімліда таки відсікає чужу команду, а відділ — ні. */
test("#672b 🪞 ДЗЕРКАЛО: скоуп тімліда відсікає чужу команду, відділ бачить усіх", () => {
  const states = new Map<number, DealState>([[9001, st("success", 30_000)], [9002, st("paid", 4_000)]]);
  const domain = [e(301, 7, 0, 9001, 1), e(303, 8, 5, 9002, 2)];
  const team2 = handoffView(domain, states, { teamId: 2, managerId: null });
  assert.deepEqual(team2.byPerson.map((p) => p.managerId), [8], "🔴 тімлід бачить людину з чужої команди");
  assert.equal(team2.totals.success.sum, 0, "🔴 гроші чужої команди в підсумку тімліда");
  const dept = handoffView(domain, states, { teamId: null, managerId: null });
  assert.deepEqual(dept.byPerson.map((p) => p.managerId), [7, 8], "🔴 відділ не бачить усіх людей");
  assert.equal(dept.totals.success.sum + dept.totals.paid.sum, 34_000);
  // Форма відповіді — явними полями: жодного зайвого ключа не поїде назовні.
  assert.deepEqual(Object.keys(personMoneyWire(8, team2.totals)).sort(),
    ["expect", "handoffs", "lost", "managerId", "paid", "sameDeal", "success", "unlinked", "work"]);
});

/**
 * #673 — МЕЖА СПИСКУ ПЕРЕДАЧ: тімлід і чужий `managerId` → 403; свій — пропуск (обидва боки).
 * 🧨 САБОТАЖ: у `handoffDealsScope` для тімліда не перевіряти команду → червоніє.
 */
test("#673 ТІМЛІД І ЧУЖИЙ managerId → 403; свій — пропуск; менеджер — 403", () => {
  const lead = { role: "team_lead", teamId: 5 };
  assert.deepEqual(handoffDealsScope(lead, 44, 6), { ok: false, status: 403 },
    "🔴 тімлід відкрив список людини з ЧУЖОЇ команди");
  assert.deepEqual(handoffDealsScope(lead, 44, undefined), { ok: false, status: 403 },
    "🔴 невідома людина для тімліда — не порожній список, а 403");
  assert.deepEqual(handoffDealsScope(lead, 44, 5), { ok: true, scope: { teamId: 5, managerId: 44 } },
    "🔴 тімлід не бачить СВОЄЇ людини");
  assert.deepEqual(handoffDealsScope(lead, null, null), { ok: true, scope: { teamId: 5, managerId: null } },
    "🔴 без managerId тімлід мусить отримати свою команду, а не відділ");
  assert.deepEqual(handoffDealsScope({ role: "team_lead", teamId: null }, null, null),
    { ok: true, scope: { teamId: -1, managerId: null } }, "🔴 тімлід без команди отримав відділ");
  assert.deepEqual(handoffDealsScope({ role: "manager", teamId: 5 }, null, null), { ok: false, status: 403 });
  assert.deepEqual(handoffDealsScope({ role: "admin", teamId: null }, 44, 6), { ok: true, scope: { teamId: null, managerId: 44 } },
    "🔴 адмін не бачить людини з будь-якої команди");
});

/**
 * #674 — ВІКНО ТРЕНДУ Й ПАРАМЕТРИ: місяці від 1-го, 31-ше не перескакує; межі параметрів.
 *
 * `setUTCMonth` від 31-го числа перескакує місяць (борг 19 кореня) — тут місяці цілими числами.
 * 🧨 САБОТАЖ: `trendWindow` рахувати через `new Date(to).setUTCMonth(...)` → 31.03 дає пропуск.
 */
test("#674 ВІКНО ТРЕНДУ: місяці від 1-го, 31-ше не перескакує; months 1…24; grain лише день/тиждень", () => {
  assert.deepEqual(trendWindow("2026-03-31", 2).monthStarts, ["2026-02-01", "2026-03-01"],
    "🔴 від 31 березня вікно перескочило лютий");
  const y = trendWindow("2026-09-30", 12);
  assert.equal(y.from, "2025-10-01");
  assert.equal(y.monthStarts.length, 12);
  assert.equal(new Set(y.monthStarts).size, 12, "🔴 місяць повторився у вікні");
  assert.deepEqual(trendWindow("2026-01-15", 1).monthStarts, ["2026-01-01"]);
  assert.deepEqual(trendWindow("2026-01-31", 3).monthStarts, ["2025-11-01", "2025-12-01", "2026-01-01"], "🔴 межа року");
  assert.equal(trendWindow("2026-09-30", 99).months, 24);
  assert.equal(trendWindow("2026-09-30", 0).months, 1);
  // Параметри: порожнє — «не задано»; поза межами — обрізка; не число — 400.
  assert.equal(parseTrendMonths(undefined), 12);
  assert.equal(parseTrendMonths(""), 12);
  assert.equal(parseTrendMonths("36"), 24);
  assert.equal(parseTrendMonths("0"), 1);
  assert.equal(parseTrendMonths("6"), 6);
  assert.equal(parseTrendMonths("6.5"), null);
  assert.equal(parseTrendMonths("abc"), null);
  assert.equal(parseTrendMonths(["6", "7"]), null, "🔴 повторений параметр прочитано як число");
  assert.equal(parseLeadgenGrain(undefined), null);
  assert.equal(parseLeadgenGrain(""), null);
  assert.equal(parseLeadgenGrain("week"), "week");
  assert.equal(parseLeadgenGrain("day"), "day");
  assert.equal(parseLeadgenGrain("month"), "bad", "🔴 місяць у /leadgen-stats — не розбивка періоду");
  assert.equal(parseManagerIdParam(""), null);
  assert.equal(parseManagerIdParam("42"), 42);
  assert.equal(parseManagerIdParam("0"), "bad");
  assert.equal(parseManagerIdParam("-3"), "bad");
  assert.equal(parseManagerIdParam("4x"), "bad");
});

/**
 * #680 — ЧИСТІ МОДУЛІ ГРОШЕЙ З ПЕРЕДАЧ: без `funnel_stage`, без числових id стадій, без імпортів.
 *
 * Той самий вирок, що `#365` для `leadgenStats.ts`, — на нові модулі, куди переїхав SQL:
 * `funnel_stage` склеює «ОПР» і «Кваліфіковано», а вписаний числом id — друга копія правила.
 * 🧨 САБОТАЖ: вписати `69693696` у `leadgenSql.ts` → червоніє.
 */
test("#680 ЧИСТІ МОДУЛІ ГРОШЕЙ З ПЕРЕДАЧ: без funnel_stage, без числових id стадій, без імпортів", () => {
  for (const rel of ["core/leadgenSql.ts", "core/leadgenHandoffRules.ts"]) {
    const raw = SRC(rel);
    assert.ok(raw.length > 1000, `🔴 ${rel} не прочитався — гейту нема що перевіряти`);
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(/export function/.test(code), `🔴 після зрізання коментарів у ${rel} не лишилось коду`);
    assert.ok(!/funnel_stage/.test(code), `🔴 ${rel} читає funnel_stage — ОПР і прорахунки склеяться`);
    assert.ok(!/\b(69693696|69716492|69693740|8921936|7337048|8921948|8921928|7336928|8921932|155304)\b/.test(code),
      `🔴 ${rel}: id стадії/воронки вписаний числом — друга копія правила розійдеться тихо`);
    assert.deepEqual(code.split("\n").filter((l) => /^\s*import\s/.test(l)), [], `🔴 ${rel} обзавівся імпортом`);
  }
  // 🪞 Дзеркало: `status_id = 142` без імені — теж число; воно мусить іти параметром.
  assert.ok(!/status_id\s*(=|IN)\s*\(?\s*14[23]\b/.test(SRC("core/leadgenSql.ts")),
    "🔴 142/143 вписано в SQL числом — «Кваліфіковано» має йти іменованою константою");
});
