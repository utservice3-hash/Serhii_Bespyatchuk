import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySignCode, linkTokenState, notifyDue, generateSignCode, generateLinkToken, signCodeMessage, MAX_ATTEMPTS, type CodeRecord } from "./signCode.js";

const now = new Date("2026-09-22T09:00:00Z");
const rec = (over: Partial<CodeRecord> = {}): CodeRecord => ({ code: "123456", fileId: 7, sha256: "abc", version: 2, attempts: 0, expiresAt: new Date(now.getTime() + 60_000), usedAt: null, ...over });
const exp = { fileId: 7, sha256: "abc", version: 2 };

/**
 * #442 — КОД ПІДПИСУ ПРИВʼЯЗАНИЙ ДО ВЕРСІЇ, ОДНОРАЗОВИЙ, 5 ХВ, 3 СПРОБИ.
 * Червоніє, якщо прибрати звірку sha/версії (код на v1 підпише v2), не гасити код після
 * використання, ігнорувати строк або спроби.
 */
test("#442 TG-ПІДПИС: код чинний лише для того файла/хеша/версії, на які надісланий; одноразовий; 5 хв; 3 спроби", () => {
  assert.deepEqual(verifySignCode(rec(), "123456", exp, now), { ok: true });
  assert.equal(verifySignCode(rec(), "123456", { ...exp, sha256: "def" }, now).ok, false, "код на стару версію підписав нову");
  assert.equal((verifySignCode(rec(), "123456", { ...exp, sha256: "def" }, now) as { reason: string }).reason, "wrong_version");
  assert.equal((verifySignCode(rec(), "123456", { ...exp, fileId: 8 }, now) as { reason: string }).reason, "wrong_version", "код на інший файл прийнято");
  assert.equal((verifySignCode(rec({ usedAt: now }), "123456", exp, now) as { reason: string }).reason, "used", "використаний код спрацював удруге");
  assert.equal((verifySignCode(rec({ expiresAt: now }), "123456", exp, now) as { reason: string }).reason, "expired", "прострочений код прийнято");
  assert.equal((verifySignCode(rec({ attempts: MAX_ATTEMPTS }), "123456", exp, now) as { reason: string }).reason, "attempts", "після 3 спроб код досі живий");
  const wrong = verifySignCode(rec({ attempts: 1 }), "000000", exp, now);
  assert.equal(wrong.ok, false); assert.equal((wrong as { reason: string }).reason, "mismatch");
  assert.equal((wrong as { attemptsLeft: number }).attemptsLeft, 1, "лічильник спроб не зменшується");
  assert.deepEqual(verifySignCode(rec(), " 123456 ", exp, now), { ok: true }, "пробіли навколо коду мають прощатись");
  assert.match(generateSignCode(() => 0.000001), /^\d{6}$/, "код не 6 цифр");
  assert.equal(generateSignCode(() => 0.999999).length, 6);
  const msg = signCodeMessage("111222", "Офер — Іван", 3);
  assert.ok(msg.includes("Офер — Іван") && msg.includes("версія 3"), "повідомлення без назви/версії — людина не знає, що підписує");
});

/** #442b — ТОКЕН ПРИВʼЯЗКИ: одноразовий і зі строком; deep-link ≤ 64 символів URL-безпечних. */
test("#442b TG-ПРИВʼЯЗКА: токен /start одноразовий, 10 хв, придатний для deep-link", () => {
  assert.equal(linkTokenState({ expiresAt: new Date(now.getTime() + 1000), usedAt: null }, now), "ok");
  assert.equal(linkTokenState({ expiresAt: new Date(now.getTime() + 1000), usedAt: now }, now), "used", "використаний токен привʼязав би другу людину");
  assert.equal(linkTokenState({ expiresAt: now, usedAt: null }, now), "expired");
  const t = generateLinkToken(new Uint8Array(36).fill(255));
  assert.ok(t.length > 20 && t.length <= 64 && /^[A-Za-z0-9_-]+$/.test(t), `токен непридатний для start=: ${t}`);
});

/** #442d — ПОВІДОМЛЕННЯ ПРО ОФЕР РІВНО ОДИН РАЗ: непідписаний неархівований офер без позначки → так; з позначкою → ні (повторний прогін мовчить); підписаний/архівний → ні. */
test("#442d TG-ПОВІДОМЛЕННЯ: про офер пишемо рівно один раз — повторний прогін мовчить, підписаний і архівний не отримують", () => {
  const base = { section: "offer", archivedAt: null, signedCurrent: false, remindedAt: null };
  assert.equal(notifyDue(base), true);
  assert.equal(notifyDue({ ...base, remindedAt: now }), false, "написали вдруге — власник просив одне повідомлення");
  assert.equal(notifyDue({ ...base, remindedAt: new Date(now.getTime() - 30 * 864e5) }), false, "через місяць написали знову — це вже нагадування");
  assert.equal(notifyDue({ ...base, signedCurrent: true }), false, "написали про підписаний офер");
  assert.equal(notifyDue({ ...base, archivedAt: now }), false, "написали звільненому про архівний офер");
  assert.equal(notifyDue({ ...base, section: "personal" }), false, "написали про не-офер");
});
