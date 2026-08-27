import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsApi, needsDb } from "../testMode.js";

const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const SRC = (p: string) => srcOf(`../${p}`);
const FE = (p: string) => srcOf(`../../../frontend/src/${p}`);
/**
 * Специфікатор для РАНТАЙМ-імпорту файла фронта. Node вміє зняти типи з `.ts`
 * на льоту, але статичний `import "…/frontend/…"` не пройшов би збірку бекенду,
 * тож шлях будується змінною — тоді `tsc` його не резолвить, а рантайм резолвить.
 * Потрібно там, де гейт звіряє ЗНАЧЕННЯ фронта, а не текст файла.
 */
const FE_SPEC = (p: string) => srcOf(`../../../frontend/src/${p}`);

const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("#197 плитки без кольорових смуг, і жодна не порожня", () => {
  // 🔴 ДВІ ПРАВКИ, ЯКІ ТРИМАЮТЬСЯ РАЗОМ (Е4b, макет власника).
  //
  // (а) Смуги зверху прибрано з УСІХ пʼяти. Пʼять різних кольорів у ряд читались
  //     як світлофор — ніби плитки різного «стану». Вони просто різні метрики.
  // (б) «Загальний борг» і «Прострочено» більше не порожні: вони несуть той
  //     самий розклад, що й три сусідні. Дві білі плями на початку екрана
  //     читались як «тут нема чого показати».
  const tiles = readFileSync(FE("pages/dashboard/sections/ReceivablesTiles.tsx"), "utf8");
  assert.ok(!/borderTop:\s*[`"]3px solid/.test(strip(tiles)),
    "🔴 кольорова смуга повернулась — пʼять кольорів у ряд читаються як світлофор");

  // Розклад є в ОБОХ колишніх порожніх плитках: кожна має свій `Bar` і `Legend`.
  // ⚠️ РІЖЕМО ПО ОЧИЩЕНОМУ ДЖЕРЕЛУ, а не по сирому. Межа плитки шукається за
  // словом «Прострочено», а воно трапляється й у КОМЕНТАРЯХ («урок „Прострочено
  // (понад ліміт)“»): перший же такий коментар у сусідній плитці обрізав зріз
  // раніше за `<Bar/>`, і гейт червонів на власній крихкості, а не на дефекті.
  // Той самий урок, що з пошуком `<th>` за відступом у символах нижче.
  const body = strip(tiles);
  const total = body.slice(body.indexOf("Загальний борг"), body.indexOf("Прострочено"));
  assert.match(total, /<Bar/, "🔴 «Загальний борг» знову без розкладу");
  assert.match(total, /<Legend/, "🔴 «Загальний борг» має смужку без підписів — колір без пояснення");
  const over = body.slice(body.indexOf("Прострочено"), body.indexOf("Перевізник оплачений"));
  assert.match(over, /<Bar/, "🔴 «Прострочено» знову без розкладу");
  assert.match(over, /понад узгоджений ліміт/, "🔴 зникла перша половина розкладу");
  assert.match(over, /ліміт не узгоджено/, "🔴 зникла друга половина розкладу");
});

test("#198 розкриття — окремий блок із прокруткою, а не вивал у сторінку", () => {
  // Без `max-height` сорок рядків ПВК АРСЕНАЛ вивалювались у сторінку й гнали
  // решту 73 клієнтів униз: щоб подивитись наступного, доводилось згорнути
  // попереднього. Прокрутка всередині лишає список на місці.
  // 🔴 ІНВАРІАНТ ЗМІНИВСЯ РІШЕННЯМ ВЛАСНИКА 26.08.2026, І ГЕЙТ ПЕРЕПИСАНО, А НЕ ЗНЯТО.
  // Було: вкладений блок `.recv-detail` зі своєю прокруткою — щоб сорок рядків
  // не гнали список униз. Стало: рахунки — рядки ТІЄЇ САМОЇ таблиці, бо вкладена
  // мала власні колонки й збігалася з батьківською лише «на око» (саме тому на
  // проді заробіток стояв перед сумою). Прокрутка більше не потрібна: рядки
  // всередині спільної таблиці нікуди не «вивалюються».
  // Що лишилось ЧИННИМ і стережеться далі: у розкриття є ШАПКА з підсумком —
  // без неї людина бачить перші пʼять рядків і не знає, скільки їх усього.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.ok(!/className="recv-detail"/.test(sec),
    "🔴 вкладений блок розкриття повернувся — його колонки знову збігатимуться з таблицею лише на око");
  assert.match(sec, /Рахунки клієнта/, "🔴 у розкритті немає шапки");
  assert.match(sec, /найстаріший/, "🔴 у шапці немає віку найстарішого рахунку");
  // ⚠️ ЯКІР ПЕРЕЇХАВ РАЗОМ ІЗ ЧИСЛІВНИКОМ (26.08.2026), АЛЕ НЕ ПОСЛАБ: він і
  // далі привʼязаний до `inv.length`, тож і зниклий рядок, і зашите число
  // червонять однаково. Було `Разом по {inv.length} рах.` — стало
  // `Разом по {nPlural(inv.length, …)}`, бо «1 рахунках» читалось як помилка.
  assert.match(sec, /Разом по \{nPlural\(inv\.length,/, "🔴 зник підсумковий рядок групи");
});

test("#199 два рівні полів названі ПО-РІЗНОМУ, бо означають різне", () => {
  // 🔴 БІЗНЕС-СЕНС, не косметика. Угорі — домовленість із КЛІЄНТОМ загалом;
  // у розкритті — строк по КОНКРЕТНОМУ рахунку, від якого створюється задача
  // менеджеру. Поки обидві пари звались однаково («дата оплати» / «коментар»),
  // людина не бачила, що дії різні. Той самий клас, що два «очікуємо» під одним
  // підписом і «сер.чек» від двох знаменників.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  // ⚠️ ПІДПИСИ ЗМІНИЛИСЬ ЗА МАКЕТОМ v5 (26.08.2026): «Обіцяна дата» злита з
  // «Домовленістю» — це була одна думка на два стовпці. РІВНІВ І ДОСІ ДВА, і
  // саме це гейт і стереже: домовленість із КЛІЄНТОМ загалом проти строку по
  // КОНКРЕТНОМУ рахунку, від якого створюється задача менеджеру.
  assert.match(sec, /Домовленість\s*$/m, "🔴 зник верхній рівень — домовленість із клієнтом");
  assert.match(sec, /Дедлайн оплати рахунка/, "🔴 у розкритті зник строк по КОНКРЕТНОМУ рахунку");
  assert.match(sec, /домовленість <b>з клієнтом<\/b> загалом|з клієнтом загалом|Дата й суть домовленості з клієнтом/,
    "🔴 верхній рівень більше не підписаний як домовленість із клієнтом");
  // Дзеркало: рівні мусять ВІДРІЗНЯТИСЬ підписом, а не просто існувати.
  assert.ok(!/>Дата оплати \(клієнт\)</.test(sec), "🔴 лишився старий однаковий підпис");
});

test("#197b у розкритті — НАША юрособа по кожному рахунку, і «невідомо» з причиною", () => {
  // Плитка обіцяє «ЮТС 26 · Автомув 3 · невідомо 11», а всередині клієнта
  // складу цього не було видно: підсумок є, з чого він — ні.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.match(sec, /Наша юрособа/, "🔴 колонки нашої юрособи в розкритті немає");
  assert.match(sec, /ENTITY_REASON_LABEL\[x\.ourEntityReason\]/,
    "🔴 «невідомо» без причини — порожнє місце читається як «нічого немає»");

  // 🔴 І ДЖЕРЕЛО — ТЕ САМЕ ЯДРО, ЩО В ПЛИТЦІ. Друге виведення юрособи з
  // `payment_type` одного дня розійшлося б із плиткою, і кожна половина
  // виглядала б правдоподібно — рівно так розійшлись чипи «новий/постійний».
  const route = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  const inv = route.slice(route.indexOf('"/receivables/invoices"'), route.indexOf('"/receivables/invoices"') + 4000);
  assert.match(inv, /loadInvoiceFacts/, "🔴 розкриття виводить юрособу власним кодом, а не ядром");
  assert.ok(!/payment_type/.test(strip(inv)),
    "🔴 у роуті розкриття зʼявився власний розбір payment_type — це друге джерело");
});

test("#198b лінк на угоду ЛИШЕ там, де угода є", () => {
  // Мертва іконка 🔗 у сорока рядках поспіль обіцяє перехід, якого не буде.
  // 1С-рахунок угоди не має В ПРИНЦИПІ — це не «загубили лінк», і підпис має
  // казати саме це.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.match(sec, /x\.serviceUrl && x\.dealFound/,
    "🔴 лінк малюється лише за наявністю URL — а він є і в 1С-рахунків, де угоди немає");
  assert.match(sec, /угоди немає/, "🔴 немає чесного підпису для рахунків без угоди");
  assert.match(sec, /лінк битий/, "🔴 немає окремого підпису для випадку «лінк є, угоди в базі немає»");
  // Дзеркало: підписи РІЗНІ — «угоди не існує» і «угода загубилась» це різні речі.
  const i = sec.indexOf("угоди немає");
  const j = sec.indexOf("лінк битий");
  assert.ok(i > 0 && j > 0 && i !== j, "🔴 два різні випадки описані одним підписом");
});

test("#199b ряд фільтрів переноситься, а не вилазить за екран", () => {
  // Успадковано з Е6-полірування: `display:flex` без переносу тисне елементи в
  // один рядок будь-якої ширини, і на вузькому екрані останній фільтр опинявся
  // за межею видимої області — ані видно, ані натиснути.
  const css = readFileSync(FE("index.css"), "utf8");
  const block = css.slice(css.indexOf(".page-filters"), css.indexOf(".page-filters") + 400);
  assert.match(block, /flex-wrap:\s*wrap/, "🔴 фільтри знову в один нерозривний ряд");
});

test("#199e FK-помилка називає ТУ колонку, що впала", async () => {
  // 🔴 ГЕЙТ ПЕРЕВІРЯЄ ПОВЕДІНКУ, А НЕ ТЕКСТ РОУТУ.
  //
  // Перша редакція шукала в джерелі слова `manager_id` і `set_by` — і саботаж
  // «звинувачувати менеджера завжди» НЕ спіймала: обидва слова лишились у коді,
  // змінилась лише умова. Це рівно той клас, що `#163` із неунікальним якорем:
  // гейт дивився на присутність рядка, а не на те, що код РОБИТЬ.
  const { fkErrorMessage } = await import("./creditLimits.js");
  assert.equal(fkErrorMessage('insert violates foreign key constraint "..._manager_id_fkey"'),
    "Такого менеджера немає");
  assert.equal(fkErrorMessage('insert violates foreign key constraint "..._set_by_fkey"'),
    "Автор дії не знайдений — перезайдіть у систему");
  // Невідомий FK — чесне «щось не так», а не вгадування.
  assert.equal(fkErrorMessage('violates foreign key constraint "..._client_key_fkey"'),
    "Посилання на неіснуючий запис");
  // 🪞 ДЗЕРКАЛО: не-FK помилка НЕ маскується під дружнє повідомлення. Інакше
  // будь-який збій БД показувався б користувачу як «немає менеджера».
  assert.equal(fkErrorMessage("duplicate key value violates unique constraint"), null);
  assert.equal(fkErrorMessage("connection terminated"), null);

  // І роут справді кличе ядро, а не має власну копію правила.
  const route = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  assert.match(route, /fkErrorMessage\(/, "🔴 роут більше не кличе спільне правило");
  assert.ok(!/\/manager_id\/\.test\(msg\)/.test(route),
    "🔴 у роуті зʼявилась друга копія розбору FK");
});

/**
 * 🔎 #204 НЕ НАПИСАНИЙ — І ЦЕ ЗАМІР, А НЕ ЛІНОЩІ.
 *
 * Постановник запропонував звірити наше виведення юрособи з полем Kommo
 * `2097485` «На яку компанію надходять кошти» — незалежним джерелом, яке в
 * нашому виведенні не бере участі. Замір Допоміжного: збіг 306 · розбіжність 3
 * (62608907, 62540681, 62576159) · нічого звіряти 323. Ідея правильна.
 *
 * 🔴 АЛЕ ЗРОБИТИ З НЕЇ ГЕЙТ ЗАРАЗ НЕМОЖЛИВО: сирих custom-полів Kommo ми НЕ
 * ЗБЕРІГАЄМО. Перевірено на живій базі — у `deals` 34 колонки і ЖОДНОЇ json;
 * `payment_type` приїжджає вже розібраним, а `2097485` не синкається взагалі.
 * Допоміжний брав його ПРЯМО з Kommo API, а не з нашої БД.
 *
 * Перша редакція цього гейта читала `deals.custom_fields_json -> '2097485'` —
 * тобто колонку, якої не існує. Він упав би на проді помилкою SQL, а виглядав
 * би як «розбіжність юрособи»: рівно та підміна, що `deals.id` замість
 * `deals.kommo_id` двома тижнями раніше. Спіймано заміром ДО викату.
 *
 * Щоб гейт став можливим, потрібні колонка + синк поля + бекфіл — це окрема
 * задача, а не рядок у цьому файлі. Записано в чергу.
 */

test("#197c «угоди немає» читається як «не знаємо», а не як «перевізник не оплачений»", async () => {
  // 🔴 ОБОВʼЯЗКОВИЙ ГЕЙТ ЗІ ЗВУЖЕНОГО ТЗ, і він перевіряє ПОВЕДІНКУ.
  //
  // Ядро цю межу вже тримає (`#152`: `classifyCarrierPaid` віддає `na/one_c`).
  // Але між ядром і оком користувача лежить клітинка, і саме там підміна
  // безкоштовна: один `||` у верстці — і 1С-рахунок малюється як «ще не
  // оплачено». Заміряно на живому проді 25.08.2026: таких рахунків **15 на
  // 1 604 500 ₴** (плюс 1 битий лінк і 1 поза мапою — разом 17 / 1 618 200 ₴).
  //
  // ⚠️ Гейт імпортує ФРОНТОВИЙ модуль напряму (node роздягає типи), а не читає
  // його як текст. Урок `#203`: перевірка на присутність рядка зеленіє, поки
  // рядок на місці, — навіть якщо умова над ним перевернута.
  // ⚠️ Специфікатор У ЗМІННІЙ — навмисно, той самий прийом, що для playwright у
  // `#193`: `tsc` бекенду не має права тягнути файл поза своїм `rootDir`, а
  // рантайм node роздягає типи й імпортує його без збірки.
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    carrierCell: (s: string | null, r: string | null) => { text: string; why: string | null; tone: string };
  };

  // Рахунок без угоди — «н/д» З ПРИЧИНОЮ, і в тексті НЕМАЄ слова про неоплату.
  const oneC = V.carrierCell("na", "one_c");
  assert.equal(oneC.text, "н/д");
  assert.equal(oneC.tone, "unknown");
  assert.equal(oneC.why, "виставлено через 1С");
  assert.ok(!/не оплач/i.test(oneC.text + " " + (oneC.why ?? "")),
    "🔴 відсутність угоди подана як факт неоплати — це 1.6 млн вигаданого боргу перевізнику");

  // Дві інші причини «не знаємо» теж названі, і РІЗНИМИ словами: битий лінк і
  // 1С — різні дії (полагодити лінк / нічого не робити).
  assert.equal(V.carrierCell("na", "broken_link").why, "лінк не веде на угоду");
  assert.equal(V.carrierCell("na", "out_of_map").why, "воронка поза мапою етапів");
  assert.notEqual(V.carrierCell("na", "broken_link").why, V.carrierCell("na", "one_c").why);

  // `null` (рахунок не зіставився з фактом) — теж «не знаємо», а не «ні».
  assert.equal(V.carrierCell(null, null).tone, "unknown");
  assert.equal(V.carrierCell(null, null).why, null, "🔴 причина вигадана там, де її немає");

  // 🪞 ДЗЕРКАЛО: два ВИЗНАЧЕНІ стани не з'їхали в «н/д». Без цього правило
  // «завжди н/д» було б зеленим — і колонка стала б суцільним «не знаємо».
  assert.equal(V.carrierCell("paid", null).tone, "paid");
  assert.match(V.carrierCell("paid", null).text, /оплачений/);
  assert.equal(V.carrierCell("unpaid", null).tone, "unpaid");
  assert.equal(V.carrierCell("unpaid", null).text, "ще не оплачено");

  // І клітинка справді малюється ЦИМ правилом, а не власним ланцюжком `&&`.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.match(sec, /carrierCell\(x\.carrierPaid, x\.carrierReason/,
    "🔴 колонка перевізника виводиться у верстці власними умовами — це друге правило");
  assert.ok(!/x\.carrierPaid === "unpaid" &&/.test(sec),
    "🔴 у верстці знову зʼявилась копія правила");

  // 🔗 І роут це віддає — інакше колонка отримувала б `undefined` і мовчки
  // показувала «н/д» усім 290 рахункам, виглядаючи при цьому справною.
  const route = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  // ⚠️ МЕЖА ЗРІЗУ — ЗА ЗМІСТОМ, А НЕ ЗА ЛІЧИЛЬНИКОМ СИМВОЛІВ. Перша редакція
  // брала фіксовані 5000 символів від початку роуту, і перший же доданий
  // коментар виштовхнув `carrierPaid` за вікно: гейт почервонів на правці, яка
  // його предмета не чіпала. Тепер зріз іде до НАСТУПНОГО роуту.
  const invStart = route.indexOf('"/receivables/invoices"');
  const invEnd = route.indexOf("dashboardRouter.", invStart + 40);
  const inv = route.slice(invStart, invEnd > invStart ? invEnd : route.length);
  assert.match(inv, /carrierPaid: f\?\.carrierPaid/, "🔴 роут не віддає стан перевізника по рахунку");
  assert.match(inv, /carrierReason: f\?\.carrierReason/, "🔴 роут віддає стан без причини");
});

// ─────────────────────── ПРОХІД 1: ВИПЛАТА ПЕРЕВІЗНИКУ ───────────────────────

test("#197d сума виплати читається ЗА ТИПОМ, і складена — це СУМА ОБОХ", async () => {
  // 📐 Заміряно на живому Kommo 25.08.2026 по 279 угодах дебіторки:
  // тип заповнений у 195 · тип є, а суми немає — 0 · обидві суми одночасно — 4.
  // Останні чотири і є причина складати, а не вибирати «ту, що пасує типу».
  //
  // ⚠️ Правило живе в ЧИСТОМУ модулі саме щоб цей гейт біг без оточення:
  // `kommo/client.ts` тягне `config.js`, який кидає без `JWT_SECRET` на імпорті.
  const C = await import("./carrierPayment.js");

  assert.equal(C.carrierPaymentFrom({ type: "Готівка", cash: 5000, general: null }), 5000);
  assert.equal(C.carrierPaymentFrom({ type: "ТОВ", cash: null, general: 12000 }), 12000);
  // 🔴 СКЛАДЕНА ВИПЛАТА: обидві заповнені → сума обох, а не одна з них.
  assert.equal(C.carrierPaymentFrom({ type: "ТОВ", cash: 3000, general: 7000 }), 10000,
    "🔴 складена виплата порахована однією половиною — недорахунок саме там, де платили двома шляхами");

  // 🪞 ДЗЕРКАЛО: без типу — `null`, а не 0. «Не знаємо» ≠ «нуль»: таких угод 84
  // із 279, і намалювати їм 0 ₴ означало б стверджувати, що виплати не було.
  assert.equal(C.carrierPaymentFrom({ type: null, cash: 5000, general: 7000 }), null,
    "🔴 сума без типу видається за факт — 84 угоди дістали б вигадану виплату");
  assert.equal(C.carrierPaymentFrom({ type: "  ", cash: 5000, general: null }), null,
    "🔴 порожній рядок прийнято за тип — та сама пастка, що utm_source: \"\"");
  assert.equal(C.carrierPaymentFrom({ type: "ФОП", cash: null, general: null }), null);

  // 🔴 `2097503` «Сумма запиту» НЕ бере участі ЖОДНИМ БОКОМ: із 128 заповнених
  // вона збігається з «загальною» лише в 39, тобто це інша величина.
  assert.equal(Object.values(C.CARRIER_PAY_FIELDS).includes(C.FORBIDDEN_REQUEST_SUM_FIELD as never), false,
    "🔴 заборонене поле 2097503 потрапило в набір полів виплати");
  // І його id не згадується в модулі синку взагалі.
  const src = strip(readFileSync(SRC("kommo/client.ts"), "utf8"));
  assert.equal(src.includes(String(C.FORBIDDEN_REQUEST_SUM_FIELD)), false,
    "🔴 id 2097503 зʼявився в kommo/client.ts — синкати його ЗАБОРОНЕНО");
  // 🪞 ДЗЕРКАЛО: три ДОЗВОЛЕНІ id там бути МУСЯТЬ — інакше перевірка вище
  // зеленіла б і тоді, коли синк не читає полів узагалі.
  const wired = readFileSync(SRC("kommo/client.ts"), "utf8");
  assert.match(wired, /CARRIER_PAY_FIELDS/, "🔴 синк не підключений до полів виплати");
});

test("#197e стеля 250 кидає, а не обрізає мовчки", async () => {
  // 🔴 ЗНАЙДЕНО ЗАМІРОМ, А НЕ ЧИТАННЯМ (25.08.2026). Запит іде з `limit=250` і
  // БЕЗ пагінації: на 279 id Kommo віддав рівно 250, і виклик виглядав успішним.
  // Мій власний зонд на цьому попався — порахував частки по обрізаній вибірці.
  const C = await import("./carrierPayment.js");
  assert.equal(C.LEADS_BY_IDS_MAX, 250);
  assert.throws(() => C.assertLeadIdsWithinLimit(C.LEADS_BY_IDS_MAX + 1), /стеля|250/,
    "🔴 понад стелю проходить мовчки — недорахунок буде невидимий");
  // 🪞 ДЗЕРКАЛО: рівно стеля і менше — дозволено. Межа саме «понад», а не «від»;
  // інакше сторож ламав би кожен нормальний батч.
  assert.doesNotThrow(() => C.assertLeadIdsWithinLimit(C.LEADS_BY_IDS_MAX));
  assert.doesNotThrow(() => C.assertLeadIdsWithinLimit(0));

  // Сторож справді стоїть у запиті, а не лише існує.
  const client = strip(readFileSync(SRC("kommo/client.ts"), "utf8"));
  const fn = client.slice(client.indexOf("export async function fetchLeadsByIds"),
    client.indexOf("export async function fetchLeadsByIds") + 400);
  assert.match(fn, /assertLeadIdsWithinLimit/, "🔴 fetchLeadsByIds більше не питає стелю");

  // І жодна джоба не шле список без дроблення: інакше сторож перетворив би
  // тихе обрізання на падіння джоби — гірше, ніж було.
  for (const f of ["jobs/syncReceivables.ts", "jobs/syncCarriers.ts"]) {
    const src = strip(readFileSync(SRC(f), "utf8"));
    const call = src.slice(src.indexOf("fetchLeadsByIds("), src.indexOf("fetchLeadsByIds(") + 140);
    assert.match(call, /slice\(/, `🔴 ${f} шле список у fetchLeadsByIds без дроблення`);
  }
});

test("#197f «суму не вказано» — окремий стан, а не нуль і не «не оплачено»", async () => {
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    carrierCell: (s: string | null, r: string | null, a?: number | null)
      => { text: string; why: string | null; tone: string; amountText: string | null };
  };
  // Сума відома — показуємо число.
  assert.match(V.carrierCell("paid", null, 12400).amountText!, /12\s?400/);
  // 🔴 Сума НЕВІДОМА при відомому стані — окремий підпис, не «0 ₴».
  assert.equal(V.carrierCell("paid", null, null).amountText, "суму не вказано");
  assert.equal(V.carrierCell("unpaid", null, null).amountText, "суму не вказано");
  // …і стан при цьому НЕ зʼїжджає в «не оплачено».
  assert.equal(V.carrierCell("paid", null, null).tone, "paid",
    "🔴 невідома сума перевела оплаченого перевізника в «не оплачено»");
  // 🔴 При `na` суми немає ВЗАГАЛІ: не знаємо навіть, чи платили, — казати
  // «скільки» означає видавати здогад за факт.
  assert.equal(V.carrierCell("na", "one_c", 999).amountText, null);
  // 🪞 ДЗЕРКАЛО: нуль — це число, а не «не вказано». Інакше правило ховало б
  // справжні нулі під підписом «немає даних».
  assert.match(V.carrierCell("paid", null, 0).amountText!, /0/);
});

test("#197g фільтр «н/д, що лагодиться» бере ПРИЧИНУ, а не стан", async () => {
  // 📐 Заміряно 25.08.2026: із 21 «н/д» лагодяться рівно 2 (битий лінк + воронка
  // поза мапою), решта 19 — 1С, де угоди немає в принципі. Поки вони в одній
  // купі, ті два тонуть, і «н/д» читається як «нічого не вдіяти».
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as { passesFilters: (c: never, f: never) => boolean; EMPTY_FILTERS: never };
  const cli = (reasons: string[]) => ({
    facts: { carrierReasons: reasons, carrier: {}, entity: {}, aging: {} },
  } as never);
  const f = { ...(V.EMPTY_FILTERS as object), carrier: "na_fixable" } as never;

  assert.equal(V.passesFilters(cli(["broken_link"]), f), true, "🔴 битий лінк не потрапив у «що лагодиться»");
  assert.equal(V.passesFilters(cli(["out_of_map"]), f), true, "🔴 воронка поза мапою не потрапила");
  // 🔴 1С — НЕ лагодиться: угоди немає в принципі, і слати туди людину означає
  // посилати шукати те, чого не існує.
  assert.equal(V.passesFilters(cli(["one_c"]), f), false, "🔴 1С затесався у «що лагодиться» — 19 із 21 стануть шумом");
  assert.equal(V.passesFilters(cli([]), f), false);
  // 🪞 ДЗЕРКАЛО: без фільтра проходять усі — інакше предикат різав би список завжди.
  assert.equal(V.passesFilters(cli(["one_c"]), V.EMPTY_FILTERS), true);
});

test("#198c шапка розкриття липка — інакше прокрутка лишає колонки без назв", () => {
  // Побачено власним оком на знімку приймання 25.08.2026: прокрутив 41 рахунок
  // усередині блоку — числа є, підписів немає. Рівно та проблема, від якої
  // шапки й заводяться; жоден гейт її не бачив, бо всі дивились на дані.
  const css = readFileSync(FE("index.css"), "utf8");
  const i = css.indexOf(".recv-detail thead th");
  assert.ok(i > 0, "🔴 правила для шапки розкриття немає — при прокрутці вона поїде");
  const block = css.slice(i, i + 300);
  assert.match(block, /position:\s*sticky/, "🔴 шапка не липка");
  assert.match(block, /top:\s*0/, "🔴 sticky без `top` не діє взагалі");
  // 🔴 Фон обовʼязковий: без нього рядки просвічують крізь прозорий `th`, і
  // липка шапка виглядає гірше за її відсутність.
  assert.match(block, /background/, "🔴 липка шапка без фону — рядки просвічуватимуть");
});

test("#199c жоден розмір шрифту в дебіторці не поза набором --fs-*", () => {
  // 📐 ЗАМІРЯНО НА ЖИВОМУ ПРОДІ 25.08.2026, а не «схоже, що багато»:
  // у таблиці жили 6 різних розмірів — 12/lh18 ×685 · 15/lh22.5 ×494 ·
  // 11/lh16.5 ×144 · 11.5/lh17.3 ×72 · 12/lh16.8 ×33 · 10 і 10.5 поштучно.
  // Поза шкалою було ЧОТИРИ значення (10 · 10.5 · 11.5 · 12.5), а не три:
  // 12.5 знайшовся вже в джерелі, у DOM-підрахунку його не було видно.
  //
  // 🔴 ВИМАГАЄМО ТОКЕН, А НЕ «ЧИСЛО НА ШКАЛІ». Літерал `11` формально в наборі,
  // але саме літерал одного дня стає `11.5` — так ці чотири й зʼявились.
  // Токен такої правки не переживе: `var(--fs-11.5)` не існує.
  const FILES = [
    "pages/dashboard/sections/ReceivablesSection.tsx",
    "pages/dashboard/sections/ReceivablesTiles.tsx",
    "pages/dashboard/sections/ReceivablesFilters.tsx",
    "pages/dashboard/sections/ReceivablesBreakdownCard.tsx",
    "pages/dashboard/sections/LimitEditor.tsx",
    "pages/dashboard/sections/OwnerEditor.tsx",
    "pages/dashboard/sections/MergeDialog.tsx",
  ];
  // Набір беремо З CSS, а не переписуємо списком: зашитий перелік протух би
  // мовчки на першій же зміні токенів.
  const css = readFileSync(FE("index.css"), "utf8");
  const tokens = new Set([...css.matchAll(/--fs-([a-z0-9]+)\s*:/g)].map((m) => `--fs-${m[1]}`));
  assert.ok(tokens.size >= 5, `🔴 з index.css видобуто лише ${tokens.size} токенів — розбір зламався`);

  const bad: string[] = [];
  let seen = 0;
  for (const rel of FILES) {
    const src = strip(readFileSync(FE(rel), "utf8"));
    for (const m of src.matchAll(/fontSize:\s*([^,\n}]+)/g)) {
      seen++;
      const v = m[1].trim();
      if (v === "undefined" || v === "inherit") continue;
      const used = [...v.matchAll(/var\((--fs-[a-z0-9]+)\)/g)].map((x) => x[1]);
      // Кожен розмір у виразі (включно з обома гілками тернара) — токен зі списку.
      if (used.length === 0 || used.some((t) => !tokens.has(t))) {
        bad.push(`${rel.split("/").pop()}: ${v.slice(0, 60)}`);
      }
    }
  }
  // ⚠️ ПОРОЖНІЙ РЕЗУЛЬТАТ — ПРОВАЛ. Якби шлях до файлів зламався, `bad` теж був
  // би порожній, і гейт зеленів би, нічого не перевіривши.
  assert.ok(seen >= 60, `🔴 знайдено лише ${seen} оголошень fontSize — гейту не було що перевіряти`);
  assert.deepEqual(bad, [],
    "🔴 РОЗМІР ПОЗА ШКАЛОЮ. Проміжних 10/10.5/11.5/12.5 у системі немає — їх дописують\n"
    + "руками, і потім на одному екрані живе шість розмірів:\n  " + bad.join("\n  "));
});

