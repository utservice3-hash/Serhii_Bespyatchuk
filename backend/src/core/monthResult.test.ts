import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { closerAt, checksOf, placeInMonth, summarize, monthsToCheck, type CheckInput, type MRDeal, type Override } from "./monthResult.js";

/**
 * 🏁 «Результат місяця» (задача Тетяни #5583, прохід 1 — 23.10.2026) — гейти `#1282`–`#1282f` (`#1282`–`#1289` вільні в
 * `main` і в усіх гілках на 23.10.2026). Визначення заміряне на вересні проти аркуша «09.26»: успішні угоди «Повного циклу»,
 * закриті в місяці (разом із мінусовими), Σ бюджетів Kommo, за тим, хто був відповідальним у момент закриття.
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const T = (iso: string) => new Date(iso).getTime();

/**
 * #1282 — ХТО ЗАКРИВАВ. Змін після закриття немає — той, хто зараз; найраніша зміна ПІСЛЯ закриття каже, з кого забрали;
 * зміни ДО закриття не рахуються; `from` невідомий — не вгадуємо, той, хто зараз. Випадок, що це купив: 15.10.2026 угоди
 * Янчевського (14431884) перепризначили на Михальчевську (12782896) — у вересні вони мусять лишитись за ним.
 * 🧨 Червоніє, якщо брати поточного відповідального, останню зміну замість першої чи зміни до закриття.
 */
test("#1282 ХТО ЗАКРИВАВ: перша зміна після закриття — з кого забрали; до закриття й без змін — поточний; невідомий from — поточний", () => {
  const close = T("2026-09-20T10:00:00Z");
  assert.equal(closerAt(12782896, close, []), 12782896, "🔴 без змін — не поточний");
  assert.equal(closerAt(12782896, close, [{ at: T("2026-10-15T09:30:00Z"), from: 14431884, to: 12782896 }]), 14431884, "🔴 перепризначену після закриття угоду віддано новому");
  assert.equal(closerAt(3, close, [{ at: T("2026-09-01T00:00:00Z"), from: 1, to: 2 }]), 3, "🔴 зміну ДО закриття враховано");
  assert.equal(closerAt(3, close, [{ at: T("2026-10-20T00:00:00Z"), from: 2, to: 3 }, { at: T("2026-10-01T00:00:00Z"), from: 1, to: 2 }]), 1, "🔴 взято не першу зміну після закриття");
  assert.equal(closerAt(3, close, [{ at: T("2026-10-01T00:00:00Z"), from: null, to: 3 }]), 3, "🔴 невідомого «з кого» вгадано");
});

/**
 * #1282b — ПЕРЕВІРКИ, по обидва боки кожної межі. Безнал без «Номер заказа» — «немає рахунку»; без галочки 1С і без
 * платежу у «Виписці» — «немає фактичного приходу» (будь-що одне знімає); готівкова угода цих двох не має; валютна —
 * позначка; готівковий розхід: оплачено більше плану (+1 ₴ допуску) або запитів немає взагалі.
 * 🧨 Червоніє, якщо зсунути будь-яку межу чи вимагати рахунок у готівкової.
 */
test("#1282b ПЕРЕВІРКИ: рахунок і прихід лише в безготівкових, валюта, розхід понад план і без запиту — по обидва боки межі", () => {
  const ok: CheckInput = { price: 10000, isMinus: false, paymentType: "Безнал с НДС", orderNo: "3165", paid1c: true, bankPaid: false, cashExpense: null, requestsPaid: 0, requestsOpen: 0 };
  const c = (x: Partial<CheckInput>) => checksOf({ ...ok, ...x });
  assert.deepEqual(c({}), [], "🔴 чиста угода на перевірці");
  assert.deepEqual(c({ paid1c: false, bankPaid: true }), [], "🔴 платіж у «Виписці» не зняв «немає приходу»");
  assert.match(c({ orderNo: null }).join(), /немає рахунку/, "🔴 без рахунку — не на перевірці");
  assert.match(c({ paid1c: false }).join(), /немає фактичного приходу/, "🔴 без приходу — не на перевірці");
  assert.deepEqual(c({ paymentType: "Наличные", orderNo: null, paid1c: false }), [], "🔴 готівковій вимагають рахунок / прихід");
  assert.match(c({ paymentType: "ВАЛЮТА" }).join(), /валютна угода/, "🔴 валютну не позначено");
  assert.deepEqual(c({ cashExpense: 5000, requestsPaid: 5001 }), [], "🔴 1 ₴ допуску не дано");
  assert.match(c({ cashExpense: 5000, requestsPaid: 5002 }).join(), /більше за план: 5 002 проти 5 000/, "🔴 переплату перевізнику не помічено");
  assert.match(c({ cashExpense: 5000 }).join(), /а запиту на оплату немає/, "🔴 розхід без запиту не помічено");
  assert.deepEqual(c({ cashExpense: 5000, requestsOpen: 5000 }), [], "🔴 відкритий запит не зарахувано");
});

