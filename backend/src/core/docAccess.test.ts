import { test } from "node:test";
import assert from "node:assert/strict";
import { canSeeDocument, canSeeOffersSection, canEditDocument, canSignDocument, signatureState, MANAGEMENT_ROLES, type DocLike, type AccessContext } from "./docAccess.js";

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({ folderRights: new Map(), grants: [], now: new Date("2026-09-15T12:00:00Z"), ...over });
const doc = (over: Partial<DocLike> = {}): DocLike => ({ id: 1, folderId: 10, section: "general", addresseeUserId: null, createdBy: 5, archivedAt: null, ...over });

/**
 * #430 — ГОЛОВНИЙ ГЕЙТ ПРОХОДУ: доступ до документів НЕ виводиться з обсягу ролі.
 * Опдир має `data_scope='company'` і бачить усіх клієнтів — але чужий особистий документ
 * і чужий офер бачить ЛИШЕ тому, що він у `MANAGEMENT_ROLES`, а КВП (теж company-scope)
 * — не бачить. Червоніє, якщо зробити предикат похідним від обсягу ролі (КВП побачить
 * офер) або вписати КВП у керівництво.
 */
test("#430 ДОКУМЕНТИ: чужий офер/особистий недосяжний за обсягом ролі — КВП (company) не бачить, опдир бачить як керівництво", () => {
  const offer = doc({ section: "offer", addresseeUserId: 77 });
  const personal = doc({ section: "personal", addresseeUserId: 77, createdBy: 3 });
  assert.equal(canSeeDocument({ userId: 1, roleKey: "kvp" }, offer, ctx()), false, "КВП з company-scope побачив чужий офер");
  assert.equal(canSeeDocument({ userId: 1, roleKey: "kvp" }, personal, ctx()), false, "КВП побачив чужий особистий");
  assert.equal(canSeeDocument({ userId: 1, roleKey: "opdir" }, offer, ctx()), true, "опдир (керівництво) не бачить офер");
  assert.equal(canSeeDocument({ userId: 1, roleKey: "team_lead" }, offer, ctx()), false, "тімлід побачив чужий офер");
  assert.equal(canSeeDocument({ userId: 1, roleKey: "manager" }, offer, ctx()), false, "менеджер побачив чужий офер");
  assert.deepEqual([...MANAGEMENT_ROLES].sort(), ["admin", "ceo", "opdir"], "склад керівництва змінився — це рішення власника");
});

/** #430b 🪞 ДЗЕРКАЛО: адресат бачить свій офер і свій особистий; автор бачить особистий, який виклав. */
test("#430b 🪞 ДОКУМЕНТИ: адресат бачить свій офер і особистий, автор — особистий, що виклав", () => {
  const offer = doc({ section: "offer", addresseeUserId: 77 });
  const personal = doc({ section: "personal", addresseeUserId: 77, createdBy: 3 });
  assert.equal(canSeeDocument({ userId: 77, roleKey: "manager" }, offer, ctx()), true);
  assert.equal(canSeeDocument({ userId: 77, roleKey: "manager" }, personal, ctx()), true);
  assert.equal(canSeeDocument({ userId: 3, roleKey: "team_lead" }, personal, ctx()), true, "автор не бачить особистий, який сам виклав");
  assert.equal(canSeeDocument({ userId: 3, roleKey: "team_lead" }, offer, ctx()), false, "автор-тімлід не має бачити офер (його виклало керівництво)");
  assert.equal(canSignDocument({ userId: 77, roleKey: "manager" }, offer), true);
  assert.equal(canSignDocument({ userId: 3, roleKey: "team_lead" }, offer), false);
});

