import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🛑 #257–#258b — ЕКРАН НЕ СМИКАЄТЬСЯ ПІД РУКАМИ, А НАЗВИ НЕ РІЖУТЬСЯ.
 *
 * 📐 Дві скарги власника, обидві заміряні на проді 01.09.2026:
 *   ① «проблема що сам оновлюється на вкладці дебіторка залишився» —
 *      `usePolling` бампає нонс раз на 5 хв ±25% І НЕГАЙНО на кожне повернення
 *      фокуса, а ефект перезаписує дані цілком;
 *   ② «не поміщаються назви компаній, хоча місце для цього є» — обрізано
 *      29 назв клієнта з 55 і 41 імʼя менеджера з 55; «Семенюк Дмитро» не
 *      влазив у ВІСІМ пікселів (101 проти 109).
 *
 * ⚠️ МЕЖА, НАЗВАНА ВГОЛОС: DOM-харнеса в проєкті немає, тож ці гейти б'ють по
 * ЧИСТИХ ФУНКЦІЯХ, що приймають рішення, і по джерелу розмітки. Піксельну
 * частину доводить замір рамок у браузері й скріншот — не гейт.
 */

const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const FE_SPEC = (p: string) => srcOf(`../../../frontend/src/${p}`);
const FE = (p: string) => readFileSync(FE_SPEC(p), "utf8");

test("#257 поки людина зайнята — оновлення НЕ застосовується", async () => {
  const G = await import(FE_SPEC("pages/dashboard/refreshGate.ts"));

  // Дві незалежні ознаки зайнятості, і жодної не досить окремо.
  assert.equal(G.isBusy({ openEditors: 1, activeTag: null }), true,
    "🔴 відкритий поповер не рахується зайнятістю — редактор закриється під руками");
  for (const tag of ["input", "textarea", "select", "INPUT", "TextArea"]) {
    assert.equal(G.isBusy({ openEditors: 0, activeTag: tag }), true,
      `🔴 фокус у <${tag}> не рахується зайнятістю — набраний текст зникне`);
  }

  // Навіть на СТАРИХ даних зайнятість переважує: свіжість не варта втрати тексту.
  const old = { busy: true, ageMs: 60 * 60 * 1000 };
  assert.deepEqual(G.shouldApplyRefresh(old), { apply: false, reason: "busy" },
    "🔴 оновлення застосувалось попри відкритий редактор — це і є «смикається»");

  // Свіжі дані самі по собі теж не привід перемальовувати: повернення на
  // вкладку не має сенсу як подія, якщо дані щойно завантажені.
  assert.deepEqual(G.shouldApplyRefresh({ busy: false, ageMs: 1000 }),
    { apply: false, reason: "fresh" },
    "🔴 рефетч при поверненні фокуса перемальовує щойно завантажене");
});

