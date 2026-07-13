// «Кількість дзвінків» для розділу «Статистики» — Ringostat API (GET
// https://api.ringostat.net/calls/list, заголовок Auth-key). LIVE per-manager:
// поле `employee_fio` (ПІБ співробітника) → мапимо на нашого менеджера → тімліда
// → sales.calls ПО ТІМЛІДАХ. Результативні = була розмова (`billsec > 0`), як
// «Прийнятий» у ручному експорті.
//
// ⚠️ Мапимо по НАШІЙ структурі команд, а НЕ по полю `department` Ringostat —
// воно ненадійне (той самий менеджер може бути позначений іншим відділом).
// Рахуємо тільки менеджерів команд продажу (Яцик/Дмитрук/Безпамятний/Шаврова/
// Михальчевська/Самостійні→Шевчук). Щогодини + старт.

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
function kyivNow() {
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
function mondayOf(y: number, m: number, d: number, dow: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dow + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

const norm = (s: string) => s.toLowerCase().replace(/[ʼ'’`]/g, "'").replace(/\s+/g, "");
function leadOfTeam(team: string | null): string | null {
  if (!team) return null;
  if (/Яцик/i.test(team)) return "Яцик";
  if (/Дмитрук/i.test(team)) return "Дмитрук";
  if (/Безпам/i.test(team)) return "Безпамятний";
  if (/Шаврово/i.test(team)) return "Шаврова";
  if (/Михальчевсь/i.test(team)) return "Михальчевська";
  if (/Самост/i.test(team)) return "Шевчук Назар";
  return null;
}
/** ПІБ (employee_fio) → тімлід. Ключі: «прізвищеімʼя» + прізвище (fallback). */
async function buildLeadMap(): Promise<Map<string, string>> {
  const r = await pool.query<{ name: string; team: string | null }>(
    `SELECT m.name, t.name AS team FROM managers m LEFT JOIN teams t ON t.id = m.team_id WHERE m.is_active`
  );
  const map = new Map<string, string>();
  for (const row of r.rows) {
    const lead = leadOfTeam(row.team);
    if (!lead) continue;
    const toks = row.name.trim().split(/\s+/);
    map.set(norm(toks.slice(0, 2).join("")), lead);
    if (!map.has(norm(toks[0]))) map.set(norm(toks[0]), lead); // прізвище-fallback (перший виграє)
  }
  return map;
}
function resolveLead(fio: string, map: Map<string, string>): string | null {
  const toks = (fio ?? "").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  return map.get(norm(toks.slice(0, 2).join(""))) ?? map.get(norm(toks[0])) ?? null;
}

/** Результативні дзвінки (billsec>0) по тімлідах за період. */
async function callsByLead(from: string, to: string, leadMap: Map<string, string>): Promise<Map<string, number>> {
  const url = `https://api.ringostat.net/calls/list?export_type=json`
    + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&fields=calldate,employee_fio,billsec`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { headers: { "Auth-key": config.ringostat.authKey }, signal: ctrl.signal });
    const txt = await res.text();
    let arr: { employee_fio?: string; billsec?: number | string }[];
    try { arr = JSON.parse(txt); } catch { throw new Error(`Ringostat non-JSON: ${txt.slice(0, 120)}`); }
    if (!Array.isArray(arr)) throw new Error(`Ringostat unexpected: ${txt.slice(0, 120)}`);
    const byLead = new Map<string, number>();
    for (const c of arr) {
      if (Number(c.billsec) <= 0) continue;
      const lead = resolveLead(c.employee_fio ?? "", leadMap);
      if (!lead) continue;
      byLead.set(lead, (byLead.get(lead) ?? 0) + 1);
    }
    return byLead;
  } finally { clearTimeout(t); }
}

async function upsert(periodType: "month" | "week", periodStart: string, byLead: Map<string, number>): Promise<void> {
  if (periodStart < STATS_AUTO_FROM) return;
  // Прибираємо старий відділовий рядок (team_lead=NULL) — тепер розбивка по тімлідах.
  await pool.query(
    `DELETE FROM statistics_values WHERE department='sales' AND metric_key='calls'
       AND period_type=$1 AND period_start=$2 AND team_lead IS NULL`, [periodType, periodStart]
  );
  for (const [lead, value] of byLead) {
    await pool.query(
      `INSERT INTO statistics_values (department, period_type, period_start, team_lead, metric_key, value, source)
       VALUES ('sales',$1,$2,$3,'calls',$4,'auto')
       ON CONFLICT (department, period_type, period_start, COALESCE(team_lead,''), metric_key)
       DO UPDATE SET value = EXCLUDED.value, source = 'auto', updated_at = now()`,
      [periodType, periodStart, lead, value]
    );
  }
}

export async function syncRingostatCalls(): Promise<void> {
  if (!config.ringostat.authKey) { console.warn("syncRingostatCalls: RINGOSTAT_AUTH_KEY не задано — пропуск."); return; }
  if (running) { console.warn("syncRingostatCalls: previous run in progress — skip."); return; }
  running = true; status.running = true;
  const startedAt = new Date();
  try {
    const leadMap = await buildLeadMap();
    const n = kyivNow();
    const nowStr = `${n.y}-${pad(n.m)}-${pad(n.d)} ${pad(n.hh)}:${pad(n.mm)}:${pad(n.ss)}`;
    const monthStart = `${n.y}-${pad(n.m)}-01`;
    const monthByLead = await callsByLead(`${monthStart} 00:00:00`, nowStr, leadMap);
    await upsert("month", monthStart, monthByLead);
    status.monthCalls = [...monthByLead.values()].reduce((s, v) => s + v, 0);
    const weekStart = mondayOf(n.y, n.m, n.d, n.dow);
    const weekByLead = await callsByLead(`${weekStart} 00:00:00`, nowStr, leadMap);
    await upsert("week", weekStart, weekByLead);
    status.lastError = null;
    console.log(`syncRingostatCalls: month ${status.monthCalls} (per-lead ${monthByLead.size}), week ${[...weekByLead.values()].reduce((s, v) => s + v, 0)}.`);
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
