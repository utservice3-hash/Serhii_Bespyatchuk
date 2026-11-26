/**
 * 💰 ЗАДАЧІ «ОТРИМАТИ ОПЛАТУ» — ОДНА ВІДКРИТА ЗАДАЧА НА ОДИН БОРГ (задача 9934, 26.11.2026).
 *
 * 🔴 НАВІЩО. Джоба `receivableDeadlineTasks` ставила НОВУ задачу щоразу, коли минала дата оплати, а
 * перенесення дати скидало позначку «задачу вже створено». Стару при цьому не закривав ніхто — ні при
 * наступному переносі, ні коли клієнт розрахувався. Заміряно на проді 26.11.2026: відкритих 164, з них
 * 98 зайвих копій; СМАР ТЕКС ТОВ — 14 відкритих задач у Семенюка, по одній на тиждень з 18.07; у команді
 * Яцика 137 із 213 відкритих задач — це «💰 Отримати оплату». Тімліди перестали бачити в задачнику живе.
 *
 * Правило тепер одне й живе тут, у чистій функції, щоб його можна було перевірити без бази:
 *  · борг має КЛЮЧ (`receivableTaskKey`): рахунок — `inv:<клієнт>:<№>`, клієнт — `cli:<клієнт>`;
 *  · новий прострочений дедлайн по борг-у з відкритою задачею ОНОВЛЮЄ її (назва, дедлайн, виконавець),
 *    а не ставить другу;
 *  · кілька відкритих задач з одним ключем → лишається НАЙНОВІША, решта закривається як дубль;
 *  · ключа вже немає в дебіторці (рахунок оплачений, клієнт розрахувався) → задача закривається;
 *  · ПОРОЖНЯ дебіторка нічого не закриває: нуль рядків означає «синк не дав даних», а не «усі
 *    заплатили» (правило проєкту: порожній результат — провал, доки не доведено протилежне).
 *
 * Межа свідома: задачі, поставлені ДО 9934, ключа не мають — їх розбирає разовий інструмент
 * `tools/cleanupReceivableTasks.ts` (сухий прогін за замовчуванням), а не джоба на льоту.
 */

export const RECEIVABLE_TASK_PREFIX = "💰 Отримати оплату: ";

export type ReceivableKeyKind = "inv" | "cli";

/** Ключ боргу. Рахунок без номера в дебіторці буває (`COALESCE(invoice_no, '')`) — тоді номер порожній, але ключ стабільний. */
export function receivableTaskKey(clientKey: string, invoiceNo: string | null): string {
  return invoiceNo === null ? `cli:${clientKey}` : `inv:${clientKey}:${invoiceNo}`;
}

export function receivableKeyKind(key: string): ReceivableKeyKind | null {
  if (key.startsWith("inv:")) return "inv";
  if (key.startsWith("cli:")) return "cli";
  return null;
}

/** Прострочений дедлайн, по якому має бути задача. */
export interface DueReceivable {
  key: string;
  title: string;
  comments: string;
  managerId: number;
  department: string;
}

/** Відкрита (status <> 'done') задача з ключем боргу. */
export interface OpenReceivableTask {
  id: number;
  key: string;
}

export interface ReceivableTaskPlan {
  insert: DueReceivable[];
  update: { id: number; due: DueReceivable }[];
  /** id дубля → id задачі, що лишається (для причини закриття). */
  closeDuplicate: { id: number; keptId: number }[];
  closePaid: number[];
  /** Види ключів, по яких закриття оплачених ПРОПУЩЕНО, бо джерело порожнє. */
  paidCheckSkipped: ReceivableKeyKind[];
}

export interface PlanInput {
  due: DueReceivable[];
  open: OpenReceivableTask[];
  /** Ключі, що ЗАРАЗ є в дебіторці: `cli:` з `receivables`, `inv:` з `receivable_invoices`. */
  liveKeys: ReadonlySet<string>;
  /** Скільки рядків у кожному джерелі. Нуль = джерело порожнє, закривати по ньому не можна. */
  liveRows: Record<ReceivableKeyKind, number>;
}

