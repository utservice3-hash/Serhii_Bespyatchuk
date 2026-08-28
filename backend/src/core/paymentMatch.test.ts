import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  invoiceNoCandidates, invoicePaymentsSql, livesNamedBy, matchAll, matchPayment,
  normalizeEdrpou, rollUp, stripLeadingZeros, SEEN_MAX_WORKDAYS,
  type IncomingPayment, type OpenInvoice,
} from "./paymentMatch.js";

const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const SRC = (p: string) => srcOf(`../${p}`);
const FE = (p: string) => srcOf(`../../../frontend/src/${p}`);

const EDR = "32210390";
const inv = (no: string, amount = 1000, edrpou: string | null = EDR): OpenInvoice =>
  ({ invoiceNo: no, amount, edrpou });
const pay = (o: Partial<IncomingPayment> & { purpose: string | null }): IncomingPayment =>
  ({ txId: 1, bookedOn: "2026-08-28", amount: 1000, payerEdrpou: EDR, ...o });
const openMap = (...is: OpenInvoice[]) =>
  new Map(is.map((i) => [stripLeadingZeros(i.invoiceNo), i]));

/* ═══════════════════ РОЗБІР ПРИЗНАЧЕННЯ ═══════════════════ */

/**
 * #24e — КАНДИДАТИ, А НЕ «РОЗПІЗНАНИЙ НОМЕР».
 *
 * 🔴 ЗАМІРЯНО НА 855 ЖИВИХ ПРИЗНАЧЕННЯХ 28.08.2026: наївний розбір витягує
 * договори й дати. Сьогодні жоден не влучив лише тому, що живі номери
 * чотиризначні (5000-7000) — тобто нас рятує ВЛАСТИВІСТЬ ДАНИХ, а не код.
 * Тому рішення ухвалює не розбір, а звірка з реальними відкритими рахунками.
 */
test("#24e договір і дата не стають рахунком — рішення ухвалює звірка з відкритими", () => {
  // Реальні рядки з прода, дослівно.
  const contract = "Оплата за організацію перевезення в межах території України по Договору №10012022";
  const dated = "Сплата за організацію перевезення згідно рах. б/н від 06.08.2026 року.";
  const dashed = "За організацію перевезення зг. Договору № 04-20/12-25 від 20.12.2025р.";

  // Розбір справді витягує ці числа — і це НЕ помилка розбору, а його межа.
  assert.ok(invoiceNoCandidates(contract).includes("10012022"),
    "🔴 фікстура не відтворює проблему: число з договору не витягується взагалі");

  // 🔴 А ОСЬ РІШЕННЯ мусить бути порожнім: серед відкритих таких немає.
  const open = openMap(inv("000006708"));
  assert.deepEqual(livesNamedBy(pay({ purpose: contract }), open), []);
  assert.deepEqual(livesNamedBy(pay({ purpose: dated }), open), []);
  assert.deepEqual(livesNamedBy(pay({ purpose: dashed }), open), []);

  // 🪞 ДЗЕРКАЛО: справжній номер ВПІЗНАЄТЬСЯ. Без нього «нічого не впізнавати»
  // було б зеленим, а колонка — суцільним «не зіставлено».
  const real = "Оплата за послугу згідно рахунка №6708, від 17.08.2026 у т. ч. ПДВ 2_333,33 грн.";
  assert.deepEqual(livesNamedBy(pay({ purpose: real }), open), ["6708"]);
});

/**
 * #24e2 — НУЛІ. У дебіторці `000006708`, у призначенні `№6708`.
 * Без обрізання збігів було б РІВНО НУЛЬ, і це виглядало б як «фіча не працює».
 */
test("#24e2 номери порівнюються без ведучих нулів — інакше збігів нуль", () => {
  assert.equal(stripLeadingZeros("000006708"), "6708");
  const seen = matchPayment(inv("000006708"), [pay({ purpose: "зг. рах. №6708" })],
    openMap(inv("000006708")), "2026-08-28");
  assert.equal(seen.kind, "seen", "🔴 нулі не обрізались — жоден рахунок не зіставиться ніколи");
});

/* ═══════════════════ ПРАВИЛА ВЛАСНИКА ═══════════════════ */

