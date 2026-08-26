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
  assert.match(sec, /Разом по \{inv\.length\}/, "🔴 зник підсумковий рядок групи");
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
  const inv = route.slice(route.indexOf('"/receivables/invoices"'), route.indexOf('"/receivables/invoices"') + 5000);
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
  { name: "avgCheck", why: "ВІДКРИТЕ ПИТАННЯ до власника: очікуваний середній чек — це СЕРЕДНЄ, а не сума. Рішення 26.08.2026 стосувалось «очікуваних КОШТІВ»; чи виходить списана угода зі знаменника чека — не наше рішення" },
  { name: "avgCheckByTeam", why: "той самий очікуваний чек у розрізі команд — питання спільне з avgCheck, і відповідь на нього мусить бути одна на всі три розрізи, інакше команда й компанія рахуватимуть чек по-різному" },
  { name: "avgCheckPerManager", why: "той самий очікуваний чек у розрізі менеджерів — вносити предикат лише сюди означало б, що Σ по людях перестане сходитись із компанією; рішення потрібне одне на всі три" },
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
  const out: { file: string; name: string; zones: string[]; hasPredicate: boolean }[] = [];
  for (const f of ["core/metrics.ts", "core/money.ts"]) {
    const s = read(f);
    const heads = [...s.matchAll(/^export (?:async )?(?:function|const|interface|type) (\w+)/gm)];
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].index!;
      const end = i + 1 < heads.length ? heads[i + 1].index! : s.length;
      const raw = s.slice(start, end);
      if (!/^export (?:async )?function/.test(raw)) continue;
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const zones = EXPECTED_MONEY_ZONES.filter((z) => new RegExp(`\\b${z}\\b`).test(code));
      if (zones.length) out.push({ file: f, name: heads[i][1], zones, hasPredicate: /\bDEAL_NOT_WRITTEN_OFF\b/.test(code) });
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
