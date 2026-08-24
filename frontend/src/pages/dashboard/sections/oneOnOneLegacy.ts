import type { OneOnOneAnswers, O2OFormBody } from "../../../api";

/**
 * 🕰 АНКЕТИ, СТАРІШІ ЗА РЕЄСТР ФОРМ — ЩОБ ЇХ ЗМІСТ БУЛО ВИДНО.
 *
 * 🔴 ЩО БУЛО ЗЛАМАНО (заміряно на бойовій базі 24.08.2026, read-only). Чотири зустрічі
 * типу A від 01.07 (Антипенко, Мокляк, Семенюк, Хомік) зберігалися 15-17.07 — ДО того,
 * як 29.07 посіяли таблицю `one_on_one_forms`. `form_version` у них дорівнює 1 просто
 * тому, що це DEFAULT колонки, а не тому, що така форма існувала. Ключі їхніх
 * відповідей (`energy_score`, `growth_dir`, `action_plan`…) не збігаються з ключами
 * форми A ЖОДНОЇ версії (там `a_prod`, `a_emotion`…).
 *
 * Наслідок на екрані був такий: у «Історії» стоїть число 8.7, клік по ньому відкриває
 * анкету — і ВСІ питання порожні. Заміряно точно: **59 полів у 4 зустрічах, з них
 * видимих в інтерфейсі — 0**. Дані не втрачені, але недосяжні; при цьому число поруч
 * стверджує, що зустріч відбулась і має зміст.
 *
 * ✅ ТЕКСТИ ПИТАНЬ ВІДНОВЛЕНО, А НЕ ВИГАДАНО. Вони знайшлись у комміті `e31c0bf`
 * (08.07.2026) — тодішній набір жив хардкодом у секції, з `key`, `group`, `label` і
 * типом поля. Перенесено дослівно; жодного тексту я не переписував і не «покращував».
 *
 * ⚠️ ЦЕЙ НАБІР — ІСТОРИЧНИЙ І ЗАМОРОЖЕНИЙ. Він не «ще одна форма»: редагувати його
 * ніхто не може й не має, нових записів у ньому не зʼявиться. Живі форми лежать у БД.
 */

export type LegacyField = "score" | "text";
export interface LegacyQuestion { qKey: string; group: string; label: string; field: LegacyField }

/** Набір питань 1×1 до появи реєстру форм. Дослівно з `e31c0bf` (08.07.2026). */
export const LEGACY_QUESTIONS: LegacyQuestion[] = [
  { qKey: "prev",              group: "Огляд",              field: "text",  label: "Що з домовленостей минулої зустрічі виконано, що ні?" },
  { qKey: "result_score",      group: "Результати",         field: "score", label: "Наскільки ти задоволений своїм результатом за місяць (виконання плану)?" },
  { qKey: "result_factors",    group: "Результати",         field: "text",  label: "Що найбільше допомогло / завадило досягти цілей?" },
  { qKey: "intake_score",      group: "Результати",         field: "score", label: "Наскільки якісно ти опрацьовуєш вхідні заявки (швидкість, дотиск)?" },
  { qKey: "repeat_score",      group: "Клієнти та процеси", field: "score", label: "Наскільки добре ти утримуєш і розвиваєш постійних клієнтів?" },
  { qKey: "client_challenges", group: "Клієнти та процеси", field: "text",  label: "Які виклики в роботі з клієнтами зараз найгостріші?" },
  { qKey: "process_blockers",  group: "Клієнти та процеси", field: "text",  label: "Що в процесах / інструментах сповільнює тебе найбільше?" },
  { qKey: "energy_score",      group: "Мотивація та стан",  field: "score", label: "Оціни свій рівень енергії та залученості зараз." },
  { qKey: "motivation",        group: "Мотивація та стан",  field: "text",  label: "Що тебе зараз найбільше мотивує / демотивує?" },
  { qKey: "retention_score",   group: "Мотивація та стан",  field: "score", label: "Наскільки ймовірно, що ти працюватимеш тут через рік?" },
  { qKey: "growth_gap",        group: "Розвиток",           field: "text",  label: "Яких навичок / знань тобі бракує для наступного рівня?" },
  { qKey: "growth_dir",        group: "Розвиток",           field: "text",  label: "Куди ти хочеш рости (роль / напрям)?" },
  { qKey: "support_score",     group: "Розвиток",           field: "score", label: "Наскільки ти отримуєш підтримку й визнання в роботі?" },
  { qKey: "summary",           group: "Домовленості",       field: "text",  label: "Головні висновки зустрічі." },
  { qKey: "action_plan",       group: "Домовленості",       field: "text",  label: "План дій до наступної зустрічі (конкретні кроки)." },
  { qKey: "overall_score",     group: "Домовленості",       field: "score", label: "ЗАГАЛЬНА оцінка місяця (підсумок)." },
];