/**
 * #24f — НАЗВАНО НОМЕР → ПІДБІР ЗА СУМОЮ НЕ ВМИКАЄТЬСЯ.
 *
 * 🔴 НАЙДОРОЖЧА ПОМИЛКА, ЯКУ ФІЧА МОГЛА ЗРОБИТИ, і вона заміряна: «СМАР ТЕКС»
 * платить 42 000 ₴ за рахунком 6704, той уже рознесли, а 42 000 випадково
 * дорівнює ЧУЖОМУ відкритому 6829. Провал у підбір за сумою приписав би гроші
 * не тому рахунку — і з повною впевненістю.
 */
test("#24f названо номер → за сумою не підбираємо, навіть коли сума збігається", () => {
  const alien = inv("000006829", 42000);
  const open = openMap(alien);
  const p = pay({ purpose: "Оплата за перевезення згідно рах.№ 6704 від 17.08.2026р.", amount: 42000 });
  assert.equal(matchPayment(alien, [p], open, "2026-08-28").kind, "none",
    "🔴 платіж із НАЗВАНИМ 6704 зарахувався ЧУЖОМУ 6829 за збігом суми");
  // 🪞 ДЗЕРКАЛО: без номера той самий платіж на ту саму суму ЗАРАХОВУЄТЬСЯ —
  // інакше «ніколи не підбирати» було б зеленим, а правило власника мертвим.
  const noNum = pay({ purpose: "Оплата за транспортні послуги", amount: 42000 });
  assert.equal(matchPayment(alien, [noNum], open, "2026-08-28").kind, "seen");
});

/**
 * #24g — БЕЗ НОМЕРА Й КІЛЬКА РАХУНКІВ НА ТУ САМУ СУМУ → НЕ ВГАДУЄМО.
 * 📐 Заміряно: платежів без номера за 30 днів — 1, і зона «2+» сьогодні порожня.
 * Механізм мусить її вміти до того, як вона наповниться.
 */
test("#24g без номера і кілька рахунків на ту саму суму → ambiguous, не перший-ліпший", () => {
  const a = inv("6001", 5000), b = inv("6002", 5000);
  const open = openMap(a, b);
  const p = pay({ purpose: "Оплата за послуги", amount: 5000 });
  assert.equal(matchPayment(a, [p], open, "2026-08-28").kind, "ambiguous");
  assert.equal(matchPayment(b, [p], open, "2026-08-28").kind, "ambiguous");
  // 🪞 Один рахунок на цю суму — беремо.
  assert.equal(matchPayment(a, [p], openMap(a), "2026-08-28").kind, "seen");
});

/**
 * #24h — СУМА НЕПОВНА І НОМЕРА НЕМАЄ → НІЧОГО.
 *
 * ⚠️ І ГОЛОВНЕ ПРО СУМУ: `receivable_invoices.amount` — це ЗАЛИШОК, а не сума
 * рахунка. Доказ із живих даних: платник САМ пише «часткова оплата за Рахунок
 * № 4488», платячи 200 000 ₴ проти залишку 41 145 ₴. Отже «менше» не означає
 * «часткова», «більше» не означає «переплата», і сума в рішенні «за номером»
 * не бере участі ВЗАГАЛІ.
 */
test("#24h неповна сума без номера → нічого; а з номером сума не заважає", () => {
  const i = inv("6100", 4800);
  const partial = pay({ purpose: "Оплата за послуги", amount: 4000 });
  assert.equal(matchPayment(i, [partial], openMap(i), "2026-08-28").kind, "none",
    "🔴 неповну суму без номера зарахували — це відмітка на неоплаченому рахунку");
  // 🔴 А ЗА НОМЕРОМ — зараховуємо будь-яку суму: «менше залишку» не означає
  // «часткова оплата», і вирішувати за платника ми не маємо права.
  const named = pay({ purpose: "часткова оплата за Рахунок на оплату № 6100", amount: 4000 });
  assert.equal(matchPayment(i, [named], openMap(i), "2026-08-28").kind, "seen");
});

/**
 * #24i — ДРУГИЙ БАРʼЄР: ЄДРПОУ ПЛАТНИКА ПРОТИ КЛІЄНТА РАХУНКА.
 *
 * 🔴 ЛОВИТЬ ТЕ, ЧОГО НЕ ЛОВИТЬ `#24e`: чуже число (договір, дата), що ЗБІГЛОСЬ
 * із живим рахунком. Заміряно: розбіжностей сьогодні 0 із 31 — тобто барʼєр
 * стоїть заздалегідь і мовчить, а не «нічого не робить».
 */
