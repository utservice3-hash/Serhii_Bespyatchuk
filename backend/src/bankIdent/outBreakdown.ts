/**
 * 💳 «Виписка» — РОЗШИФРОВКА ВИХІДНИХ ФОП І КАРТКИ (задача Тетяни 03.11.2026; рішення Сергія 03.11 — варіант «б»).
 *
 * До вихідного платежу з рахунків ФОП Приват / ФОП Моно / картки Ступаківського вписують, за які угоди він пішов
 * перевізнику: рядки «№ угоди сума» (формат Тані: «62788851 3000»). У призначенні цих платежів номерів угод немає
 * взагалі (замір 03.11, 30 днів: ФОП Моно 0 з 67, ФОП Приват 0 з 29, картка 0 з 5) — тож лише руками.
 *
 *   Бачать розшифровку, фільтр і рядок стану — фінанси й тімліди (право `view_bank_out_breakdown`); менеджер — ні:
 *   по угоді стало б видно, скільки заплатили перевізнику.
 *   Вписують і змінюють — Таня (адмін), бухгалтерія, тімліди (право `edit_bank_out_breakdown`).
 *   Строку немає: платіж «чекає», поки не впишуть. «Неідентифікований» — лише руками, з причиною.
 *   «Змінити» вписане — з причиною; платіж іде у фільтр «Відкориговані», в історію — обидва стани.
 *   Розписано ≠ сумі платежу — стан «не зійшлось»: він у «Чекають», а не в «З номером».
 *
 *   Рядки трьох видів (Тетяна 03.11, 18:56 — «не лише оплати по айді, а й операційні і зп»):
 *     «62821719 3000» — витрата по угоді (8–9 цифр, як у Kommo);
 *     «4445 3000»     — операційний запит (до 7 цифр; номер приймаємо як є — довідника запитів у дашборді немає);
 *     «зп 20000», «DigitalOcean 453» — категорія текстом (мусить мати хоч одну літеру).
 *   Хвіст у дужках — примітка до рядка: «4445 3000 (Операційний запит)».
 *   «Свій переказ» для вихідних — лише на НАШ рахунок (IBAN) або «між власними рахунками»; імʼя власника — ні:
 *   «Переказ на картку» Беспятчуку — це 73 з 75 вихідних ФОП Моно, і саме їх Тетяна розписує (замір 03.11).
 *
 * Чисті функції: без БД і мережі — гейти ганяють їх у звичайному `npm test`.
 */

import { isOwnTransfer, type IdentRules, type TxLite } from "./bankIdent.js";

export const VIEW_PERM = "view_bank_out_breakdown";
export const EDIT_PERM = "edit_bank_out_breakdown";

// Рахунки — ТІ САМІ, що на «№ рахунку» вхідних (`engine.accountIds`: ФОП Приват 3, ФОП Моно 4, картка 11; env
// BANK_IDENT_ACCOUNT_IDS). Один перелік на обидві половини «Виписки» — щоб рахунок не опинився лише в одній.
/** З якої дати платежі рахуються «чекають» — старіші можна розписати, але в лічильник вони не падають. */
export const OUT_FROM = "2026-10-01";

export const MAX_LINES = 50;
const MAX_TEXT = 4000;
const MAX_LABEL = 80;

export type OutKind = "deal" | "op" | "text";
/** Рядок розшифровки. `ref` — № угоди / № запиту / назва категорії; `note` — примітка з дужок. */
export interface OutLine { kind: OutKind; ref: string; amount: number; note?: string }

/** Збережений рядок → рядок. Записи до 03.11 вечора — `{deal, amount}` без виду: це угода. */
export function normLine(raw: unknown): OutLine {
  const x = (raw ?? {}) as { kind?: string; ref?: unknown; deal?: unknown; amount?: unknown; note?: unknown };
  const kind: OutKind = x.kind === "op" || x.kind === "text" ? x.kind : "deal";
  const ref = String(x.ref ?? x.deal ?? "");
  return { kind, ref, amount: Number(x.amount), ...(typeof x.note === "string" && x.note ? { note: x.note } : {}) };
}

