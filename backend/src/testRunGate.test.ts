import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRun, allowedSkips, ALLOWED_PROD_SKIPS, modeName, EMPTY_PERIOD_MARK, EMPTY_PERIOD_SKIPS, isEmptyPeriodSkip, BROKEN_ENV_MARK } from "./testRunGate.js";

/**
 * #19 — ВОРОТА РЕЖИМУ ПРОГОНУ. Третій (і останній) закритий випадок хибно-зеленого.
 *
 * 🔴 Форма помилки та сама, що в перших двох, лише на іншому рівні:
 *   · у ДАНИХ    — «порожній результат = pass» (закрито правилом «порожньо = провал»);
 *   · у СКЛАДІ   — «тесту немає, а вивід зелений» (закрито маніфестом);
 *   · у ПРОГОНІ  — «тест є, але не виконався» ← ЦЕ.
 * Реально коштувало: приймання після деплою надрукувало «100 тестів, 0 падінь» при
 * 72 тихо пропущених, бо оточення подали з `../.env` замість `backend/.env`.
 *
 * Перевіряємо ЧИСТУ функцію вироку, а не весь прогін: інакше тест мусив би мутувати
 * `process.exitCode` і валив би сам набір. Наскрізний доказ — окремий саботаж
 * (запуск приймання з неправильним шляхом до .env), він дає `exit 1`.
 */

const MANIFEST = 100;                                  // скільки тестів оголошено
const PROD = { TEST_SCOPE: "prod" } as NodeJS.ProcessEnv;
const MATRIX = { TEST_SCOPE: "prod", TEST_MATRIX: "1" } as NodeJS.ProcessEnv;
const OK_SKIP = "#8 міграція проходить на ПОРОЖНІЙ базі повністю";
const MATRIX_SKIP = "#11 МАТРИЦЯ ДОСТУПУ: жодна клітинка не змінилась";

test("#19 РЕЖИМ: скіп ПОЗА списком дозволених — прогін НЕ зараховано", () => {
  const v = evaluateRun(
    { ran: 98, failed: 0, skipped: ["#5.9 HR НЕ бачить ЧУЖІ особисті задачі (приватність не залежить від scope)", OK_SKIP] },
    MANIFEST, PROD);
  assert.equal(v.ok, false, "🔴 несподіваний скіп зарахований як успіх — ворота не працюють");
  assert.deepEqual(v.unexpected, ["#5.9 HR НЕ бачить ЧУЖІ особисті задачі (приватність не залежить від scope)"]);
  assert.match(v.report, /ПРОГІН НЕ ЗАРАХОВАНО/);
});

test("#19b ДЗЕРКАЛО: лише дозволені скіпи — прогін зараховано", () => {
  // Без цієї пари ворота могли б валити ЗАВЖДИ, і ми б читали це як надійність.
  const v = evaluateRun({ ran: 99, failed: 0, skipped: [OK_SKIP] }, MANIFEST, PROD);
  assert.equal(v.ok, true, `🔴 чистий прогін відхилено: ${v.report}`);
  assert.equal(v.required, 99, "required має бути «оголошено мінус дозволені скіпи»");
  assert.doesNotMatch(v.report, /НЕ ЗАРАХОВАНО/);
});

test("#19c 🔴 «НІЧОГО НЕ ВИКОНАЛОСЬ» — це ПРОВАЛ, а не «0 падінь»", () => {
  // Рівно той випадок, що стався: файли впали на імпорті, тестів не було зовсім.
  // Скіпів теж нема — тому ловить саме порівняння з МАНІФЕСТОМ, зовнішнім числом.
  const v = evaluateRun({ ran: 18, failed: 18, skipped: [] }, MANIFEST, PROD);
  assert.equal(v.ok, false, "🔴 прогін, у якому виконалась п'ята частина, зарахований");
  assert.equal(v.required, MANIFEST);
  assert.match(v.report, /не дорахувались 82 тестів/);
});

