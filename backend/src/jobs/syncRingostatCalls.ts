// «Кількість дзвінків» для розділу «Статистики» — джерело Ringostat API
// (GET https://api.ringostat.net/calls/list, заголовок Auth-key). Рахує дзвінки
// поточного місяця й тижня по відділу «Менеджери з продажу» → sales.calls.
//
// ⚠️ ГРАНУЛЯРНІСТЬ — ЛИШЕ ВІДДІЛ (не по менеджерах): у відповіді API поле
// employee/extension (`additional_number`) порожнє, тож розбити дзвінки по
// team_lead неможливо. Тому пишемо calls на рівні відділу (team_lead = NULL);
// у таблиці показник видно в рядку «Разом». Історія (лист) лишається imported.
//
// Що рахуємо: результативні дзвінки відділу = БУЛА РОЗМОВА (`billsec > 0`), як у
// експорті «Розбивка по менеджерах» («Прийнятий»=1 покриває ANSWERED/PROPER/
// REPEATED). Суворий disposition='ANSWERED' недобирав PROPER/REPEATED (~20%).
// Щогодини + старт. Порожній Auth-key → джоба спить.

import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { STATS_AUTO_FROM } from "../statistics/catalog.js";

export interface RingostatStatus {
  lastRunAt: string | null; lastError: string | null;
  monthCalls: number | null; running: boolean;
}
const status: RingostatStatus = { lastRunAt: null, lastError: null, monthCalls: null, running: false };
export function getRingostatStatus(): RingostatStatus { return { ...status }; }

let running = false;

const pad = (n: number) => String(n).padStart(2, "0");
/** Частини поточного часу в Києві. */
function kyivNow(): { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number } {
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get("year")), m: Number(get("month")), d: Number(get("day")),
    hh: Number(get("hour")), mm: Number(get("minute")), ss: Number(get("second")),
    dow: dowMap[get("weekday")] ?? 0,
  };
}
/** period_start понеділка тижня, у який попадає (y,m,d). */
function mondayOf(y: number, m: number, d: number, dow: number): string {
  const back = (dow + 6) % 7; // Mon=0
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}

async function countSalesCalls(from: string, to: string): Promise<number> {
  const url = `https://api.ringostat.net/calls/list?export_type=json`
    + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&fields=calldate,department,billsec`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { headers: { "Auth-key": config.ringostat.authKey }, signal: ctrl.signal });
    const txt = await res.text();
    let arr: { department?: string; billsec?: number | string }[];
    try { arr = JSON.parse(txt); } catch { throw new Error(`Ringostat non-JSON: ${txt.slice(0, 120)}`); }
    if (!Array.isArray(arr)) throw new Error(`Ringostat unexpected: ${txt.slice(0, 120)}`);
    // Результативні = була розмова (billsec > 0), як «Прийнятий» у експорті.
    return arr.filter((c) =>
      (c.department ?? "").trim() === config.ringostat.salesDepartment &&
      Number(c.billsec) > 0
    ).length;
  } finally { clearTimeout(t); }
}

async function upsertCalls(periodType: "month" | "week", periodStart: string, value: number): Promise<void> {
  if (periodStart < STATS_AUTO_FROM) return;
  await pool.query(
    `INSERT INTO statistics_values (department, period_type, period_start, team_lead, metric_key, value, source)
     VALUES ('sales',$1,$2,NULL,'calls',$3,'auto')
     ON CONFLICT (department, period_type, period_start, COALESCE(team_lead,''), metric_key)
     DO UPDATE SET value = EXCLUDED.value, source = 'auto', updated_at = now()`,
    [periodType, periodStart, value]
  );
}

export async function syncRingostatCalls(): Promise<void> {
  if (!config.ringostat.authKey) { console.warn("syncRingostatCalls: RINGOSTAT_AUTH_KEY не задано — пропуск."); return; }
  if (running) { console.warn("syncRingostatCalls: previous run in progress — skip."); return; }
  running = true; status.running = true;
  const startedAt = new Date();
  try {
    const n = kyivNow();
    const nowStr = `${n.y}-${pad(n.m)}-${pad(n.d)} ${pad(n.hh)}:${pad(n.mm)}:${pad(n.ss)}`;
    // місяць
    const monthStartDate = `${n.y}-${pad(n.m)}-01`;
    const monthCalls = await countSalesCalls(`${monthStartDate} 00:00:00`, nowStr);
    await upsertCalls("month", monthStartDate, monthCalls);
    status.monthCalls = monthCalls;
    // тиждень
    const weekStartDate = mondayOf(n.y, n.m, n.d, n.dow);
    const weekCalls = await countSalesCalls(`${weekStartDate} 00:00:00`, nowStr);
    await upsertCalls("week", weekStartDate, weekCalls);
    status.lastError = null;
    console.log(`syncRingostatCalls: month=${monthCalls} week=${weekCalls} (sales calls).`);
  } catch (err) {
    status.lastError = (err as Error).message;
    console.error("syncRingostatCalls failed:", err);
  } finally {
    running = false; status.running = false; status.lastRunAt = startedAt.toISOString();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncRingostatCalls().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
