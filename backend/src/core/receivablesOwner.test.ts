import test from "node:test";
import assert from "node:assert/strict";
import {
  majorityByAmount, resolveOwner, activeTeamLead, sliceByManager,
  type ManagerFact, type OwnerRow,
  resolveCashOwner,
} from "./receivablesOwner.js";

/**
 * ГЕЙТИ ВИБОРУ ВІДПОВІДАЛЬНОГО ЗА БОРГ (#126…#128b).
 *
 * Фікстури зліплені з ЖИВИХ кейсів, заміряних 22.08.2026, а не вигадані:
 * саме на них попередня редакція правила давала неправильну відповідь, тож
 * гейт відтворює реальну поломку, а не мою гіпотезу про неї.
 */

const YATSYK = 8, SHEVCHUK = 33, SEMENIUK = 87, KOSIAK = 190, LEAD_RPK = 9;

const facts = new Map<number, ManagerFact>([
  [YATSYK,   { teamId: 5, isTeamLead: false, kommoActive: true,  loginStates: [true] }],
  [SHEVCHUK, { teamId: 5, isTeamLead: false, kommoActive: true,  loginStates: [] }],
  [SEMENIUK, { teamId: 5, isTeamLead: false, kommoActive: true,  loginStates: [true] }],
  [LEAD_RPK, { teamId: 5, isTeamLead: true,  kommoActive: true,  loginStates: [true] }],
  // Звільнений і БЕЗ команди — живий випадок «Косяк Дмитро» (team_id IS NULL).
  [KOSIAK,   { teamId: null, isTeamLead: false, kommoActive: false, loginStates: [] }],
]);

/** АВТОСТРАДА ВК: 22 рахунки Шевчука на 1 018 600 і ОДИН Семенюка на 15 900 — пізніший. */
const AVTOSTRADA: OwnerRow[] = [
  ...Array.from({ length: 22 }, (_, i) => ({
    managerId: SHEVCHUK, amount: 46300, invoiceDate: `2026-07-${String(3 + i % 20).padStart(2, "0")}`,
  })),
  { managerId: SEMENIUK, amount: 15900, invoiceDate: "2026-08-10" },
];

/** ПВК АРСЕНАЛ: нічийна купа БІЛЬША за будь-якого живого менеджера. */
const ARSENAL: OwnerRow[] = [
  { managerId: null,     amount: 1560000, invoiceDate: "2026-06-01" },
  { managerId: YATSYK,   amount: 780000,  invoiceDate: "2026-08-19" },
  { managerId: SHEVCHUK, amount: 72000,   invoiceDate: "2026-07-15" },
  { managerId: SEMENIUK, amount: 12200,   invoiceDate: "2026-08-05" },
];

test("#126 АВТО = МАЖОРИТАР ЗА СУМОЮ, а не останній і не «найбільше рахунків»", () => {
  const m = majorityByAmount(AVTOSTRADA);
  assert.equal(m.managerId, SHEVCHUK, "22 рахунки на 1 018 600 важать більше за один на 15 900");
  assert.equal(m.amount, 22 * 46300);
  // 🪤 Саме тут ламалась попередня редакція: останній рахунок — Семенюка (10.08),
  // і за правилом «останній творець» весь мільйон переїжджав до нього.
  const last = [...AVTOSTRADA].sort((a, b) => (a.invoiceDate! < b.invoiceDate! ? 1 : -1))[0];
  assert.equal(last.managerId, SEMENIUK, "останній рахунок справді чужий — інакше гейт нічого не ловить");
  assert.notEqual(m.managerId, last.managerId, "мажоритар ≠ останній: гейт має що розрізняти");

  const res = resolveOwner(AVTOSTRADA, facts, null);
  assert.equal(res.managerId, SHEVCHUK);
  assert.equal(res.source, "auto-majority");
});

