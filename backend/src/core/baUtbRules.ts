/**
 * 🚛 БІЗНЕС-АСИСТЕНТ · РЕЄСТР УКРТРАНСБЕЗПЕКИ (задача 6269, ТЗ Даші 19.10.2026). Чисті правила — без бази,
 * щоб гейти перевіряли їх без оточення. Операції з базою — `core/baUtb.ts`.
 *
 * Рішення, на яких стоїть модуль:
 *  • ТЗ: один рядок = одна постанова УТБ; статуси «Нова → Збір документів → Передано → Переведено на перевізника»
 *    і окремо «Відмовлено / закрито без переведення» (лише з коментарем); «Передано» — лише з постановою, заявкою й ТТН;
 *  • ТЗ суперечить собі («без обовʼязкових полів запис не зберігається», а заявку й ТТН збирають аж на кроці 2), тож
 *    обовʼязкове ЗРОСТАЄ разом зі статусом (тлумачення з плану, Роман 21.10.2026 відповів на нього без заперечень);
 *  • доступ (Роман 21.10.2026): «Операційний директор і адміни бачать, а веде Даша» — веде власник реєстру ПОІМЕННО
 *    (`UTB_OWNER_IDS`, типово Дарʼя Протас, users.id 52), бачать ролі `admin` і `opdir`, решті вкладка прихована.
 */

export const UTB_STATUSES = ["new", "collecting", "handed", "transferred", "rejected"] as const;
export type UtbStatus = (typeof UTB_STATUSES)[number];
export const UTB_STATUS_LABEL: Record<UtbStatus, string> = {
  new: "Нова",
  collecting: "Збір документів",
  handed: "Передано",
  transferred: "Переведено на перевізника",
  rejected: "Відмовлено / закрито без переведення",
};
export const isUtbStatus = (v: unknown): v is UtbStatus => typeof v === "string" && (UTB_STATUSES as readonly string[]).includes(v);

/** Що з документів лежить у записі (за типами файлів у `ba_files`). */
export interface UtbDocs { decision: boolean; request: boolean; ttn: boolean }
/** Стан запису, з якого видно, чого бракує для статусу. */
export interface UtbState { managerId: number | null; handlerId: number | null; ttnNumber: string; comment: string; docs: UtbDocs }

/** Комплект для «Передано» (ТЗ: «неможливий, поки не завантажені заява, заявка і ТТН»). Індикатор у таблиці — той самий. */
export function utbDocsComplete(d: UtbDocs): boolean {
  return d.decision && d.request && d.ttn;
}

/**
 * Чого бракує, щоб запис стояв у статусі `status`. Порожній масив — можна. Підписи — словами для людини.
 * Кроки накопичуються: «Передано» вимагає і те, що вимагав «Збір документів». «Відмовлено» — лише коментар
 * (закрити можна на будь-якому кроці, але не мовчки).
 */
export function utbMissingFor(status: UtbStatus, s: UtbState): string[] {
  if (status === "new") return [];
  if (status === "rejected") return s.comment.trim() ? [] : ["коментар — чому штраф не переведено"];
  const out: string[] = [];
  if (!s.docs.decision) out.push("файл заяви / постанови УТБ");
  if (s.managerId == null) out.push("відповідальний менеджер");
  if (status === "collecting") return out;
  if (!s.docs.request) out.push("файл заявки");
  if (!s.docs.ttn) out.push("файл ТТН");
  if (!s.ttnNumber.trim()) out.push("номер ТТН");
  if (s.handlerId == null) out.push("відповідальна особа");
  return out;
}

// ── Доступ ───────────────────────────────────────────────────────────────────
export type UtbAccess = "edit" | "view";
/** Ролі, що БАЧАТЬ реєстр (Роман 21.10.2026: «Операційний директор і адміни бачать»). */
export const UTB_VIEW_ROLES: readonly string[] = ["admin", "opdir"];
/** Власник реєстру — поіменно. Типово Дарʼя Протас (users.id 52); змінюється ENV без викату коду. */
export function utbOwnerIds(env: string | undefined = process.env.UTB_OWNER_IDS): string[] {
  const ids = (env ?? "52").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
  return ids.length ? ids : ["52"];
}
/** `edit` — власник (незалежно від ролі); `view` — адмін чи операційний директор; `null` — вкладки немає. */
export function utbAccessOf(userId: number | null | undefined, roleKey: string | null | undefined, owners: readonly string[]): UtbAccess | null {
  if (userId != null && owners.includes(String(userId))) return "edit";
  if (roleKey && UTB_VIEW_ROLES.includes(roleKey)) return "view";
  return null;
}

