import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  pickHandoffs, classifyHandoffs, aggregateHandoffMoney, handoffView, managerDealClass,
  handoffDealsScope, leadgenAuthScope, trendWindow, parseTrendMonths, parseLeadgenGrain, parseManagerIdParam,
  personMoneyWire, emptyHandoffMoney, mergeBucketRows, assembleTrend, sumBuckets, handoffDealRow,
  type StageBucketRow, type CallBucketRow, type HandoffLinkInfo, type HandoffRowDeps, type LeadgenDealClass, type HandoffEntry, type DealState, type LeadgenHandoffMoney,
} from "./leadgenHandoffRules.js";
import { HANDOFF_CLASS_RULES } from "./moneyBuckets.js";
import { isRegularAt, monthsBackDay, REGULAR_MIN_SUCCESSES, REGULAR_FRESH_MONTHS, handoffMoneyBuckets, mondayOf, dayInRange, pendingIn, type ClientSuccess } from "./leadgenHandoffRules.js";

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
 * Правила — ТОЙ САМИЙ обʼєкт `HANDOFF_CLASS_RULES`, що `money.handoffDealStates` передає в
 * `managerDealClass` (ревʼю F3: раніше тест складав свій, а ядро — свій). Його поля з
 * константами ядра звіряє `#683`; увесь ланцюг на тимчасовій базі — `#683b`.
 * 🧨 САБОТАЖ: прибрати `&& d.closed` у гілці `success` → 142 без `closed_at` стає «успіхом», червоніє.
 */
