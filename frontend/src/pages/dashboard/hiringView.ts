import type { HiringStatus } from "../../api";

/**
 * 🧑‍💼 НАЙМ — дрібні чисті помічники вигляду. Дати ЛИШЕ як рядки YYYY-MM-DD і арифметика
 * в UTC: `new Date("…T00:00:00")` у локальному поясі зсував день (спіймано на макеті 16.09:
 * стрілка «вперед» стояла на місці, тиждень показувався 12–18.09 замість 14–20.09).
 */
export const todayKyiv = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
export const nowKyivHM = (): string =>
  new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hour12: false });

const utc = (d: string) => new Date(d + "T00:00:00Z");
export const addDays = (d: string, n: number): string => {
  const x = utc(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
};
export const mondayOf = (d: string): string => addDays(d, -((utc(d).getUTCDay() + 6) % 7));
export const monthStart = (d: string): string => d.slice(0, 8) + "01";
export const monthEnd = (d: string): string => {
  const [y, m] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

const MON = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
export const DOW = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const DOWF = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];
export const dowOf = (d: string) => DOW[utc(d).getUTCDay()];
export const isWeekend = (d: string) => [0, 6].includes(utc(d).getUTCDay());
export const longDate = (d: string) => { const x = utc(d); return `${DOWF[x.getUTCDay()]}, ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`; };
export const dm = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "—");

/** Колір статусу: сірий — ще нічого, синій — у роботі, жовтий — ризик, зелений — рух уперед, червоний — стоп. */
export const STATUS_TONE: Record<HiringStatus, "gr" | "pl" | "wn" | "ok" | "dg"> = {
  new: "gr", planned: "gr", done: "pl", noshow: "wn", noanswer: "wn", lead: "pl",
  candidate: "ok", training: "wn", manager: "ok", declined: "dg", nofit: "dg", black: "dg",
};

/** Перехід у ці статуси вимагає команди — дзеркало `NEEDS_TEAM` бекенду (сервер однаково перевірить). */
export const NEEDS_TEAM: HiringStatus[] = ["lead", "candidate"];

export const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 100) : null);

/** Пресети періоду звіту. «Цей тиждень/місяць» — до сьогодні: майбутнім дням нема чого показати. */
export function presetRange(id: string, today = todayKyiv()): { from: string; to: string } {
  const mon = mondayOf(today);
  switch (id) {
    case "yesterday": return { from: addDays(today, -1), to: addDays(today, -1) };
    case "week": return { from: mon, to: today };
    case "lastweek": return { from: addDays(mon, -7), to: addDays(mon, -1) };
    case "month": return { from: monthStart(today), to: today };
    case "lastmonth": { const e = addDays(monthStart(today), -1); return { from: monthStart(e), to: e }; }
    default: return { from: today, to: today };
  }
}

export const LS = {
  get(k: string): string | null { try { return localStorage.getItem("hiring." + k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem("hiring." + k, v); } catch { /* приватне вікно */ } },
};