test("#199d висоту рядка тримає ОДИН рядок, а не другий під контролом", () => {
  // 🔴 ЗАМІР ПЕРЕВЕРНУВ ДІАГНОЗ, і гейт стереже саме те, що дало ефект.
  // По 73 рядках живого прода: медіана 72px, і в 55 із них висоту задавала
  // колонка «Ліміт» («14 дн.» + «✏️ змінити» другим рядком = 40px вмісту),
  // ще в 11 — «Відповідальний». Симуляція: прибрати ці другі рядки → 48px
  // (−24% таблиці); прибрати перенос чипів → 72px, тобто НУЛЬ.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  // Кнопки «змінити» більше не блокові — інакше вони знову стануть другим рядком.
  for (const anchor of ["Змінити відповідального за борг", "Змінити узгоджену відстрочку"]) {
    const i = sec.indexOf(anchor);
    assert.ok(i > 0, `🔴 контрол «${anchor}» зник із рядка`);
    const btn = sec.slice(i, i + 420);
    assert.ok(!/display:\s*"block"/.test(btn),
      `🔴 «${anchor}» знову блоковий — це другий рядок, і він коштує 24% висоти таблиці`);
  }

  // 🔴 ПОСИЛЕНО 26.08.2026 ПІСЛЯ ВЛАСНОГО РЕГРЕСУ, І САМЕ ЦЕЙ АБЗАЦ — УРОК.
  // Гейт вище шукав ІНЛАЙНОВИЙ `display: "block"`. Прохід верстки переніс ті самі
  // кнопки в клас `.recv-ico` з `display: grid` — блоковість приїхала іншим
  // словом і з іншого файлу, тож гейт лишився ЗЕЛЕНИЙ, поки механізм був
  // зламаний. Заміряно в браузері: олівець опустився на 16px нижче імені,
  // клітинка 117 → 150 — правка, що мала прибирати висоту, її додавала.
  // Спіймало ОКО на знімку приймання.
  //
  // Тому перевіряємо ВЛАСТИВІСТЬ ЗА НАСЛІДКОМ, а не одне її значення: будь-яке
  // блокове `display` у класі іконкової кнопки — це другий рядок.
  // ⚠️ КОМЕНТАРІ ЗНІМАЄМО ПЕРЕД МАТЧЕМ — і це не педантизм. Перша редакція цього
  // гейта читала сире CSS і влучила у ВЛАСНИЙ пояснювальний коментар усередині
  // правила («display: grid робить кнопку блоковою»): гейт червонів на вже
  // виправленому коді. Той самий клас, що `idx_tasks_credit_limit_open`, який
  // матчився у власному коментарі автора.
  const css = readFileSync(FE("index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const ico = /\.recv-ico\s*\{([^}]*)\}/.exec(css);
  assert.ok(ico, "🔴 класу .recv-ico немає — кнопки в рядку не мають спільної геометрії");
  const disp = /display:\s*([a-z-]+)/.exec(ico![1]);
  assert.ok(disp, "🔴 у .recv-ico не задано display — браузер зробить кнопку inline-block без центрування");
  const BLOCK_LEVEL = ["block", "grid", "flex", "flow-root", "table"];
  assert.ok(!BLOCK_LEVEL.includes(disp![1]),
    `🔴 .recv-ico має display: ${disp![1]} — це БЛОКОВИЙ бокс, отже кнопка йде на власний рядок. `
    + `Заміряно на цьому ж значенні: +16px під іменем, клітинка 117 → 150. `
    + `Потрібен inline-* (inline-grid/inline-flex).`);
  // 🪞 ДЗЕРКАЛО: контроли не зникли зовсім. Інакше «немає другого рядка» було б
  // зелене й тоді, коли редагування прибрали разом із ним.
  //
  // 🔴 ПЕРША РЕДАКЦІЯ ЦЬОГО ДЗЕРКАЛА БУЛА БЕЗЗУБА: вона шукала `setLimitFor(`
  // будь-де у файлі, а той рядок є ще у `onClose`/`onDone`. Саботаж «вихолостити
  // кнопку» вона НЕ спіймала. Той самий клас, що `#163` із неунікальним якорем:
  // перевірялась присутність рядка, а не те, що код РОБИТЬ. Тепер дивимось у
  // САМУ кнопку — від її `<button` до її ж підпису.
  for (const [anchor, handler] of [
    ["Змінити відповідального за борг", "setOwnerFor"],
    ["Змінити узгоджену відстрочку", "setLimitFor"],
  ] as const) {
    const at = sec.indexOf(`title="${anchor}"`);
    assert.ok(at > 0, `🔴 контрол «${anchor}» зник`);
    const open = sec.lastIndexOf("<button", at);
    assert.ok(open > 0 && at - open < 200, `🔴 «${anchor}» більше не кнопка`);
    const btn = sec.slice(open, at);
    assert.match(btn, new RegExp(`onClick=\\{\\(\\) => ${handler}\\(`),
      `🔴 кнопка «${anchor}» не перемикає редактор — контрол став декорацією`);
  }

  // 🔴 ПРИЧИНА ВИСОТИ ЗМІНИЛАСЬ РІШЕННЯМ ВЛАСНИКА 26.08.2026 — і гейт разом із нею.
  // Було: чипи в «Юрособі» й «Перевізнику» мали `flex-wrap` і сипались у
  // стовпчик, бо колонкам бракувало ширини; лікувалось шириною.
  // Стало: розкладу в клітинці НЕМАЄ взагалі — найбільша складова одним рядком,
  // повний розклад у підказці (макет v5). Тобто джерело висоти усунуте, а не
  // компенсоване. Стережемо тепер саме це: багаторядкового блоку немає, а
  // колонки й далі мають ширину, щоб один рядок не переносився.
  const heads = sec.slice(sec.indexOf("<thead>"), sec.indexOf("</thead>"));
  for (const col of ["Юрособа", "Перевізник"]) {
    const at = heads.indexOf(col);
    assert.ok(at > 0, `🔴 колонки «${col}» немає в шапці`);
    const th = heads.slice(heads.lastIndexOf("<th", at), at);
    assert.match(th, /width:\s*1[0-9]{2}/,
      `🔴 колонці «${col}» знову бракує ширини — навіть один рядок почне переноситись`);
  }
  // 🪞 Дзеркало: розклад НЕ зник із продукту, він переїхав у підказку. Інакше
  // «немає багаторядкового блоку» було б зелене й тоді, коли склад просто
  // втратили — а це відповідь на «з чого це число».
  assert.match(sec, /foldEntity\(c\.facts\)/, "🔴 розклад юросіб зник, а не переїхав у підказку");
  assert.match(sec, /foldCarrier\(c\.facts\)/, "🔴 розклад перевізників зник, а не переїхав у підказку");
  assert.ok(!/entityBreakdown\(/.test(sec),
    "🔴 повернувся багаторядковий розклад у клітинці — він і роздував висоту рядка втричі");
});

/* ══════════════ 💰 МАРЖИНАЛЬНІСТЬ І 🗑 СПИСАННЯ (25.08.2026) ══════════════ */

test("#197h маржа рахується від «Приход 1», а НЕ від боргу", async () => {
  // 🔴 ЦЕ НЕ СМАК, І ЦИФРА ЦЕ ДОВОДИТЬ. Борг — це ЗАЛИШОК: він падає з кожною
  // оплатою, тож `заробили / борг` вибухає. Заміряно на живому проді 25.08.2026:
  // максимум 6 667% (клієнт заборгував 3 ₴ і «заробив» 200), плюс 110% і −10%.
  // Проти цього `заробили / Приход 1`: медіана 12.3%, максимум РІВНО 100.0%,
  // поза діапазоном один рядок — законне сторно.
  const { marginCell } = await import("./receivablesMargin.js");
  const { CLIENT_PAY_FIELD, CARRIER_OBLIGATION_FIELD } = await import("./carrierPayment.js");

  // 200 заробили при повній сумі 1000 → 20%. Якби знаменником був борг (3 ₴),
  // вийшло б 6 667% — саме те число, що ми на проді й побачили.
  assert.equal(marginCell(200, 1000).pct, 20);
  assert.notEqual(marginCell(200, 1000).pct, marginCell(200, 3).pct,
    "🔴 знаменник підмінили боргом — відношення до залишку вибухає");

  // Знаменник приходить із ПОЛЯ «Приход 1», а не з `receivable_invoices.amount`.
  assert.equal(CLIENT_PAY_FIELD, 2097627, "🔴 знаменник переїхав на інше поле CRM");
  assert.notEqual(CLIENT_PAY_FIELD, CARRIER_OBLIGATION_FIELD,
    "🔴 знаменником став обовʼязок перед перевізником — це витрата, не сума угоди");

  // І САМЕ ЦЕ ПОЛЕ ЇДЕ В ЗАПИТІ ЕКРАНА, а не сума боргу.
  const { __INVOICE_FACTS_SQL_FOR_TESTS: sql } = await import("./receivablesFacts.js");
  assert.match(sql, /d\.client_pay_amount/,
    "🔴 запит більше не тягне «Приход 1» — знаменника нема з чого взяти");
  assert.ok(!/ri\.amount\s+AS\s+(base|client_pay)/i.test(sql),
    "🔴 знаменником підставили суму боргу — рівно та підміна, від якої гейт стоїть");

  // 🪞 ДЗЕРКАЛО: синк справді пише це поле, інакше знаменник був би вічно NULL
  // і «—» стояло б у ВСІХ рядках — гейт вище лишався б зеленим на мертвій фічі.
  const sync = readFileSync(SRC("jobs/syncKommo.ts"), "utf8");
  assert.match(sync, /client_pay_amount/, "🔴 синк не пише «Приход 1» — маржі не буде в жодного клієнта");
});

test("#197i невідома маржа — це «—» з причиною, а НЕ нуль", async () => {
  // 🔴 НУЛЬ У ЧИСЕЛЬНИКУ Й НУЛЬ У ЗНАМЕННИКУ — РІЗНІ ТВЕРДЖЕННЯ.
  // «Заробили 0» означає «не заробили»; «знаменник 0» означає «не знаємо, з чого
  // рахувати». Заміряно 25.08.2026: 5 клієнтів із 76 не мають жодної звʼязаної
  // угоди, а угод із `price = 0` — дві. Тобто обидва випадки реальні.
  const { marginCell, MARGIN_UNKNOWN_LABEL } = await import("./receivablesMargin.js");

  assert.equal(marginCell(null, 1000).pct, null, "🔴 клієнт без угоди дістав відсоток нізвідки");
  assert.equal(marginCell(null, 1000).why, "no_deal");
  assert.equal(marginCell(500, null).pct, null, "🔴 без «Приход 1» рахувати нема з чого");
  assert.equal(marginCell(500, null).why, "no_base");

  // 🪞 ДЗЕРКАЛО: нуль у ЧИСЕЛЬНИКУ дає ЧЕСНІ 0.0%, а не «—». Інакше правило
  // з'їхало б у другий бік — «не заробили» читалось би як «не знаємо».
  assert.equal(marginCell(0, 1000).pct, 0, "🔴 «заробили нуль» перетворилось на «не знаємо»");
  assert.equal(marginCell(0, 1000).why, null);

  // Причина названа СЛОВАМИ. Порожнє місце читається як «нічого немає».
  for (const k of ["no_deal", "no_base"] as const) {
    assert.ok(MARGIN_UNKNOWN_LABEL[k].length > 5, `🔴 причина «${k}» не пояснює нічого`);
  }

  // І екран показує саме «—», а не 0: фронт друкує `null` як прочерк.
  // Специфікатор У ЗМІННІЙ — той самий прийом, що вище: `tsc` бекенду не має
  // права тягнути файл поза своїм `rootDir`, а рантайм node роздягає типи.
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    marginPctText: (m: { pct: number | null } | null) => string;
  };
  assert.equal(V.marginPctText({ earned: null, base: 1000, pct: null, why: "no_deal" } as never), "—");
  assert.equal(V.marginPctText(null), "—", "🔴 клієнт без рахунків дістав число замість прочерку");
  assert.equal(V.marginPctText({ earned: 0, base: 1000, pct: 0, why: null } as never), "0.0%",
    "🔴 чесний нуль сховали за прочерком");
});

test("#197j нульовий знаменник не дає ні Infinity, ні NaN, ні «0%»", async () => {
  // 🔴 ДІЛЕННЯ НА НУЛЬ ТУТ НЕ ПАДАЄ ГОЛОСНО — воно дає `Infinity`/`NaN`, і на
  // екрані зʼявляється «∞» або порожнеча без жодного пояснення. Тому нуль і
  // `null` у знаменнику — ОДИН стан «рахувати нема з чого», названий словами.
  const { marginCell } = await import("./receivablesMargin.js");
  for (const base of [0, null]) {
    const c = marginCell(500, base as number | null);
    assert.equal(c.pct, null, `🔴 знаменник ${base} дав число`);
    assert.equal(c.why, "no_base", `🔴 знаменник ${base} лишився без пояснення`);
  }
  // Дзеркало до самої арифметики: якби перевірку на нуль прибрали, вийшло б
  // саме це — і воно НЕ дорівнює тому, що ми віддаємо.
  assert.equal(500 / 0, Infinity);
  assert.notEqual(marginCell(500, 0).pct, Infinity, "🔴 нуль пройшов у ділення");
  assert.equal(marginCell(0, 0).pct, null, "🔴 0/0 дало NaN замість чесного «не знаємо»");
});

test("#199f підпис колонки НАЗИВАЄ знаменник і не прикидається звітом про прибутки", () => {
  // 🔴 ПІДПИС «маржинальність, %» БЕЗ ЗНАМЕННИКА ЧИТАВСЯ Б ЯК «% від боргу» —
  // той самий клас, що «Прострочено (понад ліміт)» і «сер.чек ÷ авто»: підпис
  // технічно правдивий, величина за ним інша.
  //
  // 🔴 І СЛОВО «PnL» ЗАБОРОНЕНЕ ОКРЕМО. Це не звіт про прибутки: у знаменнику
  // одне поле CRM, у чисельнику друге, витрат компанії тут немає взагалі.
  // Назвати це «PnL» означало б пообіцяти те, чого екран не рахує.
  const sec = readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8");
  const tiles = readFileSync(FE("pages/dashboard/sections/ReceivablesTiles.tsx"), "utf8");
  const view = readFileSync(FE("pages/dashboard/receivablesView.ts"), "utf8");

  for (const [what, src] of [["рядок клієнта", sec], ["плитка", tiles]] as const) {
    assert.match(strip(src), /від суми рахунків/,
      `🔴 ${what}: знаменник більше не названий — «маржинальність, %» прочитають як «% від боргу»`);
  }
  for (const [what, src] of [["рядок клієнта", sec], ["плитка", tiles], ["правила", view]] as const) {
    assert.ok(!/PnL|P&L|прибуток компанії/i.test(strip(src)),
      `🔴 ${what}: зʼявилось «PnL» — екран обіцяє звіт про прибутки, якого не рахує`);
  }
  // Ядро несе той самий підпис, тож розійтись фронту з ним нема як.
  const core = readFileSync(SRC("core/receivablesMargin.ts"), "utf8");
  assert.match(core, /% від суми рахунків/, "🔴 у ядрі підпис уже без знаменника");
});

test("#198d ключ списання — сирий ключ клієнта + номер рахунку, а не канонічний", () => {
  // 🔴 КАНОНІЧНИЙ КЛЮЧ РУХАЄ СКЛЕЙКА (`client_key_alias`). Списали клієнта,
  // потім злили його з іншим — і списання «переїхало» б на обʼєднаного,
  // прибравши ЧУЖИЙ борг. Сирий ключ склейка не рухає.
  const schema = readFileSync(SRC("db/schema.sql"), "utf8");
  const tbl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS receivable_writeoffs"),
                           schema.indexOf("CREATE TABLE IF NOT EXISTS receivable_writeoffs") + 1400);
  assert.ok(tbl.length > 100, "🔴 таблиці списань у схемі немає");
  assert.match(tbl, /PRIMARY KEY \(client_key_raw, invoice_no\)/,
    "🔴 ключ списання змінився — або він канонічний (переїде при склейці), або не поіменний");

  // І JOIN на екрані бере ТОЙ САМИЙ сирий ключ, а не канонічний: інакше запис
  // лежав би правильно, а екран читав би його не тим ключем.
  const facts = readFileSync(SRC("core/receivablesFacts.ts"), "utf8");
  assert.match(facts, /wo\.client_key_raw = ri\.client_key_raw/,
    "🔴 списання приєднується канонічним ключем — після склейки воно накриє чужий борг");
  assert.match(facts, /wo\.revoked_at IS NULL/,
    "🔴 join не фільтрує скасовані — повернений борг лишиться списаним назавжди");
});

test("#198e списання переживає TRUNCATE синку — воно в ОКРЕМІЙ таблиці", () => {
  // 🔴 `syncReceivables` робить TRUNCATE обох таблиць дебіторки КОЖНІ 15 ХВИЛИН.
  // Прапорець `written_off` у `receivable_invoices` зник би за один прохід —
  // гарантовано, не «можливо». Прецедент у проєкті вже є: `receivable_invoice_notes`
  // заведено рівно з цієї причини.
  const sync = readFileSync(SRC("jobs/syncReceivables.ts"), "utf8");
  const truncated = [...sync.matchAll(/TRUNCATE\s+(?:TABLE\s+)?([a-z_,\s]+)/gi)]
    .flatMap((m) => m[1].split(",").map((x) => x.trim()));
  assert.ok(truncated.length > 0, "🔴 у синку немає жодного TRUNCATE — вимір не має що перевіряти");
  assert.ok(!truncated.includes("receivable_writeoffs"),
    "🔴 синк тепер зносить списання — вони проживуть максимум 15 хвилин");
  // 🪞 ДЗЕРКАЛО: TRUNCATE справді зачіпає ті таблиці, ЧЕРЕЗ ЯКІ гейт і існує.
  // Інакше він зеленів би на синку, що взагалі нічого не чистить.
  assert.ok(truncated.includes("receivable_invoices"),
    "🔴 синк більше не чистить рахунки — привід для окремої таблиці зник, перевір заново");

  // І сама колонка `written_off` НЕ живе в таблиці, що зноситься.
  const schema = readFileSync(SRC("db/schema.sql"), "utf8");
  const invTbl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS receivable_invoices"),
                              schema.indexOf("CREATE TABLE IF NOT EXISTS receivable_invoices") + 700);
  assert.ok(!/written_off/.test(invTbl),
    "🔴 списання переїхало в `receivable_invoices` — його зітре найближчий синк");
});

test("#199g право write_off_debt має РІВНО дві ролі, і адміна серед них немає", needsDb(), async (t) => {
  // 🔴 РІШЕННЯ ВЛАСНИКА 25.08.2026: СЕО й опердир. Не фінансист (хоч він має
  // `admin_scope` з 31.07), не КВП, не тімліди — і НЕ АДМІН. Списання зменшує
  // суму на плитці, тобто це визнання втрати грошей, а не операційна дія.
  //
  // Склад перевіряється на схемі З НУЛЯ і ДВІЧІ: `#186` уже показав, що грант,
  // який стоїть вище за блок зняття, гаситься тим самим прогоном і «Migration
  // applied.» друкується при незастосованій зміні.
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    const schema = readFileSync(SRC("db/schema.sql"), "utf8");
    await c.query(schema);
    const have = async () => (await c.query<{ key: string }>(
      `SELECT key FROM roles WHERE (permissions->>'write_off_debt')::boolean ORDER BY key`)
    ).rows.map((r) => r.key);
    assert.deepEqual(await have(), ["ceo", "opdir"], "🔴 право дісталось не тим ролям");
    // 🪞 ДЗЕРКАЛО ДО ГОЛОВНОЇ ПАСТКИ: `permissions` адміна копіюють у нові ролі,
    // тож право могло б розтектись мовчки. Називаємо це окремо.
    assert.ok(!(await have()).includes("admin"),
      "🔴 адмін дістав право списувати — рішення власника назвало РІВНО дві ролі");
    assert.ok(!(await have()).includes("financier"),
      "🔴 фінансист дістав право через `admin_scope` — списання це не фінансова операція, "
      + "а визнання втрати грошей");
    await c.query(schema);
    assert.deepEqual(await have(), ["ceo", "opdir"], "🔴 другий прогін міграції змінив склад права");
    // 📐 ЗНАХІДКА САБОТАЖУ 25.08.2026, записана тут, бо вона неочевидна:
    // дописати `admin` В ОДИН ЛИШЕ ГРАНТ — і гейт лишається ЗЕЛЕНИМ. Це не
    // діра: блок зняття нижче (`NOT IN ('ceo','opdir')`) забирає право назад
    // тим самим прогоном. Тобто помилка «розширив грант і забув про зняття»
    // наслідків не має в принципі — рівно та властивість, через яку `#186`
    // колись показав протилежне (грант СТОЯВ вище за зняття й гасився).
    // Почервоніти гейт змушує лише свідоме розширення В ОБОХ операторах — і
    // саме воно й є тим, що ми стережемо.
  } finally { await c.end(); scratch.dispose(); }
});

test("#198f списання без причини не приймає БД, і воно оборотне з журналом", needsDb(), async (t) => {
  // 🔴 ТРИ ВИМОГИ ВЛАСНИКА В ОДНОМУ ГЕЙТІ, бо вони й тримаються разом:
  //   ІЗ ПРИЧИНОЮ — `CHECK`, а не валідація роуту: роут обходить будь-який скрипт;
  //   ОБОРОТНЕ   — скасування ТИМ САМИМ інтерфейсом (правило власника 06.08.2026:
  //                незворотна кнопка — пастка, навіть коли працює правильно);
  //   ІЗ ЖУРНАЛОМ — рядок НЕ видаляється, обидві дії лишаються поіменними.
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SRC("db/schema.sql"), "utf8"));
    // ТЕСТ НА ВІДХИЛЕННЯ, а не «очима»: `CHECK` виглядає бездоганно й тоді, коли
    // не стереже нічого — на цьому ми вже спіймались із NULL у `IN`.
    await assert.rejects(
      () => c.query(`INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note)
                     VALUES ('т', '1', 100, '   ')`),
      /check|порушує/i, "🔴 БД прийняла списання з порожньою приміткою");
    await assert.rejects(
      () => c.query(`INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount)
                     VALUES ('т', '1', 100)`),
      /null|not-null|порушує/i, "🔴 БД прийняла списання БЕЗ примітки взагалі");

    // 🪞 ДЗЕРКАЛО: правильний рядок ПРОХОДИТЬ — інакше `CHECK` міг би різати все
    // підряд, а гейт читався б як надійність.
    await c.query(`INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note)
                   VALUES ('т', '1', 100, 'банкрут, виконавче провадження закрито')`);

    // ОБОРОТНІСТЬ: скасування лишає рядок і додає ДРУГИЙ слід, а не стирає перший.
    await c.query(`UPDATE receivable_writeoffs SET revoked_at = now(), revoke_note = 'помилились клієнтом'
                    WHERE client_key_raw = 'т' AND invoice_no = '1'`);
    const j = await c.query<{ note: string; revoke_note: string | null; written_off_at: string }>(
      `SELECT note, revoke_note, written_off_at FROM receivable_writeoffs WHERE client_key_raw = 'т'`);
    assert.equal(j.rowCount, 1, "🔴 скасування ВИДАЛИЛО рядок — журнал двох дій зник");
    assert.match(j.rows[0].note, /банкрут/, "🔴 причина списання стерлась при скасуванні");
    assert.match(j.rows[0].revoke_note ?? "", /помилились/, "🔴 причини скасування в журналі немає");

    // І роут справді ПОЗНАЧАЄ, а не видаляє: інакше схема дозволяла б журнал,
    // а код усе одно стирав би слід.
    const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
    const del = routes.slice(routes.indexOf(`dashboardRouter.delete("/receivables/writeoff"`),
                             routes.indexOf(`dashboardRouter.delete("/receivables/writeoff"`) + 1600);
    assert.ok(del.length > 100, "🔴 роут скасування зник");
    assert.match(del, /UPDATE receivable_writeoffs/, "🔴 скасування більше не UPDATE");
    assert.ok(!/DELETE FROM receivable_writeoffs/.test(del),
      "🔴 скасування видаляє рядок — слід дії на грошах зникає");
    assert.match(del, /revoke_note/, "🔴 скасування не пише причину — журнал стає безіменним");
  } finally { await c.end(); scratch.dispose(); }
});

