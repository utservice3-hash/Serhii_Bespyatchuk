import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeNoteComment } from "./receivableNoteMerge.js";

/**
 * #459 — ПОРОЖНІЙ КОМЕНТАР НЕ ЗАТИРАЄ ТЕКСТ: без `clear` порожнеча лишає старий текст,
 * текст замінює, `clear` стирає. Червоніє, якщо повернути `comment = EXCLUDED.comment`
 * (порожнє затре) або якщо `clear` перестане стирати (дзеркало).
 */
test("#459 mergeNoteComment: порожнє лишає текст, текст замінює, clear стирає", () => {
  assert.equal(mergeNoteComment("оплачено", "", false), "оплачено", "порожнє поверх тексту мусить лишити текст");
  assert.equal(mergeNoteComment("оплачено", null, false), "оплачено", "null поверх тексту мусить лишити текст");
  assert.equal(mergeNoteComment("оплачено", "  ", false), "оплачено", "пробіли — це порожнє");
  assert.equal(mergeNoteComment("оплачено", "частково", false), "частково", "текст замінює");
  assert.equal(mergeNoteComment("оплачено", "", true), null, "🪞 явне очищення стирає");
  assert.equal(mergeNoteComment("оплачено", "нове", true), "нове", "clear із текстом — текст");
  assert.equal(mergeNoteComment(null, "", false), null, "нічого поверх нічого — null, не порожній рядок");
  assert.equal(mergeNoteComment("", "", false), null);
});

/**
 * #459b — РОУТ `PUT /receivables/note` справді читає попередній коментар, кличе злиття і
 * приймає `clear`; старої форми `comment = EXCLUDED.comment` без злиття бути не має.
 * Читає джерело, межа слова. Червоніє, якщо прибрати SELECT попереднього, виклик злиття
 * або прапорець.
 */
test("#459b РОУТ нотатки: SELECT попереднього → mergeNoteComment → upsert; clear читається з тіла", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "dashboard.ts"), "utf8");
  const start = src.indexOf('dashboardRouter.put("/receivables/note"');
  assert.ok(start > 0, "роут не знайдено");
  const body = src.slice(start, src.indexOf("\n});", start));
  assert.match(body, /SELECT comment FROM receivable_notes WHERE client_key = \$1/, "попередній коментар не читається");
  assert.match(body, /\bmergeNoteComment\(/, "злиття не викликається");
  assert.match(body, /req\.body\?\.clear === true/, "прапорець clear не читається");
  const sel = body.indexOf("SELECT comment FROM receivable_notes"), ins = body.indexOf("INSERT INTO receivable_notes");
  assert.ok(sel > 0 && ins > sel, "SELECT попереднього мусить стояти ДО upsert");
});