test("#24i чужий ЄДРПОУ не відмічає рахунок, навіть коли номер збігся", () => {
  const i = inv("6200", 1000, "32210390");
  const stranger = pay({ purpose: "зг. рах. № 6200", payerEdrpou: "46353132" });
  assert.equal(matchPayment(i, [stranger], openMap(i), "2026-08-28").kind, "ambiguous",
    "🔴 гроші чужої фірми зарахувались за збігом номера");
  // 🔴 FAIL-CLOSED: невідомий ЄДРПОУ з БУДЬ-ЯКОГО боку — теж не відмічаємо.
  assert.equal(matchPayment(inv("6200", 1000, null), [pay({ purpose: "зг. рах. № 6200" })],
    openMap(inv("6200", 1000, null)), "2026-08-28").kind, "ambiguous");
  assert.equal(matchPayment(i, [pay({ purpose: "зг. рах. № 6200", payerEdrpou: null })],
    openMap(i), "2026-08-28").kind, "ambiguous");
  // 🪞 ДЗЕРКАЛО: свій ЄДРПОУ — відмічається. Інакше «не відмічати нікого»
  // проходило б, а фіча була б мертвою.
  assert.equal(matchPayment(i, [pay({ purpose: "зг. рах. № 6200" })], openMap(i), "2026-08-28").kind, "seen");
  assert.equal(normalizeEdrpou(" 0032210390 "), "32210390");
});

/**
 * #24j — ПЛАТІЖ, ЩО НАЗИВАЄ КІЛЬКА ЖИВИХ РАХУНКІВ, НЕ ВІДМІЧАЄ ЖОДНОГО.
 *
 * 📐 Заміряно: 28 із 855 призначень називають більше одного номера
 * («зг. рах. № 6683, № 6459»); живих серед них сьогодні нуль. Зона порожня —
 * але вона існує, і саме тут «за номером» перестає бути однозначним.
 * Рішення власника 28.08.2026: не відмічаємо, але кажемо ПРИЧИНУ окремо.
 */
test("#24j платіж на кілька живих рахунків → ambiguous в ОБОХ, а не в жодному", () => {
  const a = inv("6683"), b = inv("6459");
  const open = openMap(a, b);
  const p = pay({ purpose: "Оплата за організацію перевезення вантажу, зг. рах. № 6683, № 6459" });
  assert.deepEqual(livesNamedBy(p, open).sort(), ["6459", "6683"]);
  assert.equal(matchPayment(a, [p], open, "2026-08-28").kind, "ambiguous");
  assert.equal(matchPayment(b, [p], open, "2026-08-28").kind, "ambiguous");
  // 🪞 Той самий платіж, коли живий лише ОДИН із названих — однозначний.
  assert.equal(matchPayment(a, [p], openMap(a), "2026-08-28").kind, "seen");
});

/**
 * #24k — СТЕЛЯ ДВА РОБОЧІ ДНІ, І ПІСЛЯ НЕЇ СТАН НЕ ЗНИКАЄ, А КАЖЕ ПРО СЕБЕ.
 *
 * 🔴 ДНІ РОБОЧІ, А НЕ ГОДИНИ: пʼятничний платіж не має світитись у понеділок
 * уранці без причини. 🔴 І від `booked_at` — це факт банку, а не наш `seen_at`.
 *
 * ⚠️ Саме число — ОЦІНКА ЗІ СЛІВ ВЛАСНИКА, не замір: історії рознесення не
 * існує (`receivable_invoices` TRUNCATE-иться), тож перевірити її можна лише
 * спостереженням уперед.
 */
test("#24k стеля — два РОБОЧІ дні, і після неї стан stale, а не зникнення", () => {
  const i = inv("6300");
  const at = (d: string) => matchPayment(i, [pay({ purpose: "рах. № 6300", bookedOn: d })], openMap(i), "2026-08-28");
  // 28.08.2026 — пʼятниця. Платіж у пʼятницю → 0 робочих днів.
  assert.equal(at("2026-08-28").kind, "seen");
  assert.equal(at("2026-08-26").kind, "seen", "🔴 два робочі дні вже стали простроченням");
  assert.equal(at("2026-08-25").kind, "stale", "🔴 три робочі дні не дали stale");
  // 🔴 ВИХІДНІ НЕ РАХУЮТЬСЯ: платіж у пʼятницю 21.08 на понеділок 24.08 — це
  // ОДИН робочий день, а не три календарні.
  const mon = matchPayment(i, [pay({ purpose: "рах. № 6300", bookedOn: "2026-08-21" })], openMap(i), "2026-08-24");
  assert.equal(mon.kind, "seen", "🔴 пʼятничний платіж червоніє в понеділок — дні рахуються календарно");
  assert.equal(mon.workdays, 1);
  assert.equal(SEEN_MAX_WORKDAYS, 2);
  // Стан НЕ зникає: `stale` несе дату й суму, тобто слід лишається.
  assert.equal(at("2026-08-25").bookedOn, "2026-08-25");
  assert.ok((at("2026-08-25").amount ?? 0) > 0);
});

