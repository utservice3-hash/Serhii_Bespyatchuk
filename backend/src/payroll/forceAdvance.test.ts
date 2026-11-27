import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🆘 «Аванс форс-мажор» (задача 10723, PDF Тетяни 27.11; Роман 27.11: «ліміти такі самі, як і звичайного авансу. Тільки Сергій
 * погоджує. Ну, загалом я з тобою згоден»): будь-коли, кілька на місяць, з причиною; ліміт спільний зі звичайним авансом;
 * погоджує лише ОД, далі фінансист виплачує; відомість віднімає ВСІ виплачені аванси, «До виплати» не нижче 0; звільненим — ні.
 * Гейти `#11350`–`#11354`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

type Adv = Record<string, unknown>;
const fmA = (o: Adv = {}): Adv => ({ id: 1, amount: 3000, cash: 3000, cards: [], note: "лікування", requestedAt: "2026-11-27T10:00", ...o });
const PAID = { approvedAt: "2026-11-27T11:00", paidAt: "2026-11-27T12:00" };
const REG = { id: 9, amount: 5000, cash: 5000, cards: [], requestedAt: "2026-11-26T10:00", paidAt: "2026-11-26T12:00" };

/** Ставка 20 000 (HR): ліміт звичайного авансу = 50 % ставки = 10 000. `fm === undefined` — стан як у пакеті. */
async function mk(fm?: Adv[], reg?: Adv) {
  const { createPayroll } = await import("./engine/zarplata-engine.mjs");
  const { createNotifier } = await import("./engine/notify.mjs");
  const base = { dept: "hr", startDate: "2024-01-01", birthday: null, official: [], leave: null, clientRates: [], adjustments: [] };
  const state = {
    now: "2026-11-27T16:00", liveMonth: "2026-11", closedMonth: "2026-10", settings: { birthday: { v2From: null } },
    employees: [{ ...base, id: "S", name: "Олена", role: "staff", title: "HR", team: null, terms: [{ from: "2000-01", rate: 20000 }] }],
    departments: { hr: { name: "HR" } }, teams: {}, plans: {}, deals: {}, kpi: {}, records: {}, clearances: {},
    advances: reg ? { "2026-11": { S: reg } } : {},
    responsibles: { ba: { id: "", name: "БА" }, acc: { id: "", name: "Бух" }, hr: { id: "7", name: "HR" }, od: { id: "3", name: "ОД" }, finance: ["8"] },
    ...(fm === undefined ? {} : { fmAdvances: { "2026-11": { S: fm } }, fmApprovers: ["3"] }),
  };
  const zp = createPayroll(state as never);
  return { zp, nt: createNotifier(zp, state) };
}

/**
 * #11350 — ВІДОМІСТЬ: звичайний 5 000 і форс-мажор 3 000, обидва виплачені → аванс 8 000, «До виплати» 12 000. Пара: поданий,
 * але не погоджений форс-мажор не віднімається; аванси понад ЗП дають 0, а не мінус. 🧨 Червоніє, якщо рушій бере лише один аванс,
 * віднімає непогоджений або пускає «До виплати» в мінус.
 */
test("#11350 ВІДОМІСТЬ: віднімає звичайний і форс-мажор разом; непогоджений — ні; «До виплати» не нижче 0", async () => {
  const both = (await mk([fmA(PAID)], REG)).zp.settlement("S", "2026-11") as { advance: number; pay: number; total: number };
  assert.equal(both.total, 20000, "🔴 фікстура: нараховано 20 000");
  assert.equal(both.advance, 8000, `🔴 аванс ${both.advance}, а виплачено 5 000 + 3 000`);
  assert.equal(both.pay, 12000, `🔴 до виплати ${both.pay}, чекали 12 000`);
  const pend = (await mk([fmA()], REG)).zp.settlement("S", "2026-11") as { advance: number };
  assert.equal(pend.advance, 5000, "🔴 непогоджений форс-мажор віднято з ЗП");
  const big = (await mk([fmA({ ...PAID, amount: 25000 })])).zp.settlement("S", "2026-11") as { pay: number };
  assert.equal(big.pay, 0, `🔴 аванси понад ЗП: «До виплати» ${big.pay}, а має бути 0`);
});

/**
 * #11351 — ЛІМІТ СПІЛЬНИЙ: поданий форс-мажор 3 000 зменшує звичайний ліміт 10 000 → 7 000; звичайний 5 000 зменшує ліміт
 * форс-мажору; відхилений не займає ліміту; без `fmAdvances` у стані — як у пакеті (поля `fm` немає, сума та сама).
 * 🧨 Червоніє, якщо ліміти рахувати окремо або відхилений «їсть» ліміт.
 */
test("#11351 ЛІМІТ: один на обидва види — форс-мажор зменшує звичайний і навпаки; відхилений не займає; пакет — без змін", async () => {
  const L = async (fm?: Adv[], reg?: Adv) => (await mk(fm, reg)).zp.advanceLimit("S", "2026-11") as { amount: number; fm?: number };
  const pkg = await L();
  assert.equal(pkg.amount, 10000, "🔴 фікстура: 50 % ставки 20 000");
  assert.equal(pkg.fm, undefined, "🔴 без fmAdvances рушій має рахувати як пакет");
  const pend = await L([fmA()]);
  assert.deepEqual([pend.amount, pend.fm], [7000, 7000], "🔴 поданий форс-мажор має зменшити обидва ліміти");
  const withReg = await L([fmA(PAID)], REG);
  assert.deepEqual([withReg.amount, withReg.fm], [7000, 2000], "🔴 звичайний аванс зменшує ліміт форс-мажору");
  const rej = await L([fmA({ rejectedAt: "2026-11-27T11:00", reason: "ні" })]);
  assert.deepEqual([rej.amount, rej.fm], [10000, 10000], "🔴 відхилений форс-мажор не займає ліміту");
});

