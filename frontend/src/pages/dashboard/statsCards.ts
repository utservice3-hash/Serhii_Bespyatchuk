/**
 * 🧱 ЦИФРИ КАРТКИ СТІНИ «СТАТИСТИК» (погоджений макет «стіна графіків», зустріч 20.11.2026; Роман 20.11: «картки з
 * цифрами — так», ТЗ 14.10 «лише графіки» скасовано).
 *
 * Правило живе ФУНКЦІЄЮ, а не виразом у JSX, бо його виконує гейт (той самий прийом, що `statsGran.ts`, `statsMulti.ts`):
 *   • головне число — ОСТАННІЙ ПОВНИЙ період (місяць / тиждень), порівняння — з ПОПЕРЕДНІМ ПОВНИМ;
 *   • період, що йде, — ОКРЕМИМ рядком «станом на», і в порівняння він НЕ потрапляє ніколи: «половина листопада проти
 *     цілого жовтня» читалась би як обвал (той самий клас, що #877: неповний тиждень проти «4 тижні тому»);
 *   • немає точки за останній повний період — це «після <періоду> даних немає», а не нуль і не порожнеча.
 */

export type CardGran = "week" | "month";
export interface Pt { period: string; value: number }
export interface CardFigures {
  /** Останній ПОВНИЙ період, за який є точка, або `null`, якщо повних точок немає. */
  last: Pt | null;
  /** Попередній повний період ВІДНОСНО `last` (саме сусідній, не «будь-яка попередня точка»). */
  prev: Pt | null;
  /** Зміна `last` до `prev`, % (`null` — нема з чим порівняти або попереднє = 0). */
  deltaPct: number | null;
  /** Період, що йде: точка «станом на сьогодні» (`null`, якщо в ньому ще нічого не було). */
  current: Pt | null;
  /** Початок періоду, що йде (щоб підписати «листопад іде» навіть без точки). */
  currentStart: string;
  /** Останній повний період без точки: ряд обривається раніше — це треба сказати словами. */
  missingSince: string | null;
}

const d2s = (d: Date) => d.toISOString().slice(0, 10);
const s2d = (s: string) => new Date(`${s}T00:00:00Z`);

/** Початок періоду дня: місяць — 1-ше число, тиждень — понеділок (як `date_trunc` на сервері). */
export function periodStartOf(day: string, g: CardGran): string {
  if (g === "month") return `${day.slice(0, 7)}-01`;
  const d = s2d(day); const w = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (w === 0 ? 6 : w - 1));
  return d2s(d);
}
/** Попередній період (зсув на один місяць / тиждень від початку періоду). */
export function prevPeriod(start: string, g: CardGran): string {
  const d = s2d(start);
  if (g === "month") { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); } else d.setUTCDate(d.getUTCDate() - 7);
  return d2s(d);
}

export function cardFigures(points: readonly Pt[], g: CardGran, today: string): CardFigures {
  const currentStart = periodStartOf(today, g);
  const at = new Map(points.map((p) => [p.period, p]));
  const closed = points.filter((p) => p.period < currentStart).sort((a, b) => a.period.localeCompare(b.period));
  const last = closed.length ? closed[closed.length - 1] : null;
  const lastFull = prevPeriod(currentStart, g);
  const prev = last ? at.get(prevPeriod(last.period, g)) ?? null : null;
  const deltaPct = last && prev && prev.value !== 0 ? Math.round(((last.value - prev.value) / Math.abs(prev.value)) * 1000) / 10 : null;
  return {
    last, prev, deltaPct,
    current: at.get(currentStart) ?? null,
    currentStart,
    missingSince: last && last.period < lastFull ? last.period : null,
  };
}

/**
 * 🔺 ЯК КАРТКА КАЖЕ «ЗМІНИЛОСЬ» (заміри 20.11.2026 на проді, після викату стіни).
 *  • Показник САМ у відсотках (`unit === "%"`, напр. «Частка до 5 хв», «Плинність») — різниця у ВІДСОТКОВИХ ПУНКТАХ:
 *    30% → 68% — це «▲ 38 п.п.», а не «▲ 126,7%». Відсоток від відсотка на проді читався як «частка виросла вдвічі з
 *    гаком», хоча вона виросла на 38 пунктів.
 *  • Решта — відносна зміна, % (як `deltaPct`); попереднє = 0 — порівнювати нема з чим.
 *  • Колір — НАПРЯМОК, а не знак: для «менше — краще» (медіана хвилин, звільнені, плинність) падіння зелене; для
 *    нейтральних (витрати, дебіторка) — сірий, бо «більше» там саме по собі не добре й не погане.
 */
export type Better = "up" | "down" | "neutral";
export interface CardDelta { dir: "up" | "down" | "same"; text: string; tone: "good" | "bad" | "neutral" }
export function cardDelta(last: Pt | null, prev: Pt | null, unit: string | undefined, better: Better = "up"): CardDelta | null {
  if (!last || !prev) return null;
  const pp = unit === "%";
  if (!pp && prev.value === 0) return null;
  const v = pp ? Math.round((last.value - prev.value) * 10) / 10 : Math.round(((last.value - prev.value) / Math.abs(prev.value)) * 1000) / 10;
  const dir = v > 0 ? "up" : v < 0 ? "down" : "same";
  const text = `${dir === "up" ? "▲" : dir === "down" ? "▼" : "="} ${Math.abs(v).toLocaleString("uk-UA")}${pp ? " п.п." : "%"}`;
  const tone = dir === "same" || better === "neutral" ? "neutral" : dir === better ? "good" : "bad";
  return { dir, text, tone };
}

/**
 * ★ «МІЙ НАБІР» (Сашин «Кастом», Роман 20.11: «у браузері») — ключі показників у `localStorage`. Вміст сховища —
 * чужий текст: старий формат, ручна правка, показник, якого вже немає. Тож розбір ніколи не кидає і лишає лише
 * відомі ключі, без повторів, не більше `MINE_MAX`.
 */
export const MINE_KEY = "stats.mine";
export const MINE_MAX = 24;
export function parseMine(raw: string | null | undefined, known: readonly string[]): string[] {
  if (!raw) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const ok = new Set(known);
  const out: string[] = [];
  for (const k of v) if (typeof k === "string" && ok.has(k) && !out.includes(k)) out.push(k);
  return out.slice(0, MINE_MAX);
}
