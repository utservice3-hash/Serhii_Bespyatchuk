import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🏗 #250–#250e — ЗБІРКА ВИНЕСЕНА З ПРОД-ЧЕКАУТУ.
 *
 * 📐 Навіщо, числом: чекаут тримався ~21 хв на викат, з них збірка+рестарт — 1.2 хв
 * (медіана вікна FF-merge → sha на проді по 47 викатах: 1.0 хв). Решту тримали крок 0
 * і приймання, яким прод-дерево не потрібне нічим, окрім того, що вони в ньому лежали.
 *
 * ⚠️ Чого це НЕ лікує — і це мусить лишатись у тексті: серіалізація стоїть на ПРОЦЕСІ
 * прода, а не на дереві. Двоє не викочують одночасно, хоч би де збиралися. Виграш —
 * паралельна підготовка, а не зникнення черги.
 */

const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), "utf8");
const DEPLOY = () => SRC("tools/deploy.ts");

/** Тіло обробника кроку — від його імені до наступного ключа мапи. */
function stepBody(src: string, id: string): string {
  const i = src.indexOf(`\n  ${id}: `);
  assert.ok(i > 0, `крок «${id}» не знайдено в handlers`);
  const rest = src.slice(i + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z_][\w]*: /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/**
 * Тіло БЕЗ коментарів. 🔴 Написано після того, як саботаж T6 лишився зеленим:
 * перевірка `/\brm\b/` збіглася з коментарем «dist (rm -rf)» усередині кроку, а не з
 * кодом видалення. Присутність, перевірена в прозі, стереже прозу.
 */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Ідентифікатори всіх обробників кроків — щоб питати «а ХТО це робить», не перелічуючи руками. */
function HANDLER_IDS(src: string): Record<string, true> {
  const from = src.indexOf("const handlers");
  const out: Record<string, true> = {};
  for (const m of src.slice(from).matchAll(/\n {2}([A-Za-z_][\w]*): \(c\) =>/g)) out[m[1]] = true;
  return out;
}

test("#250 збірка і докрут — РІЗНІ дерева, і жоден крок збірки докрута не торкається", () => {
  const s = DEPLOY();
  assert.match(s, /\bbuildRepo\b/, "у Ctx немає buildRepo");
  assert.match(s, /\bdocRoot\b/, "у Ctx немає docRoot");
  assert.equal((s.match(/\bc\.repo\b/g) ?? []).length, 0,
    "🔴 лишився c.repo — тобто десь роль дерева досі не названа, і саме там вона зіллється назад");

  // Кроки, що ЗБИРАЮТЬ або читають джерела, не сміють згадувати докрут.
  for (const id of ["base", "buildBack", "tscFront", "test", "recount", "artifact", "baseAgain"]) {
    const body = stepBody(s, id);
    assert.ok(!/\bc\.docRoot\b|\bc\.prodBe\b/.test(body),
      `🔴 крок збірки «${id}» торкається докрута — сенс винесення втрачено: чекаут знову зайнятий на весь час збірки`);
  }
  // І дзеркально: кроки доставки мусять працювати САМЕ в докруті.
  for (const id of ["ff", "copy", "cssGuard", "pushBranch"]) {
    assert.match(stepBody(s, id), /\bc\.docRoot\b/,
      `🔴 крок доставки «${id}» не працює в докруті — тоді він або нікуди не кладе, або кладе не туди`);
  }
});

test("#250b фаза run НЕ збирає — вона доставляє; але БАНДЛ хтось таки збирає", () => {
  const s = DEPLOY();
  assert.ok(!/buildBackProd|buildFront: \(c\) => run\("buildFront"[\s\S]{0,200}c\.docRoot/.test(s),
    "🔴 у run-фазі лишилась збірка. Поки вона там, чекаут тримається всі ~21 хв, і винесення нічого не дало");
  const d = stepBody(s, "deliver");
  assert.match(d, /c\.be\b/, "deliver не бере dist зі стенда");
  assert.match(d, /c\.prodBe\b/, "deliver не кладе dist у докрут");

  /**
   * 🔴 ПАРНЕ ТВЕРДЖЕННЯ — «А ДЕ ВОНО ТЕПЕР». Без нього ця перевірка ВИНАГОРОДЖУЄ
   * зникнення: «у run немає збірки» однаково істинне і коли крок переїхав у стенд, і
   * коли його не стало ніде. Саме так і сталось 27.08.2026 — я прибрав `buildFront`
   * із run і не додав у check, `vite build` не кликав ніхто, а гейт був зелений.
   * Ціна: перший викат обірвався б на `distNotEmpty` — ОДРАЗУ ПІСЛЯ `deliver`.
   */
  const FE_BUILDERS = Object.keys(HANDLER_IDS(s)).filter((id) => {
    const b = stepBody(s, id);
    return /\bc\.fe\b/.test(b) && /"build"/.test(b);
  });
  assert.deepEqual(FE_BUILDERS, ["buildFront"],
    `🔴 бандл фронту збирають кроки [${FE_BUILDERS.join(", ") || "ЖОДЕН"}], а має рівно один — buildFront.\n` +
    "   Порожньо = vite build не кликає ніхто: `tscFront` поруч робить `tsc -b`, тобто ТИПИ, і нічого не емітить.");

  const plan = SRC("tools/deployPlan.ts");
  assert.match(plan, /id: "buildFront", phase: "check"/,
    "🔴 buildFront не у фазі check — або його немає, або він знову в докруті");
  for (const id of ["baseAgain", "deliver", "backupOutgoing"]) assert.ok(plan.includes(`id: "${id}"`), `крок «${id}» не оголошено в реєстрі`);
  assert.ok(!plan.includes(`id: "buildBackProd"`), "реєстр досі оголошує збірку в run-фазі");
});

test("#250c ДОСТАВКА ВІДМОВЛЯЄ, коли прод зрушив або артефакт від іншого коміту", () => {
  const b = stepBody(DEPLOY(), "baseAgain");
  // ① база перевіряється ВДРУГЕ, живим health, а не значенням із памʼяті
  assert.match(b, /prodSha\(\)/, "🔴 baseAgain не питає health — тоді він звіряє памʼять, а не прод");
  assert.match(b, /merge-base[\s\S]{0,80}is-ancestor/, "🔴 немає перевірки предка");
  assert.match(b, /"fetch"/, "🔴 немає fetch — без нього merge-base бреше проти застарілого tracking-ref");
  // ② і третє твердження — про АРТЕФАКТ, не про дерево
  // 🔴 САМЕ ПОРІВНЯННЯ, а не згадка імені файлу. Перша редакція перевіряла лише
  // `version.json` у тексті — і саботаж «прибрати звірку» лишав цей гейт ЗЕЛЕНИМ,
  // червонів натомість сусідній. Гейт, чия назва обіцяє одне, а ловить інше, — це
  // рівно той клас, який ми весь час і викорінюємо.
  assert.match(b, /version\.json/, "🔴 артефакт не читається взагалі");
  assert.match(b, /built !== head/,
    "🔴 немає ПОРІВНЯННЯ артефакта з HEAD. Перші два твердження — про дерево, а доставляємо ми dist:\n" +
    "   HEAD може бути правильний, а артефакт — від іншого коміту (перезбирали, ребейзились після збірки).");
  assert.match(b, /ok: false/, "🔴 крок не вміє відмовити — тоді він не гейт, а напис");
  assert.match(b, /НЕ «швидко домержити під замком»/,
    "🔴 причина не називає, чого саме не робити. «Домержу під замком» поверне збірку в чекаут, тобто скасує весь прохід");
});

test("#250d ДЗЕРКАЛО: доставка ПРОХОДИТЬ, коли база предок і артефакт свій", () => {
  // Без цього твердження #250c був би зелений на кроці, що відмовляє ЗАВЖДИ, —
  // тобто на мертвому викаті. Перевіряємо, що гілка успіху існує й досяжна.
  const b = stepBody(DEPLOY(), "baseAgain");
  assert.match(b, /ok: true/, "🔴 у baseAgain немає гілки успіху — доставка не відбудеться ніколи");
  const okAt = b.indexOf("ok: true"), failAt = b.indexOf("ok: false");
  assert.ok(failAt >= 0 && okAt > failAt,
    "🔴 успіх стоїть перед усіма відмовами — тоді перевірки нижче недосяжні");
  assert.match(b, /built !== head/, "🔴 порівняння артефакта з HEAD відсутнє або перевернуте");
});

test("#250e стенд читає, а ланцюг зі стенда не пушить; node названий шляхом", () => {
  const s = DEPLOY();
  // Пуш у прод-гілку лишається в ДОКРУТІ — і це рішення, а не випадковість.
  assert.match(stepBody(s, "pushBranch"), /c\.docRoot[\s\S]{0,60}git push/,
    "🔴 пуш задеплоєного sha поїхав зі стенда. Він мусить іти з докрута: саме там дерево == те, що крутить прод");
  for (const id of ["base", "test", "artifact", "baseAgain", "deliver"]) {
    assert.ok(!/git push/.test(stepBody(s, id)),
      `🔴 крок «${id}» пушить зі стенда. Клон із локального шляху успадковує ЦЕЙ ШЛЯХ як origin —\n` +
      "   спіймано 26.08.2026: пуш пішов у прод-репозиторій замість GitHub");
  }
  // Шлях до node названий, а не «те, що в PATH».
  assert.match(s, /NODE_BIN/, "🔴 немає NODE_BIN");
  assert.match(s, /node26/, "🔴 шлях до node не названий: прод виконує /usr/local/node26/bin/node");
  const t = s.slice(s.indexOf("function toolsPresent"));
  assert.ok(t.indexOf("NODE_BIN") < t.indexOf("rm -rf dist") || !t.includes("rm -rf dist"),
    "🔴 перевірка бінарів має бути ПЕРЕД першим rm: HR уже втратив прохід на `npm: command not found` ПІСЛЯ видалення dist");
  // Конфіг фронта більше не поза git — причини міни немає.
  const gi = readFileSync(fileURLToPath(new URL("../../../.gitignore", import.meta.url)), "utf8");
  assert.match(gi, /!frontend\/\.env\.production/,
    "🔴 frontend/.env.production знову поза git — збірка з будь-якого свіжого клону тихо підставить localhost");
  assert.ok(existsSync(fileURLToPath(new URL("../../../frontend/.env.production", import.meta.url))),
    "🔴 файла немає в дереві — негація в .gitignore сама по собі нічого не дає");
});

/**
 * 🏗 #250f — СТЕНД НА ПРОД-ХОСТІ НЕ Є ДОКРУТОМ.
 *
 * 📐 Спіймано ВИКОНАННЯМ, не читанням (27.08.2026): перший же `deploy:check` у стенді
 * `/home/evraziat/fwt` відмовив із кодом 3. Причина — другий сигнал `isProdCheckout`
 * був `/home/evraziat/`, тобто «будь-що на прод-хості». Поки дерево було одне, це
 * збігалося з істиною; винесення збірки зробило умову хибною, і гейт заблокував саме
 * те дерево, заради якого весь прохід.
 *
 * 🔴 Клас — «прибираєш інваріанту, знайди всіх, хто на неї спирався», у зворотний бік:
 * я нічого не прибирав, я ДОДАВ друге дерево — і цього вистачило, щоб чинна умова
 * почала брехати, не змінившись жодним символом.
 *
 * ⚠️ Заміряно, що перша ознака не вироджується: у докруті `index.html` і `assets/` є,
 * і **в git не відстежується жоден із них** (`git ls-files index.html assets` → 0).
 * Отже жоден клон їх не успадкує, і докрут лишається впізнаваним без шляху взагалі.
 */
test("#250f стенд на прод-хості не приймається за докрут", async () => {
  const { isProdCheckout } = await import("./deployPlan.js");
  const DOC = "/home/evraziat/uts.ua/dashboard";

  assert.equal(isProdCheckout({ rootIndexHtml: false, rootAssets: false, path: "/home/evraziat/fwt", docRoot: DOC }), false,
    "🔴 стенд прийнято за прод-чекаут — `deploy:check` у ньому відмовить, і збірку\n" +
    "   доведеться повернути в докрут, тобто скасувати весь сенс винесення");

  // 🪞 ДЗЕРКАЛО, без якого попереднє твердження зеленіло б на функції, що завжди false.
  assert.equal(isProdCheckout({ rootIndexHtml: false, rootAssets: false, path: DOC, docRoot: DOC }), true,
    "🔴 сам докрут більше не впізнається за шляхом — другий сигнал помер замість того, щоб звузитись");
  assert.equal(isProdCheckout({ rootIndexHtml: false, rootAssets: false, path: DOC + "/", docRoot: DOC }), true,
    "🔴 кінцевий слеш обійшов звірку — шлях той самий, а гейт мовчить");

  // 🔴 Порожній docRoot не сміє збігтися з порожнім шляхом.
  // ⚠️ Перша редакція цього твердження була БЕЗЗУБА, і спіймав це саботаж, не читання:
  // я звіряв `docRoot: ""` проти НЕпорожнього шляху — а там рівність не виконується
  // ні з умовою, ні без неї, тож прибирання умови лишало гейт зеленим. Захист має сенс
  // рівно в одному місці: коли ОБИДВА порожні, і `"" === ""` дає хибний збіг.
  assert.equal(isProdCheckout({ rootIndexHtml: false, rootAssets: false, path: "", docRoot: "" }), false,
    "🔴 порожній docRoot зматчився з порожнім шляхом — невиставлені змінні дали б відмову на порожньому місці");

  // Виклик у deploy.ts мусить передавати docRoot — інакше звуження існує лише в тесті.
  const s = readFileSync(fileURLToPath(new URL("../../src/tools/deploy.ts", import.meta.url)), "utf8");
  const at = s.indexOf("isProdCheckout({");
  assert.ok(at > 0, "🔴 виклик isProdCheckout зник із deploy.ts");
  const call = s.slice(at, at + 300);
  // 🔴 САМЕ ЗМІННА, А НЕ ПРОСТО СЛОВО. Перша редакція шукала /docRoot\b/ — і була
  // зелена на саботажі `docRoot: ""`, бо підрядок на місці. Скорочений запис
  // (`docRoot,` / `docRoot }`) означає «те саме значення, куди ми доставляємо»;
  // будь-яке `docRoot: <щось>` — це вже ІНШЕ значення, і гейт мусить це бачити.
  assert.match(call, /\bdocRoot\s*[,}]/,
    "🔴 deploy.ts кличе гейт БЕЗ docRoot — тоді звірка йде проти undefined і не спрацює ніколи");
  assert.ok(!/\bdocRoot\s*:/.test(call),
    "🔴 у виклик підставлено ЛІТЕРАЛ замість docRoot — гейт звіряється не з тим деревом,\n" +
    "   куди ланцюг реально доставляє, і мовчить рівно тоді, коли мав би спинити");
});

/**
 * 🚦 #250g — УСЕ, ЩО ВМІЄ СКАЗАТИ «НІ», КАЖЕ ЦЕ ДО ПЕРШОЇ НЕЗВОРОТНОЇ ДІЇ.
 *
 * 🔴 Привід заміряний, а не уявний. У першій редакції `distNotEmpty` стояв ПІСЛЯ
 * `deliver`: незібраний фронт спинив би ланцюг рівно там, де бекенд прода вже
 * підмінено, докрут уже перемотано, а бандл лишився старий. Це рідня випадку
 * 26.08.2026, коли `rm -rf dist` виконався ПЕРЕД `npm: command not found`.
 * Правило одне: відмова, що приходить після руйнування, — не гейт, а звіт про збиток.
 */
test("#250g відмовні кроки — перед першим руйнівним", async () => {
  const { planSteps } = await import("./deployPlan.js");
  const ids = planSteps("run", "full").map((x) => x.id);
  const at = (id: string) => { const i = ids.indexOf(id); assert.ok(i >= 0, `🔴 крок «${id}» зник із фази run`); return i; };

  // ① Порядок: три перевірки → перша мутація докрута → тарбол → доставка.
  const order = ["artifactFresh", "baseAgain", "distNotEmpty", "ff", "backupOutgoing", "deliver", "copy"];
  const got = order.map(at);
  assert.deepEqual(got, [...got].sort((a, b) => a - b),
    `🔴 порядок порушено: ${order.map((id, i) => `${id}@${got[i]}`).join(" · ")}`);

  // ② І сильніше за порядок: жодна з трьох перевірок не сміє ТОРКАТИСЬ докрута.
  //    Крок, що встиг щось змінити, вже не може «просто відмовити».
  const s = DEPLOY();
  for (const id of ["artifactFresh", "baseAgain", "distNotEmpty"]) {
    const b = stepBody(s, id);
    assert.ok(!/\bc\.docRoot\b|\bc\.prodBe\b/.test(b),
      `🔴 відмовний крок «${id}» чіпає докрут — тоді його «ні» приходить уже після сліду`);
  }
  // ③ Дзеркало: `deliver` справді руйнівний, інакше весь порядок стереже порожнечу.
  assert.match(stepBody(s, "deliver"), /rm -rf|"-rf"/,
    "🔴 deliver більше не руйнівний — тоді твердження про «перед першим руйнівним» ні про що");
});

/**
 * 📦 #250h — КОПІЯ ВИЇЖДЖАЮЧОГО. Нова ціна нового ланцюга, названа вголос.
 *
 * Старий ланцюг збирав ПОВЕРХ, тож при невдачі попередній `dist` лишався майже цілим.
 * Новий робить `rm -rf` ПЕРЕД копією — попереднього стану не лишається ніде, і відкат
 * коштував би повного перезбору (≈169 с) замість розпакування (≈10 с).
 */
test("#250h тарбол виїжджаючого: перед deliver, ім'я з version.json, поза докрутом, ретенція", async () => {
  const { BACKUP_DIR, BACKUP_KEEP } = await import("./deploy.js");
  const s = DEPLOY();
  const b = stepBody(s, "backupOutgoing");

  // ① Каталог ПОЗА докрутом — докрут роздається вебом.
  const docDefault = s.match(/UTS_DOC_ROOT \?\? "([^"]+)"/)?.[1];
  assert.ok(docDefault, "🔴 не знайшов дефолт docRoot — нема з чим порівнювати");
  assert.ok(!BACKUP_DIR.startsWith(docDefault + "/") && BACKUP_DIR !== docDefault,
    `🔴 тарболи лежать У ДОКРУТІ (${BACKUP_DIR} всередині ${docDefault}).\n` +
    "   Заміряно 27.08.2026: по HTTP такий файл не віддається — але тримається це на правилі\n" +
    "   перезапису в НЕвідстежуваному .htaccess, а не на межі каталогу.");

  // ② Ім'я — sha З АРТЕФАКТА, а не git HEAD. Крок іде ПІСЛЯ `ff`, тож HEAD уже НОВИЙ,
  //    і назва за ним описувала б те, чого в тарболі немає.
  assert.match(b, /version\.json/,
    "🔴 ім'я не бере sha з version.json — тоді воно бреше саме про те, заради чого тарбол існує");
  assert.ok(!/c\.target|rev-parse/.test(b),
    "🔴 ім'я береться з HEAD/target — це sha, що ПРИЇХАВ, а в тарболі лежить той, що ВИЇХАВ");

  // ③ Порожній результат — провал, а не успіх.
  // 🔴 Перша редакція була АЛЬТЕРНАТИВОЮ `size < 1024|throw new Error` — і лишалась
  // зеленою, коли прибрати саме перевірку розміру: у кроці є ДРУГИЙ throw («нема чого
  // зберігати»), і він її підміняв. Альтернатива в гейті означає «будь-що з двох згодиться».
  assert.match(code(b), /size\s*<\s*1024/,
    "🔴 крок не перевіряє РОЗМІР тарбола — «tar відпрацював» не означає «щось збережено»");

  // ④ Ретенція — у тому ж кроці, і саме два покоління.
  assert.equal(BACKUP_KEEP, 2, "🔴 глибина ретенції змінилась — рішення власника було «останні два»");
  // 🔴 Не «слово BACKUP_KEEP десь у кроці» — а ЗРІЗ за ним і ВИДАЛЕННЯ зрізаного, у коді.
  // Саботаж T6 (зняти ретенцію) лишав перше зеленим: BACKUP_KEEP згадувався у рядку звіту,
  // а `rm` збігався з коментарем. Обидві присутності були правдиві й нічого не стерегли.
  const c4 = code(b);
  assert.match(c4, /slice\(\s*BACKUP_KEEP\s*\)/,
    "🔴 крок не робить зріз за BACKUP_KEEP — старі тарболи нікуди не діваються");
  assert.match(c4, /for\s*\(\s*const\s+\w+\s+of\s+drop\s*\)[\s\S]{0,120}\brm\b/,
    "🔴 зріз є, а видалення немає: каталог росте тихо до «no space left on device» посеред викату");
});