test("#126b ТАЙ-БРЕЙК за рівних сум — свіжіший рахунок, і він детермінований", () => {
  const tie: OwnerRow[] = [
    { managerId: SHEVCHUK, amount: 50000, invoiceDate: "2026-07-01" },
    { managerId: SEMENIUK, amount: 50000, invoiceDate: "2026-08-01" },
  ];
  assert.equal(majorityByAmount(tie).managerId, SEMENIUK, "рівні суми → свіжіша дата");
  // Порядок рядків у відповіді 1С нам не підвладний, тож результат не сміє від
  // нього залежати: інакше відповідальний стрибав би між синками сам по собі.
  assert.equal(majorityByAmount([...tie].reverse()).managerId, SEMENIUK, "зворотний порядок — та сама відповідь");
});

test("#126c КЛІЄНТ — ОДИН РЯДОК, скільки б менеджерів не було в рахунках", () => {
  // Розклад по менеджерах існує (він потрібен розкриттю), але рядок дебіторки один.
  const slices = sliceByManager(ARSENAL);
  assert.equal(slices.length, 4, "у розкритті видно всі чотири купи");
  const one = resolveOwner(ARSENAL, facts, null);
  assert.equal(typeof one.managerId, "number", "відповідальний РІВНО один");
  // Сума клієнта не залежить від того, скільки менеджерів у нього намішано.
  assert.equal(slices.reduce((s, x) => s + x.amount, 0), 2424200);
});

test("#126d «БЕЗ МЕНЕДЖЕРА» НЕ ВИГРАЄ ЗМАГАННЯ", () => {
  // 🔴 Найбільша купа ПВК АРСЕНАЛ — нічийна (1 560 000 проти 780 000 у Яцика).
  // Якби відсутність даних змагалась, найбільший боржник компанії став би
  // нічийним ЗА ПРАВИЛОМ, а не за фактом.
  const m = majorityByAmount(ARSENAL);
  assert.equal(m.managerId, YATSYK, "виграє найбільший СЕРЕД ВІДОМИХ");
  assert.equal(m.amount, 780000);
  assert.equal(resolveOwner(ARSENAL, facts, null).source, "auto-majority");
  // 🪞 ДЗЕРКАЛО: коли ВСІ рахунки без менеджера — чесний `none`, а не вигаданий хтось.
  const blind: OwnerRow[] = [{ managerId: null, amount: 500, invoiceDate: "2026-08-03" }];
  const r = resolveOwner(blind, facts, null);
  assert.equal(r.managerId, null);
  assert.equal(r.source, "none");
  assert.equal(r.majorityId, null);
});

test("#128 ЗВІЛЬНЕНИЙ МАЖОРИТАР → ТІМЛІД ЙОГО КОМАНДИ", () => {
  const fired = new Map(facts);
  fired.set(SHEVCHUK, { ...facts.get(SHEVCHUK)!, kommoActive: false });
  const r = resolveOwner(AVTOSTRADA, fired, null);
  assert.equal(r.source, "auto-teamlead");
  assert.equal(r.managerId, LEAD_RPK, "відповідає тімлід команди 5");
  assert.equal(r.majorityId, SHEVCHUK, "мажоритар названий — екран має сказати «замість звільненого»");

  // Другий бік ДВОХ ДЖЕРЕЛ активності: у Kommo працює, а логін адмін зняв.
  const noLogin = new Map(facts);
  noLogin.set(SHEVCHUK, { ...facts.get(SHEVCHUK)!, loginStates: [false] });
  assert.equal(resolveOwner(AVTOSTRADA, noLogin, null).source, "auto-teamlead",
    "деактивація в Налаштуваннях — теж звільнення");
  // 🪞 ДЗЕРКАЛО: логіна НЕМАЄ взагалі — це не звільнення (правило core/activeManager).
  assert.equal(resolveOwner(AVTOSTRADA, facts, null).source, "auto-majority",
    "Шевчук без логіна лишається активним");
});