test("#198g рахунки БЕЗ номера згортаються в один ключ — і журнал це знає", needsDb(), async (t) => {
  // 🔴 ТИХА РОЗБІЖНІСТЬ, ЯКУ НА ЕКРАНІ НЕ ВИДНО ВЗАГАЛІ.
  //
  // Ключ списання — пара (сирий ключ клієнта, номер рахунку), а `invoice_no` у
  // `receivable_invoices` буває порожнім. Кілька безномерних рахунків одного
  // клієнта згортаються в ОДИН ключ. Без агрегації `ON CONFLICT DO UPDATE`
  // записав би суму ОСТАННЬОГО рядка — а join на екрані накрив би ВСІ, тож
  // плитка просіла б на повну суму, і журнал розійшовся б із нею мовчки.
  //
  // ⚠️ Женемо САМ текст запиту з роута, а не переписаний «схоже»: переписаний
  // SQL доводить рівно нічого (урок `#21c`).
  const { WRITEOFF_TARGETS_SQL } = await import("./receivablesWriteoff.js");
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SRC("db/schema.sql"), "utf8"));
    // Три безномерні рахунки (порожній рядок і NULL — обидві форми) + один із номером.
    await c.query(`INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, invoice_no, amount)
                   VALUES ('к','к','К',NULL,100), ('к','к','К','',200), ('к','к','К',NULL,300), ('к','к','К','7',50)`);
    const r = await c.query<{ invoice_no: string; amount: string }>(WRITEOFF_TARGETS_SQL(false), ["к"]);
    const byNo = new Map(r.rows.map((x) => [x.invoice_no, Number(x.amount)]));
    assert.equal(r.rowCount, 2, "🔴 безномерні рахунки не згорнулись в один ключ — журнал збереже лише останній");
    assert.equal(byNo.get(""), 600, "🔴 сума безномерних не 600 — журнал розійдеться з тим, що зникне з екрана");
    assert.equal(byNo.get("7"), 50, "🔴 рахунок із номером злився з безномерними");

    // 🪞 ДЗЕРКАЛО: гілка «один рахунок» звужує, а не ігнорує номер — інакше
    // списання ОДНОГО рахунку тихо забирало б увесь борг клієнта.
    const one = await c.query<{ amount: string }>(WRITEOFF_TARGETS_SQL(true), ["к", "7"]);
    assert.equal(one.rowCount, 1, "🔴 гілка по одному рахунку віддала не один рядок");
    assert.equal(Number(one.rows[0].amount), 50, "🔴 списання одного рахунку захопило чужі суми");

    // 💵 ГОТІВКОВИЙ РЯДОК: `client_key_raw` = NULL, І САМЕ ЙОГО ФІКСТУРА НЕ
    // ПРОХОДИЛА ЖОДНОГО РАЗУ (знахідка нічного аудиту, підтверджена).
    //
    // `insertCashReceivables` вставляє в `receivable_invoices` БЕЗ `client_key_raw`
    // — заміряно на проді: у МГЕР (готівка) 12 рахунків, `client_key_raw`
    // заповнений у НУЛЯ з них. Уся фікстура вище ставила `'к'`, тож гілка
    // `COALESCE(…, client_key)` не виконувалась ніколи: гейт благословляв
    // випадок, якого не бачив.
    //
    // ⚠️ Висновок аудиту («списати готівкового неможливо») при цьому НЕ
    // підтвердився: запис і читання беруть ОДИН вираз `COALESCE`, тож NULL
    // вироджується симетрично. Перевірено повним циклом у транзакції з ROLLBACK
    // проти прода — 12 цілей, 12 у розкритті, 12 в архіві з назвою, скасування
    // повертає 0. Але фікстуру це не виправдовує: сліпа пляма була справжня.
    await c.query(`INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, invoice_no, amount)
                   VALUES ('готівка', NULL, 'МГЕР', '900', 700), ('готівка', NULL, 'МГЕР', NULL, 300)`);
    const cash = await c.query<{ client_key_raw: string; invoice_no: string; amount: string }>(
      WRITEOFF_TARGETS_SQL(false), ["готівка"]);
    assert.equal(cash.rowCount, 2, "🔴 готівкові рахунки не дали цілей списання");
    for (const row of cash.rows) {
      assert.equal(row.client_key_raw, "готівка",
        "🔴 при NULL у `client_key_raw` ключем стало не `client_key` — запис і читання розійдуться, "
        + "і списання готівкового клієнта стане невидимим");
    }
    // І ЧИТАННЯ бачить його тим самим виразом — інакше запис ліг би, а екран мовчав.
    await c.query(`INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note)
                   VALUES ('готівка', '900', 700, 'готівкова проба')`);
    const seen = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM receivable_invoices ri
        WHERE ri.client_key = 'готівка' AND EXISTS (SELECT 1 FROM receivable_writeoffs w
          WHERE w.client_key_raw = COALESCE(ri.client_key_raw, ri.client_key)
            AND w.invoice_no = COALESCE(ri.invoice_no,'') AND w.revoked_at IS NULL)`);
    assert.equal(Number(seen.rows[0].n), 1,
      "🔴 списаний готівковий рахунок не видно на боці ЧИТАННЯ — запис і читання беруть різні вирази ключа");

    // І ключ справді витримує вставку: пара унікальна, друга спроба ОНОВЛЮЄ.
    for (const row of r.rows) {
      await c.query(`INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note)
                     VALUES ('к', $1, $2, 'перевірка ключа')
                     ON CONFLICT (client_key_raw, invoice_no) DO UPDATE SET amount = EXCLUDED.amount`,
                    [row.invoice_no, Number(row.amount)]);
    }
    const w = await c.query<{ s: string }>(`SELECT SUM(amount) AS s FROM receivable_writeoffs WHERE client_key_raw='к'`);
    assert.equal(Number(w.rows[0].s), 650,
      "🔴 у журналі не вся списана сума — саме та тиха розбіжність, заради якої гейт існує");
  } finally { await c.end(); scratch.dispose(); }
});

test("#198h списане віднімається і від РЯДКА, а не лише від плитки", async () => {
  // 🔴 ЩО САМЕ ТУТ ЛАМАЛОСЬ, І ЧОМУ ЦЕ ОКРЕМИЙ ГЕЙТ.
  //
  // Борг рядка приходить із `receivables` (ядро `metrics.receivablesByClient`),
  // а плитка складається з ФАКТІВ по рахунках. Це ДВА РІЗНІ ДЖЕРЕЛА одного
  // числа. Поки списання зменшувало лише факти, екран показував просілу плитку
  // й НЕзмінений рядок: Σ рядків ≠ плитці, а в самому рядку одночасно стояли
  // «борг 3 ₴» і «списано: 1 на 3 ₴».
  //
  // 📐 Знайшов це чужий гейт (`#150c`, Δ 3.00 на живих даних приймання), а не я.
  // Мій власний цикл різницю ДРУКУВАВ — `рядок.сума` лишалась 3 у всіх трьох
  // станах — і я її не побачив, бо міряв Δ плитки, яку сам і перевіряв.
  //
  // 🔴 І САМЕ ТОМУ ГЕЙТ ТУТ, А НЕ «`#150c` уже ловить». `#150c` червоніє лише
  // коли списання ФАКТИЧНО існує в базі; сьогодні їх нуль, отже на зламаному
  // коді він був би зелений. Це рівно та пастка, що `#56b`/`#61b`: перевірка,
  // привʼязана до наявності стану, стереже лише в ті дні, коли стан є.
  const { foldFacts, classifyInvoice } = await import("./receivablesFacts.js");
  const row = (invoiceNo: string, amount: number, writtenOff: boolean) => classifyInvoice({
    clientKey: "к", clientName: "К", amount, invoiceDate: "2026-08-01", invoiceNo,
    dealId: 1, dealFound: true, paymentType: "Безнал с НДС", statusId: 142, pipelineId: 8921932,
    stageMapped: true, writtenOff, carrierPayAmount: null, carrierPayType: null,
    earned: 10, clientPay: 100, carrierObligation: null, ageDays: 5,
  });
  const { byClient, totals } = foldFacts([row("1", 100, false), row("2", 30, true)]);
  const c = byClient.get("к")!;

  // Факти: у сумі лишилось 100, списане пораховане окремо.
  assert.equal(totals.amount, 100, "🔴 списане знову потрапило в суму плитки");
  assert.equal(c.writtenOffAmount, 30, "🔴 списане не пораховане окремим числом");

  // 🔴 ГОЛОВНЕ ТВЕРДЖЕННЯ: борг рядка (130 із `receivables`) МІНУС списане має
  // дорівнювати плитці. Інакше на одному екрані два числа про одне й те саме.
  const rowDebtFromReceivables = 130;
  const visible = rowDebtFromReceivables - c.writtenOffAmount;
  assert.equal(visible, totals.amount,
    "🔴 рядок і плитка розійшлись — Σ рядків не дорівнює плитці, і кожне число виглядає правдоподібно");

  // І роут справді рахує рядок ТИМ САМИМ виразом, а не `r.amount` напряму:
  // без цього функція вище була б правильною, а екран — ні.
  const src = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  const at = src.indexOf('dashboardRouter.get("/receivables"');
  const body = strip(src.slice(at, src.indexOf("res.json({", at)));
  assert.match(body, /const visibleAmount = r\.amount - \(cf\?\.writtenOffAmount \?\? 0\)/,
    "🔴 роут більше не віднімає списане від боргу рядка");
  assert.match(body, /amount: visibleAmount/, "🔴 рядок клієнта знову віддає невіднятий борг");
  assert.match(body, /entry\.total \+= visibleAmount/,
    "🔴 підсумок менеджера рахує невіднятий борг — Σ по екрану розійдеться з плиткою");
  assert.ok(!/amount: r\.amount\b/.test(body), "🔴 у рядку лишився прямий `r.amount`");
  assert.ok(!/entry\.total \+= r\.amount\b/.test(body), "🔴 у підсумку лишився прямий `r.amount`");
});

test("#198i Σ колонки «заробили» в розкритті == «Заробили» в рядку клієнта", async () => {
  // 🔴 ПРАВИЛО, СФОРМУЛЬОВАНЕ ВЧОРА: перевіряй не те число, яке змінив, а те,
  // яке МУСИТЬ ІЗ НИМ ЗІЙТИСЬ. Ми додали колонку в розкритті — отже стерегти
  // треба її рівність із «Заробили» рядка клієнта, а не саму її наявність.
  //
  // Заробіток належить УГОДІ, а не рахунку. Кілька рахунків на одну угоду →
  // число малюється ЛИШЕ на першому, решта дістають «та сама угода». Намалюй
  // у кожному — і Σ перевищить рядок клієнта рівно на кількість дублів.
  //
  // 📐 ЗАМІР ЗМІНИВ ФОРМУ ГЕЙТА, а не лише підтвердив її. На живому проді
  // 26.08.2026: 302 рахунки · 283 з лінком · **283 УНІКАЛЬНІ угоди** · рядків
  // «та сама угода» — НУЛЬ. Розрив «315 проти 295» — це рахунки БЕЗ лінка, а не
  // дублі. Тобто гейт, що спирався б на наявність дублів у проді, був би
  // зелений незалежно від коду — рівно пастка `#56b`/`#61b`. Тому механізм
  // стоїть на ВЛАСНІЙ фікстурі й червоніє в будь-який день.
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    earnedCells: (r: { dealId: number | null; dealFound: boolean; earned: number | null; writtenOff: boolean }[]) => { kind: string; earned?: number; why?: string }[];
    earnedShownTotal: (c: { kind: string; earned?: number }[]) => number;
    earnedCellText: (c: { kind: string; why?: string }) => string | null;
    earnedCellHint: (c: { kind: string; why?: string }) => string;
  };
  const { foldFacts, classifyInvoice } = await import("./receivablesFacts.js");
  const mk = (invoiceNo: string, amount: number, dealId: number | null, earned: number | null,
              opts: { dealFound?: boolean; writtenOff?: boolean } = {}) => ({
    clientKey: "к", clientName: "К", amount, invoiceDate: "2026-08-01", invoiceNo,
    dealId, dealFound: opts.dealFound ?? (dealId != null), paymentType: "Безнал с НДС",
    statusId: 142, pipelineId: 8921932, stageMapped: true, writtenOff: opts.writtenOff ?? false,
    carrierPayAmount: null, carrierPayType: null, earned, clientPay: 1000,
    carrierObligation: null, ageDays: 5,
  });

  // ФІКСТУРА, яка містить УСІ п'ять випадків одночасно:
  //   два рахунки однієї угоди · окрема угода · рахунок без лінка (1С) ·
  //   битий лінк · списаний рахунок ТІЄЇ САМОЇ угоди, що й живий.
  const rows = [
    mk("1", 100, 501, 40),                         // перший рахунок угоди 501 → число
    mk("2", 200, 501, 40),                         // ДРУГИЙ рахунок тієї ж угоди → «та сама угода»
    mk("3", 300, 502, 55),                         // інша угода → число
    mk("4", 400, null, null),                      // 1С, угоди немає за задумом → «—»
    mk("5", 500, 777, 999, { dealFound: false }),  // битий лінк → «—»
    mk("6", 600, 503, 70, { writtenOff: true }),   // списаний → числа НЕ несе
  ];
  const cells = V.earnedCells(rows);
  assert.deepEqual(cells.map((c) => c.kind),
    ["value", "same-deal", "value", "unknown", "unknown", "written-off"],
    "🔴 розподіл клітинок змінився — перевір, кому дістається число");

  // 🔴 ГОЛОВНЕ ТВЕРДЖЕННЯ: Σ намальованого == «Заробили» рядка клієнта.
  const { byClient } = foldFacts(rows.map((r) => classifyInvoice(r)));
  const rowEarned = byClient.get("к")!.earned;
  assert.equal(V.earnedShownTotal(cells), rowEarned,
    "🔴 Σ колонки розійшлась із «Заробили» рядка клієнта — це друге джерело одного числа");
  assert.equal(rowEarned, 95, "🔴 еталон зсунувся: 40 (угода 501, раз) + 55 (угода 502); списана 503 не входить");

  // 🪞 ДЗЕРКАЛО ДО САМОГО ДЕФЕКТУ: «намалювати в кожному рядку» дає БІЛЬШЕ.
  // Без цього гейт лишався б зеленим і тоді, коли ловити нічого (напр. якби
  // фікстура випадково не мала дубля) — а живі дані сьогодні саме такі.
  const naive = rows.filter((r) => r.dealId != null && r.dealFound && !r.writtenOff)
    .reduce((s, r) => s + (r.earned ?? 0), 0);
  assert.equal(naive, 135, "🔴 наївна сума мала б подвоїти угоду 501");
  assert.notEqual(naive, rowEarned,
    "🔴 фікстура втратила дубль — гейт більше не має що ловити, це ПРОВАЛ, а не успіх");

  // Порожнє місце — заборонене: кожен не-числовий стан має текст І причину.
  for (const c of cells) {
    if (c.kind === "value") continue;
    assert.ok((V.earnedCellText(c) ?? "").length > 0, `🔴 клітинка «${c.kind}» порожня — читатиметься як «нічого немає»`);
    assert.ok(V.earnedCellHint(c).length > 10, `🔴 клітинка «${c.kind}» без пояснення причини`);
  }

  // 🔴 ПІДПИС ЗВІРЯЄМО НА ЕКРАНІ, А НЕ В КОНСТАНТІ.
  // Перша редакція перевіряла `EARNED_COL_LABEL` — і та константа після
  // переверстки стала МЕРТВОЮ (розкриття більше не має власної шапки, колонка
  // підписана спільним заголовком). Гейт лишався зеленим, стережучи те, чого на
  // екрані немає; спіймав це `grep` по БАНДЛУ — маркер дав нуль збігів, бо
  // tree-shaking вирізав мертвий експорт. Той самий клас, що `BandHead`.
  const th = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const head = th.slice(th.indexOf("<thead>"), th.indexOf("</thead>"));
  assert.match(head, /Заробили/, "🔴 колонка заробітку втратила підпис у шапці");
  assert.match(head, /поля «Бюджет» в угоді CRM/,
    "🔴 підказка більше не називає джерело словами власника — людина не впізнає поле");
  assert.match(head, /від суми рахунків/,
    "🔴 знаменник не названий: «Заробили %» прочитають як «% від боргу»");

  // І верстка справді бере ці функції, а не рахує колонку своїм виразом.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.match(sec, /const eCells = earnedCells\(inv\)/,
    "🔴 розкриття більше не бере клітинки з ядра правила");
  assert.match(sec, /const eTotal = earnedShownTotal\(eCells\)/,
    "🔴 підсумок рахується не з намальованих клітинок — він зможе розійтись із колонкою");
  assert.ok(!/inv\.reduce\(\([^)]*\) => [^)]*earned/.test(sec),
    "🔴 у верстці зʼявився ДРУГИЙ вираз для Σ заробленого");
});

/* ═══════════ ПЕРЕВЕРСТКА ЗА МАКЕТОМ v5 (26.08.2026) ═══════════ */

test("#199h розкриття — рядки ТІЄЇ САМОЇ таблиці, колонки збігаються за побудовою", () => {
  // 🔴 ВКЛАДЕНА ТАБЛИЦЯ МАЛА ВЛАСНІ КОЛОНКИ, і збігалися вони з батьківськими
  // лише «на око» — рівно тому на проді заробіток стояв ПЕРЕД сумою, і числа
  // читались навхрест. Власник помітив це оком; жоден гейт не міг, бо кожна
  // таблиця окремо була правильна.
  //
  // Коли рахунок — рядок ТІЄЇ САМОЇ таблиці, колонка стоїть під своєю колонкою
  // ЗА ПОБУДОВОЮ. Тому гейт перевіряє не порядок підписів, а те, що вкладеної
  // таблиці більше немає І що кількість клітинок однакова в усіх видах рядка.
  const src = readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8");
  const sec = strip(src);

  // (а) вкладеної таблиці немає: у файлі рівно ДВІ <table> — клієнти й підсумок
  //     по менеджерах. Третя означала б, що розкриття знову живе окремо.
  const tables = (sec.match(/<table\b/g) ?? []).length;
  assert.equal(tables, 2, `🔴 у секції ${tables} таблиць — розкриття знову стало вкладеною`);

  // (б) сітка: шапка, рядок клієнта, рядок рахунку й підсумковий — однакові.
  const count = (chunk: string) => {
    let n = 0;
    for (const m of chunk.matchAll(/<td\b((?:[^>]|\n)*?)(?:\/>|>)/g)) {
      const cs = /colSpan=\{(\d+)\}/.exec(m[1]);
      n += cs ? Number(cs[1]) : 1;
    }
    return n;
  };
  const head = sec.slice(sec.indexOf("<thead>"), sec.indexOf("</thead>"));
  const cols = (head.match(/<th\b/g) ?? []).length;
  const client = sec.slice(sec.indexOf('className="recv-row"'), sec.indexOf("{renderInvoices(c.clientKey"));
  // ⚠️ Зріз до КІНЦЯ `.map`, а не до слів «Разом по»: підсумковий рядок
  // відкривається РАНІШЕ за свій текст, і його клітинки потрапляли в підрахунок
  // (16 замість 11). Гейт червонів на власній крихкості — той самий клас, що
  // «Прострочено» в коментарі, який обривав зріз плитки.
  const invoice = sec.slice(sec.indexOf("{inv.map((x, i) => {"), sec.indexOf("\n        })}"));
  assert.ok(cols > 5, "🔴 шапку не знайдено — гейт міряє порожнечу");
  assert.equal(count(client), cols, `🔴 рядок клієнта дає ${count(client)} клітинок при ${cols} колонках`);
  assert.equal(count(invoice), cols, `🔴 рядок РАХУНКУ дає ${count(invoice)} клітинок при ${cols} колонках — колонки роз'їхались`);

  // (в) розкриття кличеться з тим самим числом колонок, що в шапці.
  assert.ok(sec.includes(`renderInvoices(c.clientKey, c.clientName, ${cols})`),
    `🔴 розкриття кличеться не з ${cols} колонками — colSpan шапки групи розійдеться з таблицею`);

  // (г) заголовки СКОРОЧЕНІ, пояснення переїхали в підказки (макет v5).
  assert.ok(!/Маржа, % від суми рахунків/.test(sec), "🔴 повернувся трирядковий заголовок замість підказки");
  assert.ok(!/Днів без оплати/.test(sec), "🔴 повернувся довгий заголовок «Днів без оплати»");
  assert.ok(!/>\s*Обіцяна дата\s*</.test(sec), "🔴 «Обіцяна дата» знову окрема колонка — це одна думка на два стовпці");
});

test("#199i активним є ЛИШЕ коментар поточного тижня, і історія не гине", async () => {
  // 🔴 ДЖОБА, ЩО ЗАТИРАЄ ПОЛЕ, — НЕЗВОРОТНА ВТРАТА ДАНИХ ЗАРАДИ КОСМЕТИКИ,
  // і вона ще й не спрацює, якщо в понеділок сервер лежав. Тому межа ЛІНИВА:
  // активним є запис ПІСЛЯ понеділка 00:00 за Києвом, а старий просто перестає
  // вважатись актуальним — лежачи в журналі з датою й автором.
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    weekStartKyiv: (d: Date) => string;
    isCurrentWeekNote: (at: string | null, now: Date) => boolean;
    activeNote: (c: string | null, at: string | null, now: Date) => string;
    NOTE_EMPTY_PLACEHOLDER: string;
  };
  // Середа 26.08.2026 12:00 Київ → тиждень почався в понеділок 24.08.
  const now = new Date("2026-08-26T09:00:00Z");
  assert.equal(V.weekStartKyiv(now), "2026-08-24", "🔴 початок тижня зсунувся — межа поїде на всіх клієнтах");

  assert.equal(V.isCurrentWeekNote("2026-08-25T10:00:00Z", now), true, "🔴 вчорашній запис цього тижня став неактивним");
  // ⚠️ 23.08 13:00 Київ — це НЕДІЛЯ, тобто минулий тиждень. Перша редакція
  // брала 23.08 23:00 UTC і була НЕПРАВИЛЬНА: у Києві це вже 24.08 02:00,
  // тобто понеділок. Помилка була у фікстурі, не в коді — і спіймав її гейт.
  assert.equal(V.isCurrentWeekNote("2026-08-23T10:00:00Z", now), false, "🔴 запис МИНУЛОГО тижня лишився активним");
  assert.equal(V.isCurrentWeekNote(null, now), false);

  // 🔴 КИЇВСЬКА МЕЖА, А НЕ UTC. Понеділок 24.08 00:30 Київ = 23.08 21:30 UTC:
  // за UTC цей запис читався б як МИНУЛОТИЖНЕВИЙ, тобто зникав би з екрана
  // одразу після того, як людина його зробила.
  assert.equal(V.isCurrentWeekNote("2026-08-23T21:30:00Z", now), true,
    "🔴 межу рахують за UTC — понеділковий ранковий запис зникає з екрана");

  // Показ: старий текст НЕ показується, і порожнеча підписана відповіддю.
  assert.equal(V.activeNote("торішня обіцянка", "2026-08-10T10:00:00Z", now), "",
    "🔴 старий текст показується як сьогоднішня домовленість");
  assert.equal(V.activeNote("400 до пʼятниці", "2026-08-25T10:00:00Z", now), "400 до пʼятниці");
  assert.match(V.NOTE_EMPTY_PLACEHOLDER, /ще не записано/, "🔴 порожній стан не підписаний — читатиметься як «немає даних»");

  // 🔴 І ГОЛОВНЕ: НІЩО НЕ ВИДАЛЯЄТЬСЯ. Роут ДОПИСУЄ в журнал, а джоби немає.
  const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  assert.match(routes, /INSERT INTO receivable_note_history/,
    "🔴 журнал не поповнюється — тижнева межа стала втратою даних");
  assert.ok(!/UPDATE receivable_notes SET comment = NULL|DELETE FROM receivable_note_history/.test(routes),
    "🔴 зʼявилось затирання коментаря — саме те, чого власник прямо не хоче");
  const schema = readFileSync(SRC("db/schema.sql"), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS receivable_note_history/,
    "🔴 таблиці журналу немає — історії нема де жити");
  // Дзеркало: журнал не має PK по клієнту, інакше він теж тримав би один рядок
  // і «історія» була б тим самим затиранням, лише в іншому місці.
  const tbl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS receivable_note_history"),
                           schema.indexOf("CREATE TABLE IF NOT EXISTS receivable_note_history") + 500);
  assert.ok(!/PRIMARY KEY \(client_key\)/.test(tbl),
    "🔴 журнал з PK по клієнту — це один рядок на клієнта, тобто те саме затирання");
});

test("#198j підказка живе в body з position:fixed — інакше її ріже прокрутка", () => {
  // 🔴 ЄДИНИЙ ПРИЙОМ, УЗЯТИЙ З МАКЕТА ДОСЛІВНО, і причина технічна: таблиця
  // живе всередині `overflow-x: auto`, а будь-який `absolute` усередині такого
  // контейнера обрізається його межами — тобто підказка над ПРАВОЮ колонкою
  // була б відрізана рівно там, де вона потрібна.
  const hint = readFileSync(FE("components/Hint.tsx"), "utf8");
  assert.match(hint, /createPortal\(/, "🔴 підказка більше не портал — її ріже контейнер прокрутки");
  // 🔴 ПЕРША РЕДАКЦІЯ БУЛА БЕЗЗУБА: вона шукала `document.body` БУДЬ-ДЕ у файлі.
  // Саботаж «портал у контейнер таблиці, а body лише фолбеком» лишав рядок на
  // місці — і гейт був зелений на зламаному коді. Той самий клас, що беззубе
  // дзеркало `#199d`: перевірялась ПРИСУТНІСТЬ рядка, а не те, куди насправді
  // йде портал. Тепер дивимось на ДРУГИЙ АРГУМЕНТ `createPortal`.
  // ЦІЛЬ ПОРТАЛУ — РІВНО `document.body`, останнім аргументом і нічим іншим.
  assert.match(strip(hint), /,\s*\n\s*document\.body\s*\n\s*\);/,
    "🔴 другий аргумент createPortal — не рівно `document.body`: усе, що всередині "
    + "overflow-x:auto, обрізається межами свого контейнера");
  assert.ok(!/querySelector|getElementById/.test(strip(hint)),
    "🔴 ціль порталу шукається в DOM — вона може виявитись контейнером прокрутки, і підказку знову обріже");
  assert.match(hint, /position:\s*"fixed"/, "🔴 підказка не fixed — вона поїде разом із прокруткою");
  // Прокрутка ховає підказку, і слухач ОБОВʼЯЗКОВО з capture: прокручується
  // внутрішній контейнер, і без capture подія до вікна не дійде.
  assert.match(hint, /addEventListener\("scroll",[^)]*true\)/,
    "🔴 слухач прокрутки без capture — підказка зависне над чужим місцем");
  // 🔴 ТЕКСТ, А НЕ HTML: у підказки їдуть назви клієнтів і суми з БД.
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(strip(hint)),
    "🔴 підказка рендерить HTML — це ін'єкція з даних (макет так робить, бо він статичний)");
  // Клавіатура нарівні з мишею: підказка — єдине місце, де сказано, звідки число.
  assert.match(hint, /onFocus/, "🔴 підказка недоступна з клавіатури");

  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.match(sec, /<TipLayer \/>/, "🔴 шар підказок не змонтовано — жодна підказка не покажеться");
  // Правило власника: якщо на екрані є число, має бути пояснення, звідки воно.
  const hints = (sec.match(/<Hint\b/g) ?? []).length;
  assert.ok(hints >= 8, `🔴 підказок лише ${hints} — у макеті вони біля КОЖНОГО показника`);
});