const deal = (o: Partial<MRDeal>): MRDeal => ({ id: 1, name: "", client: null, closedAt: "2026-09-10T10:00:00.000Z", closedMonth: "2026-09-01", price: 1000, isMinus: false,
  paymentType: null, closer: 7, current: 7, reassigned: false, checks: [], override: null, included: true, profit: 1000, ...o });
const ov = (o: Partial<Override>): Override => ({ kommoId: 1, action: "exclude", targetMonth: null, profit: null, note: "бо так", setBy: null, setAt: "", ...o });

/**
 * #1282c — РІШЕННЯ І ЗВЕДЕННЯ. Перенесена звідси — у місяці немає, перенесена сюди — є; «не рахувати» — є в списку, але не
 * в сумі й кількості; «свій профіт» замінює бюджет (і мінус робить угоду мінусовою). Зведення — лише враховані угоди;
 * «на перевірці» в результаті Є; рішення лічаться й у невключених.
 * 🧨 Червоніє, якщо «не рахувати» лишити в сумі, перенесену рахувати двічі чи на перевірці вийняти з результату.
 */
test("#1282c РІШЕННЯ: перенесена — лише в цільовому місяці, «не рахувати» — без суми, свій профіт — замість бюджету; зведення по врахованих", () => {
  const d = { closedMonth: "2026-09-01", price: 1000 };
  assert.deepEqual(placeInMonth(d, null, "2026-09-01"), { inMonth: true, included: true, profit: 1000 }, "🔴 звичайна угода");
  const mv = ov({ action: "move", targetMonth: "2026-10-01" });
  assert.equal(placeInMonth(d, mv, "2026-09-01").inMonth, false, "🔴 перенесена лишилась у місяці закриття");
  assert.deepEqual(placeInMonth(d, mv, "2026-10-01"), { inMonth: true, included: true, profit: 1000 }, "🔴 перенесеної немає в цільовому місяці");
  assert.deepEqual(placeInMonth(d, ov({}), "2026-09-01"), { inMonth: true, included: false, profit: 1000 }, "🔴 «не рахувати» в сумі чи зникла зі списку");
  assert.deepEqual(placeInMonth(d, ov({ action: "profit", profit: -300 }), "2026-09-01"), { inMonth: true, included: true, profit: -300 }, "🔴 свій профіт не замінив бюджет");

  const names = new Map([[7, { name: "Менеджер А", active: true }], [8, { name: "Менеджер Б", active: false }]]);
  const s = summarize([
    deal({ id: 1, profit: 1000 }), deal({ id: 2, profit: 500, checks: ["немає рахунку"] }), deal({ id: 3, included: false, profit: 9999, override: ov({}) }),
    deal({ id: 4, profit: -200, isMinus: true }), deal({ id: 5, closer: 8, profit: 300, override: ov({ action: "profit", profit: 300 }) }), deal({ id: 6, closer: null, profit: 50 }),
  ], names);
  const a = s.find((m) => m.kommoUserId === 7)!;
  assert.deepEqual([a.deals, a.result, a.review, a.minus, a.overrides], [3, 1300, { n: 1, sum: 500 }, { n: 1, sum: -200 }, 1], "🔴 зведення менеджера хибне");
  assert.deepEqual(s.map((m) => m.name), ["Менеджер А", "Менеджер Б", "відповідальний невідомий"], "🔴 порядок чи імена зведення");
  assert.equal(s[1].active, false, "🔴 неактивного показано активним");
});

