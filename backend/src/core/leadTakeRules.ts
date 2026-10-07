/**
 * ⏱ «ЧАС ОПРАЦЮВАННЯ ЗАЯВКИ» — ПРАВИЛА ВІКНА (ТЗ Юлії Роману 24.09.2026, копія Сергію).
 *
 * Модуль ЧИСТИЙ — жодного імпорту: його читають і ядро (`core/leadTake.ts`), і гейти без БД.
 *
 * ЩО ТАКЕ «ВЗЯТО В РОБОТУ» (ТЗ, дослівно за змістом): час від створення заявки до ПЕРШОЇ з подій —
 *   1. зміна етапу угоди (перехід у закриття — 142/143 — не рахується);
 *   2. перший вихідний дзвінок по угоді в Ringostat;
 *   3. заповнене поле «Взято в работу» в Kommo.
 * Жодної події — «не взято», навіть якщо угоду закрили за 2 хв: саме так ховаються «Дублі» без дзвінка.
 *
 * НОРМАТИВ (ТЗ): «до 1 хв» ≥ 90%, «до 5 хв» = 100%, «не взято» = 0. Гірше — клітинка червона.
 *
 * 🔴 РОБОЧИЙ ЧАС ТУТ 08:00–18:00 (ТЗ), А НЕ 09:00–18:00 ІНШИХ ЕКРАНІВ (`core/dayBuckets.ts`). Це свідомо
 * друге означення: так написано в ТЗ цього вікна. Константи названі окремо, щоб не сплутати.
 * Свята не враховуються (той самий борг календаря №2 у CLAUDE.md) — робочі дні = Пн–Пт.
 *
 * 🔴 НЕРОБОЧИЙ ЧАС (тлумачення ТЗ «заявку з неробочого часу беремо в перші 15 хв робочого дня»): строк такої
 * заявки — 08:15 найближчого робочого дня. Годинник для неї стартує о 08:15: взяли до 08:15 (або ще вночі) —
 * 0 хв, тобто «до 1 хв»; о 08:20 — 5 хв. Інакше заявка, прийнята рівно в нормі, читалась би як «понад годину».
 */

export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 18;
export const OFFHOURS_GRACE_MIN = 15;

/** Норматив ТЗ — і для підсвічування, і для рядка «Норматив» під таблицею. */
export const NORM = { m1Pct: 90, m5Pct: 100, notTaken: 0 } as const;

export type TakeEvent = "stage" | "call" | "field";
export const TAKE_EVENT_LABEL: Record<TakeEvent, string> = {
  stage: "зміна етапу",
  call: "вихідний дзвінок",
  field: "поле «Взято в работу»",
};

/** Кошики часу взяття. `m1`/`m5` на екрані кумулятивні («до 5 хв» включає «до 1 хв») — так вимагає норматив 100%. */
export type TakeBucket = "m1" | "m5" | "m30" | "m60" | "h1" | "none";

export interface DealTakeInput {
  createdAt: number;              // ms
  stageAt: number | null;         // перша зміна етапу (не в закриття), ms
  callAt: number | null;          // перший вихідний дзвінок, ms
  fieldAt: number | null;         // поле «Взято в работу», ms
  /** Закрита з причиною «Дубль» — зміна етапу для неї НЕ «взято» (див. `isDuplicateLost`). */
  duplicate?: boolean;
}

/**
 * 🔁 «ДУБЛЬ» — ЛИШЕ ДЗВІНОК АБО ПОЛЕ (рішення Юлі/Романа 07.10.2026, варіант «Б»). Замір 01–23.09, реклама: у 19 з 84
 * «Дублів» етап змінювався через 10–15 с після створення — швидше, ніж людина встигає щось зробити (схоже, автоматика
 * Kommo), і вікно ставило їх у «до 1 хв», хоча менеджер міг так і не подзвонити. Хто зрушив етап, Kommo не передає,
 * тож для «Дубля» рахуємо лише вихідний дзвінок або поле «Взято в работу». Правило — ЛИШЕ для «Дубля»: у решти угод
 * зміна етапу лишається «взято», як у ТЗ.
 */
export const DUPLICATE_REASON = "Дубль";
export const isDuplicateLost = (statusId: string | number, rejectReason: string | null | undefined): boolean =>
  String(statusId) === "143" && (rejectReason ?? "").trim() === DUPLICATE_REASON;
export interface DealTake {
  takenAt: number | null;
  event: TakeEvent | null;
  /** Хвилини до взяття від старту годинника; `null` — не взято. */
  minutes: number | null;
  bucket: TakeBucket;
  offHours: boolean;
}

/** Київські складові моменту (день тижня 0=Нд, година, хвилина, дата). */
function kyivParts(ms: number): { y: number; mo: number; d: number; dow: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), dow, h: Number(p.hour) % 24, mi: Number(p.minute) };
}

/** Мить «год:хв за Києвом» у вказану київську дату (з урахуванням переходу на літній час). */
export function kyivAt(y: number, mo: number, d: number, h: number, mi: number): number {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = kyivParts(guess);
    const shownAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, mo - 1, d, h, mi) - shownAsUtc;
  }
  return guess;
}