// ── Сповіщення (задачі в Задачнику) ──────────────────────────────────────────
/**
 * Початок назви задачі з реєстру. За ним фронт упізнає НОВУ задачу й дає тост зі звуком (`signalTaskNotify.ts`,
 * `UTB_TASK_PREFIX`) — розійдуться, і сповіщення замовкне тихо (тримає `#1860f`).
 */
export const UTB_TASK_PREFIX = "🚛 УТБ:";
/**
 * Задача менеджеру «передати заявку і ТТН» — при ПРИЗНАЧЕННІ менеджера. `taskFor` — кому вже ставили задачу з цього
 * запису: повторне збереження того самого менеджера другу задачу не створює, зміна менеджера — створює новому.
 */
export function needsManagerTask(nextManagerId: number | null, taskFor: number | null): boolean {
  return nextManagerId != null && nextManagerId !== taskFor;
}
/** Задача відповідальній особі — при ПЕРЕХОДІ в «Передано» (ТЗ), одна на особу. */
export function needsHandlerTask(prev: UtbStatus, next: UtbStatus, handlerId: number | null, taskFor: number | null): boolean {
  return next === "handed" && prev !== "handed" && handlerId != null && handlerId !== taskFor;
}

// ── Фільтр і експорт ─────────────────────────────────────────────────────────
/** Рядок таблиці — мінімум, потрібний фільтру й експорту. */
export interface UtbRowLike {
  epNumber: string; receivedOn: string; carrier: string; fineAmount: number;
  managerId: number | null; managerName: string | null; handlerName: string | null;
  status: UtbStatus; docs: UtbDocs; ttnNumber: string; comment: string;
}
export interface UtbFilter { q?: string; carrier?: string; managerId?: number | null; status?: UtbStatus | null; from?: string | null; to?: string | null }

const norm = (s: string) => s.toLocaleLowerCase("uk-UA").replace(/\s+/g, " ").trim();
/**
 * Фільтр таблиці — ОДИН для екрана й для Excel (сервер віддає вже відфільтроване, експорт бере ту саму функцію):
 * № ВП і перевізник — входження без регістру; менеджер і статус — точно; період — дата надходження, обидва кінці включно.
 */
export function filterUtb<T extends UtbRowLike>(rows: readonly T[], f: UtbFilter): T[] {
  const q = norm(f.q ?? ""), c = norm(f.carrier ?? "");
  return rows.filter((r) =>
    (!q || norm(r.epNumber).includes(q))
    && (!c || norm(r.carrier).includes(c))
    && (f.managerId == null || r.managerId === f.managerId)
    && (!f.status || r.status === f.status)
    && (!f.from || r.receivedOn >= f.from)
    && (!f.to || r.receivedOn <= f.to));
}

export const UTB_EXPORT_HEAD = ["№ ВП", "Дата надходження", "Перевізник", "Сума штрафу, грн", "Відповідальний менеджер",
  "Відповідальна особа", "Статус", "Документи", "№ ТТН", "Коментар"] as const;
/** Рядки Excel — ті самі записи й той самий порядок, що в таблиці; документи словами, як індикатор на екрані. */
export function utbExportRows(rows: readonly UtbRowLike[]): (string | number | null)[][] {
  return [[...UTB_EXPORT_HEAD], ...rows.map((r) => [
    r.epNumber, `${r.receivedOn.slice(8, 10)}.${r.receivedOn.slice(5, 7)}.${r.receivedOn.slice(0, 4)}`, r.carrier, r.fineAmount,
    r.managerName ?? "", r.handlerName ?? "", UTB_STATUS_LABEL[r.status], utbDocsLabel(r.docs), r.ttnNumber, r.comment,
  ])];
}
/** «повний комплект» або що саме бракує — той самий текст, що в підказці індикатора. */
export function utbDocsLabel(d: UtbDocs): string {
  const miss = [!d.decision && "постанова", !d.request && "заявка", !d.ttn && "ТТН"].filter(Boolean);
  return miss.length ? `бракує: ${miss.join(", ")}` : "повний комплект";
}
