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
  assert.match(sec, /carrierCell\(x\.carrierPaid, x\.carrierReason\)/,
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
