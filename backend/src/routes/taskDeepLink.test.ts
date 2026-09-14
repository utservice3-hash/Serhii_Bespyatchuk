import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🔗 #406–#406c — ПРЯМЕ ПОСИЛАННЯ НА ЗАДАЧУ (`/tasks?id=3367`).
 *
 * 📐 ПРОХАННЯ ВЛАСНИЦІ 14.09.2026: «зараз доводиться писати „зайди в задачник і
 * пошукай", а хочеться кидати посилання одразу на потрібну».
 *
 * ✅ ТУТ ГАНЯЄТЬСЯ СПРАВЖНІЙ МОДУЛЬ ФРОНТУ, А НЕ ЙОГО ПЕРЕКАЗ: `.ts` транспілюється
 * на льоту й імпортується (прийом `#138`). Переписати правило «схоже» в тесті
 * означало б доводити ні про що — саботаж у справжньому файлі мусить червонити.
 *
 * 🔴 ЧОМУ ЛОГІКА ВИНЕСЕНА В ОКРЕМИЙ `.ts`, А НЕ ЛИШИЛАСЬ УМОВОЮ В JSX. Твердження
 * через позицію рядка у файлі падає від чужого коментаря і мовчить від дефекту
 * (правило 10). Чиста функція дає фікстури по ОБИДВА боки межі (правило 11).
 */

const FE_ROOT = new URL("../../../frontend/src/", import.meta.url);
const LINK_TS = fileURLToPath(new URL("pages/dashboard/taskDeepLink.ts", FE_ROOT));
const SECTION_TSX = fileURLToPath(new URL("pages/dashboard/sections/TasksSection.tsx", FE_ROOT));

/** Коментарі вирізаються: у доках фіксу цитується САМЕ хибний рядок. */
const stripComments = (src: string): string =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

