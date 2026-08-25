import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsApi } from "../testMode.js";

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
  const total = tiles.slice(tiles.indexOf("Загальний борг"), tiles.indexOf("Прострочено"));
  assert.match(total, /<Bar/, "🔴 «Загальний борг» знову без розкладу");
  assert.match(total, /<Legend/, "🔴 «Загальний борг» має смужку без підписів — колір без пояснення");
  const over = tiles.slice(tiles.indexOf("Прострочено"), tiles.indexOf("Перевізник оплачений"));
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

test("#200 у розкритті — НАША юрособа по кожному рахунку, і «невідомо» з причиною", () => {
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

test("#201 лінк на угоду ЛИШЕ там, де угода є", () => {
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

test("#202 ряд фільтрів переноситься, а не вилазить за екран", () => {
  // Успадковано з Е6-полірування: `display:flex` без переносу тисне елементи в
  // один рядок будь-якої ширини, і на вузькому екрані останній фільтр опинявся
  // за межею видимої області — ані видно, ані натиснути.
  const css = readFileSync(FE("index.css"), "utf8");
  const block = css.slice(css.indexOf(".page-filters"), css.indexOf(".page-filters") + 400);
  assert.match(block, /flex-wrap:\s*wrap/, "🔴 фільтри знову в один нерозривний ряд");
});

test("#203 FK-помилка називає ТУ колонку, що впала", async () => {
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

test("#205 «угоди немає» читається як «не знаємо», а не як «перевізник не оплачений»", async () => {
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

test("#206 сума виплати читається ЗА ТИПОМ, і складена — це СУМА ОБОХ", async () => {
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

test("#207 стеля 250 кидає, а не обрізає мовчки", async () => {
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

test("#208 «суму не вказано» — окремий стан, а не нуль і не «не оплачено»", async () => {
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

test("#209 фільтр «н/д, що лагодиться» бере ПРИЧИНУ, а не стан", async () => {
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

test("#210 шапка розкриття липка — інакше прокрутка лишає колонки без назв", () => {
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

test("#211 жоден розмір шрифту в дебіторці не поза набором --fs-*", () => {
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

test("#212 висоту рядка тримає ОДИН рядок, а не другий під контролом", () => {
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
