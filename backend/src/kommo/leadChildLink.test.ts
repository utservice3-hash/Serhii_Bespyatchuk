import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeadChildLink } from "./leadChildLink.js";

/**
 * #1094 — ПРИМІТКА KOMMO `lead_auto_created` → ПАРА «батьківська → дочірня» (30.09.2026).
 * Живі форми з угоди Сердюка 62338837 → 62668945: примітка в батьківській («child») і в дочірній
 * («parent») дають ОДНУ пару; усе інше — `null`, а не здогад (помилкова пара віддала б гроші не тому).
 * 🧨 САБОТАЖ: у гілці `"parent"` поміняти місцями `parentId`/`childId` → червоніє.
 */
test("#1094 ПРИМІТКА KOMMO: «child» і «parent» дають одну пару; чуже й биті id — null", () => {
  const inParent = { note_type: "lead_auto_created", entity_id: 62338837, created_at: 1788944926,
    params: { type: "child", link: { id: 62668945, type: 2 }, lead_type: "child", lead_id: 62668945 } };
  const inChild = { note_type: "lead_auto_created", entity_id: 62668945, created_at: 1788944926,
    params: { type: "parent", link: { id: 62338837, type: 2 }, lead_type: "parent", lead_id: 62338837 } };
  const want = { parentId: 62338837, childId: 62668945, createdAt: 1788944926 };
  assert.deepEqual(parseLeadChildLink(inParent), want, "🔴 примітка в батьківській угоді розібрана не так");
  assert.deepEqual(parseLeadChildLink(inChild), want, "🔴 примітка в дочірній угоді дала іншу пару");
  assert.equal(parseLeadChildLink({ ...inParent, note_type: "common" }), null, "🔴 чужий тип примітки дав пару");
  assert.equal(parseLeadChildLink({ ...inParent, params: { lead_type: "sibling", lead_id: 1 } }), null, "🔴 невідомий тип дав пару");
  assert.equal(parseLeadChildLink({ ...inParent, params: { lead_type: "child", lead_id: "abc" } }), null);
  assert.equal(parseLeadChildLink({ ...inParent, params: { lead_type: "child", lead_id: 62338837 } }), null, "🔴 угода — сама собі дочірня");
  assert.equal(parseLeadChildLink({ ...inParent, params: null }), null);
});