test("#197k «н/д» у розкритті — прочерк із причиною, а НЕ нуль", () => {
  // Той самий урок, що з «угоди немає ≠ перевізник не оплачений»: нуль у
  // грошовій клітинці стверджує факт, якого ми не знаємо.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const inv = sec.slice(sec.indexOf("{inv.map((x, i) => {"), sec.indexOf("Разом по {inv.length}"));
  assert.ok(inv.length > 200, "🔴 рядок рахунку не знайдено — гейт міряє порожнечу");
  // Юрособа без відповіді — підписана причиною, а не порожня.
  assert.match(inv, /ENTITY_REASON_LABEL\[x\.ourEntityReason\]/,
    "🔴 «невідомо» в юрособі втратило причину — порожнє місце читається як «нічого немає»");
  // Заробіток без угоди — текст із причини, а не formatAmount(0).
  assert.match(inv, /eTxt == null[\s\S]{0,120}earnedCellHint\(ec\)/,
    "🔴 клітинка заробітку більше не показує причину прочерку");
  assert.ok(!/formatAmount\(x\.earned \?\? 0\)/.test(inv),
    "🔴 відсутній заробіток малюється нулем — це твердження «не заробили», якого ми не знаємо");
  assert.match(inv, /age \?\? "—"/, "🔴 вік рахунку без дати став нулем замість прочерку");
});


test("#199j тижнева межа не робить старі коментарі НЕДОСЯЖНИМИ", needsDb(), async (t) => {
  // 🔴 ДІРА, ЯКУ Я СТВОРИВ САМ І ЗНАЙШОВ ЗАМІРОМ ПІСЛЯ ВИКАТУ.
  //
  // Правило ховає з поля все, що старіше за поточний тиждень, — так і задумано.
  // Але журнал наповнюється ЛИШЕ новими збереженнями, тож у момент викату він
  // порожній: заміряно на проді 26.08.2026 — з 77 заповнених коментарів **59
  // старіші за тиждень**, і всі 59 ставали недосяжними. Ні в полі, ні в історії;
  // у БД лежать, побачити не може ніхто. Це не «сховали», це «загубили на екрані».
  //
  // Інваріант, який тепер тримається: у КОЖНОГО непорожнього коментаря є
  // щонайменше один запис у журналі. Тоді «сховати з поля» завжди означає
  // «перенести в історію», а не «прибрати з очей».
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    const schema = readFileSync(SRC("db/schema.sql"), "utf8");
    await c.query(schema);
    // Сіємо коментар, ЯКИЙ БУВ БИ схований: місячної давності.
    await c.query(`INSERT INTO receivable_notes (client_key, comment, updated_at)
                   VALUES ('к', 'обіцяв 400 до пʼятниці', now() - interval '30 days')`);
    // Друга міграція = той самий бекфіл, що поїде на прод.
    await c.query(schema);
    const h = await c.query<{ comment: string; written_at: string }>(
      `SELECT comment, written_at FROM receivable_note_history WHERE client_key = 'к'`);
    assert.equal(h.rowCount, 1,
      "🔴 старий коментар не потрапив у журнал — правило сховало б його з поля, і він став би недосяжним");
    assert.match(h.rows[0].comment, /400 до пʼятниці/);

    // 🔴 ДАТА — СВОЯ, А НЕ `now()`. Інакше вся історія злиплась би в момент
    // міграції, і «тиждень 18-24.08» став би «тиждень викату».
    const age = await c.query<{ d: number }>(
      `SELECT EXTRACT(day FROM now() - written_at)::int AS d FROM receivable_note_history WHERE client_key='к'`);
    assert.ok(age.rows[0].d >= 29,
      `🔴 запис датований моментом міграції (вік ${age.rows[0].d} дн.) — історія втратила свої дати`);

    // 🪞 ІДЕМПОТЕНТНІСТЬ: унікального ключа в журналі немає навмисно (одного дня
    // можна записати двічі), тож `ON CONFLICT` не працює — захист через NOT EXISTS.
    // Без нього кожен прогін міграції подвоював би історію.
    await c.query(schema);
    await c.query(schema);
    const again = await c.query(`SELECT count(*)::int n FROM receivable_note_history WHERE client_key='к'`);
    assert.equal(again.rows[0].n, 1, "🔴 повторна міграція подвоїла журнал");

    // Дзеркало: порожній коментар у журнал НЕ пишеться — «стер текст» не є домовленістю.
    await c.query(`INSERT INTO receivable_notes (client_key, comment, updated_at) VALUES ('порожній', '   ', now())`);
    await c.query(schema);
    const empty = await c.query(`SELECT count(*)::int n FROM receivable_note_history WHERE client_key='порожній'`);
    assert.equal(empty.rows[0].n, 0, "🔴 порожній коментар потрапив у журнал — історія заросте нічим");
  } finally { await c.end(); scratch.dispose(); }
});

test("#199k нерозбірна або відсутня дата НЕ валить екран", async () => {
  // 🔴 ЦЕЙ ГЕЙТ ПИШЕТЬСЯ ПІСЛЯ АВАРІЇ НА ПРОДІ 26.08.2026, І ЦЕ ВАЖЛИВО НАЗВАТИ:
  // `test:prod` дав 500 із 500, усі гейти були зелені, приймання числами
  // зійшлося — а розділ дебіторки не відкривався ВЗАГАЛІ: «Invalid time value»
  // замість таблиці. Числа й екран перевіряють різні речі.
  //
  // МЕХАНІЗМ: Postgres `to_char(..., 'OF')` віддає ДВОЗНАЧНЕ зміщення (`+03`), а
  // ECMAScript вимагає `±HH:mm`. `new Date("2026-08-26T10:21:50+03")` → Invalid
  // Date, `Intl.format` на ньому КИДАЄ, і виняток усередині `.map` по рядках
  // убиває всю секцію — не клітинку, не рядок, а екран.
  //
  // ⚠️ ГІПОТЕЗА «падають ті, у кого дати НЕМА» була ХИБНОЮ — там стоїть сторож.
  // Падали ті, у кого дата Є: 49 із 76. Перевіряти треба відтворюване.
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    parseDateSafe: (v: string | null | undefined) => Date | null;
    formatDateSafe: (v: string | null | undefined, f?: string) => string;
    isCurrentWeekNote: (at: string | null, now: Date) => boolean;
    activeNote: (c: string | null, at: string | null, now: Date) => string;
    kyivDate: (d: Date) => string;
  };
  const now = new Date("2026-08-26T09:00:00Z");

  // ── САМЕ ТОЙ ФОРМАТ, ЩО ПОКЛАВ ПРОД. Голий `new Date` його не бере.
  assert.ok(Number.isNaN(new Date("2026-08-26T10:21:50+03").getTime()),
    "🔴 рушій раптом почав розбирати двозначне зміщення — перевір, чи гейт іще про щось");
  assert.throws(() => V.kyivDate(new Date("2026-08-26T10:21:50+03")), /Invalid time value/,
    "🔴 форматування більше не кидає на Invalid Date — гейт стереже те, чого немає");

  // 🔴 ГОЛОВНЕ: жоден вхід НЕ кидає, і кожен має свій стан.
  for (const bad of [null, undefined, "", "не дата", "2026-13-45T99:99:99Z", "0000-00-00"]) {
    assert.doesNotThrow(() => V.parseDateSafe(bad), `🔴 parseDateSafe кидає на ${JSON.stringify(bad)}`);
    assert.equal(V.parseDateSafe(bad), null, `🔴 ${JSON.stringify(bad)} дав Date замість null`);
    assert.doesNotThrow(() => V.formatDateSafe(bad), `🔴 formatDateSafe кидає на ${JSON.stringify(bad)}`);
    assert.doesNotThrow(() => V.isCurrentWeekNote(bad as string | null, now),
      `🔴 isCurrentWeekNote кидає на ${JSON.stringify(bad)} — це і є падіння всієї секції`);
    assert.doesNotThrow(() => V.activeNote("текст", bad as string | null, now),
      `🔴 activeNote кидає на ${JSON.stringify(bad)}`);
  }

  // Двозначне зміщення Postgres добирається до канонічного й ПРАЦЮЄ, а не просто
  // не падає: інакше 49 клієнтів мовчки втратили б свою домовленість.
  const d = V.parseDateSafe("2026-08-26T10:21:50+03");
  assert.ok(d, "🔴 `+03` не розібрано — 49 клієнтів утратили б дату домовленості");
  assert.equal(V.kyivDate(d!), "2026-08-26");
  assert.equal(V.isCurrentWeekNote("2026-08-26T10:21:50+03", now), true,
    "🔴 запис цього тижня у форматі Postgres не вважається активним");

  // 🪞 ДЗЕРКАЛО: сторож не перетворює ВСЕ на «немає». Канонічні формати живі.
  assert.ok(V.parseDateSafe("2026-08-26T10:21:50Z"), "🔴 сторож зарізав канонічний ISO");
  assert.ok(V.parseDateSafe("2026-08-24"), "🔴 сторож зарізав звичайну дату");
  assert.equal(V.formatDateSafe(null), "дати немає", "🔴 порожній стан без підпису — читається як «нічого немає»");

  // ── ДРУГИЙ РУБІЖ: бекенд більше не віддає формат, який рушій не бере.
  const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  const notes = routes.slice(routes.indexOf("FROM receivable_notes n WHERE n.client_key") - 1200,
                             routes.indexOf("FROM receivable_notes n WHERE n.client_key"));
  assert.ok(!/HH24:MI:SSOF/.test(notes),
    "🔴 `updated_at` знову віддається з двозначним зміщенням OF — саме воно поклало прод");
  assert.match(notes, /AT TIME ZONE 'UTC'[\s\S]{0,80}HH24:MI:SS"Z"/,
    "🔴 `updated_at` віддається не в UTC із Z — єдиному форматі, який усі рушії читають однаково");

  // І у ВЕРСТЦІ немає голого `new Date(поле)` — кожна дата йде через сторож.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const naked = [...sec.matchAll(/new Date\(([^)]*)\)/g)].map((m) => m[1].trim())
    .filter((arg) => arg !== "" && !arg.startsWith("now.getTime"));
  assert.deepEqual(naked, [],
    `🔴 у верстці лишився голий new Date(${naked.join(", ")}) — одна нерозбірна дата вб'є всю секцію`);

  // ── ТРЕТІЙ РУБІЖ: межа на рівні РЯДКА. Сторожі ловлять відоме; межа ловить
  // те, чого ми не передбачили, і не дає одному клієнту забрати з собою решту
  // 75. Вона НЕ ховає дефект — називає клієнта поіменно, інакше рядок мовчки
  // зникав би з таблиці, а Σ по екрану розійшлася б із плиткою.
  assert.match(sec, /<RowBoundary key=\{`\$\{c\.clientKey\}-\$\{i\}`\} label=\{c\.clientName\} cols=\{11\}>/,
    "🔴 рядок клієнта більше не обгорнутий межею — одна погана дата знову вб'є всю секцію");
  const rb = strip(readFileSync(FE("pages/dashboard/sections/RowBoundary.tsx"), "utf8"));
  assert.match(rb, /getDerivedStateFromError/, "🔴 межа не ловить помилки рендеру");
  assert.match(rb, /this\.props\.label/, "🔴 межа не називає клієнта — «щось зламалось» не веде до причини");
  assert.ok(!/return null|return <\/>|children\s*:\s*null/.test(rb),
    "🔴 межа ХОВАЄ зламаний рядок — він зник би з таблиці, а Σ розійшлася б із плиткою мовчки");
});


/* ═══════════ 🗄 АРХІВ: СПИСАНЕ ВИХОДИТЬ З ОЧІКУВАНИХ (26.08.2026) ═══════════ */

/**
 * 🔴 ОКРЕМИЙ ГЕЙТ НА КОЖНУ ФУНКЦІЮ — ВИМОГА ВЛАСНИКА, І ВОНА ПРАВИЛЬНА.
 *
 * Один загальний гейт «предикат десь є» зеленів би, поки хоч одна функція його
 * має. А розходяться екрани саме поштучно: додав функцію — забув предикат, і
 * один екран показує очікувані з урахуванням списань, інший без. Розбіжність
 * тиха, тобто найдорожчий клас.
 *
 * 📐 ПЕРЕЛІК — РЕЗУЛЬТАТ ЗАМІРУ, А НЕ ПАМʼЯТІ. Мій власний замір назвав ПʼЯТЬ
 * функцій, і його прийняли; насправді їх ДВАНАДЦЯТЬ. Дві знайшлись випадково
 * (масова заміна влучила в шосту, сьома мала багаторядковий `conds`), решта —
 * коли я перелічив їх скриптом замість оком.
 *
 * ⚠️ ГЕЙТИ ВИПИСАНІ ПОШТУЧНО, А НЕ ЦИКЛОМ. Перша редакція генерувала їх у
 * `for` із шаблонним іменем — і маніфест справедливо почервонів: динамічні
 * імена він статично НЕ БАЧИТЬ, тобто такий гейт міг би зникнути з набору
 * непоміченим. Рівно те, від чого маніфест і заведений.
 */
function assertExcludesWrittenOff(fn: string) {
  const src = readFileSync(SRC("core/metrics.ts"), "utf8");
  const at = src.indexOf(`export async function ${fn}`);
  assert.ok(at > 0, `🔴 функції ${fn} більше немає — або перейменували, або перелік протух`);
  const next = src.indexOf("\nexport ", at + 10);
  const body = src.slice(at, next > 0 ? next : src.length);
  assert.match(body, /EXPECT_ZONE/, `🔴 ${fn} більше не читає EXPECT_ZONE — перевір, чи гейт іще про те саме`);
  assert.match(body, /DEAL_NOT_WRITTEN_OFF/,
    `🔴 ${fn} рахує очікувані БЕЗ виключення списаних — цей екран покаже більше за сусідні, і розбіжність буде тиха`);
}

test("#199l expectedZoneByScope виключає списані борги з очікуваних", () => assertExcludesWrittenOff("expectedZoneByScope"));

test("#199m expectedPaymentsByPlanned виключає списані борги з очікуваних", () => assertExcludesWrittenOff("expectedPaymentsByPlanned"));

test("#199n expectedByManagerDay виключає списані борги з очікуваних", () => assertExcludesWrittenOff("expectedByManagerDay"));

test("#199o expectedByPlannedBucket виключає списані борги з очікуваних", () => assertExcludesWrittenOff("expectedByPlannedBucket"));

test("#199p expectedBySegment виключає списані борги з очікуваних", () => assertExcludesWrittenOff("expectedBySegment"));

test("#199q expectedMonthByScope виключає списані борги з очікуваних", () => assertExcludesWrittenOff("expectedMonthByScope"));

test("#199r expectedThisMonthByScope виключає списані борги з очікуваних", () => assertExcludesWrittenOff("expectedThisMonthByScope"));

test("#199s expectedThisMonthByMgrKlass виключає списані борги з очікуваних", () => assertExcludesWrittenOff("expectedThisMonthByMgrKlass"));

test("#199t repeatForecastByManager виключає списані борги з очікуваних", () => assertExcludesWrittenOff("repeatForecastByManager"));

test("#199u carryoverByScope виключає списані борги з очікуваних", () => assertExcludesWrittenOff("carryoverByScope"));

test("#199v carryoverByManager виключає списані борги з очікуваних", () => assertExcludesWrittenOff("carryoverByManager"));

test("#199w awaitingNowSnapshot виключає списані борги («станом на зараз»)", () => {
  const src = readFileSync(SRC("core/money.ts"), "utf8");
  const at = src.indexOf("export async function awaitingNowSnapshot");
  const body = src.slice(at, src.indexOf("\nexport ", at + 10));
  assert.match(body, /DEAL_NOT_WRITTEN_OFF/,
    "🔴 знімок «станом на зараз» рахує списані — прогноз-картка розійдеться з рештою екранів");
});

test("#199x перелік функцій очікуваних ПОВНИЙ — жодної без предиката", () => {
  // 🔴 ЦЕЙ ГЕЙТ ІСНУЄ ТОМУ, ЩО МІЙ ЗАМІР БУВ НЕПОВНИЙ НА СІМ ФУНКЦІЙ.
  // Перелічувати оком — це те, як зʼявляються пропущені. Тут перелік будується
  // З ДЖЕРЕЛА: усе, що читає EXPECT_ZONE і сумує `d.price`, мусить мати предикат.
  // Нова функція без нього почервонить гейт у день народження.
  const scan = (path: string) => {
    const s = readFileSync(SRC(path), "utf8");
    const fns = [...s.matchAll(/export (?:async )?function (\w+)/g)].map((m) => ({ at: m.index!, name: m[1] }));
    const bad: string[] = [];
    for (let i = 0; i < fns.length; i++) {
      const b = s.slice(fns[i].at, i + 1 < fns.length ? fns[i + 1].at : s.length);
      const zone = /EXPECT_ZONE|STAGE_EXPECTED/.test(b);
      const money = /SUM\(d\.price\)|sum\(d\.price\)/.test(b);
      if (zone && money && !b.includes("DEAL_NOT_WRITTEN_OFF")) bad.push(fns[i].name);
    }
    return bad;
  };
  const bad = [...scan("core/metrics.ts"), ...scan("core/money.ts")];
  assert.deepEqual(bad, [],
    `🔴 функції очікуваних БЕЗ виключення списаних: ${bad.join(", ")} — цей екран покаже більше за сусідні`);

  // 🪞 ДЗЕРКАЛО: скан МАЄ ЩО ЗНАХОДИТИ. Порожній результат інакше означав би
  // «регулярка нічого не матчить», а не «все гаразд».
  const hits = (readFileSync(SRC("core/metrics.ts"), "utf8").match(/DEAL_NOT_WRITTEN_OFF/g) ?? []).length;
  assert.ok(hits >= 11, `🔴 предикат знайдено лише ${hits} разів — скан або перелік зламані`);
});

test("#199y предикат NULL-безпечний і вимагає ВСІХ рахунків угоди", async () => {
  const { DEAL_NOT_WRITTEN_OFF, FULLY_WRITTEN_OFF_DEALS } = await import("./writeoffScope.js");

  // 🔴 `NOT EXISTS`, А НЕ `NOT IN`. З NULL у підзапиті `NOT IN` виключає ВСЕ —
  // очікувані стали б нулем, і це читалось би як «списали все». Та сама
  // NULL-пастка, що вже двічі коштувала нам замірів.
  assert.match(DEAL_NOT_WRITTEN_OFF, /NOT EXISTS/,
    "🔴 предикат перейшов на NOT IN — з NULL у підзапиті він вимкне очікувані ЦІЛКОМ");
  assert.ok(!/NOT IN/.test(DEAL_NOT_WRITTEN_OFF), "🔴 у предикаті зʼявився NOT IN");
  assert.match(FULLY_WRITTEN_OFF_DEALS, /deal_id IS NOT NULL/,
    "🔴 зник захист від NULL-угод — рахунки без лінка потрапили б у вибірку");

  // 🔴 ВСІ рахунки, а не один: інакше списання копійки з десяти вимикало б угоду.
  assert.match(FULLY_WRITTEN_OFF_DEALS, /HAVING count\(\*\) = count\(\*\) FILTER/,
    "🔴 умова більше не вимагає, щоб списаними були ВСІ рахунки угоди");
  assert.match(FULLY_WRITTEN_OFF_DEALS, /w\.revoked_at IS NULL/,
    "🔴 скасовані списання знову рахуються — повернений борг лишився б поза очікуваними");
  assert.match(FULLY_WRITTEN_OFF_DEALS, /client_key_raw/,
    "🔴 предикат зіставляє не за сирим ключем — після склейки він накриє чужі угоди");
});

test("#199z розбіжність із CRM НАЗВАНА числом, а не схована", async () => {
  // 🔴 УМОВА, ПІД ЯКОЮ ВЛАСНИК ПОГОДИВСЯ НА ЦЕЙ ВАРІАНТ. Списана угода лишається
  // в Kommo на грошовій стадії, а в нас її вже немає — дашборд показує МЕНШЕ за
  // CRM, що прямо суперечить «дашборд це дзеркало CRM». Суперечність закрито не
  // забороною, а видимістю; прибрати лічильник = скасувати умову рішення.
  const { WRITTEN_OFF_STILL_IN_ZONE } = await import("./writeoffScope.js");
  assert.match(WRITTEN_OFF_STILL_IN_ZONE, /EXISTS \(SELECT 1 FROM \(/,
    "🔴 лічильник рахує не ті угоди — він мусить брати САМЕ виключені зі своїх очікуваних");
  const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  assert.match(routes, /WRITTEN_OFF_STILL_IN_ZONE/, "🔴 роут архіву більше не рахує розбіжність");
  assert.match(routes, /stillInZone/, "🔴 розбіжність не їде на екран — вона стає тихою");
  const arch = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesArchive.tsx"), "utf8"));
  assert.match(arch, /Списані борги, чиї угоди досі в грошовій зоні/,
    "🔴 на екрані немає підпису розбіжності — число без назви нічого не пояснює");
  assert.match(arch, /stillInZone\.deals > 0 &&/,
    "🔴 підпис показується завжди — «розбіжності 0» у кожному відкритті стає шумом");
});

test("#198k списаний рахунок зникає з активного списку ПОВНІСТЮ", () => {
  // 🔴 РІШЕННЯ ВЛАСНИКА 26.08.2026, І ВОНО СКАСОВУЄ ПОПЕРЕДНЄ. Було: рахунок
  // лишається закресленим із підписом «списано», а плитка каже, на скільки
  // просіла. Стало: зникає з активного списку повністю, сліду в рядку клієнта
  // немає — усе про нього живе у вкладці «Архів».
  const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  assert.match(routes, /writtenOffNos/, "🔴 роут розкриття більше не ховає списані рахунки");
  assert.match(routes, /\.filter\(\(x\) => !writtenOffNos\.has/,
    "🔴 списані рахунки знову їдуть у розкриття активної дебіторки");

  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const tiles = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesTiles.tsx"), "utf8"));
  assert.ok(!/writtenOffLabel/.test(sec), "🔴 слід списання повернувся в рядок клієнта");
  assert.ok(!/writtenOffLabel/.test(tiles), "🔴 слід списання повернувся в плитку боргу");

  // 🪞 ДЗЕРКАЛО: борг НЕ зник з обліку — він у вкладці «Архів», і вкладка є.
  assert.match(sec, /<ReceivablesArchive/, "🔴 вкладки «Архів» немає — борг зник би БЕЗ СЛІДУ, а це вже втрата");
  assert.match(sec, /role="tablist"/, "🔴 зникли вкладки — архів нема як відкрити");
  const arch = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesArchive.tsx"), "utf8"));
  for (const col of ["Клієнт", "Рахунок №", "Сума", "Списав", "Коли", "Причина", "Повернути в активні"]) {
    assert.ok(arch.includes(col), `🔴 в архіві немає колонки «${col}» — журнал неповний`);
  }
  // Дія оборотна ТИМ САМИМ інтерфейсом (правило власника 06.08.2026).
  assert.match(arch, /revokeReceivableWriteoff/, "🔴 з архіву не можна повернути борг — незворотна кнопка на грошах");
  assert.match(arch, /d\.canWriteOff &&/, "🔴 кнопка повернення показується без права — «є, але дає 403»");
});

test("#199aa предикат ВИКОНУЄТЬСЯ проти БД і справді виключає — на власній фікстурі", needsDb(), async (t) => {
  // 🔴 ЦЕЙ ГЕЙТ ІСНУЄ ТОМУ, ЩО РЕШТА #199* — ПЕРЕВІРКИ РЯДКА, А НЕ ПОВЕДІНКИ.
  //
  // Заміряно на проді 26.08.2026, і число незручне: угод, у яких списані ВСІ
  // рахунки, — **нуль**. Єдине живе списання (28 000 ₴, УКРЕНЕРГО-АЛЬЯНС) стоїть
  // на рахунку з `service_url IS NULL` — саме тому, що він, словами власника,
  // «виставлений не через срм». Отже предикат на проді не спрацьовує НІ РАЗУ,
  // і golden-master «12 функцій, 0 розбіжностей» доводить лише те, що SQL
  // ПАРСИТЬСЯ. Про те, що він щось виключає, він не свідчить нічого.
  //
  // Це рівно «порожній результат = провал, а не успіх»: перевірка мовчить, бо
  // їй не було що знаходити. Тому механізм — на ВЛАСНІЙ фікстурі (рецепт #220),
  // де випадок сконструйовано, а не виловлено з живих даних.
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { DEAL_NOT_WRITTEN_OFF, FULLY_WRITTEN_OFF_DEALS, WRITTEN_OFF_STILL_IN_ZONE } =
    await import("./writeoffScope.js");
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SRC("db/schema.sql"), "utf8"));
    const K = "фікстура";
    const inv = (no: string, deal: string | null) =>
      c.query(`INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, invoice_no, amount, service_url)
               VALUES ($1,$1,'Ф',$2,100,$3)`,
        [K, no, deal === null ? null : `https://x.kommo.com/leads/detail/${deal}`]);
    const off = (no: string) =>
      c.query(`INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note)
               VALUES ($1,$2,100,'фікстура')`, [K, no]);
    // 111 — ДВА рахунки (саме на цьому перевіряється «ВСІ, а не один»);
    // 222 — один; 333 — один, чистий; 444 — рахунок БЕЗ угоди, як на проді.
    await inv("i1", "111"); await inv("i2", "111"); await inv("i3", "222");
    await inv("i4", "333"); await inv("i5", null);
    for (const [id, st] of [[111, 100274340], [222, 69716312], [333, 69716300], [444, 69716300]] as const)
      await c.query(`INSERT INTO deals (kommo_id, pipeline_id, status_id, price) VALUES ($1,8921932,$2,1000)`, [id, st]);
    const excluded = async () => (await c.query<{ deal_id: string }>(FULLY_WRITTEN_OFF_DEALS))
      .rows.map((r) => Number(r.deal_id)).sort((a, b) => a - b);
    const zone = async () => (await c.query<{ c: number; s: number }>(
      `SELECT count(*)::int c, COALESCE(sum(d.price),0)::float s FROM deals d
        WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2) AND ${DEAL_NOT_WRITTEN_OFF}`,
      [[8921932, 155304], [100274340, 69716312, 69716300]])).rows[0];

    // ① Нічого не списано — предикат не виключає нікого.
    assert.deepEqual(await excluded(), [], "🔴 без жодного списання предикат уже когось виключає");
    assert.equal((await zone()).c, 4, "🔴 предикат ріже угоди на порожньому журналі списань");

    // ② Списано ОДИН із двох рахунків угоди 111 — угода лишається.
    await off("i1");
    assert.deepEqual(await excluded(), [],
      "🔴 досить одного списаного рахунку — списання копійки вимикало б усю угоду");
    assert.equal((await zone()).c, 4, "🔴 угода вийшла з очікуваних за одним списаним рахунком з двох");

    // ③ Списано ДРУГИЙ — тепер угода 111 виключається, і саме вона.
    await off("i2");
    assert.deepEqual(await excluded(), [111],
      "🔴 усі рахунки угоди списані, а предикат її не виключає — механізм мертвий");
    const z3 = await zone();
    assert.equal(z3.c, 3, "🔴 очікувані не зменшились після списання ВСІХ рахунків угоди");
    assert.equal(z3.s, 3000, "🔴 з очікуваних пішла не та сума — вийшла не одна угода");

    // ④ Рахунок БЕЗ угоди (`service_url IS NULL`) — саме прод-випадок. Списання
    //    такого рахунка не має виключати НІЧОГО і не має валити запит: без
    //    `deal_id IS NOT NULL` він дав би NULL-рядок у вибірці.
    await off("i5");
    assert.deepEqual(await excluded(), [111],
      "🔴 списання рахунка без лінка на угоду зачепило чужі угоди");

    // ⑤ Скасування повертає угоду в очікувані — байт-у-байт до стану ②.
    await c.query(`UPDATE receivable_writeoffs SET revoked_at = now() WHERE invoice_no = 'i2'`);
    assert.deepEqual(await excluded(), [],
      "🔴 скасоване списання й далі тримає угоду поза очікуваними — гроші не повернулись");
    assert.equal((await zone()).c, 4, "🔴 скасування не повернуло угоду в очікувані");

    // ⑥ Лічильник розбіжності рахує ТУ САМУ множину, що виключає предикат.
    await c.query(`UPDATE receivable_writeoffs SET revoked_at = NULL WHERE invoice_no = 'i2'`);
    const div = (await c.query<{ deals: number; amount: number }>(
      WRITTEN_OFF_STILL_IN_ZONE, [[8921932, 155304], [100274340, 69716312, 69716300]])).rows[0];
    assert.equal(div.deals, 1, "🔴 лічильник розбіжності не бачить виключеної угоди — розбіжність стала тихою");
    assert.equal(div.amount, 1000, "🔴 лічильник називає не ту суму, що пішла з очікуваних");

    // ⑦ Σ ПО МЕНЕДЖЕРАХ == КОМАНДА == КОМПАНІЯ, ПІСЛЯ СПИСАННЯ (вимога власника).
    //
    // 🔴 ЖИВІ ДАНІ ЦЬОГО НЕ ПОКАЗУЮТЬ І НЕ ПОКАЖУТЬ: на проді 26.08.2026 угод із
    // повністю списаними рахунками НУЛЬ, тож «до» і «після» там байт-у-байт
    // однакові (заміряно старим і новим `dist` — 0 розбіжностей у трьох пулах).
    // Рівність на живих даних тримається, але вона тримається й на зламаному
    // предикаті — тобто доводить рівно нічого. Тут випадок сконструйовано.
    //
    // ⚠️ Три зерна (компанія / команда / менеджер) — це і є предмет перевірки,
    // тож GROUP BY у тесті свій. Ліворуч у КОЖНОМУ з них стоїть ПРОДАКШН-вираз
    // `DEAL_NOT_WRITTEN_OFF`, а не переписаний «схоже»: інакше гейт порівнював би
    // дві копії, написані поруч (урок `#214c`).
    await c.query(`INSERT INTO teams (id, name) VALUES (900, 'Ф') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, kommo_user_id, name, team_id, is_active)
                   VALUES (901, 9901, 'М1', 900, true), (902, 9902, 'М2', 900, true)
                   ON CONFLICT DO NOTHING`);
    await c.query(`UPDATE deals SET manager_id = CASE WHEN kommo_id IN (111,222) THEN 901 ELSE 902 END`);
    const ZONE = [100274340, 69716312, 69716300];
    const grain = async (extra: string, group: string) => (await c.query<Record<string, string>>(
      `SELECT ${extra} FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
        WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2) AND ${DEAL_NOT_WRITTEN_OFF} ${group}`,
      [[8921932, 155304], ZONE])).rows;
    const company = Number((await grain("COALESCE(SUM(d.price),0) AS revenue", ""))[0].revenue);
    const byTeam = (await grain("m.team_id, COALESCE(SUM(d.price),0) AS revenue", "GROUP BY m.team_id"))
      .reduce((a, x) => a + Number(x.revenue), 0);
    const byMgr = (await grain("m.id, COALESCE(SUM(d.price),0) AS revenue", "GROUP BY m.id"))
      .reduce((a, x) => a + Number(x.revenue), 0);
    assert.equal(company, byTeam, "🔴 Σ команд ≠ компанії ПІСЛЯ списання — предикат ріже зерна по-різному");
    assert.equal(company, byMgr, "🔴 Σ менеджерів ≠ компанії ПІСЛЯ списання");
    // І це НЕ вироджена рівність «0 == 0»: списана угода 111 (1000 ₴) вийшла,
    // решта лишилась. Без цієї перевірки гейт зеленів би на предикаті, що ріже все.
    assert.equal(company, 3000,
      `🔴 після списання лишилось ${company} ₴ замість 3000 — або не вийшла та угода, або вийшли зайві`);
  } finally { await c.end(); scratch.dispose(); }
});