/**
 * 💳 Переказ з ФОП Моно на картку власника (Тетяна 13.11.2026: «фоп моно: прибрати розшифровку таких платежів, зробити
 * як „переказ між рахунками“, розшифровка по них на карті буде»). Гроші розписуються на робочій картці «Беспятчук white
 * (Моно)», тож на ФОП — свій переказ, і НАВІТЬ уже розписаний (інакше ті самі гроші розписані двічі). Лише ФОП Моно (id 4).
 */
export const FOP_MONO_ACCOUNT_ID = 4;
const TO_CARD = /переказ\s+на\s+картку/i;
export const isFopMonoToOwnerCard = (tx: TxLite): boolean => !tx.incoming && Number(tx.accountId) === FOP_MONO_ACCOUNT_ID
  && String(tx.counterpartyName || "").toLowerCase().includes("беспятчук") && TO_CARD.test(String(tx.purpose || ""));

/** Вихідний платіж — свій переказ: на наш рахунок (IBAN), «між власними рахунками» або з ФОП Моно на картку власника. */
export const isOutOwn = (tx: TxLite, r: Pick<IdentRules, "ownIbans">): boolean =>
  isFopMonoToOwnerCard(tx) || isOwnTransfer(tx, { ownIbans: r.ownIbans, ownNames: [] });
export type ParseResult = { ok: true; lines: OutLine[] } | { ok: false; error: string };

/** Сума «3 000», «3000,50», «3000.5», «3000 грн», «₴3000» → число з копійками; не сума → null. */
function parseAmount(s: string): number | null {
  const t = s.replace(/(грн\.?|uah|₴)/gi, "").replace(/[\s ]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n < 1e9 ? Math.round(n * 100) / 100 : null;
}

const SEP = String.raw`\s*(?:[-–—:=\t]\s*)?`;
const NUM_LINE = new RegExp(String.raw`^(\d{1,9})` + SEP + "(.+)$");
const TEXT_LINE = new RegExp(String.raw`^(.*?\p{L}.*?)` + SEP + String.raw`(\d[\d\s\u00a0]*(?:[.,]\d{1,2})?\s*(?:грн\.?|uah|₴)?)$`, "iu");

/** Один рядок → рядок розшифровки або null. Номер угоди — 8–9 цифр, запиту — до 7; інакше потрібна літера (категорія). */
export function parseLine(line: string): OutLine | null {
  const nm = /^(.*?)\s*\(([^()]{0,120})\)\s*$/.exec(line);
  const body = (nm ? nm[1] : line).trim();
  const note = nm ? nm[2].trim() : "";
  const withNote = (l: OutLine): OutLine => (note ? { ...l, note } : l);
  const n = NUM_LINE.exec(body);
  const na = n ? parseAmount(n[2]) : null;
  if (n && na !== null) return withNote({ kind: n[1].length >= 8 ? "deal" : "op", ref: String(Number(n[1])), amount: na });
  const t = TEXT_LINE.exec(body);
  const ta = t ? parseAmount(t[2]) : null;
  const label = t ? t[1].trim().replace(/\s+/g, " ") : "";
  if (t && ta !== null && label.length <= MAX_LABEL) return withNote({ kind: "text", ref: label, amount: ta });
  return null;
}

const KIND_WORD: Record<OutKind, string> = { deal: "Угода", op: "Операційний запит", text: "Категорія" };
const keyOf = (l: OutLine) => `${l.kind}:${l.ref.toLowerCase()}`;

/**
 * Вставлений текст → рядки (вид див. `parseLine`); роздільник між першою частиною й сумою — пробіл, таб, тире,
 * двокрапка; рядки — переносом або «;». Порожні пропускаються. Той самий № / категорія двічі — помилка (інакше сума
 * подвоїлась би непомітно).
 */
export function parseBreakdown(text: unknown): ParseResult {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "Впишіть хоча б один рядок, напр. «62788851 3000»." };
  if (text.length > MAX_TEXT) return { ok: false, error: "Забагато тексту." };
  const raw = text.split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean);
  if (raw.length > MAX_LINES) return { ok: false, error: `Забагато рядків — до ${MAX_LINES}.` };
  const lines: OutLine[] = [];
  const seen = new Set<string>();
  for (const [i, l] of raw.entries()) {
    const line = parseLine(l);
    if (!line) return { ok: false, error: `Рядок ${i + 1} «${l.slice(0, 40)}»: потрібно «№ угоди сума», «№ запиту сума» або «категорія сума», напр. 62788851 3000 · 4445 3000 · зп 20000.` };
    if (seen.has(keyOf(line))) return { ok: false, error: `${KIND_WORD[line.kind]} «${line.ref}» двічі — обʼєднайте суми в один рядок.` };
    seen.add(keyOf(line));
    lines.push(line);
  }
  return { ok: true, lines };
}

