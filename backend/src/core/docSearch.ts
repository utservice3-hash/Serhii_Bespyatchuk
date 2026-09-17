/**
 * 🔎 ПОШУК ПО ТЕКСТУ ДОКУМЕНТІВ — чиста функція над ВЖЕ ВИДИМИМИ документами.
 *
 * 🔴 Видимість вирішує роут (`canSeeDocument`) ДО виклику: сюди не мусить потрапити текст документа,
 * якого людина не бачить, інакше уривок у відповіді розкриє чужий офер (гейт #510b).
 *
 * Правила збігу:
 *  - усі слова запиту мають бути в тексті (І, не АБО), регістр не важить;
 *  - латинські двійники кириличних літер (a c e i o p x y k) і різні апострофи зводяться до одного:
 *    «Комiсiя» з латинською i у файлі знаходиться за «комісія» (так пише Приват, заміряно 26.08.2026);
 *  - текст СТАРОЇ версії не шукається: після нової версії документ «ще обробляється», а не хибний збіг.
 *
 * Разом зі збігами — два числа: скільки видимих документів НЕ шукались (скан, фото, збій) і скільки
 * ще обробляються. Порожній результат без них читався б як «такого тексту ніде немає».
 */
import type { TextStatus } from "./docText.js";

export interface SearchDoc { id: number; version: number; contentVersion: number | null; status: TextStatus | null; text: string | null }
export interface SearchHit { id: number; snippet: string; count: number }
export interface SearchResult { hits: SearchHit[]; searched: number; notSearchable: number; pending: number }

const HOMO: Record<string, string> = { a: "а", c: "с", e: "е", i: "і", o: "о", p: "р", x: "х", y: "у", k: "к", "’": "'", "ʼ": "'", "`": "'", "‘": "'" };

/** Згортає текст ПОСИМВОЛЬНО (довжина не змінюється), щоб позиції збігу лягали на оригінал для уривка. */
export function foldText(s: string): string {
  let out = "";
  for (const ch of s) {
    const lc = ch.toLocaleLowerCase("uk");
    const one = lc.length === ch.length ? lc : ch;
    out += /\s/.test(one) ? " ".repeat(one.length) : (HOMO[one] ?? one);
  }
  return out;
}

export function queryTerms(q: string): string[] {
  return [...new Set(foldText(q.slice(0, 200)).split(" ").map((t) => t.trim()).filter((t) => t.length >= 2))];
}

export function makeSnippet(text: string, pos: number, len: number, before = 60, after = 110): string {
  let start = Math.max(0, pos - before); let end = Math.min(text.length, pos + len + after);
  if (start > 0) { const sp = text.indexOf(" ", start); if (sp >= 0 && sp < pos) start = sp + 1; }
  if (end < text.length) { const sp = text.lastIndexOf(" ", end); if (sp > pos + len) end = sp; }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

export function searchDocs(docs: readonly SearchDoc[], q: string, maxHits = 200): SearchResult {
  const terms = queryTerms(q);
  let searched = 0, notSearchable = 0, pending = 0;
  const hits: SearchHit[] = [];
  for (const d of docs) {
    if (d.status == null || d.contentVersion !== d.version) { pending++; continue; }
    if (d.status !== "ok" || !d.text) { notSearchable++; continue; }
    searched++;
    if (!terms.length) continue;
    const folded = foldText(d.text);
    if (!terms.every((t) => folded.includes(t))) continue;
    const first = terms[0];
    const pos = folded.indexOf(first);
    let count = 0; for (let i = pos; i >= 0 && count < 999; i = folded.indexOf(first, i + first.length)) count++;
    hits.push({ id: d.id, snippet: makeSnippet(d.text, pos, first.length), count });
  }
  hits.sort((a, b) => b.count - a.count || a.id - b.id);
  return { hits: hits.slice(0, maxHits), searched, notSearchable, pending };
}