export function planReceivableTasks(input: PlanInput): ReceivableTaskPlan {
  const plan: ReceivableTaskPlan = { insert: [], update: [], closeDuplicate: [], closePaid: [], paidCheckSkipped: [] };

  // 1) Одна відкрита задача на ключ: найновіша (найбільший id) лишається, решта — дублі.
  const survivor = new Map<string, number>();
  for (const t of input.open) {
    const kept = survivor.get(t.key);
    if (kept === undefined || t.id > kept) survivor.set(t.key, t.id);
  }
  for (const t of input.open) {
    const kept = survivor.get(t.key)!;
    if (t.id !== kept) plan.closeDuplicate.push({ id: t.id, keptId: kept });
  }

  // 2) Оплачене закривається — лише якщо джерело відповідного виду НЕ порожнє.
  for (const kind of ["inv", "cli"] as const) {
    if (!(input.liveRows[kind] > 0)) plan.paidCheckSkipped.push(kind);
  }
  const paid = new Set<string>();
  for (const [key, id] of survivor) {
    const kind = receivableKeyKind(key);
    if (kind === null || plan.paidCheckSkipped.includes(kind)) continue;
    if (!input.liveKeys.has(key)) { plan.closePaid.push(id); paid.add(key); }
  }

  // 3) Прострочені дедлайни: є жива відкрита задача — оновити її; немає — поставити нову.
  //    Два записи з одним ключем в одному проході (не мало б бути) дають ОДНУ дію: перемагає останній.
  const dueByKey = new Map<string, DueReceivable>();
  for (const d of input.due) dueByKey.set(d.key, d);
  for (const [key, d] of dueByKey) {
    const id = survivor.get(key);
    if (id !== undefined && !paid.has(key)) plan.update.push({ id, due: d });
    else plan.insert.push(d);
  }
  return plan;
}

export const CLOSE_REASON_PAID = "Боргу вже немає в дебіторці — задачу закрито автоматично";
export const closeReasonDuplicate = (keptId: number) => `Дубль: по цьому боргу відкрита задача №${String(keptId)}`;

// ─────────────────────────────────────────────────────────────────────────────
// РАЗОВЕ ПРИБИРАННЯ ЗАДАЧ, ПОСТАВЛЕНИХ ДО 9934 (без ключа)
// ─────────────────────────────────────────────────────────────────────────────

/** Що можна прочитати з назви старої задачі. Формат назви — з джоби до 9934, обидва види. */
export interface ParsedLegacyTitle { clientName: string; invoiceNo: string | null }

const LEGACY_RE = /^💰 Отримати оплату: (.+?)(?: — рахунок №(.*?))? \(дедлайн \d{2}\.\d{2}\.\d{4} минув\)$/u;

export function parseLegacyTitle(title: string): ParsedLegacyTitle | null {
  const m = LEGACY_RE.exec(title);
  if (!m) return null;
  return { clientName: m[1].trim(), invoiceNo: m[2] === undefined ? null : m[2] };
}

export interface LegacyTask { id: number; title: string }

/** Живі борги за назвою клієнта: для клієнта — множина client_key, для рахунку — client_key за номером. */
export interface LiveByName {
  clients: ReadonlyMap<string, ReadonlySet<string>>;
  invoices: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
}

export interface LegacyCleanupPlan {
  /** Стара задача отримує ключ і лишається відкритою. */
  assignKey: { id: number; key: string }[];
  closeDuplicate: { id: number; keptId: number }[];
  closePaid: number[];
  /** Не чіпаємо: назву не розібрано або назва клієнта веде до кількох client_key. */
  untouched: { id: number; why: "unparsed" | "ambiguous" }[];
}

/**
 * Старі задачі (без ключа) разом із уже ключованими відкритими. Ключ виводиться з НАЗВИ клієнта через
 * поточну дебіторку; рівно один client_key → ключ, нуль → боргу немає (закрити), більше одного → не чіпати.
 * Серед однакових ключів лишається найновіша задача — і стара, і нова (з ключем) рахуються разом.
 */
export function planLegacyCleanup(input: {
  legacy: LegacyTask[];
  keyedOpen: OpenReceivableTask[];
  live: LiveByName;
}): LegacyCleanupPlan {
  const out: LegacyCleanupPlan = { assignKey: [], closeDuplicate: [], closePaid: [], untouched: [] };
  const byKey = new Map<string, { id: number; legacy: boolean }[]>();
  const add = (key: string, id: number, legacy: boolean) => {
    const arr = byKey.get(key) ?? [];
    arr.push({ id, legacy });
    byKey.set(key, arr);
  };
  for (const t of input.keyedOpen) add(t.key, t.id, false);

  for (const t of input.legacy) {
    const p = parseLegacyTitle(t.title);
    if (!p) { out.untouched.push({ id: t.id, why: "unparsed" }); continue; }
    const keys = p.invoiceNo === null
      ? input.live.clients.get(p.clientName)
      : input.live.invoices.get(p.clientName)?.get(p.invoiceNo);
    const n = keys?.size ?? 0;
    if (n === 0) { out.closePaid.push(t.id); continue; }
    if (n > 1) { out.untouched.push({ id: t.id, why: "ambiguous" }); continue; }
    const ck = [...keys!][0];
    add(receivableTaskKey(ck, p.invoiceNo), t.id, true);
  }

  for (const [key, arr] of byKey) {
    const kept = arr.reduce((a, b) => (b.id > a.id ? b : a));
    for (const x of arr) {
      if (x.id !== kept.id) out.closeDuplicate.push({ id: x.id, keptId: kept.id });
    }
    if (kept.legacy) out.assignKey.push({ id: kept.id, key });
  }
  return out;
}
