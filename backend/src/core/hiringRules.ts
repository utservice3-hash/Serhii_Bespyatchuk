/**
 * 🧑‍💼 НАЙМ — ЧИСТІ ПРАВИЛА (прохід 1, 17.09.2026).
 *
 * Тут НЕМАЄ жодного імпорту з БД чи `config`: гейти мусять виконуватись у звичайному
 * `npm test`, а не лише проти прода (той самий клас, що `routeTab.ts`).
 *
 * Джерело правил — макет, який затвердив Іван (рекрутер) 16.09.2026, і рішення власника
 * 17.09.2026: Іван працює з роллю HR; «призначено» — заплановані співбесіди; «проведено» —
 * позначка «прийшов», рахується в день, коли її поставили, а не в день співбесіди.
 */

export const HIRING_STATUSES = [
  "new", "planned", "done", "noshow", "noanswer", "lead",
  "candidate", "training", "manager", "declined", "nofit", "black",
] as const;
export type HiringStatus = (typeof HIRING_STATUSES)[number];

export const STATUS_LABEL: Record<HiringStatus, string> = {
  new: "новий",
  planned: "заплановано",
  done: "проведено",
  noshow: "не прийшов",
  noanswer: "недозвон",
  lead: "співбесіда з тімлідом",
  candidate: "кандидат + команда",
  training: "на навчанні",
  manager: "менеджер",
  declined: "відмова",
  nofit: "не підходить",
  black: "чорний список",
};

export const isHiringStatus = (s: unknown): s is HiringStatus =>
  typeof s === "string" && (HIRING_STATUSES as readonly string[]).includes(s);

/** Наступні статуси — рівно ті, що в затвердженому макеті. */
export const TRANSITIONS: Record<HiringStatus, HiringStatus[]> = {
  new: ["planned", "noanswer", "declined", "nofit", "black"],
  planned: ["done", "noshow", "noanswer", "declined"],
  done: ["lead", "nofit", "declined"],
  noshow: ["planned", "declined"],
  noanswer: ["planned", "declined"],
  lead: ["candidate", "nofit"],
  candidate: ["training", "declined"],
  training: ["manager", "declined"],
  declined: ["planned"],
  nofit: ["planned", "black"],
  manager: [],
  black: [],
};

/** Тімлід працює лише з кандидатами після співбесіди з ним. */
export const LEAD_TRANSITIONS: Partial<Record<HiringStatus, HiringStatus[]>> = {
  lead: ["candidate", "nofit"],
  candidate: ["training", "declined"],
  training: ["manager", "declined"],
};

/** Перехід у ці статуси вимагає команди: до кого йде кандидат. */
export const NEEDS_TEAM: readonly HiringStatus[] = ["lead", "candidate"];

export type HiringAccess = "edit" | "lead" | "none";

/**
 * Хто що може в розділі. Вкладку `hiring` відкриває tab-гейт; ЦЕ — друга межа, всередині.
 * • edit — рекрутер (роль HR) і адмін-рівень: графік, база, звіт, будь-які переходи.
 * • lead — тімлід: лише кандидати своєї команди від етапу «з тімлідом».
 * • none — усі інші, навіть якщо адмін відкрив їм вкладку тумблером у Налаштуваннях
 *   (fail-closed: тумблер дає пункт меню, а не право бачити телефони кандидатів).
 */
export function hiringAccess(a: { roleKey: string; adminScope: boolean }): HiringAccess {
  if (a.adminScope || a.roleKey === "hr") return "edit";
  if (a.roleKey === "team_lead") return "lead";
  return "none";
}

export type TransitionVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Чи дозволений перехід.
 *
 * 🔁 СКАСОВНІСТЬ (правило власника 06.08.2026: дія в інтерфейсі мусить скасовуватись тим
 * самим інтерфейсом). Строга мапа переходів робить «чорний список» чи «менеджер» кінцевими —
 * помилковий клік без цього виправити було б нічим. Тому повернення РІВНО в статус, з якого
 * прийшла ОСТАННЯ зміна (`lastFrom`), дозволене завжди тому, хто може цю зміну зробити.
 */