test("#19d 🔴 ОЧІКУВАНЕ ЧИСЛО — ЗЗОВНІ, не з самого прогону", () => {
  // Заборонена циклічна перевірка «A = B, де B — це щойно означене A». Саме її я
  // спершу й написав: expected = ran + дозволені скіпи → «18 із 18» при нулі роботи.
  const a = evaluateRun({ ran: 50, failed: 0, skipped: [] }, MANIFEST, PROD);
  const b = evaluateRun({ ran: 50, failed: 0, skipped: [] }, 50, PROD);
  assert.equal(a.ok, false, "🔴 половина прогону зарахована — вирок залежить від прогону, а не від маніфесту");
  assert.equal(b.ok, true, "той самий прогін при меншому оголошеному числі має бути валідним");
});

test("#19e РЕЖИМ ВИРІШУЄ: #11 дозволено пропустити в test:prod, але НЕ в test:matrix", () => {
  assert.equal(evaluateRun({ ran: 99, failed: 0, skipped: [MATRIX_SKIP] }, MANIFEST, PROD).ok, true,
    "у швидкому прийманні повний зліпок законно пропускається");
  const m = evaluateRun({ ran: 99, failed: 0, skipped: [MATRIX_SKIP] }, MANIFEST, MATRIX);
  assert.equal(m.ok, false,
    "🔴 у матричному режимі #11 пропустився й це зарахували — тобто «повна матриця» могла б не виконатись жодного разу");
  assert.equal(modeName(MATRIX), "test:matrix");
});

test("#19f РЕЄСТР ДОЗВОЛЕНИХ СКІПІВ: кожен названий поіменно і з причиною", () => {
  assert.ok(ALLOWED_PROD_SKIPS.length > 0, "реєстр порожній — перевірка нічого не робить");
  for (const s of ALLOWED_PROD_SKIPS) {
    assert.ok(s.name.trim(), "скіп без назви");
    assert.ok(s.why.trim(), `«${s.name}» без причини — реєстр не сміє стати смітником`);
    // Маска (напр. «усе, що починається з #8») прикрила б і майбутній скіп, якого ми
    // не бачили. Тому — точні назви, без символів шаблону.
    assert.doesNotMatch(s.name, /[*?]/, `«${s.name}» схоже на маску — дозволяємо лише точні назви`);
  }
  assert.ok(allowedSkips(PROD).has(OK_SKIP), "дозволений скіп не потрапив у набір режиму");
});

/**
 * #19g — 🪞 РЕЄСТР НЕ ГНИЄ: кожен дозволений скіп називає ІСНУЮЧИЙ тест.
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ 21.08.2026. Реєстр звіряється за ТОЧНОЮ назвою. Прохід Звіту
 * перейменував два тести (`#66` «ПРАВИЛО новий/постійний…» → «НОВИЗНА…», `#66b` «ДВІ
 * ФОРМИ» → «ТРИ ФОРМИ»), реєстр лишився зі старими рядками — і записи мовчки
 * перестали збігатись. Наслідок: обидва тести поїхали в «несподівані скіпи», а
 * `test:prod` почав друкувати «ПРОГІН НЕ ЗАРАХОВАНО» на кожному прийманні. Ніщо не
 * зламалось — зламався ЗВʼЯЗОК між реєстром і набором.
 *
 * `#19f` цього не бачив: він перевіряє, що запис має назву й причину, а не що назва
 * когось означає. Це рівно клас `#15e` (реєстр `ACCEPTED_DIVERGENCES` не сміє стати
 * смітником) — мертвий запис глушить справжню розбіжність.
 */
