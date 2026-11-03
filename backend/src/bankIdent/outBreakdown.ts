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
 * Чисті функції: без БД і мережі — гейти ганяють їх у звичайному `npm test`.
 */

export const VIEW_PERM = "view_bank_out_breakdown";
export const EDIT_PERM = "edit_bank_out_breakdown";

// Рахунки — ТІ САМІ, що на «№ рахунку» вхідних (`engine.accountIds`: ФОП Приват 3, ФОП Моно 4, картка 11; env
// BANK_IDENT_ACCOUNT_IDS). Один перелік на обидві половини «Виписки» — щоб рахунок не опинився лише в одній.
/** З якої дати платежі рахуються «чекають» — старіші можна розписати, але в лічильник вони не падають. */
export const OUT_FROM = "2026-10-01";

export const MAX_LINES = 50;
const MAX_TEXT = 4000;

export interface OutLine { deal: number; amount: number }
export type ParseResult = { ok: true; lines: OutLine[] } | { ok: false; error: string };

/** Сума «3 000», «3000,50», «3000.5», «3000 грн», «₴3000» → число з копійками; не сума → null. */
function parseAmount(s: string): number | null {
  const t = s.replace(/(грн\.?|uah|₴)/gi, "").replace(/[\s ]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n < 1e9 ? Math.round(n * 100) / 100 : null;
}

/**
 * Вставлений текст → рядки. Рядок = «№ угоди» (8–9 цифр) + сума; роздільник між ними — пробіл, таб, тире, двокрапка
 * чи «;». Порожні рядки пропускаються. Одна угода двічі — помилка (інакше сума подвоїлась би непомітно).
 */
export function parseBreakdown(text: unknown): ParseResult {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "Впишіть хоча б один рядок «№ угоди сума»." };
  if (text.length > MAX_TEXT) return { ok: false, error: "Забагато тексту." };
  const raw = text.split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean);
  if (raw.length > MAX_LINES) return { ok: false, error: `Забагато рядків — до ${MAX_LINES}.` };
  const lines: OutLine[] = [];
  const seen = new Set<number>();
  for (const [i, l] of raw.entries()) {
    const m = /^(\d{8,9})\s*(?:[-–—:=\t]\s*)?(.+)$/.exec(l);
    const amount = m ? parseAmount(m[2]) : null;
    if (!m || amount === null) return { ok: false, error: `Рядок ${i + 1} «${l.slice(0, 40)}»: потрібно «№ угоди сума», напр. 62788851 3000.` };
    const deal = Number(m[1]);
    if (seen.has(deal)) return { ok: false, error: `Угода ${deal} двічі — обʼєднайте суми в один рядок.` };
    seen.add(deal);
    lines.push({ deal, amount });
  }
  return { ok: true, lines };
}

export const sumLines = (lines: OutLine[]) => Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

/** Той самий формат, що вставляють: «№ сума» рядками — для «Скопіювати». */
export function formatBreakdown(lines: OutLine[]): string {
  return lines.map((l) => `${l.deal} ${Number.isInteger(l.amount) ? l.amount : l.amount.toFixed(2)}`).join("\n");
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