export function canTransition(
  from: HiringStatus, to: HiringStatus, access: HiringAccess, lastFrom: HiringStatus | null,
): TransitionVerdict {
  if (access === "none") return { ok: false, reason: "Немає доступу до найму" };
  if (from === to) return { ok: false, reason: "Статус не змінився" };
  const map = access === "lead" ? LEAD_TRANSITIONS : TRANSITIONS;
  const leadScope = (s: HiringStatus) => ["lead", "candidate", "training", "manager", "nofit", "declined"].includes(s);
  if (lastFrom === to && (access === "edit" || (leadScope(from) && leadScope(to))))
    return { ok: true };
  if ((map[from] ?? []).includes(to)) return { ok: true };
  return {
    ok: false,
    reason: access === "lead"
      ? `Тімлід не може перевести «${STATUS_LABEL[from]}» → «${STATUS_LABEL[to]}»`
      : `Перехід «${STATUS_LABEL[from]}» → «${STATUS_LABEL[to]}» не передбачено`,
  };
}

/**
 * Телефон → ключ дублів. Лише цифри, український номер зводиться до 380XXXXXXXXX,
 * тож «066 166 97 04», «+38 (066) 166-97-04» і «380661669704» — одна людина.
 * Закордонний номер лишається своїми цифрами. Менше 9 цифр — не ключ (null).
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) d = "38" + d;
  else if (d.length === 9) d = "380" + d;
  else if (d.length === 11 && d.startsWith("80")) d = "3" + d;
  return d.length >= 9 ? d : null;
}

export const isIsoDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"))
  && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;

export const isTime = (s: unknown): s is string =>
  typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/**
 * Посилання (резюме, запис співбесіди). Лише http/https: `javascript:` у клітинці, яку
 * відкриє інша людина, — це виконання чужого коду в її сесії.
 */
export function cleanUrl(raw: unknown): string | null | undefined {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : undefined;
  } catch { return undefined; }
}

/** Рядок дня звіту, як його віддає SQL. */
export interface DailyRow {
  day: string;
  planned: number;     // співбесід, запланованих на цей день
  booked: number;      // рядків графіка, записаних цього дня (дата призначення)
  done: number;        // позначок «прийшов», поставлених цього дня
  noshow: number;      // позначок «не прийшов», поставлених цього дня
  toLead: number;      // переходів у «співбесіда з тімлідом»
  toCandidate: number; // переходів у «кандидат + команда»
  toTraining: number;  // переходів у «на навчанні»
  toManager: number;   // переходів у «менеджер»
  resumes: number;     // вручну
  coldSearch: number;  // вручну
}

export const ADDITIVE_KEYS = [
  "planned", "booked", "done", "noshow", "toLead", "toCandidate", "toTraining", "toManager", "resumes", "coldSearch",
] as const;

/**
 * Разом за період. Лічильники складаються; ЯВКА — ні: вона рахується з сум
 * (Σ прийшли ÷ Σ заплановано), бо середнє відсотків дає неправду на днях різної ваги.
 * Нульовий знаменник — `null` («нема з чого рахувати»), а не 0 %.
 */
export function dailyTotals(rows: DailyRow[]): Omit<DailyRow, "day"> & { attendancePct: number | null } {
  const t = Object.fromEntries(ADDITIVE_KEYS.map((k) => [k, rows.reduce((s, r) => s + (r[k] ?? 0), 0)])) as Omit<DailyRow, "day">;
  return { ...t, attendancePct: attendancePct(t.done, t.planned) };
}

export const attendancePct = (done: number, planned: number): number | null =>
  planned > 0 ? Math.round((done / planned) * 100) : null;

/** Межа запиту звіту: не більше 400 днів, from ≤ to. */
export function validRange(from: unknown, to: unknown): { from: string; to: string } | null {
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return null;
  const days = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000;
  return days <= 400 ? { from, to } : null;
}
