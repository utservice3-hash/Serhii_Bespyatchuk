import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🕰 #144–#144b — АНКЕТИ, СТАРІШІ ЗА РЕЄСТР ФОРМ, МУСЯТЬ ПОКАЗУВАТИ СВІЙ ЗМІСТ.
 *
 * 🔴 БАГ, ЩО ЦЕ ПОРОДИВ (заміряно на бойовій базі 24.08.2026, read-only). Чотири
 * зустрічі типу A від 01.07 писались 15-17.07 — ДО того, як 29.07 посіяли
 * `one_on_one_forms`. `form_version` у них 1 просто тому, що це DEFAULT колонки. Їхні
 * ключі (`energy_score`, `growth_dir`…) не збігаються з ключами форми A жодної версії,
 * тож «Історія» показувала число 8.7, а клік по ньому відкривав ПОРОЖНЮ анкету.
 * Точний обсяг: **59 полів у 4 зустрічах, видимих в інтерфейсі — 0**.
 *
 * ✅ ФІКСТУРА НИЖЧЕ — СПРАВЖНІЙ ЗАПИС АНТИПЕНКА, а не вигаданий: сім пікерів
 * (8/9/8/10/7/10/9) дають рівно ті 8.7, що стоять у «Історії» на проді.
 */

const FE = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/oneOnOneLegacy.ts", import.meta.url));
const SECTION = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/OneOnOneSection.tsx", import.meta.url));
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

async function loadLegacy() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/** Запис Антипенка від 01.07 — ключі й бали як у проді. */
const LEGACY_RECORD = {
  prev: { text: "Домовленості виконані частково." },
  result_score: { score: 7 }, result_factors: { text: "Заважали затримки перевізників." },
  intake_score: { score: 9 }, repeat_score: { score: 10 },
  client_challenges: { text: "Клієнти тиснуть по ставці." },
  process_blockers: { text: "Ручне заведення заявок." },
  energy_score: { score: 8 }, motivation: { text: "Мотивує результат команди." },
  retention_score: { score: 10 }, growth_gap: { text: "Бракує англійської." },
  growth_dir: { text: "Хочу рости в міжнародку." }, support_score: { score: 9 },
  summary: { text: "Загалом місяць рівний." }, action_plan: { text: "Взяти два міжнародні рейси." },
  overall_score: { score: 8 },
};
/** Активна форма A — саме ті ключі, через які легасі-анкета й ставала порожньою. */
const FORM_A = { sections: [{ key: "s", title: "Оцінка продуктивності", questions: [
  { qKey: "a_prod", label: "Оціни свою продуктивність", field: "score_text" },
  { qKey: "a_emotion", label: "Емоційний стан", field: "score_text" },
] }] };

/**
 * #144 — ЗМІСТ СТАРОЇ АНКЕТИ ВИДИМИЙ, І ПИТАННЯ — СПРАВЖНІ.
 *
 * 🧨 САБОТАЖ (виконано): звузити `unmappedKeys` назад до ключів форми (тобто повернути
 * мапінг лише на `a_*`) — секцій стає нуль, анкета знову порожня, гейт червоніє.
 */
