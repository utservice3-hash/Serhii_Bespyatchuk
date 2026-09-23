import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 📅 ПЕРЕНЕСТИ / ВИДАЛИТИ РЯДОК ГРАФІКА У ВИГЛЯДІ «РОЗКЛАД» (23.09.2026, Іван: «випадково поставив співбесіди
 * на сьогодні — як перенести на завтра або видалити, щоб не тягнулось у звітність») — гейт `#690`.
 * Номер із запасом над `#649` — борг 17: перед мержем перемірити перетин.
 */
const FE = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/HiringSchedule.tsx", import.meta.url));

/**
 * #690 — ДІЇ Є І ЙДУТЬ ЧЕРЕЗ ТОЙ САМИЙ ЗАПИС РЯДКА: «Розклад» передає в картку `onMove` і `onRemove`;
 * перенесення — це `save` рядка з `interviewDate`/`interviewTime` (той самий шлях, що й решта полів, тож
 * щоденний звіт рахує день по новій даті), видалення — скасовне `deleteHiringInterview` з «Відновити».
 * 🧨 Червоніє, якщо прибрати дії з картки, слати перенесення окремим запитом або зробити видалення без відновлення.
 */
test("#690 РОЗКЛАД: рядок можна перенести й видалити; перенесення — той самий запис, видалення — скасовне", () => {
  const src = readFileSync(FE, "utf8");
  for (const need of ["onMove={", "onRemove={", "Перенести на іншу дату…", "Видалити з графіка"])
    assert.ok(src.includes(need), `🔴 у «Розкладі» немає «${need}»`);
  // Межа ЗМІСТОВА: тіло `move` — від його оголошення до наступного `const`, а не «N рядків» (правило 9).
  const move = src.slice(src.indexOf("const move = async"), src.indexOf("const remove = async"));
  assert.ok(move.includes("save(r, { interviewDate: date, interviewTime: time })"),
    "🔴 перенесення не йде тим самим записом рядка (`save` з датою й часом)");
  assert.ok(!/patchHiringInterview\(/.test(move), "🔴 перенесення шле власний запит повз `save`");
  const remove = src.slice(src.indexOf("const remove = async"), src.indexOf("const badge ="));
  assert.ok(remove.includes("deleteHiringInterview(") && remove.includes("restoreHiringInterview("),
    "🔴 видалення не скасовне: немає «Відновити»");
  assert.ok(src.includes("Дата призначення не змінюється"), "🔴 діалог не каже, що «призначено» лишається тим самим днем");
});

/**
 * #691 — ПОМИЛКОВА ДІЯ СКАСОВНА: у «Розкладі» є «⟲ Скасувати позначку» (знімає явку) і в меню — «Змінити рядок…»
 * та «↩ Повернути останню зміну статусу». Який статус повертати, питає СЕРВЕР (`lastFrom` картки), а не вгадує
 * з поточного: інакше «прийшов» після «недозвону» повертав би не туди.
 * 🧨 Червоніє, якщо прибрати скасування явки, редагування рядка або почати вгадувати попередній статус у фронті.
 */
test("#691 РОЗКЛАД: позначку явки можна зняти, рядок змінити, статус повернути — попередній статус бере сервер", () => {
  const src = readFileSync(FE, "utf8");
  for (const need of ["⟲ Скасувати позначку", "Змінити рядок…", "↩ Повернути останню зміну статусу", "onClearMark", "onUndoStatus"])
    assert.ok(src.includes(need), `🔴 у «Розкладі» немає «${need}»`);
  const clear = src.slice(src.indexOf("const clearMark = async"), src.indexOf("const undoStatus = async"));
  assert.ok(clear.includes("save(r, { attended: null })"), "🔴 позначка знімається не тим самим записом рядка");
  assert.ok(clear.includes("fetchHiringCard(") && clear.includes("card.lastFrom"), "🔴 попередній статус не питають у сервера");
  const undo = src.slice(src.indexOf("const undoStatus = async"), src.indexOf("const remove = async"));
  assert.ok(undo.includes("card.lastFrom") && undo.includes("setHiringStatus("), "🔴 повернення статусу не йде через картку й статусний роут");
  assert.ok(!/attended === true \? "planned"|status === "done" \? "planned"/.test(src), "🔴 фронт вгадує попередній статус сам");
});
