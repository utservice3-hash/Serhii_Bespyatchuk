import { test } from "node:test";
import assert from "node:assert/strict";
import { MANIFEST_TESTS, collidingNumbers, KNOWN_NUMBER_COLLISIONS, gateNames, diffGates,
  acceptRetired, RETIRED_GATES, type RetiredGate } from "./testManifest.js";
import { parseManifestTests, treeTests, freshManifest, bustToken } from "./tools/gateCount.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 🔢 #223–#223b — ОДИН НОМЕР = ОДИН ГЕЙТ.
 *
 * Привід і механізм — у коментарі до `collidingNumbers`. Тут важливе інше:
 * 🔴 ПОВІДОМЛЕННЯ МУСИТЬ НАЗВАТИ ОБОХ ВЛАСНИКІВ. Гейт, що каже лише «номер #30
 * зайнятий двічі», повторив би ваду, на якій ми спіймались того ж дня: вартовий
 * правильно відмовляв, а підказкою вів перевіряти `.env`, поки вмирали файли.
 * Той, хто читає падіння, має бачити ОБИДВА імені й одразу знати, що перейменувати.
 */

test("#223 новий номер не зіштовхується з уже зайнятим", () => {
  const found = collidingNumbers(MANIFEST_TESTS);
  const known = new Set(KNOWN_NUMBER_COLLISIONS);
  const fresh = [...found].filter(([tok]) => !known.has(tok));

  assert.deepEqual(fresh.map(([tok]) => tok), [],
    "🔴 НОВЕ ЗІТКНЕННЯ НОМЕРІВ:\n"
    + fresh.map(([tok, names]) =>
        `   ${tok} — ${names.length} власники:\n` + names.map((n) => `      • ${n}\n`).join(""))
        .join("")
    + "   Номер у виводі падіння — це адреса. Дай новому гейту вільний номер\n"
    + "   і онови testManifest; якщо зіткнення свідоме — внеси його в\n"
    + "   KNOWN_NUMBER_COLLISIONS з поясненням.");
});

test("#223b ДЗЕРКАЛО: гейт ловить підкинуте зіткнення, а реєстр не є смітником", () => {
  // 1 · 🧨 САБОТАЖ: підкидаємо новий дубль — мусить бути помічений і НАЗВАНИЙ.
  const sabotage = [...MANIFEST_TESTS, "#222 інший гейт із тим самим номером"];
  const found = collidingNumbers(sabotage);
  assert.ok(found.has("#222"), "🔴 підкинуте зіткнення не помічене — гейт вироджений");
  assert.equal(found.get("#222")!.length, 2);
  // обидва власники мусять бути в переліку, інакше повідомлення не скаже, що робити
  assert.ok(found.get("#222")!.some((n) => n.includes("мертвий контейнер")),
    "🔴 у переліку немає ПЕРШОГО власника — читач не дізнається, з чим зіткнувся");

  // 2 · ТОКЕНІЗАЦІЯ: крапкові підномери й суфікси з цифрою — це РІЗНІ гейти.
  const distinct = collidingNumbers(["#5.1 а", "#5.2 б", "#99b в", "#99b2 г"]);
  assert.deepEqual([...distinct.keys()], [],
    "🔴 #5.1/#5.2 або #99b/#99b2 прочитано як один номер — на такій токенізації "
    + "гейт дав би 16 фальшивих зіткнень і його б вимкнули");

  // 3 · РЕЄСТР НЕ СМІТНИК: кожен запис досі має бути справжнім зіткненням.
  const real = collidingNumbers(MANIFEST_TESTS);
  const dead = KNOWN_NUMBER_COLLISIONS.filter((t) => !real.has(t));
  assert.deepEqual(dead, [],
    `🔴 у реєстрі є мертві записи: ${dead.join(", ")}. Зіткнення розчищене — прибери рядок, `
    + "інакше він тихо дозволить НОВЕ зіткнення на тому самому номері.");
});

