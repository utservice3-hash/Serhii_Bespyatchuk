/**
 * 🚦 СИГНАЛИ 1×1 — «що підсвітити за минулий місяць» одним ядром.
 *
 * Задача власника 07.09.2026, дослівно: «додати вкладку коротка аналітика — натискаємо,
 * і воно за попередній місяць підсвічує, які є проблеми, з ким ті проблеми, що покращити».
 * Пороги погоджені 09.09.2026: середній бал < 7 із 10, окрема відповідь ≤ 5, eNPS ≤ 6.
 *
 * 📐 ЗАМІР НА ПРОДІ ЗА СЕРПЕНЬ 2026, і саме він змінив конструкцію. Ростер — 37 людей
 * (стан `active` + є команда). З них: **22 мали** зустріч свого типу, **1 пропустив**
 * (Білоусько — раніше 1×1 були, у серпні ні), **14 не мали ЖОДНОГО разу за всю історію**.
 *
 * 🔴 ЧОМУ «НЕ ПРОВЕДЕНО» РОЗКОЛОТО НАДВОЄ. Наївний сигнал «немає зустрічі цього місяця»
 * дав би **15 людей**, і 14 із них — щомісяця, назавжди, бо процес на них не поширюється:
 * **6 тімлідів** (їхній тип Б за всю історію не проводили ЖОДНОГО разу — 0 записів) і
 * **3 фінвідділ** (жодного 1×1 будь-якого типу). Екран, який щомісяця показує ті самі
 * 14 «проблем», перестають читати за два місяці — рівно клас `#220`/`#56b` («перевірка,
 * привʼязана до наявності стану, червоніє за календарем»), тільки на екрані, а не в гейті.
 *
 * Тому під одним підписом не живуть дві різні відмови (правило 3 з CLAUDE.md — стан, що
 * стверджує причину, не може бути смітником): `missed` = був у процесі й цього місяця
 * пропустили (це проблема місяця); `never` = у процесі не був ніколи (це питання до
 * власника «чи запускаємо тип Б / чи фінвідділ у 1×1», а не пропуск тімліда).
 *
 * 🔴 ТИП ЗУСТРІЧІ ЗАЛЕЖИТЬ ВІД ЛЮДИНИ, А НЕ ВІД ЕКРАНА. Тімліду належить тип Б
 * («Керівник продажу → Тімлід»), решті — тип A («Тімлід → Менеджер»). Шукати в тімліда
 * зустріч типу A означало б рахувати пропуском те, чого ніколи й не мало бути: заміряно —
 * жоден тімлід не мав типу A у серпні, і це не дефект.
 *
 * 🔴 ЖОДНОГО `new Date()` У ЦЬОМУ ФАЙЛІ. Місяць і попередній місяць приходять рядками
 * `YYYY-MM`; `prevMonthOf` — чиста рядкова арифметика. Причина названа боргом 19 у
 * CLAUDE.md: `d.setUTCMonth(d.getUTCMonth() + 1)` перескакує місяць 31-го числа (27 днів
 * на рік), і той самий клас помилки тут зсунув би вікно порівняння мовчки.
 */
import type { OneOnOneType } from "../oneOnOne/catalog.js";

/**
 * Пороги. Усе інше рахується ВІД цих чисел, а не поруч із ними — зміна порогу має бути
 * однією правкою в одному місці, інакше екран і гейт розійдуться тихо.
 */
export const SIGNAL_THRESHOLDS = {
  /** Середній бал за місяць нижче цього — сигнал. Шкала 1×1 десятибальна. */
  avgLow: 7,
  /** Падіння середнього проти попереднього місяця на стільки балів і більше. */
  dropBy: 1,
  /** Окрема відповідь на питання ≤ цього — сигнал, навіть коли середнє високе. */
  answerLow: 5,
  /** eNPS ≤ цього — детрактор (та сама межа, що `ENPS_SCALE.passiveFrom - 1`). */
  enpsLow: 6,
  /** Скільки найслабших питань показувати у блоці «що покращити». */
  weakTop: 3,
} as const;

/** Ключі сигналів. Порядок — як на екрані: спершу пропуски, далі бали, далі задачі. */
export const SIGNAL_KEYS = [
  "missed", "never", "avgLow", "drop", "enpsLow", "answerLow", "tasksOpen",
] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

/** Підписи живуть у ядрі, а не у фронті: інакше поріг і його опис розійдуться. */
export const SIGNAL_LABEL: Record<SignalKey, string> = {
  missed:    "Зустріч пропущено цього місяця",
  never:     "1×1 не проводили жодного разу",
  avgLow:    `Середній бал нижче ${SIGNAL_THRESHOLDS.avgLow} із 10`,
  drop:      `Падіння на ${SIGNAL_THRESHOLDS.dropBy} бал і більше проти минулого місяця`,
  enpsLow:   `eNPS ${SIGNAL_THRESHOLDS.enpsLow} і нижче`,
  answerLow: `Окрема відповідь ${SIGNAL_THRESHOLDS.answerLow} і нижче`,
  tasksOpen: "Задачі з 1×1 із дедлайном у місяці не закриті",
};

