import { test } from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_STEPS, planSteps, verifyArtifact, LIGHT_OMITS, type Artifact } from "./deployPlan.js";
import { executablePlan, missingHandlers, handlers } from "./deploy.js";

/**
 * 🚀 #226–#226d — ЖОДЕН ОБОВʼЯЗКОВИЙ КРОК ВИКАТУ НЕ МОЖЕ ЗНИКНУТИ НЕПОМІЧЕНИМ.
 *
 * 🔴 ГЕЙТ СФОРМУЛЬОВАНО ЧЕРЕЗ НАСЛІДОК, А НЕ ЧЕРЕЗ МЕХАНІЗМ. Не «у файлі є рядок
 * markDeploy» — така перевірка зеленіла б і тоді, коли рядок є, а виклику немає.
 * Звіряється те, що виконавець СПРАВДІ вміє виконати (ключі мапи обробників), із
 * реєстром обовʼязкових кроків. Той самий урок, що з чанками: механізмів обійти
 * завжди більше, ніж ми згадаємо в момент написання.
 */

test("#226 виконавець уміє виконати КОЖЕН обовʼязковий крок", () => {
  const missing = missingHandlers();
  assert.deepEqual(missing.map((s) => s.id), [],
    "🔴 КРОКИ БЕЗ ОБРОБНИКА — вони мовчки не виконаються:\n"
    + missing.map((s) => `   ﹣ ${s.id} (${s.title})\n     навіщо: ${s.why}\n`).join(""));
});

test("#226b ПОРЯДОК КРОКІВ — ЧАСТИНА БЕЗПЕКИ, а не оформлення", () => {
  const run = planSteps("run", "full").map((s) => s.id);
  // markDeploy ПЕРЕД kill: після kill намір забирати нікому — він провисить і згорить,
  // старт класифікується як crash, і банер «АВАРІЯ» кричить на кожному викаті.
  assert.ok(run.indexOf("markDeploy") < run.indexOf("kill"),
    "🔴 markDeploy опинився ПІСЛЯ kill — намір не буде спожито, викат прийде як аварія");
  // Доказ рестарту — тільки після kill, інакше він доводить старий процес.
  assert.ok(run.indexOf("kill") < run.indexOf("healthVersion"),
    "🔴 health.version перевіряється ДО kill — це доказ про старий процес");
  // Пуш у прод-гілку — після того, як рестарт доведено.
  assert.ok(run.indexOf("healthVersion") < run.indexOf("pushBranch"),
    "🔴 пуш у прод-гілку до доказу рестарту — гілка казатиме про те, чого на проді немає");
  // 🔒 Замок бере САМ скрипт, і бере ДО першого дотику до чужого дерева; звільняє —
  // лише після того, як рестарт доведено й гілку запушено.
  assert.ok(run.indexOf("lockTake") < run.indexOf("ff"),
    "🔴 замок береться ПІСЛЯ дотику до чекауту — тобто рівно тоді, коли зіткнення вже сталось");
  assert.ok(run.indexOf("lockRelease") > run.indexOf("pushBranch"),
    "🔴 замок звільняється до кінця роботи — чекаут віддається в мішаному стані");
  // Копія — лише після перевірки, що є що копіювати.
  assert.ok(run.indexOf("distNotEmpty") < run.indexOf("copy"),
    "🔴 копія перед перевіркою dist/assets — саме так index.html лишається старим при новому бекенді");
  // Виконавець віддає план у ТОМУ САМОМУ порядку, що й реєстр.
  assert.deepEqual(executablePlan("run", "full"), run,
    "🔴 порядок виконання розійшовся з реєстром");
});

