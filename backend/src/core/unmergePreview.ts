/**
 * 🔓 ПРЕВʼЮ РОЗʼЄДНАННЯ — ЩО САМЕ СТАНЕТЬСЯ, ПОКАЗАНЕ ДО ДІЇ (01.09.2026).
 *
 * Розʼєднання пише в бойові дані, тож воно зобовʼязане показати наслідки ДО, а
 * не після. Симетрично до `mergeSummary`, який уже показує сторони, суму й
 * рахунки перед обʼєднанням.
 *
 * 🔴 ЧОМУ ЧИСТА ФУНКЦІЯ, А НЕ SQL У РОУТІ. Твердження, які тут стережуть гейти
 * (`#265`-`#268`), не потребують БД — а отже перевіряються і в контейнері, і в
 * стенді, де немає `.env`. Той самий урок, що `core/cohortRule.ts`.
 *
 * 🔴 ГОЛОВНЕ ПРАВИЛО МОДУЛЯ: стан «ліміт до злиття» ЗАВЖДИ називає себе одним із
 * трьох варіантів і ніколи не мовчить. Мовчання тут коштувало б найдорожче: саме
 * незворотне перезаписування ліміту й зробило розʼєднання наближенням, а не
 * відкатом. Заміряно на проді: `set_at` канонічного рядка дорівнює моменту
 * злиття з точністю 0 с, таблиці історії лімітів у базі немає, а `min(x,0)=0`
 * не лишає з чого вивести попереднє.
 */

/** Стан знання про ліміт канонічного клієнта ДО злиття. Три варіанти, без четвертого. */
export type LimitBefore =
  /** Знімок є в реєстрі — злиття зроблено вже після `#262`. Найкращий випадок. */
  | { kind: "recorded"; days: number | null; amount: number | null; setAt: string | null }
  /**
   * Знімка немає, але Google-аркуш («Лист20») знає число. Показуємо — і НЕ
   * підставляємо: аркуш поза базою, і мовчки взяти з нього значення означало б
   * вигадати запис. Людина бачить число й ухвалює рішення сама.
   */
  | { kind: "sheet"; days: number | null }
  /** Ні знімка, ні аркуша. Стан називає СЕБЕ і несе причину, а не порожнечу. */
  | { kind: "unknown"; why: string };

export interface UnmergeSideIn {
  clientKey: string;
  name: string;
  amount: number;
  invoices: number;
  /** Власний рядок у `client_credit_limits`, якщо він є. */
  ownLimitDays: number | null;
  ownLimitAmount: number | null;
  /** Нотатки, що лежать на цьому ключі й зараз невидимі (їх читають по канонічному). */
  hiddenNotes: number;
}

export interface OwnerlessNote {
  text: string;
  dueDate: string | null;
  createdAt: string;
}

export interface UnmergeInput {
  canonicalKey: string;
  /** Канонічний ПЕРШИМ, далі псевдоніми. */
  sides: UnmergeSideIn[];
  canonicalLimitNow: { days: number | null; amount: number | null; note: string | null };
  limitBefore: LimitBefore;
  /** Нотатки, поставлені на ГРУПУ після злиття — у них немає однозначного власника. */
  ownerlessNotes: OwnerlessNote[];
}

export interface UnmergePreview {
  canonicalKey: string;
  /** На що розпадеться: юрособи з сумами й рахунками. */
  splitsInto: { clientKey: string; name: string; amount: number; invoices: number }[];
  parties: number;
  amount: number;
  invoices: number;
  /** Ліміти псевдонімів, які знову почнуть діяти — з їхніх ВЛАСНИХ рядків. */
  aliasLimitsRestored: { clientKey: string; days: number | null; amount: number | null }[];
  canonicalLimit: {
    now: { days: number | null; amount: number | null; note: string | null };
    before: LimitBefore;
    /** Що людина побачить одним рядком. Порожнім не буває НІКОЛИ. */
    warning: string;
  };
  ownerlessNotes: OwnerlessNote[];
  notesBecomingVisible: number;
  /** Дебіторка перебудовується синком, не миттєво. */
  rebuildMinutes: number;
}

/** Скільки хвилин до того, як синк перебудує дебіторку (`syncReceivables` — 15 хв). */
export const REBUILD_MINUTES = 15;

/** Примітка, якою позначається успадкований ліміт (рішення власника, варіант ①). */
export const INHERITED_LIMIT_NOTE =
  "успадковано від обʼєднання, значення до злиття втрачено — перевірити";

/**
 * Рядок попередження про ліміт канонічного. **Ніколи не порожній** — саме тому
 * він і функція, а не тернарник у розмітці: порожній рядок пройшов би непоміченим.
 */
export function limitWarning(before: LimitBefore, nowDays: number | null): string {
  const now = nowDays == null ? "не задано" : `${nowDays} дн.`;
  switch (before.kind) {
    case "recorded":
      return `Ліміт до обʼєднання збережено в реєстрі: ${before.days == null ? "не задано" : `${before.days} дн.`}`
        + ` (зараз ${now}). Після розʼєднання перевірте, чи повертати його.`;
    case "sheet":
      return `Значення до обʼєднання в базі НЕ збереглося. За Лист20 до злиття було `
        + `${before.days == null ? "не задано" : `${before.days} дн.`} (зараз ${now}) — ПЕРЕВІРТЕ. `
        + "Автоматично з аркуша нічого не підставляється.";
    case "unknown":
      return `Ліміт до обʼєднання відновити нема з чого (${before.why}). Зараз ${now} — `
        + "значення успадковане від обʼєднання, перевірте його вручну.";
  }
}

export function buildUnmergePreview(input: UnmergeInput): UnmergePreview {
  const [, ...aliases] = input.sides;
  return {
    canonicalKey: input.canonicalKey,
    splitsInto: input.sides.map((s) => ({
      clientKey: s.clientKey, name: s.name, amount: s.amount, invoices: s.invoices,
    })),
    parties: input.sides.length,
    amount: input.sides.reduce((s, x) => s + x.amount, 0),
    invoices: input.sides.reduce((s, x) => s + x.invoices, 0),
    // 🔴 З ВЛАСНИХ РЯДКІВ, не з нуля: рядки псевдонімів злиття не видаляло, і
    // це єдине джерело для них. Заміряно: `тексгруп` 10 дн. пережив злиття.
    aliasLimitsRestored: aliases
      .filter((a) => a.ownLimitDays != null || a.ownLimitAmount != null)
      .map((a) => ({ clientKey: a.clientKey, days: a.ownLimitDays, amount: a.ownLimitAmount })),
    canonicalLimit: {
      now: input.canonicalLimitNow,
      before: input.limitBefore,
      warning: limitWarning(input.limitBefore, input.canonicalLimitNow.days),
    },
    // 🔴 Нотатки НЕ переносяться — рішення власника, і воно тут видиме
    // ВІДСУТНІСТЮ поля «куди перенести». Вони лишаються на канонічному, а превʼю
    // називає їх поіменно, щоб людина знала, що саме лишається без власника.
    ownerlessNotes: input.ownerlessNotes,
    notesBecomingVisible: aliases.reduce((s, a) => s + a.hiddenNotes, 0),
    rebuildMinutes: REBUILD_MINUTES,
  };
}