/** #430c ЗАГАЛЬНІ — усім ролям (двобічно): без рядка прав бачать усі; явний рядок can_view=false закриває; виняток відкриває назад. */
test("#430c ДОКУМЕНТИ: загальні видно всім ролям; явне право папки закриває; персональний виняток зі строком", () => {
  const g = doc({ section: "general", folderId: 10 });
  for (const r of ["manager", "team_lead", "hr", "kvp", "financier"]) assert.equal(canSeeDocument({ userId: 9, roleKey: r }, g, ctx()), true, `${r} не бачить загальний`);
  const closed = ctx({ folderRights: new Map([[10, { canView: false, canUpload: false, canEdit: false, canPublish: false }]]) });
  assert.equal(canSeeDocument({ userId: 9, roleKey: "manager" }, g, closed), false, "явне can_view=false не закрило папку");
  assert.equal(canSeeDocument({ userId: 9, roleKey: "admin" }, g, closed), true, "керівництво закрилось власною матрицею");
  const grantLive = ctx({ folderRights: closed.folderRights, grants: [{ folderId: 10, fileId: null, userId: 9, canView: true, canUpload: false, expiresAt: "2026-12-31T00:00:00Z" }] });
  assert.equal(canSeeDocument({ userId: 9, roleKey: "manager" }, g, grantLive), true, "живий виняток не відкрив папку");
  const grantDead = ctx({ folderRights: closed.folderRights, grants: [{ folderId: 10, fileId: null, userId: 9, canView: true, canUpload: false, expiresAt: "2026-09-14T00:00:00Z" }] });
  assert.equal(canSeeDocument({ userId: 9, roleKey: "manager" }, g, grantDead), false, "прострочений виняток досі діє");
});

/** #430d ТІМЛІД НЕ БАЧИТЬ ПАПКУ ОФЕРІВ; менеджер бачить її лише коли має власний офер; архів — лише керівництву і не редагується ніким. */
test("#430d ДОКУМЕНТИ: папка оферів тімліду відсутня; архів читає лише керівництво, редагує ніхто", () => {
  assert.equal(canSeeOffersSection({ userId: 1, roleKey: "team_lead" }, false), false);
  assert.equal(canSeeOffersSection({ userId: 1, roleKey: "team_lead" }, true), true, "тімлід із власним офером мусить бачити свій");
  assert.equal(canSeeOffersSection({ userId: 1, roleKey: "manager" }, false), false);
  assert.equal(canSeeOffersSection({ userId: 1, roleKey: "admin" }, false), true);
  const arch = doc({ section: "personal", addresseeUserId: 77, archivedAt: "2026-09-10T00:00:00Z" });
  assert.equal(canSeeDocument({ userId: 77, roleKey: "manager" }, arch, ctx()), false, "адресат бачить свій документ в архіві — а має лише керівництво");
  assert.equal(canSeeDocument({ userId: 1, roleKey: "admin" }, arch, ctx()), true);
  assert.equal(canEditDocument({ userId: 1, roleKey: "admin" }, arch, ctx()), false, "адмін може редагувати архів — заборонено рішенням ⑦");
});

/** #430e ПІДПИС ПРИВʼЯЗАНИЙ ДО ВЕРСІЇ: нова версія (інший sha) робить підпис недійсним. */
test("#430e ДОКУМЕНТИ: підпис чинний лише для поточної версії; нова версія → «потребує підпису», старий запис лишається", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const sigs = [{ version: 1, sha256: "aaa", signedAt: "2026-09-11T14:20:00Z" }];
  assert.equal(signatureState({ version: 1, sha256: "aaa", section: "offer" }, sigs, now, "2026-09-11T00:00:00Z").kind, "signed");
  const after = signatureState({ version: 2, sha256: "bbb", section: "offer" }, sigs, now, "2026-09-11T00:00:00Z");
  assert.equal(after.kind, "outdated", "після заміни файла підпис лишився чинним");
  assert.equal(signatureState({ version: 1, sha256: "aaa", section: "offer" }, [], now, "2026-09-12T00:00:00Z").kind, "pending");
  assert.equal(signatureState({ version: 1, sha256: "aaa", section: "offer" }, [], now, "2026-09-01T00:00:00Z").kind, "overdue");
  assert.equal(signatureState({ version: 1, sha256: "aaa", section: "general" }, [], now, null).kind, "not_required");
});
