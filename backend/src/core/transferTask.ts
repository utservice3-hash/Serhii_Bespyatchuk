/**
 * 📝 ЗАДАЧА НОВОМУ МЕНЕДЖЕРУ ПРИ ПЕРЕДАЧІ КЛІЄНТА (Роман 08.10.2026; Андрій Безпамʼятний: «тімлід має прописати
 * чітку задачу, а не просто дізнатись чи є актуальні вантажі»). Чисте — без БД.
 *
 * Правила (рішення Романа 08.10.2026, «так, як пропонуєш»):
 *  · «Передача» — задача ОБОВʼЯЗКОВА: клієнт переходить до людини, яка його не знає, і без чіткої дії він зависає;
 *  · «Виправлення привʼязки» — задача за бажанням: новий менеджер, як правило, уже веде клієнта
 *    (з 33 змін тімлідів до 08.10 — 31 виправлення);
 *  · текст пише тімлід сам — шаблону немає, обовʼязкові лише текст і дедлайн (не раніше сьогодні);
 *  · пріоритет і «додатково для менеджера» — за потреби.
 *
 * Хто виконує, хто приймає, до чого привʼязано — `transferTaskRow`: виконавець — новий менеджер, автор і
 * «Приймає» — той, хто передав, `client_key` — клієнт. Записує роут `/client-manager` ОДНІЄЮ транзакцією з
 * передачею: або передача й задача, або нічого.
 */
export type TransferKind = "fix" | "transfer";
export type TaskPriority = "low" | "medium" | "high";
export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high"];

/**
 * Початок назви задачі. За ним фронт упізнає нову задачу по клієнту й показує менеджеру сповіщення — бо звичайна
 * нова задача приходить мовчки. ⚠️ МУСИТЬ ДОРІВНЮВАТИ фронту (`signalTaskNotify.ts`), тримає `#1499c`.
 */
export const TRANSFER_TASK_PREFIX = "👤 Клієнт";

export interface TransferTask { text: string; deadline: string; priority: TaskPriority; details: string | null }

/** Задача обовʼязкова лише при передачі. */
export function transferTaskRequired(kind: TransferKind): boolean {
  return kind === "transfer";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 2000;

/**
 * Перевірка задачі з тіла запиту. `raw == null` — задачі немає: це помилка лише тоді, коли вона обовʼязкова.
 * `today` — київська дата (дедлайн не може бути в минулому).
 */
export function transferTaskVerdict(
  raw: unknown, kind: TransferKind, today: string,
): { ok: true; task: TransferTask | null } | { ok: false; error: string } {
  if (raw == null) {
    return transferTaskRequired(kind)
      ? { ok: false, error: "При передачі клієнта задача новому менеджеру обовʼязкова: що зробити і до якої дати" }
      : { ok: true, task: null };
  }
  if (typeof raw !== "object") return { ok: false, error: "Задача: очікується обʼєкт" };
  const r = raw as Record<string, unknown>;
  const text = String(r.text ?? "").trim();
  if (!text) return { ok: false, error: "Задача: напишіть, що зробити новому менеджеру" };
  if (text.length > TEXT_MAX) return { ok: false, error: `Задача: текст довший за ${TEXT_MAX} символів` };
  const deadline = String(r.deadline ?? "").trim();
  if (!ISO_DATE.test(deadline)) return { ok: false, error: "Задача: вкажіть дедлайн" };
  // Справжня календарна дата: «2026-02-30» проходить регулярку, але впала б уже в БД — і разом із нею вся передача.
  if (new Date(`${deadline}T00:00:00Z`).toISOString().slice(0, 10) !== deadline) return { ok: false, error: "Задача: такої дати немає" };
  if (deadline < today) return { ok: false, error: "Задача: дедлайн у минулому" };
  const priority = (r.priority == null || r.priority === "" ? "medium" : String(r.priority)) as TaskPriority;
  if (!TASK_PRIORITIES.includes(priority)) return { ok: false, error: "Задача: невідомий пріоритет" };
  const detailsRaw = String(r.details ?? "").trim();
  if (detailsRaw.length > TEXT_MAX) return { ok: false, error: `Задача: «додатково» довше за ${TEXT_MAX} символів` };
  return { ok: true, task: { text, deadline, priority, details: detailsRaw || null } };
}

const TITLE_TEXT_MAX = 140;

/**
 * Що записати в `tasks`. Назва — префікс + клієнт + перший рядок тексту (до 140 знаків, щоб список Задачника
 * читався); повний текст, «додатково» і причина передачі — у коментарі, нічого не губиться.
 */
export function transferTaskRow(i: {
  task: TransferTask; clientName: string; reason: string; kind: TransferKind;
}): { title: string; comments: string; deadline: string; priority: TaskPriority } {
  const firstLine = i.task.text.split(/\r?\n/)[0].trim();
  const short = firstLine.length > TITLE_TEXT_MAX ? `${firstLine.slice(0, TITLE_TEXT_MAX - 1).trimEnd()}…` : firstLine;
  const parts = [i.task.text];
  if (i.task.details) parts.push(`Додатково: ${i.task.details}`);
  parts.push(`${i.kind === "transfer" ? "Причина передачі" : "Причина виправлення привʼязки"}: ${i.reason}`);
  return {
    title: `${TRANSFER_TASK_PREFIX} ${i.clientName}: ${short}`,
    comments: parts.join("\n\n"),
    deadline: i.task.deadline,
    priority: i.task.priority,
  };
}
