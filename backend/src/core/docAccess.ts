/**
 * 📁 ДОСТУП ДО ДОКУМЕНТІВ — ОДНЕ ПРАВИЛО, ЧИСТЕ, БЕЗ БД.
 *
 * 🔴 СВІДОМИЙ ВИНЯТОК ІЗ ЗАГАЛЬНОГО ПРАВИЛА ВИДИМОСТІ (рішення власника 10.09 і 15.09.2026).
 * Скрізь у дашборді видимість виводиться з `roles.data_scope`: менеджер — свої клієнти,
 * тімлід — команда, опдир — уся компанія. ТУТ — НІ. Навіть роль з обсягом «вся компанія»
 * не бачить чужий особистий документ і чужий офер. Видимість задається ВЛАСНИМ списком:
 * розділ документа, адресат, права папки по ролях, персональні винятки.
 * Якщо колись уніфікуватимуть обсяги в одному місці — цей файл лишається окремим, і гейт
 * #430 червоніє на першій же спробі вивести доступ із `data_scope`.
 *
 * Розділи (вісь B ТЗ):
 *   general  — бачить уся команда (права папки можуть звузити), публікує лише керівництво;
 *   personal — адресат + автор + керівництво;
 *   offer    — керівництво + менеджер-адресат СВОГО офера; тімлід — НЕ бачить навіть папки;
 *   archive  — стан (`archived_at`), читання лише керівництву, редагування нікому.
 *
 * «Керівництво» = ролі з `MANAGEMENT_ROLES`. Це не `isAdminScope` навмисно: фінансист і
 * бухгалтерія мають company-scope на клієнтах, але офери — не їхня справа (рішення 15.09).
 */

export type DocSection = "general" | "personal" | "offer";

export interface DocViewer {
  userId: number;
  roleKey: string;
}

export interface DocLike {
  id: number;
  folderId: number | null;
  section: DocSection;
  addresseeUserId: number | null;
  createdBy: number | null;
  archivedAt: string | null;
  /** «Неактивний» після повернення з архіву: видно, але не підписати й не редагувати до «Активувати». */
  inactiveAt?: string | null;
}

export interface FolderRights {
  canView: boolean; canUpload: boolean; canEdit: boolean; canPublish: boolean;
}

export interface Grant {
  folderId: number | null; fileId: number | null; userId: number;
  canView: boolean; canUpload: boolean; expiresAt: string | null;
}

/**
 * Ролі, що бачать усе (у тому числі офери й архів) і керують доступом. Рішення ⑤/⑥,
 * склад уточнено власником 15.09.2026 («усі з адміном, КВП, СЕО, HR», опдир лишається).
 * ⚠️ Це список ЗА ІМЕНЕМ ролі, а не за `data_scope`: фінансист і бухгалтерія теж company-scope,
 * але сюди не входять — і саме це стереже #441.
 */
export const MANAGEMENT_ROLES: readonly string[] = ["admin", "opdir", "ceo", "kvp", "hr"];

export const isManagement = (roleKey: string): boolean => MANAGEMENT_ROLES.includes(roleKey);

/** Права ролі на папці за відсутності рядка: загальні читають усі, решта — нічого. */
export const DEFAULT_RIGHTS: FolderRights = { canView: true, canUpload: false, canEdit: false, canPublish: false };

function grantActive(g: Grant, now: Date): boolean {
  return g.expiresAt == null || new Date(g.expiresAt).getTime() > now.getTime();
}

export interface AccessContext {
  /** Права поточної ролі на папках: folderId → rights (лише явні рядки). */
  folderRights: ReadonlyMap<number, FolderRights>;
  /** Персональні винятки поточного користувача. */
  grants: readonly Grant[];
  now?: Date;
}