test("#226c АРТЕФАКТ ПРОТУХАЄ ЗА ОБОМА sha, і кожен бік названо окремо", () => {
  const a: Artifact = { branchSha: "aaa1111", prodSha: "bbb2222", mode: "full", at: "2026-08-25T00:00:00Z" };
  assert.deepEqual(verifyArtifact(a, "aaa1111", "bbb2222"), { ok: true });

  const noArt = verifyArtifact(null, "aaa1111", "bbb2222");
  assert.equal(noArt.ok, false);

  // 🔴 Гілка та сама, а ПРОД зрушив — саме цей випадок «той самий sha» пропускав би.
  //    Заміряно 25.08.2026: прод змінювався ВІСІМ разів за добу.
  const stale = verifyArtifact(a, "aaa1111", "ccc3333");
  assert.equal(stale.ok, false, "🔴 протухлий бік ПРОДА не помічено — перевірка звірялась би з тим, чого вже немає");
  if (stale.ok) return;
  assert.match(stale.reason, /ПРОДА/, "🔴 причина не називає, ЯКИЙ бік протух — читач піде перевіряти не те");

  const moved = verifyArtifact(a, "ddd4444", "bbb2222");
  assert.equal(moved.ok, false);
  if (moved.ok) return;
  assert.match(moved.reason, /ГІЛКИ/);
});

test("#226d РЕЖИМ ЛИШЕ ЯВНО, і легкий каже, чого не робить", async () => {
  const { main } = await import("./deploy.js");
  // Без --mode виконавець мусить ВІДМОВИТИСЬ, а не поїхати з мовчазним дефолтом.
  assert.equal(await main(["check"]), 2, "🔴 стартував без явного режиму — дешевий викат розбещує саме так");
  assert.equal(await main(["--mode=full"]), 2, "🔴 стартував без фази");
  // Легкий режим має ПЕРЕЛІК того, чого не робить, і він не порожній.
  assert.ok(LIGHT_OMITS.length > 0, "🔴 легкий режим нічого не оголошує — тоді він тихо слабший");
  // Умова допуску легкого існує саме як КРОК, а не як усна домовленість.
  assert.ok(REQUIRED_STEPS.some((s) => s.id === "lightAdmission" && s.lightOnly),
    "🔴 умова допуску легкого режиму не є кроком — її можна буде «памʼятати», а не перевіряти");
  assert.ok(planSteps("check", "light").some((s) => s.id === "lightAdmission"));
  assert.ok(!planSteps("check", "full").some((s) => s.id === "lightAdmission"));
  // Кожен крок реєстру пояснює, НАВІЩО він — інакше його приберуть як незрозумілий.
  const silent = REQUIRED_STEPS.filter((s) => s.why.trim().length < 20).map((s) => s.id);
  assert.deepEqual(silent, [], `🔴 кроки без пояснення: ${silent.join(", ")}`);
  assert.equal(typeof handlers.markDeploy, "function");
});

/**
 * 📍 #226e — ОБІРВАНИЙ ПРОГІН НАЗИВАЄ СТАН ПРОДА, А НЕ ЛИШЕ ПРИЧИНУ.
 *
 * 🔴 Три стани мусять РОЗРІЗНЯТИСЬ, і кожен мати свій вихід. Гейт перевіряє саме
 * розрізнення: доки всі три давали б один текст, скрипт «щось надрукував» — і читач
 * усе одно не знав би, чи можна йти спати.
 */
