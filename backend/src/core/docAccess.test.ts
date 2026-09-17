import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canSeeDocument, canSeeOffersSection, canEditDocument, canSignDocument, signatureState, MANAGEMENT_ROLES, isNewForViewer, roleSeesGeneral, type DocLike, type AccessContext } from "./docAccess.js";

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

/** #448 — ФОТО ПАПЕРУ ЧИННЕ ЛИШЕ ПІСЛЯ ПІДТВЕРДЖЕННЯ: до нього «review», відхилене не рахується; код у Telegram — одразу «signed». */
test("#448 ПІДПИС ФОТО: чекає підтвердження керівництва, відхилений не чинний; код у Telegram чинний одразу", () => {
  const now = new Date("2026-09-16T12:00:00Z"); const d = { version: 2, sha256: "bbb", section: "offer" as const };
  const photo = { version: 2, sha256: "bbb", signedAt: "2026-09-16T10:00:00Z", method: "paper_photo", approvedAt: null, rejectedAt: null };
  assert.equal(signatureState(d, [photo], now, "2026-09-16T09:00:00Z").kind, "review", "фото без підтвердження зараховано як підпис");
  assert.equal(signatureState(d, [{ ...photo, approvedAt: "2026-09-16T11:00:00Z" }], now, "2026-09-16T09:00:00Z").kind, "signed");
  assert.equal(signatureState(d, [{ ...photo, rejectedAt: "2026-09-16T11:00:00Z" }], now, "2026-09-16T09:00:00Z").kind, "pending", "відхилене фото досі чинне або «review»");
  assert.equal(signatureState(d, [{ ...photo, method: "telegram_code", approvedAt: "2026-09-16T10:00:00Z" }], now, "2026-09-16T09:00:00Z").kind, "signed");
  assert.equal(signatureState(d, [{ ...photo, version: 1, sha256: "aaa", approvedAt: "2026-09-16T11:00:00Z" }], now, "2026-09-16T09:00:00Z").kind, "outdated", "підтверджене фото старої версії має бути «outdated», не чинним");
});

/**
 * #490 — КОШИК: видалене не потрапляє в дерево й картку, а кошик і повернення — лише керівництву.
 * Читає джерело роуту: єдиний запит для дерева/картки (`FILE_SELECT`) мусить відсікати `deleted_at`,
 * а `/trash` і `/undelete` стоять за middleware `management`. Червоніє, якщо прибрати фільтр
 * (видалений документ повернеться в список усім) або зняти `management` з кошика.
 */
