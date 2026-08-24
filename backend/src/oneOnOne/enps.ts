/**
 * 📊 eNPS — ЄДИНЕ ДЖЕРЕЛО ШКАЛИ, СМУГ І БАКЕТІВ.
 *
 * 🔴 ПРИВІД. Пороги «9-10 / 7-8 / 0-6» жили в ЧОТИРЬОХ місцях: `BETWEEN` у SQL роута,
 * `enpsColor` на фронті, підпис під пікером і мертвий `ENPS` у `catalog.ts`, який не
 * імпортувався НІКУДИ (тобто вже нічого не стеріг). Чотири копії одного правила
 * розходяться не «якщо», а «коли» — і розійдуться тихо, бо кожне число окремо
 * виглядатиме правильним.
 *
 * ✅ ТОМУ КЛАСИФІКАЦІЯ ПІШЛА З SQL. Запит тепер віддає ГІСТОГРАМУ (день × бал ×
 * кількість) і не знає про промоутерів узагалі; хто промоутер, які відсотки, яка
 * смуга й на які бакети різати період — вирішує цей модуль. Правило, яке не можна
 * дописати в одному місці й забути в другому, бо місце одне.
 *
 * ⚠️ ФРОНТ має власну копію ДВОХ чисел (`promoterFrom`/`passiveFrom`) — інакше він не
 * розфарбує окремий бал у пікері, а тягти по HTTP колір однієї кнопки безглуздо. Це
 * єдина копія, вона одна на весь фронт, і її звіряє гейт `#143c`: розійтись мовчки
 * вони не можуть.
 */

/** Шкала eNPS. Усе інше в модулі рахується ВІД цих трьох чисел, а не поруч із ними. */
export const ENPS_SCALE = { min: 0, max: 10, promoterFrom: 9, passiveFrom: 7 } as const;

export type EnpsClass = "promoter" | "passive" | "detractor" | "invalid";

/**
 * Клас одного бала. `invalid` — НЕ синонім «нема оцінки»: це бал ПОЗА шкалою
 * (рішення власника 24.08.2026). Раніше такий бал мовчки ставав нейтралом і ЗАНИЖУВАВ
 * eNPS: у знаменник входив, у чисельник — ні. Тепер він зі знаменника виключений і
 * названий числом на екрані.
 */
export function classifyEnps(score: number | null | undefined): EnpsClass {
  if (typeof score !== "number" || !Number.isInteger(score)) return "invalid";
  if (score < ENPS_SCALE.min || score > ENPS_SCALE.max) return "invalid";
  if (score >= ENPS_SCALE.promoterFrom) return "promoter";
  if (score >= ENPS_SCALE.passiveFrom) return "passive";
  return "detractor";
}

export type EnpsTone = "green" | "amber" | "orange" | "red";
export interface EnpsBand { key: string; label: string; tone: EnpsTone; from: number; to: number }

/**
 * Смуги оцінки (специфікація власника 24.08.2026). Межі ВКЛЮЧНІ з обох боків і
 * покривають увесь можливий діапазон −100..100 без дірок і перетинів — це стереже
 * `#143`. Дірка тут означала б «бейджа немає» рівно для тих значень, які ніхто не
 * перевіряв руками.
 */
export const ENPS_BANDS: EnpsBand[] = [
  { key: "excellent", label: "Відмінно",    tone: "green",  from:   50, to:  100 },
  { key: "good",      label: "Добре",       tone: "green",  from:   30, to:   49 },
  { key: "ok",        label: "Нормально",   tone: "amber",  from:   10, to:   29 },
  { key: "attention", label: "Зона уваги",  tone: "orange", from:    0, to:    9 },
  { key: "bad",       label: "Погано",      tone: "orange", from:  -29, to:   -1 },
  { key: "critical",  label: "Критично",    tone: "red",    from: -100, to:  -30 },
];

export function bandFor(enps: number): EnpsBand {
  const b = ENPS_BANDS.find((x) => enps >= x.from && enps <= x.to);
  if (!b) throw new Error(`eNPS ${enps} не потрапив у жодну смугу — реєстр смуг має дірку`);
  return b;
}

export interface EnpsHistogramRow { score: number; count: number }

export interface EnpsSummary {
  /** Скільки оцінок увійшло в розрахунок (бали ПОЗА шкалою сюди НЕ входять). */
  total: number;
  promoters: number; passives: number; detractors: number;
  /** Бали поза 0..10 — у знаменник не входять, але мусять бути названі на екрані. */
  invalid: number;
  promotersPct: number; passivesPct: number; detractorsPct: number;
  /** null = оцінок немає. Саме null, а не 0: «0» читається як результат. */
  enps: number | null;
  band: EnpsBand | null;
}

/**
 * Відсотки, що в сумі дають РІВНО 100 (метод найбільшого залишку).
 *
 * 🔴 НЕ ПРИКРАСА. Три частки на екрані показані поруч; наївне округлення кожної дає
 * 99% або 101%, і людина бачить арифметичну помилку там, де її немає. Найбільший
 * залишок роздає розбіжність тим часткам, у яких дробова частина найбільша.
 */
function pctShares(parts: number[], total: number): number[] {
  if (total <= 0) return parts.map(() => 0);
  const exact = parts.map((p) => (p / total) * 100);
  const floors = exact.map(Math.floor);
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (const { i } of order) { if (rest <= 0) break; out[i] += 1; rest -= 1; }
  return out;
}