test("#19g РЕЄСТР СКІПІВ НЕ ГНИЄ: кожна назва означає існуючий тест", async () => {
  const { MANIFEST_TESTS } = await import("./testManifest.js");
  const known = new Set(MANIFEST_TESTS);
  assert.ok(known.size > 100, `🔴 маніфест дав ${known.size} назв — звіряти нема з чим`);
  const dead = ALLOWED_PROD_SKIPS.map((s) => s.name).filter((n) => !known.has(n));
  assert.deepEqual(dead, [],
    "🔴 У РЕЄСТРІ СКІПІВ Є ЗАПИСИ, ЯКИМ НЕ ВІДПОВІДАЄ ЖОДЕН ТЕСТ. Найчастіша причина —\n"
    + "тест перейменували, а рядок лишився: збіг за точною назвою зникає МОВЧКИ, і\n"
    + "приймання починає падати з «несподіваного скіпу»:\n  " + dead.join("\n  "));
  // 🪞 Дзеркало: перевірка не має зеленіти на порожньому — реєстр справді непорожній
  //    і справді перетинається з маніфестом.
  const alive = ALLOWED_PROD_SKIPS.map((s) => s.name).filter((n) => known.has(n));
  assert.ok(alive.length >= 20,
    `🔴 з реєстру в маніфесті впізнано лише ${alive.length} назв — звірка вироджена`);
});

test("#12g ДІТИ СКІПНУТОГО БАТЬКА не валять прогін (але лише коли батько СПРАВДІ скіпнувся)", async () => {
  const { evaluateRun, PROD_SKIP_CHILDREN } = await import("./testRunGate.js");
  const PARENT = "#27 ДЗВІНКИ: запис, дедуп батча, звʼязка номер→клієнт";
  const kids = PROD_SKIP_CHILDREN[PARENT];
  assert.ok(kids && kids.length === 4, "🔴 нема з чим працювати — перевірка була б порожньою");
  // Батько скіпнувся (дозволено) → його 4 дітей фізично не зʼявляться.
  const v = evaluateRun({ ran: 10, failed: 0, skipped: [PARENT] }, 15, { TEST_SCOPE: "prod" } as NodeJS.ProcessEnv);
  assert.equal(v.required, 10, "15 оголошено − 1 скіп батька − 4 дітей = 10");
  assert.ok(v.ok, "🔴 прогін не зараховано, хоча ламати не було чого");
});

test("#12h ДЗЕРКАЛО: батько ВІДПРАЦЮВАВ — діти зобовʼязані зʼявитись", async () => {
  const { evaluateRun } = await import("./testRunGate.js");
  // Без цього дзеркала #12g перетворив би маніфест на декорацію: діти зникали б
  // мовчки й тоді, коли батько чудово працює.
  const v = evaluateRun({ ran: 10, failed: 0, skipped: [] }, 15, { TEST_SCOPE: "prod" } as NodeJS.ProcessEnv);
  assert.equal(v.required, 15, "нічого не скіпнулось — знижок бути не може");
  assert.equal(v.ok, false, "🔴 недолік 5 тестів зарахований як успіх");
});

/**
 * 🈳 #236–#236d — ПОРОЖНІЙ ПЕРІОД: ГУЧНИЙ СКІП ЗАМІСТЬ ПАДІННЯ.
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ ДВІЧІ 01.09.2026: із 17-18 падінь приймання **одинадцять**
 * були наші гейти, що червоніють від відсутності даних вересня. Тобто на кожній межі
 * місяця критерій приймання перестає працювати за побудовою і блокує викати всім
 * трьом чатам.
 *
 * ⚠️ ГОЛОВНЕ ТУТ — НЕ ДОЗВІЛ, А ЙОГО МЕЖА, і вона двоскладова: імʼя в реєстрі І
 * маркер у причині. Скіп, що ковтає справжній дефект, гірший за падіння; односторонній
 * предикат у нас за тиждень спрацював тричі.
 */
test("#236 порожній період: імʼя в реєстрі + маркер = дозволений скіп", () => {
  const name = EMPTY_PERIOD_SKIPS[0].name;
  const v = evaluateRun(
    { ran: 10, failed: 0, skipped: [name], emptyPeriod: [{ name, reason: `${EMPTY_PERIOD_MARK} нема даних` }] },
    11, { TEST_SCOPE: "prod" } as NodeJS.ProcessEnv);
  assert.equal(v.ok, true, "🔴 законний скіп на порожньому періоді не зарахувався");
});

