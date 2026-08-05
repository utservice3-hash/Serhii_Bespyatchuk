import { test } from "node:test";
import assert from "node:assert/strict";
import { orphanReason, orphanManagerSql, SERVICE_KOMMO_USER_IDS, ORPHAN_DEFAULT_MONTHS } from "./orphanClients.js";

/**
 * 🔴 Ці тести існують через КОНКРЕТНУ помилку 05.08.2026: перший критерій
 * «службовий = немає пошти @uts.ua» затягнув у службові звільнену людину
 * (Мельник Лілія, пошта в картці просто не заповнена). Тому головне, що вони
 * стережуть, — це РОЗДІЛЬНІСТЬ двох ознак, а не сам факт «щось повертається».
 */

test("#30 НІЧИЙНИЙ: службовий і звільнений — РІЗНІ причини, не змішані", () => {
  assert.equal(orphanReason({ kommoUserId: "904923", isActive: true }), "service");
  assert.equal(orphanReason({ kommoUserId: 904923, isActive: true }), "service",
    "🔴 число і рядок мають давати те саме — kommo_user_id приходить і так, і так");
  assert.equal(orphanReason({ kommoUserId: "111", isActive: false }), "inactive");
  // Службовий ВАЖЛИВІШИЙ: якщо адмінський акаунт колись деактивують, клієнти
  // мають лишитись «службовими» — їх треба роздати, а не «перепризначити».
  assert.equal(orphanReason({ kommoUserId: "904923", isActive: false }), "service");
});

test("#30b ДЗЕРКАЛО: звичайний активний менеджер НЕ нічийний", () => {
  // Без цього #30 зеленів би й тоді, коли в пул поїхала б уся компанія.
  assert.equal(orphanReason({ kommoUserId: "7181916", isActive: true }), null);
  assert.equal(orphanReason({ kommoUserId: null, isActive: true }), null);
});

test("#30c ПОШТА НЕ Є КРИТЕРІЄМ (саме через неї Мельник впала у службові)", () => {
  assert.equal(orphanReason({ kommoUserId: "5", isActive: true }), null,
    "🔴 повернулась евристика по пошті/порожньому полю");
  assert.equal(orphanReason({ kommoUserId: "5", isActive: false }), "inactive");
});

test("#30d SQL-ПРЕДИКАТ і TS-функція говорять про ТЕ САМЕ", () => {
  const sql = orphanManagerSql("mm");
  for (const id of SERVICE_KOMMO_USER_IDS) assert.ok(sql.includes(`'${id}'`), `у SQL немає ${id}`);
  assert.ok(sql.includes("NOT mm.is_active"), "у SQL немає ознаки деактивації");
  assert.ok(sql.includes("mm.kommo_user_id"), "алиас не підставився");
  assert.ok(SERVICE_KOMMO_USER_IDS.length > 0, "🔴 список службових порожній");
  assert.equal(ORPHAN_DEFAULT_MONTHS, 18);
});