test("#223c РАХУНОК ГЕЙТІВ · зниклий гейт називається ІМЕНЕМ, а не дельтою", () => {
  // 🔴 Критерій приймання — НЕ «число не впало». Число росте й тоді, коли хтось
  // тихо виніс гейт сусіда, а свої додав. Тому `diffGates` віддає імена.
  const before = ["#42 A", "#43 B", "не гейт"];
  const d = diffGates(before, ["#43 B", "#99 C"]);
  assert.deepEqual(d.onlyBefore, ["#42 A"], "🔴 зниклий гейт не названо — приймання осліпло");
  assert.deepEqual(d.onlyAfter, ["#99 C"]);
  assert.equal(d.countBefore, 2, "🔴 у рахунок потрапило те, що не є гейтом");
  // Дзеркало: однакові списки не мусять давати «зникло».
  assert.deepEqual(diffGates(before, before).onlyBefore, [], "🔴 детектор червоніє на тотожності");
  assert.ok(gateNames().length > 500, "рахунок по реальному маніфесту виродився");
});

test("#223d РАХУНОК ГЕЙТІВ · екрановану лапку розекрановано, інакше гейт «зник і додався»", () => {
  // 📐 Спіймано на живому #159c: у джерелі стоїть `роз\'єднати`, і без розекранування
  // той самий гейт читався ОДНОЧАСНО як зниклий і як доданий. Тобто інструмент,
  // створений заради «не втратити гейт», сам вигадував втрату.
  const src = 'export const MANIFEST_TESTS: string[] = [\n  "#1 СЕО може роз\\\'єднати",\n  "#2 звичайний",\n];\n';
  assert.deepEqual(parseManifestTests(src), ["#1 СЕО може роз'єднати", "#2 звичайний"]);
  assert.deepEqual(diffGates(parseManifestTests(src), ["#1 СЕО може роз'єднати", "#2 звичайний"]).onlyBefore, [],
    "🔴 розбір і живий маніфест дають різні імена — інструмент вигадує втрату");
  // Порожній результат = провал: розбір мусить ГОЛОСНО падати, а не віддавати [].
  assert.throws(() => parseManifestTests("нічого схожого", "фікстура"), /не знайшов MANIFEST_TESTS/,
    "🔴 зламаний розбір віддав порожній список — це читалось би як «гейтів немає»");
});

/**
 * 🧭 #326–#326b — ДЕРЕВО В `gateCount` БЕРЕТЬСЯ З ДЖЕРЕЛА, А НЕ З `dist`.
 *
 * 📐 Привід і межі — у доккоментарі `treeTests`. Тут важлива форма перевірки:
 * 🔴 ФІКСТУРА МУСИТЬ РОЗХОДИТИСЬ ІЗ ЗІБРАНИМ МАНІФЕСТОМ, інакше гейт зеленів би й на
 * реалізації, що повернулась до `MANIFEST_TESTS` — обидва джерела дали б те саме, і
 * перевірка доводила б лише «функція щось повертає» (правило 11).
 */
const FIXTURE = (names: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "gatecount-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "testManifest.ts"),
    "export const MANIFEST_TESTS: string[] = [\n"
    + names.map((n) => `  ${JSON.stringify(n)},\n`).join("") + "];\n");
  return dir;
};

