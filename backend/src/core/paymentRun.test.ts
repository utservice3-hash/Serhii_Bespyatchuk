import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  judgeRequest, cardOf, ownerLine, payRow, cashExpenseOf, isNetworkDrop, PAY_PIPELINE, PAY_STATUSES, PAY_RESPONSIBLE, PAY_URGENCY, PAY_CATEGORY,
  type PayRequest, type MainDeal, type PayContext,
} from "./paymentRun.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const NOW = new Date("2026-10-14T13:00:00Z");
// Номери карток у фікстурах вигадані (16 цифр за форматом), не справжні.
const req = (o: Partial<PayRequest> = {}): PayRequest => ({
  id: 1, createdAt: new Date("2026-10-14T08:00:00Z"), type: "Готівка", urgency: "Стандартная",
  phone: null, card: "1111222233334444", bank: "приват", recipient: "Іваненко Іван Іванович", cash: 18000, sourceDealId: 100, ttnFiles: 1, ...o,
});
const main = (o: Partial<MainDeal> = {}): MainDeal => ({ id: 100, cashExpense: 18000, paid1c: true, invoiceIssued: true, ...o });
const ctx = (o: Partial<PayContext> = {}): PayContext => ({
  dupOf: [], paidBefore: 0, openInvoices: [], bankSeen: null, limit: null, debt: null, ttnExempt: false, ...o,
});
const unpaid = (o: Partial<MainDeal> = {}) => main({ paid1c: false, ...o });

/**
 * #1267 — ПЕРЕВІРКИ ЗАПИТУ НА ОПЛАТУ (зустріч Романа з Тетяною 13.10.2026). Кожне правило — по ОБИДВА боки межі:
 * сума 18 000 при розході 18 000 — так, 19 000 — ні, а вже оплачене додається; рахунку немає — не платимо (але
 * неоплачений рахунок 1С угоди теж доводить, що рахунок є); оплата — галочка 1С, або платіж у «Виписці», або ліміт
 * у межах днів і суми; за лімітом — лише з ТТН (крім клієнтів Беспʼятчука); дубль, тип, картка, ПІБ, банк.
 * 🧨 Червоніє, якщо хоч одне правило перестане відсікати або почне відсікати чисте.
 */
