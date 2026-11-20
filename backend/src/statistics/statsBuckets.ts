/**
 * 🧮 ЧИСТІ ПРАВИЛА ЕКРАНА «СТАТИСТИКИ» (стіна, 20.11.2026): кошики періоду, головна серія глядача і межа доступу
 * до відділів, чиї числа живуть на закритих екранах. Без БД — тож кожне правило виконується в гейті, а не читається.
 */

export type Gran = "day" | "week" | "month";

/** Понеділок тижня (UTC-арифметика над київською датою, як `date_trunc('week')`). */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const w = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (w === 0 ? 6 : w - 1));
  return d.toISOString().slice(0, 10);
}

/** Кошик київського дня: день — сам день, тиждень — понеділок, місяць — 1-ше число. */
export function bucketOfDay(day: string, g: Gran): string {
  if (g === "month") return `${day.slice(0, 7)}-01`;
  if (g === "week") return mondayOf(day);
  return day;
}

/** Поденні суми ядра → кошики. Порожній кошик не народжується: «не було» ≠ «нуль». */
export function sumIntoBuckets<T extends { day: string }>(rows: readonly T[], g: Gran, pick: (r: T) => number): { bucket: string; value: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) { const b = bucketOfDay(r.day, g); m.set(b, (m.get(b) ?? 0) + pick(r)); }
  return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([bucket, value]) => ({ bucket, value }));
}

/** Початки місяців / тижнів, що ЦІЛКОМ або частково лежать у [from, to] і починаються не раніше `from`. */
export function periodStarts(g: "week" | "month", from: string, to: string): string[] {
  const out: string[] = [];
  let cur = g === "month" ? `${from.slice(0, 7)}-01` : mondayOf(from);
  if (cur < from) cur = g === "month" ? nextMonth(cur) : addDays(cur, 7);
  while (cur <= to && out.length < 400) { out.push(cur); cur = g === "month" ? nextMonth(cur) : addDays(cur, 7); }
  return out;
}
function addDays(day: string, n: number): string { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nextMonth(first: string): string { const d = new Date(`${first}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); }

/**
 * 🎯 ГОЛОВНА СЕРІЯ ГЛЯДАЧА — для карток стіни (`/series?scope=main`). З набору, який уже обрізав серверний клам ролі,
 * береться перша серія, що НЕ є бенчмарком: адмін — компанія, тімлід — своя команда (компанія йому лише бенчмарк),
 * менеджер — він сам. Нового скоупу функція не створює: вона лише ЗВУЖУЄ вже дозволене.
 */
export function mainSpec<T extends { benchmark?: boolean }>(set: readonly T[]): T[] {
  const main = set.find((s) => !s.benchmark) ?? set[0];
  return main ? [main] : [];
}

/**
 * 🔒 ВІДДІЛИ, ЧИЇ ЧИСЛА ЖИВУТЬ НА ЗАКРИТИХ ЕКРАНАХ. «Фінанси» беруть рядки екрана «Фінанси → Тиждень і місяць»
 * (банк, дебіторка) — та сама межа, що в нього: вкладка `finance`. «HR» бере плинність із реєстру людей — межа
 * `view_employee_secrets`, як у `/secrets/churn`. Статистики не стають обхідним входом до цих чисел.
 * Повертає текст відмови або `null`, якщо можна.
 */
export function blockDenied(block: string, can: { tab: (t: string) => boolean; perm: (p: string) => boolean }): string | null {
  if (block === "finance" && !can.tab("finance")) return "числа «Фінансів» бачать ті, кому відкрито розділ «Фінанси»";
  if (block === "hr" && !can.perm("view_employee_secrets")) return "числа HR бачать ті, кому відкрито реєстр людей";
  return null;
}