test("#199ab архів: сума ТОЧНА, і колонки мають власні відступи", () => {
  // 🔴 ОБИДВІ ПРАВКИ ЗНАЙШЛО ОКО В БРАУЗЕРІ, А НЕ ГЕЙТ — і це чесна межа: жодна
  // перевірка не дивиться, чи сусідні колонки не злиплись. Записую їх РІШЕННЯМИ,
  // щоб наступний прохід не «спростив» назад.
  //
  // (а) Базовий `.data-table th/td` має горизонтальний падінг НУЛЬ. На інших
  //     екранах не видно, тут правовирівняна «Сума» торкалась лівовирівняного
  //     «Списав»: шапка читалась «СумаСписав», клітинка — «28тис ₴utservice3@…».
  //     Скоуповано класом; глобальний `.data-table` не чіпаємо — він під усіма
  //     таблицями продукту.
  // (б) Сума в рядку реєстру — ТОЧНА. «28тис ₴» однаково читається для 28 000
  //     і 28 400, тобто ховає саме те, за що людина відповідає підписом.
  //     Плитка згори лишається скороченою: вона про порядок величини.
  const arch = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesArchive.tsx"), "utf8"));
  const css = readFileSync(FE("index.css"), "utf8");

  assert.match(arch, /className="data-table recv-archive"/,
    "🔴 таблиця архіву втратила власний скоуп — колонки знову зліпляться");
  assert.match(css, /\.recv-archive th,\s*\n\.recv-archive td\s*\{[^}]*padding-left/,
    "🔴 зникло правило відступів архіву — «Сума» знову торкнеться «Списав»");

  // Рядок і підсумок реєстру — ТОЧНА сума. Дозволяємо `formatAmount` лише в плитках.
  const body = arch.slice(arch.indexOf("<tbody>"));
  assert.ok(!/\{formatAmount\(/.test(body),
    "🔴 у реєстрі повернулась скорочена сума — «28тис ₴» ховає, за що саме підписалась людина");
  assert.match(body, /formatAmountFull\(w\.amount\)/, "🔴 рядок архіву більше не показує точну суму");
  assert.match(body, /formatAmountFull\(t\.amount\)/, "🔴 підсумок архіву більше не показує точну суму");

  // 🪞 ДЗЕРКАЛО: плитки СКОРОЧУЮТЬ — інакше «точно скрізь» перетворило б
  // заголовок плитки на 9 цифр і зламало б верхній ряд.
  const tiles = arch.slice(0, arch.indexOf("<tbody>"));
  assert.match(tiles, /formatAmount\(/, "🔴 плитки архіву перейшли на повний формат — верхній ряд розповзеться");
});

/**
 * 🔎 МЕХАНІЧНИЙ ПЕРЕБІР ФУНКЦІЙ ОЧІКУВАНИХ ГРОШЕЙ.
 *
 * КРИТЕРІЙ СЛОВАМИ, щоб наступний не реконструював його з регулярки:
 * функція вважається такою, що рахує очікувані гроші, якщо вона
 *   (а) експортована з `core/metrics.ts` або `core/money.ts`, І
 *   (б) у СВОЄМУ КОДІ (не в коментарі) звʼязує хоч одну константу зони
 *       очікування: `EXPECT_ZONE` · `STAGE_EXPECTED` · `CHAIN_INFLIGHT`.
 *
 * Три константи, а не одна, бо зона записана в продукті трьома різними
 * виразами — і саме тому критерій «шукати EXPECT_ZONE» був би дірявим:
 * `awaitingNowSnapshot` бере `[...STAGE_EXPECTED, ...STAGE_PAID]` і в такий
 * перебір не потрапила б.
 *
 * 🔴 РІЗАТИ ТІЛА ТРЕБА ПО `^export ` БУДЬ-ЯКОГО ВИДУ, А НЕ ПО `export function`.
 * Перша редакція різала лише по функціях — і тіло `responseTime` проковтнуло
 * оголошення `export const EXPECT_ZONE`, що лежить нижче. Перебір бадьоро
 * доповів про функцію очікуваних, якої не існує. Той самий клас, що «порожній
 * результат = успіх», тільки навиворіт: зайва знахідка замість зниклої.
 */
const EXPECTED_MONEY_ZONES = ["EXPECT_ZONE", "STAGE_EXPECTED", "CHAIN_INFLIGHT"] as const;

/**
 * Функції, що ПРОХОДЯТЬ критерій, але предиката НЕ мають — і це рішення, а не
 * недогляд. Реєстр не «ковдра»: дзеркало нижче вимагає, щоб кожен запис справді
 * існував і справді був без предиката, інакше мертвий рядок глушив би справжню
 * знахідку.
 */
const EXPECTED_MONEY_NO_PREDICATE: { name: string; why: string }[] = [
  // 🟢 ПОРОЖНІЙ — І ЦЕ РЕЗУЛЬТАТ, А НЕ ЗАБУТИЙ РЕЄСТР. Три розрізи чека
  // (`avgCheck`, `avgCheckByTeam`, `avgCheckPerManager`) лежали тут як ВІДКРИТЕ
  // ПИТАННЯ; власник закрив його 26.08.2026 словами «вона зникає з усіх етапів
  // і екранів у дашборді» — тобто зі знаменника очікуваного чека теж.
  // Предикат поставлено в ОДИН спільний `snapshotBy`, крізь який ходять усі
  // три, тож рівність Σ(менеджери) == команда == компанія тримається за
  // побудовою. Реєстр лишається жити для наступного випадку.
];

/**
 * Функції, що предикат МАЮТЬ, але під критерій не підпадають — тобто перебір
 * їх не стереже, і стереже лише поіменний гейт. Записані, щоб було видно межу
 * механічного перебору, а не щоб її замовчати.
 */
const EXPECTED_MONEY_OUTSIDE_CRITERION: { name: string; why: string }[] = [
  { name: "repeatForecastByManager", why: "фільтрує `status_id = 142` (історія виграних), а не зону очікування — це ПРОГНОЗ на історичній базі. Внести 142 в критерій означало б затягнути в перебір усі функції виручки" },
];

function enumerateExpectedMoneyFns(read: (p: string) => string) {
  const out: { file: string; name: string; zones: string[]; hasPredicate: boolean; via: string | null }[] = [];
  for (const f of ["core/metrics.ts", "core/money.ts"]) {
    const s = read(f);
    // Тіла ВСІХ функцій файла, включно з НЕекспортованими: предикат може жити в
    // спільному хелпері, і саме так воно й правильно.
    const heads = [...s.matchAll(/^(?:export )?(?:async )?(?:function|const|interface|type) (\w+)/gm)];
    const bodies = new Map<string, string>();
    /** Кандидатом є лише ЕКСПОРТОВАНА функція: хелпери всередині модуля — це
     *  реалізація, і вимагати предикат від кожного означало б вимагати копій. */
    const isCandidate = new Map<string, boolean>();
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].index!;
      const end = i + 1 < heads.length ? heads[i + 1].index! : s.length;
      const raw = s.slice(start, end);
      bodies.set(heads[i][1], raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""));
      isCandidate.set(heads[i][1], /^export (?:async )?function/.test(raw));
    }
    /**
     * Предикат зараховується, якщо він у САМІЙ функції АБО в локальному хелпері,
     * який вона кличе (глибина 2). Інакше гейт вимагав би КОПІЇ правила в кожній
     * функції — тобто карав би саме ту архітектуру, до якої ми йдемо.
     */
    const covered = (name: string, depth = 0): string | null => {
      const body = bodies.get(name);
      if (body == null || depth > 2) return null;
      if (/\bDEAL_NOT_WRITTEN_OFF\b/.test(body)) return depth === 0 ? name : name;
      for (const m of body.matchAll(/\b(\w+)\s*\(/g)) {
        const callee = m[1];
        if (callee === name || !bodies.has(callee)) continue;
        const hit = covered(callee, depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    for (const [name, body] of bodies) {
      if (!isCandidate.get(name)) continue;
      const zones = EXPECTED_MONEY_ZONES.filter((z) => new RegExp(`\\b${z}\\b`).test(body));
      if (!zones.length) continue;
      const via = covered(name);
      out.push({ file: f, name, zones, hasPredicate: via != null, via: via === name ? null : via });
    }
  }
  return out;
}

test("#199ac перелічувач: КОЖНА функція очікуваних має предикат — включно з ненаписаною", () => {
  // 🔴 НАВІЩО ЦЕ ПОВЕРХ ДВАНАДЦЯТИ ПОІМЕННИХ ГЕЙТІВ. Перелік місць, куди треба
  // вставити правило, я отримав ПРИГАДУВАННЯМ і дістав 5 із 12; механічний
  // перебір дав 12. Дванадцять поіменних гейтів не бачать ТРИНАДЦЯТОЇ функції:
  // завтра хтось додає `expectedSomethingNew`, предиката в ній немає, гейта на
  // неї немає, і жоден із дванадцяти не почервоніє.
  const found = enumerateExpectedMoneyFns((p) => readFileSync(SRC(p), "utf8"));

  // Порожній перебір = провал, а не успіх: спершу доводимо, що йому БУЛО що знайти.
  assert.ok(found.length >= 12,
    `🔴 перебір знайшов лише ${found.length} функцій — критерій розсипався, і мовчазне «усе гаразд» тут означає, що не перевірено НІЧОГО`);

  const allowed = new Set(EXPECTED_MONEY_NO_PREDICATE.map((x) => x.name));
  const guilty = found.filter((f) => !f.hasPredicate && !allowed.has(f.name));
  assert.deepEqual(guilty.map((f) => `${f.file}:${f.name}`), [],
    `🔴 функція рахує очікувані гроші (зона ${guilty.map((f) => f.zones.join("+")).join(", ")}), але списаний борг із неї НЕ виключено. `
    + `Або постав ${"DEAL_NOT_WRITTEN_OFF"}, або внеси у EXPECTED_MONEY_NO_PREDICATE з поясненням ЧОМУ.`);

  // 🪞 РЕЄСТР НЕ СМІТНИК (обидва). Мертвий запис глушив би справжню знахідку.
  for (const e of EXPECTED_MONEY_NO_PREDICATE) {
    const hit = found.find((f) => f.name === e.name);
    assert.ok(hit, `🔴 «${e.name}» у реєстрі винятків, але перебір її не бачить — запис протух`);
    assert.ok(!hit!.hasPredicate,
      `🔴 «${e.name}» уже МАЄ предикат, а лежить у винятках — прибери з реєстру, інакше він накриє наступну справжню дірку`);
    assert.ok(e.why.length > 40, `🔴 виняток «${e.name}» без пояснення — через місяць його не відрізнити від помилки`);
  }
  const metrics = readFileSync(SRC("core/metrics.ts"), "utf8");
  const money = readFileSync(SRC("core/money.ts"), "utf8");
  for (const e of EXPECTED_MONEY_OUTSIDE_CRITERION) {
    const src = new RegExp(`export (?:async )?function ${e.name}\\b`).test(metrics) ? metrics : money;
    assert.match(src, new RegExp(`export (?:async )?function ${e.name}\\b`),
      `🔴 «${e.name}» зникла — запис у реєстрі поза критерієм протух`);
    const body = src.slice(src.search(new RegExp(`export (?:async )?function ${e.name}\\b`)));
    assert.match(body.slice(0, 4000), /DEAL_NOT_WRITTEN_OFF/,
      `🔴 «${e.name}» втратила предикат, а механічний перебір її НЕ СТЕРЕЖЕ — саме тому вона тут і записана`);
  }
});

test("#199ad кнопка «історія» має зону натискання не менше 32×32", () => {
  // 🔴 ЧЕСНА МЕЖА ЦЬОГО ГЕЙТА, НАЗВАНА ПЕРШИМ РЯДКОМ: він читає ДЖЕРЕЛО, а
  // піксель бачить лише екран. Справжній замір зроблено `boundingBox()` у
  // браузері: ДО правки **56×17**, після — **68×33**, рядок клієнта 140→150.
  // Гейт стереже стилі, З ЯКИХ це число виходить, а не саме число — і якщо
  // завтра їх перекриє зовнішній CSS, він цього не побачить. Тому в приймання
  // лишається погляд на екран, а не «гейт зелений».
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const i = sec.indexOf("setHistoryFor(c.clientKey)");
  assert.ok(i > 0, "🔴 кнопка «історія» зникла — перевіряти нема чого");
  const btn = sec.slice(i, i + 900);

  for (const [prop, min] of [["minWidth", 32], ["minHeight", 32]] as const) {
    const m = new RegExp(`${prop}:\\s*(\\d+)`).exec(btn);
    assert.ok(m, `🔴 у кнопки «історія» немає ${prop} — зона натискання знову стиснеться до тексту (було 56×17)`);
    assert.ok(Number(m![1]) >= min,
      `🔴 ${prop} = ${m![1]} < ${min}: у кнопку треба цілитись, а вона відкриває журнал домовленостей`);
  }
  // Падінг обовʼязковий разом із min-розміром: без нього inline-текст лишається
  // приліплений до сусідів, і «32 пікселі» дістаються за рахунок порожнечі збоку.
  assert.match(btn, /padding:\s*"\d+px \d+px"/, "🔴 зник падінг — текст знову зліпиться із сусідніми контролами");
  assert.match(btn, /display:\s*"inline-flex"/,
    "🔴 без inline-flex min-height у інлайновій кнопці не працює — вона лишиться 17px заввишки, а гейт зеленів би");

  // 🪞 ДЗЕРКАЛО: кнопка й далі ЧИТАЄТЬСЯ як посилання, а не як панель. Виросла
  // площа влучання, не вигляд — інакше «полагодили» перетворилось би на нову
  // кнопку в кожному з 74 рядків.
  assert.match(btn, /textDecoration:\s*"underline dotted"/, "🔴 кнопка перестала читатись як посилання");
  assert.match(btn, /aria-label=/, "🔴 зник aria-label — з клавіатури й читалкою «історія · 1» не пояснює, чия саме");
});

test("#199ae відсутнє поле CRM не стає нулем — «не знаємо» і «нуль» різні", async () => {
  // 🔴 НАЙШКІДЛИВІША ЗНАХІДКА НІЧНОГО АУДИТУ, І ШКОДА В ТОМУ, ЩО ВОНА НЕОБОРОТНА.
  //
  // `Number(fieldText(…) ?? "")` дає `Number("")` → **0**, а `Number.isFinite(0)`
  // істинне. Нуль тут ЛЕГІТИМНИЙ («перевізник наш, платити нікому»), тож після
  // запису «поля немає» і «нуль» — одне значення в базі, і ре-бекфіл їх уже НЕ
  // РОЗРІЗНИТЬ: ознаки, з якого боку прийшов нуль, не лишилось. Псування йшло
  // по колу разом із `syncKommo` кожні 30 хв.
  //
  // 📐 Заміряно на проді 26.08.2026 ДО правки: 11 699 нулів проти 1 193 додатних;
  // за серпень нулів 5 754 з 8 672 угод. Це не крайній випадок, а норма.
  //
  // ⚠️ ПЕРЕВІРЯЄТЬСЯ ПОВЕДІНКОЮ ЧИСТОЇ ФУНКЦІЇ, а не текстом екстрактора:
  // текстовий гейт зеленів би на будь-якому переписуванні того самого дефекту.
  const { carrierObligationFrom, clientPaymentFrom } = await import("./carrierPayment.js");

  // ① Поля немає → null. ② Порожнє → null. ③ Сміття → null. Жодного нуля.
  assert.equal(carrierObligationFrom(null), null,
    "🔴 відсутнє поле знову стає числом — «не знаємо» пишеться в базу як факт");
  assert.equal(carrierObligationFrom(undefined), null, "🔴 undefined став нулем");
  assert.equal(carrierObligationFrom(""), null, "🔴 порожнє значення стало нулем");
  assert.equal(carrierObligationFrom("   "), null, "🔴 пробіли стали нулем");
  assert.equal(carrierObligationFrom("абв"), null,
    "🔴 нечислове стало нулем — помилка заповнення читалась би як рішення «не платити»");

  // 🪞 ДЗЕРКАЛО, БЕЗ ЯКОГО ФІКС МІГ БИ ПРОСТО ВИМКНУТИ ПОЛЕ: справжній нуль і
  // справжнє число мусять доходити. Односторонній гейт зеленів би й на
  // `return null` завжди.
  assert.equal(carrierObligationFrom("0"), 0,
    "🔴 СПРАВЖНІЙ нуль перестав доходити — фікс перетворився на вимкнення поля");
  assert.equal(carrierObligationFrom("12000"), 12000, "🔴 звичайне число не доходить");
  assert.equal(carrierObligationFrom("-500"), -500,
    "🔴 відʼємне (сторно) не доходить — знак у цьому продукті значущий");

  // ⚠️ СУСІД УЦІЛІВ ВИПАДКОВО, І ЦЕ ЗАФІКСОВАНО, А НЕ ВЗЯТО ЗА ЗРАЗОК.
  // `clientPaymentFrom` відкидає нуль не заради «не знаємо», а тому що
  // нуль-знаменник маржі непридатний. Наслідок збігається, підстава інша —
  // тож у нього поведінка на нулі СВОЯ, і міняти її «за компанію» не можна.
  assert.equal(clientPaymentFrom(null), null, "🔴 знаменник маржі почав приходити нулем");
  assert.equal(clientPaymentFrom("0"), null,
    "🔴 у знаменника змінилась поведінка на нулі — це окреме рішення, не побічний ефект");
  assert.equal(clientPaymentFrom("1000"), 1000, "🔴 знаменник не доходить");

  // 🔗 І ЕКСТРАКТОР МУСИТЬ КЛИКАТИ САМЕ ЦЕ ПРАВИЛО, а не мати власну копію:
  // інакше чиста функція лишиться зеленою, а в базу писатиме друга реалізація.
  const cli = readFileSync(SRC("kommo/client.ts"), "utf8");
  assert.match(cli, /return carrierObligationFrom\(fieldText\(deal, CARRIER_OBLIGATION_FIELD\)\)/,
    "🔴 екстрактор перестав делегувати правилу — зʼявилась друга копія, і вона розійдеться");
  assert.match(cli, /return clientPaymentFrom\(fieldText\(deal, CLIENT_PAY_FIELD\)\)/,
    "🔴 знаменник маржі теж обзавівся власною копією правила");
});

test("#199af підказки маржі: копія фронта == копії ядра, ключ у ключ", async () => {
  // 🔴 ЗНАХІДКА НІЧНОГО АУДИТУ, І ВОНА ПРО КЛАС, А НЕ ПРО ЦІ ДВА РЯДКИ.
  //
  // `MARGIN_UNKNOWN_LABEL` існує ДВІЧІ — у ядрі й у фронті, з однаковим текстом.
  // Гейти читали копію БЕКЕНДУ. Саботаж «поміняти місцями `no_deal` і `no_base`
  // У ФРОНТІ» лишав УСІ гейти зеленими, а екран починав пояснювати навпаки:
  // «немає звʼязку з угодою» там, де звʼязок є, і навпаки. Людину послали б
  // шукати не те.
  //
  // 📐 Перевірено грепом по ЗІБРАНОМУ БАНДЛУ, а не по джерелу: обидва рядки
  // там є (по одному входженню), тобто копія фронта ЖИВА і саме вона на екрані.
  // Греп по ІМЕНІ константи в мініфікованому бандлі не доводить нічого —
  // ідентифікатори перейменовані; переживають мініфікацію лише літерали.
  const core = await import("./receivablesMargin.js");
  const fe = await import(FE_SPEC("pages/dashboard/receivablesView.ts"));

  const a = core.MARGIN_UNKNOWN_LABEL as Record<string, string>;
  const b = fe.MARGIN_UNKNOWN_LABEL as Record<string, string>;
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(),
    "🔴 набір причин розійшовся — у фронта зʼявилась або зникла причина, якої ядро не знає");
  for (const k of Object.keys(a)) {
    assert.equal(b[k], a[k],
      `🔴 причина «${k}»: фронт каже «${b[k]}», ядро — «${a[k]}». Підказка на екрані пояснює НЕ ТЕ, `
      + "і жоден гейт, що читає ядро, цього не побачить");
  }
  // Порожній набір = провал: `deepEqual({}, {})` істинний, і гейт мовчав би.
  assert.ok(Object.keys(a).length >= 2,
    `🔴 у ядрі лишилось ${Object.keys(a).length} причин — порівнювати нема чого, а зелений колір це ховає`);
});

test("#199ap факт за виграну угоду НЕ зменшується заднім числом", async () => {
  // 🔴 ПРАВИЛО ВЛАСНИКА 26.08.2026, ДОСЛІВНО: «Ні, факт лишається.»
  //
  // Питання ставилось прямо: чи зменшується заднім числом факт менеджера за
  // виграну угоду, якщо борг по ній списали. За відповіддю стоять закриті
  // місяці, KPI й уже виплачені премії.
  //
  // Гейт існує проти ОДНІЄЇ конкретної помилки, і вона правдоподібна: рішення
  // про списання звучить «вона зникає з усіх етапів і екранів у дашборді».
  // Прочитавши це без контексту, наступний розширить предикат на пул `success`
  // (142) і вважатиме, що доробляє незакінчене. Наслідок — зрушений факт Звіту,
  // «Виконано плану» і премії за вже закриті місяці.
  const money = readFileSync(SRC("core/money.ts"), "utf8");

  // ① Правило записане поруч із предикатом — саме там, де його прочитають.
  const i = money.indexOf("DEAL_NOT_WRITTEN_OFF,");
  assert.ok(i > 0, "🔴 предикат зник зі спільного знімка");
  const around = money.slice(Math.max(0, i - 2200), i);
  assert.match(around, /Ні, факт лишається/,
    "🔴 зникла дослівна відповідь власника — лишилось «зникає з усіх екранів», і наступний розширить предикат");
  assert.match(around, /закрит[іи] місяц|прем/i,
    "🔴 зникла ПРИЧИНА (закриті місяці, премії) — правило без причини скасовують першим");

  // ② `successAggActive` / `agg("success", …)` предиката НЕ несуть.
  const succ = money.slice(money.indexOf("const successAggActive"), money.indexOf("const successAggActive") + 400);
  assert.ok(!/DEAL_NOT_WRITTEN_OFF/.test(succ),
    "🔴 предикат заїхав у пул `success` — факт за виграну угоду почав зменшуватись заднім числом");

  // ③ І в самому `agg` теж — це спільне ядро грошей, звідки живиться Звіт.
  const aggSrc = money.slice(money.indexOf("async function agg("), money.indexOf("async function agg(") + 1400);
  assert.ok(!/DEAL_NOT_WRITTEN_OFF/.test(aggSrc),
    "🔴 предикат у `agg` — зрушаться successMoney, successByMgr, successByTeam, тобто факт Звіту й «Виконано плану»");

  // 🪞 ДЗЕРКАЛО: предикат ПРИСУТНІЙ там, де має бути. Без нього гейт зеленів би
  // і на коді, з якого предикат прибрали ЗОВСІМ.
  assert.match(money, /DEAL_NOT_WRITTEN_OFF/,
    "🔴 предиката немає ніде — списане повернулось в очікувані");
});

test("#199aq ліміт суми має ТРИ стани, і «не ставили» ≠ «відмовили» ≠ 0", async () => {
  // 🔴 ПАСТКА, ЯКУ ВЛАСНИК ВИМАГАВ ЗАКРИТИ ЗА ПОБУДОВОЮ. Колонка нова, отже в
  // момент викату вона порожня в УСІХ клієнтів. Пара станів «у межах /
  // переліміт» збрехала б 77 разів поспіль: `NULL` став би нулем, і кожен
  // боржник — перелімітником.
  //
  // 📐 Прецедент поруч, на живих даних 26.08.2026: у ДНЯХ «порожньо» — це вже
  // 61% (47 не ставили + 8 відмовили з 77 боржників). Тобто третій стан там не
  // теоретичний, а більшість — і в сумі буде так само.
  const { amountLimitState, amountLimitLabel, amountLimitHint, isOverAmount, splitOverAmount } =
    await import("./creditLimits.js");

  assert.equal(amountLimitState(null), "never-set", "🔴 NULL перестав бути окремим станом");
  assert.equal(amountLimitState(undefined), "never-set", "🔴 undefined читається не як «не ставили»");
  assert.equal(amountLimitState(0), "declined", "🔴 нуль перестав означати «розглянули і не дали»");
  assert.equal(amountLimitState(50000), "agreed");

  // 🔴 NULL-ПАСТКА: `Number(null) === 0` істинне. Наївне порівняння зробило б
  // «відмовлено» ВСІМ, кому суму просто не ставили. У днях це вже коштувало
  // заміру (54 замість 9); тут ціна вища — всі 77.
  assert.notEqual(amountLimitState(null), amountLimitState(0),
    "🔴 «не ставили» і «відмовили» злились — це різні відповіді на питання ЧОМУ");

  // Підписи: «0 ₴» на екрані читається як помилка заповнення, тому його немає.
  assert.equal(amountLimitLabel(null), "не узгоджено");
  assert.equal(amountLimitLabel(0), "не узгоджено");
  assert.ok(!/^0/.test(amountLimitLabel(0)), "🔴 нуль друкується числом");
  assert.match(amountLimitLabel(50000), /50\s*000/, "🔴 узгоджена сума не показується числом");
  // А ось ПІДКАЗКИ мусять розрізняти — саме там живе «чому».
  assert.notEqual(amountLimitHint(null), amountLimitHint(0),
    "🔴 підказка однакова для «не дивились» і «подивились і відмовили»");

  // Неузгоджений = нульовий (одне правило на обидва ліміти, рішення 26.08.2026).
  assert.equal(isOverAmount(1, null), true, "🔴 без ліміту борг перестав вважатись перевищенням");
  assert.equal(isOverAmount(1, 0), true);
  assert.equal(isOverAmount(0, null), false, "🔴 нульовий борг став перевищенням");
  // Строго БІЛЬШЕ: борг, що дорівнює ліміту, — це межа, а не перехід.
  assert.equal(isOverAmount(50000, 50000), false, "🔴 борг РІВНО на ліміт зарахований як перевищення");
  assert.equal(isOverAmount(50001, 50000), true);
  assert.equal(isOverAmount(null, 50000), false, "🔴 невідомий борг став перевищенням");

  // 🔴 РОЗКЛАД ОБОВʼЯЗКОВИЙ. Без нього перше відкриття після викату покаже
  // «77 перелімітників» — правду, яка бреше.
  const split = splitOverAmount([
    { debt: 100, limitAmount: null }, { debt: 100, limitAmount: 0 },
    { debt: 200, limitAmount: 50 }, { debt: 10, limitAmount: 50 },
  ]);
  assert.equal(split.total, 3);
  assert.equal(split.beyondAgreed, 1, "🔴 перейшли УЗГОДЖЕНУ суму пораховані невірно");
  assert.equal(split.noLimitAgreed, 2, "🔴 «ліміту не узгоджено» злилось із класичним перевищенням");
  assert.equal(split.total, split.beyondAgreed + split.noLimitAgreed, "🔴 розклад не сходиться з числом");
});

test("#199ar ліміти днів і суми НЕЗАЛЕЖНІ — усі чотири комбінації", async () => {
  // 🔴 НЕЗАЛЕЖНІСТЬ — ЧАСТИНА ПРАВИЛА, А НЕ НАСЛІДОК (рішення власника
  // 26.08.2026). Клієнт може порушити один ліміт, обидва або жоден.
  const { isOverdue, isOverAmount } = await import("./creditLimits.js");
  const cases = [
    { назва: "жоден", age: 5, days: 30, debt: 100, amount: 50000, дні: false, сума: false },
    { назва: "лише дні", age: 40, days: 30, debt: 100, amount: 50000, дні: true, сума: false },
    { назва: "лише сума", age: 5, days: 30, debt: 90000, amount: 50000, дні: false, сума: true },
    { назва: "обидва", age: 40, days: 30, debt: 90000, amount: 50000, дні: true, сума: true },
  ];
  for (const c of cases) {
    assert.equal(isOverdue(c.age, c.days), c.дні, `🔴 «${c.назва}»: денний ліміт спрацював не так`);
    assert.equal(isOverAmount(c.debt, c.amount), c.сума, `🔴 «${c.назва}»: ліміт суми спрацював не так`);
  }
  // 🔴 І ГОЛОВНЕ — ОДИН НЕ ЗАЛЕЖИТЬ ВІД ДРУГОГО СТРУКТУРНО, а не за збігом:
  // функція суми не приймає `limitDays` навіть аргументом, тож написати
  // залежність випадково неможливо. Перевіряємо саме сигнатуру.
  assert.equal(isOverAmount.length, 2,
    "🔴 у `isOverAmount` зʼявився третій аргумент — найімовірніше `limitDays`, і це вже залежність");
  assert.equal(isOverdue.length, 2, "🔴 у `isOverdue` змінилась сигнатура");

  // Дзеркало: сума працює й тоді, коли ДНІВ немає зовсім (саме заради цього
  // знімався `NOT NULL` з `limit_days`).
  assert.equal(isOverAmount(90000, 50000), true, "🔴 без денного ліміту сума перестала рахуватись");
  assert.equal(isOverdue(40, null), true, "🔴 без ліміту суми дні перестали рахуватись");
});

test("#199as заголовок задачі несе КЛІЄНТА і СУМУ — інакше це «дайте ліміт»", async () => {
  // Тімлід читає його в списку своєї команди. Без предмета задачу неможливо
  // виконати, не відкривши її, — а в списку їх десятки.
  const { limitRequestTitle } = await import("./creditLimits.js");
  const t = limitRequestTitle("ПВК АРСЕНАЛ ТОВ", 2_600_000, null);
  assert.match(t, /ПВК АРСЕНАЛ ТОВ/, "🔴 у заголовку немає клієнта");
  assert.match(t, /2\s*600\s*000/, "🔴 у заголовку немає суми боргу");
  assert.match(t, /не встановлено/, "🔴 стан «ліміту немає» не названий — читач вирішить, що ліміт є");
  const t2 = limitRequestTitle("МГЕР", 100, 50000);
  assert.match(t2, /50\s*000/, "🔴 наявний ліміт не показаний — тімлід не бачить, що переглядає");
  assert.ok(!/не встановлено/.test(t2), "🔴 наявний ліміт підписаний як відсутній");
});

test("#199at ліміт суми ПЕРЕЖИВАЄ TRUNCATE синку", needsDb(), async (t) => {
  // 🔴 НАЙТИХІШИЙ ДЕФЕКТ ЦЬОГО ПРОХОДУ, І Я НАЗВАВ ЙОГО САМ У ПЛАНІ.
  // `receivables` TRUNCATE-иться кожні 15 хв. Якби в синк їхав лише
  // `limit_days`, ліміт суми зникав би після КОЖНОГО проходу і зʼявлявся знову
  // при перезаході в редактор — на екрані це читається як «іноді працює», а не
  // як поломка, і ловиться місяцями.
  //
  // Перевіряється на СПРАВЖНІЙ схемі: людське мусить лежати поза синковими
  // таблицями, і саме це тут доводиться, а не «в коді є слово limit_amount».
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SRC("db/schema.sql"), "utf8"));
    await c.query(`INSERT INTO client_credit_limits (client_key, limit_days, limit_amount, note)
                   VALUES ('к', 14, 50000, 'узгоджено'), ('лише-сума', NULL, 30000, 'днів не ставили')`);
    await c.query(`INSERT INTO receivables (client_key, client_name, amount, limit_days, limit_amount)
                   VALUES ('к','К',100,14,50000), ('лише-сума','Л',100,NULL,30000)`);

    // Синк: TRUNCATE + перенесення з людської таблиці.
    await c.query("TRUNCATE receivables");
    const lim = await c.query<{ client_key: string; limit_days: number | null; limit_amount: string | null }>(
      `SELECT client_key, limit_days, limit_amount FROM client_credit_limits`);
    for (const l of lim.rows) {
      await c.query(`INSERT INTO receivables (client_key, client_name, amount, limit_days, limit_amount)
                     VALUES ($1,'X',100,$2,$3)`, [l.client_key, l.limit_days, l.limit_amount]);
    }
    const after = await c.query<{ client_key: string; limit_amount: string | null; limit_days: number | null }>(
      `SELECT client_key, limit_amount, limit_days FROM receivables ORDER BY client_key`);
    const byKey = new Map(after.rows.map((x) => [x.client_key, x]));
    assert.equal(Number(byKey.get("к")!.limit_amount), 50000,
      "🔴 ліміт суми не пережив TRUNCATE — він зникатиме кожні 15 хв і повертатиметься при перезаході");
    assert.equal(byKey.get("к")!.limit_days, 14, "🔴 денний ліміт зламався разом із додаванням суми");

    // 🔴 І САМЕ ЗАРАДИ ЦЬОГО РЯДКА ЗНІМАВСЯ `NOT NULL` З `limit_days`:
    // клієнт може мати ЛИШЕ суму. Якби обмеження лишилось, вставка впала б.
    assert.equal(Number(byKey.get("лише-сума")!.limit_amount), 30000);
    assert.equal(byKey.get("лише-сума")!.limit_days, null,
      "🔴 клієнт із самою лише сумою не існує — `limit_days` знову NOT NULL, і ліміти перестали бути незалежними");

    // 🪞 ДЗЕРКАЛО: сам синк СПРАВДІ переносить обидва — інакше фікстура
    // доводила б лише те, що схема це вміє, а джоба тим часом возила один.
    const job = readFileSync(SRC("jobs/syncReceivables.ts"), "utf8");
    assert.match(job, /SELECT client_key, limit_days, limit_amount FROM client_credit_limits/,
      "🔴 синк перестав читати ліміт суми з людської таблиці");
    assert.match(job, /INSERT INTO receivables \([^)]*limit_amount/,
      "🔴 синк не пише `limit_amount` у `receivables` — ліміт зникатиме щопроходу");
  } finally { await c.end(); scratch.dispose(); }
});

