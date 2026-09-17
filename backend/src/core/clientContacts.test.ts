import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { lastContactOf, contactFileVerdict, canDeleteContact, CONTACT_CHANNEL_KEYS } from "./clientContacts.js";

/**
 * #460 — ОСТАННІЙ КОНТАКТ = свіжіше з розмови Ringostat і ручного запису, джерело названо.
 * Фікстури по обидва боки: розмова свіжіша → talk; ручний свіжіший → manual з каналом;
 * лише одне з двох → воно; нічого → null. Червоніє, якщо взяти лише розмову (ручний зникне)
 * або лише ручний, або загубити канал.
 */
test("#460 lastContactOf: свіжіше з двох джерел, джерело й канал названі", () => {
  assert.deepEqual(lastContactOf("2026-09-15T10:00:00Z", "2026-09-10T10:00:00Z", "viber"), { at: "2026-09-15T10:00:00Z", source: "talk", channel: null });
  assert.deepEqual(lastContactOf("2026-09-10T10:00:00Z", "2026-09-15T10:00:00Z", "viber"), { at: "2026-09-15T10:00:00Z", source: "manual", channel: "viber" });
  assert.deepEqual(lastContactOf(null, "2026-09-15T10:00:00Z", "telegram"), { at: "2026-09-15T10:00:00Z", source: "manual", channel: "telegram" });
  assert.deepEqual(lastContactOf("2026-09-15", null, null), { at: "2026-09-15", source: "talk", channel: null });
  assert.equal(lastContactOf(null, null, null), null);
  assert.equal(lastContactOf("не дата", null, null), null, "нерозбірна дата — не контакт");
});

/**
 * #460b — ФАЙЛ КОНТАКТУ: лише зображення, ≤ 5 МБ, не порожній; свій запис прибирається
 * протягом доби, керівництво — завжди. Дзеркала по обидва боки кожної межі.
 */
test("#460b contactFileVerdict і canDeleteContact: межі з обох боків", () => {
  assert.equal(contactFileVerdict("image/png", 1000).ok, true);
  assert.equal(contactFileVerdict("image/png", 5 * 1024 * 1024).ok, true, "рівно 5 МБ ще проходить");
  assert.equal(contactFileVerdict("image/png", 5 * 1024 * 1024 + 1).ok, false);
  assert.equal(contactFileVerdict("application/pdf", 1000).ok, false, "PDF — не зображення");
  assert.equal(contactFileVerdict(null, 1000).ok, false);
  assert.equal(contactFileVerdict("image/jpeg", 0).ok, false);
  const now = new Date("2026-09-17T12:00:00Z");
  assert.equal(canDeleteContact(false, 7, 7, "2026-09-17T00:00:00Z", now), true, "свій, 12 год — можна");
  assert.equal(canDeleteContact(false, 7, 7, "2026-09-15T12:00:00Z", now), false, "свій, 2 доби — ні");
  assert.equal(canDeleteContact(false, 8, 7, "2026-09-17T11:00:00Z", now), false, "чужий — ні");
  assert.equal(canDeleteContact(true, 8, 7, "2026-09-01T00:00:00Z", now), true, "🪞 керівництво — завжди");
  assert.deepEqual([...CONTACT_CHANNEL_KEYS], ["viber", "telegram", "email", "call", "other"]);
});

/**
 * #460c — РОУТИ Й РЯДКИ: файл контакту віддається лише після `canSeeClient`; запис і видалення
 * теж за ним; рядок плану несе `lastContact` через `lastContactOf`; матриця знає всі три роути;
 * схема має CHECK на канал із тим самим переліком. Читає джерело, межа слова.
 */
test("#460c РОУТИ контактів за canSeeClient, рядок плану несе lastContact, матриця й схема узгоджені", () => {
  const src = path.join(import.meta.dirname, "..", "..", "src");
  const d = readFileSync(path.join(src, "routes", "dashboard.ts"), "utf8");
  for (const route of ['dashboardRouter.get("/client-contacts/:id/file"', 'dashboardRouter.post("/client-contacts"', 'dashboardRouter.delete("/client-contacts/:id"', 'dashboardRouter.get("/client-contacts"']) {
    const i = d.indexOf(route); assert.ok(i > 0, `${route} не знайдено`);
    const body = d.slice(i, d.indexOf("\n});", i));
    assert.match(body, /\bcanSeeClient\(/, `${route}: немає перевірки скоупу клієнта`);
  }
  assert.match(d, /lastContact: lastContactOf\(/, "рядок плану не рахує lastContact спільною функцією");
  assert.match(d, /CONTACT_FILES_DIR = path\.join\(UPLOAD_DIR, "\.\.", "contact-files"\)/, "тека файлів мусить бути ПОЗА публічним uploads/");
  const m = readFileSync(path.join(src, "auth", "accessMatrix.ts"), "utf8");
  assert.match(m, /"\/api\/dashboard\/client-contacts\?clientKey=zzz"/);
  assert.match(m, /method: "POST", path: "\/api\/dashboard\/client-contacts"/);
  assert.match(m, /method: "DELETE", path: "\/api\/dashboard\/client-contacts\/0"/);
  const schema = readFileSync(path.join(src, "db", "schema.sql"), "utf8");
  const chk = schema.match(/client_contacts[\s\S]*?channel TEXT NOT NULL CHECK \(channel IN \(([^)]*)\)\)/);
  assert.ok(chk, "CHECK на канал не знайдено");
  assert.deepEqual([...chk![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]), [...CONTACT_CHANNEL_KEYS], "словник каналів у коді й у схемі розійшлися");
});