async function loadLink(): Promise<{
  parseTaskIdParam: (search: string) => number | null;
  deepLinkState: (a: { openTaskId: number | null; found: boolean; settled: boolean }) => string;
}> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(LINK_TS, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/**
 * #406 — `?id=` ЧИТАЄТЬСЯ ЛИШЕ ЯК ДОДАТНЕ ЦІЛЕ.
 *
 * 🔴 ПРАВИЛО ДЗЕРКАЛИТЬ СЕРВЕР (`routes/tasks.ts` → `pathId`). Якщо фронт пропустить
 * сміття, у три запити супутників картки (стрічка, файли, історія) поїде `NaN`, і
 * людина отримає три НЕВИДИМІ 400 замість чесного «задача недоступна».
 *
 * ⚠️ Фікстури стоять по ОБИДВА боки межі: не лише «валідне читається», а й кожен
 * спосіб бути невалідним. Односторонній набір зеленів би й на функції, що завжди
 * повертає число.
 *
 * 🧨 САБОТАЖ: у `taskDeepLink.ts` замінити `Number.isInteger(n) && n > 0` на `true`
 * → червоніє на `?id=abc` (NaN замість null).
 */
test("#406 ?id= читається лише як додатне ціле, решта — null", async () => {
  const { parseTaskIdParam } = await loadLink();
  assert.equal(parseTaskIdParam("?id=3367"), 3367, "🔴 валідний id не прочитався — посилання мертве");
  assert.equal(parseTaskIdParam("?id=1&x=2"), 1, "🔴 id поруч з іншими параметрами не читається");
  for (const bad of ["", "?x=1", "?id=", "?id=abc", "?id=0", "?id=-5", "?id=12x", "?id=1.5"]) {
    assert.equal(parseTaskIdParam(bad), null,
      `🔴 «${bad}» прочиталось як id. Сміття поїде в три запити супутників, і людина `
      + "побачить порожній екран замість причини");
  }
});

/**
 * #406b — СЕКЦІЯ СПРАВДІ СІДАЄ СТАН ІЗ URL І ПИШЕ ЙОГО НАЗАД, В ОБИДВА БОКИ.
 *
 * 🔴 ДВОБІЧНО СВІДОМО. Сама лише «ставить `id` при відкритті» лишала б параметр у
 * рядку адреси після закриття картки: людина закрила задачу, скопіювала URL — і
 * віддала посилання на вже закриту. Тому парне твердження про `delete`.
 *
 * 🔴 І ЧОМУ `replaceState`, А НЕ `pushState` — та сама причина, що в «Клієнтах»:
 * інакше кожне відкриття картки кладе запис в історію, і «назад» гортає їх замість
 * повернути людину туди, звідки вона прийшла.
 *
 * 🧨 САБОТАЖ: замінити ініціалізатор на `useState<number | null>(null)` → червоніє.
 */
test("#406b секція сідає з URL і синхронізує параметр в обидва боки", () => {
  const src = stripComments(readFileSync(SECTION_TSX, "utf8"));
  assert.match(src, /useState<number \| null>\(\(\) => parseTaskIdParam\(window\.location\.search\)\)/,
    "🔴 картка більше не сідає з URL — посилання /tasks?id= відкриває просто список");
  assert.match(src, /searchParams\.set\("id", String\(openTaskId\)\)/,
    "🔴 відкрита картка не пише id в URL — посилання нема звідки скопіювати");
  assert.match(src, /searchParams\.delete\("id"\)/,
    "🔴 закрита картка лишає id в URL — скопійоване посилання веде на вже закриту задачу");
  assert.match(src, /history\.replaceState/,
    "🔴 синхронізація пішла через pushState — «назад» гортатиме відкриття карток");
});

/**
 * #406c — ПОРОЖНЕЧА НАЗИВАЄ СЕБЕ, І НЕ БЛИМАЄ НА ВАЛІДНОМУ ПОСИЛАННІ.
 *
 * 🔴 ДВА ТВЕРДЖЕННЯ, І ДРУГЕ ВАЖЛИВІШЕ. (1) id є, завантаження ЗАВЕРШИЛОСЬ, задачі
 * немає → «missing»: екран мусить сказати причину, а не мовчати. (2) те саме, але
 * завантаження ще НЕ завершувалось → «loading», не «missing».
 *
 * 📐 Чому (2) не теоретичне: `tasksLoading` стартує `false` (`Dashboard.tsx`) і стає
 * `true` лише коли ефект добіг до запиту. Тобто на першому намальованому кадрі —
 * `loading=false` і `tasks=[]` ОДНОЧАСНО. Перевірка, побудована на `!loading`,
 * блимнула б «недоступна» на КОЖНОМУ глибокому посиланні, включно з валідним.
 *
 * ⚠️ І окремо — що функція взагалі КЛИКАНА: правильне правило нічого не варте, поки
 * виклик іде повз нього (урок `#139`).
 *
 * 🧨 САБОТАЖ: у `deepLinkState` замінити `return "missing";` на `return "idle";`
 * → червоніє перше твердження; прибрати `if (!a.settled) return "loading";`
 * → червоніє друге.
 */
test("#406c недоступна задача називає себе, а валідна не блимає", async () => {
  const { deepLinkState } = await loadLink();
  assert.equal(deepLinkState({ openTaskId: null, found: false, settled: true }), "idle",
    "🔴 без id секція вважає, що є глибоке посилання");
  assert.equal(deepLinkState({ openTaskId: 3367, found: true, settled: true }), "open",
    "🔴 знайдена задача не відкривається");
  assert.equal(deepLinkState({ openTaskId: 3367, found: false, settled: false }), "loading",
    "🔴 БЛИМАННЯ: до завершення першого завантаження екран уже каже «недоступна». "
    + "На першому кадрі tasksLoading=false і tasks=[] одночасно, тож це вдарить по "
    + "КОЖНОМУ глибокому посиланню, включно з валідним");
  assert.equal(deepLinkState({ openTaskId: 3367, found: false, settled: true }), "missing",
    "🔴 недоступна задача знову мовчить — людина бачить порожній екран без причини");

  const src = stripComments(readFileSync(SECTION_TSX, "utf8"));
  assert.match(src, /deepLinkState\(\{/,
    "🔴 секція не кличе deepLinkState — правило є, а екран повз нього");
  assert.match(src, /deepLink === "missing"/,
    "🔴 стан «missing» ніде не малюється — порожнеча знову не називає себе");
});