test("#326 дерево читається з ДЖЕРЕЛА — фікстура перемагає зібраний маніфест", () => {
  const dir = FIXTURE(["#901 вигаданий гейт фікстури", "#902 другий", "не гейт"]);
  try {
    const got = treeTests(dir);
    assert.deepEqual(got, ["#901 вигаданий гейт фікстури", "#902 другий", "не гейт"],
      "🔴 повернуто не те, що лежить у ДЖЕРЕЛІ фікстури");
    // 🧨 Осердя: якби реалізація читала `dist`, тут був би бойовий маніфест на 800+.
    assert.ok(!got.some((n) => MANIFEST_TESTS.includes(n)),
      "🔴 у відповіді імена БОЙОВОГО маніфеста — тобто дерево знову береться з dist, "
      + "і хибне «зникло N гейтів» від несвіжої збірки повертається");
    assert.ok(got.length < 10, `🔴 замість фікстури прочитано щось на ${got.length} імен`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#326b 🪞 ДЗЕРКАЛО: відсутнє джерело ПАДАЄ з іменем файлу, справжнє дерево читається", () => {
  // 1 · Порожній результат = провал: «немає файлу» не сміє прочитатись як «гейтів немає».
  const empty = mkdtempSync(join(tmpdir(), "gatecount-порожньо-"));
  try {
    assert.throws(() => treeTests(empty), /не прочитав маніфест дерева.*testManifest\.ts/s,
      "🔴 відсутнє джерело віддало список замість падіння — це читалось би як втрата ВСІХ гейтів");
  } finally { rmSync(empty, { recursive: true, force: true }); }
  // 2 · Другий бік межі: на СПРАВЖНЬОМУ дереві функція не падає й не вироджується —
  // інакше перша половина зеленіла б від того, що вона падає завжди.
  const real = treeTests();
  assert.ok(gateNames(real).length > 500,
    `🔴 на бойовому дереві прочитано лише ${gateNames(real).length} гейтів`);
  // 3 · І воно збігається зі зібраним маніфестом ПРЯМО ЗАРАЗ: розбіжність тут означає
  // або несвіжий dist, або що розбір джерела втратив рядки. Обидва варіанти — стоп.
  assert.deepEqual(diffGates(real, MANIFEST_TESTS).onlyBefore, [],
    "🔴 джерело й зібраний маніфест розійшлись — перезбери dist перед висновками");
});

/**
 * 🧭 #328–#328b — РЕЄСТР ЗНЯТИХ БЕРЕТЬСЯ ЗІ СВІЖОЇ ЗБІРКИ, А НЕ З ПАМʼЯТІ ПРОЦЕСУ.
 *
 * 📐 Привід — у доккоментарі `freshManifest`: `deploy.js` виконується з `dist`, який сам
 * зносить кроком `buildBack`, тож усі його верхньорівневі імпорти лишаються старими.
 * Законне зняття гейта через це читалось як диверсія РІВНО ОДИН РАЗ і зникало з другого
 * запуску — тобто виглядало флаком.
 *
 * 🔴 ФІКСТУРА МУСИТЬ ЗМІНИТИСЬ МІЖ ДВОМА ВИКЛИКАМИ. Інакше «свіжий» і «з памʼяті» дали б
 * те саме, і гейт доводив би лише, що функція щось повертає.
 */
const distFixture = (names: string[], retired: string[], into?: string): string => {
  // 🔴 `into` — НЕ зручність, а суть гейта. Кеш модулів Node вʼяжеться до ШЛЯХУ, тож
  // фікстура у НОВОМУ каталозі імпортується свіжою й БЕЗ обходу кешу: саботаж
  // «прибрати ?bust=» лишав гейт зеленим, поки я не переписав його на ПЕРЕЗАПИС
  // ТОГО САМОГО файлу. Реальний `buildBack` робить саме це — перезбирає `dist` на місці.
  const dir = into ?? mkdtempSync(join(tmpdir(), "fresh-"));
  if (!into) { mkdirSync(join(dir, "src")); mkdirSync(join(dir, "dist")); }
  const body = names.map((n) => `  ${JSON.stringify(n)},\n`).join("");
  writeFileSync(join(dir, "src", "testManifest.ts"),
    `export const MANIFEST_TESTS: string[] = [\n${body}];\n`);
  writeFileSync(join(dir, "dist", "testManifest.js"),
    `export const MANIFEST_TESTS = [\n${body}];\n`
    + `export const RETIRED_GATES = ${JSON.stringify(
      retired.map((n) => ({ name: n, since: "2026-09-03", reason: "фікстура" })))};\n`
    + "export const diffGates = (b, a) => ({ onlyBefore: b.filter(x => !a.includes(x)),"
    + " onlyAfter: a.filter(x => !b.includes(x)), countBefore: b.length, countAfter: a.length });\n"
    + "export const acceptRetired = (lost, alive) => {\n"
    + "  const known = new Set(RETIRED_GATES.map(r => r.name));\n"
    + "  return { problems: [], accepted: lost.filter(x => known.has(x)),"
    + " unaccounted: lost.filter(x => !known.has(x)) };\n};\n");
  return dir;
};

test("#328c токен обходу кешу УНІКАЛЬНИЙ у межах однієї мілісекунди", () => {
  // 📐 Куплено живим прийманням 03.09.2026: токеном був `Date.now()`, а `#328` виконується
  // за 2.4 мс — на швидкому хості обидва виклики лягли в ОДНУ мілісекунду, URL збігся, кеш
  // модулів віддав старий модуль. У повільнішому контейнері це не відтворювалось НІКОЛИ,
  // тобто дефект був невидимий саме там, де його перевіряли.
  //
  // 🔴 Тому твердження — не «зазвичай різні», а «різні ЗАВЖДИ»: беремо пачку підряд, у
  // межах одного тіку, і вимагаємо стільки ж УНІКАЛЬНИХ значень, скільки викликів.
  const many = Array.from({ length: 200 }, () => bustToken());
  assert.equal(new Set(many).size, many.length,
    "🔴 токени повторюються в межах тіку — обхід кешу модулів працює лише поки хост повільний, "
    + "а на швидкому мовчки віддає СТАРИЙ модуль");
});

test("#328 реєстр зняття береться зі СВІЖОГО dist — перезбірка між викликами видима", async () => {
  const dir = distFixture(["#901 живий"], []);
  try {
    const first = await freshManifest(dir);
    assert.deepEqual(first.RETIRED_GATES.map((r) => r.name), [],
      "🔴 фікстура стартувала не з порожнього реєстру — вимір нічого не покаже");
    // 🧨 Осердя: перезбірка ТОГО САМОГО файлу в тому самому процесі — рівно те, що
    // робить крок `buildBack`. Без обходу кешу модулів другий імпорт віддасть перший.
    distFixture(["#901 живий"], ["#902 знятий у цьому ж проході"], dir);
    const second = await freshManifest(dir);
    assert.deepEqual(second.RETIRED_GATES.map((r) => r.name), ["#902 знятий у цьому ж проході"],
      "🔴 повернувся реєстр із КЕШУ модулів — саме тут законне зняття читається як диверсія");
    // І вирок на законному знятті мусить бути «дозволено», а не «unaccounted».
    const v = second.acceptRetired(["#902 знятий у цьому ж проході"], ["#901 живий"]);
    assert.deepEqual(v.unaccounted, [], "🔴 законне зняття все одно спиняє ланцюг");
    assert.deepEqual(v.accepted, ["#902 знятий у цьому ж проході"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#328b 🪞 ДЗЕРКАЛО: dist, що розійшовся з джерелом, — це СТОП, а не мовчазний вирок", async () => {
  // Джерело має два гейти, dist — один: рівно стан «забули перезібрати».
  const dir = mkdtempSync(join(tmpdir(), "fresh-stale-"));
  try {
    mkdirSync(join(dir, "src")); mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "src", "testManifest.ts"),
      'export const MANIFEST_TESTS: string[] = [\n  "#901 живий",\n  "#903 доданий у джерелі",\n];\n');
    writeFileSync(join(dir, "dist", "testManifest.js"),
      'export const MANIFEST_TESTS = [\n  "#901 живий",\n];\nexport const RETIRED_GATES = [];\n'
      + "export const diffGates = () => ({ onlyBefore: [], onlyAfter: [], countBefore: 0, countAfter: 0 });\n"
      + "export const acceptRetired = () => ({ problems: [], accepted: [], unaccounted: [] });\n");
    await assert.rejects(() => freshManifest(dir), /РОЗІЙШОВСЯ З ДЖЕРЕЛОМ.*#903 доданий у джерелі/s,
      "🔴 несвіжий dist прийнято мовчки — тоді вирок про зниклі гейти виноситься за двома "
      + "різними моментами часу, і це рівно та аварія, яку крок мав ловити");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // 🪞 Другий бік межі: на ЗБІЖНИХ джерелі й dist функція не кидає — інакше вона
  // падала б завжди, і перша половина зеленіла б ні від чого.
  const ok = distFixture(["#901 живий"], []);
  try {
    const m = await freshManifest(ok);
    assert.deepEqual(m.MANIFEST_TESTS, ["#901 живий"], "🔴 на збіжній парі функція не віддала маніфест");
  } finally { rmSync(ok, { recursive: true, force: true }); }
});

/**
 * 🗑 #235–#235d — РЕЄСТР СВІДОМО ЗНЯТИХ ГЕЙТІВ.
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ: 01.09.2026 викат `4b8627a` став намертво на кроці 0. Гейт
 * `#46` знято за рішенням власника (твердження змінилось на СКЛАД, правило 13 —
 * новий номер), крок 0 назвав зникнення ПОІМЕННО і правильно, і однаково відмовив:
 * оголосити зняття законним не було чим. Правило зобовʼязувало зробити те, що
 * процедура забороняла.
 *
 * ⚠️ ГОЛОВНЕ ТУТ — НЕ ДОЗВІЛ, А ЙОГО МЕЖА. Реєстр, який дозволяє оголосити знятим
 * ЖИВИЙ гейт, гірший за відсутній: під таким записом наступне справжнє зникнення
 * пройшло б мовчки. Тому нижче кожне твердження має ОБИДВА боки межі.
 */
const R = (o: Partial<RetiredGate> = {}): RetiredGate =>
  ({ name: "#46 факт тижня ≤ факт місяця", since: "2026-09-01", reason: "замінений на #46c за правилом 13", ...o });

test("#235 РЕЄСТР приймає зняття ПОІМЕННО — і лише його", () => {
  const alive = ["#46c склад угод", "#99 інший"];
  const v = acceptRetired(["#46 факт тижня ≤ факт місяця"], alive, [R()]);
  assert.deepEqual(v.problems, [], "🔴 законний запис оголошено дефектним");
  assert.deepEqual(v.accepted, ["#46 факт тижня ≤ факт місяця"]);
  assert.deepEqual(v.unaccounted, [], "🔴 дозволене зникнення все одно спиняє ланцюг");
});

test("#235b 🔴 ДЗЕРКАЛО: дозвіл ПОІМЕННИЙ — чуже зникнення реєстр НЕ покриває", () => {
  // Саме той випадок, який робить реєстр ковдрою: під одним дозволом тихо їде друге.
  const v = acceptRetired(["#46 факт тижня ≤ факт місяця", "#77 чужий гейт"], ["#46c склад угод"], [R()]);
  assert.deepEqual(v.accepted, ["#46 факт тижня ≤ факт місяця"]);
  assert.deepEqual(v.unaccounted, ["#77 чужий гейт"],
    "🔴 незаявлене зникнення проїхало під чужим дозволом — реєстр став ковдрою");
  // І дзеркало до дзеркала: якщо в реєстрі ІНШЕ імʼя, ніж зникло, не покривається НІЧОГО.
  const other = acceptRetired(["#46 факт тижня ≤ факт місяця"], ["#46c"], [R({ name: "#47 щось інше" })]);
  assert.deepEqual(other.accepted, [], "🔴 дозвіл на #47 покрив зникнення #46");
  assert.deepEqual(other.unaccounted, ["#46 факт тижня ≤ факт місяця"]);
});

test("#235c 🔴 ЗАПИС ПРО ЖИВИЙ ГЕЙТ — ЧЕРВОНЕ, і це гірша помилка за незаявлене зникнення", () => {
  const alive = ["#46 факт тижня ≤ факт місяця", "#46c склад угод"];   // гейт ЖИВИЙ у дереві
  const v = acceptRetired([], alive, [R()]);
  assert.equal(v.problems.length, 1, "🔴 реєстр оголосив знятим гейт, який зараз у дереві");
  assert.match(v.problems[0], /ЖИВИЙ/);
  assert.deepEqual(v.accepted, [], "🔴 дефектний запис усе одно щось дозволив");
  // 🪞 Друга сторона межі: той самий запис при ВІДСУТНЬОМУ гейті — законний.
  assert.deepEqual(acceptRetired([], ["#46c склад угод"], [R()]).problems, [],
    "🔴 перевірка червоніє завжди — тоді вона не про «живий», а про сам факт запису");
});

test("#235d ЗАПИС БЕЗ ПРИЧИНИ (або без дати) не приймається", () => {
  assert.match(acceptRetired([], [], [R({ reason: "  " })]).problems[0] ?? "", /без ПРИЧИНИ/,
    "🔴 запис без причини прийнято — реєстр перестав відповідати на єдине питання, заради якого існує");
  assert.match(acceptRetired([], [], [R({ since: "" })]).problems[0] ?? "", /без ДАТИ/);
  // 🪞 Дзеркало: повний запис проблем не дає — інакше «без причини» ловилось би на чому завгодно.
  assert.deepEqual(acceptRetired([], [], [R()]).problems, []);
  // І реальний реєстр мусить бути справним ПРЯМО ЗАРАЗ, а не лише на фікстурах.
  assert.deepEqual(acceptRetired([], gateNames(), RETIRED_GATES).problems, [],
    "🔴 бойовий RETIRED_GATES несправний: або запис без причини, або він про ЖИВИЙ гейт");
});