test("#671 КЛАС УГОДИ МЕНЕДЖЕРА: успіх лише з closed_at, списане → програно, Кваліфікація 142 → в роботі", () => {
  const c = (pipelineId: number, statusId: number, closed = false, writtenOff = false) =>
    managerDealClass({ pipelineId, statusId, closed, writtenOff }, HANDOFF_CLASS_RULES);
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
 * #683 — ПРАВИЛА КЛАСУ == КОНСТАНТАМ ГРОШОВОГО ЯДРА (ревʼю F3).
 *
 * `HANDOFF_CLASS_RULES` живе в чистому реєстрі корзин, а дохід рахують константи `money.ts`/
 * `metrics.ts`. Розійдуться — «успіх», «оплачено» й «очікуємо» в рядку лідгена означатимуть
 * інше, ніж на решті екранів. Звірка — з РЕАЛЬНИМИ константами ядра (лінивий імпорт із
 * заглушками оточення, як `#342`: `config` кидає без змінних ще на імпорті, а БД тут не
 * потрібна — жодного запиту), тож біжить у кожному оточенні, а не лише з `DATABASE_URL`.
 * 🧨 САБОТАЖ: у реєстрі `expectZone: AWAITING_STATUSES` → вузький етап 8 → червоніє.
 */
test("#683 ПРАВИЛА КЛАСУ УГОДИ МЕНЕДЖЕРА == КОНСТАНТАМ ГРОШОВОГО ЯДРА (FC, 142, етап 9, зона «Очікуємо», 143)", async () => {
  process.env.DATABASE_URL ??= "postgresql://stub@localhost/stub";
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const money = await import("./money.js");
  const metrics = await import("./metrics.js");
  const sorted = (a: readonly number[]) => [...a].sort((x, y) => x - y);
  const R = HANDOFF_CLASS_RULES;
  assert.deepEqual(sorted(R.fcPipelines), sorted(money.FC_PIPELINES), "🔴 воронки повного циклу розійшлись із FC_PIPELINES");
  assert.deepEqual(sorted(R.success), sorted(money.STAGE_SUCCESS), "🔴 «успіх» розійшовся з STAGE_SUCCESS");
  assert.deepEqual(sorted(R.paid), sorted(money.STAGE_PAID), "🔴 «оплачено» розійшлось із STAGE_PAID");
  assert.deepEqual(sorted(R.expectZone), sorted(metrics.EXPECT_ZONE),
    "🔴 «очікуємо» розійшлось із EXPECT_ZONE — рядок лідгена рахує іншу зону, ніж решта екранів");
  assert.equal(R.lostStatus, 143, "🔴 «програно» — не системний 143 Kommo");
  // 🪞 Дзеркало: звірка розрізняє саме ту підміну, яку знайшло ревʼю, — вузький етап 8 ≠ зона.
  assert.notDeepEqual(sorted(money.STAGE_EXPECTED), sorted(metrics.EXPECT_ZONE),
    "фікстура вироджена: етап 8 і зона однакові — підміну не було б видно");
  assert.ok(R.expectZone.length > 0 && R.fcPipelines.length > 0, "порожні правила — звіряти нема чого");
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
    ["earned", "expect", "handoffs", "lost", "machines", "managerId", "paid", "pending", "regular", "sameDeal", "success", "unlinked", "waiting", "work"]);
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
 * #681 — СКОУП З РОЛІ ОБЧИСЛЮЄ ОДИН ПОМІЧНИК, І ВІН ЗВУЖУЄ (ревʼю F1, правило 7).
 *
 * `leadgenAuthScope` — єдине джерело скоупу для трьох роутів екрана. Обидва боки межі:
 * тімлід → лише своя команда (і без команди — НІЧИЯ, `-1`, а не весь відділ); адмін-рівень і
 * `company` → відділ; менеджер → ніщо. І те саме дає список передач без `managerId` — інакше
 * число в рядку і розкривний список тімліда рахувались би над різними скоупами.
 * Поведінково: через цей скоуп тімлід команди 2 НЕ бачить грошей команди 1, а адмін бачить обидві.
 * 🧨 САБОТАЖ: у гілці тімліда повертати `teamId: null` → червоніє.
 */
test("#681 СКОУП З РОЛІ — ОДИН ПОМІЧНИК: тімлід → своя команда, без команди → нічия, адмін → відділ", () => {
  assert.deepEqual(leadgenAuthScope({ role: "team_lead", teamId: 5 }), { teamId: 5, managerId: null },
    "🔴 тімлід отримав не свою команду — гроші інших команд поїдуть йому");
  assert.deepEqual(leadgenAuthScope({ role: "team_lead", teamId: null }), { teamId: -1, managerId: null },
    "🔴 тімлід БЕЗ команди отримав весь відділ — порожній скоуп виражено «без обмеження»");
  assert.deepEqual(leadgenAuthScope({ role: "team_lead", teamId: undefined }), { teamId: -1, managerId: null });
  assert.deepEqual(leadgenAuthScope({ role: "manager", teamId: 5 }), { teamId: -1, managerId: -1 },
    "🔴 менеджер (друга лінія після 403) отримав непорожній скоуп");
  // 🪞 Дзеркало: ті, кому відділ належить, його отримують — інакше «звузити всім» теж пройшло б.
  assert.deepEqual(leadgenAuthScope({ role: "admin", teamId: 5 }), { teamId: null, managerId: null },
    "🔴 адмін із прописаною командою звужений до неї — відділ зник");
  assert.deepEqual(leadgenAuthScope({ role: "company", teamId: null }), { teamId: null, managerId: null });
  // Список передач без `managerId` — рівно той самий скоуп, що число в рядку.
  for (const a of [{ role: "team_lead", teamId: 5 }, { role: "team_lead", teamId: null }, { role: "admin", teamId: null },
    { role: "company", teamId: 3 }]) {
    assert.deepEqual(handoffDealsScope(a, null, null), { ok: true, scope: leadgenAuthScope(a) },
      `🔴 ${a.role}/${a.teamId}: список передач і число рядка рахуються над різними скоупами`);
  }
  // Поведінково, через `handoffView`: тімлід 2 не бачить грошей команди 1; адмін бачить обидві.
  const states = new Map<number, DealState>([[9001, st("success", 30_000)], [9002, st("paid", 4_000)]]);
  const domain = [e(401, 7, 0, 9001, 1), e(402, 8, 5, 9002, 2)];
  const lead2 = handoffView(domain, states, leadgenAuthScope({ role: "team_lead", teamId: 2 }));
  assert.equal(lead2.totals.success.sum, 0, "🔴 тімлід команди 2 бачить успіх команди 1");
  assert.equal(lead2.totals.paid.sum, 4_000, "фікстура: своя команда мусить бути видна");
  const adm = handoffView(domain, states, leadgenAuthScope({ role: "admin", teamId: null }));
  assert.equal(adm.totals.success.sum + adm.totals.paid.sum, 34_000, "🔴 адмін не бачить відділу");
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
 * #682 — МІСЯЦЬ ТРЕНДУ == ТА САМА ЗБІРКА НАД ОДНИМ ЦИМ МІСЯЦЕМ (ревʼю F2).
 *
 * Вимога власника: місяць тренду дорівнює `/leadgen-stats` того місяця — і в лічильниках, і в
 * ДЗВІНКАХ, і в ГРОШАХ. Ревʼю показало, що дві підміни проходили зеленими: ростер дзвінків на
 * все вікно замість місяця і дедуп грошей над усім вікном. Фікстура саме на них:
 *  • людина 4 має дзвінки в травні, але жодної події стадій у травні — `/leadgen-stats` травня
 *    її не показує, тож тренд теж не має (а квітневі дзвінки — має: дзеркало);
 *  • угоду менеджера 9101 привели передачі ДВОХ місяців (30.04 23:59 і 01.05 00:00 за Києвом). З 30.09.2026
 *    (правило Ярослава, `#1095`) угода належить ПЕРШІЙ передачі: у травні друга — «та сама угода», а гроші
 *    йдуть у місяць успіху. «Місяць окремо» тому — той самий `handoffView` над УСІМ доменом передач із
 *    періодом-місяцем, рівно як рахує `/leadgen-stats` того місяця.
 * Порівняння — у двох скоупах (відділ і команда), по кожному місяцю вікна.
 * 🧨 САБОТАЖ: в `assembleTrend` `mergeBucketRows(…, true)` → `false` → червоніє; `handoffView` без періоду
 * (когорта = усі передачі вікна) → червоніє.
 */
test("#682 МІСЯЦЬ ТРЕНДУ == ЗБІРКА НАД ОДНИМ ЦИМ МІСЯЦЕМ: дзвінки й гроші теж, не лише стадії", () => {
  const W = trendWindow("2026-06-30", 3).monthStarts;             // квітень, травень, червень
  const APR = W[0], MAY = W[1], JUN = W[2];
  const sr = (bucket: string, managerId: number, teamId: number, leads: number, quotes = 0): StageBucketRow =>
    ({ bucket, managerId, teamId, leads, opr: 0, quotes, warming: 0 });
  const stages = [sr(APR, 4, 3, 2, 1), sr(JUN, 4, 3, 1), sr(MAY, 5, 3, 1, 1), sr(APR, 6, 4, 1, 1)];
  const calls: CallBucketRow[] = [
    { bucket: APR, managerId: 4, calls: 7 },
    { bucket: MAY, managerId: 4, calls: 5 },   // у травні людина 4 подій не має
    { bucket: MAY, managerId: 5, calls: 3 },
    { bucket: JUN, managerId: 9, calls: 4 },   // людини 9 немає в ростері жодного місяця
  ];
  const T = Date.UTC(2026, 3, 30, 20, 59, 30);                    // 30.04 23:59:30 за Києвом
  const links: HandoffEntry[] = [
    { pzId: 501, lgId: 4, lgTeamId: 3, at: T, day: "2026-04-30", dealId: 9101 },
    { pzId: 502, lgId: 5, lgTeamId: 3, at: T + 60_000, day: "2026-05-01", dealId: 9101 },
    { pzId: 503, lgId: 6, lgTeamId: 4, at: T - 86_400_000 * 20, day: "2026-04-10", dealId: null },
  ];
  const states = new Map<number, DealState>([[9101, st("success", 10_000)]]);
  const inMonth = (m: string, d: string) => d.slice(0, 7) === m.slice(0, 7);
  let compared = 0;
  for (const scope of [{ teamId: null, managerId: null }, { teamId: 3, managerId: null }]) {
    const whole = assembleTrend({ monthStarts: W, stages, calls, links, states, firstDay: "2026-04-03", scope });
    assert.deepEqual(whole.monthStarts, W, "усі три місяці памʼятає журнал — порівнювати є що");
    for (const m of W) {
      const alone = assembleTrend({
        monthStarts: [m], stages: stages.filter((r) => r.bucket === m), calls: calls.filter((c) => c.bucket === m),
        links, states, firstDay: "2026-04-03", scope,
      });
      assert.deepEqual(whole.byPerson.filter((r) => r.bucket === m), alone.byPerson,
        `🔴 ${m} (команда ${scope.teamId}): рядки людей у тренді ≠ тому самому місяцю окремо — дзвінки чи ростер розійшлись`);
      assert.deepEqual(whole.money.find((x) => x.bucket === m), alone.money[0],
        `🔴 ${m} (команда ${scope.teamId}): гроші з передач у тренді ≠ тому самому місяцю окремо — дедуп не в межах місяця`);
      assert.deepEqual(sumBuckets(whole.byPerson, W).find((x) => x.bucket === m), sumBuckets(alone.byPerson, [m])[0],
        `🔴 ${m}: підсумок відділу в тренді ≠ місяцю окремо`);
      compared++;
    }
    const row = (b: string, id: number) => whole.byPerson.find((r) => r.bucket === b && r.managerId === id);
    assert.equal(row(MAY, 4), undefined, "🔴 дзвінки людини в місяці без її подій — /leadgen-stats того місяця їх не показує");
    assert.equal(row(APR, 4)?.calls, 7, "🔴 дзвінки людини в місяці з її подіями зникли (дзеркало)");
    assert.ok(!whole.byPerson.some((r) => r.managerId === 9), "🔴 дзвінки людини поза ростером потрапили в тренд");
    const money = (b: string) => whole.money.find((x) => x.bucket === b)!.totals;
    assert.equal(money(APR).success.n, 1, "🔴 квітнева передача не отримала угоди менеджера");
    // З 30.09.2026 (`#1095`): угода 9101 належить першій передачі (квітень); травнева — «та сама угода».
    assert.equal(money(MAY).sameDeal, 1, "🔴 травнева передача в угоду квітневої не стала «тією самою»");
  }
  assert.equal(compared, 6);
  // Відділ бачить команду 4, команда 3 — ні (скоуп і в рядках, і в грошах).
  const t3 = assembleTrend({ monthStarts: W, stages, calls, links, states, firstDay: "2026-04-03", scope: { teamId: 3, managerId: null } });
  assert.ok(!t3.byPerson.some((r) => r.managerId === 6) && t3.money[0].totals.unlinked === 0, "🔴 тімлід 3 бачить команду 4");
  // Глибина журналу: місяць до першої події не звітується; подій немає — немає й місяців.
  assert.deepEqual(assembleTrend({ monthStarts: W, stages, calls, links, states, firstDay: "2026-05-10",
    scope: { teamId: null, managerId: null } }).monthStarts, [MAY, JUN], "🔴 місяць до першої події звітується нулем");
  assert.deepEqual(assembleTrend({ monthStarts: W, stages: [], calls: [], links: [], states, firstDay: null,
    scope: { teamId: null, managerId: null } }).monthStarts, []);
  // 🪞 Дзеркало ростеру: усередині ОДНОГО періоду (день/тиждень) ростер — люди періоду, дзвінок
  // у день без стадій рахується. Та сама функція, інший прапорець — інша, теж правильна відповідь.
  const inPeriod = mergeBucketRows(stages, calls, false);
  assert.equal(inPeriod.find((r) => r.bucket === MAY && r.managerId === 4)?.calls, 5,
    "🔴 у розбивці одного періоду загубився дзвінок дня без стадій — рядок його рахує");
  assert.ok(!inPeriod.some((r) => r.managerId === 9), "🔴 людина поза ростером періоду отримала рядок");
});

/**
 * #684 — РЯДОК СПИСКУ ПЕРЕДАЧ: КОЖНЕ ПОЛЕ З ОБОХ БОКІВ СВОЄЇ МЕЖІ (ревʼю F4, правило 8).
 *
 * Жоден тест не виконував збирання рядка — префікс Кваліфікації, «причина лише для програних»,
 * посилання на Продзвін для `none`, фолбек назви на угоду Продзвону могли змінитись мовчки.
 * Залежності тут — тестові (видно, що саме підставлено); що ядро передає СПРАВЖНІ, тримає `#684b`.
 * 🧨 САБОТАЖ: прибрати префікс «Кваліфікація · » → червоніє; `reason` для будь-якого класу →
 * червоніє; `url` завжди з угоди Продзвону → червоніє.
 */
test("#684 РЯДОК СПИСКУ ПЕРЕДАЧ: префікс Кваліфікації, причина лише для програних, посилання й назва з Продзвону для «без угоди»", () => {
  const deps: HandoffRowDeps = { stageName: (p, s) => `S${p}:${s}`, qualificationPipelines: [111], leadUrl: (id) => `u/${id}` };
  const base = (pzId: number, dealId: number | null, cls: LeadgenDealClass, o: Partial<HandoffLinkInfo> = {}) =>
    Object.assign({
      pzId, lgId: 7, lgTeamId: 1, at: at(pzId), day: "2026-09-01", dealId,
      pzName: "Продзвін-назва", pzClient: "Продзвін-клієнт", dealName: "Київ — Львів", dealClient: "ТОВ Угода",
      salesManager: "Продажі В", dealReason: "Дорого", closedDay: "2026-09-05", planPayDay: "2026-09-10",
    }, o, { cls, price: 1000, successDay: null, autoDay: null });
  // ── без угоди менеджера: усе з Продзвону, решта — null, навіть якщо рядок запиту щось приніс
  const none = handoffDealRow(base(1, null, "none"), undefined, deps);
  assert.equal(none.url, "u/1", "🔴 «без угоди» веде не на угоду Продзвону");
  assert.equal(none.route, "Продзвін-назва", "🔴 «без угоди» без назви Продзвону");
  assert.equal(none.client, "Продзвін-клієнт");
  assert.deepEqual([none.stage, none.salesManager, none.closedDay, none.planPayDay, none.reason], [null, null, null, null, null],
    "🔴 «без угоди» отримала поля угоди менеджера, якої немає");
  // ── програна угода повного циклу: причина є, префікса немає, посилання — на угоду менеджера
  const lost = handoffDealRow(base(2, 9002, "lost", { dealReason: "  Дорого  " }), { pipelineId: 222, statusId: 143 }, deps);
  assert.equal(lost.reason, "Дорого", "🔴 програна угода без причини відмови");
  assert.equal(lost.stage, "S222:143", "🔴 повний цикл отримав префікс Кваліфікації");
  assert.equal(lost.url, "u/9002", "🔴 посилання не на угоду менеджера");
  assert.deepEqual([lost.route, lost.client, lost.salesManager], ["Київ — Львів", "ТОВ Угода", "Продажі В"]);
  // ── угода в роботі з давньою причиною: причину НЕ показуємо (дзеркало до lost)
  const work = handoffDealRow(base(3, 9003, "work"), { pipelineId: 222, statusId: 5 }, deps);
  assert.equal(work.reason, null, "🔴 причина відмови в угоди, що ще в роботі — читалась би як провал");
  const same = handoffDealRow(base(4, 9002, "same"), { pipelineId: 222, statusId: 143 }, deps);
  assert.equal(same.reason, null, "🔴 «та сама угода» отримала причину — провал уже показано в першої передачі");
  // ── Кваліфікація — з префіксом (дзеркало до повного циклу)
  const qual = handoffDealRow(base(5, 9005, "work"), { pipelineId: 111, statusId: 142 }, deps);
  assert.equal(qual.stage, "Кваліфікація · S111:142", "🔴 стадія Кваліфікації без префікса — читається як повний цикл");
  // ── порожня назва угоди менеджера → назва Продзвону; клієнт так само
  const blank = handoffDealRow(base(6, 9006, "success", { dealName: "   ", dealClient: null }), { pipelineId: 222, statusId: 142 }, deps);
  assert.equal(blank.route, "Продзвін-назва", "🔴 порожня назва угоди менеджера не впала на назву Продзвону");
  assert.equal(blank.client, "Продзвін-клієнт");
  assert.equal(blank.closedDay, "2026-09-05");
  // Форма — явними полями, рівно ті, що читає екран.
  assert.deepEqual(Object.keys(lost).sort(), ["autoDay", "carried", "client", "closedDay", "cls", "day", "dealId", "inPeriod", "lgId", "planPayDay", "price",
    "pzId", "reason", "route", "salesManager", "stage", "url"]);
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

/**
 * #1091 — ПОСТІЙНИЙ КЛІЄНТ НА ДАТУ ПЕРЕДАЧІ (правило Ярослава, задача 4668, п.5). Кожна межа — з обох
 * боків: 2 успіхи до передачі (свіжий останній) — постійний; лише 1 до + 1 ПІСЛЯ — ні; останній
 * успіх рівно 3 місяці тому — «пройшло», ні; на день пізніше — так; успіх у ту саму мить, що й
 * передача, — ще не «до». Плюс обрізання дня: 31.05 − 3 міс = 28.02, а не «03.03» (борг 19).
 * 🧨 САБОТАЖ: `s.at < h.at` → `s.at <= h.at +  86_400_000` (успіх після передачі) → червоніє; `lastDay >` → `>=` → червоніє.
 */
test("#1091 ПОСТІЙНИЙ КЛІЄНТ: 2+ успіхи ДО передачі, останній свіжіший за 3 місяці — обидва боки кожної межі", () => {
  assert.equal(REGULAR_MIN_SUCCESSES, 2, "🔴 поріг постійного — 2 успішні перевезення (Ярослав)");
  assert.equal(REGULAR_FRESH_MONTHS, 3, "🔴 «3 місяці тиші» — правило Ярослава");
  assert.equal(monthsBackDay("2026-09-27", 3), "2026-06-27");
  assert.equal(monthsBackDay("2026-05-31", 3), "2026-02-28", "🔴 від 31-го місяць перескочив (setUTCMonth)");
  assert.equal(monthsBackDay("2024-05-31", 3), "2024-02-29", "🔴 високосний лютий обрізано не так");
  assert.equal(monthsBackDay("2026-01-15", 3), "2025-10-15", "🔴 перехід через рік");
  const H = { at: Date.UTC(2026, 8, 27, 9), day: "2026-09-27" };
  const s = (day: string, hour = 9): ClientSuccess => ({ at: Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hour), day });
  assert.equal(isRegularAt([s("2026-08-01"), s("2026-09-01")], H), true, "🔴 2 успіхи, останній місяць тому — мав бути постійним");
  assert.equal(isRegularAt([s("2026-01-10"), s("2026-05-20")], H), false, "🔴 останній успіх 4 місяці тому — клієнт мав повернутись до лідгена");
  assert.equal(isRegularAt([s("2026-08-01"), s("2026-09-28")], H), false, "🔴 успіх ПІСЛЯ передачі зробив клієнта постійним заднім числом");
  assert.equal(isRegularAt([s("2026-08-01")], H), false, "🔴 один успіх — ще не постійний");
  assert.equal(isRegularAt([s("2026-05-01"), s("2026-06-27")], H), false, "🔴 рівно 3 місяці тому — «пройшло», вже не постійний");
  assert.equal(isRegularAt([s("2026-05-01"), s("2026-06-28")], H), true, "🔴 на день свіжіше за 3 місяці — ще постійний");
  assert.equal(isRegularAt([s("2026-08-01"), { at: H.at, day: H.day }], H), false, "🔴 успіх у мить передачі зараховано як «до»");
  assert.equal(isRegularAt([], H), false);
});

/**
 * #1091b — ГРОШІ БЕЗ ПОСТІЙНИХ І «ОЧІКУВАННЯ» (задача 4668, пп.5–6). Передача в угоду постійного
 * клієнта — `regular`: поза «Успішними», «Очікуванням» і «в роботі», але названа числом. Тотожність
 * передач тримається з новим класом; «Очікування» = оплачено + «Очікуємо» і нічого більше.
 * 🧨 САБОТАЖ: у `classifyHandoffs` прибрати рядок з `isRegularAt` → успіх постійного йде в «Успішні» → червоніє;
 * в `aggregateHandoffMoney` дописати `|| r.cls === "work"` до «Очікування» → червоніє.
 */
test("#1091b ГРОШІ: постійні поза «Успішними» й «Очікуванням», тотожність передач ціла, «Очікування» = оплачено + «Очікуємо»", () => {
  const H = (pz: number, deal: number, ck: string): HandoffEntry => ({ ...e(pz, 7, pz, deal), clientKey: ck });
  const states = new Map<number, DealState>([
    [9101, st("success", 10_000)], [9102, st("success", 7_000)], [9103, st("paid", 3_000)],
    [9104, st("expect", 2_000)], [9105, st("work", 900)], [9106, st("lost", 0)],
  ]);
  const old = (day: string): ClientSuccess => ({ at: Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))), day });
  const history = new Map<string, ClientSuccess[]>([
    ["reg", [old("2026-07-01"), old("2026-08-15")]],       // постійний на 01.09
    ["cold", [old("2026-01-01"), old("2026-02-01")]],      // «3 місяці тиші» — знову лідгена
  ]);
  const rows = classifyHandoffs([H(1, 9101, "new"), H(2, 9102, "reg"), H(3, 9103, "cold"), H(4, 9104, "new2"),
    H(5, 9105, "new3"), H(6, 9106, "new4"), { ...e(7, 7, 7, null), clientKey: "reg" }], states, history);
  assert.deepEqual(rows.map((r) => r.cls), ["success", "regular", "paid", "expect", "work", "lost", "none"],
    "🔴 клас передачі не той: постійний — `regular`, «3 місяці тиші» — звичайний, без угоди — `none`");
  const m = aggregateHandoffMoney(rows);
  assert.deepEqual([m.success.n, m.success.sum], [1, 10_000], "🔴 успіх постійного клієнта потрапив у гроші лідгена");
  assert.deepEqual([m.regular.n, m.regular.sum], [1, 7_000], "🔴 постійних не названо числом");
  assert.deepEqual([m.waiting.n, m.waiting.sum], [2, 5_000], "🔴 «Очікування» ≠ оплачено + «Очікуємо»");
  assert.equal(m.handoffs, m.unlinked + m.sameDeal + m.lost + m.regular.n + m.success.n + m.paid.n + m.expect.n + m.work.n,
    "🔴 тотожність передач зламалась — хтось зник або порахований двічі");
  // Без історії постійних немає — поведінка до задачі 4668 (дзеркало: правило не вмикається саме).
  assert.equal(classifyHandoffs([H(2, 9102, "reg")], states).map((r) => r.cls)[0], "success");
});

/**
 * #1092 — ГРОШІ ПО ТИЖНЯХ І ДНЯХ (задача 4668, п.6): розклад ТИХ САМИХ класифікованих передач періоду,
 * тож Σ одиниць == періоду по кожному полю — навіть коли друга передача в ту саму угоду лягла в інший
 * тиждень (`same`). Ключ тижня — понеділок (неділя → попередній понеділок), дня — сама дата; по людях — теж Σ.
 * 🧨 САБОТАЖ: у `mondayOf` `(dow + 6) % 7` → `dow` (тиждень з неділі) → червоніє; у `handoffMoneyBuckets`
 * рахувати підсумок одиниці без `same` → Σ передач ≠ періоду → червоніє.
 */
test("#1092 ГРОШІ ПО ОДИНИЦЯХ: Σ тижнів/днів == період по кожному полю й людині; тиждень — з понеділка", () => {
  assert.equal(mondayOf("2026-09-21"), "2026-09-21", "понеділок — сам собі");
  assert.equal(mondayOf("2026-09-27"), "2026-09-21", "🔴 неділя лягла не в свій тиждень");
  assert.equal(mondayOf("2026-10-01"), "2026-09-28", "🔴 межа місяця зсунула тиждень");
  const E = (pz: number, lg: number, day: string, deal: number | null): HandoffEntry =>
    ({ pzId: pz, lgId: lg, lgTeamId: 1, at: Date.parse(day + "T09:00:00Z") + pz, day, dealId: deal });
  const states = new Map<number, DealState>([[9201, st("success", 10_000)], [9202, st("paid", 3_000)], [9203, st("expect", 2_000)], [9204, st("work", 500)]]);
  const view = handoffView([E(1, 7, "2026-09-21", 9201), E(2, 7, "2026-09-27", 9202), E(3, 8, "2026-09-28", 9203),
    E(4, 8, "2026-09-29", 9201), E(5, 8, "2026-09-30", null), E(6, 7, "2026-10-01", 9204)], states, { teamId: null, managerId: null });
  assert.ok(view.rows.some((r) => r.cls === "same"), "фікстура вироджена — немає «тієї самої угоди» в іншому тижні");
  for (const grain of ["week", "day"] as const) {
    const b = handoffMoneyBuckets(view.rows, grain);
    if (grain === "week") assert.deepEqual(b.map((x) => x.bucket), ["2026-09-21", "2026-09-28"], "🔴 ключі тижнів не понеділки");
    else assert.equal(b.length, 6, "🔴 днів не стільки, скільки різних дат передач");
    const sum = (f: (m: LeadgenHandoffMoney) => number, ms: LeadgenHandoffMoney[]) => ms.reduce((a, m) => a + f(m), 0);
    const fields: [string, (m: LeadgenHandoffMoney) => number][] = [["передачі", (m) => m.handoffs], ["без угоди", (m) => m.unlinked],
      ["та сама", (m) => m.sameDeal], ["успішні ₴", (m) => m.success.sum], ["очікування ₴", (m) => m.waiting.sum], ["в роботі", (m) => m.work.n]];
    for (const [name, f] of fields) {
      assert.equal(sum(f, b.map((x) => x.totals)), f(view.totals), `🔴 ${grain}: Σ одиниць «${name}» ≠ періоду`);
      for (const p of view.byPerson) assert.equal(sum(f, b.flatMap((x) => x.byPerson.filter((y) => y.managerId === p.managerId).map((y) => y.money))),
        f(p.money), `🔴 ${grain}: людина ${p.managerId}, «${name}» по одиницях ≠ періоду`);
    }
  }
});



import { leadgenViewer, leadgenAuthScope as scopeOf, handoffDealsScope as dealsScopeOf, ownLeadgenStatsBody, ownLeadgenTrendBody,
  NOT_LEADGEN_TEXT } from "./leadgenHandoffRules.js";

/**
 * #1250 — ХТО ДИВИТЬСЯ ЕКРАН (рішення власника 02.10.2026): лідген (роль «менеджер» + активний учасник
 * «Лідогенерації») — свої дані й підсумок команди; менеджер продажу (та сама роль, поза командою) — відмова
 * з поясненням; тімлід і компанія — як були. Кожна межа — по обидва боки.
 * 🧨 САБОТАЖ: у `leadgenViewer` прибрати перевірку `auth.leadgenTeamId != null` → менеджер продажу стає `own` → червоніє.
 */
test("#1250 ХТО ДИВИТЬСЯ: лідген — свої дані й підсумок команди; менеджер продажу — відмова; тімлід — як був", () => {
  const LG = 50011;
  const lidgen = { role: "manager", teamId: null, managerId: 118, leadgenTeamId: LG };
  const sales = { role: "manager", teamId: 7, managerId: 8, leadgenTeamId: null };
  assert.deepEqual(leadgenViewer(lidgen), { kind: "own", selfId: 118 });
  assert.deepEqual(leadgenViewer(sales), { kind: "deny", error: NOT_LEADGEN_TEXT }, "🔴 менеджер продажу бачить екран лідгенів");
  assert.equal(leadgenViewer({ ...lidgen, managerId: null }).kind, "deny", "🔴 «свої дані» без «себе» — відкрито");
  assert.equal(leadgenViewer({ ...lidgen, managerId: -1 }).kind, "deny", "🔴 порожній менеджер (-1) прочитався як «свій»");
  assert.equal(leadgenViewer({ role: "team_lead", teamId: LG }).kind, "all");
  // Скоуп: лідгену — команда (підсумок), менеджеру продажу — ніщо, тімліду — своя команда, як було.
  assert.deepEqual(scopeOf(lidgen), { teamId: LG, managerId: null });
  assert.deepEqual(scopeOf(sales), { teamId: -1, managerId: -1 }, "🔴 менеджеру продажу пішов скоуп із даними");
  assert.deepEqual(scopeOf({ role: "team_lead", teamId: LG }), { teamId: LG, managerId: null });
  // Список угод: лідген — лише свої; чужий `managerId` — 403, а не «тихо свої»; продажі — 403.
  assert.deepEqual(dealsScopeOf(lidgen, null, null), { ok: true, scope: { teamId: LG, managerId: 118 } });
  assert.deepEqual(dealsScopeOf(lidgen, 118, LG), { ok: true, scope: { teamId: LG, managerId: 118 } });
  assert.deepEqual(dealsScopeOf(lidgen, 190, LG), { ok: false, status: 403 }, "🔴 лідген отримав угоди колеги");
  assert.deepEqual(dealsScopeOf(sales, null, null), { ok: false, status: 403 });
  assert.deepEqual(dealsScopeOf({ role: "team_lead", teamId: LG }, 190, LG), { ok: true, scope: { teamId: LG, managerId: 190 } },
    "🔴 тімлід втратив угоди своєї команди");
});

/**
 * #1251 — ВІДПОВІДЬ ДЛЯ ЛІДГЕНА — БІЛИЙ СПИСОК: свій рядок, свої гроші й розбивка, підсумки КОМАНДИ;
 * рядків, грошей, передач колег, «Інших», рівня відділу — НЕМАЄ; поле, якого немає в списку, не проходить.
 * 🧨 САБОТАЖ: в `ownLeadgenStatsBody` замінити `onlySelf(body.rows, selfId)` на `body.rows` → червоніє.
 */
test("#1251 ВІДПОВІДЬ ЛІДГЕНУ: лише своє + підсумок команди; невідоме поле не проходить", () => {
  const me = 118, mate = 190;
  const person = (id: number) => ({ managerId: id, name: `Л${id}`, quotes: id });
  const body = {
    from: "2026-10-01", to: "2026-10-31", grain: "week",
    rows: [person(me), person(mate)], teamMembers: [person(me), person(mate)],
    totals: { quotes: 308 }, conversions: { oprOfLeads: 50 },
    plans: { elapsed: 0.1, byPerson: [person(me), person(mate)], team: { plan: 300 } },
    handoffMoney: { totals: { earned: { sum: 99 } }, byPerson: [person(me), person(mate)] },
    buckets: [{ bucket: "2026-09-28", quotes: 9 }], bucketsByPerson: [person(me), person(mate)],
    handoffMoneyBuckets: [{ bucket: "2026-09-28" }], handoffMoneyBucketsByPerson: [person(me), person(mate)],
    others: [person(5)], othersTotals: { quotes: 5 }, bySource: [{ source: "x" }], weeks: [{ week: "x" }],
    closures: [{ reason: "x", deals: 1 }], handoffs: [{ kommoId: 1, manager: "Л190" }], handoffsLimit: 500,
    warmingNow: 1682, department: { machines: 103 }, secretTomorrow: "чуже",
  };
  const o = ownLeadgenStatsBody(body, me);
  for (const k of ["rows", "teamMembers", "bucketsByPerson", "handoffMoneyBucketsByPerson"] as const) {
    assert.deepEqual(o[k], [person(me)], `🔴 «${k}»: у відповіді лідгену чужі рядки`);
  }
  assert.deepEqual((o.plans as { byPerson: unknown }).byPerson, [person(me)], "🔴 план колеги у відповіді лідгену");
  assert.deepEqual((o.handoffMoney as { byPerson: unknown }).byPerson, [person(me)], "🔴 гроші колеги у відповіді лідгену");
  // Підсумки команди — є (рішення: «свій рядок + підсумок команди»).
  assert.deepEqual([o.totals, (o.plans as { team: unknown }).team, (o.handoffMoney as { totals: unknown }).totals, o.buckets],
    [body.totals, body.plans.team, body.handoffMoney.totals, body.buckets], "🔴 підсумок команди зник з відповіді лідгену");
  // Чуже й відділ — порожні, а невідоме поле не проходить зовсім.
  assert.deepEqual([o.others, o.bySource, o.weeks, o.closures, o.handoffs, o.department, o.warmingNow, o.othersTotals],
    [[], [], [], [], [], null, null, null], "🔴 лідгену пішли «Інші», журнал передач з іменами чи рівень відділу");
  assert.ok(!("secretTomorrow" in o), "🔴 нове поле відповіді пройшло до лідгена без внесення в білий список");
  assert.equal(o.viewer, "own");
  // Тренд — той самий принцип.
  const t = ownLeadgenTrendBody({ months: 12, to: "2026-10-31", buckets: [1], handoffMoney: [2],
    bucketsByPerson: [person(me), person(mate)], handoffMoneyByPerson: [person(mate)], extra: 1 }, me);
  assert.deepEqual([t.bucketsByPerson, t.handoffMoneyByPerson, t.buckets, t.handoffMoney], [[person(me)], [], [1], [2]]);
  assert.ok(!("extra" in t), "🔴 тренд: невідоме поле пройшло до лідгена");
});

/**
 * #1257 — «ОЧІКУВАННЯ» СТАНОМ НА КІНЕЦЬ ПЕРІОДУ (рішення власника 02.10.2026: «якщо не перейшло в успіх у
 * минулому місяці — переходить в очікування в цей»; минулі місяці — станом на ЇХНІЙ кінець). По обидва боки:
 * авто серпня, досі чекає → і серпень, і вересень (перенесено); успіх 05.10 → вересень у «Очікуванні», жовтень
 * у «Успішних», а не в «Очікуванні»; програно 25.09 → не вересень; авто 02.10 → не вересень, жовтень так; авто ще
 * не поїхало → ніде. «Успішні» — як були, за датою успіху. Тижні — станом на кінець тижня.
 * 🧨 САБОТАЖ: у `pendingIn` замість історії брати поточний клас (`return isWaitingCls(r.cls)` одразу після межі
 * авто) → угода, що стала успішною 05.10, зникає з «Очікування» вересня → червоніє.
 */
test("#1257 ОЧІКУВАННЯ — станом на кінець періоду: переноситься, поки не успіх; минуле — з історії", () => {
  const E = (pz: number, day: string, deal: number): HandoffEntry =>
    ({ pzId: pz, lgId: 7, lgTeamId: 1, at: Date.parse(day + "T09:00:00Z") + pz, day, dealId: deal });
  const S = (cls: DealState["cls"], price: number, closedDay: string | null, autoDay: string | null, pend: [string, boolean][]): DealState =>
    ({ cls, price, closedDay, autoDay, pendDays: pend.map(([day, pending]) => ({ day, pending })) });
  const states = new Map<number, DealState>([
    [9501, S("expect", 1_000, null, "2026-08-28", [["2026-08-28", true]])],                          // досі чекає
    [9502, S("success", 2_000, "2026-10-05", "2026-09-20", [["2026-09-20", true], ["2026-10-05", false]])], // успіх 05.10
    [9503, S("lost", 4_000, null, "2026-09-10", [["2026-09-10", true], ["2026-09-25", false]])],    // програно 25.09
    [9504, S("paid", 8_000, null, "2026-10-02", [["2026-10-02", true]])],                            // авто в жовтні
    [9505, S("expect", 16_000, null, null, [])],                                                    // авто не поїхало
    [9506, S("success", 32_000, "2026-09-12", "2026-09-05", [["2026-09-05", true], ["2026-09-12", false]])], // успіх вересня
  ]);
  const domain = [E(1, "2026-08-20", 9501), E(2, "2026-09-15", 9502), E(3, "2026-09-01", 9503), E(4, "2026-09-25", 9504),
    E(5, "2026-09-03", 9505), E(6, "2026-09-02", 9506)];
  const view = (from: string, to: string) => handoffView(domain, states, { teamId: null, managerId: null }, new Map(), dayInRange(from, to));
  const aug = view("2026-08-01", "2026-08-31"), sept = view("2026-09-01", "2026-09-30"), oct = view("2026-10-01", "2026-10-31");
  assert.deepEqual([aug.totals.pending.n, aug.totals.pending.sum], [1, 1_000], "🔴 серпень: авто 28.08, на 31.08 чекала — не в очікуванні");
  assert.deepEqual([sept.totals.pending.n, sept.totals.pending.sum], [2, 3_000],
    "🔴 вересень: не «перенесена з серпня 1 000 + на 30.09 ще чекала, а 05.10 стала успішною 2 000» (програна 25.09 — не входить)");
  assert.deepEqual([oct.totals.pending.n, oct.totals.pending.sum], [2, 9_000],
    "🔴 жовтень: не «досі чекає 1 000 + авто 02.10 8 000» (успішна 05.10 — вже не очікування)");
  assert.deepEqual([oct.totals.earned.n, oct.totals.earned.sum], [1, 2_000], "🔴 успіх 05.10 не в «Успішних» жовтня");
  assert.deepEqual([sept.totals.earned.n, sept.totals.earned.sum], [1, 32_000], "🔴 «Успішні» вересня змінились — правило їх не чіпає");
  assert.equal(sept.rows.find((r) => r.pzId === 1)?.carried, true, "🔴 перенесена з серпня угода не позначена «перенесено»");
  assert.equal(sept.rows.find((r) => r.pzId === 2)?.carried, false, "🔴 авто вересня позначене як перенесене");
  // Тижні — станом на кінець тижня: на 13.09 чекали перенесена й 9503 (програна лише 25.09), 9506 вже успішна (12.09);
  // на 30.09 — перенесена й 9502, а 9503 вже програна.
  const weeks = handoffMoneyBuckets(sept.rows, "week", dayInRange("2026-09-01", "2026-09-30"));
  assert.equal(weeks.find((b) => b.bucket === "2026-09-07")?.totals.pending.n, 2, "🔴 тиждень 07.09: очікування не станом на кінець тижня");
  assert.equal(weeks.find((b) => b.bucket === "2026-09-28")?.totals.pending.n, 2, "🔴 тиждень 28.09: очікування не станом на кінець тижня");
  // Період без меж (старий виклик) — як було: клас зараз + авто в періоді.
  assert.equal(pendingIn({ cls: "expect", autoDay: "2026-08-28" }, () => true), true);
  assert.equal(pendingIn({ cls: "success", autoDay: "2026-08-28" }, () => true), false);
});

/**
 * #1258 — «МАШИН» = «УСПІШНІ» + «ОЧІКУВАННЯ» ПЕРІОДУ, ЯК І БУЛО (рішення власника 02.10.2026: «залиш як є»), тепер
 * над «Очікуванням» станом на кінець періоду — тож перенесена машина рахується й у місяці, де вона ще чекала. Σ людей ==
 * відділ. Наступник `#1096` (знятий: «Σ тижнів == період» більше не правда — очікування тижнів це знімки).
 * 🧨 САБОТАЖ: у `withAnchored` `machines: a.earned.n + a.pending.n` → `a.earned.n` → червоніє.
 */
test("#1258 МАШИН = успішні + очікування періоду (станом на кінець): відділ і люди — одне число", () => {
  const E = (pz: number, day: string, deal: number, lg: number): HandoffEntry =>
    ({ pzId: pz, lgId: lg, lgTeamId: 1, at: Date.parse(day + "T09:00:00Z") + pz, day, dealId: deal });
  const S = (cls: DealState["cls"], closedDay: string | null, autoDay: string | null, pend: [string, boolean][] = []): DealState =>
    ({ cls, price: 1000, closedDay, autoDay, pendDays: pend.map(([day, pending]) => ({ day, pending })) });
  const states = new Map<number, DealState>([
    [9601, S("success", "2026-09-10", "2026-09-02", [["2026-09-02", true], ["2026-09-10", false]])],
    [9602, S("expect", null, "2026-08-30", [["2026-08-30", true]])],      // перенесена з серпня
    [9603, S("expect", null, null)],                                      // авто не поїхало
  ]);
  const v = handoffView([E(1, "2026-08-20", 9601, 7), E(2, "2026-08-15", 9602, 8), E(3, "2026-09-12", 9603, 8)],
    states, { teamId: null, managerId: null }, new Map(), dayInRange("2026-09-01", "2026-09-30"));
  assert.equal(v.totals.machines, 2, "🔴 машин вересня не 2 (успіх 9601 + перенесена 9602)");
  assert.equal(v.totals.machines, v.totals.earned.n + v.totals.pending.n);
  assert.equal(v.byPerson.reduce((a, p) => a + p.money.machines, 0), v.totals.machines, "🔴 Σ людей ≠ відділ");
  assert.equal(personMoneyWire(8, v.totals).machines, 2, "🔴 машини не доїхали у відповідь");
});

/**
 * #1500 — МІНУСОВА УГОДА В ГРОШАХ ЛІДГЕНА (рішення власника 07.10.2026). Угода з полем «Мінусова угода»
 * лишається машиною (успіх / очікування), але її сума лідгену — 0: мінус — розщеплення перевезення в продажах,
 * плюсова половина з передачею не повʼязана (62630491 Крупник: −4 948 + окрема +7 188). Фікстура по обидва
 * боки: та сама угода без позначки дає свою суму, з позначкою — машину й 0; рядок списку несе `minus`.
 * 🧨 САБОТАЖ: у `leadgenPrice` `st.minus ? 0 : st.price` → `st.price` → червоніє (сума −4 948).
 */
test("#1500 МІНУСОВА УГОДА: лідгену — машина і 0 ₴; без позначки — своя сума", () => {
  const E = (pz: number, deal: number): HandoffEntry =>
    ({ pzId: pz, lgId: 7, lgTeamId: 1, at: Date.parse("2026-09-10T09:00:00Z") + pz, day: "2026-09-10", dealId: deal });
  const S = (cls: DealState["cls"], price: number, minus: boolean): DealState =>
    ({ cls, price, minus, closedDay: cls === "success" ? "2026-09-20" : null, autoDay: "2026-09-15",
      pendDays: [{ day: "2026-09-15", pending: cls !== "success" }, ...(cls === "success" ? [{ day: "2026-09-20", pending: false }] : [])] });
  const states = new Map<number, DealState>([
    [9601, S("expect", 2_448, false)],   // плюсова в очікуванні
    [9602, S("expect", -4_948, true)],   // мінусова в очікуванні
    [9603, S("success", 3_000, false)],  // плюсова успішна
    [9604, S("success", -1_100, true)],  // мінусова успішна
  ]);
  const v = handoffView([E(1, 9601), E(2, 9602), E(3, 9603), E(4, 9604)], states, { teamId: null, managerId: null }, new Map(),
    dayInRange("2026-09-01", "2026-09-30"));
  assert.deepEqual([v.totals.pending.n, v.totals.pending.sum], [2, 2_448], "🔴 очікування: мінусова угода не машина або її −4 948 у сумі");
  assert.deepEqual([v.totals.earned.n, v.totals.earned.sum], [2, 3_000], "🔴 успішні: мінусова угода не машина або її −1 100 у сумі");
  assert.equal(v.totals.machines, 4, "🔴 мінусові угоди випали з «Машин»");
  const row = (pz: number) => v.rows.find((r) => r.pzId === pz)!;
  assert.deepEqual([row(2).price, row(2).minus], [0, true], "🔴 рядок мінусової угоди: сума не 0 або без позначки");
  assert.deepEqual([row(1).price, row(1).minus], [2_448, false], "🔴 плюсова угода втратила суму або позначена мінусовою");
  const deps: HandoffRowDeps = { stageName: () => "етап", qualificationPipelines: [], leadUrl: (id) => `u/${id}` };
  const info = (h: (typeof v.rows)[number]): HandoffLinkInfo & typeof h =>
    Object.assign({}, h, { pzName: null, pzClient: null, dealName: null, dealClient: null, salesManager: null, dealReason: null, closedDay: null, planPayDay: null });
  assert.equal(handoffDealRow(info(row(2)), { pipelineId: 1, statusId: 1 }, deps).minus, true, "🔴 список «Гроші з передач» не знає, що угода мінусова");
  assert.equal(handoffDealRow(info(row(1)), { pipelineId: 1, statusId: 1 }, deps).minus, false, "🔴 плюсова угода в списку позначена мінусовою");
});