/** Пояснення, що саме сигнал означає — щоб екран не потребував усного переказу. */
export const SIGNAL_NOTE: Record<SignalKey, string> = {
  missed:    "Раніше 1×1 із цією людиною проводили, цього місяця — ні.",
  never:     "Не пропуск місяця, а процес, який на людину не поширювався. Питання власнику, а не тімліду.",
  avgLow:    "Середнє по всіх оцінках зустрічей місяця.",
  drop:      "Порівняння з попереднім місяцем. Немає попередньої зустрічі — не сигнал, а «немає з чим порівняти».",
  enpsLow:   "Тип В (HR → всі). Причину показуємо дослівно, як її записали.",
  answerLow: "Середнє високе може ховати одну низьку відповідь — цей сигнал дивиться на кожну окремо.",
  tasksOpen: "Задача без дедлайну в місяць не потрапляє — їх кількість названа окремо.",
};

/** Тип, який людині НАЛЕЖИТЬ: тімліду — Б, решті — A. Дивитись інший означало б рахувати
 *  пропуском те, чого не мало бути. */
export function owedType(isTeamLead: boolean): OneOnOneType {
  return isTeamLead ? "B" : "A";
}

/**
 * Попередній місяць чистою рядковою арифметикою. Без `Date` — саме тут борг 19 із
 * CLAUDE.md зсунув би вікно на 31-му числі, і зсув був би невидимий.
 * `"2026-01"` → `"2025-12"`; `"2026-08"` → `"2026-07"`.
 */
export function prevMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error(`prevMonthOf: очікується YYYY-MM, отримано «${month}»`);
  }
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Одна низька відповідь: який qKey і який бал. Підпис питання додає роут із форми. */
export interface LowAnswer { qKey: string; label: string | null; score: number }
/** Незакрита задача з 1×1 із дедлайном усередині місяця. */
export interface OpenTask { id: number; title: string; deadline: string | null; status: string }

/**
 * Вхід на ОДНУ людину — уже зібраний роутом із бази. Ядро нічого не запитує саме:
 * так його можна прогнати фікстурою по обидва боки кожного порогу, а живих даних
 * на межах може не бути роками (у серпні під `avgLow` не потрапив НІХТО).
 */
export interface PersonInput {
  managerId: number;
  name: string;
  teamId: number | null;
  teamName: string | null;
  isTeamLead: boolean;
  /** Чи була зустріч ПОТРІБНОГО типу в цьому місяці. */
  metThisMonth: boolean;
  /** Чи була зустріч потрібного типу КОЛИ-НЕБУДЬ (визначає missed проти never). */
  metEver: boolean;
  /** Середній `overall` за місяць. `null` = оцінок немає; саме null, а не 0. */
  avgThisMonth: number | null;
  /** Середній `overall` за попередній місяць. `null` = немає з чим порівняти. */
  avgPrevMonth: number | null;
  /** eNPS (тип В) за місяць — найнижчий, якщо зустрічей кілька. */
  enpsScore: number | null;
  enpsReason: string | null;
  lowAnswers: LowAnswer[];
  openTasks: OpenTask[];
}

/** Один спрацьований сигнал на людині. `value` — число, яким його показувати (або null). */
export interface SignalHit {
  key: SignalKey;
  /** Число сигналу: бал, розмір падіння, кількість задач. `null` — сигнал без числа. */
  value: number | null;
  /** Рядок для екрана: причина eNPS, назва питання, скільки задач. */
  detail: string;
}

