import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isInsufficientPrivilege } from "./pgErrors.js";

/**
 * #409 — ЧИТАННЯ НЕ ГИНЕ ВІД ПОБІЧНОГО ЗАПИСУ ЗНІМКІВ ПІД READ-ONLY РОЛЛЮ.
 *
 * Дві половини, і обидві потрібні: розпізнавач має ЗНАТИ 42501 і НЕ ЗНАТИ решту
 * (інакше він ковдра), а `weekPlansForMonth` має справді ним користуватись — інакше
 * хелпер існує, а читання все одно падає (правило 8: «а де воно ТЕПЕР»).
 *
 * 🧨 Червоніє, якщо: розширити розпізнавач на будь-який код; прибрати try/catch
 * навколо `freezeWeekPlans`; ковтати помилку без перевірки коду.
 */
test("#409 ЗНІМКИ ТИЖНЕВИХ ПЛАНІВ: 42501 не валить читання, інші помилки — валять", () => {
  assert.equal(isInsufficientPrivilege({ code: "42501" }), true, "🔴 недостатньо прав не розпізнано");
  assert.equal(isInsufficientPrivilege({ code: "23505" }), false, "🔴 унікальність (23505) проковтнуто — ковдра");
  assert.equal(isInsufficientPrivilege(new Error("permission denied")), false, "🔴 текст без коду не є 42501");
  assert.equal(isInsufficientPrivilege(null), false);

  // Читаємо ЗІБРАНИЙ модуль: саме він поїде на сервер, і саме в ньому мусить стояти сторожа.
  const src = readFileSync(path.join(import.meta.dirname, "..", "core", "weekPlan.js"), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");
  assert.match(src, /try \{ await freezeWeekPlans\(monthStart, toInsert, "live"\); \} catch \(e\) \{ if \(!isInsufficientPrivilege\(e\)\) throw e;/,
    "🔴 заморозка знімків знову без сторожі — GET впаде 500-ю під read-only роллю на першому ж новому періоді");
});
