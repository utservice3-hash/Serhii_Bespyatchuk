import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTap, normaliseName, judgeDelta, type TapLine } from "./testDelta.js";

/**
 * 📊 #230–#230g — КРИТЕРІЙ КРОКУ `test` У ВИКАТІ.
 *
 * Усі без БД, мережі й прода: чисті функції на власних фікстурах, тож червоніють
 * у будь-якому оточенні й у будь-який день (урок #220-#221b).
 */
const L = (name: string, ok: boolean, skipped = false): TapLine => ({ name, ok, skipped });

test("#230 НОРМАЛІЗАЦІЯ ШЛЯХУ: та сама смерть файлу з різних чекаутів — ОДНЕ імʼя", () => {
  // 📐 Заміряно 26.08.2026 на ОДНАКОВОМУ коді: 8 зі 104 падінь — смерть ФАЙЛУ, і TAP
  // називає її абсолютним шляхом. База в worktree, дерево в клоні → сирі імена дали
  // «8 зникло, 8 зʼявилось». Тобто порівняння по іменах БЕЗ нормалізації — не краще
  // за порівняння по числу, а новий спосіб збрехати в обидва боки одночасно.
  const a = normaliseName("/tmp/deploy-base-x7/backend/dist/ai/oracle.test.js");
  const b = normaliseName("/home/user/Serhii_Bespyatchuk/backend/dist/ai/oracle.test.js");
  assert.equal(a, b, "🔴 та сама смерть файлу з двох чекаутів дала різні імена");
  assert.equal(a, "dist/ai/oracle.test.js");
  const d = judgeDelta(
    [L("/tmp/deploy-base-x7/backend/dist/ai/oracle.test.js", false)],
    [L("/home/user/Serhii_Bespyatchuk/backend/dist/ai/oracle.test.js", false)]);
  assert.deepEqual(d.newFailures, [], "🔴 однакове падіння прочитано як НОВЕ");
  assert.deepEqual(d.vanishedFailures, [], "🔴 однакове падіння прочитано як ЗНИКЛЕ");
  // Дзеркало: звичайне імʼя тесту нормалізація НЕ сміє чіпати.
  assert.equal(normaliseName("#42 щось · про dist/ai"), "#42 щось · про dist/ai");
});

test("#230b РОЗЕКРАНУВАННЯ TAP: екранована решітка — той самий тест", () => {
  // TAP екранує решітку. Той самий баг я вже мав у gateCount: гейт читався одночасно
  // як зниклий і як доданий.
  assert.equal(normaliseName("\\#6 БЕЗПЕКА · «users» не читає ЖОДНА метрика"),
    "#6 БЕЗПЕКА · «users» не читає ЖОДНА метрика");
  const d = judgeDelta([L("\\#6 A", false)], [L("#6 A", false)]);
  assert.deepEqual([...d.newFailures, ...d.vanishedFailures], [],
    "🔴 екранування зробило з одного падіння два різні");
});

test("#230c ① НОВЕ ПАДІННЯ — крок ЧЕРВОНИЙ", () => {
  const d = judgeDelta([L("#1 A", true)], [L("#1 A", false)]);
  assert.equal(d.ok, false, "🔴 нове падіння пропущено");
  assert.deepEqual(d.newFailures, ["#1 A"]);
  assert.match(d.lines.join("\n"), /НОВІ ПАДІННЯ/);
});

test("#230d ДЗЕРКАЛО: те саме падіння вже є НА БАЗІ — крок ЗЕЛЕНИЙ", () => {
  // 🔴 Без цієї половини критерій нічого не вартий: він виродився б у «нуль падінь»,
  // тобто рівно в те, що є зараз і чого не можна виконати в жодному середовищі.
  const base = [L("#1 A", false), L("#2 B", true)];
  const tree = [L("#1 A", false), L("#2 B", true)];
  const d = judgeDelta(base, tree);
  assert.equal(d.ok, true, "🔴 успадковане падіння прочитано як своє — крок знову невиконуваний");
  assert.match(d.lines.join("\n"), /приріст падінь 0/);
});