test("#199au право на запит ліміту — на API, а не на кнопці", async () => {
  // 🔴 РІШЕННЯ ВЛАСНИКА 26.08.2026, І ВОНО СКАСУВАЛО ПОПЕРЕДНЄ («бачать усі,
  // виконавець — опердир»). Стало: «задачі не операційний отримує, а тім-лід в
  // межах своєї команди», «Кнопка тільки в тімліда».
  //
  // ⚠️ СХОВАНА КНОПКА НЕ Є ПРАВОМ — гейт стоїть на роуті. Тому перевіряється
  // предикат, яким гейтить роут, а не наявність кнопки у верстці.
  const { canAssignTaskToOthers, canRequestLimitFor } = await import("../auth/taskAssignScope.js");

  // Менеджер не бачить і не може — він ставить задачі лише собі.
  assert.equal(canAssignTaskToOthers({ role: "manager", teamId: 5 }), false,
    "🔴 менеджер отримав кнопку — власник сказав «тільки в тімліда»");
  assert.equal(canRequestLimitFor({ role: "manager", teamId: 5 }, 5), false,
    "🔴 менеджер може поставити задачу про ліміт навіть у своїй команді");

  // 🪞 ДЗЕРКАЛО: тімлід МОЖЕ — інакше гейт зеленів би на фічі, вимкненій усім.
  assert.equal(canRequestLimitFor({ role: "team_lead", teamId: 5 }, 5), true,
    "🔴 тімлід не може поставити задачу про СВОГО клієнта — фіча мертва");
  // …але лише в межах СВОЄЇ команди.
  assert.equal(canRequestLimitFor({ role: "team_lead", teamId: 5 }, 7), false,
    "🔴 тімлід ставить задачі про ЧУЖИХ боржників — «в межах своєї команди» не працює");
  assert.equal(canRequestLimitFor({ role: "team_lead", teamId: 5 }, null), false,
    "🔴 клієнт без команди дістався тімліду — межу неможливо перевірити, отже це відмова");
  // Тімлід без команди — не тімлід: інакше `teamId === clientTeamId` при обох
  // `null` відкрило б йому всіх нічийних клієнтів.
  assert.equal(canAssignTaskToOthers({ role: "team_lead", teamId: null }), false,
    "🔴 тімлід без команди отримав право — і накрив би всіх клієнтів без команди");

  // Адмінський рівень — може будь-якого клієнта.
  for (const role of ["admin", "company"] as const) {
    assert.equal(canRequestLimitFor({ role, teamId: null }, 7), true, `🔴 «${role}» втратив право`);
  }

  // І роут справді кличе САМЕ цей предикат, а не свою копію умови.
  const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  assert.match(routes, /canRequestLimitFor\(\{ role: auth\.role, teamId: auth\.teamId \}, c\.team_id\)/,
    "🔴 роут завів власну копію умови — вона розійдеться з кнопкою й гейтом");
});

test("#199av подвійне натискання не створює другої задачі — тримає БД", async () => {
  // 🔴 МЕХАНІЗМ, А НЕ ВИГЛЯД (рішення 26.08.2026). Заблокована кнопка нікого не
  // зупиняє: два відкриті вікна, повтор запиту, швидкі пальці — і задач дві.
  // Тому унікальність стоїть у БД частковим індексом.
  const schema = readFileSync(SRC("db/schema.sql"), "utf8");
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_credit_limit_open/,
    "🔴 зник унікальний індекс — подвійне натискання знову дасть дві задачі");
  const idx = schema.slice(schema.indexOf("idx_tasks_credit_limit_open"),
                           schema.indexOf("idx_tasks_credit_limit_open") + 400);
  assert.match(idx, /ON tasks \(client_key\)/, "🔴 індекс більше не по клієнту");
  assert.match(idx, /task_type = 'credit_limit_request'/,
    "🔴 індекс накрив УСІ задачі про клієнта — тімлід не зміг би завести жодної другої задачі");
  assert.match(idx, /status <> 'done'/,
    "🔴 індекс тримає й ЗАКРИТІ запити — після виконання новий запит став би неможливим назавжди");

  // 🔴 І РОУТ ЗАГОТОВКИ НЕ БРЕШЕ ПРО УСПІХ: при наявному відкритому він віддає
  // ЙОГО, а не мовчазне «ок». Мовчазний успіх — це «операція, що звітує про
  // роботу, якої не зробила».
  //
  // ⚠️ ДІЯ РОЗДІЛЕНА НА ДВА РОУТИ 26.08.2026, І ГЕЙТ СТЕРЕЖЕ ОБИДВА. Заготовка
  // стала `GET /receivables/limit-request` — вона нічого не змінює, тож і
  // методом мусить бути читальним; створення живе в `POST
  // /receivables/limit-task`, як пара `reactivation-task` поруч. Тут
  // перевіряється головне: ЗАГОТОВКА не створює нічого.
  const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  const cut = (m: string) => {
    const i = routes.indexOf(m);
    const j = routes.indexOf("dashboardRouter.", i + 40);
    return routes.slice(i, j > i ? j : routes.length);
  };
  const draft = cut('get("/receivables/limit-request"');
  assert.match(draft, /status <> 'done'/, "🔴 заготовка не шукає наявний відкритий запит");
  assert.match(draft, /existing: \{ id: e\.id/,
    "🔴 заготовка не віддає наявну задачу — фронт не має що показати, і людина натисне втретє");
  assert.ok(!/INSERT INTO tasks/.test(draft),
    "🔴 ЗАГОТОВКА САМА створює задачу — а власник сказав, що виконавця й дедлайн обирає той, хто ставить");
  assert.ok(!/INSERT|UPDATE|DELETE/.test(draft),
    "🔴 заготовка щось ПИШЕ — вона має лише читати, інакше `GET` бреше про свою природу");
});

test("#199aw вік боргу — по ЖИВИХ рахунках, і саме це чинний дефект", needsDb(), async (t) => {
  // 🔴 ЧИННИЙ ДЕФЕКТ НА ПРОДІ, ЗАМІРЯНО 26.08.2026, А НЕ МАЙБУТНЯ ФІЧА.
  // УКРЕНЕРГО-АЛЬЯНС: екран показував 1128 днів при ліміті 25 — тобто клієнта
  // «у межах» (найстаріший ЖИВИЙ рахунок 22 дні) малювало простроченим на 1103
  // дні понад ліміт і ще й «висяком» (поріг 365). Тягнув списаний рахунок
  // `00000003074` від 25.07.2023: списання прибрало 28 000 ₴ із суми — і
  // лишило по них годинник.
  //
  // Фікстура ВЛАСНА: на проді списання одне, тож жива перевірка мовчала б, а
  // зелений колір нічого не довів би (на цьому вже спіймались із golden-master).
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { CLIENT_DEBT_AGE_SQL } = await import("./receivablesAge.js");
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SRC("db/schema.sql"), "utf8"));
    const K = "укр";
    await c.query(`INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, invoice_no, invoice_date, amount)
                   VALUES ($1,$1,'У','старий', CURRENT_DATE - 1128, 28000),
                          ($1,$1,'У','свіжий', CURRENT_DATE - 22, 100000),
                          ($1,$1,'У','вчора',  CURRENT_DATE - 1,  5000)`, [K]);
    await c.query(`INSERT INTO receivables (client_key, client_name, amount, limit_days) VALUES ($1,'У',133000,25)`, [K]);
    const age = async () => {
      await c.query(`UPDATE receivables r SET overdue_days = a.max_age
                       FROM (${CLIENT_DEBT_AGE_SQL}) a WHERE a.client_key = r.client_key`);
      return (await c.query<{ d: number | null }>(
        `SELECT overdue_days AS d FROM receivables WHERE client_key = $1`, [K])).rows[0].d;
    };
    const off = (no: string) => c.query(
      `INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note) VALUES ($1,$2,1,'ф')`, [K, no]);

    // ① Нічого не списано — вік по найстарішому, як і було.
    assert.equal(await age(), 1128, "🔴 без списань вік змінився — фікс зачепив звичайний випадок");

    // ② ЧАСТКОВО СПИСАНО: пішов найстаріший → вік за найстарішим ІЗ РЕШТИ.
    //    Це і є прод-випадок: 1128 → 22.
    await off("старий");
    assert.equal(await age(), 22,
      "🔴 списаний рахунок далі тягне годинник — саме це на проді малює клієнта «у межах» простроченим на 1103 дні");

    // ③ СПИСАНО ВСІ — віку немає. `null`, а не застигле старе значення:
    //    з `WHERE` замість `FILTER` рядок просто не оновився б, і «списали все»
    //    читалось би як «вік застиг», причому бездоганно правдоподібно.
    await off("свіжий"); await off("вчора");
    assert.equal(await age(), null,
      "🔴 у клієнта зі СПИСАНИМИ ВСІМА рахунками вік не занулився — найімовірніше `WHERE` замість `FILTER`");

    // ④ СКАСУВАННЯ повертає — байт-у-байт до стану ②, потім до ①.
    await c.query(`UPDATE receivable_writeoffs SET revoked_at = now() WHERE invoice_no IN ('свіжий','вчора')`);
    assert.equal(await age(), 22, "🔴 скасування списання не повернуло вік");
    await c.query(`UPDATE receivable_writeoffs SET revoked_at = now() WHERE invoice_no = 'старий'`);
    assert.equal(await age(), 1128, "🔴 повне скасування не повернуло вихідний вік");

    // 💵 ГОТІВКОВИЙ ВИПАДОК: `client_key_raw = NULL`. Ключ мусить вироджуватись
    // симетрично, інакше списання готівкового не вплине на вік узагалі.
    const C = "готівка";
    await c.query(`INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, invoice_no, invoice_date, amount)
                   VALUES ($1,NULL,'Г','g1', CURRENT_DATE - 500, 1000), ($1,NULL,'Г','g2', CURRENT_DATE - 3, 1000)`, [C]);
    await c.query(`INSERT INTO receivables (client_key, client_name, amount) VALUES ($1,'Г',2000)`, [C]);
    await c.query(`INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note) VALUES ($1,'g1',1,'ф')`, [C]);
    await c.query(`UPDATE receivables r SET overdue_days = a.max_age
                     FROM (${CLIENT_DEBT_AGE_SQL}) a WHERE a.client_key = r.client_key`);
    const g = (await c.query<{ d: number | null }>(
      `SELECT overdue_days AS d FROM receivables WHERE client_key = $1`, [C])).rows[0].d;
    assert.equal(g, 3, "🔴 списання ГОТІВКОВОГО рахунка не вплинуло на вік — ключ розійшовся на NULL");
  } finally { await c.end(); scratch.dispose(); }
});