test("#236b 🔴 ДЗЕРКАЛО: ІМʼЯ БЕЗ МАРКЕРА не дозволене — реєстр не ковдра", () => {
  const name = EMPTY_PERIOD_SKIPS[0].name;
  // Той самий гейт, той самий реєстр — але скіпнувся він З ІНШОЇ ПРИЧИНИ.
  const v = evaluateRun(
    { ran: 10, failed: 0, skipped: [name], emptyPeriod: [] },
    11, { TEST_SCOPE: "prod" } as NodeJS.ProcessEnv);
  assert.equal(v.ok, false,
    "🔴 запис у реєстрі покрив скіп із ЧУЖОЇ причини — саме так дозвіл стає ковдрою");
});

test("#236c 🔴 МАРКЕР БЕЗ ІМЕНІ теж не дозволений — інакше маркер сам себе дозволяє", () => {
  const v = evaluateRun(
    { ran: 10, failed: 0, skipped: ["#999 гейт поза реєстром"],
      emptyPeriod: [{ name: "#999 гейт поза реєстром", reason: `${EMPTY_PERIOD_MARK} нема даних` }] },
    11, { TEST_SCOPE: "prod" } as NodeJS.ProcessEnv);
  assert.equal(v.ok, false,
    "🔴 будь-який гейт зміг би пропустити себе сам, просто додавши маркер у причину");
});

test("#236d ЗЛАМАНЕ ОТОЧЕННЯ БʼЄ І ЦЕЙ ДОЗВІЛ — маркери не змішуються", () => {
  const name = EMPTY_PERIOD_SKIPS[0].name;
  const v = evaluateRun(
    { ran: 10, failed: 0, skipped: [name],
      broken: [{ name, reason: `${BROKEN_ENV_MARK} кластер не встав` }],
      emptyPeriod: [{ name, reason: `${EMPTY_PERIOD_MARK} нема даних` }] },
    11, { TEST_SCOPE: "prod" } as NodeJS.ProcessEnv);
  assert.equal(v.ok, false,
    "🔴 зламане оточення проїхало під дозволом на порожній період — два різні стани "
    + "в одній клітинці, рівно те, від чого нас береже маркер");
  // 🪞 І розпізнавач маркера не вироджений: він мусить казати «ні» на чужий текст.
  assert.equal(isEmptyPeriodSkip(`${EMPTY_PERIOD_MARK} x`), true);
  assert.equal(isEmptyPeriodSkip("просто причина"), false);
});

/**
 * 🗑 #235e — ПРИЙНЯТЕ ЗНЯТТЯ НЕ РАХУЄТЬСЯ ДВІЧІ: ані ③, ані ②.
 *
 * 🔴 Знайдено ДРУГИМ ужитком реєстру: `#305` знято поіменно, ③ промовчав, а ② сказав
 * «перестало виконуватись» — і ланцюг усе одно став. Першого разу (`#46`) не спливло
 * випадково: той гейт скіпався по обидва боки й у «виконаних» не був ніколи.
 */
test("#235e знятий поіменно гейт не є порушенням «перестало виконуватись»", async () => {
  const { judgeDelta } = await import("./tools/testDelta.js");
  const base = [{ name: "#305 старий", ok: true, skipped: false }, { name: "#1 живий", ok: true, skipped: false }];
  const tree = [{ name: "#1 живий", ok: true, skipped: false }];
  assert.equal(judgeDelta(base, tree, [], ["#305 старий"]).ok, true,
    "🔴 свідоме зняття спиняє ланцюг критерієм ②, хоч ③ його вже прийняв");
  // 🪞 ДЗЕРКАЛО: незаявлене зникнення лишається порушенням — виняток вузький.
  const v = judgeDelta(base, tree, [], []);
  assert.equal(v.ok, false, "🔴 будь-який зниклий тест тепер проїжджає — виняток став ковдрою");
  assert.deepEqual(v.stoppedExecuting, ["#305 старий"]);
  // 🪞 І чуже зникнення не покривається дозволом на СВОЄ.
  const w = judgeDelta([...base, { name: "#7 чужий", ok: true, skipped: false }], tree, [], ["#305 старий"]);
  assert.deepEqual(w.stoppedExecuting, ["#7 чужий"], "🔴 під одним дозволом проїхало друге зникнення");
});
