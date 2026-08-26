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