test("#199ay вік боргу ВИРОБЛЯЄТЬСЯ в одному місці — шапка розкриття не рахує сама", async () => {
  // 🔴 ДРУГЕ ДЖЕРЕЛО ОДНОГО ЧИСЛА, ЯКОГО НІХТО НЕ НАЗИВАВ. Шапка розкриття мала
  // власний `Math.floor((Date.now() - min) / 86400000)`, і на УКРЕНЕРГО-АЛЬЯНСІ
  // екран казав двома голосами ОДНОЧАСНО: рядок «1128 дн.», шапка під ним —
  // «найстаріший 22 дн.». Обидва правильні кожен у своєму всесвіті — саме тому
  // їх ніхто не помітив.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const head = sec.slice(sec.indexOf("const renderInvoices"), sec.indexOf("Рахунки клієнта"));
  assert.ok(!/86400000/.test(head),
    "🔴 шапка розкриття знову рахує вік сама — два джерела одного числа на одному екрані");
  assert.match(head, /invAge\[clientKey\]/, "🔴 шапка більше не бере вік із сервера");

  // Сервер його справді віддає, і саме з ядра.
  const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  assert.match(routes, /oldestAliveDays/, "🔴 роут не віддає вік — шапці нема звідки його взяти");
  assert.match(routes, /debtAgeDays\(/, "🔴 роут рахує вік власним виразом замість ядра");

  // 🪞 ДЗЕРКАЛО: вік ВСЕ ЩЕ показується. Без нього гейт зеленів би й тоді, коли
  // «найстаріший N дн.» прибрали з екрана зовсім.
  assert.match(sec, /найстаріший \$\{oldest\}/, "🔴 вік зник із шапки розкриття взагалі");
});

test("#199ba кнопка «Списати» ВИДИМА в рядку рахунка", () => {
  // 🔴 ЧЕСНА МЕЖА ЦЬОГО ГЕЙТА, ПЕРШИМ РЯДКОМ: він читає СТИЛІ, з яких видимість
  // виходить, а піксель бачить тільки екран. Сьогоднішній випадок доводить, чому
  // цього мало: CSS був синтаксично бездоганний, селектор теж, а зламане було
  // саме те, чого правило не бачить — що `<tr>` рахунка не має класу `.recv-row`.
  // Тому доказом лишається СКРІНШОТ розкриття з наведенням, а не зелений гейт.
  //
  // 📐 Заміряно в браузері `getComputedStyle` перед фіксом: 117 кнопок у DOM
  // (76 у рядках клієнта + 41 у рядках рахунків), видимих після наведення на
  // рядок рахунка — НУЛЬ. Власник: «я не можу списувати саме певні рахунки».
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const css = readFileSync(FE("index.css"), "utf8");

  assert.match(sec, /<tr key=\{`\$\{clientKey\}-inv-\$\{i\}`\} className="recv-inv">/,
    "🔴 рядок рахунка втратив клас `recv-inv` — кнопка знову не зможе стати видимою");
  assert.match(css, /\.recv-inv:hover \.recv-wo/,
    "🔴 зникло правило видимості для рядка рахунка");
  assert.match(css, /\.recv-inv:focus-within \.recv-wo/,
    "🔴 зникла видимість із КЛАВІАТУРИ — до кнопки не дійти без миші");

  // 🪞 ДЗЕРКАЛО: правило для рядка КЛІЄНТА не послаблене й не прибране.
  // Односторонній фікс міг би зробити `.recv-wo` видимою скрізь — тобто 74
  // червоні кнопки постійно на екрані, від чого приховування й заводилось.
  assert.match(css, /\.recv-row:hover \.recv-wo/, "🔴 зникло правило для рядка клієнта");
  assert.ok(!/^\s*\.recv-wo\s*\{[^}]*visibility:\s*visible/m.test(css),
    "🔴 `.recv-wo` зробили видимою БЕЗУМОВНО — це 74 постійні червоні кнопки, а не фікс");
});

test("#199bb порахункове списання ≠ компанійському", () => {
  // 🔴 ДВІ РІЗНІ ДІЇ З ОДНОГО ЕКРАНА, І ПЛУТАТИ ЇХ НЕ МОЖНА: кнопка в рядку
  // рахунка списує ОДИН, кнопка в рядку клієнта — УСІ, що лишились. Якби
  // `invoiceNo` губився дорогою, клік по одному рахунку тихо забирав би весь
  // борг клієнта — і виглядало б це як «спрацювало».
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.match(sec, /\{ clientKey, invoiceNo: no \}/,
    "🔴 кнопка рахунка більше не передає номер — вона списала б усього клієнта");
  assert.match(sec, /\{ clientKey: c\.clientKey, invoiceNo: null \}/,
    "🔴 кнопка клієнта більше не передає `null` — компанійське списання зламане");

  const dlg = strip(readFileSync(FE("pages/dashboard/sections/WriteoffDialog.tsx"), "utf8"));
  assert.match(dlg, /УСІ рахунки клієнта/,
    "🔴 діалог не називає обсяг компанійського списання — «списати борг» прочитають як один рахунок");
  assert.match(dlg, /рахунок № \$\{invoiceNo\}/,
    "🔴 діалог не називає НОМЕР при порахунковому списанні — обсяг знову не видно");

  // Безномерний рядок: кнопки НЕМАЄ, а пояснення Є (рішення власника 26.08.2026).
  assert.match(sec, /canWriteOff && no !== ""/,
    "🔴 кнопка зʼявилась у безномерному рядку — вона діяла б на кілька рядків одразу");
  assert.match(sec, /списання недоступне: рахунок без номера/,
    "🔴 на місці кнопки порожнеча — відсутня дія мусить бути ПОЯСНЕНА, а не просто відсутня");
});

test("#199bd два `isOverdue` дають ОДНЕ І ТЕ САМЕ — розходження неможливе тихо", async () => {
  // 🔴 РІШЕННЯ 26.08.2026: не зводимо в цьому проході, але й боргом без
  // механізму не лишаємо. Означення прострочки живе ДВІЧІ — у ядрі
  // (`core/creditLimits.isOverdue`) і у фронті (`receivablesView.isOverdue`).
  // Поки їх дві, вони мусять збігатися на спільній таблиці випадків; зведення —
  // окремий прохід, коли чіпатимемо `ReceivablesBreakdownCard` із її третьою
  // умовою `(overdueDays ?? 0) > 0`.
  const core = await import("./creditLimits.js");
  const fe = await import(FE_SPEC("pages/dashboard/receivablesView.ts"));

  const CASES: { age: number | null; limit: number | null; why: string }[] = [
    { age: 22, limit: 25, why: "у межах — прод-випадок УКРЕНЕРГО після фіксу" },
    { age: 1128, limit: 25, why: "далеко за межею — той самий клієнт до фіксу" },
    { age: 25, limit: 25, why: "РІВНО на межі: це межа, а не її перехід" },
    { age: 26, limit: 25, why: "на день за межею" },
    { age: 0, limit: 0, why: "нуль проти нуля" },
    { age: 1, limit: 0, why: "«розглянули і не дали» = нульовий ліміт" },
    { age: 1, limit: null, why: "ліміту НІКОЛИ не ставили — теж нульовий" },
    { age: null, limit: 25, why: "віку немає (усі рахунки списані) — НЕ прострочка" },
    { age: null, limit: null, why: "нічого не відомо" },
    { age: 0, limit: null, why: "виставлений сьогодні, ліміту немає" },
  ];
  const diff: string[] = [];
  for (const c of CASES) {
    const a = core.isOverdue(c.age, c.limit);
    const b = fe.isOverdue({ overdueDays: c.age, limitDays: c.limit });
    if (a !== b) diff.push(`${c.why}: ядро=${a}, фронт=${b} (вік ${c.age}, ліміт ${c.limit})`);
  }
  assert.deepEqual(diff, [],
    "🔴 ДВА ОЗНАЧЕННЯ ПРОСТРОЧКИ РОЗІЙШЛИСЬ. Вони живуть у ядрі й у фронті окремо; поки їх два, "
    + "вони мусять давати те саме на кожному випадку — інакше рядок і плитка одного екрана "
    + "почнуть казати різне, і кожне число виглядатиме правдоподібно:\n  " + diff.join("\n  "));

  // Порожня таблиця = провал: `deepEqual([], [])` істинний і при нулі випадків.
  assert.ok(CASES.length >= 8, `🔴 випадків лише ${CASES.length} — звіряти нема на чому`);
  // І щонайменше один випадок мусить давати `true`, а один `false`: інакше
  // збіг тримався б на тому, що обидві функції завжди повертають одне й те саме.
  assert.ok(CASES.some((c) => core.isOverdue(c.age, c.limit)), "🔴 жоден випадок не дає прострочки");
  assert.ok(CASES.some((c) => !core.isOverdue(c.age, c.limit)), "🔴 жоден випадок не дає «у межах»");
});

/**
 * 🔎 ПЕРЕЛІЧУВАЧ РОДИНИ ПРОСТРОЧКИ.
 *
 * КРИТЕРІЙ СЛОВАМИ, щоб наступний не реконструював його з регулярки:
 * місце ВИРОБЛЯЄ вік боргу, якщо воно рахує його з ДАТИ РАХУНКА —
 *   · у SQL: різниця з `invoice_date` (`CURRENT_DATE - invoice_date` тощо);
 *   · у TS: арифметика по мілісекундах доби (`86400000`) над датами рахунків.
 * Місце, яке лише ЧИТАЄ готовий `overdue_days` / `overdueDays`, виробником НЕ
 * є — таких на екрані півдюжини, і вимагати від них чогось безглуздо.
 *
 * 🔴 НАВІЩО ПОВЕРХ ПОІМЕННИХ ГЕЙТІВ. Виробників було ДВА, і другого ніхто не
 * називав: SQL у синку рахував по всіх рахунках, шапка розкриття — по живих,
 * і на УКРЕНЕРГО-АЛЬЯНСІ екран казав «1128 дн.» і «найстаріший 22 дн.»
 * ОДНОЧАСНО. Поіменні гейти стережуть двох відомих; третього, ще не
 * написаного, не бачить жоден.
 */
const AGE_PRODUCER_FILES = [
  "jobs/syncReceivables.ts", "routes/dashboard.ts", "core/receivablesAge.ts",
  "core/receivablesFacts.ts", "core/creditLimits.ts", "core/metrics.ts",
] as const;
const FE_AGE_PRODUCER_FILES = [
  "pages/dashboard/sections/ReceivablesSection.tsx",
  "pages/dashboard/sections/ReceivablesBreakdownCard.tsx",
  "pages/dashboard/sections/ReceivablesTiles.tsx",
  "pages/dashboard/receivablesView.ts",
] as const;

/** Виробники, яким МОЖНА: саме вони і є єдиним джерелом. */
const AGE_PRODUCER_ALLOWED: { file: string; why: string }[] = [
  { file: "core/receivablesAge.ts",
    why: "ЄДИНЕ джерело віку: `CLIENT_DEBT_AGE_SQL` для синку і `debtAgeDays` для фронта. Тут виробляти й треба" },
];

test("#199bc перелічувач: вік боргу виробляє РІВНО одне місце", () => {
  const found: { file: string; how: string }[] = [];
  const scan = (rel: string, src: string, isFe: boolean) => {
    const code = strip(src);
    // Рахунковий рядок розкриття показує вік ОДНОГО рахунка — це не «вік боргу
    // клієнта», а підпис рядка; він живиться тією самою датою й нікуди не
    // агрегується. Виключаємо іменем змінної, а не «схожістю».
    const body = code.replace(/const age = iDate \? Math\.floor\(\(Date\.now\(\) - iDate\.getTime\(\)\) \/ 86400000\) : null;/g, "");
    if (/CURRENT_DATE\s*-\s*(ri\.)?invoice_date/.test(body)) { found.push({ file: rel, how: "SQL по invoice_date" }); return; }
    // ⚠️ `86400000` САМЕ ПО СОБІ виробником не є: тією ж константою рахується
    // тижнева межа коментарів (`weekStartKyiv`). Перша редакція критерію на
    // ній і спіймалась — і це був ХИБНИЙ ПОЗИТИВ мого гейта, а не знахідка.
    // Тому вимагаємо, щоб поруч (±2 рядки) стояла ДАТА РАХУНКА — рівно як
    // критерій і сформульований словами вище.
    if (!isFe) return;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("86400000")) continue;
      const near = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
      if (/invoiceDate|invoice_date/.test(near)) { found.push({ file: rel, how: "арифметика діб над датою рахунка" }); return; }
    }
  };
  for (const f of AGE_PRODUCER_FILES) scan(f, readFileSync(SRC(f), "utf8"), false);
  for (const f of FE_AGE_PRODUCER_FILES) scan(f, readFileSync(FE(f), "utf8"), true);

  // Порожній перебір = провал: спершу доводимо, що йому БУЛО що знайти.
  assert.ok(found.length >= 1,
    "🔴 перебір не знайшов ЖОДНОГО виробника віку — критерій розсипався, і зелене тут означає «не перевірено нічого»");

  const allowed = new Set(AGE_PRODUCER_ALLOWED.map((a) => a.file));
  const extra = found.filter((f) => !allowed.has(f.file)).map((f) => `${f.file} (${f.how})`);
  assert.deepEqual(extra, [],
    "🔴 ЗʼЯВИВСЯ ДРУГИЙ ВИРОБНИК ВІКУ БОРГУ. Вік мусить приходити з `core/receivablesAge.ts`; "
    + "друге місце одного дня розійдеться з першим, і екран казатиме два числа одночасно — "
    + "рівно як «1128 дн.» у рядку проти «найстаріший 22 дн.» у шапці під ним:\n  " + extra.join("\n  "));

  // 🪞 РЕЄСТР НЕ СМІТНИК: дозволений виробник мусить існувати й справді виробляти.
  for (const a of AGE_PRODUCER_ALLOWED) {
    assert.ok(found.some((f) => f.file === a.file),
      `🔴 «${a.file}» оголошений виробником, але нічого не виробляє — запис протух`);
    assert.ok(a.why.length > 30, `🔴 «${a.file}» без пояснення`);
  }
});

test("#199be ліміт суми: копія фронта == копії ядра, значення в значення", async () => {
  // 🔴 ТОЙ САМИЙ КЛАС, ЩО `#199af` (підказки маржі): правило живе ДВІЧІ — у
  // ядрі й у фронті, — і гейти читали б лише копію ядра. Саботаж «поміняти
  // `declined` і `never-set` місцями У ФРОНТІ» лишав би все зеленим, а екран
  // пояснював би навпаки: «не встановлювали» там, де свідомо відмовили.
  const core = await import("./creditLimits.js");
  const fe = await import(FE_SPEC("pages/dashboard/receivablesView.ts"));

  const AMOUNTS: (number | null)[] = [null, 0, 1, 50_000, 325_500];
  const diff: string[] = [];
  for (const a of AMOUNTS) {
    if (core.amountLimitState(a) !== fe.amountLimitState(a))
      diff.push(`стан(${a}): ядро=${core.amountLimitState(a)}, фронт=${fe.amountLimitState(a)}`);
    if (core.amountLimitLabel(a) !== fe.amountLimitLabel(a))
      diff.push(`підпис(${a}): ядро=«${core.amountLimitLabel(a)}», фронт=«${fe.amountLimitLabel(a)}»`);
    if (core.amountLimitHint(a) !== fe.amountLimitHint(a))
      diff.push(`підказка(${a}) розійшлась`);
  }
  // Перевищення — теж дві копії, з різними формами виклику.
  for (const [debt, lim] of [[100, null], [100, 0], [100, 50], [50, 50], [49, 50], [0, null]] as const) {
    const a = core.isOverAmount(debt, lim);
    const b = fe.isOverAmount({ amount: debt, limitAmount: lim });
    if (a !== b) diff.push(`переліміт(борг ${debt}, ліміт ${lim}): ядро=${a}, фронт=${b}`);
  }
  // Заголовок задачі — теж дзеркало: тімлід читає ТОЙ САМИЙ рядок, що пише роут.
  for (const [n, d, l] of [["УКРЕНЕРГО", 325500, null], ["МГЕР", 100, 50000]] as const) {
    if (core.limitRequestTitle(n, d, l) !== fe.limitRequestTitle(n, d, l))
      diff.push(`заголовок(${n}): ядро=«${core.limitRequestTitle(n, d, l)}», фронт=«${fe.limitRequestTitle(n, d, l)}»`);
  }
  assert.deepEqual(diff, [],
    "🔴 ДВІ КОПІЇ ПРАВИЛА ЛІМІТУ СУМИ РОЗІЙШЛИСЬ. Гейти, що читають ядро, цього не побачать, "
    + "а на екрані малюється копія фронта:\n  " + diff.join("\n  "));
  assert.ok(AMOUNTS.length >= 4, "🔴 випадків замало — звіряти нема на чому");
});

test("#199bf кнопка запиту — у РЯДКУ клієнта, і лише в того, хто може ставити задачу", () => {
  // 🔴 ЧЕСНА МЕЖА ПЕРШИМ РЯДКОМ: гейт читає ДЖЕРЕЛО, а видимість бачить лише
  // екран. Сьогодні це вже коштувало власнику робочої дії: кнопка списання
  // рахунка була в DOM і не могла стати видимою через селектор, якого правило
  // не перевіряє. Тому доказом лишається скріншот із наведенням і кліком.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const tiles = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesTiles.tsx"), "utf8"));

  assert.match(sec, /<LimitRequestDialog clientKey=\{c\.clientKey\}/,
    "🔴 діалог запиту не підключений у рядку клієнта");
  assert.match(sec, /canRequestLimit &&/,
    "🔴 кнопка малюється без перевірки права — її побачив би менеджер, якому власник її не давав");
  // 🔴 У ПЛИТЦІ КНОПКИ НЕМАЄ (рішення власника): ліміт задається поклієнтно,
  // отже й запит поклієнтний. Кнопка над сумою всього екрана означала б «запит
  // про весь борг компанії» — предмета, якого не існує.
  assert.ok(!/LimitRequestDialog|canRequestLimit/.test(tiles),
    "🔴 кнопка запиту зʼявилась у плитці «Загальний борг» — там сума по ВСЬОМУ екрану, а ліміт поклієнтний");

  // Право віддає СЕРВЕР тим самим виразом, яким гейтить роут.
  const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  assert.match(routes, /canRequestLimit: canAssignTaskToOthers\(/,
    "🔴 сервер рахує право кнопки не тим виразом, що гейтить роут");
});

test("#199bg задача створюється БЕЗ правки контракту Задачника", () => {
  // 🔴 ПРАВИЛО ВЛАСНИКА: «Її поля й логіка не змінюються правками Звіту; будь-яка
  // зміна контракту — окрема задача з окремим прийманням.» `POST /tasks` не
  // приймає `task_type`, `client_key` і `description`, а `routes/tasks.ts` —
  // файл контракту. Тому пишемо тим самим способом, що вже існує ПОРУЧ:
  // `POST /reactivation-task` у `dashboard.ts` створює задачу з тими самими
  // трьома полями й контракту не чіпає.
  const tasks = readFileSync(SRC("routes/tasks.ts"), "utf8");
  assert.ok(!/credit_limit_request/.test(tasks),
    "🔴 тип запиту ліміту заїхав у `routes/tasks.ts` — це правка контракту Задачника");
  assert.ok(!/limitRequestTitle|limit-request|limit-task/.test(tasks),
    "🔴 логіка ліміту заїхала в контракт Задачника");

  const routes = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  const body = routes.slice(routes.indexOf('post("/receivables/limit-task"'),
                            routes.indexOf('post("/receivables/limit-task"') + 4500);
  assert.match(body, /INSERT INTO tasks \([^)]*task_type, client_key, description\)/,
    "🔴 роут не створює задачу з предметом — без клієнта й опису це «дайте ліміт» без предмета");
  assert.match(body, /LIMIT_REQUEST_TASK_TYPE/, "🔴 тип задачі не з ядра — розійдеться з індексом у схемі");
  // Виконавця й дедлайн НЕ проставляємо за людину.
  assert.match(body, /Оберіть виконавця/,
    "🔴 задача створюється без виконавця — вона нікому не належить");
  assert.ok(!/deadline = .*now\(\)|INTERVAL '\d+ day'/.test(body),
    "🔴 дедлайн проставляється автоматично — власник сказав, що його обирає той, хто ставить");
});

test("#199bh подвійне натискання: перевірка + індекс, і жодного мовчазного успіху", () => {
  // 🔴 МЕХАНІЗМ, А НЕ ВИГЛЯД. Заблокована кнопка нікого не зупиняє: дві вкладки,
  // повтор запиту, швидкі пальці — і задач дві. Тому оборони ДВІ:
  //   (1) перевірка «чи є відкрита» в роуті — вона дає зрозумілу відповідь;
  //   (2) частковий унікальний індекс у БД — він ловить ГОНКУ, що проходить
  //       повз перевірку між SELECT і INSERT.
  // 🔴 ЧИТАЄМО ПО ОЧИЩЕНОМУ ДЖЕРЕЛУ Й ДО МЕЖІ РОУТУ, А НЕ ФІКСОВАНИМ ВІКНОМ.
  // Обидві помилки спіймано САБОТАЖЕМ того самого дня, і кожна робила гейт
  // зеленим на зламаному коді:
  //   · зріз «+4500 символів» їде разом із будь-яким доданим коментарем — рівно
  //     те, на чому вже спіймався `#197c`;
  //   · пошук по СИРОМУ тексту знаходив `idx_tasks_credit_limit_open` у моєму ж
  //     КОМЕНТАРІ, тож саботаж «прибрати обробку гонки» лишався непоміченим.
  const routes = strip(readFileSync(SRC("routes/dashboard.ts"), "utf8"));
  const i = routes.indexOf('post("/receivables/limit-task"');
  const j = routes.indexOf("dashboardRouter.", i + 40);
  const body = routes.slice(i, j > i ? j : routes.length);

  assert.match(body, /status <> 'done' LIMIT 1/, "🔴 роут не шукає наявний відкритий запит");
  // 🔴 НЕ ПРОСТО «SELECT Є», А ЩО ЙОГО РЕЗУЛЬТАТ ЗУПИНЯЄ ВСТАВКУ. Саботаж F4
  // прибрав саме гілку `if (open.rowCount) return 409`, лишивши запит на місці —
  // і гейт, що перевіряв лише наявність SELECT, цього не побачив.
  assert.match(body, /if \(open\.rowCount\)[\s\S]{0,200}?return res\.status\(409\)/,
    "🔴 наявний відкритий запит НЕ зупиняє створення — SELECT є, а рішення по ньому немає");
  assert.match(body, /catch[\s\S]{0,400}?idx_tasks_credit_limit_open[\s\S]{0,200}?409/,
    "🔴 гонка двох вкладок не обробляється — індекс кине помилку, і користувач побачить 500");

  const schema = readFileSync(SRC("db/schema.sql"), "utf8");
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_credit_limit_open/,
    "🔴 зник унікальний індекс — лишилась сама перевірка, яку гонка обходить");

  // 🪞 І ФРОНТ ПОКАЗУЄ НАЯВНУ, а не бадьоре «готово».
  const dlg = strip(readFileSync(FE("pages/dashboard/sections/LimitRequestDialog.tsx"), "utf8"));
  assert.match(dlg, /Запит на цього клієнта вже відкритий/,
    "🔴 діалог мовчить про наявний запит — людина натисне втретє");
  assert.match(dlg, /existing\.id/, "🔴 діалог не називає НОМЕР наявної задачі — її нема як знайти");
});

// ════════════════ ВЕРСТКА ЗА МАКЕТОМ v6.1 · ПРОХІД A (26.08.2026) ════════════
//
// 🔴 ЩО ЦЕЙ БЛОК НЕ СТЕРЕЖЕ, СКАЗАНО ПЕРШИМ РЯДКОМ: висоту рядка клієнта.
// Вона 117..156 і лишається такою — її тримає колонка «Домовленість», а це
// прохід B. Гейт на «рядок ≤52px» тут був би зелений лише в мріях; поставити
// його зараз означало б завести червону перевірку, яку два тижні гортають очима.

test("#199bs шрифт контролів тримає ПРАВИЛО, а не інлайн у компоненті", async () => {
  // 🔴 ЗАМІР ПЕРЕВЕРНУВ ФОРМУЛЮВАННЯ, І ГЕЙТ СТЕРЕЖЕ ТЕ, ЩО ДАЛО ЕФЕКТ.
  //
  // Промт казав «у нас точково і майже напевно не на всіх». Заміряно в браузері
  // на живому зрізі: **517 контролів дебіторки, сімʼя ОДНА** — дефекту немає.
  // Але правило `select, input, button { font: inherit }` стояло для ТРЬОХ тегів
  // із чотирьох, а всі 77 `textarea` тримались на інлайновому `font: "inherit"`
  // усередині `CommentField`. Проба: зняти той інлайн → `getComputedStyle`
  // віддає **monospace**.
  //
  // 🔴 ТОМУ ГЕЙТ У ФОРМУЛЮВАННІ «множина сімей == 1» БУВ БИ ЗЕЛЕНИЙ ДО ПРАВКИ.
  // Це рівно клас `#56b`/`#61b`: перевірка, привʼязана до наявності стану, яка
  // зеленіє на зламаному коді, бо стан випадково є. Тут стан тримає компонент —
  // прибери `CommentField` із рядка (а прохід B саме це й робить), і перша ж
  // нова `textarea` мовчки поїде в моноширинний.
  //
  // Стережемо ПРАВИЛО: усі чотири теги мусять успадковувати сімʼю.
  const css = readFileSync(FE("index.css"), "utf8");
  const tags = ["select", "input", "button", "textarea"] as const;

  // Збираємо всі селектори, що задають контролам успадкування шрифту.
  const covered = new Set<string>();
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1], body = m[2];
    if (!/font(-family)?\s*:\s*inherit/.test(body)) continue;
    for (const t of tags) if (new RegExp(`(^|[,\\s])${t}\\s*(,|\\{|$)`).test(sel + "{")) covered.add(t);
  }
  for (const t of tags) {
    assert.ok(covered.has(t),
      `🔴 <${t}> не успадковує сімʼю шрифту жодним правилом — браузер дасть йому свій дефолт `
      + `(для textarea це monospace), і він зʼїдеться з текстом поруч. `
      + `Покрито: ${[...covered].join(", ") || "нічого"}`);
  }
});

test("#199bs2 шорткат `font: inherit` НЕ накладено на textarea — інакше поїде розмір", () => {
  // 🪞 ДЗЕРКАЛО ДО `#199bs`, І ВОНО ПРО МЕЖУ, А НЕ ПРО ПРИСУТНІСТЬ.
  // Полагодити дефект можна було одним словом у наявному правилі — і це було б
  // ГІРШЕ: шорткат `font:` задає ще й РОЗМІР. Заміряно: сім `textarea` на шести
  // інших екранах (Новини, AI-робота, 1×1, Формування планів, `RowComment`,
  // Зворотний звʼязок, Навчання) не мають жодного шрифтового стилю — шорткат
  // зробив би їм 13.3px → 15px, тобто зміну вигляду на екранах, яких цей прохід
  // не стосується. Без цього гейта наступний прохід «спростить два правила в
  // одне» і мовчки перемалює шість чужих екранів.
  const css = readFileSync(FE("index.css"), "utf8");
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim(), body = m[2];
    if (!/(^|[,\s])textarea\s*(,|\{|$)/.test(sel + "{")) continue;
    assert.ok(!/(^|;|\s)font\s*:\s*inherit/.test(body),
      `🔴 селектор «${sel}» дає textarea шорткат font: inherit — разом із сімʼєю поїде РОЗМІР `
      + `на шести екранах поза дебіторкою. Потрібен саме font-family.`);
  }
});

test("#199bn олівець ліміту стоїть на місці, а не за текстом значення", () => {
  // 📐 Заміряно в браузері, x олівця в пʼяти сусідніх рядках:
  // `1240 · 1240 · 1240 · 1240 · **1216**` — він їхав за довжиною значення
  // («14 дн.» проти «не узгоджено»). У макеті — `1094` пʼять разів.
  // Лікує не відступ, а розкладка комірки.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const i = sec.indexOf("Змінити узгоджену відстрочку");
  assert.ok(i > 0, "🔴 олівець ліміту зник — перевіряти нема чого");
  // Комірка мусить бути саме розкладкою, а не інлайновим текстом.
  const cell = sec.slice(Math.max(0, i - 900), i + 300);
  assert.match(cell, /className="recv-limitcell"/,
    "🔴 значення й олівець знову в одному текстовому потоці — олівець поїде за довжиною значення");

  const css = readFileSync(FE("index.css"), "utf8");
  const rule = /\.recv-limitcell\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "🔴 правила .recv-limitcell немає — клас у розмітці нічого не робить");
  assert.match(rule![1], /justify-content:\s*space-between/,
    "🔴 без space-between олівець знову приліплений до тексту, а не до краю комірки");
  assert.match(rule![1], /min-width:\s*\d+px/,
    "🔴 без мінімальної ширини комірка стискається під найкоротше значення, і край знову їде");
});

test("#199bo сітка плиток задана явним числом колонок, а не auto-fit", () => {
  // 📐 Заміряно: при `auto-fit, minmax(230px,1fr)` шість плиток лягали у **2 ряди**
  // на 1440 і 1600 (ширина плитки 250px — місця вистачало, браузер усе одно
  // переносив), і лише на 1920 в один. `auto-fit` тут не «гнучкіший», він
  // НЕДЕТЕРМІНОВАНИЙ: результат залежить від заокруглень контейнера.
  //
  // 🪞 ОБИДВІ ВКЛАДКИ, а не лише активна: інакше архів лишився б із auto-fit і
  // розійшовся б із сусідньою вкладкою того самого екрана.
  for (const f of ["ReceivablesTiles.tsx", "ReceivablesArchive.tsx"]) {
    const src = strip(readFileSync(FE(`pages/dashboard/sections/${f}`), "utf8"));
    assert.ok(!/auto-fit/.test(src),
      `🔴 ${f}: повернувся auto-fit — сітка знову залежить від заокруглень, а не від рішення`);
    assert.match(src, /className="kpi-grid recv-kpis"/,
      `🔴 ${f}: плитки не беруть спільний клас сітки`);
  }
  const css = readFileSync(FE("index.css"), "utf8");
  assert.match(css, /\.recv-kpis\s*\{[^}]*repeat\(6,\s*minmax\(0,\s*1fr\)\)/,
    "🔴 у .recv-kpis немає шести колонок — плитки знову перенесуться");
  assert.match(css, /max-width:\s*1500px\s*\)\s*\{\s*\.recv-kpis/,
    "🔴 немає брейкпоінта 1500 — на вузькому екрані шість колонок стиснуться в нечитабельні");
});