/* ═══════════════════ ЗГОРТКА Й ЕКРАН ═══════════════════ */

test("#24l порожнеча НАЗИВАЄ СЕБЕ, і три стани не зливаються в один підпис", async () => {
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    seenCell: (s: unknown) => { text: string; why: string | null; tone: string };
    seenRollLabel: (r: unknown) => { text: string; tone: string } | null;
  };
  const none = V.seenCell({ kind: "none" });
  assert.ok(none.text.trim().length > 0, "🔴 «не зіставлено» стало порожньою клітинкою");
  assert.match(none.text, /не зіставлено/);
  assert.ok(none.why, "🔴 порожнеча без пояснення — це порожнеча");

  const amb = V.seenCell({ kind: "ambiguous" });
  assert.match(amb.text, /кілька рахунків/,
    "🔴 «платіж називає кілька рахунків» злився з «не зіставлено» — людина втратила ПРИЧИНУ "
    + "і піде шукати наосліп (рішення власника 28.08.2026)");
  assert.notEqual(amb.text, none.text);

  const seen = V.seenCell({ kind: "seen", bookedOn: "2026-08-28" });
  const stale = V.seenCell({ kind: "stale", bookedOn: "2026-08-20", workdays: 6 });
  assert.notEqual(seen.text, stale.text, "🔴 «зайшли» і «не рознесено» — один підпис");
  assert.match(stale.text, /не рознесено/);
  assert.equal(stale.tone, "warn");
  // Усі чотири підписи різні — жоден не поглинув сусіда.
  assert.equal(new Set([none.text, amb.text, seen.text, stale.text]).size, 4);

  // Згортка: мовчить, коли казати нема про що, і називає проблемні окремо.
  assert.equal(V.seenRollLabel({ seen: 0, stale: 0, ambiguous: 0, total: 5 }), null,
    "🔴 «0 з 5» у кожному рядку — шпалери, які перестають читати");
  assert.equal(V.seenRollLabel(null), null);
  const roll = V.seenRollLabel({ seen: 2, stale: 1, ambiguous: 1, total: 5 });
  assert.match(roll!.text, /3 з 5/, "🔴 stale випав зі згортки — гроші є, а їх не порахували");
  assert.match(roll!.text, /не рознесено/);
  assert.match(roll!.text, /неоднозначн/);
  assert.equal(roll!.tone, "warn");

  // Ядро згортки — те саме, що дає ці числа.
  assert.deepEqual(rollUp([{ kind: "seen" }, { kind: "stale" }, { kind: "ambiguous" }, { kind: "none" }] as never),
    { seen: 1, stale: 1, ambiguous: 1, total: 4 });
});

/**
 * #24m — ОДИН ВИРАЗ, ОДНА СТЕЛЯ ПОХОДІВ.
 *
 * 🔴 `#158` стереже `/receivables` на ЧОТИРИ запити, і підняти стелю «щоб
 * пройшло» заборонено її ж текстом. Я цей регрес уже зробив у проході
 * обʼєднання — тому платежі їдуть ПІДЗАПИТОМ у наявному поході.
 */