export interface PersonFinding {
  managerId: number;
  name: string;
  teamId: number | null;
  teamName: string | null;
  owed: OneOnOneType;
  hits: SignalHit[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Сигнали однієї людини. Порядок `hits` — як у `SIGNAL_KEYS`, щоб екран не сортував сам.
 *
 * 🔴 `missed` і `never` ВЗАЄМОВИКЛЮЧНІ за побудовою: людина або була в процесі й
 * пропустила, або не була ніколи. Дозволити обидва означало б порахувати одну людину
 * двічі в підсумку по команді.
 */
export function personSignals(p: PersonInput): PersonFinding {
  const hits: SignalHit[] = [];
  const T = SIGNAL_THRESHOLDS;

  const owed = owedType(p.isTeamLead);
  if (!p.metThisMonth) {
    hits.push(p.metEver
      ? { key: "missed", value: null, detail: `Зустріч типу ${owed} не проведена цього місяця` }
      : { key: "never", value: null, detail: `Зустріч типу ${owed} не проводили жодного разу` });
  }

  if (p.avgThisMonth !== null && p.avgThisMonth < T.avgLow) {
    hits.push({ key: "avgLow", value: round1(p.avgThisMonth), detail: `Середній бал ${round1(p.avgThisMonth)} із 10` });
  }

  // Падіння рахуємо ЛИШЕ коли є обидва місяці. Немає попереднього — це «немає з чим
  // порівняти», і воно НЕ сигнал: інакше кожна перша зустріч людини світилась би падінням.
  if (p.avgThisMonth !== null && p.avgPrevMonth !== null) {
    const drop = round1(p.avgPrevMonth - p.avgThisMonth);
    if (drop >= T.dropBy) {
      hits.push({ key: "drop", value: drop, detail: `Було ${round1(p.avgPrevMonth)} → стало ${round1(p.avgThisMonth)}` });
    }
  }

  if (p.enpsScore !== null && p.enpsScore <= T.enpsLow) {
    hits.push({ key: "enpsLow", value: p.enpsScore,
      detail: p.enpsReason?.trim() ? `eNPS ${p.enpsScore}: ${p.enpsReason.trim()}` : `eNPS ${p.enpsScore}, причину не записали` });
  }

  const low = p.lowAnswers.filter((a) => a.score <= T.answerLow);
  if (low.length) {
    const worst = low.reduce((a, b) => (b.score < a.score ? b : a));
    hits.push({ key: "answerLow", value: worst.score,
      detail: low.length === 1
        ? `${worst.label ?? worst.qKey} — ${worst.score}`
        : `${worst.label ?? worst.qKey} — ${worst.score} (і ще ${low.length - 1})` });
  }

  const open = p.openTasks.filter((t) => t.status !== "done");
  if (open.length) {
    hits.push({ key: "tasksOpen", value: open.length,
      detail: open.length === 1 ? open[0].title : `${open.length} задачі: ${open.map((t) => t.title).join(" · ")}` });
  }

  return { managerId: p.managerId, name: p.name, teamId: p.teamId, teamName: p.teamName, owed, hits };
}

/**
 * Люди із сигналами. Людина без жодного сигналу зі списку ВИПАДАЄ — екран показує
 * проблеми, а не ростер. Порядок: спершу ті, у кого сигналів більше.
 */
export function findingsOf(people: PersonInput[]): PersonFinding[] {
  return people.map(personSignals).filter((f) => f.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length || a.name.localeCompare(b.name, "uk"));
}

/** Скільки людей під кожним сигналом. Нуль лишається в мапі — його показують словами. */
export function countBySignal(findings: PersonFinding[]): Record<SignalKey, number> {
  const out = Object.fromEntries(SIGNAL_KEYS.map((k) => [k, 0])) as Record<SignalKey, number>;
  for (const f of findings) for (const h of f.hits) out[h.key] += 1;
  return out;
}

export interface TeamRollUp {
  teamId: number | null;
  teamName: string;
  people: number;
  bySignal: Record<SignalKey, number>;
}

/**
 * Зведення по командах — другий зріз того самого набору («що покращити» по командах).
 *
 * 🔴 ІНВАРІАНТ, ЯКИЙ СТЕРЕЖЕ ГЕЙТ: Σ по командах для кожного сигналу == Σ по людях.
 * Два агрегати над одним набором розійшлись би тихо, і кожен виглядав би правильним.
 */
export function rollUpByTeam(findings: PersonFinding[]): TeamRollUp[] {
  const by = new Map<string, TeamRollUp>();
  for (const f of findings) {
    const key = String(f.teamId ?? "none");
    if (!by.has(key)) {
      by.set(key, { teamId: f.teamId,
        // Порожня назва читається як «нічого немає» — тому підписуємо словами.
        teamName: f.teamName ?? "Поза командами",
        people: 0, bySignal: Object.fromEntries(SIGNAL_KEYS.map((k) => [k, 0])) as Record<SignalKey, number> });
    }
    const t = by.get(key)!;
    t.people += 1;
    for (const h of f.hits) t.bySignal[h.key] += 1;
  }
  return [...by.values()].sort((a, b) => b.people - a.people || a.teamName.localeCompare(b.teamName, "uk"));
}

/** Один рядок блоку «що покращити»: питання форми з найнижчим середнім по відділу. */
export interface WeakQuestion { qKey: string; label: string | null; avg: number; answers: number }

/**
 * Найслабші питання форми — БЕЗ порогу, топ-N за зростанням середнього.
 *
 * 🔴 Порогу тут немає навмисно: це відповідь на «що покращити», а не «де біда». З порогом
 * блок був би порожній у будь-який добрий місяць — і зник би саме тоді, коли його читають.
 * Питання без жодної оцінки в місяці не потрапляє: середнє по нулю відповідей — не 0, а
 * відсутність числа.
 */
export function weakestQuestions(
  rows: { qKey: string; label: string | null; avg: number; answers: number }[],
  topN: number = SIGNAL_THRESHOLDS.weakTop,
): WeakQuestion[] {
  return rows.filter((r) => r.answers > 0)
    .map((r) => ({ ...r, avg: round1(r.avg) }))
    .sort((a, b) => a.avg - b.avg || a.qKey.localeCompare(b.qKey))
    .slice(0, Math.max(0, topN));
}