test("#1267 ПЕРЕВІРКИ ЗАПИТУ: сума, рахунок, оплата (1С / Виписка / ліміт + ТТН), дубль і реквізити — по обидва боки межі", () => {
  const ok = (r: PayRequest, m: MainDeal | null, c: PayContext) => judgeRequest(r, m, c, NOW);
  const clean = ok(req(), main(), ctx());
  assert.deepEqual([clean.ok, clean.paidBy, clean.reasons], [true, "1С", []], "🔴 чистий запит з галочкою 1С не пройшов");
  // сума
  assert.equal(ok(req({ cash: 19000 }), main(), ctx()).ok, false, "🔴 19 000 при розході 18 000 пройшло");
  assert.equal(ok(req({ cash: 10000 }), main(), ctx({ paidBefore: 9000 })).ok, false, "🔴 уже оплачене не додається до суми");
  assert.equal(ok(req({ cash: 9000 }), main(), ctx({ paidBefore: 9000 })).ok, true, "🔴 рівно в межах розходу з урахуванням оплаченого — відкинуто");
  assert.match(ok(req(), main({ cashExpense: null }), ctx()).reasons.join(), /немає готівкового розходу/, "🔴 угода без готівкового розходу пройшла");
  // рахунок
  assert.match(ok(req(), unpaid({ invoiceIssued: false }), ctx({ bankSeen: { invoiceNo: "8482", bookedOn: "2026-10-13" } })).reasons.join(),
    /рахунок клієнту не виставлено/, "🔴 без рахунку пройшло");
  assert.equal(ok(req(), unpaid({ invoiceIssued: false }), ctx({ openInvoices: ["8482"], bankSeen: { invoiceNo: "8482", bookedOn: "2026-10-13" } })).ok, true,
    "🔴 неоплачений рахунок 1С угоди не визнано за виставлений");
  // оплата
  const bank = ok(req(), unpaid(), ctx({ bankSeen: { invoiceNo: "8482", bookedOn: "2026-10-13" } }));
  assert.deepEqual([bank.ok, bank.paidBy], [true, "Виписка"], "🔴 оплата у Виписці не зарахована");
  assert.match(ok(req(), unpaid(), ctx()).reasons.join(), /оплати від клієнта немає, і ліміту немає/, "🔴 без оплати й ліміту пройшло");
  assert.match(ok(req(), unpaid(), ctx({ limit: { days: 0, amount: null } })).reasons.join(), /ліміт не надано/, "🔴 ліміт 0 днів зарахований");
  const inLim = ctx({ limit: { days: 14, amount: 30000 }, debt: { amount: 30000, ageDays: 14 } });
  assert.deepEqual([ok(req(), unpaid(), inLim).ok, ok(req(), unpaid(), inLim).paidBy], [true, "ліміт"], "🔴 борг рівно на межі ліміту відкинуто");
  assert.match(ok(req(), unpaid(), ctx({ limit: { days: 14, amount: 30000 }, debt: { amount: 30000, ageDays: 15 } })).reasons.join(), /ліміт перевищено/, "🔴 15 дн. при ліміті 14 пройшло");
  assert.match(ok(req(), unpaid(), ctx({ limit: { days: 14, amount: 30000 }, debt: { amount: 30001, ageDays: 1 } })).reasons.join(), /ліміт перевищено/, "🔴 борг понад суму ліміту пройшов");
  assert.match(ok(req({ ttnFiles: 0 }), unpaid(), inLim).reasons.join(), /ТТН не прикріплено/, "🔴 за лімітом без ТТН пройшло");
  assert.equal(ok(req({ ttnFiles: 0 }), unpaid(), { ...inLim, ttnExempt: true }).ok, true, "🔴 клієнту Беспʼятчука ТТН вимагається");
  assert.equal(ok(req({ ttnFiles: 0 }), main(), ctx()).ok, true, "🔴 ТТН вимагається й там, де оплата вже є");
  // дубль, тип, реквізити, угода
  assert.match(ok(req(), main(), ctx({ dupOf: [7] })).reasons.join(), /можливий дубль: запит #7/, "🔴 дубль пройшов");
  assert.match(ok(req({ type: "ТОВ" }), main(), ctx()).reasons.join(), /а не «Готівка»/, "🔴 безготівковий запит пройшов");
  assert.match(ok(req({ card: "111122223333444" }), main(), ctx()).reasons.join(), /не 16 цифр/, "🔴 картка з 15 цифр пройшла");
  assert.match(ok(req({ recipient: " " }), main(), ctx()).reasons.join(), /немає ПІБ/, "🔴 без ПІБ пройшло");
  assert.match(ok(req({ bank: null }), main(), ctx()).reasons.join(), /не вказано банк/, "🔴 без банку пройшло");
  assert.match(ok(req(), null, ctx()).reasons.join(), /основну угоду #100 не знайдено/, "🔴 без основної угоди пройшло");
  // підказка про старий запит — примітка, а не причина
  const stale = ok(req({ createdAt: new Date("2026-10-08T08:00:00Z") }), main(), ctx());
  assert.deepEqual([stale.ok, stale.notes], [true, ["висить 6 дн."]], "🔴 давність стала причиною або зникла");
});

/**
 * #1267b — ФОРМАТ РЯДКА = ТАНИН ФАЙЛ «Обработка выгрузки»: ID основної угоди | картка `0000 0000 0000 0000` | ПІБ,
 * банк і телефон як вніс менеджер | сума | «Транспортні послуги». Готівковий розхід угоди — лише слоти з готівковим
 * типом («Наличные» / «Готівка»), безнал не рахується.
 * 🧨 Червоніє, якщо зміниться формат картки, склад «власника» чи категорія, або безнал потрапить у готівковий розхід.
 */
test("#1267b ФОРМАТ ФАЙЛУ: картка 0000 0000 0000 0000, власник як вніс менеджер, «Транспортні послуги»; готівка — лише готівкові слоти", () => {
  assert.equal(cardOf("1111 2222 3333 4444"), "1111 2222 3333 4444");
  assert.equal(cardOf("1111222233334444"), "1111 2222 3333 4444", "🔴 картку не розбито по 4 цифри");
  assert.equal(cardOf("1111-2222-3333-444"), null, "🔴 15 цифр видано за картку");
  assert.equal(ownerLine({ recipient: " Іваненко  Іван ", bank: "моно,", phone: "0961112233" }), "Іваненко Іван моно 0961112233", "🔴 власник картки не як у файлі Тані");
  assert.equal(ownerLine({ recipient: "Іваненко", bank: "приват", phone: null }), "Іваненко приват", "🔴 порожній телефон лишив хвіст");
  assert.deepEqual(payRow(req({ phone: "0961112233" }), main({ id: 62762651 })),
    [62762651, "1111 2222 3333 4444", "Іваненко Іван Іванович приват 0961112233", 18000, PAY_CATEGORY], "🔴 рядок не в колонках Таниного файлу");
  assert.equal(PAY_CATEGORY, "Транспортні послуги");
  const f: Record<number, string> = { 2097661: "10000", 2097651: "Наличные", 2097663: "5000", 2097653: "Безнал с НДС", 2097665: "3000", 2097655: "Готівка" };
  assert.equal(cashExpenseOf((id) => f[id]), 13000, "🔴 у готівковий розхід потрапив безнал або загубився слот «Готівка»");
  assert.equal(cashExpenseOf((id) => ({ 2097661: "10000", 2097651: "Безнал без НДС" } as Record<number, string>)[id]), null, "🔴 угода без готівки дала число");
});

/**
 * #1268 — ПРОВОДКА: фільтр — рівно Танин (воронка, три етапи, відповідальна, «Стандартная»); у Kommo нічого не
 * пишемо (паралельний тиждень); у стані прогону немає номерів карток і ПІБ; крон — :40 щогодини + 16:55 у будні,
 * нагляд — 60 хв, як у кроні.
 * 🧨 Червоніє, якщо з'явиться запис у Kommo, номер картки потрапить у базу або розклад розійдеться з наглядом.
 */
test("#1268 ПРОВОДКА ФАЙЛУ НА ОПЛАТУ: Танин фільтр, у Kommo не пише, картки не в базі, писар окремо від Сейфу, крон :40 + 16:55 під наглядом", async () => {
  assert.deepEqual([PAY_PIPELINE, [...PAY_STATUSES], PAY_RESPONSIBLE, PAY_URGENCY], [7341740, [60434920, 60434924, 60436036], 10081384, "Стандартная"],
    "🔴 фільтр розійшовся з Таниним");
  const job = SRC("jobs/buildPaymentFile.ts"), core = SRC("core/paymentRun.ts");
  for (const [name, src] of [["джоба", job], ["ядро", core]] as const)
    assert.doesNotMatch(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""), /kommoWrite|kommoDelete|method:\s*"(POST|PATCH|DELETE)"/, `🔴 ${name} пише в Kommo`);
  const state = job.slice(job.indexOf("INSERT INTO payment_file_state"), job.indexOf("return { at, queue"));
  assert.ok(state.length > 0, "🔴 запис стану не знайдено — гейту нічого перевіряти");
  const rowIface = job.slice(job.indexOf("export interface RunRow"), job.indexOf("export interface RunResult"));
  assert.doesNotMatch(rowIface, /card|recipient|phone|bank/, "🔴 у стані прогону (база) опинились реквізити картки");
  // Запис у Google — окремий модуль; модуль Сейфу (читання) писати не вміє, і Сейф писаря не імпортує (#1249 — про Сейф).
  assert.match(job, /^import \{ writeSheetTab \} from "\.\.\/bankSources\/googleSheetsWrite\.js";$/m, "🔴 файл на оплату пише не через окремого писаря");
  assert.doesNotMatch(SRC("jobs/syncSafe.ts") + SRC("core/safeSync.ts"), /googleSheetsWrite/, "🔴 шлях Сейфу отримав право запису в таблицю");
  assert.doesNotMatch(SRC("bankSources/googleSheets.ts"), /writeSheetTab|method: "(PUT|PATCH)"|:clear|:batchUpdate|auth\/spreadsheets"/, "🔴 модуль читання Сейфу навчився писати");
  const idx = SRC("index.ts");
  assert.match(idx, /cron\.schedule\("40 \* \* \* \*", \(\) => \{ void runJob\("buildPaymentFile", \(\) => buildPaymentFile\(\)\); \}/, "🔴 немає щогодинного :40");
  assert.match(idx, /cron\.schedule\("55 16 \* \* 1-5", \(\) => \{ void runJob\("buildPaymentFile", \(\) => buildPaymentFile\(\)\); \}/, "🔴 немає фінального 16:55");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "buildPaymentFile")?.everyMin, 60, "🔴 нагляд не збігається з кроном");
});

/**
 * #1268b — ОБРИВ ЗʼЄДНАННЯ З KOMMO ПОВТОРЮЄТЬСЯ ОДИН РАЗ, ВІДМОВА З КОДОМ — НІ. 13.10.2026 сухий прогін упав на
 * «other side closed» посеред відповіді, повтор пройшов. По обидва боки: мережевий обрив — повтор; 403 — ні.
 * 🧨 Червоніє, якщо обрив валитиме прогін або 403 почне повторюватись.
 */
test("#1268b ОБРИВ KOMMO: мережевий обрив — один повтор, відмова з кодом — без повтору", () => {
  // Кожен вид обриву — окремо: одна фікстура з кількома ознаками лишала гейт зеленим, коли правило губило ознаку.
  assert.equal(isNetworkDrop(new TypeError("terminated")), true, "🔴 «terminated» (undici) не повторюється");
  assert.equal(isNetworkDrop({ message: "x", cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), true, "🔴 код UND_ERR_* не повторюється");
  assert.equal(isNetworkDrop(new Error("other side closed")), true, "🔴 «other side closed» не повторюється");
  assert.equal(isNetworkDrop(new Error("read ECONNRESET")), true, "🔴 ECONNRESET не повторюється");
  assert.equal(isNetworkDrop(new Error("Kommo 403 Forbidden")), false, "🔴 відмову з кодом повторюємо");
  const job = SRC("jobs/buildPaymentFile.ts");
  assert.match(job, /const queue = await once\(fetchQueue\);/, "🔴 черга без повтору");
  assert.match(job, /await once\(\(\) => fetchLeadsByIds\(ids\)\)/, "🔴 основні угоди без повтору");
  assert.match(job, /catch \(e\) \{ if \(!isNetworkDrop\(e\)\) throw e;/, "🔴 повтор не за правилом обриву");
});

