import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsApi, needsDb } from "../testMode.js";

const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const SRC = (p: string) => srcOf(`../${p}`);
const FE = (p: string) => srcOf(`../../../frontend/src/${p}`);
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
  const css = readFileSync(FE("index.css"), "utf8");
  const block = css.slice(css.indexOf(".recv-detail"), css.indexOf(".recv-detail") + 400);
  assert.ok(block.length > 0, "🔴 стилю .recv-detail немає — рамки й прокрутки не буде");
  assert.match(block, /max-height/, "🔴 розкриття знову без стелі висоти");
  assert.match(block, /overflow:\s*auto/, "🔴 розкриття без прокрутки — стеля просто обріже рядки");
  assert.match(block, /border/, "🔴 розкриття без власної рамки — воно зливається з таблицею");

  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.match(sec, /className="recv-detail"/, "🔴 блок розкриття не має класу — стиль ні до чого не застосується");
  // Шапка з підсумком: скільки рахунків, на скільки, і який найстаріший.
  assert.match(sec, /Рахунки клієнта/, "🔴 у розкритті немає шапки");
  assert.match(sec, /найстаріший/, "🔴 у шапці немає віку найстарішого рахунку");
});

test("#199 два рівні полів названі ПО-РІЗНОМУ, бо означають різне", () => {
  // 🔴 БІЗНЕС-СЕНС, не косметика. Угорі — домовленість із КЛІЄНТОМ загалом;
  // у розкритті — строк по КОНКРЕТНОМУ рахунку, від якого створюється задача
  // менеджеру. Поки обидві пари звались однаково («дата оплати» / «коментар»),
  // людина не бачила, що дії різні. Той самий клас, що два «очікуємо» під одним
  // підписом і «сер.чек» від двох знаменників.
  const sec = strip(readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8"));
  assert.match(sec, /Обіцяна дата/, "🔴 верхній рівень знову зветься «дата оплати»");
  assert.match(sec, /Домовленість з клієнтом/, "🔴 верхній коментар не підписаний як домовленість із клієнтом");
  assert.match(sec, /Дедлайн оплати/, "🔴 у розкритті зник дедлайн по рахунку");
  assert.match(sec, /Коментар до рахунка/, "🔴 коментар у розкритті не підписаний як «до рахунка»");
  // Дзеркало: підписи мусять ВІДРІЗНЯТИСЬ, а не просто існувати.
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

  // Колонки чипів дістали ширину: вони МАЛИ `flex-wrap` і без неї, тож переносило
  // їх не відсутнє правило, а 95px на «Юрособу». Це одна причина, не дві.
  // ⚠️ Шукаємо САМ елемент, а не зріз за відступом у символах: `strip()` знімає
  // коментарі й зсуває офсети, тож перша редакція цієї перевірки падала на
  // власній крихкості, а не на дефекті.
  // 🔴 «Перевізник» є У ДВОХ таблицях — у рядку клієнта і в розкритті. Перша
  // редакція брала `.match()` без розрізнення й влучала в ту, що в файлі раніше,
  // тобто перевіряла не ту колонку. Розрізняємо за ПІДПИСОМ, а не за порядком.
  const CHIP_COLS = [
    { col: "Юрособа", title: "Наша юрособа, від якої виставлено" },
    { col: "Перевізник", title: "Чи оплачено перевізника по угоді рахунку" },
  ];
  for (const { col, title } of CHIP_COLS) {
    const th = [...sec.matchAll(new RegExp(`<th[^>]*>${col}</th>`, "g"))]
      .map((m) => m[0]).find((t) => t.includes(title));
    assert.ok(th, `🔴 колонки «${col}» рядка клієнта немає в шапці`);
    assert.match(th!, /width:\s*1[0-9]{2}/,
      `🔴 колонці «${col}» знову бракує ширини — чипи мають flex-wrap і без неї посиплються в стовпчик`);
  }
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
