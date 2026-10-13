import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { offerDate } from "./offerDate.js";
import { zoneRecommendation } from "../core/zoneRates.js";

/**
 * 🧮 КАЛЬКУЛЯТОР СТАВОК ПІСЛЯ ПОВЕРНЕННЯ LARDI (13.10.2026): дата пропозиції й українська мова довідників.
 */
const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const SRC = (p: string) => readFileSync(srcOf(`../${p}`), "utf8");
const FE = (p: string) => readFileSync(srcOf(`../../../frontend/src/${p}`), "utf8");

test("#1670 ДАТА ПРОПОЗИЦІЇ: мілісекунди Lardi і секунди архіву → одна київська дата; сміття — порожньо, а не число", () => {
  // 13.10.2026 00:00 UTC — так Lardi віддає `dateFrom` (мс); архів `lardi_offers.dt` — ті самі секунди рядком.
  assert.equal(offerDate(1791849600000), "2026-10-13", "🔴 мілісекунди Lardi не стали датою (було «1791849600» на екрані)");
  assert.equal(offerDate("1791849600"), "2026-10-13", "🔴 секунди з архіву не стали датою — «За тиждень / За місяць» лишились би з числами");
  assert.equal(offerDate("2026-10-13T08:00:00"), "2026-10-13");
  // Межа доби — за Києвом, по обидва боки: 21:30 UTC 12.10 = 00:30 13.10 Київ; 20:30 UTC 12.10 = 23:30 12.10 Київ.
  assert.equal(offerDate(Date.UTC(2026, 9, 12, 21, 30)), "2026-10-13", "🔴 дата за UTC, а не за Києвом");
  assert.equal(offerDate(Date.UTC(2026, 9, 12, 20, 30)), "2026-10-12");
  for (const bad of [null, undefined, "", "договірна", "12", 0]) assert.equal(offerDate(bad), "", `🔴 «${String(bad)}» прочитано як дату`);
});

test("#1670b ДАТА В ЛАНЦЮГУ: жива пропозиція і архів ідуть через offerDate, екран показує «13.10», а не сирий рядок", async () => {
  process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:1/x";
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  // Поведінкою: бойовий `toOffer` на сирій пропозиції Lardi (пул імпортується, але не зʼєднується).
  const { toOffer } = await import("../routes/rates.js");
  const o = toOffer({ id: 1, dateFrom: 1791849600000, payment: { value: 25000, currency: { name: "грн." } }, size: { mass: 22 } }, 500);
  assert.equal(o.date, "2026-10-13", "🔴 toOffer віддав не дату");
  assert.match(SRC("lardi/history.ts"), /date: offerDate\(x\.dt\)/, "🔴 архів віддає сирі секунди — вкладки «За тиждень / За місяць» з числами");
  const fe = FE("pages/dashboard/sections/RatesSection.tsx");
  assert.match(fe, /\{offerDay\(s\.date\)\}/, "🔴 колонка «Дата» показує сирий рядок");
  assert.doesNotMatch(fe, /\{s\.date \|\| ""\}/, "🔴 сирий рядок дати повернувся в таблицю");
});

// Довідник областей Lardi, знятий з прода 13.10.2026: [ru, uk] для кожної області України.
const AREAS: [string, string][] = [["Винницкая обл.", "Вінницька обл."], ["Волынская обл.", "Волинська обл."], ["Днепропетровская обл.", "Дніпропетровська обл."], ["Донецкая обл.", "Донецька обл."], ["Житомирская обл.", "Житомирська обл."], ["Закарпатская обл.", "Закарпатська обл."], ["Запорожская обл.", "Запорізька обл."], ["Ивано-Франковская обл.", "Івано-Франківська обл."], ["Киевская обл.", "Київська обл."], ["Кировоградская обл.", "Кіровоградська обл."], ["Крым Авт. Респ.", "Крим Авт. Респ."], ["Луганская обл.", "Луганська обл."], ["Львовская обл.", "Львівська обл."], ["Николаевская обл.", "Миколаївська обл."], ["Одесская обл.", "Одеська обл."], ["Полтавская обл.", "Полтавська обл."], ["Ровненская обл.", "Рівненська обл."], ["Сумская обл.", "Сумська обл."], ["Тернопольская обл.", "Тернопільська обл."], ["Харьковская обл.", "Харківська обл."], ["Херсонская обл.", "Херсонська обл."], ["Хмельницкая обл.", "Хмельницька обл."], ["Черкасская обл.", "Черкаська обл."], ["Черниговская обл.", "Чернігівська обл."], ["Черновицкая обл.", "Чернівецька обл."]];
const zoneOf = (area: string) => zoneRecommendation(area, area, 20, 500)?.zone ?? null;

