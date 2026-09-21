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

/**
 * «ВЛАСНІ ПРАВА» ФАЙЛА (рішення ТЗ: права на окремий документ ширші або вужчі за папку).
 * Явний рядок ролі на файлі ПЕРЕМАГАЄ права папки в обидва боки: може закрити документ у
 * відкритій папці й відкрити документ у закритій. Керівництво не звужується ніколи.
 */
export interface FileRights { canView: boolean; canEdit: boolean; }

/**
 * Чи бачить РОЛЬ загальний документ без персональних винятків. Одне правило на три місця:
 * перевірку доступу, аудиторію регламенту і блок «хто бачить» — інакше вони розійдуться.
 */
export function roleSeesGeneral(roleKey: string, folderId: number | null, file: FileRights | undefined, folder: FolderRights | undefined): boolean {
  if (isManagement(roleKey)) return true;
  if (file) return file.canView;
  if (folderId == null) return true; // корінь загальних — усім
  return folder ? folder.canView : DEFAULT_RIGHTS.canView;
}

/**
 * 📂 ПАПКА В ПАПЦІ (21.09.2026). Ланцюжок від папки до кореня; цикл у даних обривається, а не вішає запит.
 * Права підпапки без власного рядка = права НАЙБЛИЖЧОЇ батьківської, що його має. Інакше перенесення
 * папки всередину закритої відкривало б її вміст усім (дефолт «загальні бачать усі»).
 */
export type FolderParents = ReadonlyMap<number, number | null>;
export function folderChain(folderId: number | null, parents: FolderParents | undefined): number[] {
  const out: number[] = [];
  for (let id = folderId; id != null && !out.includes(id) && out.length < 64; id = parents?.get(id) ?? null) out.push(id);
  return out;
}
export function inheritedRights<T>(folderId: number | null, parents: FolderParents | undefined, rows: ReadonlyMap<number, T>): T | undefined {
  for (const id of folderChain(folderId, parents)) { const r = rows.get(id); if (r) return r; }
  return undefined;
}
/** Чи можна перенести папку `id` у `newParent`: не в себе й не у власну підпапку. */
export function moveFolderRefusal(id: number, newParent: number | null, parents: FolderParents): string | null {
  if (newParent == null) return null;
  if (newParent === id) return "Папку не можна перенести саму в себе";
  if (!parents.has(newParent)) return "Папки призначення не існує";
  if (folderChain(newParent, parents).includes(id)) return "Папку не можна перенести у власну підпапку";
  return null;
}

export interface AccessContext {
  /** Батьки папок (id → parentId) для успадкування прав; без них папка рахується кореневою. */
  folderParents?: FolderParents;
  /** Права поточної ролі на папках: folderId → rights (лише явні рядки). */
  folderRights: ReadonlyMap<number, FolderRights>;
  /** Власні права поточної ролі на окремих файлах: fileId → rights (лише явні рядки). */
  fileRights?: ReadonlyMap<number, FileRights>;
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
    && ((g.fileId != null && g.fileId === doc.id) || (g.folderId != null && folderChain(doc.folderId, ctx.folderParents).includes(g.folderId))));
  if (grant) return true;
  return roleSeesGeneral(viewer.roleKey, doc.folderId, ctx.fileRights?.get(doc.id), inheritedRights(doc.folderId, ctx.folderParents, ctx.folderRights));
}

/** Чи бачить viewer сам розділ «Офери» (папку) — тімлід не бачить її взагалі (рішення ⑥). */
export function canSeeOffersSection(viewer: DocViewer, hasOwnOffer: boolean): boolean {
  return isManagement(viewer.roleKey) || hasOwnOffer;
}

/** Чи може viewer завантажувати в папку розділу general. */
export function canUploadTo(viewer: DocViewer, folderId: number | null, ctx: AccessContext): boolean {
  if (isManagement(viewer.roleKey)) return true;
  const now = ctx.now ?? new Date();
  if (ctx.grants.some((g) => grantActive(g, now) && g.canUpload && g.folderId != null && folderChain(folderId, ctx.folderParents).includes(g.folderId))) return true;
  if (folderId == null) return false;
  return inheritedRights(folderId, ctx.folderParents, ctx.folderRights)?.canUpload ?? DEFAULT_RIGHTS.canUpload;
}

/** Редагувати (перейменувати, нова версія, тип) — керівництво або право папки; архів — ніхто. */
export function canEditDocument(viewer: DocViewer, doc: DocLike, ctx: AccessContext): boolean {
  if (doc.archivedAt != null || doc.inactiveAt != null) return false;
  if (isManagement(viewer.roleKey)) return true;
  if (doc.section !== "general") return false;
  const own = ctx.fileRights?.get(doc.id);
  if (own) return own.canView && own.canEdit; // редагувати невидиме не можна
  if (doc.folderId == null) return false;
  return inheritedRights(doc.folderId, ctx.folderParents, ctx.folderRights)?.canEdit ?? DEFAULT_RIGHTS.canEdit;
}

