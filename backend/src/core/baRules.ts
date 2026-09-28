/**
 * 🗂 БІЗНЕС-АСИСТЕНТ, прохід 1 (ТЗ «Блок Бізнес-асистент», задача 4314): Претензії й Судовий
 * реєстр. Чисті правила — без бази, щоб гейти перевіряли їх без оточення.
 *
 * Рішення, на яких стоїть цей модуль (Роман, 24.09.2026, пам'ять `business-assistant-decisions`):
 *  • розділ бачать роль «бізнес-асистент» і керівництво — межа = вкладка `ba` (screen_access);
 *  • кнопку «Проблемний клієнт» у дебіторці натискають керівництво і фінансист — право
 *    `create_claim`; бухгалтерія лише переглядає (рішення власника 05.09.2026), тож її там немає;
 *  • судовий реєстр ведеться вручну, без інтеграції з ЄДРСР;
 *  • з ТЗ: претензія зі статусом «Передано в суд» сама створює справу й переносить документи.
 */

export const CLAIM_STATUSES = ["problem", "sent", "answered", "noreply", "court", "paid", "closed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  problem: "Проблемний клієнт",
  sent: "Претензія відправлена",
  answered: "Відповідь отримана",
  noreply: "Без відповіді",
  court: "Передано в суд",
  paid: "Оплачено",
  closed: "Закрито",
};
/** Претензія «відкрита», поки не оплачена й не закрита (і не в архіві — це вже поле рядка). */
export const CLAIM_CLOSED_STATUSES: readonly ClaimStatus[] = ["paid", "closed"];

export const CASE_STATUSES = ["prep", "filed", "going", "done"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  prep: "Готується",
  filed: "Подано",
  going: "У процесі",
  done: "Завершено",
};

/** Типи документів. Претензія й справа мають свої переліки з ТЗ; спільний тип «Інше». */
export const DOC_TYPES = ["claim", "lawsuit", "receipt", "company_docs", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_TYPE_LABEL: Record<DocType, string> = {
  claim: "Претензія",
  lawsuit: "Позовна заява",
  receipt: "Квитанція про оплату",
  company_docs: "Документи компанії",
  other: "Інше",
};
export const CLAIM_DOC_TYPES: readonly DocType[] = ["claim", "lawsuit", "receipt", "other"];
export const CASE_DOC_TYPES: readonly DocType[] = ["lawsuit", "company_docs", "other"];

export const isClaimStatus = (v: unknown): v is ClaimStatus => typeof v === "string" && (CLAIM_STATUSES as readonly string[]).includes(v);
export const isCaseStatus = (v: unknown): v is CaseStatus => typeof v === "string" && (CASE_STATUSES as readonly string[]).includes(v);
export const isDocType = (v: unknown): v is DocType => typeof v === "string" && (DOC_TYPES as readonly string[]).includes(v);

/**
 * Чи створювати справу ПРИ ЦЬОМУ збереженні. Лише перехід у «Передано в суд» і лише коли справи
 * ще немає: повторне збереження того самого статусу справу не дублює (гейт `#770`).
 */
export function needsCourtCase(nextStatus: ClaimStatus, hasCase: boolean): boolean {
  return nextStatus === "court" && !hasCase;
}

/** Назва справи з претензії: «Стягнення боргу · Дельта Логістик» (без «ТОВ» і лапок). */
export function caseTitleFor(company: string): string {
  const short = company.replace(/^\s*(ТОВ|ФОП|ПП|ПрАТ|АТ)\s+/u, "").replace(/[«»"“”]/gu, "").trim();
  return `Стягнення боргу · ${short || company.trim()}`;
}

/**
 * Знімок боргу з рядків ядра `receivablesByClient` для ОДНОГО клієнта. Сума — сума рядків цього
 * ключа, дні — найбільші, назва — перша непорожня. Інші клієнти не підмішуються (гейт `#771b`).
 * `null`, якщо клієнта в дебіторці немає: претензію «з дебіторки» тоді не створюємо.
 */
export interface ReceivableRowLike { clientKey: string | null; clientName: string | null; amount: number; overdueDays: number | null }
export function debtSnapshot(rows: readonly ReceivableRowLike[], clientKey: string): { company: string; amount: number; overdueDays: number | null } | null {
  const mine = rows.filter((r) => r.clientKey === clientKey);
  if (!mine.length) return null;
  const amount = Math.round(mine.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100;
  const days = mine.map((r) => r.overdueDays).filter((d): d is number => d != null);
  const company = mine.map((r) => (r.clientName ?? "").trim()).find((n) => n) ?? clientKey;
  return { company, amount, overdueDays: days.length ? Math.max(...days) : null };
}

// ── Файли ────────────────────────────────────────────────────────────────────
export const BA_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const BA_FILE_MIMES = [
  "image/png", "image/jpeg", "image/webp", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
export type BaMime = (typeof BA_FILE_MIMES)[number];
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Тип — за ПЕРШИМИ БАЙТАМИ, а не за словом клієнта (той самий підхід, що в найму). DOCX — це
 * zip, тож zip приймаємо лише з розширенням `.docx`: голий архів із підписом «позов» не пройде.
 */
export function sniffBaMime(buf: Uint8Array, filename: string): BaMime | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => buf[i + k] === b);
  if (buf.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (buf.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (buf.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  if (buf.length >= 5 && at(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (buf.length >= 4 && at(0, [0x50, 0x4b, 0x03, 0x04]) && /\.docx$/i.test(filename.trim())) return DOCX;
  return null;
}

/**
 * Імʼя на диску. Файли лежать у КОРЕНІ теки документів із префіксом `ba-`: нічний бекап
 * (`jobs/backupDocuments.ts`) копіює лише файли кореня, без підтек — той самий урок, що в найму.
 */
export function baStoredName(uuid: string, mime: BaMime): string {
  const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "application/pdf" ? "pdf" : "docx";
  return `ba-${uuid}.${ext}`;
}

/** Дата `YYYY-MM-DD` або `null`; сміття — помилка, а не мовчазний `null`. */
export function parseDateOrNull(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))) return undefined;
  return v;
}
