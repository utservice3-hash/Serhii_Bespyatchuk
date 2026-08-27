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

test("#250b фаза run НЕ збирає — вона доставляє", () => {
  const s = DEPLOY();
  assert.ok(!/buildBackProd|buildFront:/.test(s),
    "🔴 у run-фазі лишилась збірка. Поки вона там, чекаут тримається всі ~21 хв, і винесення нічого не дало");
  const d = stepBody(s, "deliver");
  assert.match(d, /c\.be\b/, "deliver не бере dist зі стенда");
  assert.match(d, /c\.prodBe\b/, "deliver не кладе dist у докрут");
  // Реєстр кроків мусить знати обидва нові — інакше #226 побачить крок без опису.
  const plan = SRC("tools/deployPlan.ts");
  for (const id of ["baseAgain", "deliver"]) assert.ok(plan.includes(`id: "${id}"`), `крок «${id}» не оголошено в реєстрі`);
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