/** Група для ключа, якого немає навіть в історичному наборі. */
export const UNKNOWN_GROUP = "Поля без збереженого питання";

/** Ключі, які форма запису НЕ показує (звідси й бралася порожня анкета). */
export function unmappedKeys(answers: OneOnOneAnswers, form: O2OFormBody | null | undefined): string[] {
  const inForm = new Set((form?.sections ?? []).flatMap((s) => s.questions).map((q) => q.qKey));
  return Object.keys(answers ?? {}).filter((k) => !inForm.has(k));
}

/**
 * Чи НЕ мапиться ЖОДНА відповідь на форму запису. Саме цей випадок і дав «порожню
 * анкету з числом»: форма малює свої 14 питань як «—», а всі 15 справжніх відповідей
 * лежать поруч і не показуються ніде.
 *
 * 🔴 У цьому разі порожню форму НЕ малюємо взагалі — інакше людина спершу гортає екран
 * прочерків і лише під ним знаходить зміст. Часткову розбіжність так НЕ чіпаємо: там
 * форма показує свою частину чесно, а решта доїжджає окремим блоком.
 */
export function isFullyUnmapped(answers: OneOnOneAnswers, form: O2OFormBody | null | undefined): boolean {
  const total = Object.keys(answers ?? {}).length;
  return total > 0 && unmappedKeys(answers, form).length === total;
}

export interface LegacySection { title: string; questions: (LegacyQuestion & { known: boolean })[] }

/**
 * Секції для відповідей, яких форма не показує.
 *
 * 🔴 ПОРЯДОК — ІСТОРИЧНОГО НАБОРУ, А НЕ `Object.keys(answers)`. `jsonb` порядку не
 * зберігає, тож інакше питання щоразу шикувались би по-новому, і одна й та сама
 * зустріч виглядала б різною при кожному відкритті.
 *
 * ⚠️ Ключ, якого немає навіть в історичному наборі, НЕ ховаємо — показуємо як є, в
 * окремій групі з прямим підписом. Викинути його означало б повторити ту саму
 * поломку, яку тут і лікуємо, лише тихіше.
 */
export function legacySections(answers: OneOnOneAnswers, form: O2OFormBody | null | undefined): LegacySection[] {
  const keys = new Set(unmappedKeys(answers, form));
  if (keys.size === 0) return [];
  const out: LegacySection[] = [];
  const push = (title: string, q: LegacyQuestion & { known: boolean }) => {
    const sec = out.find((s) => s.title === title);
    if (sec) sec.questions.push(q); else out.push({ title, questions: [q] });
  };
  for (const q of LEGACY_QUESTIONS) {
    if (keys.has(q.qKey)) { push(q.group, { ...q, known: true }); keys.delete(q.qKey); }
  }
  for (const k of keys) {
    const a = (answers ?? {})[k];
    push(UNKNOWN_GROUP, { qKey: k, group: UNKNOWN_GROUP, label: k, known: false,
      field: typeof a?.score === "number" ? "score" : "text" });
  }
  return out;
}

/**
 * Середнє по показаних пікерах — щоб число в «Історії» можна було ЗВІРИТИ з тим, що
 * всередині. Правило проєкту: розкриття пояснює число, а не сперечається з ним.
 */
export function averageOfScores(answers: OneOnOneAnswers, keys: string[]): number | null {
  const vals = keys.map((k) => answers?.[k]?.score).filter((x): x is number => typeof x === "number" && x > 0);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
}

/**
 * Чи збігається середнє по показаних пікерах із числом, що стоїть у «Історії».
 *
 * 🔴 ПОРІВНЯННЯ ЧИСЛОВЕ, І ЦЕ НЕ ПРИСКІПЛИВІСТЬ. `one_on_ones.overall` — це `numeric`, а
 * `pg` без налаштованих парсерів типів віддає такі поля РЯДКОМ (парсерів у проєкті
 * немає — перевірено). Отже `8.7 === "8.7"` хибне, і підпис вічно казав би «числа
 * різні» саме там, де вони однакові. Спіймано знімком екрана, не тестом.
 */
export function sameScore(avg: number | null, stored: number | string | null | undefined): boolean {
  if (avg == null || stored == null || stored === "") return false;
  const n = Number(stored);
  return Number.isFinite(n) && Math.abs(avg - n) < 1e-9;
}