/**
 * #1282f — НІЧНИЙ ПРОХІД ДЖОБИ: поточний і минулий місяць за Києвом (01.10 о 00:30 Києва — це вже жовтень, хоч у UTC ще
 * вересень); перехід року.
 * 🧨 Червоніє, якщо рахувати місяць в UTC чи брати один місяць.
 */
test("#1282f ДЖОБА ВІДПОВІДАЛЬНИХ: поточний і минулий місяць за Києвом, перехід року", () => {
  assert.deepEqual(monthsToCheck(new Date("2026-09-30T21:30:00Z")), ["2026-09-01", "2026-10-01"], "🔴 місяць не за Києвом");
  assert.deepEqual(monthsToCheck(new Date("2026-09-30T20:30:00Z")), ["2026-08-01", "2026-09-01"], "🔴 вересень 23:30 Києва — не вересень");
  assert.deepEqual(monthsToCheck(new Date("2027-01-10T10:00:00Z")), ["2026-12-01", "2027-01-01"], "🔴 перехід року");
});

async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  return { c, dispose: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #1282d — ЖИВИЙ SQL. Вересень: межа місяця за Києвом (30.09 23:30 Києва — вересень, 01.10 00:30 — жовтень); не «Повний
 * цикл» і не успішна — поза; перепризначена після закриття — тому, хто закривав (`reassigned`, «зараз»); готівковий розхід
 * без запиту — на перевірці; рішення: «в інший місяць» переносить угоду з вересня в жовтень, «не рахувати» лишає в списку
 * без суми, «Повернути» повертає як у Kommo; без примітки, на той самий місяць, з кривим профітом, на чужу угоду — 400/404,
 * і відмова нічого не пише.
 * 🧨 Червоніє, якщо зламати межу місяця, пустити чужу воронку, рахувати поточного відповідального чи дати рішення без примітки.
 */
test("#1282d ЖИВИЙ SQL: межа місяця за Києвом, лише успішні «Повного циклу», хто закривав, рішення й «Повернути», відмови нічого не пишуть", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { loadMonthResult, setOverride } = await import("./monthResult.js");
  const db = c as unknown as import("./finance.js").Db;
  try {
    await c.query(`INSERT INTO users (id, email, password_hash, role, is_active, full_name) VALUES (901, 'fin@test', 'x', 'admin', true, 'Тетяна Тест')`);
    await c.query(`INSERT INTO managers (id, name, kommo_user_id, is_active) VALUES (1, 'Янчевський', 14431884, false), (2, 'Михальчевська', 12782896, true), (3, 'Третій', 333, true)`);
    const put = (id: number, mgr: number, closed: string, o: { price?: number; pipe?: number; status?: number; pay?: string; minus?: boolean } = {}) =>
      c.query(`INSERT INTO deals (kommo_id, name, client_name, manager_id, price, pipeline_id, status_id, closed_at_kommo, payment_type, is_minus) VALUES ($1, $2, 'Клієнт', $3, $4, $5, $6, $7, $8, $9)`,
        [id, `Угода ${id}`, mgr, o.price ?? 1000, o.pipe ?? 8921932, o.status ?? 142, closed, o.pay ?? "Безнал с НДС", o.minus ?? false]);
    await put(101, 2, "2026-09-10T10:00:00Z", { price: 5000 });             // закривав Янчевський, зараз Михальчевська
    await put(102, 2, "2026-09-30T20:30:00Z", { price: 700 });              // 23:30 Києва — вересень
    await put(103, 3, "2026-09-30T21:30:00Z", { price: 900 });              // 00:30 01.10 Києва — жовтень
    await put(104, 3, "2026-09-12T10:00:00Z", { price: 400, pipe: 7341740 }); // не «Повний цикл»
    await put(105, 3, "2026-09-12T10:00:00Z", { price: 400, status: 143 });   // не успішна
    await put(106, 3, "2026-09-15T10:00:00Z", { price: -300, pay: "Наличные", minus: true, pipe: 155304 });
    await c.query(`INSERT INTO deal_responsible_events (kommo_id, changed_at, from_user_id, to_user_id) VALUES (101, '2026-10-15T09:30:00Z', 14431884, 12782896)`);
    const live = async (ids: number[]) => new Map(ids.map((id) => [id, { orderNo: "1", paid1c: true, income: null, cashExpense: id === 106 ? 2000 : null }]));
    const load = (m: string) => loadMonthResult(db, m, { live, bankPaid: async () => new Set<number>(), kommoBase: "https://k.test" });

    const sep = await load("2026-09-01");
    assert.deepEqual(sep.deals.map((d) => d.id), [101, 106, 102], "🔴 склад вересня: межа за Києвом, воронка чи статус");
    const d101 = sep.deals.find((d) => d.id === 101)!;
    assert.deepEqual([d101.closer, d101.current, d101.reassigned], [14431884, 12782896, true], "🔴 перепризначену віддано тому, хто зараз");
    assert.deepEqual(sep.managers.map((m) => [m.name, m.deals, m.result]), [["Янчевський", 1, 5000], ["Михальчевська", 1, 700], ["Третій", 1, -300]], "🔴 зведення вересня");
    assert.deepEqual([sep.totals.deals, sep.totals.result, sep.totals.minus], [3, 5400, { n: 1, sum: -300 }], "🔴 підсумок вересня");
    assert.match(sep.deals.find((d) => d.id === 106)!.checks.join(), /а запиту на оплату немає/, "🔴 готівковий розхід без запиту не на перевірці");
    assert.deepEqual((await load("2026-10-01")).deals.map((d) => d.id), [103], "🔴 00:30 01.10 Києва — не жовтень");

    const r = await setOverride(db, 901, { kommoId: 102, action: "move", targetMonth: "2026-10", note: "оплата в жовтні" });
    assert.deepEqual(r.months.sort(), ["2026-09-01", "2026-10-01"], "🔴 скинуто кеш не тих місяців");
    assert.deepEqual((await load("2026-09-01")).deals.map((d) => d.id), [101, 106], "🔴 перенесена лишилась у вересні");
    const oct = await load("2026-10-01");
    assert.deepEqual([oct.deals.map((d) => d.id), oct.totals.result, oct.deals.find((d) => d.id === 102)!.override?.setBy], [[102, 103], 1600, "Тетяна Тест"], "🔴 перенесеної немає в жовтні чи без автора");
    await setOverride(db, 901, { kommoId: 101, action: "exclude", note: "Шевчук — не рахуємо" });
    const sep2 = await load("2026-09-01");
    assert.deepEqual([sep2.deals.length, sep2.totals.deals, sep2.totals.result], [2, 1, -300], "🔴 «не рахувати» в сумі чи зникла зі списку");
    await setOverride(db, 901, { kommoId: 101, action: null });
    await setOverride(db, 901, { kommoId: 102, action: null });
    assert.equal((await load("2026-09-01")).totals.result, 5400, "🔴 «Повернути» не повернуло як у Kommo");

    const bad: [unknown, number][] = [[{ kommoId: 101, action: "exclude", note: "  " }, 400], [{ kommoId: 101, action: "move", targetMonth: "2026-09", note: "x" }, 400],
      [{ kommoId: 101, action: "profit", profit: "багато", note: "x" }, 400], [{ kommoId: 101, action: "delete", note: "x" }, 400], [{ kommoId: 104, action: "exclude", note: "x" }, 404]];
    for (const [b, code] of bad) await assert.rejects(setOverride(db, 901, b), (e: any) => e?.status === code, `🔴 прийнято: ${JSON.stringify(b)}`);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM fin_month_result_overrides`)).rows[0].n, 0, "🔴 відмова щось записала");
  } finally { await s.dispose(); }
});

/**
 * #1282e — ПРОВОДКА. Перегляд і Excel — першим рядком `onlyFinance`, рішення — `canEdit`, усі три в матриці; три нові
 * таблиці закриті від AI; джоба питає події ПО УГОДАХ (потоком їх ~3 000 на добу), крон щоночі й під наглядом із тим самим
 * інтервалом; вкладка «Результат місяця» в «Фінансах» — з рішенням, «Повернути», Excel і посиланням у Kommo.
 * 🧨 Червоніє, якщо зняти межу, повернути потік усіх подій, розвести крон і нагляд чи загубити «Повернути».
 */
test("#1282e ПРОВОДКА: межі роутів і матриця, AI закрито, джоба по угодах щоночі під наглядом, вкладка з рішеннями й Excel", async () => {
  const r = SRC("routes/finance.ts");
  assert.match(r, /financeRouter\.get\("\/month-result", async \(req, res\) => \{\s*try \{\s*onlyFinance\(req\);/, "🔴 перегляд без межі першим рядком");
  assert.match(r, /financeRouter\.get\("\/month-result\/export\.xlsx", async \(req, res\) => \{\s*try \{\s*onlyFinance\(req\);/, "🔴 Excel без межі першим рядком");
  assert.match(r, /financeRouter\.put\("\/month-result\/override", async \(req, res\) => \{\s*try \{\s*canEdit\(req\);/, "🔴 рішення без права вносити першим рядком");
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js");
  for (const [m, p] of [["GET", "/api/finance/month-result?m=2026-09"], ["GET", "/api/finance/month-result/export.xlsx?m=2026-09"], ["PUT", "/api/finance/month-result/override"]])
    assert.deepEqual(ACCESS_MATRIX.find((x) => x.method === m && x.path === p)?.deny, ["hr", "team_lead", "manager"], `🔴 ${m} ${p} — не в матриці`);
  for (const tbl of ["deal_responsible_events", "deal_responsible_state", "fin_month_result_overrides"]) {
    assert.match(SRC("db/schema.sql"), new RegExp(`REVOKE ALL ON ${tbl} FROM ai_readonly;`), `🔴 ${tbl} відкрита для AI`);
    assert.match(SRC("ai/metricTools.ts"), new RegExp(`"${tbl}"`), `🔴 ${tbl} не в забороненых AI`);
  }
  const job = SRC("jobs/syncDealResponsible.ts");
  assert.match(job, /await fetchResponsibleEventsForLeads\(ids\)/, "🔴 джоба питає не по угодах");
  assert.doesNotMatch(job, /forEachResponsibleChangeEventPage/, "🔴 джоба тягне потік усіх подій");
  assert.match(SRC("kommo/client.ts"), /filter\[entity\]=lead&\$\{q\}/, "🔴 запит подій — не по конкретних угодах");
  assert.match(SRC("index.ts"), /cron\.schedule\("50 4 \* \* \*", \(\) => \{\s*void runJob\("syncDealResponsible", \(\) => syncDealResponsible\(\)\);/, "🔴 крону немає чи не щоночі");
  assert.match(SRC("jobs/monitoredJobs.ts"), /\{ name: "syncDealResponsible", everyMin: 1440,/, "🔴 нагляд не з тим самим інтервалом");
  const sec = FE("pages/dashboard/sections/FinanceSection.tsx");
  assert.match(sec, /\["result", "Результат місяця", false\]/, "🔴 вкладки немає");
  assert.match(sec, /\{tab === "result" && <FinanceMonthResultTab ask=\{ask\} toast=\{toast\} \/>\}/, "🔴 вкладка не рендериться");
  const tab = FE("pages/dashboard/sections/FinanceMonthResultTab.tsx");
  assert.match(tab, /setMonthResultOverride\(\{ kommoId: d\.id, action: null \}\)/, "🔴 «Повернути» не знімає рішення");
  assert.match(tab, />Повернути<\/button>/, "🔴 кнопки «Повернути» немає");
  assert.match(tab, /\{data\.canEdit && <td/, "🔴 кнопки рішень не за правом сервера");
  assert.match(tab, /downloadMonthResultXlsx\(ym\)/, "🔴 Excel не завантажується");
  assert.match(tab, /\$\{data\.kommoBase\}\/leads\/detail\/\$\{id\}/, "🔴 немає посилання на угоду в Kommo");
  assert.match(tab, /зараз: \{name\(d\.current\)/, "🔴 перепризначену не позначено");
});
