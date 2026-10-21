/**
 * 💬 ЗВОРОТНИЙ ЗВʼЯЗОК — ФОРМА ЗВЕРНЕННЯ (рішення Романа 21.10.2026).
 *
 * Проблема, яку це лікує: звернення приходили одним вільним полем і були абстрактні
 * («звіт неправильно рахує», «зробіть зручніше»), тож кожне доводилось розпитувати.
 * Тепер звернення має ТИП, і в кожного типу свої обовʼязкові поля — серед них завжди
 * ПРИКЛАД (конкретний клієнт, угода, рахунок): на ньому відтворюють і на ньому ж
 * перевіряють виправлення.
 *
 * 🔴 ОДНА КОПІЯ ПРАВИЛА. Форму малює фронт, але опис полів бере з `GET /api/feedback`
 * (`form`), а сервер перевіряє ТИМ САМИМ описом. Дві копії «що обовʼязкове» розійшлися б:
 * фронт пропустив би, сервер відхилив — або гірше, навпаки.
 *
 * Чистий модуль без БД — його виконує гейт `#1990`.
 */

export const FEEDBACK_KINDS = ["bug", "data", "change", "idea", "question"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** Наскільки заважає. «block» — блокує роботу, «hurt» — заважає, «minor» — дрібниця. */
export const FEEDBACK_IMPACTS = ["block", "hurt", "minor"] as const;
export type FeedbackImpact = (typeof FEEDBACK_IMPACTS)[number];

/** Яке з пʼяти питань інструкції закриває поле — фронт показує по них чек-лист. */
export type FeedbackQuestion = "where" | "now" | "should" | "impact" | "example";

export interface FeedbackField {
  key: string;
  label: string;
  question: FeedbackQuestion;
  placeholder: string;
  hint?: string;
  multiline?: boolean;
  optional?: boolean;
}

export interface FeedbackKindSpec {
  kind: FeedbackKind;
  icon: string;
  title: string;
  description: string;
  /** Чи питати «наскільки заважає» (обовʼязково, якщо так). */
  askImpact: boolean;
  fields: FeedbackField[];
}

/** «Де» — однакове для всіх типів: розділ вибирається окремо, тут — що саме було відкрито. */
const WHERE: FeedbackField = {
  key: "where", label: "Що саме відкрито", question: "where",
  placeholder: "Тиждень 13–19.10, менеджер Петренко / клієнт ТОВ «Сігма»",
  hint: "період, менеджер, команда чи клієнт — те, що було на екрані",
};

export const FEEDBACK_FORM: FeedbackKindSpec[] = [
  {
    kind: "bug", icon: "🐞", title: "Не працює", description: "помилка, кнопка, не відкривається",
    askImpact: true,
    fields: [
      WHERE,
      { key: "steps", label: "Що робили", question: "now", multiline: true,
        placeholder: "1. Відкрив Дебіторку\n2. Натиснув «Запит на ліміт» у ТОВ «Сігма»" },
      { key: "expected", label: "Що очікували", question: "should", placeholder: "Відкриється вікно запиту" },
      { key: "actual", label: "Що сталося", question: "now",
        placeholder: "Нічого не відбувається / дослівний текст помилки" },
      { key: "example", label: "Приклад", question: "example",
        placeholder: "ТОВ «Сігма», 21.10 о 10:15, повторюється щоразу",
        hint: "клієнт / угода / рахунок, на якому ламається, і коли" },
    ],
  },
  {
    kind: "data", icon: "📊", title: "Неправильна цифра", description: "не збігається з Kommo / 1С / банком",
    askImpact: true,
    fields: [
      WHERE,
      { key: "actual", label: "Яка цифра зараз", question: "now", placeholder: "Гроші тижня 48 000 ₴" },
      { key: "expected", label: "Яка має бути і звідки це видно", question: "should",
        placeholder: "63 500 ₴ — за 1С" },
      { key: "example", label: "Приклади (1–3)", question: "example", multiline: true,
        placeholder: "Рахунок №1234 від 16.10, ТОВ «Агро-Лан», 15 500 ₴ — є в 1С, немає у звіті",
        hint: "номер угоди в Kommo чи рахунку 1С, сума, дата — і скрін, де видно правильне" },
    ],
  },
  {
    kind: "change", icon: "✏️", title: "Змінити / додати", description: "нове поле, колонка, фільтр",
    askImpact: false,
    fields: [
      WHERE,
      { key: "actual", label: "Як зараз", question: "now",
        placeholder: "Задача на 3 менеджерів — це 3 окремі задачі, загального прогресу не видно" },
      { key: "expected", label: "Як хочу", question: "should", placeholder: "Бачити «виконали 2 з 3» в одному рядку" },
      { key: "example", label: "Приклад ситуації", question: "example", multiline: true,
        placeholder: "Вчора ставив «оновити контакти» трьом менеджерам — 20 хв перевіряв кожного окремо",
        hint: "коли саме цього не вистачило; як має виглядати — додайте скрін, малюнок чи приклад з Excel" },
      { key: "why", label: "Навіщо і як часто", question: "impact",
        placeholder: "~5 разів на тиждень, економить ~1 год" },
    ],
  },
  {
    kind: "idea", icon: "💡", title: "Ідея", description: "як покращити роботу",
    askImpact: false,
    fields: [
      { ...WHERE, label: "Про що", placeholder: "Дебіторка / план тижня / дзвінки", hint: undefined },
      { key: "actual", label: "Що зараз не так", question: "now",
        placeholder: "Тімлід дізнається про прострочену дебіторку із запізненням" },
      { key: "expected", label: "Ідея", question: "should", multiline: true,
        placeholder: "Щоранку повідомлення в Telegram зі списком прострочених" },
      { key: "example", label: "Приклад", question: "example",
        placeholder: "Минулого тижня борг ТОВ «Сігма» помітили лише на 5-й день", hint: "реальний випадок" },
      { key: "why", label: "Що це дасть", question: "impact", placeholder: "Швидше повертаємо гроші" },
    ],
  },
  {
    kind: "question", icon: "❓", title: "Питання", description: "як щось зробити",
    askImpact: false,
    fields: [
      WHERE,
      { key: "actual", label: "Що хочете зробити", question: "now", multiline: true,
        placeholder: "Поставити план на тиждень лише на 3 дні" },
      { key: "expected", label: "Що вже пробували", question: "should",
        placeholder: "Обирав дати в календарі, але зберігається на 5" },
      { key: "example", label: "Приклад", question: "example", optional: true,
        placeholder: "Менеджер Петренко, тиждень 27–31.10" },
    ],
  },
];

export const IMPACT_LABEL: Record<FeedbackImpact, string> = {
  block: "🔴 Блокує роботу",
  hurt: "🟠 Заважає",
  minor: "⚪ Дрібниця",
};

/** Скільки символів тримає одне поле. Більше — це вже не поле, а лист. */
export const FEEDBACK_FIELD_MAX = 2000;

export function kindSpec(kind: unknown): FeedbackKindSpec | null {
  return FEEDBACK_FORM.find((s) => s.kind === kind) ?? null;
}

export interface FeedbackDraft {
  kind: FeedbackKind;
  section: string | null;
  impact: FeedbackImpact | null;
  fields: Record<string, string>;
}

/**
 * Перевірка звернення. Повертає або нормалізоване звернення, або перелік того, чого
 * не вистачає, — СЛОВАМИ з форми, щоб людина побачила, яке саме поле заповнити.
 * Поля, яких немає в описі типу, відкидаються (не зберігаємо довільний JSON із клієнта).
 */
export function validateFeedback(body: unknown): { ok: true; draft: FeedbackDraft } | { ok: false; missing: string[]; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const spec = kindSpec(b.kind);
  if (!spec) {
    return { ok: false, missing: ["Тип звернення"], error: "Оберіть, що сталося. Якщо форма виглядає по-старому — оновіть сторінку" };
  }
  const raw = (b.fields && typeof b.fields === "object" ? b.fields : {}) as Record<string, unknown>;
  const section = typeof b.section === "string" && b.section.trim() ? b.section.trim().slice(0, 60) : null;
  const missing: string[] = [];
  if (!section) missing.push("Розділ");
  const fields: Record<string, string> = {};
  for (const f of spec.fields) {
    const v = typeof raw[f.key] === "string" ? (raw[f.key] as string).trim().slice(0, FEEDBACK_FIELD_MAX) : "";
    if (v) fields[f.key] = v;
    else if (!f.optional) missing.push(f.label);
  }
  const impact = (FEEDBACK_IMPACTS as readonly string[]).includes(String(b.impact)) ? (b.impact as FeedbackImpact) : null;
  if (spec.askImpact && !impact) missing.push("Наскільки заважає");
  if (missing.length) return { ok: false, missing, error: `Не заповнено: ${missing.join(", ")}` };
  return { ok: true, draft: { kind: spec.kind, section, impact: spec.askImpact ? impact : null, fields } };
}

/**
 * Текст звернення для колонки `message` — одним блоком, у порядку форми. Колонка лишається
 * NOT NULL і читабельною для всього, що її вже читає (старі записи, пошук, АІ-асистент).
 */
export function composeMessage(d: FeedbackDraft): string {
  const spec = kindSpec(d.kind)!;
  const lines = [`${spec.icon} ${spec.title}${d.section ? ` · ${d.section}` : ""}`];
  for (const f of spec.fields) if (d.fields[f.key]) lines.push(`${f.label}: ${d.fields[f.key]}`);
  if (d.impact) lines.push(`Наскільки заважає: ${IMPACT_LABEL[d.impact]}`);
  return lines.join("\n").slice(0, 8000);
}

/** Коментар у переписці по зверненню. `role` — хто писав: автор чи той, хто розбирає. */
export interface FeedbackComment {
  at: string;
  byUserId: number;
  byName: string;
  role: "author" | "admin";
  kind: "question" | "reply" | "reject" | "reopen" | "note";
  body: string;
}

export const FEEDBACK_COMMENT_MAX = 2000;
