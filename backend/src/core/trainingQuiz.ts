/**
 * 📝 ТЕСТ ПІСЛЯ ТЕМИ — ЧИСТІ ПРАВИЛА (13.10.2026, Роман: «тести після кожного модуля»). Без БД, без мережі.
 *
 * Рішення, на яких це стоїть (план «Тести в навчанні», 13.10.2026):
 *  • тест — останній обовʼязковий крок теми; відкривається, коли пройдено уроки теми (це дає наявний замок);
 *  • наступна тема відкривається лише після СКЛАДЕНОГО тесту — тест зараховується тільки цією перевіркою;
 *  • прохідний поріг — відсоток правильних (80% за замовчуванням), 3 спроби, далі тімлід/HR дає ще одну;
 *  • правильний варіант кандидату не показується ніде: ні до спроби, ні після (`publicQuestion`).
 *
 * 🔴 ЧОМУ ПЕРЕВІРКА ЛИШЕ ТУТ. Бал читають екран кандидата, дошка «Найму» й відсоток курсу. Друга копія
 * правила «що зараховано» розійшлася б із першою мовчки — рівно той клас, що «чип проти лічильника».
 */

export type QuizKind = "one" | "multi" | "number";

export interface QuizQuestion {
  id: number;
  kind: QuizKind;
  text: string;
  /** Варіанти для `one` / `multi`. Індекси — ОРИГІНАЛЬНІ, перемішування їх не змінює. */
  options: string[] | null;
  /** `one` / `multi` — масив оригінальних індексів; `number` — значення й допуск. */
  correct: number[] | { value: number; tol: number };
  explanation: string | null;
  sourceTitle: string | null;
}

/** Відповідь кандидата: індекс (`one`), масив індексів (`multi`), рядок або число (`number`). */
export type QuizAnswer = number | number[] | string | null | undefined;

/** Число з тексту людини: «24 000», «24000 грн», «7,5» → число; сміття → `null`. */
export function parseNumberAnswer(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\s ]/g, "").replace(/грн\.?$/i, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * Чи правильна відповідь.
 * 🔴 «Кілька правильних» — лише ТОЧНИЙ збіг множини: часткова відповідь (2 з 3) і зайвий варіант — помилка.
 * Інакше «позначити все» давало б бал.
 */
export function gradeAnswer(q: QuizQuestion, answer: QuizAnswer): boolean {
  if (q.kind === "number") {
    const c = q.correct as { value: number; tol: number };
    const n = parseNumberAnswer(answer);
    return n != null && Math.abs(n - c.value) <= (c.tol ?? 0);
  }
  const right = q.correct as number[];
  if (q.kind === "one") return typeof answer === "number" && right.length === 1 && answer === right[0];
  if (!Array.isArray(answer)) return false;
  const got = new Set(answer);
  return got.size === answer.length && got.size === right.length && right.every((i) => got.has(i));
}

export interface QuizScore { right: number; total: number; pct: number; passed: boolean }

/**
 * Бал спроби. «Складено» — ціле порівняння `right × 100 ≥ поріг × total`, без округленого відсотка:
 * 10 з 12 = 83,3% ≥ 80 — складено; 9 з 12 = 75% — ні; 4 з 5 = 80% — складено рівно на межі.
 * Порожній тест не складається — нуль питань не доводить нічого.
 */
export function scoreAttempt(marks: readonly boolean[], passPct: number): QuizScore {
  const total = marks.length;
  const right = marks.filter(Boolean).length;
  const pct = total ? Math.round((right / total) * 100) : 0;
  return { right, total, pct, passed: total > 0 && right * 100 >= passPct * total };
}

/** Скільки спроб лишилось: ліміт + видані тімлідом/HR − використані. Не менше нуля. */
export function attemptsLeft(p: { used: number; max: number; grants: number }): number {
  return Math.max(0, p.max + p.grants - p.used);
}

export type StartVerdict = { ok: true } | { ok: false; status: number; reason: string };

/** Чи можна почати нову спробу. Склав — більше не треба; вичерпав — лише після «ще спроби». */
export function startVerdict(p: { passed: boolean; used: number; max: number; grants: number }): StartVerdict {
  if (p.passed) return { ok: false, status: 409, reason: "Тест уже складено" };
  if (attemptsLeft(p) <= 0) return { ok: false, status: 409, reason: "Спроби закінчились — попросіть тімліда дати ще одну" };
  return { ok: true };
}

/** Генератор випадкових чисел — параметром, щоб гейт перевіряв перемішування детерміновано. */
export type Rng = () => number;

function shuffled<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Що випало в спробі: які питання й у якому порядку варіантів. Зберігається в спробі — перевірка йде по ньому. */
export interface AttemptPlan { questionId: number; order: number[] | null }

/**
 * Набір питань для спроби: перемішані питання (і варіанти всередині), `size` штук або всі.
 * Нова спроба — інший порядок, тож повтор перевіряє знання, а не памʼять позицій.
 */
export function pickQuestions(pool: readonly QuizQuestion[], size: number | null, rng: Rng): AttemptPlan[] {
  const take = size && size < pool.length ? size : pool.length;
  return shuffled(pool, rng).slice(0, take).map((q) => ({
    questionId: q.id,
    order: q.options ? shuffled(q.options.map((_, i) => i), rng) : null,
  }));
}

/** Питання для кандидата: БЕЗ правильної відповіді й пояснення; варіанти — у порядку спроби, з оригінальним індексом. */
export interface PublicQuestion { id: number; kind: QuizKind; text: string; options: { i: number; text: string }[] | null }

export function publicQuestion(q: QuizQuestion, order: number[] | null): PublicQuestion {
  const opts = q.options ? (order ?? q.options.map((_, i) => i)).map((i) => ({ i, text: q.options![i] })) : null;
  return { id: q.id, kind: q.kind, text: q.text, options: opts };
}

/** Результат по питанню для екрана після спроби: пояснення й урок — ЛИШЕ для помилок; правильного варіанта немає. */
export interface QuestionResult { id: number; text: string; ok: boolean; explanation: string | null; source: string | null }

export function gradePlan(plan: readonly AttemptPlan[], byId: ReadonlyMap<number, QuizQuestion>,
  answers: Readonly<Record<string, QuizAnswer>>): { marks: boolean[]; results: QuestionResult[] } {
  const marks: boolean[] = [];
  const results: QuestionResult[] = [];
  for (const p of plan) {
    const q = byId.get(p.questionId);
    const ok = q ? gradeAnswer(q, answers[String(p.questionId)]) : false;
    marks.push(ok);
    results.push({ id: p.questionId, text: q?.text ?? "", ok,
      explanation: ok ? null : q?.explanation ?? null, source: ok ? null : q?.sourceTitle ?? null });
  }
  return { marks, results };
}
