import { test } from "node:test";
import assert from "node:assert/strict";
import { canSeeDocument, canSeeOffersSection, canEditDocument, canSignDocument, signatureState, MANAGEMENT_ROLES, type DocLike, type AccessContext } from "./docAccess.js";

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({ folderRights: new Map(), grants: [], now: new Date("2026-09-15T12:00:00Z"), ...over });
const doc = (over: Partial<DocLike> = {}): DocLike => ({ id: 1, folderId: 10, section: "general", addresseeUserId: null, createdBy: 5, archivedAt: null, ...over });

/**
 * #441 — ГОЛОВНИЙ ГЕЙТ ПРОХОДУ: доступ до документів НЕ виводиться з обсягу ролі.
 * Фінансист і бухгалтерія мають `data_scope='company'` і бачать усіх клієнтів — але чужий
 * особистий документ і чужий офер НЕ бачать, бо їх немає в `MANAGEMENT_ROLES`. КВП і HR
 * бачать ЛИШЕ тому, що власник 15.09.2026 вписав їх у керівництво поіменно. Червоніє,
 * якщо зробити предикат похідним від обсягу ролі (фінансист побачить офер) або
 * змінити склад керівництва без рішення власника.
 * (Замінив #430: там КВП був поза керівництвом — твердження змінилось, номер новий.)
 */
test("#441 ДОКУМЕНТИ: чужий офер/особистий недосяжний за обсягом ролі — фінансист (company) не бачить, КВП/HR/опдир бачать як керівництво", () => {
  const offer = doc({ section: "offer", addresseeUserId: 77 });
  const personal = doc({ section: "personal", addresseeUserId: 77, createdBy: 3 });
  for (const r of ["financier", "____________"]) {
    assert.equal(canSeeDocument({ userId: 1, roleKey: r }, offer, ctx()), false, `${r} з company-scope побачив чужий офер`);
    assert.equal(canSeeDocument({ userId: 1, roleKey: r }, personal, ctx()), false, `${r} побачив чужий особистий`);
  }
  for (const r of ["admin", "opdir", "ceo", "kvp", "hr"]) {
    assert.equal(canSeeDocument({ userId: 1, roleKey: r }, offer, ctx()), true, `${r} (керівництво) не бачить офер`);
    assert.equal(canSeeDocument({ userId: 1, roleKey: r }, personal, ctx()), true, `${r} (керівництво) не бачить особистий`);
  }
  assert.equal(canSeeDocument({ userId: 1, roleKey: "team_lead" }, offer, ctx()), false, "тімлід побачив чужий офер");
  assert.equal(canSeeDocument({ userId: 1, roleKey: "team_lead" }, personal, ctx()), false, "тімлід побачив особистий документ своєї команди (рішення 15.09: не бачить)");
  assert.equal(canSeeDocument({ userId: 1, roleKey: "manager" }, offer, ctx()), false, "менеджер побачив чужий офер");
  assert.deepEqual([...MANAGEMENT_ROLES].sort(), ["admin", "ceo", "hr", "kvp", "opdir"], "склад керівництва змінився — це рішення власника (15.09.2026)");
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

/**
 * #430f — ТРИ СТАНИ ЕКРАНА НЕ ЗМІШУЮТЬСЯ (розділ 8 ТЗ). Читає джерело `DocumentsSection.tsx`:
 * стан «помилка» рендериться ДО будь-якого «порожньо», а стан «немає доступу» береться з
 * відповіді сервера (403), а не вигадується. Червоніє, якщо повернути «Порожньо» поруч із
 * помилкою або прибрати гілку 403.
 */
test("#430f ДОКУМЕНТИ: «помилка», «порожньо» і «немає доступу» — три різні гілки, помилка раніше за порожнечу", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "DocumentsSection.tsx"), "utf8");
  const errIdx = src.indexOf("Не вдалося завантажити список");
  const emptyIdx = src.indexOf("ще нічого немає");
  const noAccessIdx = src.indexOf("Документ не для вас");
  assert.ok(errIdx > 0 && emptyIdx > 0 && noAccessIdx > 0, "одного з трьох станів немає в джерелі");
  assert.ok(errIdx < emptyIdx, "стан «помилка» стоїть ПІСЛЯ «порожньо» — при 500 людина побачить порожню папку");
  assert.match(src, /if \(loadErr && !tree\) return \(/, "гілка помилки не відрізає рендер списку");
  assert.match(src, /r\?\.status === 403\) setNoAccess\(true\)/, "стан «немає доступу» не береться з 403 сервера");
  assert.doesNotMatch(src, /Порожньо\. Створіть папку/, "старий рядок «Порожньо…» повернувся");
});
