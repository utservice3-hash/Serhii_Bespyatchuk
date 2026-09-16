import { test } from "node:test";
import assert from "node:assert/strict";
import { ackRequired, ackMine, ackProgress, remindTargets } from "./docAck.js";

const reg = { section: "general", category: "Регламент", archivedAt: null, version: 2, sha256: "v2" };

/**
 * #445 — ОЗНАЙОМЛЕННЯ: лише загальні регламенти; позначка привʼязана до версії; прогрес — по аудиторії.
 * Червоніє, якщо вимагати ознайомлення з усім підряд, зарахувати стару версію або порахувати
 * «прочитали» по всіх, хто натиснув, а не по тих, хто мусив.
 */
test("#445 ОЗНАЙОМЛЕННЯ: потрібне лише загальним регламентам; нова версія — читати знову; прогрес по аудиторії", () => {
  assert.equal(ackRequired(reg), true);
  assert.equal(ackRequired({ ...reg, category: "Інструкція" }), false, "інструкція вимагає ознайомлення — ТЗ каже лише регламенти");
  assert.equal(ackRequired({ ...reg, section: "personal" }), false, "особистий регламент? такого не буває — ознайомлення лише для загальних");
  assert.equal(ackRequired({ ...reg, archivedAt: "2026-09-01" }), false, "архівний регламент вимагає читання");
  const acks = [{ userId: 7, version: 1, sha256: "v1" }, { userId: 8, version: 2, sha256: "v2" }, { userId: 99, version: 2, sha256: "v2" }];
  assert.equal(ackMine(reg, acks, 8), "acked");
  assert.equal(ackMine(reg, acks, 7), "pending", "позначка зі старої версії зарахована — а файл замінили");
  assert.equal(ackMine(reg, acks, 5), "pending");
  assert.equal(ackMine({ ...reg, category: "Шаблон" }, acks, 5), "not_required");
  const p = ackProgress(reg, [7, 8, 9], acks);
  assert.deepEqual(p, { total: 3, done: 1, missing: [7, 9] }, "прогрес порахував не по аудиторії (99 — сторонній) або зарахував стару версію (7)");
});

/** #445b НАГАДУВАННЯ: лише тим, хто не прочитав і має Telegram; решта названі поіменно, а не загублені. */
test("#445b НАГАДУВАННЯ про регламент: тільки непрочитавшим із Telegram; без Telegram — окремим списком", () => {
  const chats = new Map<number, string | null>([[7, "111"], [9, null]]);
  const r = remindTargets([7, 9, 10], chats);
  assert.deepEqual(r.send, [{ userId: 7, chatId: "111" }], "нагадали комусь без чату або не тому");
  assert.deepEqual(r.noTelegram, [9, 10], "ті, кому нема куди писати, загубились");
  assert.deepEqual(remindTargets([], chats), { send: [], noTelegram: [] });
});