test("#226e обірваний прогін розрізняє три стани прода і дає вихід для кожного", async () => {
  const { abortState } = await import("./deployPlan.js");
  const ctx = { prodSha: "7915551", targetSha: "4a5655f", branch: "claude/friendly-galileo-8pijhl" };

  // 1 · Нічого не чіпали — найбезпечніший стан, і він мусить бути названий саме так.
  const a = abortState("test", ["base", "buildBack"], ctx);
  assert.equal(a.state, "prod-untouched");
  assert.ok(a.lines.some((l) => /ПРОД НЕ ЗМІНЕНО/.test(l)), "🔴 не сказано, що прод цілий — читач шукатиме наслідки, яких немає");
  assert.ok(a.lines.some((l) => /Нічого відкочувати/.test(l)));

  // 2 · Докрут уже новий, сервер ще старий — саме тут банер «АВАРІЯ» спрацює правильно.
  const b = abortState("kill", ["base", "ff", "copy", "cssGuard", "markDeploy"], ctx);
  assert.equal(b.state, "docroot-ahead");
  assert.ok(b.lines.some((l) => l.includes("7915551")), "🔴 не названо, який sha крутить прод");
  assert.ok(b.lines.some((l) => /АВАРІЯ/.test(l)), "🔴 не попереджено, що банер спрацює — його приймуть за поломку скрипта");
  assert.ok(b.lines.some((l) => /markDeploy/.test(l)), "🔴 не сказано про виставлений намір, який сам спливе");
  assert.ok(b.lines.some((l) => /Щоб відкотити/.test(l)) && b.lines.some((l) => /Щоб завершити/.test(l)),
    "🔴 у стані з розходженням мусять бути ОБИДВА виходи");

  // 3 · Сервер уже новий, гілка не знає — відкочувати не треба, бракує запису.
  const c = abortState("pushBranch", ["copy", "markDeploy", "kill", "healthVersion"], ctx);
  assert.equal(c.state, "server-ahead");
  assert.ok(c.lines.some((l) => /Відкочувати НЕ треба/.test(l)), "🔴 підштовхує відкочувати справний прод");
  assert.ok(c.lines.some((l) => l.includes("git push origin HEAD:")), "🔴 немає команди, якою завершити");

  // 4 · 🔴 ТРИ СТАНИ — ТРИ РІЗНІ ВИХОДИ. Однаковий код перетворив би розрізнення на текст.
  const codes = [a.exitCode, b.exitCode, c.exitCode];
  assert.equal(new Set(codes).size, 3, `🔴 стани не розрізняються кодом виходу: ${codes.join(", ")}`);
  assert.ok(codes.every((x) => x !== 0), "🔴 обірваний прогін не сміє віддавати 0");
});

/**
 * 🧬 #226f — КРОК `migrate` ВИВОДИТЬСЯ З ДІФУ, А НЕ З ПРАПОРЦЯ.
 *
 * 🔴 ГЕЙТ ЧЕРЕЗ НАСЛІДОК, а не «у файлі є hasMigrations»: підсовуємо диф зі схемою і
 * вимагаємо, щоб крок НЕ вважався пропущеним. Перша редакція мала зашитий `false` — крок
 * не виконався б НІКОЛИ, а звіт упевнено стверджував би «міграцій немає», тобто факт про
 * диф, якого ніхто не дивився. Знайшов це читач, а не тест — тому тест тепер є.
 */
test("#226f міграція у діфі НЕ може бути прочитана як «міграцій немає»", async () => {
  const { migrationsInDiff } = await import("./deployPlan.js");

  // 1 · Диф зі схемою — крок МУСИТЬ бути визнаний потрібним.
  assert.deepEqual(migrationsInDiff(["backend/src/routes/x.ts", "backend/src/db/schema.sql"]),
    ["backend/src/db/schema.sql"],
    "🔴 міграцію у діфі не помічено — саме так крок не виконався б НІКОЛИ, а звіт казав би «міграцій немає»");

  // 2 · Інші .sql у db/ теж рахуються: сид мапінгу — теж зміна БД.
  assert.equal(migrationsInDiff(["backend/src/db/seedKommoMapping.sql"]).length, 1);

  // 3 · 🪞 ДЗЕРКАЛО: звичайний діф НЕ вигадує міграцію — інакше крок ганявся б щоразу,
  //     «завжди зелений» став би новим фоном, і ми втратили б сигнал.
  assert.deepEqual(migrationsInDiff(["backend/src/tools/deploy.ts", "CLAUDE.md", "frontend/src/App.tsx"]), [],
    "🔴 міграцію вигадано на порожньому місці");
  assert.deepEqual(migrationsInDiff(["backend/src/fixtures/sample.sql", "docs/sql/diagnostics.sql"]), [],
    "🔴 .sql поза src/db прийнято за схему");

  // 4 · Порожній диф — це порожній диф, а не «є міграція».
  assert.deepEqual(migrationsInDiff([]), []);
});

/**
 * 🛑 #226g — `deploy:check` НЕ ЗАПУСКАЄТЬСЯ У ПРОД-ЧЕКАУТІ.
 *
 * 🔴 Це не теорія: 26.08.2026 фазу `check` запустили на проді, і `rm -rf dist &&
 * npm run build` перезібрав dist ПРОДА з чужої незапушеної гілки. Прод лишився на
 * старому sha, а на диску опинився бандл іншого коду — рестарт підняв би не те.
 * Ознака — ДОКРУТ (Apache віддає корінь репо), а не шлях: шлях може змінитись.
 */