test("#1670c УКРАЇНСЬКА МОВА LARDI: за замовчуванням «uk»; зонна карта впізнає кожну область, крім окупованих; відмова 403 впізнається обома мовами", () => {
  assert.match(SRC("config.ts"), /lang: process\.env\.LARDIWEB_LANG \?\? "uk"/, "🔴 Lardi знову просять російською («Киев», «Цельномет»)");
  const unknown = AREAS.filter(([, uk]) => zoneOf(uk) == null).map(([, uk]) => uk);
  assert.deepEqual(unknown, ["Донецька обл.", "Крим Авт. Респ.", "Луганська обл."], "🔴 українська назва області не дає зони — рекомендація зникне");
  // Перехід не змінює зону жодної області, яку впізнавала російська назва (решта — дві, які «ru» губила).
  const moved = AREAS.filter(([ru, uk]) => zoneOf(ru) != null && zoneOf(ru) !== zoneOf(uk));
  assert.deepEqual(moved, [], "🔴 зміна мови переставила область в іншу зону");
  // Плашка «пакет Lardi не оплачено»: текст відмови приходить мовою запиту.
  const m = FE("pages/dashboard/sections/RatesSection.tsx").match(/const lardiOff = [^\n]*\n[^\n]*\.test\(side\.detail/);
  assert.ok(m, "🔴 перевірки відмови Lardi у калькуляторі немає");
  const re = new RegExp(m[0].match(/&& \/(.+)\/i\.test\(side\.detail/)![1], "i");
  assert.ok(re.test("Метод доступний лише при підключенні пакета «Розширений доступ до API»"), "🔴 українська відмова 403 не впізнається — калькулятор не скаже, що пакет не оплачено");
  assert.ok(re.test("Метод доступен только при подключении пакета «Расширенный доступ к API»"), "🔴 російська відмова 403 перестала впізнаватись");
  assert.ok(!re.test("Lardi 403 Forbidden"), "🔴 будь-яка 403 читається як «пакет не оплачено»");
});

test("#1671 ЦІНА «ЗА Т»: Lardi пише одиницю «т» — це ставка за тонну (× вага), а не сума за рейс; «за км» і без одиниці — як були", async () => {
  process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:1/x";
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { toOffer } = await import("../routes/rates.js");
  // Сира пропозиція з прода 13.10.2026: соняшникова олія Київ → Львів, 25 т, «2 200 грн. за т», 537 км.
  const raw = (value: number, unit: string | null, mass: number | null) => ({
    id: 1, payment: { value, currency: { name: "грн." }, ...(unit ? { unit: { name: unit } } : {}) },
    size: mass == null ? {} : { mass }, distanceLine: 537_000,
  });
  const t = toOffer(raw(2200, "т", 25), null);
  assert.equal(t.total, 55_000, "🔴 «2 200 грн за т × 25 т» прочитано як 2 200 грн за рейс");
  assert.equal(t.per_ton, 2200); assert.equal(t.per_km, 102);
  assert.equal(toOffer(raw(2200, "т.", 25), null).total, 55_000);
  assert.equal(toOffer(raw(2200, "тонна", 25), null).total, 55_000);
  // Без ваги суми рейсу не вигадуємо: лише ставка за тонну.
  const noMass = toOffer(raw(2200, "т", null), null);
  assert.equal(noMass.total, null, "🔴 без ваги ставку за тонну видано за суму рейсу"); assert.equal(noMass.per_ton, 2200);
  // Дзеркало: інші одиниці не зачеплено.
  assert.deepEqual([toOffer(raw(30, "км", 22), null).per_km, toOffer(raw(30, "км", 22), null).total], [30, 16_110], "🔴 «за км» зламано");
  assert.equal(toOffer(raw(25_000, null, 22), null).total, 25_000, "🔴 ціна без одиниці (за рейс) перестала бути сумою");
});