test("#24m платежі не коштують зайвого походу, і текст запиту ОДИН", () => {
  const src = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  const from = src.indexOf('dashboardRouter.get("/receivables"');
  assert.ok(from > 0, "🔴 роут списку не знайдено — гейт міряє порожнечу");
  const body = src.slice(from, src.indexOf("dashboardRouter.", from + 40));

  /**
   * 🔴 МЕЖА ЗРІЗУ — СЕМАНТИЧНА, І ЦЕ НЕ ПЕДАНТИЗМ: перша редакція шукала
   * `invoicePaymentsSql` у 900 символах після `MAX(r.synced_at)`, і саботаж
   * «винести платежі окремим запитом» лишив гейт ЗЕЛЕНИМ — виклик просто стояв
   * пʼятьма рядками нижче, усе ще в межах вікна. Тепер вимагаємо, щоб виклик
   * був УСЕРЕДИНІ того самого запиту: між `MAX(r.synced_at)` і його `FROM`.
   */
  const qFrom = body.indexOf("MAX(r.synced_at)");
  assert.ok(qFrom > 0, "🔴 запиту про synced_at більше немає — гейт міряє порожнечу");
  const qTo = body.indexOf("FROM receivables r", qFrom);
  assert.ok(qTo > qFrom, "🔴 не знайдено кінця запиту про synced_at");
  assert.ok(body.slice(qFrom, qTo).includes("invoicePaymentsSql(1)"),
    "🔴 платежі поїхали ОКРЕМИМ запитом — це пʼятий похід проти стелі #158, "
    + "і саме такий регрес уже червонів на проді 27.08.2026");
  // І ЖОДНОГО другого походу по платежах у цьому роуті.
  assert.equal((body.match(/invoicePaymentsSql\(/g) ?? []).length, 1,
    "🔴 у списку зʼявився ДРУГИЙ виклик по платежах — стеля #158 порахує його окремо");

  // 🔴 ТЕКСТ ЗАПИТУ — ОДНА ФУНКЦІЯ НА ОБИДВА МІСЦЯ. Копія розійшлася б у тому,
  // ЯКІ платежі ми взагалі дивимось, і кожна половина лишилась би правдоподібною.
  assert.equal(invoicePaymentsSql(1).replace(/\$1/g, "$X"), invoicePaymentsSql(7).replace(/\$7/g, "$X"),
    "🔴 текст запиту залежить не лише від номера параметра");
  // 🔴 МЕЖА ЗРІЗУ — СЕМАНТИЧНА (наступний роут), а не «стільки-то символів»:
  // зріз за довжиною червонів би від дописаного коментаря, а не від поломки.
  const invFrom = src.indexOf('dashboardRouter.get("/receivables/invoices"');
  assert.ok(invFrom > 0, "🔴 роут розкриття не знайдено");
  const invRoute = src.slice(invFrom, src.indexOf("dashboardRouter.", invFrom + 40));
  assert.match(invRoute, /paymentMatch\.invoicePaymentsSql\(1\)/,
    "🔴 розкриття/реєстр читає платежі власним SQL, а не спільним виразом");

  // Рішення — в ЯДРІ, а не в SQL: правило в тексті запиту неможливо просаботувати.
  assert.doesNotMatch(invoicePaymentsSql(1), /CASE|рахун|invoice_no/i,
    "🔴 у SQL платежів зʼявилось бізнес-правило — його вже не перевірити без БД");
  assert.match(invoicePaymentsSql(1), /direction = 'in'/);
  assert.match(invoicePaymentsSql(1), /NOT t\.is_bank_fee/,
    "🔴 комісії потрапили у вхідні — це наш платіж банку, а не гроші клієнта");
});

/**
 * #24n — ЗІСТАВЛЕННЯ ПАКЕТОМ: `matchAll` дає ті самі відповіді, що поштучний
 * виклик, і `ambiguous` видно ЛИШЕ пакетом.
 */
test("#24n matchAll == поштучно, і кілька рахунків видно лише пакетом", () => {
  const a = inv("7001"), b = inv("7002");
  const p = pay({ purpose: "зг. рах. № 7001, № 7002" });
  const all = matchAll([a, b], [p], "2026-08-28");
  assert.equal(all.get("7001")!.kind, "ambiguous");
  assert.equal(all.get("7002")!.kind, "ambiguous");
  // 🔴 А ПООДИНЦІ — той самий платіж однозначний, і саме тому зіставляти по
  // одному рахунку НЕ МОЖНА: стан `ambiguous` це питання про ПЛАТІЖ.
  assert.equal(matchPayment(a, [p], openMap(a), "2026-08-28").kind, "seen",
    "🔴 фікстура не показує різниці — гейт нічого не доводить");
  // Ключі мапи — сирі номери рахунків, як їх бачить екран.
  assert.deepEqual([...matchAll([inv("000007003")], [], "2026-08-28").keys()], ["000007003"]);
});