test("#144 анкета, старіша за реєстр форм, показує свої питання, а не порожнечу", async () => {
  const { legacySections, unmappedKeys, averageOfScores, LEGACY_QUESTIONS } = await loadLegacy();

  const secs = legacySections(LEGACY_RECORD, FORM_A);
  assert.ok(secs.length > 0, "🔴 жодної секції — стара анкета лишилась порожньою, це і є той баг");

  // 🔴 І ПОРОЖНЮ ФОРМУ НЕ МАЛЮЄМО. Інакше зверху екран прочерків, а зміст під ним —
  // саме так виглядав перший знімок цього фікса.
  const { isFullyUnmapped } = await loadLegacy();
  assert.equal(isFullyUnmapped(LEGACY_RECORD, FORM_A), true);
  assert.equal(isFullyUnmapped({ a_prod: { score: 8 } }, FORM_A), false, "🔴 сучасний запис визнано «повністю чужим»");
  assert.equal(isFullyUnmapped({ a_prod: { score: 8 }, energy_score: { score: 5 } }, FORM_A), false,
    "🔴 часткова розбіжність сховала б форму, яка чесно показує свою частину");
  assert.equal(isFullyUnmapped({}, FORM_A), false);

  // 🔴 НІЧОГО НЕ ЗАГУБИЛОСЬ. Показаних питань має бути РІВНО стільки, скільки ключів у
  // відповідях: рендер, що ховає частину, — це та сама поломка, лише тихіша.
  type Shown = { qKey: string; label: string; known: boolean };
  const shown: Shown[] = secs.flatMap((s: { questions: Shown[] }) => s.questions);
  assert.equal(shown.length, Object.keys(LEGACY_RECORD).length,
    "🔴 показано не всі відповіді запису");

  // Питання — СПРАВЖНІ тексти (відновлені з e31c0bf), а не ключі.
  const byKey = new Map<string, Shown>(shown.map((q) => [q.qKey, q]));
  assert.equal(byKey.get("energy_score")!.label, "Оціни свій рівень енергії та залученості зараз.");
  assert.equal(byKey.get("action_plan")!.label, "План дій до наступної зустрічі (конкретні кроки).");
  assert.ok(shown.every((q) => q.known), "🔴 знайомий ключ позначено як невідомий");

  // 🔴 ПОРЯДОК СТАЛИЙ. `jsonb` порядку ключів не зберігає; якби рендер ішов за
  // `Object.keys`, та сама зустріч виглядала б різною при кожному відкритті.
  const order = shown.map((q) => q.qKey);
  const expected = LEGACY_QUESTIONS.map((q: { qKey: string }) => q.qKey).filter((k: string) => k in LEGACY_RECORD);
  assert.deepEqual(order, expected, "🔴 порядок питань залежить від порядку ключів у JSON");

  // Розкриття ПОЯСНЮЄ число, а не сперечається з ним: 8/9/8/10/7/10/9 → 8.7, як у «Історії».
  const avg = averageOfScores(LEGACY_RECORD, unmappedKeys(LEGACY_RECORD, FORM_A));
  assert.equal(avg, 8.7, "🔴 середнє по показаних пікерах не дорівнює числу, яке стоїть у таблиці");

  // 🔴 І ЗВІРЯТИСЬ ВОНО МУСИТЬ ЧИСЛОВО. `overall` — це `numeric`, а `pg` без парсерів
  // типів (їх у проєкті немає) віддає такі поля РЯДКОМ. Строге `===` завжди хибне, тож
  // підпис казав би «числа різні» саме там, де вони однакові. Спіймано знімком екрана.
  const { sameScore } = await loadLegacy();
  assert.equal(sameScore(avg, "8.7"), true, "🔴 порівняння не числове — рядок із бекенда не збігається сам із собою");
  assert.equal(sameScore(avg, 8.7), true);
  assert.equal(sameScore(avg, "7"), false, "🔴 різні числа визнано однаковими");
  assert.equal(sameScore(null, "8.7"), false);
  assert.equal(sameScore(avg, null), false);
});

/**
 * #144b — БЛОК ЗʼЯВЛЯЄТЬСЯ ЛИШЕ ТАМ, ДЕ ТРЕБА, І ДОХОДИТЬ ДО ЕКРАНА.
 *
 * 🧨 САБОТАЖ (виконано): прибрати рендер `{legacy.length > 0 && …}` з
 * `HistoryRecordModal` — чиста функція лишається правильною, а на екрані знову порожньо;
 * гейт червоніє на перевірці джерела.
 */
test("#144b сучасний запис не дублюється, невідомий ключ не ковтається, блок є в рендері", async () => {
  const { legacySections, UNKNOWN_GROUP } = await loadLegacy();

  // 🪞 ДЗЕРКАЛО: запис, чиї ключі форма ЗНАЄ, не повинен давати жодної легасі-секції —
  // інакше кожна нормальна анкета показувалась би двічі.
  assert.deepEqual(legacySections({ a_prod: { score: 8 }, a_emotion: { text: "ок" } }, FORM_A), [],
    "🔴 сучасний запис поїхав у блок «старішого зразка» — на екрані зʼявився б дубль");
  assert.deepEqual(legacySections({}, FORM_A), []);

  // Ключ, якого немає навіть в історичному наборі, показуємо ЯК Є й підписуємо.
  const secs = legacySections({ energy_score: { score: 5 }, wat_is_this: { text: "щось" } }, FORM_A);
  const unknown = secs.find((s: { title: string }) => s.title === UNKNOWN_GROUP);
  assert.ok(unknown, "🔴 невідомий ключ проковтнуто — це та сама втрата, лише тихіша");
  assert.equal(unknown.questions[0].qKey, "wat_is_this");
  assert.equal(unknown.questions[0].known, false);

  // 🔴 І БЛОК МУСИТЬ БУТИ В РЕНДЕРІ. Правильна функція нічого не варта, поки її ніхто
  // не малює — рівно так виглядав баг Задачника (`patchTaskLocal` бездоганний, а поруч
  // `.then(setTasks)` його стирав).
  const src = stripComments(readFileSync(SECTION, "utf8"));
  assert.match(src, /const legacy = legacySections\(/, "🔴 модалка не рахує легасі-секції");
  assert.match(src, /\{legacy\.length > 0 && \(/, "🔴 легасі-блок не рендериться — анкета лишається порожньою");
  assert.match(src, /Анкета старішого зразка/, "🔴 блок без підпису: людина не зрозуміє, звідки ці питання");
});
