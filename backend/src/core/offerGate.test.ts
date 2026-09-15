import { test } from "node:test";
import assert from "node:assert/strict";
import { offerPending, offerGateBlocks, OFFER_GATE_SINCE, OFFER_GATE_TABS } from "./offerGate.js";

const after = "2026-10-01T09:00:00+03:00";
const before = "2026-09-01T09:00:00+03:00";

/**
 * #441b — НОВИЙ МЕНЕДЖЕР БЕЗ ПІДПИСАНОГО ОФЕРА: закрито все, крім Навчання й Документів.
 * Фікстура по обидва боки кожної межі: дата створення, роль, підпис.
 * Червоніє, якщо прибрати перевірку дати (поточний менеджер без офера закриється — а рішення ③
 * каже, що для поточних правило не діє), прибрати перевірку ролі (тімлід закриється) або
 * відкрити зайву вкладку.
 */
test("#441b ОФЕР-ГЕЙТ: новий менеджер без підпису — лише training/documents; підписав, або створений до дати, або не менеджер → відкрито", () => {
  const fresh = { roleKey: "manager", createdAt: after, hasSignedOffer: false };
  assert.equal(offerPending(fresh), true, "новий менеджер без підпису не обмежений");
  assert.equal(offerGateBlocks(true, ["report"]), true, "Звіт відкритий до підпису");
  assert.equal(offerGateBlocks(true, ["news"]), true, "Новини відкриті до підпису");
  assert.equal(offerGateBlocks(true, ["documents"]), false, "Документи закриті — підписати нема де");
  assert.equal(offerGateBlocks(true, ["training"]), false, "Навчання закрите");
  assert.equal(offerGateBlocks(true, ["kvp", "documents"]), false, "роут на двох вкладках закрився, хоча одна дозволена");
  assert.equal(offerGateBlocks(true, null), false, "роут поза мапою вкладок закрився");
  assert.deepEqual([...OFFER_GATE_TABS].sort(), ["documents", "training"], "перелік відкритих вкладок змінився — це рішення власника");

  // 🪞 дзеркала
  assert.equal(offerPending({ ...fresh, hasSignedOffer: true }), false, "підписав — а доступ досі закритий");
  assert.equal(offerPending({ ...fresh, createdAt: before }), false, "поточний менеджер (до дати) без офера закритий — рішення ③ порушено");
  assert.equal(offerPending({ ...fresh, roleKey: "team_lead" }), false, "тімлід потрапив під правило для менеджерів");
  assert.equal(offerPending({ ...fresh, roleKey: "candidate" }), false, "кандидат потрапив під правило — у нього свій екран");
  assert.equal(offerGateBlocks(false, ["report"]), false, "без очікування офера гейт щось закрив");
  // межа дати — включно з самою миттю викату
  assert.equal(offerPending({ ...fresh, createdAt: OFFER_GATE_SINCE.toISOString() }), true, "створений у мить викату не вважається новим");
});
