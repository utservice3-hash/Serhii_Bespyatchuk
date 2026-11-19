import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #9966 — У «ЗВІТІ КВП» КЕШУЄТЬСЯ ЛИШЕ ТЕ, ЩО НЕ ЗАЛЕЖИТЬ НІ ВІД ПЕРІОДУ, НІ ВІД ГЛЯДАЧА.
 *
 * `/kvp-report` бере сім викликів через лінивий кеш «Огляду» (60 с). Ключ кешу будується з
 * аргументів, тож чужий скоуп у відповідь не просочиться. Але кешувати виклик, що залежить від
 * періоду, означало б плодити ключі на кожен період без жодної користі. Тому правило таке:
 * кожен кешований виклик цього роуту приймає порожній скоуп `{}` і, щонайбільше, рядкові літерали.
 * Межі блоку змістові: від оголошення роуту до наступного роуту.
 */
const SRC = path.join(import.meta.dirname, "..", "..", "src", "routes", "dashboard.ts");

test("#9966 КЕШ У «ЗВІТІ КВП»: лише виклики з порожнім скоупом, і їх рівно сім", () => {
  const src = readFileSync(SRC, "utf8");
  const a = src.indexOf('dashboardRouter.get("/kvp-report", async');
  const b = src.indexOf('dashboardRouter.get("/manager-report", async');
  assert.ok(a > 0 && b > a, "🔴 не знайшов меж роуту /kvp-report");
  const calls = [...src.slice(a, b).matchAll(/overviewCache\.call\(("[^"]+"),\s*([\w.]+),\s*([^)]*)\)/g)];
  assert.equal(calls.length, 7, `🔴 кешованих викликів у /kvp-report ${calls.length}, а не 7 — склад кешу змінився, перевір кожен новий`);
  for (const c of calls) {
    const args = c[3].split(",").map((x) => x.trim());
    assert.equal(args[0], "{}", `🔴 ${c[1]} кешується з непорожнім скоупом (${args[0]}) — відповідь залежить від періоду чи глядача`);
    for (const extra of args.slice(1))
      assert.match(extra, /^"[a-z]+"$/, `🔴 ${c[1]} кешується з аргументом ${extra}, який не є рядковим літералом`);
  }
  // 🪞 Дзеркало: періодозалежні гроші періоду кешем НЕ накриті.
  assert.ok(/money\.receivedMoney\(mScope\)/.test(src.slice(a, b)), "🔴 гроші періоду зникли з роуту або пішли в кеш");
  // Доступ: кеш спільний для всіх, хто бачить екран, тож екран мусить лишатись за своєю вкладкою.
  assert.ok(/roleHasTab\(auth\.roleKey, "kvp"\)/.test(src.slice(a, a + 600)), "🔴 /kvp-report більше не перевіряє вкладку «kvp» на вході");
});