test("#226g фаза check упізнає прод-чекаут за докрутом, а не лише за шляхом", async () => {
  const { isProdCheckout, PROD_CHECKOUT_REFUSAL } = await import("./deployPlan.js");
  const DOC = "/home/evraziat/uts.ua/dashboard";

  // 1 · Докрут поруч із кодом — це прод, хоч би де він лежав.
  assert.equal(isProdCheckout({ rootIndexHtml: true, rootAssets: true, path: "/будь/де", docRoot: DOC }), true,
    "🔴 прод не впізнано за докрутом — саме так check і перезібрав чужий dist");
  // 2 · Шлях — ДРУГИЙ сигнал, а не єдиний. Звірка з docRoot, не з хостом (див. #250f).
  assert.equal(isProdCheckout({ rootIndexHtml: false, rootAssets: false, path: DOC, docRoot: DOC }), true);
  // 3 · 🪞 ДЗЕРКАЛО: звичайний дев-клон НЕ блокується, інакше check не запуститься ніде.
  assert.equal(isProdCheckout({ rootIndexHtml: false, rootAssets: false, path: "/home/user/Serhii_Bespyatchuk", docRoot: DOC }), false,
    "🔴 дев-клон прийнято за прод — фаза check стала б невиконуваною");
  // Половина ознаки — ще не прод (у фронті теж є свій index.html, але не в корені репо).
  assert.equal(isProdCheckout({ rootIndexHtml: true, rootAssets: false, path: "/home/user/x", docRoot: DOC }), false);
  // 4 · Відмова мусить ПОЯСНЮВАТИ, а не просто зупиняти.
  assert.match(PROD_CHECKOUT_REFUSAL, /rm -rf dist/);
  assert.match(PROD_CHECKOUT_REFUSAL, /У КОНТЕЙНЕРІ/, "🔴 відмова не каже, ДЕ ж тоді запускати check");
});

/**
 * 🔗 #226h — ФАЗИ СТИКУЮТЬСЯ БЕЗ РУЧНОГО КРОКУ.
 *
 * 🔴 Було: `artifactFresh` звіряв артефакт із HEAD прод-чекауту — а до `ff` там стоїть
 * СТАРИЙ sha. Отже `deploy:run` не міг збігтися НІКОЛИ й мовчки вимагав ручної
 * перемотки, якої немає в жодній інструкції. Тепер ціль передається явно.
 */
test("#226h run вимагає явну ціль, і артефакт звіряється саме з нею", async () => {
  const { main } = await import("./deploy.js");
  const { verifyArtifact } = await import("./deployPlan.js");

  // Без --target фаза run не стартує: «те, що зараз у чекауті» не є наміром викату.
  assert.equal(await main(["run", "--mode=full"]), 2,
    "🔴 run стартував без цілі — він узяв би HEAD чекауту, тобто СТАРИЙ sha прода");

  // Артефакт звіряється з ЦІЛЛЮ, а не з тим, що лежить у чекауті до перемотки.
  const art = { branchSha: "aaa1111", prodSha: "bbb2222", mode: "full" as const, at: "2026-08-26T00:00:00Z" };
  assert.deepEqual(verifyArtifact(art, "aaa1111", "bbb2222"), { ok: true },
    "🔴 ціль == артефакт, а перевірка не пройшла");
  const wrongTarget = verifyArtifact(art, "ccc3333", "bbb2222");
  assert.equal(wrongTarget.ok, false, "🔴 чужу ціль пропущено");
});