test("#230e ② ВИКОНАНЕ НЕ ЗВУЗИЛОСЬ: тест став скіпом — ЧЕРВОНО при НУЛІ падінь", () => {
  // 🔴 Найтихіша поломка: падінь не побільшало, гейт оголошений, а перевіряти перестали.
  // Заміряно на власному прикладі: «полагоджене» оточення дає бездоганні 459 ✔ / 0 падінь
  // і НЕ ВИКОНУЄ двохсот тестів — ані ①, ані ③ цього не бачать.
  const base = [L("#1 A", true), L("#2 B", true)];
  const tree = [L("#1 A", true), L("#2 B", true, /* skipped */ true)];
  const d = judgeDelta(base, tree);
  assert.equal(d.newFailures.length, 0, "фікстура зіпсована: тут не має бути падінь");
  assert.equal(d.ok, false, "🔴 тест перестав виконуватись, а крок зелений");
  assert.deepEqual(d.stoppedExecuting, ["#2 B"]);
  assert.match(d.lines.join("\n"), /ПЕРЕСТАЛИ ВИКОНУВАТИСЬ/);
  // Той самий стан, коли тест просто ЗНИК із прогону, — теж ловиться.
  assert.equal(judgeDelta(base, [L("#1 A", true)]).ok, false, "🔴 зниклий тест не помічено");
  // Дзеркало: доданий скіп, якого на базі не було, — НЕ звуження.
  assert.equal(judgeDelta(base, [...tree.slice(0, 1), L("#2 B", true), L("#3 C", true, true)]).ok, true,
    "🔴 новий скіпнутий тест прочитано як звуження — крок став би шумом");
});

test("#230f ③ ЗНИКЛИЙ ГЕЙТ — ЧЕРВОНО, навіть коли падінь СТАЛО МЕНШЕ", () => {
  // Саме та дія, якої ми боїмось найбільше: зняв гейт → падінь менше → «покращення».
  const base = [L("#1 A", false), L("#2 B", true)];
  const tree = [L("#1 A", true)];
  const d = judgeDelta(base, tree, ["#2 B гейт, який зняли"]);
  assert.equal(d.ok, false, "🔴 зняття гейта зараховано як покращення");
  assert.match(d.lines.join("\n"), /ЗНИКЛИ ГЕЙТИ/);
  // Дзеркало: без зниклих гейтів та сама картина лишається зеленою по ③.
  assert.deepEqual(judgeDelta([L("#1 A", false)], [L("#1 A", true)]).lostGates, []);
});

test("#230g ЗНИКЛЕ ПАДІННЯ НАЗИВАЄТЬСЯ, а не зараховується як тиха перемога", () => {
  // «105 проти 106» виглядало покращенням на одне падіння; розбір по іменах показав
  // одне СПРАВЖНЄ нове падіння. Голе число сховало б регресію під виглядом поліпшення.
  const d = judgeDelta([L("#1 A", false), L("#2 B", false)], [L("#1 A", true), L("#2 B", false)]);
  assert.equal(d.ok, true, "зникле падіння саме по собі не є поломкою");
  assert.deepEqual(d.vanishedFailures, ["#1 A"]);
  assert.match(d.lines.join("\n"), /зникло падінь: 1/, "🔴 зникле падіння не назване — його зарахують як перемогу");
  assert.match(d.lines.join("\n"), /нетотожні середовища/, "🔴 не сказано ДРУГОЇ причини — читач вирішить, що це фікс");
});

test("#230h РОЗБІР TAP: скіп не є виконанням, директива не є частиною імені", () => {
  const tap = [
    "ok 1 - \\#42 звичайний",
    "not ok 2 - \\#43 упав",
    "ok 3 - \\#44 пропущений # SKIP потрібен DATABASE_URL",
    "not ok 4 - /repo/backend/dist/ai/oracle.test.js",
    "# tests 4",
  ].join("\n");
  const t = parseTap(tap);
  assert.equal(t.length, 4, "🔴 розбір узяв не ті рядки");
  assert.deepEqual(t.map((x) => x.name),
    ["#42 звичайний", "#43 упав", "#44 пропущений", "dist/ai/oracle.test.js"]);
  assert.deepEqual(t.map((x) => x.skipped), [false, false, true, false],
    "🔴 скіп не відрізнено від виконання — уся ② половина критерію стає сліпою");
  assert.deepEqual(t.map((x) => x.ok), [true, false, true, false]);
  // Порожній результат = провал: розбір порожнечі не сміє віддавати «падінь немає».
  assert.deepEqual(parseTap("жодного TAP-рядка"), []);
});
