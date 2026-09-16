import { test } from "node:test";
import assert from "node:assert/strict";
import { lifecycleAction } from "./docLifecycle.js";
import { canSignDocument, canEditDocument, type DocLike, type AccessContext } from "./docAccess.js";
import { needsBackendEnv } from "../testMode.js";

const live = { archivedAt: null, archivedReason: null };
const byDismissal = { archivedAt: "2026-09-10T00:00:00Z", archivedReason: "dismissed" };
const byHand = { archivedAt: "2026-09-10T00:00:00Z", archivedReason: "manual" };

/**
 * #444 — ЖИТТЄВИЙ ЦИКЛ ЗА СТАНОМ ЛЮДИНИ, по обидва боки кожної межі.
 * Червоніє, якщо прибрати фільтр розділу (загальний документ піде в архів разом із людиною),
 * якщо повернення скасує РУЧНИЙ архів, або якщо «завершує» почне архівувати.
 */
test("#444 ЖИТТЄВИЙ ЦИКЛ: звільнений → особисті/офери в архів; повернувся → назад лише те, що архівувало звільнення; загальні не рушать ніколи", () => {
  for (const section of ["personal", "offer"] as const) {
    assert.equal(lifecycleAction("dismissed", { section, ...live }), "archive", `${section} звільненого лишився живим`);
    assert.equal(lifecycleAction("dismissed", { section, ...byDismissal }), "none", "архівоване архівують удруге");
    assert.equal(lifecycleAction("active", { section, ...byDismissal }), "return", `${section} не повернувся після повернення людини`);
    assert.equal(lifecycleAction("finishing", { section, ...byDismissal }), "return", "«завершує» — людина працює, її документи мають бути з нею");
    assert.equal(lifecycleAction("active", { section, ...byHand }), "none", "повернення скасувало РУЧНИЙ архів — його робила людина свідомо");
    assert.equal(lifecycleAction("active", { section, ...live }), "none");
    assert.equal(lifecycleAction("finishing", { section, ...live }), "none", "«завершує» архівує — а людина ще працює");
  }
  for (const state of ["active", "finishing", "dismissed"] as const) {
    assert.equal(lifecycleAction(state, { section: "general", ...live }), "none", `загальний документ рушив при стані ${state}`);
    assert.equal(lifecycleAction(state, { section: "general", ...byDismissal }), "none");
  }
});

/** #444b 🪞 НЕАКТИВНИЙ ДОКУМЕНТ: не підписується й не редагується, поки керівництво не активує; активований — як звичайний. */
test("#444b НЕАКТИВНИЙ: повернутий з архіву документ не підписати й не редагувати, поки не активовано", () => {
  const ctx: AccessContext = { folderRights: new Map(), grants: [], now: new Date("2026-09-16T09:00:00Z") };
  const base: DocLike = { id: 1, folderId: null, section: "offer", addresseeUserId: 77, createdBy: 1, archivedAt: null, inactiveAt: "2026-09-16T08:00:00Z" };
  assert.equal(canSignDocument({ userId: 77, roleKey: "manager" }, base), false, "адресат підписав неактивний офер");
  assert.equal(canEditDocument({ userId: 1, roleKey: "admin" }, base, ctx), false, "адмін редагує неактивний документ — спершу «Активувати»");
  const activated = { ...base, inactiveAt: null };
  assert.equal(canSignDocument({ userId: 77, roleKey: "manager" }, activated), true, "активований офер не підписується");
  assert.equal(canEditDocument({ userId: 1, roleKey: "admin" }, activated, ctx), true);
  assert.equal(canSignDocument({ userId: 78, roleKey: "manager" }, activated), false, "чужий підписав");
});

/** #444c ЖИВА БД: після джоби в жодного звільненого немає живого особистого/офера (інваріант, один запит). */
test("#444c ЖИВА БД: у звільнених немає живих особистих документів і оферів", needsBackendEnv(), async () => {
  const { pool } = await import("../db/pool.js");
  const { stateOf } = await import("./managerState.js");
  const r = await pool.query<{ user_id: number; is_active: boolean; override: string | null; n: number }>(
    `SELECT u.id AS user_id, u.is_active, mws.state AS override, count(f.id)::int AS n
       FROM users u LEFT JOIN manager_work_state mws ON mws.manager_id = u.manager_id
       JOIN doc_files f ON f.addressee_user_id = u.id AND f.section IN ('personal','offer') AND f.archived_at IS NULL
      GROUP BY u.id, u.is_active, mws.state`);
  const leaks = r.rows.filter((x) => stateOf({ crmActive: x.is_active, override: x.override as "finishing" | "dismissed" | null }) === "dismissed").map((x) => `user ${x.user_id}: ${x.n} живих`);
  assert.deepEqual(leaks, [], "🔴 у звільнених лишились живі особисті документи/офери — джоба docLifecycle не відпрацювала");
});