test("#257b 🪞 ДЗЕРКАЛО: коли вільно й дані старі — оновлення ЗАСТОСОВУЄТЬСЯ", async () => {
  // 🔴 Без цієї половини «ніколи не оновлювати» було б зеленим, і ми полікували
  // б смикання, зламавши свіжість. Саме той односторонній гейт, від якого
  // застерігає правило дзеркальності.
  const G = await import(FE_SPEC("pages/dashboard/refreshGate.ts"));

  assert.equal(G.isBusy({ openEditors: 0, activeTag: null }), false,
    "🔴 порожній екран вважається зайнятим — оновлення не станеться ніколи");
  assert.equal(G.isBusy({ openEditors: 0, activeTag: "button" }), false,
    "🔴 фокус на КНОПЦІ рахується як редагування — тоді зайнято майже завжди");

  const d = G.shouldApplyRefresh({ busy: false, ageMs: G.RECEIVABLES_MIN_AGE_MS + 1 });
  assert.deepEqual(d, { apply: true, reason: null },
    "🔴 дані старіші за поріг, людина вільна — а оновлення не застосовується");

  // 🔴 МЕЖА НАЗВАНА З ОБОХ БОКІВ. Правило — «молодші ЗА поріг не застосовуємо»,
  // отже РІВНО поріг це вже «не молодші»: застосовуємо. Перша редакція цього
  // гейта стверджувала протилежне — і червоніла на правильному коді. Приклад
  // лише з одного боку межі не перевіряє межу, він перевіряє випадковість.
  assert.equal(G.shouldApplyRefresh({ busy: false, ageMs: G.RECEIVABLES_MIN_AGE_MS }).apply, true,
    "🔴 рівно поріг визнано «свіжим» — межа зсунулась на мілісекунду");
  assert.equal(G.shouldApplyRefresh({ busy: false, ageMs: G.RECEIVABLES_MIN_AGE_MS - 1 }).apply, false,
    "🔴 поріг−1 мс визнано старим — межі немає взагалі");

  // Підпис свіжості існує і НЕ порожній: ознакою оновлення має бути текст,
  // а не рух таблиці.
  assert.match(G.freshnessLabel(0), /щойно/);
  assert.match(G.freshnessLabel(7 * 60 * 1000), /7/);

  // Гейт стоїть саме на поллері дебіторки, а не на всіх: heartbeat не про дані.
  const dash = FE("pages/Dashboard.tsx");
  assert.match(dash, /shouldApplyRefresh\(\{\s*busy/,
    "🔴 рішення більше не приймає чиста функція — саботувати й перевіряти нічим");
  assert.ok((dash.match(/usePolling\(/g) ?? []).length >= 3,
    "🔴 зникли інші поллери — гейт мав звузити ОДИН, а не вимкнути оновлення всюди");
});

test("#258 назви клієнта й менеджера НЕ обрізаються стелею ширини", () => {
  const css = FE("index.css");

  // 📐 Три мертві стелі, знятих 01.09.2026 разом із причиною, що їх тримала.
  // Кожна перевіряється ОКРЕМО: спільна регулярка пропустила б повернення однієї.
  const cname = css.slice(css.indexOf(".recv-cname {"), css.indexOf("}", css.indexOf(".recv-cname {")));
  assert.ok(cname.length > 10, "🔴 правило .recv-cname зникло — гейт міряє порожнечу");
  assert.ok(!/max-width:\s*\d/.test(cname),
    "🔴 повернулась стеля ширини назви клієнта — 29 назв із 55 знову ріжуться");
  assert.ok(!/text-overflow:\s*ellipsis/.test(cname),
    "🔴 назва клієнта знову обрізається багатокрапкою замість переносу");

  const owner = css.slice(css.indexOf(".recv-ownercell {"), css.indexOf("}", css.indexOf(".recv-ownercell {")));
  assert.ok(owner.length > 10, "🔴 правило .recv-ownercell зникло");
  assert.ok(!/max-width:\s*\d+px/.test(owner),
    "🔴 повернулась стеля 139px на імені менеджера — «Семенюк Дмитро» не влазив у 8 px");

  const rowTd = css.slice(css.indexOf(".recv-table tbody > tr.recv-row > td {"),
                          css.indexOf("}", css.indexOf(".recv-table tbody > tr.recv-row > td {")));
  assert.ok(rowTd.length > 10, "🔴 правило рядка зникло");
  assert.ok(!/white-space:\s*nowrap/.test(rowTd),
    "🔴 повернувся `nowrap` — саме він і змушував різати назви");
});

test("#258b 🪞 ДЗЕРКАЛО: повний текст лишається досяжним, а числа — моноширинними", () => {
  // Без цієї половини «прибрати всі обмеження й підказки» було б зеленим:
  // назва перестала б ховатись, але й аномально довга поїхала б без жодної межі,
  // а суми втратили б вирівнювання й перестали порівнюватись очима.
  const sec = FE("pages/dashboard/sections/ReceivablesSection.tsx");
  const css = FE("index.css");

  assert.match(sec, /<span className="recv-cname" title=\{c\.clientName\}>/,
    "🔴 зник `title` з повною назвою — другого рубежу для аномально довгих назв немає");
  assert.match(css, /\.recv-table \.recv-num \{[^}]*tabular-nums/,
    "🔴 числа перестали бути моноширинними — суми більше не вишиковуються у стовпчик");

  // Закріплені краї: без них «Домовленість» і «Дії» знову підуть за край екрана
  // (заміряно: 19+535+139+116+92+206 = 1107 при контейнері 1114).
  assert.match(css, /\.recv-table th:last-child, \.recv-table td:last-child \{[\s\S]{0,80}position: sticky/,
    "🔴 колонка дій більше не закріплена — «Списати» знову за межею екрана");
  assert.match(css, /\.recv-table th:nth-child\(2\), \.recv-table td:nth-child\(2\) \{[\s\S]{0,80}left: 36px/,
    "🔴 колонка «Клієнт» більше не закріплена — при прокрутці не видно, чий це рядок");
});

/** Ширина в px із першого `min-width` названого правила; `null`, якщо правила немає. */
function minWidthOf(css: string, selector: string): number | null {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  const m = /min-width:\s*(\d+)px/.exec(css.slice(open, close));
  return m ? Number(m[1]) : null;
}

const CLIENT_COL = ".recv-table th:nth-child(2), .recv-table td:nth-child(2) { left: 36px;";

test("#259 у колонки назви є ПІДЛОГА — інакше автоверстка забирає весь дефіцит саме з неї", () => {
  // 📐 ПРИЧИНА СТРУКТУРНА, А НЕ КОСМЕТИЧНА. Заміряно при 1440 на новій розкладці:
  // підлоги були в УСІХ колонок, крім назви, тож «Клієнт» осідав до 127px, і в
  // один рядок ставала РІВНО ОДНА назва з 50 (решта — до восьми рядків, висота
  // рядка 115px проти 72 до проходу). Обрізання при цьому НЕ поверталось — тобто
  // жоден із гейтів #258/#258b цього не бачив і не міг побачити: вони стережуть
  // стелю, а тут зникла підлога.
  const css = FE("index.css");
  const floor = minWidthOf(css, CLIENT_COL);
  assert.ok(floor !== null,
    "🔴 у колонки «Клієнт» зникла підлога — назви знову осядуть до 127px і поїдуть на 8 рядків");
  assert.ok(floor >= 150,
    `🔴 підлога назви ${floor}px замала: заміряно, що нижче 150px назви ламаються на ≥5 рядків`);
});

test("#259b 🪞 ДЗЕРКАЛО: підлога назви не зʼїдає колонку коментаря і не повертає скрол", () => {
  // 🔴 БЕЗ ЦІЄЇ ПОЛОВИНИ ГЕЙТ #259 ЗЕЛЕНІВ БИ НА ПІДЛОЗІ 400px — тобто на
  // розкладці, де назва видна чудово, коментар задавлено, а таблиця знову їде за
  // край. Обидві величини живуть з ОДНОГО бюджету (заміряно: 1138px доступних при
  // вікні 1440), тому й перевіряти їх треба разом, а не поодинці.
  const css = FE("index.css");
  const floor = minWidthOf(css, CLIENT_COL);
  const agree = minWidthOf(css, ".recv-agree {");

  assert.ok(floor !== null && floor <= 165,
    `🔴 підлога назви ${floor}px більша за заміряну стелю 165px — при 170px переповнення вже +3px, тобто скрол повертається`);
  assert.ok(agree !== null && agree >= 180,
    `🔴 колонка «Домовленість» лишилась без власної підлоги (${agree}) — назву полагодили б коштом коментаря, а це і була ПЕРВІСНА скарга`);
  assert.ok(agree !== null && agree <= 210,
    `🔴 підлога коментаря ${agree}px завелика: при 232px колонці назви лишалось 127px — саме той стан, від якого лікувались`);
});
