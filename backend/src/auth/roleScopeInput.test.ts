import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseDataScope, DATA_SCOPES } from "./roleScopeInput.js";

/**
 * #341 / #341b — ОБСЯГ ДАНИХ РОЛІ НЕ МАЄ МОВЧАЗНОГО ЗНАЧЕННЯ.
 *
 * Передісторія й ціна — у доккоментарі `roleScopeInput.ts`. Тут — рівно два твердження:
 * розбір не вигадує значення, і жоден роут не вигадує його поруч.
 *
 * ⚠️ Гейт навмисно стоїть на ЧИСТІЙ функції, а не на тексті `settings.ts`: твердження
 * через проксі падає від рефакторингу й мовчить від дефекту.
 */

test("#341 ОБСЯГ РОЛІ: відсутнє значення дає null, а НЕ найвужчий обсяг", () => {
  // ── по один бік межі: усі три законні значення проходять як є
  for (const s of DATA_SCOPES) {
    assert.equal(parseDataScope(s), s, `🔴 законний обсяг «${s}» не пройшов розбір`);
  }
  // ── по другий бік: усе інше — це «не передали», і саме null, бо будь-яке
  // підставлене значення тут є рішенням ЗА людину. `own` мовчки ховає доступ
  // (заміряно: бухгалтерія бачила 0 рядків при 72 у власника), `company` мовчки
  // роздає чужі дані. Обидва варіанти — помилки, і друга дорожча.
  for (const bad of [undefined, null, "", "Own", "OWN", "all", "everything", 0, 1, true, {}, []]) {
    assert.equal(parseDataScope(bad), null,
      `🔴 «${JSON.stringify(bad)}» розібрано як значення — розбір вигадав обсяг замість відмовити`);
  }
  // Найгостріший випадок окремо: колишній дефолт більше не повертається НІЗВІДКИ.
  assert.notEqual(parseDataScope(undefined), "own",
    "🔴 повернувся мовчазний `own` — це рівно той дефолт, через який роль створювали сліпою");
});

test("#341b 🪞 ДЗЕРКАЛО: жоден роут не розбирає обсяг самотужки", () => {
  const dir = path.join(import.meta.dirname, "..", "routes");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length > 0, "🔴 каталог роутів порожній — гейту не було що перевіряти");

  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(path.join(dir, f), "utf8");
    // Ознака власного розбору: перелік трьох обсягів, виписаний у самому роуті.
    // Саме так виглядав рядок, що ставив мовчазний `own`.
    const ownList = /["']own["']\s*,\s*["']team["']\s*,\s*["']company["']/.test(src);
    if (ownList) offenders.push(f);
    // І другий бік: хто ПИШЕ data_scope, мусить брати значення з розбору.
    if (/data_scope\s*=\s*\$/.test(src) && !src.includes("parseDataScope")) {
      offenders.push(`${f} (пише data_scope повз parseDataScope)`);
    }
  }
  assert.deepEqual(offenders, [],
    "🔴 роут розбирає обсяг даних сам. Копія розійдеться з оригіналом тихо — саме так "
    + "мовчазний `own` і прожив непоміченим:\n  " + offenders.join("\n  "));
});