/**
 * Зведення по гістограмі балів.
 *
 * 🔴 САМ eNPS РАХУЄТЬСЯ З СИРИХ ЛІЧИЛЬНИКІВ, А НЕ З ОКРУГЛЕНИХ ВІДСОТКІВ. Різниця
 * двох округлень дає похибку до 1 пункту — і саме на межі смуги («+49» проти «+50»)
 * вона перетворює «Добре» на «Відмінно». Тримає `#143b`.
 */
export function summarizeEnps(rows: EnpsHistogramRow[]): EnpsSummary {
  let promoters = 0, passives = 0, detractors = 0, invalid = 0;
  for (const r of rows) {
    const n = Number(r.count) || 0;
    switch (classifyEnps(r.score)) {
      case "promoter":  promoters += n; break;
      case "passive":   passives += n; break;
      case "detractor": detractors += n; break;
      default:          invalid += n;
    }
  }
  const total = promoters + passives + detractors;
  const [promotersPct, passivesPct, detractorsPct] = pctShares([promoters, passives, detractors], total);
  const enps = total > 0 ? Math.round(((promoters - detractors) / total) * 100) : null;
  return { total, promoters, passives, detractors, invalid,
    promotersPct, passivesPct, detractorsPct, enps, band: enps === null ? null : bandFor(enps) };
}

// ── Період і грануляція ──────────────────────────────────────────────────────

export type Granularity = "day" | "week" | "month";

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Дата з YYYY-MM-DD як UTC-полудень — щоб арифметика днів не з'їжджала на переходах. */
const at = (s: string) => new Date(`${s}T12:00:00Z`);

/** Скільки днів у періоді, обидва кінці ВКЛЮЧНО (1 день = 1, а не 0). */
export function spanDays(from: string, to: string): number {
  return Math.round((at(to).getTime() - at(from).getTime()) / DAY_MS) + 1;
}

/**
 * Грануляція тренду за довжиною періоду. Рішення власника: авто.
 * ≤31 дня — по днях · ≤120 днів — по тижнях · далі — по місяцях.
 * 🔴 Помісячний тренд на періоді в 10 днів — це один стовпчик замість тренду; саме
 * тому фіксована грануляція й не годиться, коли період став довільним.
 */
export function granularityFor(from: string, to: string): Granularity {
  const d = spanDays(from, to);
  if (d <= 31) return "day";
  if (d <= 120) return "week";
  return "month";
}

/** Початок бакета, у який потрапляє день. Тиждень — з ПОНЕДІЛКА (українська конвенція). */
export function bucketOf(day: string, gran: Granularity): string {
  if (gran === "day") return day;
  const d = at(day);
  if (gran === "month") return `${day.slice(0, 7)}-01`;
  const shift = (d.getUTCDay() + 6) % 7;          // Пн=0 … Нд=6
  d.setUTCDate(d.getUTCDate() - shift);
  return iso(d);
}

export interface EnpsDayRow { day: string; score: number; count: number }
export interface EnpsSeriesPoint extends EnpsSummary { bucket: string }

/** Тренд: гістограма днів → бакети обраної грануляції, кожен зведений тим самим правилом. */
export function buildEnpsSeries(rows: EnpsDayRow[], gran: Granularity): EnpsSeriesPoint[] {
  const byBucket = new Map<string, EnpsHistogramRow[]>();
  for (const r of rows) {
    const k = bucketOf(r.day, gran);
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k)!.push({ score: r.score, count: r.count });
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, hist]) => ({ bucket, ...summarizeEnps(hist) }));
}

export interface EnpsRange { from: string; to: string }

const isDay = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Скільки днів показуємо, коли період не задали взагалі. */
export const ENPS_DEFAULT_DAYS = 90;

/**
 * Період запиту. Обидва кінці ВКЛЮЧНІ (правило проєкту: дати завжди по-київськи і
 * обидва кінці разом — `col <= to` вже одного разу зрізав останній день місяця).
 *
 * `months` лишається ЗАРАДИ СУМІСНОСТІ: у момент викату в браузерах людей ще крутиться
 * старий бандл, який шле саме його. Прибрати — окремим проходом, коли всі оновлять
 * вкладку.
 *
 * `todayKyiv` приходить аргументом, а не береться з `new Date()` всередині: інакше
 * функцію неможливо перевірити, а «сьогодні» в тесті залежало б від дня прогону.
 */
export function parseEnpsRange(
  q: { from?: unknown; to?: unknown; months?: unknown },
  todayKyiv: string
): EnpsRange | { error: string } {
  if (q.from !== undefined || q.to !== undefined) {
    if (!isDay(q.from) || !isDay(q.to)) return { error: "from і to — обидва у форматі YYYY-MM-DD" };
    if (q.from > q.to) return { error: "from не може бути пізніше за to" };
    return { from: q.from, to: q.to };
  }
  const months = Number(q.months);
  if (Number.isFinite(months) && months >= 1) {
    const m = Math.min(24, Math.floor(months));
    const d = at(todayKyiv);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - (m - 1));
    return { from: iso(d), to: todayKyiv };
  }
  const d = at(todayKyiv);
  d.setUTCDate(d.getUTCDate() - (ENPS_DEFAULT_DAYS - 1));
  return { from: iso(d), to: todayKyiv };
}