export const isWorkTime = (ms: number): boolean => {
  const p = kyivParts(ms);
  return p.dow >= 1 && p.dow <= 5 && p.h >= WORK_START_HOUR && p.h < WORK_END_HOUR;
};

/** Старт годинника: робочий час — момент створення; неробочий — 08:15 найближчого робочого дня. */
export function clockStart(createdAt: number): number {
  if (isWorkTime(createdAt)) return createdAt;
  const p = kyivParts(createdAt);
  let day = Date.UTC(p.y, p.mo - 1, p.d);
  let dow = p.dow;
  // Після кінця дня (або вихідний) — наступна дата; до 08:00 у будень — цього ж дня.
  if (!(dow >= 1 && dow <= 5 && p.h < WORK_START_HOUR)) { day += 86_400_000; dow = (dow + 1) % 7; }
  while (dow === 0 || dow === 6) { day += 86_400_000; dow = (dow + 1) % 7; }
  const d = new Date(day);
  return kyivAt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), WORK_START_HOUR, OFFHOURS_GRACE_MIN);
}

export function bucketOf(minutes: number | null): TakeBucket {
  if (minutes == null) return "none";
  if (minutes <= 1) return "m1";
  if (minutes <= 5) return "m5";
  if (minutes <= 30) return "m30";
  if (minutes <= 60) return "m60";
  return "h1";
}

/** Перша з трьох подій (не раніше створення) і час до неї. */
export function takeOf(x: DealTakeInput): DealTake {
  const cands: [TakeEvent, number | null][] = [["stage", x.duplicate ? null : x.stageAt], ["call", x.callAt], ["field", x.fieldAt]];
  let best: [TakeEvent, number] | null = null;
  for (const [ev, at] of cands) {
    if (at == null || at < x.createdAt) continue;
    if (!best || at < best[1]) best = [ev, at];
  }
  const offHours = !isWorkTime(x.createdAt);
  if (!best) return { takenAt: null, event: null, minutes: null, bucket: "none", offHours };
  const minutes = Math.max(0, best[1] - clockStart(x.createdAt)) / 60_000;
  return { takenAt: best[1], event: best[0], minutes, bucket: bucketOf(minutes), offHours };
}

export interface TakeRowInput { take: DealTake; lost: boolean }
export interface TakeStats {
  n: number;
  /** Кумулятивні частки, %: до 1 хв; до 5 хв. */
  m1Pct: number | null; m5Pct: number | null;
  /** Розподіл, %: 5–30, 30–60, понад годину. */
  m30Pct: number | null; m60Pct: number | null; h1Pct: number | null;
  notTaken: number;
  medianMin: number | null;
  /** Взяли пізніше 5 хв або не взяли — і закрились у «Не реалізовано» (143). */
  slowLost: number;
  /** slowLost × середній чек; `null` — середнього чека немає (успішних рекламних угод у періоді не було). */
  loss: number | null;
  red: { m1: boolean; m5: boolean; notTaken: boolean };
}

const pct = (k: number, n: number): number | null => (n > 0 ? Math.round((k / n) * 1000) / 10 : null);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function statsOf(rows: TakeRowInput[], avgCheck: number | null): TakeStats {
  const n = rows.length;
  const cnt = (b: TakeBucket) => rows.filter((r) => r.take.bucket === b).length;
  const m1 = cnt("m1"), m5 = m1 + cnt("m5");
  const notTaken = cnt("none");
  const slowLost = rows.filter((r) => r.lost && (r.take.bucket === "none" || (r.take.minutes ?? 0) > 5)).length;
  const med = median(rows.flatMap((r) => (r.take.minutes == null ? [] : [r.take.minutes])));
  const m1Pct = pct(m1, n), m5Pct = pct(m5, n);
  return {
    n, m1Pct, m5Pct,
    m30Pct: pct(cnt("m30"), n), m60Pct: pct(cnt("m60"), n), h1Pct: pct(cnt("h1"), n),
    notTaken,
    medianMin: med == null ? null : Math.round(med * 10) / 10,
    slowLost,
    loss: avgCheck == null ? null : Math.round(slowLost * avgCheck),
    red: {
      m1: m1Pct != null && m1Pct < NORM.m1Pct,
      m5: m5Pct != null && m5Pct < NORM.m5Pct,
      notTaken: notTaken > NORM.notTaken,
    },
  };
}

/** Колонки, по яких клікають у список угод — та сама класифікація, що в `statsOf`. */
export type TakeColumn = "all" | "m1" | "m5" | "m30" | "m60" | "h1" | "none" | "slowLost";
export function inColumn(col: TakeColumn, r: TakeRowInput): boolean {
  switch (col) {
    case "all": return true;
    case "m1": return r.take.bucket === "m1";
    case "m5": return r.take.bucket === "m1" || r.take.bucket === "m5";
    case "slowLost": return r.lost && (r.take.bucket === "none" || (r.take.minutes ?? 0) > 5);
    default: return r.take.bucket === col;
  }
}

/** Пн–Нд тижня, що містить київську дату `ymd`; `offset` −1 — минулий тиждень. */
export function weekRange(ymd: string, offset = 0): { from: string; to: string } {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow - 1) + offset * 7);
  const end = new Date(d); end.setUTCDate(end.getUTCDate() + 6);
  return { from: d.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