/**
 * #11352 — СПОВІЩЕННЯ: заявка йде лише тим, хто погоджує (ОД), і висить до рішення; погоджено → фінансистам «виплатити» (висить
 * до виплати) і працівнику до відома. 🧨 Червоніє, якщо заявку отримають фінансисти до погодження або сповіщення не закривається.
 */
test("#11352 СПОВІЩЕННЯ: заявка — лише ОД, до рішення; після погодження — фінансистам до виплати, працівнику до відома", async () => {
  const open = (await mk([fmA()])).nt;
  const [n] = open.build.fmRequested("S", "2026-11", 1) as Array<{ type: string; to: string[]; go: unknown }>;
  assert.deepEqual([n.type, n.to], ["adv.fm", ["3"]], "🔴 заявку форс-мажор отримує лише ОД");
  assert.deepEqual(n.go, { tab: "adv" }, "🔴 посилання — у «Аванси»");
  assert.equal(open.notificationDoneAt(n), null, "🔴 до рішення сповіщення висить");
  const ok = (await mk([fmA({ approvedAt: "2026-11-27T11:00" })])).nt;
  assert.equal(ok.notificationDoneAt(n), "2026-11-27T11:00", "🔴 погодження закриває заявку ОД");
  const ap = ok.build.fmApproved("S", "2026-11", 1) as Array<{ type: string; to: string[] }>;
  assert.deepEqual(ap.map((x) => [x.type, x.to]), [["adv.req", ["8"]], ["adv.res", ["S"]]], "🔴 після погодження — фінансистам і працівнику");
  assert.equal(ok.notificationDoneAt(ap[0]), null, "🔴 «виплатити» висить, поки не виплачено");
  assert.equal((await mk([fmA(PAID)])).nt.notificationDoneAt(ap[0]), "2026-11-27T12:00", "🔴 виплата закриває «виплатити»");
});

/**
 * #11353 — КОЖЕН ТИП СПОВІЩЕНЬ РУШІЯ МАЄ РЯДОК У `notify_rules`. Без рядка `emitAll` мовчки пропускає сповіщення — так заявка на
 * «Профі» (`lvl.req`) першою редакцією не дійшла б нікому. 🧨 Червоніє, якщо додати тип у NOTIFICATION_TYPES і забути сід.
 */
test("#11353 СПОВІЩЕННЯ НЕ ЗНИКАЮТЬ: кожен тип рушія має рядок у notify_rules", async () => {
  const { NOTIFICATION_TYPES } = await import("./engine/notify.mjs");
  const keys = Object.keys(NOTIFICATION_TYPES);
  assert.ok(keys.includes("adv.fm") && keys.includes("lvl.req"), "🔴 фікстура: нові типи мають бути в рушії");
  const sql = SRC("db/schema.sql");
  const seeded = new Set([...sql.matchAll(/^\s*\('([a-z.]+)',\s*'[^']*',\s*(?:true|false),/gm)].map((m) => m[1]));
  const missing = keys.filter((k) => !seeded.has(k));
  assert.deepEqual(missing, [], `🔴 типи без рядка в notify_rules — сповіщення не надсилатимуться: ${missing.join(", ")}`);
});

/**
 * #11354 — ДЖЕРЕЛО: погоджує лише ОД (право `payroll_fm_approve`); «один на місяць» — лише для звичайних; форс-мажор стартує
 * `pending`; звільненим подати не можна; екрани мають кнопки. 🧨 Червоніє, якщо дати право іншим ролям, повернути індекс на всі
 * аванси, пропустити погодження або прибрати заборону звільненим.
 */
test("#11354 ДЖЕРЕЛО: право — лише ОД; індекс — лише звичайні; форс-мажор чекає ОД; звільненим — ні; екрани", () => {
  const sql = SRC("db/schema.sql"), svc = SRC("payroll/service.ts"), routes = SRC("routes/payroll.ts");
  assert.match(sql, /'\{"payroll_fm_approve":true\}'::jsonb WHERE key IN \('opdir'\);\nUPDATE roles SET permissions = permissions - 'payroll_fm_approve' WHERE key NOT IN \('opdir'\);/, "🔴 погоджує лише ОД");
  assert.match(sql, /payroll_advances_one_regular ON payroll_advances \(month, user_id\) WHERE kind = 'regular' AND status IN \('requested', 'paid'\);\nDROP INDEX IF EXISTS payroll_advances_one_active;/, "🔴 «один на місяць» — лише звичайний");
  assert.match(svc, /VALUES \(\$1::date,\$2,\$3,\$4,\$5,'fm','pending',\$6\)/, "🔴 форс-мажор стартує з «чекає ОД»");
  assert.match(svc, /if \(p\.leave\) fail\(409, "Після звільнення аванс форс-мажор не подається/, "🔴 звільненим форс-мажор не подається");
  assert.match(routes, /post\("\/advances\/:id\/fm-approve", h\(\["payroll_fm_approve"\],/, "🔴 погодити — лише з правом ОД");
  assert.match(routes, /post\("\/advances\/:id\/fm-reject", h\(\["payroll_fm_approve"\],/, "🔴 відхилити — лише з правом ОД");
  assert.match(FRONT("payroll/cabinet/Advance.tsx"), />Аванс форс-мажор<\/button>/, "🔴 кнопка в кабінеті");
  const tab = FRONT("payroll/finance/AdvancesTab.tsx");
  assert.match(tab, /r\.status === "pending" && canFm &&/, "🔴 «Погодити» бачить лише той, хто має право");
  assert.match(tab, /<Pill tone="danger">форс-мажор<\/Pill>/, "🔴 позначка форс-мажору в «Авансах»");
});
