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
  /**
   * 🔴 ДЖЕРЕЛО, А НЕ `dist` — і це не дрібниця, а урок цього ж гейта.
   * Перша редакція брала `import.meta.dirname/../routes`, тобто `dist/routes`, де лежать
   * зібрані `.js`. Фільтр по `.ts` не знаходив нічого, і гейт «проходив» над ПОРОЖНІМ
   * простором. Спіймала його власна перевірка на непорожність — саме для цього вона й є.
   */
  const dir = path.join(import.meta.dirname, "..", "..", "..", "backend", "src", "routes");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length > 5,
    `🔴 у ${dir} знайдено ${files.length} файлів роутів — гейту не було що перевіряти`);

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

/**
 * #342 / #342b — ВІДСУТНІЙ ОБСЯГ РОЗВʼЯЗУЄТЬСЯ В НАЙВУЖЧЕ, А НЕ У «ВСЮ КОМПАНІЮ».
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМО ВІД #341. Той стереже ДВЕРІ ЗАПИСУ: що приймає роут. А рішення
 * «яким є обсяг ролі, коли його немає» ухвалюється на ЧИТАННІ — `rbac.scopeCompatRole`
 * має власний фолбек. Заміряно 04.09.2026: заміна там `?? "own"` на `?? "company"`
 * лишала #341, #341b і матричні гейти ЗЕЛЕНИМИ. Тобто рівно та умова червоніння, якої
 * вимагає ТЗ 5.3 («зроби відсутність значення рівносильною company → червоніє»), не
 * стереглася нічим.
 *
 * ⚠️ Напрям має значення: `own` тут — не «дефолт зі смаку», а fail-closed. Помилка в цей
 * бік ховає дані від того, кому можна (видно одразу, скаржаться). Помилка в інший —
 * роздає чужі дані мовчки, і не скаржиться ніхто.
 */
const stubEnv = (): void => {
  process.env.DATABASE_URL ??= "postgresql://stub@localhost/stub";
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
};

test("#342 НЕВІДОМИЙ ОБСЯГ РОЛІ → найвужче, а не «вся компанія»", async () => {
  stubEnv();
  const { scopeCompatRole } = await import("./rbac.js");
  type Def = Parameters<typeof scopeCompatRole>[1];
  // Роль, якої немає в кеші, — найчастіший шлях сюди: fail-closed при збої завантаження.
  assert.equal(scopeCompatRole("роль_якої_немає", undefined), "manager",
    "🔴 невідома роль отримала ширший за найвужчий обсяг — збій кеша ролей роздав би дані");
  // Роль є, але обсяг не оголошений — той самий випадок, що завів нас сюди.
  const noScope = { key: "x", name: "x", builtIn: false, screenAccess: {}, permissions: {} } as unknown as Def;
  assert.equal(scopeCompatRole("x", noScope), "manager",
    "🔴 роль без оголошеного обсягу бачить більше за найвужче — саме це забороняє ТЗ 5.3");
});

test("#342b 🪞 ДЗЕРКАЛО: оголошені обсяги працюють, і admin_scope далі підіймає", async () => {
  stubEnv();
  const { scopeCompatRole } = await import("./rbac.js");
  type Def = Parameters<typeof scopeCompatRole>[1];
  const def = (dataScope: string, permissions: Record<string, boolean> = {}) =>
    ({ key: "x", name: "x", builtIn: false, dataScope, screenAccess: {}, permissions }) as unknown as Def;
  // Без цього боку #342 задовольнявся б кодом, що звужує ВСІХ до менеджера.
  assert.equal(scopeCompatRole("x", def("company")), "company", "🔴 company-обсяг не доїхав");
  assert.equal(scopeCompatRole("x", def("team")), "team_lead", "🔴 team-обсяг не доїхав");
  assert.equal(scopeCompatRole("x", def("own")), "manager", "🔴 own-обсяг не доїхав");
  assert.equal(scopeCompatRole("x", def("own", { admin_scope: true })), "admin",
    "🔴 право admin_scope перестало підіймати роль — це вже інша поломка, і вона теж наша");
});