test("#226i ПЕРЕВІРКА СЕРЕДОВИЩА — ПЕРЕД ПЕРШИМ РУЙНІВНИМ КРОКОМ", () => {
  // 🔴 26.08.2026 ланцюг зробив `rm -rf dist` на ПРОДІ й аж тоді впав на
  // `npm: command not found` (relay — не логін-шелл). Прод лишився без збірки на
  // диску: сайт жив із памʼяті процесу, рестарт не підняв би нічого.
  // `&&` рятує від продовження ПІСЛЯ збою, але не від того, що вже виконалось ДО.
  for (const [phase, tool, destroyer] of [
    // ⚠️ У фазі run першим руйнівним кроком став `ff` (27.08.2026, друга поправка за день).
    // Спершу я вписав сюди `deliver` — і це було ПРАВДОЮ рівно доти, доки `ff` стояв перед
    // ним у списку; після перестановки «усе відмовне — до першої незворотної дії» (#250g)
    // саме `ff` мутує докрут першим. Твердження те саме й кусає так само, лише тепер
    // указує на справжню межу, а не на другу за ліком.
    ["check", "toolsCheck", "buildBack"], ["run", "toolsRun", "ff"],
  ] as const) {
    const ids = planSteps(phase, "full").map((x) => x.id);
    const t = ids.indexOf(tool), d = ids.indexOf(destroyer);
    assert.ok(t >= 0, `🔴 у фазі ${phase} немає перевірки середовища взагалі`);
    assert.ok(d >= 0, `🔴 у фазі ${phase} зник руйнівний крок — тест звіряє порядок із порожнечею`);
    assert.ok(t < d,
      `🔴 у фазі ${phase} перевірка середовища стоїть ПІСЛЯ «${destroyer}», який починається з rm -rf dist. `
      + "Це рівно та послідовність, що лишила прод без збірки.");
  }
  // Дзеркало: детектор порядку вміє побачити порушення, інакше він завжди зелений.
  const swapped = ["deliver", "toolsRun"];
  assert.ok(swapped.indexOf("toolsRun") > swapped.indexOf("deliver"),
    "🔴 сам детектор порядку не працює");
});

test("#226j ФІНАЛЬНЕ ТВЕРДЖЕННЯ: buildStale == false — крок, а не спостереження", () => {
  // Детектор існував увесь час (`/api/health.buildStale`) — бракувало ТВЕРДЖЕННЯ.
  // Обірваний ланцюг лишає стан, який болить не зараз, а при наступній дії.
  const ids = planSteps("run", "full").map((x) => x.id);
  assert.ok(ids.includes("buildFresh"), "🔴 у плані немає перевірки свіжості збірки на диску");
  assert.ok(ids.indexOf("buildFresh") > ids.indexOf("healthVersion"),
    "🔴 buildFresh мусить іти ПІСЛЯ рестарту: до нього buildStale=true — це НОРМА, а не поломка");
  // І в легкому режимі теж: косметичний викат так само здатен лишити диск і памʼять різними.
  assert.ok(planSteps("run", "light").map((x) => x.id).includes("buildFresh"),
    "🔴 легкий режим не перевіряє свіжість збірки — саме там її й забувають");
  assert.deepEqual(missingHandlers().map((x) => x.id), [],
    "🔴 крок у реєстрі БЕЗ обробника: він мовчки не виконається, а звіт покаже план цілим");
});

test("#226k АВАРІЙНИЙ ВИХІД КАЖЕ ПРО ЗАМОК, який лишився взятим", async () => {
  const { abortState } = await import("./deployPlan.js");
  const ctx = { prodSha: "7915551", targetSha: "4a5655f", branch: "claude/friendly-galileo-8pijhl" };
  // Замок узято, робота обірвана — він мусить лишитись, і про це треба сказати вголос:
  // мовчазний замок за годину читається як забуте сміття, і його почнуть зривати.
  const a = abortState("deliver", ["toolsRun", "lockTake"], ctx);
  const txt = a.lines.join("\n");
  assert.match(txt, /ЗАМОК ЧЕКАУТУ ЛИШАЄТЬСЯ ВЗЯТИМ/, "🔴 про взятий замок не сказано — його зірвуть як сміття");
  assert.match(txt, /--release/, "🔴 не дано команди звільнення — звільнятимуть `rm`, і журнал не побачить нічого");
  // Дзеркало: якщо замок уже звільнено, попередження не сміє зʼявлятись — інакше шум.
  assert.doesNotMatch(abortState("report", ["lockTake", "lockRelease"], ctx).lines.join("\n"),
    /ЛИШАЄТЬСЯ ВЗЯТИМ/, "🔴 попередження про замок друкується завжди — його перестануть читати");
});
