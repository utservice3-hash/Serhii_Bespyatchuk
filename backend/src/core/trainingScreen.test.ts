import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🎓 ЕКРАН «НАВЧАННЯ» — ОДИН ДЛЯ ЧИТАЧА Й РЕДАКТОРА (23.09.2026) — гейти `#703`–`#705`.
 * Номери з запасом над `#702` — борг 17: перед мержем перемірити перетин.
 */
const fe = (p: string) => readFileSync(fileURLToPath(new URL(`../../../frontend/src/${p}`, import.meta.url)), "utf8");
const COURSES = "pages/dashboard/sections/TrainingCourses.tsx";
const SECTION = "pages/dashboard/sections/TrainingSection.tsx";

/**
 * #703 — ПЕРШИМ ВІДКРИВАЄТЬСЯ КУРС, А НЕ СХОВИЩЕ: вкладка «Курси» стоїть перед «Бібліотекою» і є
 * початковою, а бібліотеку видно всім, не лише редакторам. Після переносу Академії Sereda в корені
 * бібліотеки 47 тем, тож починати з неї означало показувати структуру сховища замість навчання.
 * 🧨 Червоніє, якщо повернути «Матеріали» початковою вкладкою або заховати перемикач за правом.
 */
test("#703 НАВЧАННЯ: початкова вкладка — «Курси», бібліотека друга й доступна всім", () => {
  const s = fe(SECTION);
  assert.match(s, /useState<"courses" \| "files">\("courses"\)/, "🔴 початкова вкладка не «Курси»");
  assert.ok(s.includes('([["courses", "Курси"], ["files", "Бібліотека"]] as const)'), "🔴 порядок або назви вкладок змінились");
  assert.ok(s.includes('<TrainingCourses onOpenLibrary={() => setView("files")} />'), "🔴 вкладка «Курси» не показує новий екран");
  // 🔴 Перемикач вкладок НЕ за `edit`: бібліотеку видно й тому, хто не редагує. Межа змістова — сам рядок
  // умови перед перемикачем, а не «N символів вище» (правило 9).
  assert.ok(!/\{edit && \(\s*\n\s*<div style=\{\{ display: "inline-flex"/.test(s), "🔴 перемикач вкладок знову сховано за правом редагування");
});

/**
 * #704 — РЕДАГУВАННЯ: лише за правом СЕРВЕРА (`canEdit`) і лише в окремому режимі, а не по кліку в тексті;
 * кожна дія йде НАЯВНИМИ роутами навчання (курс, папка, матеріал) — екран не відчиняє власних дверей.
 * 🧨 Червоніє, якщо кнопки редагування вивести з ролі, прибрати перемикач або піти в сервер повз ці виклики.
 */
test("#704 НАВЧАННЯ: редагування — за правом сервера, окремим режимом і наявними роутами", () => {
  const s = fe(COURSES);
  assert.match(s, /const \[canEdit, setCanEdit\] = useState\(false\)/, "🔴 право більше не питають у сервера");
  assert.match(s, /fetchTrainingCourses\(\)\.then\(\(d\) => \{ setRows\(d\.courses\); setCanEdit\(d\.canEdit\)/, "🔴 `canEdit` не з відповіді сервера");
  assert.ok(s.includes('<button className={edit ? "" : "on"} onClick={() => setEdit(false)}>Перегляд</button>')
    && s.includes('onClick={() => setEdit(true)}>Редагування</button>'), "🔴 немає перемикача «Перегляд / Редагування»");
  for (const need of ["canEdit && edit", "patchTrainingCourse(", "updateTrainingFolder(", "updateTrainingMaterial(", "deleteTrainingMaterial("])
    assert.ok(s.includes(need), `🔴 у редагуванні немає «${need}»`);
  // Жодного власного шляху в API повз наявні функції.
  assert.ok(!/api\.(get|post|patch|delete)\(/.test(s), "🔴 екран сам ходить у сервер — має кликати функції `api.ts`");
});

/**
 * #705 — СТАН КРОКУ Й ЗАМКИ — З СЕРВЕРА: екран малює `state`/`blockedBy` із відповіді, а не рахує сам
 * «наступний відкривається після попереднього». Друга копія правила розійшлася б із першою мовчки.
 * 🧨 Червоніє, якщо фронт почне сам вирішувати, що крок заблокований, або сховає причину замка.
 */
test("#705 НАВЧАННЯ: стан кроку й замки беруться з сервера, а не рахуються в екрані", () => {
  const s = fe(COURSES);
  assert.ok(s.includes('s.state === "locked"'), "🔴 стан кроку більше не читається з відповіді сервера");
  assert.ok(s.includes("s.blockedBy ? `Спершу «${s.blockedBy.title}»`"), "🔴 замок без причини: людина не бачить, що саме відкриє крок");
  assert.ok(s.includes('doneTrainingMaterial(step.id)') && s.includes("openTrainingMaterial(step.id)"),
    "🔴 прогрес пишеться не тими роутами, якими його читає решта екранів");
  // Немає власної арифметики блокування: індекси попередніх кроків фронт не порівнює.
  assert.ok(!/findIndex\([^)]*done[^)]*\)\s*[<>]/.test(s), "🔴 фронт сам вирішує, який крок заблокований");
});