export const sumLines = (lines: OutLine[]) => Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

/** Той самий формат, що вставляють (і що розбирає `parseBreakdown`) — для «Скопіювати» та «Змінити». */
export function formatBreakdown(lines: OutLine[]): string {
  return lines.map((l) => `${l.ref} ${Number.isInteger(l.amount) ? l.amount : l.amount.toFixed(2)}${l.note ? ` (${l.note})` : ""}`).join("\n");
}

export type OutStored = "identified" | "unidentified";
/** Стан для інтерфейсу: немає запису — `wait`; розписано не на всю суму — `mismatch`. */
export type OutStatus = "wait" | "ok" | "mismatch" | "unidentified";
export type OutFilter = "all" | "ok" | "wait" | "unidentified" | "corrected";
export const OUT_FILTERS: readonly OutFilter[] = ["all", "ok", "wait", "unidentified", "corrected"];

export interface OutRow { status: OutStored; lines: OutLine[]; corrected: boolean }

/** Стан платежу: сума розшифровки звіряється з модулем суми платежу до копійки. */
export function outStatus(row: OutRow | null, paymentAmount: number): OutStatus {
  if (!row) return "wait";
  if (row.status === "unidentified") return "unidentified";
  return Math.abs(sumLines(row.lines) - Math.abs(paymentAmount)) < 0.005 ? "ok" : "mismatch";
}

/** Чи потрапляє платіж у фільтр. «Не зійшлось» — у «Чекають» (розшифровка ще не завершена), не в «З номером». */
export function inFilter(f: OutFilter, row: OutRow | null, paymentAmount: number): boolean {
  if (f === "all") return true;
  if (f === "corrected") return !!row?.corrected;
  const s = outStatus(row, paymentAmount);
  if (f === "wait") return s === "wait" || s === "mismatch";
  return s === f;
}

/** Причина для «Змінити» / «Неідентифікований»: обовʼязкова, до 300 символів. */
export function checkReason(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return "Вкажіть причину — вона лишається в історії.";
  if (v.trim().length > 300) return "Причина задовга — до 300 символів.";
  return null;
}

/**
 * Дія над платежем: перше вписування — `set` (без причини); будь-яка зміна вже збереженого — `change`
 * (з причиною, позначає «відкориговано»). Чисто, щоб правило «змінити = причина + відкориговано» мало одне місце.
 */
export function nextAct(existing: OutRow | null, kind: "lines" | "unidentify"): { act: "set" | "change" | "unidentify"; needsReason: boolean; corrected: boolean } {
  if (kind === "unidentify") return { act: "unidentify", needsReason: true, corrected: !!existing };
  if (!existing) return { act: "set", needsReason: false, corrected: false };
  return { act: "change", needsReason: true, corrected: true };
}
