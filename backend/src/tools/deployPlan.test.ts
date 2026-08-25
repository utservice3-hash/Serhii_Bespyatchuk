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