test("#128b ЗВІЛЬНЕНИЙ БЕЗ КОМАНДИ → none, і мажоритар усе одно НАЗВАНИЙ", () => {
  // Живий випадок: «Міжнародна організація з міграції» → Косяк Дмитро, team_id IS NULL.
  const rows: OwnerRow[] = [{ managerId: KOSIAK, amount: 4700, invoiceDate: "2024-07-22" }];
  const r = resolveOwner(rows, facts, null);
  assert.equal(r.source, "none");
  assert.equal(r.managerId, null);
  // 🔴 Без цього рядка «none» був би нерозрізненний від «рахунки взагалі нічиї»,
  // і екран не зміг би написати, ЧОМУ відповідального немає.
  assert.equal(r.majorityId, KOSIAK, "мажоритар збережений, щоб порожнеча читалась як відповідь");
  assert.equal(activeTeamLead(null, facts), null, "команди немає — тімліда теж");
});

test("#127 OVERRIDE Б'Є АВТО, і «свідомо нікого» ≠ «ще не дивились»", () => {
  // Правило вже вміє override; читання з БД приїде наступним комітом, тож тут
  // перевіряється саме ПРАВИЛО — і воно поїде в прод перевіреним, а не наосліп.
  assert.equal(resolveOwner(AVTOSTRADA, facts, { managerId: SEMENIUK }).managerId, SEMENIUK);
  assert.equal(resolveOwner(AVTOSTRADA, facts, { managerId: SEMENIUK }).source, "override");
  // 🪞 ДЗЕРКАЛО 1: без override працює авто (інакше «override б'є» можна було б
  // реалізувати як «авто не існує»).
  assert.equal(resolveOwner(AVTOSTRADA, facts, null).source, "auto-majority");
  // 🪞 ДЗЕРКАЛО 2: рядок із `managerId: null` — це РІШЕННЯ, а не порожнеча.
  const explicit = resolveOwner(AVTOSTRADA, facts, { managerId: null });
  assert.equal(explicit.managerId, null);
  assert.equal(explicit.source, "override", "«свідомо без відповідального» — не `none`");
  assert.notEqual(explicit.source, resolveOwner([], facts, null).source,
    "«ми не дивились» і «ми вирішили, що нікого» мусять розрізнятись");
});

/**
 * #136e — ГОТІВКА НЕ ВИГАДУЄ МАЖОРИТАРА (чиста функція).
 *
 * 🔴 Спокуса була поставити `majorityId = managerId`, «щоб поле не пустувало».
 * Тоді екран міг би сказати «замість звільненого X» про людину, яку ніхто не
 * заміщав: мажоритар рахується по рахунках дебіторки, а готівковий менеджер
 * приходить із УГОД CRM. Порожнє тут — ЧЕСНА відповідь, а не прогалина.
 *
 * 🧨 САБОТАЖ (виконано): повернути `majorityId: managerId` → червоніє друга
 * перевірка; віддати `auto-majority` замість `cash-invoice` → червоніє перша.
 */
test("#136e ГОТІВКА: власне джерело, і жодного вигаданого мажоритара", () => {
  const withMgr = resolveCashOwner(87);
  assert.equal(withMgr.managerId, 87, "🔴 відомий менеджер загубився");
  assert.equal(withMgr.source, "cash-invoice",
    "🔴 готівку подано як мажоритара — правильне число під неправильним поясненням");
  assert.equal(withMgr.majorityId, null,
    "🔴 вигаданий мажоритар: екран скаже «замість звільненого X» про того, кого не заміщали");

  const noMgr = resolveCashOwner(null);
  assert.equal(noMgr.source, "none",
    "🔴 готівка без менеджера має бути ЧЕСНИМ none, а не тихим 'cash-invoice' з порожнім імʼям");
  assert.equal(noMgr.managerId, null, "🔴 менеджер узявся нізвідки");
  assert.equal(noMgr.majorityId, null);
});
