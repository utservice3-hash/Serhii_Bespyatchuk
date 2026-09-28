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
 *  • угоду менеджера 9101 привели передачі ДВОХ місяців (30.04 23:59 і 01.05 00:00 за Києвом) —
 *    у кожному місяці це окремий період, тож вона рахується і в квітні, і в травні.
 * Порівняння — у двох скоупах (відділ і команда), по кожному місяцю вікна.
 * 🧨 САБОТАЖ: в `assembleTrend` `mergeBucketRows(…, true)` → `false` → червоніє; `handoffView`
 * над усіма передачами вікна замість передач місяця → червоніє.
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
        links: links.filter((l) => inMonth(m, l.day)), states, firstDay: "2026-04-03", scope,
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
    assert.equal(money(MAY).success.n, 1,
      "🔴 травнева передача в ту саму угоду стала «тією самою» — дедуп тренду вийшов за межі місяця");
    assert.equal(money(MAY).sameDeal, 0);
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
    }, o, { cls, price: 1000 });
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
  assert.deepEqual(Object.keys(lost).sort(), ["client", "closedDay", "cls", "day", "dealId", "lgId", "planPayDay", "price",
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