/**
 * «НОВЕ» (ТЗ: позначка на свіжих документах). Припущення, озвучене власнику 17.09.2026:
 * глядач ще не відкривав ПОТОЧНУ версію, і її завантажено не раніше ніж 30 днів тому.
 * Свою ж версію людина вже бачила — для автора версії не «нове». Архів — ніколи.
 */
export const NEW_WINDOW_DAYS = 30;
export interface NewnessInput { version: number; versionAt: string | null; versionBy: number | null; archivedAt: string | null; }
export function isNewForViewer(d: NewnessInput, seenVersion: number | undefined, viewerId: number, now: Date = new Date(), windowDays = NEW_WINDOW_DAYS): boolean {
  if (d.archivedAt != null || d.versionAt == null) return false;
  if (d.versionBy != null && d.versionBy === viewerId) return false;
  if ((seenVersion ?? 0) >= d.version) return false;
  return now.getTime() - new Date(d.versionAt).getTime() <= windowDays * 86_400_000;
}

/** Керувати доступом (матриця, винятки) — лише керівництво, і це не знімається. */
export const canManageAccess = (viewer: DocViewer): boolean => isManagement(viewer.roleKey);

/** Підписувати може лише адресат неархівованого й активного документа. */
export function canSignDocument(viewer: DocViewer, doc: DocLike): boolean {
  return doc.archivedAt == null && doc.inactiveAt == null && doc.addresseeUserId === viewer.userId;
}

export interface SignatureLike { version: number; sha256: string; signedAt: string; method?: string; approvedAt?: string | null; rejectedAt?: string | null }
/**
 * Стан підпису для картки: чинний лише той запис, чий хеш == хешу поточної версії І який не
 * відхилено. Фото паперу (`paper_photo`) чинне лише ПІСЛЯ підтвердження керівництвом — до того
 * стан `review` (рішення власника 16.09.2026); код у Telegram підтверджує себе сам (#448).
 */
export function signatureState(
  doc: { version: number; sha256: string | null; section: DocSection },
  signatures: readonly SignatureLike[],
  now: Date, sentAt: string | null,
): { kind: "not_required" | "signed" | "review" | "pending" | "overdue" | "outdated"; days: number | null } {
  if (doc.section !== "offer") return { kind: "not_required", days: null };
  const live = signatures.filter((s) => s.rejectedAt == null);
  const current = live.find((s) => s.sha256 === doc.sha256 && s.version === doc.version);
  if (current) return { kind: current.method === "paper_photo" && !current.approvedAt ? "review" : "signed", days: null };
  const anyOld = live.length > 0;
  const since = sentAt ? new Date(sentAt) : null;
  const days = since ? Math.floor((now.getTime() - since.getTime()) / 864e5) : null;
  if (anyOld) return { kind: "outdated", days };
  return { kind: days != null && days > 7 ? "overdue" : "pending", days };
}

/**
 * ✍️ «ПІДПИСАНО РАНІШЕ» (рішення власника 21.09.2026): офер, який людина вже підписала на папері до
 * появи розділу, не має чекати підпису вдруге. Керівництво ставить позначку — це звичайний запис
 * підпису з методом `signed_earlier`, привʼязаний до ПОТОЧНОЇ версії й хеша. Тому стан один
 * (`signatureState`), нагадування замовкають самі, а нова версія знову вимагає підпису.
 * Повертає причину відмови або null.
 */
export const SIGNED_EARLIER = "signed_earlier";
export function presignRefusal(
  doc: { section: DocSection; archivedAt: string | null; inactiveAt?: string | null; sha256: string | null; addresseeUserId: number | null },
  stateKind: ReturnType<typeof signatureState>["kind"], signedOn: string | null, today: string,
): string | null {
  if (doc.section !== "offer") return "«Підписано раніше» буває лише в оферів";
  if (doc.archivedAt != null) return "Офер в архіві";
  if (doc.inactiveAt != null) return "Офер неактивний — спершу активуйте";
  if (!doc.addresseeUserId) return "В офера немає адресата";
  if (!doc.sha256) return "У файла немає контрольної суми — завантажте нову версію";
  if (stateKind === "signed") return "Поточна версія вже підписана";
  if (stateKind === "review") return "Фото підпису чекає підтвердження — ухваліть рішення по ньому";
  if (signedOn != null && (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn) || signedOn > today)) return "Дата підпису має бути у форматі РРРР-ММ-ДД і не в майбутньому";
  return null;
}