test("#490 КОШИК: видалене не видно в дереві/картці; кошик і «Повернути» — лише керівництву", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/routes/documents.ts", import.meta.url)), "utf8");
  const select = src.slice(src.indexOf("const FILE_SELECT = `"), src.indexOf("`;", src.indexOf("const FILE_SELECT = `")));
  assert.match(select, /WHERE f\.deleted_at IS NULL/, "🔴 FILE_SELECT не відсікає видалені — вони повернуться в дерево й картку всім");
  assert.match(src, /documentsRouter\.get\("\/trash", management,/, "🔴 кошик без middleware management — видалені офери побачить будь-хто");
  assert.match(src, /documentsRouter\.post\("\/file\/:id\/undelete", management,/, "🔴 «Повернути з кошика» без management");
  assert.match(src, /documentsRouter\.post\("\/file\/:id\/delete", management,/, "🔴 «Видалити» без management");
});

/**
 * #507 — «НОВЕ»: позначка горить, поки глядач не відкрив ПОТОЧНУ версію, і лише 30 днів від її
 * завантаження. Фікстури по обидва боки кожної межі: відкрив / не відкрив, нова версія після
 * відкриття, 29 / 31 день, автор версії, архів. Червоніє, якщо «бачив будь-яку версію» гасить
 * позначку нової (оновлений регламент тихо пройде повз), якщо зняти вікно (усе старе стане
 * «нове» після викату) або якщо автор бачитиме своє завантаження як нове.
 */
test("#507 НОВЕ: поки не відкрив поточну версію і не старше 30 днів; нова версія — знову нове; автор і архів — ні", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const d = (over = {}) => ({ version: 2, versionAt: day(3), versionBy: 5, archivedAt: null, ...over });
  assert.equal(isNewForViewer(d(), undefined, 9, now), true, "не відкривав свіжу версію — мало бути «нове»");
  assert.equal(isNewForViewer(d(), 2, 9, now), false, "відкрив поточну версію — позначка мусить згаснути");
  assert.equal(isNewForViewer(d(), 1, 9, now), true, "бачив лише стару версію — оновлений документ мусить знову бути «нове»");
  assert.equal(isNewForViewer(d({ versionAt: day(29) }), undefined, 9, now), true, "29 днів — ще в межах вікна");
  assert.equal(isNewForViewer(d({ versionAt: day(31) }), undefined, 9, now), false, "31 день — поза вікном, старе не «нове»");
  assert.equal(isNewForViewer(d(), undefined, 5, now), false, "автор версії бачив її, коли завантажував");
  assert.equal(isNewForViewer(d({ archivedAt: day(1) }), undefined, 9, now), false, "архів не буває «нове»");
});

/**
 * #508 — ВЛАСНІ ПРАВА ДОКУМЕНТА перемагають права папки В ОБИДВА БОКИ. Вужчі: документ у відкритій
 * папці закрито ролі. Ширші: документ у закритій папці відкрито ролі. Керівництво не звужується.
 * Без рядка — «як у папці». Червоніє, якщо файловий рядок лише звужує (ширші права не діятимуть),
 * лише розширює, або якщо рядок файла закриє документ керівництву.
 */
test("#508 ВЛАСНІ ПРАВА: рядок файла ширший або вужчий за папку; без рядка — як у папці; керівництво не звужується", () => {
  const m = { userId: 1, roleKey: "manager" };
  const open = new Map([[10, { canView: true, canUpload: false, canEdit: false, canPublish: false }]]);
  const closed = new Map([[10, { canView: false, canUpload: false, canEdit: false, canPublish: false }]]);
  const own = (canView: boolean, canEdit = false) => new Map([[1, { canView, canEdit }]]);
  assert.equal(canSeeDocument(m, doc(), ctx({ folderRights: open })), true, "без власних прав відкрита папка відкриває");
  assert.equal(canSeeDocument(m, doc(), ctx({ folderRights: closed })), false, "без власних прав закрита папка закриває");
  assert.equal(canSeeDocument(m, doc(), ctx({ folderRights: open, fileRights: own(false) })), false, "🔴 вужчі права файла не закрили документ у відкритій папці");
  assert.equal(canSeeDocument(m, doc(), ctx({ folderRights: closed, fileRights: own(true) })), true, "🔴 ширші права файла не відкрили документ у закритій папці");
  assert.equal(canSeeDocument(m, doc({ id: 2 }), ctx({ folderRights: closed, fileRights: own(true) })), false, "права одного файла протекли на сусідній");
  assert.equal(canSeeDocument(m, doc({ folderId: null }), ctx({ fileRights: own(false) })), false, "корінь загальних теж звужується власними правами");
  for (const r of MANAGEMENT_ROLES) assert.equal(canSeeDocument({ userId: 1, roleKey: r }, doc(), ctx({ fileRights: own(false) })), true, `${r} (керівництво) закрито власними правами`);
  assert.equal(canEditDocument(m, doc(), ctx({ folderRights: open, fileRights: own(true, true) })), true, "власне право редагувати не діє");
  assert.equal(canEditDocument(m, doc(), ctx({ folderRights: new Map([[10, { canView: true, canUpload: false, canEdit: true, canPublish: false }]]), fileRights: own(true, false) })), false, "вужче право редагувати не зняло редагування папки");
  assert.equal(canEditDocument(m, doc(), ctx({ fileRights: own(false, true) })), false, "редагувати документ, якого не бачиш");
  assert.equal(canSeeDocument(m, doc({ section: "offer", addresseeUserId: 77 }), ctx({ fileRights: own(true) })), false, "власні права відкрили чужий офер — вони лише для загальних");
});

/**
 * #508b — ОДНЕ ПРАВИЛО ДЛЯ ТРЬОХ МІСЦЬ: аудиторія регламенту («прочитали N із M») і блок «хто бачить»
 * рахують ролі тим самим `roleSeesGeneral`, що й доступ; маршрути власних прав стоять за `management`.
 * Читає джерело роуту. Червоніє, якщо аудиторія знову рахуватиме лише папку (регламент, відкритий
 * ролі власними правами, не покаже її в «не прочитали») або якщо PUT прав стане доступним не керівництву.
 */
test("#508b ВЛАСНІ ПРАВА: аудиторія регламенту і «хто бачить» рахують тим самим правилом; керують лише керівники", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/routes/documents.ts", import.meta.url)), "utf8");
  const fnBody = (name: string) => { const i = src.indexOf(name); return src.slice(i, src.indexOf("\n}", i)); };
  const aud = fnBody("function audienceFor(");
  assert.match(aud, /const fi = aud\.fileRows\.get\(r\.id\)/, "🔴 аудиторія регламенту не бере власних прав САМЕ цього документа");
  assert.match(aud, /roleSeesGeneral\(x\.roleKey, r\.folder_id, fi\?\.get\(x\.roleKey\),/, "🔴 аудиторія регламенту не передає власних прав у правило");
  assert.match(fnBody('documentsRouter.get("/file/:id/viewers"'), /roleSeesGeneral\(x\.key, r\.folder_id, ownBy\.get\(x\.key\),/, "🔴 «хто бачить» не враховує власних прав документа");
  assert.match(src, /documentsRouter\.put\("\/file\/:id\/access", management,/, "🔴 зміна власних прав без management");
  assert.match(src, /documentsRouter\.get\("\/file\/:id\/access", management,/, "🔴 перегляд власних прав без management");
  assert.equal(roleSeesGeneral("manager", 10, { canView: true, canEdit: false }, { canView: false, canUpload: false, canEdit: false, canPublish: false }), true);
});