test("#199bp числівник узгоджується — «1 рахунок», а не «1 рахунків»", async () => {
  // 🔴 ЗНАЙШЛО ОКО НА ВЛАСНОМУ ЕКРАНІ: плитка архіву писала «1 рахунків ·
  // 1 клієнтів». Жоден гейт цього не бачить — рядок склеюється з числа й
  // зашитого слова, обидва по-своєму правильні. Той самий клас, що «амсфарм»
  // у колонці «Клієнт»: текст у списку не перевіряє ніщо.
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    plural: (n: number, one: string, few: string, many: string) => string;
    nPlural: (n: number, one: string, few: string, many: string) => string;
  };
  const f = (n: number) => V.plural(n, "рахунок", "рахунки", "рахунків");
  for (const [n, want] of [[1, "рахунок"], [2, "рахунки"], [3, "рахунки"], [4, "рахунки"],
                           [5, "рахунків"], [0, "рахунків"],
                           // 11-14 — завжди «багато», і це та частина правила, яку
                           // зазвичай і забувають: 11 закінчується на 1, 12 на 2.
                           [11, "рахунків"], [12, "рахунків"], [13, "рахунків"], [14, "рахунків"],
                           [21, "рахунок"], [22, "рахунки"], [25, "рахунків"],
                           [111, "рахунків"], [121, "рахунок"]] as const) {
    assert.equal(f(n), want, `🔴 ${n}: очікували «${want}», отримали «${f(n)}»`);
  }
  assert.equal(V.nPlural(1, "клієнт", "клієнти", "клієнтів"), "1 клієнт");

  // 🪞 І ЩО ЙОГО СПРАВДІ КЛИЧУТЬ ТАМ, ДЕ БУВ ДЕФЕКТ. Чиста функція, яку ніхто не
  // викликає, — це не виправлення, а бібліотека.
  const arch = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesArchive.tsx"), "utf8"));
  assert.ok(!/\$\{t\.n\} рахунків/.test(arch),
    "🔴 плитка архіву знову склеює число із зашитим словом — «1 рахунків» повернулось");
  assert.match(arch, /nPlural\(t\.n,/, "🔴 плитка архіву не кличе числівник");
  assert.match(arch, /nPlural\(t\.clients,/, "🔴 «клієнтів» лишився зашитим");
});

test("#199bq обидві вкладки беруть ширину таблиці з ОДНІЄЇ обгортки", () => {
  // 📐 ПРИЧИНА ЗАМІРЯНА ЛАНЦЮГОМ ПРЕДКІВ, А НЕ ПІДІБРАНА ЧИСЛОМ. @1600 активна
  // таблиця лежить у `.chart-card` (падінг 20px з боків), архівна — просто в
  // `main-content`. Звідси **1274 проти 1316**: різниця рівно `2×20 + рамка`.
  // Дві вкладки одного екрана з таблицями різної ширини читаються як два різні
  // екрани; вкладка мала б міняти ВМІСТ, а не рамку.
  //
  // ⚠️ Гейт стереже ОБГОРТКУ, а не число: зашите «1274» протухло б від першої ж
  // зміни падінгу картки, і ми лагодили б гейт замість екрана.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const arch = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesArchive.tsx"), "utf8"));
  const wrapped = (src: string, table: string) => {
    const i = src.indexOf(table);
    assert.ok(i > 0, `🔴 таблиці ${table} немає`);
    return /className="chart-card"/.test(src.slice(Math.max(0, i - 1200), i));
  };
  assert.ok(wrapped(sec, 'className="data-table recv-table"'),
    "🔴 активна таблиця вийшла з .chart-card — ширина розійдеться з архівом");
  assert.ok(wrapped(arch, 'className="data-table recv-archive"'),
    "🔴 архівна таблиця не в .chart-card — саме через це було 1316 проти 1274");
});

test("#199br підпис перевізника в рядку КЛІЄНТА скорочено, у рядку РАХУНКА — ні", async () => {
  // 🔴 ДВА НАБОРИ ПІДПИСІВ — НЕ ДУБЛЬ, А ДВА РІЗНІ ТВЕРДЖЕННЯ, і плутати їх не
  // можна. `carrierCell` описує стан ОДНОГО рахунка й лишається дослівним —
  // його стереже `#197c`. `foldCarrier` — ПІДСУМОК по клієнту, де число вже
  // несе «скільки», а слово «перевізник» повторювалось у 78 рядках, хоч колонка
  // так і зветься. Заміряно: клітинка 106px, «перевізник оплачений 10» не
  // влазить і переносить рядок.
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  const V = (await import(VIEW)) as {
    CARRIER_LABEL: Record<string, string>;
    CARRIER_LABEL_SHORT: Record<string, string>;
    carrierCell: (s: string | null, r: string | null) => { text: string };
  };
  assert.equal(V.CARRIER_LABEL_SHORT.unpaid, "не оплачено");
  assert.equal(V.CARRIER_LABEL_SHORT.paid, "оплачено");
  // 🔴 «н/д» НЕ скорочується й не розшифровується: це третій стан «не знаємо»,
  // і будь-яке «зрозуміліше» слово перетворило б незнання на факт неоплати.
  assert.equal(V.CARRIER_LABEL_SHORT.na, "н/д");
  for (const k of ["paid", "unpaid", "na"]) {
    assert.ok(V.CARRIER_LABEL_SHORT[k].length <= V.CARRIER_LABEL[k].length,
      `🔴 короткий підпис «${k}» не коротший за довгий — сенсу в другому наборі немає`);
  }
  // 🪞 РЯДОК РАХУНКА НЕ ЗАЧЕПЛЕНО: `#197c` перевіряє «н/д», а тут — що довга
  // форма стану жива. Без цього скорочення могло б поїхати в обидва місця, і
  // «перевізник оплачений» зникло б звідти, де воно єдиний підпис стану.
  assert.equal(V.carrierCell("paid", null).text, "✓ оплачений");
  assert.equal(V.carrierCell("unpaid", null).text, "ще не оплачено");

  // І що коротка форма справді підставлена в підсумок по клієнту.
  const view = strip(readFileSync(FE("pages/dashboard/receivablesView.ts"), "utf8"));
  assert.match(view, /foldCarrier[\s\S]{0,200}?CARRIER_LABEL_SHORT/,
    "🔴 підсумок по клієнту знову бере довгі підписи");
});

test("#199bm слот підказки має підлогу висоти в ОБОХ поповерах", () => {
  // 📐 Заміряно на власній геометрії поповера (перший замір брав чужу кнопку
  // «Зберегти» на сторінці й показував сталі 424 — тобто міряв не те):
  //   один символ → кнопка y=918 · повна причина → 918 · СТЕРЛИ → **933**
  // Двохрядкова вимога «обовʼязково вкажіть причину» стискається в однорядковий
  // лічильник, і всі чотири кнопки їдуть на 15px — рівно тоді, коли до них
  // тягнеться рука.
  const css = readFileSync(FE("index.css"), "utf8");
  const rule = /\.recv-hintslot\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "🔴 правила .recv-hintslot немає");
  const mh = /min-height:\s*(\d+)px/.exec(rule![1]);
  assert.ok(mh, "🔴 у слота підказки немає min-height — кнопки знову стрибатимуть");
  assert.ok(Number(mh![1]) >= 30,
    `🔴 min-height ${mh![1]}px замалий: двохрядкова підказка вища, і різниця лишиться`);

  // 🪞 І ЩО КЛАС СПРАВДІ ВЗЯТИЙ ОБОМА. Правило без застосування — це CSS, який
  // виглядає як виправлення. Поповерів саме два, і стрибав кожен.
  for (const f of ["LimitEditor.tsx", "OwnerEditor.tsx"]) {
    const src = strip(readFileSync(FE(`pages/dashboard/sections/${f}`), "utf8"));
    assert.match(src, /className="recv-hintslot"/,
      `🔴 ${f}: підказка не в слоті — кнопки цього поповера стрибають далі`);
  }
});

test("#199bt колонка дій резервує ширину, а видимістю керують правила .recv-wo", () => {
  // 🔴 ДВА РІЗНІ ТВЕРДЖЕННЯ В ОДНІЙ КОЛОНЦІ, І ЗМІШУВАТИ ЇХ НЕБЕЗПЕЧНО.
  // ВИДИМІСТЬ кнопки — це `.recv-wo`, і його вже стереже `#199ba`, який 26.08
  // упіймав 41 кнопку в DOM із нуля видимих. МІСЦЕ під кнопку — окреме: без
  // резерву поява на наведенні розсуває сусідні колонки, і таблиця «дихає» під
  // курсором. Гейт стереже РЕЗЕРВ і окремо вимагає, щоб правила видимості
  // лишились недоторканими.
  const css = readFileSync(FE("index.css"), "utf8");
  const rule = /\.recv-act\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "🔴 правила .recv-act немає — ширина колонки дій знову залежить від вмісту");
  assert.match(rule![1], /width:\s*\d+px/, "🔴 у колонки дій немає фіксованої ширини");

  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  const n = (sec.match(/className="recv-act"/g) ?? []).length;
  // Шапка + рядок клієнта + рядок рахунка: три місця. Менше — якесь із них
  // лишилось із власною шириною, і колонка розʼїдеться саме там.
  assert.ok(n >= 3, `🔴 клас .recv-act стоїть лише в ${n} місцях із трьох (шапка · клієнт · рахунок)`);

  // 🪞 ПРАВИЛА ВИДИМОСТІ НЕ ПОСЛАБЛЕНО. Найпростіший спосіб «полагодити»
  // резерв — прибрати `visibility: hidden`, і кнопки стануть видимі в 78 рядках.
  assert.match(css, /\.recv-wo\s*\{[^}]*visibility:\s*hidden/,
    "🔴 зникло приховування кнопки — вона знову шумить у кожному рядку");
  assert.match(css, /\.recv-inv:hover\s+\.recv-wo/,
    "🔴 зникло правило для рядка рахунка — це рівно та поломка, яку 26.08 знайшов власник");
});

// ════════ СКОУП СУСІДНІХ ДВЕРЕЙ ДЕБІТОРКИ (26.08.2026) ════════

test("#227 скоуп дебіторки — ОДИН вираз, і сусідні двері беруть його, а не свій", () => {
  // 🔴 ЧОМУ ЦЕ ГЕЙТ НА ДЖЕРЕЛО, А НЕ НА HTTP. Діру знайшли ВІДПОВІДЯМИ СЕРВЕРА:
  // `/receivables` звужував бездоганно (менеджер 12 клієнтів, тімлід 5, адмін 78;
  // `?teamId=5` менеджера не розширює, `?managerId=4` тімліду з чужої команди дає
  // нуль), а `/receivables/writeoffs` віддавав менеджеру БАЙТ-У-БАЙТ відповідь
  // адміна — усі 8 списань на 68 178 ₴ з іменами клієнтів, сумами й приписками.
  //
  // Правило було правильне й записане РІВНО В ОДНОМУ обробнику. Поки воно живе
  // всередині роута, наступні двері відчиняються без нього — і це не недбалість,
  // а властивість: копіювати нема чого, бо копіювати нічого й не видно.
  // Тому гейт стереже не «є 403», а те, що ВСІ троє дверей звуться ОДНІЄЮ
  // функцією: HTTP-проба зеленіла б і на трьох різних копіях правила.
  const src = strip(readFileSync(SRC("routes/dashboard.ts"), "utf8"));
  const doors = [
    ['dashboardRouter.get("/receivables"', "список"],
    ['dashboardRouter.get("/receivables/writeoffs"', "архів списань"],
    ['dashboardRouter.get("/receivables/note-history"', "журнал домовленостей"],
  ] as const;
  for (const [anchor, name] of doors) {
    const i = src.indexOf(anchor);
    assert.ok(i > 0, `🔴 роут «${name}» зник — перевіряти нема чого`);
    const body = src.slice(i, src.indexOf("dashboardRouter.", i + 40));
    assert.match(body, /receivablesScope\(/,
      `🔴 «${name}» не кличе спільний скоуп — це або відкриті двері, або друга копія правила`);
    assert.match(body, /if \(!sc\.ok\)[\s\S]{0,120}?status\(sc\.status\)/,
      `🔴 «${name}» кличе скоуп, але НЕ ЗУПИНЯЄТЬСЯ на відмові — виклик без наслідку`);
  }
  // 🪞 І ЖОДНОГО ВЛАСНОГО КЛАМПА ПОРУЧ. Найпростіший спосіб «полагодити» —
  // дописати другу перевірку поруч зі спільною; тоді їх дві, і розійдуться вони мовчки.
  const listBody = src.slice(src.indexOf('dashboardRouter.get("/receivables"'),
                             src.indexOf("dashboardRouter.", src.indexOf('dashboardRouter.get("/receivables"') + 40));
  assert.ok(!/auth\.role === "manager"[\s\S]{0,200}?managerId = auth\.managerId/.test(listBody),
    "🔴 у списку знову власний кламп поруч зі спільним — два правила про одне");
});

test("#227b звуження — ПРЕДИКАТ, а не «менеджер бачить менше»", async () => {
  // 🔴 ЧИСТА ФУНКЦІЯ, ЩОБ ГЕЙТ НЕ ЗАЛЕЖАВ ВІД ЖИВИХ ДАНИХ. Перевірка «менеджер
  // отримав 12, адмін 78» істинна лише поки в базі саме такі числа — і в понеділок
  // після звільнення вона почервоніє без жодного дефекту (клас `#220`).
  const { receivablesScope } = await import("../auth/receivablesScope.js");
  type A = { role: string; managerId: number | null; teamId: number | null };
  const mgr: A = { role: "manager", managerId: 4, teamId: 5 };
  const tl: A = { role: "team_lead", managerId: 81, teamId: 14 };
  const adm: A = { role: "company", managerId: null, teamId: null };

  // ① Менеджер: параметри рядка запиту НЕ розширюють.
  for (const q of [{}, { teamId: 5 }, { managerId: 81 }, { teamId: 14, managerId: 81 }]) {
    const s = receivablesScope(mgr as never, q);
    assert.ok(s.ok && s.managerId === 4 && s.teamId === null,
      `🔴 менеджер із ${JSON.stringify(q)} отримав скоуп ${JSON.stringify(s)} — параметр розширив видимість`);
  }
  // ② Тімлід: своя команда стоїть ЗАВЖДИ; звузитись до свого можна, вийти — ні.
  const t1 = receivablesScope(tl as never, { managerId: 4 });
  assert.ok(t1.ok && t1.teamId === 14,
    "🔴 тімлід загубив свою команду — умови зʼєднуються через AND, і без team_id це доступ, а не звуження");
  // ③ FAIL-CLOSED: без прив'язки — відмова, а не порожній WHERE (тобто вся компанія).
  const noMgr = receivablesScope({ role: "manager", managerId: null, teamId: null } as never, {});
  assert.equal(noMgr.ok, false, "🔴 менеджер без manager_id отримав скоуп — це ПОРОЖНІЙ WHERE, тобто вся дебіторка");
  const noTeam = receivablesScope({ role: "team_lead", managerId: 1, teamId: null } as never, {});
  assert.equal(noTeam.ok, false, "🔴 тімлід без team_id отримав скоуп — те саме, лише іншими дверима");
  // 🪞 ДЗЕРКАЛО: адмін НЕ звужується. Без нього «звузили» тихо стало б «зламали».
  const a = receivablesScope(adm as never, {});
  assert.ok(a.ok && a.managerId === null && a.teamId === null,
    "🔴 адміна звузили — архів списань перестав би показувати всі 8");
});

test("#227c архів списань фільтрується ключами СВОЇХ клієнтів, і міст — через рахунки", () => {
  // 🔴 КЛЮЧ СПИСАННЯ СИРИЙ, А СКОУП КАНОНІЧНИЙ. Зводити їх навпростець
  // (`w.client_key_raw = r.client_key`) можна рівно доти, доки клієнта не склеїли
  // аліасом — а тоді власне списання випало б із видимості власного менеджера,
  // і виглядало б це як «списання зникло», а не як помилка звуження.
  const src = strip(readFileSync(SRC("routes/dashboard.ts"), "utf8"));
  const i = src.indexOf('dashboardRouter.get("/receivables/writeoffs"');
  const body = src.slice(i, src.indexOf("dashboardRouter.", i + 40));
  assert.match(body, /receivablesByClient\(sc\)/,
    "🔴 множина «мої клієнти» рахується не тією функцією, що будує список — два вирази розійдуться тихо");
  assert.match(body, /COALESCE\(ri\.client_key_raw, ri\.client_key\) = w\.client_key_raw/,
    "🔴 сирий ключ списання зводиться зі скоупом не через рахунки — аліас розірве звʼязок");
  assert.match(body, /ri\.client_key = ANY\(\$1\)/,
    "🔴 фільтр по ключах зник — архів знову віддає всі списання компанії");
});

// ════════ КЛІЄНТ ІЗ ПОВНІСТЮ СПИСАНИМИ РАХУНКАМИ (26.08.2026) ════════

test("#199bu клієнт, у якого списані ВСІ рахунки, у відповідь не потрапляє", async () => {
  // 🔴 ЦЕ ДРУГА ПОЛОВИНА ВИМОГИ, І ПЕРШИЙ РАЗ ЇЇ НЕ ЗБУДУВАЛИ ВЗАГАЛІ.
  // «Випадок 2» звучав як «списані всі → клієнт іде з активної». Зробили половину
  // про ГРОШІ (угода виходить із очікуваних, стереже `#199aa`), а половину про
  // ЕКРАН — ні кодом, ні гейтом. Різниця не словесна: «вужчий гейт» лікується
  // посиленням наявного, «інша половина» — тільки новим.
  //
  // 📐 Заміряно на проді, коли дефект став видимим: пʼятеро клієнтів (Байдак ·
  // МОМ · ПТФ-ТЕХНО · Свида · «не вірно») стояли з боргом 0 ₴ і датою «—»,
  // заголовок казав «Боржники (78)» замість 73. Коли випадок писали, таких
  // клієнтів було НУЛЬ — жива перевірка мовчала б, і мовчала б чесно.
  const { clientFullyWrittenOff } = await import("./writeoffScope.js");
  assert.equal(clientFullyWrittenOff({ invoices: 0, writtenOffN: 1 }), true,
    "🔴 клієнт із єдиним списаним рахунком лишається в списку — це рядок «0 ₴ · —»");
  assert.equal(clientFullyWrittenOff({ invoices: 0, writtenOffN: 2 }), true);
  // 🪞 ЧАСТКОВО СПИСАНИЙ ЛИШАЄТЬСЯ. Без цього дзеркала предикат міг би прибирати
  // за фактом БУДЬ-ЯКОГО списання, і УКРЕНЕРГО (297 500 ₴ боргу) зник би теж.
  assert.equal(clientFullyWrittenOff({ invoices: 3, writtenOffN: 1 }), false,
    "🔴 частково списаний клієнт зникає — умова має бути «ВСІ», а не «хоч один»");
  // 🔴 «НУЛЬ ЖИВИХ» І «НЕ БУЛО ЖОДНОГО» — ДВА РІЗНІ СТАНИ. Готівковий рядок
  // будується з УГОД CRM, а не з рахунків 1С: у нього `invoices = 0` і
  // `writtenOffN = 0`, і він має ЛИШИТИСЬ. Сьогодні таких нуль (заміряно), тож
  // помилка була б невидимою рівно доти, доки не зʼявиться перший.
  assert.equal(clientFullyWrittenOff({ invoices: 0, writtenOffN: 0 }), false,
    "🔴 клієнт БЕЗ рахунків (готівка) зник разом зі списаними — це різні стани");
  assert.equal(clientFullyWrittenOff(null), false);
  assert.equal(clientFullyWrittenOff(undefined), false);
});

test("#199bv роут ВИКИДАЄ такого клієнта, і саме там, де рахується видима сума", () => {
  // Предикат без виклику — це бібліотека, а не виправлення. Перевіряємо, що він
  // стоїть ПЕРЕД `visibleAmount`: інакше клієнт потрапив би в `entry.clients`,
  // а `continue` нижче вже нічого не змінив би.
  const src = strip(readFileSync(SRC("routes/dashboard.ts"), "utf8"));
  const i = src.indexOf("clientFullyWrittenOff(cf)");
  assert.ok(i > 0, "🔴 роут не кличе предикат — пʼятеро клієнтів знову в списку");
  assert.match(src.slice(i, i + 120), /continue/,
    "🔴 предикат покликаний, але клієнт усе одно додається — виклик без наслідку");
  const vis = src.indexOf("const visibleAmount");
  assert.ok(i < vis && vis - i < 400,
    "🔴 предикат стоїть не перед підрахунком видимої суми — порядок операторів тут і є поведінка");
});

test("#199bw усі лічильники екрана рахують ОДНУ множину — `all`", () => {
  // 🔴 САМЕ ТУТ НАЙЛЕГШЕ ЗАВЕСТИ ДРУГУ КОПІЮ. Заголовок «Боржники (N)» і плитка
  // «N боржників» — це ДВА місця, що показують одне число. Сьогодні обидва
  // беруть `all.length`, тож прибирання рядка у ВІДПОВІДІ лікує обидва разом.
  // Варто комусь порахувати одне з них власним виразом — і вони розійдуться
  // мовчки, як уже розходились «Команда за місяць 12%» і «Виконано 11.8%».
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.match(sec, /Боржники \(\{all\.length\}\)/,
    "🔴 заголовок рахує не `all` — зʼявилось друге джерело кількості боржників");
  assert.match(sec, /clientCount=\{all\.length\}/,
    "🔴 плитка рахує не `all` — те саме число з двох виразів");
  assert.match(sec, /const total = all\.reduce/, "🔴 сума пішла від іншої множини, ніж рядки");
  assert.match(sec, /const overdueClients = all\.filter/, "🔴 прострочка рахується не з `all`");
  // 🪞 І ЖОДЕН ІЗ НИХ НЕ РАХУЄ ВІДФІЛЬТРОВАНЕ. Це РІШЕННЯ ВЛАСНИКА з написаною
  // причиною: плитка описує стан дебіторки, а не стан фільтра; видимі рядки
  // підписані окремо під таблицею. Гейт стереже саме його, щоб «узгодити з
  // фільтром» не сталось побічним ефектом.
  assert.ok(!/clientCount=\{shown\.length\}/.test(sec),
    "🔴 плитка поїхала за фільтром — це зміна рішення власника, а не правка");
  assert.match(sec, /Видимих рядків:/, "🔴 зник підпис видимих рядків — фільтр перестав пояснювати себе");
});

// ════════ ПОПОВЕР, ЩО НЕ ВЛАЗИВ У ВІКНО (26.08.2026) ════════

test("#199bx поповер має стелю висоти й власну прокрутку — В ОБОХ редакторах", () => {
  // 🔴 МЕЖА ЦЬОГО ГЕЙТА ПЕРШИМ РЯДКОМ: він бачить СТИЛІ, а піксель бачить ЕКРАН.
  // Справжній замір зроблено в браузері на живому бандлі: редактор 300×561,
  // вікно 1600×736 → вилазив ЗНИЗУ на 213px із верхнього рядка і ЗВЕРХУ на
  // 535px із нижнього; при 900 — 535px в обидва боки. `max-height` дорівнював
  // `none`, `overflow-y` — `visible`, тобто обмеження не було взагалі, і кнопка
  // «Зберегти» лежала за екраном у ЧОТИРЬОХ випадках із чотирьох.
  // Тому в приймання входить ЗНІМОК із відкритим редактором у нижній третині —
  // саме він доводить те, чого цей гейт не бачить.
  const src = readFileSync(FE("pages/dashboard/usePopoverClamp.ts"), "utf8");
  assert.match(src, /maxHeight:\s*`calc\(100dvh/,
    "🔴 зникла стеля висоти — поповер знову виїде за екран, і кнопки підуть із ним");
  assert.match(src, /overflowY:\s*"auto"/,
    "🔴 без власної прокрутки стеля лише ОБРІЖЕ вміст: кнопки стануть недосяжні замість того, щоб гортатись");
  assert.match(src, /position:\s*"fixed"/,
    "🔴 `absolute` рахується від клітинки таблиці, а вона не знає про межі вікна — це і був дефект");
  // Затискач мусить дивитись в ОБИДВА боки: нижній рядок вилазив УГОРУ.
  assert.match(src, /top\s*=\s*aTop - h - 4/, "🔴 немає гілки «над якорем» — низ списку знову виїде вгору");
  assert.match(src, /if \(top < POPOVER_GAP\) top = POPOVER_GAP/, "🔴 немає притискання до верху");

  // 🪞 І ЩО ЙОГО СПРАВДІ ВЗЯЛИ ОБИДВА. Дефект був спільний; полагодити один і
  // лишити другий означало б розвести їх мовчки.
  for (const f of ["LimitEditor.tsx", "OwnerEditor.tsx"]) {
    const c = strip(readFileSync(FE(`pages/dashboard/sections/${f}`), "utf8"));
    assert.match(c, /usePopoverClamp\(/, `🔴 ${f} не бере спільний затискач`);
    assert.match(c, /\.\.\.clamp\.style/, `🔴 ${f} кличе затискач, але не застосовує його стиль`);
    assert.ok(!/position: "absolute", zIndex: 30/.test(c),
      `🔴 ${f}: повернулось абсолютне позиціювання без стелі — рівно те, що ховало кнопки`);
  }
});

test("#199by відмова без причини ВИДИМА, а не мовчазний disabled", () => {
  // 🔴 ВИМКНЕНА КНОПКА КОВТАЄ КЛІК БЕЗ СЛІДУ. Людина натискає — нічого не
  // стається, і немає підказки, куди дивитись. Власник: «не можу надати ліміт
  // по сумі та к-сті днів»; насправді зберегти блокувала порожня причина, і це
  // ЗАДУМ — невидимою була сама відмова.
  for (const [f, need] of [
    ["LimitEditor.tsx", "Спершу вкажіть причину"],
    ["OwnerEditor.tsx", "Спершу вкажіть причину"],
  ] as const) {
    const c = strip(readFileSync(FE(`pages/dashboard/sections/${f}`), "utf8"));
    assert.ok(c.includes(need), `🔴 ${f}: немає видимого тексту відмови — клік знову мовчить`);
    assert.match(c, /noteRef\.current\?\.focus\(\)/,
      `🔴 ${f}: відмова не ставить курсор у поле причини — сказали «чого бракує», не показавши ДЕ`);
    // Головне: кнопка більше НЕ вимикається через порожню причину.
    assert.ok(!/disabled=\{busy \|\| !noteOk/.test(c),
      `🔴 ${f}: кнопка знову вимикається порожньою причиною — тобто мовчить`);
  }
  // 🪞 ДЗЕРКАЛО: `disabled` НЕ зник зовсім. Він лишається там, де причина видима
  // в самому полі (зайнято, некоректне число) — інакше «полагодили мовчання»
  // означало б «дозволили натиснути в будь-якому стані».
  const lim = strip(readFileSync(FE("pages/dashboard/sections/LimitEditor.tsx"), "utf8"));
  assert.match(lim, /disabled=\{busy \|\| !daysOk \|\| !amtOk \|\| !anyGiven\}/,
    "🔴 зникла решта умов — форма стала приймати порожній або некоректний ліміт");
});

test("#199bz вимога стоїть НАД полем причини, а не під ним", () => {
  // 🔴 ЧОМУ ПОРЯДОК — ЦЕ ПОВЕДІНКА, А НЕ КОСМЕТИКА. Пояснення «чому кнопки
  // мертві» лежало ПІД полем, тобто рівно в тій частині поповера, що була за
  // межею екрана. Затискач висоти лікує видимість; порядок лікує читаність:
  // те, що блокує дію, мусить стояти ПЕРЕД дією.
  const c = strip(readFileSync(FE("pages/dashboard/sections/LimitEditor.tsx"), "utf8"));
  const label = c.indexOf("Обовʼязково: чому саме так");
  const field = c.indexOf("placeholder=\"Чому саме так?\"");
  assert.ok(label > 0, "🔴 зникла вимога перед полем");
  assert.ok(field > 0, "🔴 зникло поле причини");
  assert.ok(label < field, "🔴 вимога знову ПІД полем — саме там її й не було видно");
  // І дубля немає: два записи однієї вимоги читались би як дві різні.
  assert.ok(!/Обовʼязково: через місяць ліміт без причини/.test(c),
    "🔴 стара вимога лишилась під полем разом із новою — одна вимога, два тексти");
});
