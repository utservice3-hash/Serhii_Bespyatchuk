/**
 * 📌 НАСТУПНИЙ КРОК ПО КЛІЄНТУ — чисті правила, нуль імпортів (ТЗ реактивації, п.1 і п.3).
 *
 * Крок = дія з датою, яку менеджер обіцяє зробити: «передзвонити 25.09», «надіслати КП».
 * Один живий крок на клієнта (upsert), історія — у таблиці, старі рядки не видаляються.
 *
 * ⚠️ «ПРОСТРОЧЕНИЙ» РАХУЄТЬСЯ ВІД КИЇВСЬКОГО «СЬОГОДНІ», а не від `now()` сервера: крок
 * «на 25.09» о 23:30 25.09 за Києвом ще не прострочений, хоч у UTC уже 26.09.
 * Крок без дати не буває простроченим — і не буває «вчасним»: стан `none`.
 */
export type StepState = "none" | "planned" | "today" | "overdue" | "done";

export function stepState(dueDate: string | null, doneAt: string | null, todayKyiv: string): StepState {
  if (doneAt) return "done";
  if (!dueDate) return "none";
  if (dueDate < todayKyiv) return "overdue";
  if (dueDate === todayKyiv) return "today";
  return "planned";
}

/** «нема номера» — стан, а не нуль: 412 клієнтів із 6 021 без жодного телефону (замір 23.09.2026). */
export type PhoneState = "has" | "none";
export const phoneState = (phonesCount: number): PhoneState => (phonesCount > 0 ? "has" : "none");

export const STEP_TEXT_MAX = 300;
export function stepVerdict(text: unknown, due: unknown): { ok: true; text: string; due: string | null } | { ok: false; error: string } {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, error: "Що саме зробити — обовʼязково" };
  if (t.length > STEP_TEXT_MAX) return { ok: false, error: `Не більше ${STEP_TEXT_MAX} символів` };
  const d = due == null || due === "" ? null : String(due);
  if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: "Дата: YYYY-MM-DD" };
  return { ok: true, text: t, due: d };
}