/**
 * ЧИ БАЧИТЬ viewer документ. Порядок перевірок значущий:
 *  1. архів — лише керівництво;
 *  2. керівництво бачить усе;
 *  3. особистий / офер — лише адресат або автор (для офера автор ≠ доступ: офер виклав
 *     керівник, він і так у п.2; менеджер-автор чужого офера — не буває);
 *  4. загальний — за правами папки (явний рядок може ЗАКРИТИ), або персональний виняток.
 */
export function canSeeDocument(viewer: DocViewer, doc: DocLike, ctx: AccessContext): boolean {
  const now = ctx.now ?? new Date();
  if (doc.archivedAt != null) return isManagement(viewer.roleKey);
  if (isManagement(viewer.roleKey)) return true;
  if (doc.section === "offer") return doc.addresseeUserId === viewer.userId;
  if (doc.section === "personal") return doc.addresseeUserId === viewer.userId || doc.createdBy === viewer.userId;
  // general
  const grant = ctx.grants.find((g) => grantActive(g, now) && g.canView
    && ((g.fileId != null && g.fileId === doc.id) || (g.folderId != null && g.folderId === doc.folderId)));
  if (grant) return true;
  if (doc.folderId == null) return true; // корінь загальних — усім
  const rights = ctx.folderRights.get(doc.folderId);
  return rights ? rights.canView : DEFAULT_RIGHTS.canView;
}

/** Чи бачить viewer сам розділ «Офери» (папку) — тімлід не бачить її взагалі (рішення ⑥). */
export function canSeeOffersSection(viewer: DocViewer, hasOwnOffer: boolean): boolean {
  return isManagement(viewer.roleKey) || hasOwnOffer;
}

/** Чи може viewer завантажувати в папку розділу general. */
export function canUploadTo(viewer: DocViewer, folderId: number | null, ctx: AccessContext): boolean {
  if (isManagement(viewer.roleKey)) return true;
  const now = ctx.now ?? new Date();
  if (ctx.grants.some((g) => grantActive(g, now) && g.canUpload && g.folderId != null && g.folderId === folderId)) return true;
  if (folderId == null) return false;
  return ctx.folderRights.get(folderId)?.canUpload ?? DEFAULT_RIGHTS.canUpload;
}

/** Редагувати (перейменувати, нова версія, тип) — керівництво або право папки; архів — ніхто. */
export function canEditDocument(viewer: DocViewer, doc: DocLike, ctx: AccessContext): boolean {
  if (doc.archivedAt != null || doc.inactiveAt != null) return false;
  if (isManagement(viewer.roleKey)) return true;
  if (doc.section !== "general" || doc.folderId == null) return false;
  return ctx.folderRights.get(doc.folderId)?.canEdit ?? DEFAULT_RIGHTS.canEdit;
}

/** Керувати доступом (матриця, винятки) — лише керівництво, і це не знімається. */
export const canManageAccess = (viewer: DocViewer): boolean => isManagement(viewer.roleKey);

/** Підписувати може лише адресат неархівованого й активного документа. */
export function canSignDocument(viewer: DocViewer, doc: DocLike): boolean {
  return doc.archivedAt == null && doc.inactiveAt == null && doc.addresseeUserId === viewer.userId;
}

/** Стан підпису для картки: чинний лише той запис, чий хеш == хешу поточної версії. */
export function signatureState(
  doc: { version: number; sha256: string | null; section: DocSection },
  signatures: readonly { version: number; sha256: string; signedAt: string }[],
  now: Date, sentAt: string | null,
): { kind: "not_required" | "signed" | "pending" | "overdue" | "outdated"; days: number | null } {
  if (doc.section !== "offer") return { kind: "not_required", days: null };
  const current = signatures.find((s) => s.sha256 === doc.sha256 && s.version === doc.version);
  if (current) return { kind: "signed", days: null };
  const anyOld = signatures.length > 0;
  const since = sentAt ? new Date(sentAt) : null;
  const days = since ? Math.floor((now.getTime() - since.getTime()) / 864e5) : null;
  if (anyOld) return { kind: "outdated", days };
  return { kind: days != null && days > 7 ? "overdue" : "pending", days };
}
