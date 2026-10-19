import { pool } from "../db/pool.js";
import { DAY_BUCKETS, type DayBucket } from "./dayBuckets.js";
import {
  missedSummarySql, missedByManagerSql, foldManagerRows, missedByTeamSql, foldTeamRows, missedSeriesSql, foldSeries,
  type SeriesGranularity, type MissedSeries, type MissedSeriesRaw,
  missedListSql, noDealCountsSql, noDealListSql, nextStep, OWNERLESS_LABEL, capRows,
  type MissedScope, type MissedManagerRaw, type MissedManagerRow, type MissedTeamRow, type NextStep, type NoDealState,
  missedAutomationSql, ownerlessInScope,
} from "./missedCallsRules.js";
import { noCallbackSql, openTaskForPhoneSql, NO_CALLBACK_LIMIT, weekRange, weekRow, weekReportText, type WeekCell } from "./missedNoCallbackRules.js";

export interface MissedAutomation {
  days: number; skippedCarrier: number; closedCallback: number; closedCarrier: number; openNow: number;
  /** 5824: закрито, бо клієнт сам передзвонив і поговорив від 10 с / угода номера ввійшла в «Успіх» після пропущеного. */
  closedClientSelf: number; closedSuccess: number;
  /** Угоди етапу фільтра з вердиктом «історія CRM» у журналі закриттів; `null` — у скоупі команди/менеджера не показуємо. */
  dealsHistory: number | null;
}
/** Ефект автозакриття за 7 днів (контроль ТЗ 4373). */
export async function missedAutomation(today: string, s: MissedScope = {}): Promise<MissedAutomation> {
  const q = missedAutomationSql(today, s);
  const x = (await pool.query<{ skipped_carrier: number; closed_callback: number; closed_carrier: number; closed_client_self: number; closed_success: number;
    open_now: number; deals_history: number | null }>(q.sql, q.params)).rows[0];
  return { days: 7, skippedCarrier: x.skipped_carrier, closedCallback: x.closed_callback, closedCarrier: x.closed_carrier,
    closedClientSelf: x.closed_client_self, closedSuccess: x.closed_success, openNow: x.open_now, dealsHistory: x.deals_history };
}

/**
 * 📵 ПРОПУЩЕНІ ВХІДНІ — ШАР, ЩО ХОДИТЬ У БАЗУ. ТЗ-1 від 14.09.2026.
 *
 * Означення й форма запиту живуть у `missedCallsRules.ts` (чистий модуль, без
 * `pool`). Поділ не косметичний: рівно він дозволяє гейтам перевіряти ОЗНАЧЕННЯ у
 * звичайному `npm test`, без живої БД і без скіпу, який ніколи не виконується.
 */

export interface MissedSummary {
  missed: number; excluded: number; ownerless: number;
  callback: number; callbackAttempt: number; callbackSelf: number; callbackColleague: number;
  clientSelf: number; medianMin: number | null;
  buckets: Record<DayBucket, number>;
}

interface SummaryRaw {
  missed: number; excluded: number; ownerless: number; callback: number;
  callback_attempt: number; callback_self: number; callback_colleague: number;
  client_self: number; median_min: string | null;
  b_work: number; b_evening: number; b_weekend: number; b_night: number;
}

/**
 * Блок A. Одна поїздка в базу на всі числа періоду — не заради швидкості, а тому
 * що інакше частки й ціле бралися б у РІЗНІ моменти живої таблиці. Дзвінки
 * доливаються щогодини; сусідній гейт `#26q` уже платив за це (зона зрушила на
 * 6 495 ₴ за 15 хв), і правило 18 у CLAUDE.md вимагає одного виклику.
 */
export async function missedSummary(from: string, to: string, s: MissedScope = {}): Promise<MissedSummary> {
  const { sql, params } = missedSummarySql(from, to, s);
  const r = await pool.query<SummaryRaw>(sql, params);
  const x = r.rows[0];
  const n = (v: number | undefined): number => Number(v ?? 0);
  return {
    missed: n(x?.missed), excluded: n(x?.excluded), ownerless: n(x?.ownerless),
    callback: n(x?.callback), callbackAttempt: n(x?.callback_attempt),
    callbackSelf: n(x?.callback_self), callbackColleague: n(x?.callback_colleague),
    clientSelf: n(x?.client_self),
    medianMin: x?.median_min == null ? null : Math.round(Number(x.median_min)),
    buckets: {
      work: n(x?.b_work), evening: n(x?.b_evening),
      weekend: n(x?.b_weekend), night: n(x?.b_night),
    },
  };
}

/** Блок B. Рядок «без відповідального» приходить звідси ЗВИЧАЙНИМ рядком із `null`. */
export async function missedByManager(from: string, to: string, s: MissedScope = {}):
Promise<{ rows: MissedManagerRow[]; total: MissedManagerRow }> {
  const { sql, params } = missedByManagerSql(from, to, s);
  const r = await pool.query<{
    manager_id: number | null; name: string | null; team_id: number | null; missed: number;
    callback_self: number; callback_colleague: number; client_self: number; median_min: string | null;
  }>(sql, params);
  const raw: MissedManagerRaw[] = r.rows.map((x) => ({
    managerId: x.manager_id, name: x.name, teamId: x.team_id, missed: Number(x.missed),
    callbackSelf: Number(x.callback_self), callbackColleague: Number(x.callback_colleague),
    clientSelf: Number(x.client_self),
    medianMin: x.median_min == null ? null : Math.round(Number(x.median_min)),
  }));
  return foldManagerRows(raw);
}

/**
 * 📈 Ряди для графіка динаміки. `from` не задано — від ПЕРШОГО дзвінка в базі (історія з
 * 01.09.2025), як «Усе» на сторінках Статистик.
 */
export async function missedSeries(granularity: SeriesGranularity, from: string | null, to: string, s: MissedScope = {}):
Promise<{ from: string; to: string; series: MissedSeries[] }> {
  const start = from ?? (await pool.query<{ d: string | null }>(
    "SELECT to_char(min(calldate) AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS d FROM ringostat_calls")).rows[0]?.d ?? to;
  const { sql, params } = missedSeriesSql(granularity, start, to, s);
  const r = await pool.query<MissedSeriesRaw>(sql, params);
  return { from: start, to, series: foldSeries(r.rows) };
}

/** Рядки команд блоку B — окремим запитом, бо медіана команди не складається з медіан людей. */
export async function missedByTeam(from: string, to: string, s: MissedScope = {}): Promise<MissedTeamRow[]> {
  const { sql, params } = missedByTeamSql(from, to, s);
  const r = await pool.query<{
    team_id: number | null; team_name: string | null; missed: number;
    callback_self: number; callback_colleague: number; client_self: number; median_min: string | null;
  }>(sql, params);
  return foldTeamRows(r.rows.map((x) => ({
    teamId: x.team_id, name: x.team_name, missed: Number(x.missed),
    callbackSelf: Number(x.callback_self), callbackColleague: Number(x.callback_colleague),
    clientSelf: Number(x.client_self),
    medianMin: x.median_min == null ? null : Math.round(Number(x.median_min)),
  })));
}

export interface MissedListRow {
  uniqueid: string; at: string; phone: string | null; clientKey: string | null;
  managerId: number | null; managerName: string; bucket: DayBucket;
  next: NextStep; nextMin: number | null; dealId: number | null;
}

/**
 * Блок C. `truncated` — не прикраса: без нього стеля `MISSED_LIST_LIMIT` мовчки обрізала
 * б список, і екран показав би «ось усі», хоча показав лише частину.
 */
export async function missedList(day: string, s: MissedScope = {}, onlyNoCallback = false):
Promise<{ rows: MissedListRow[]; truncated: boolean }> {
  const { sql, params } = missedListSql(day, s, onlyNoCallback);
  const r = await pool.query<{
    uniqueid: string; at: string; client_phone: string | null; client_key: string | null;
    manager_id: number | null; manager_name: string | null; bucket: DayBucket;
    cb_min: string | null; cb_talked: boolean | null; cs_min: string | null; deal_id: string | null;
  }>(sql, params);
  const capped = capRows(r.rows);
  const rows = capped.rows.map((x) => {
    const n = nextStep({
      cbMin: x.cb_min == null ? null : Number(x.cb_min),
      cbTalked: x.cb_talked,
      csMin: x.cs_min == null ? null : Number(x.cs_min),
    });
    return {
      uniqueid: x.uniqueid, at: x.at, phone: x.client_phone, clientKey: x.client_key,
      managerId: x.manager_id,
      managerName: x.manager_id == null ? OWNERLESS_LABEL : (x.manager_name ?? `#${String(x.manager_id)}`),
      bucket: x.bucket, next: n.kind, nextMin: n.minutes,
      dealId: x.deal_id == null ? null : Number(x.deal_id),
    };
  });
  return { rows, truncated: capped.truncated };
}

export interface NoDealCounts { answered: number; unknown: number; hasDeal: number; noDeal: number }

/** Блок D. Три стани й ціле одним запитом. */
export async function noDealCounts(from: string, to: string, s: MissedScope = {}): Promise<NoDealCounts> {
  const { sql, params } = noDealCountsSql(from, to, s);
  const x = (await pool.query<{ answered: number; unknown: number; has_deal: number; no_deal: number }>(sql, params)).rows[0];
  return {
    answered: Number(x?.answered ?? 0), unknown: Number(x?.unknown ?? 0),
    hasDeal: Number(x?.has_deal ?? 0), noDeal: Number(x?.no_deal ?? 0),
  };
}

export interface NoDealListRow {
  uniqueid: string; at: string; phone: string | null; clientKey: string | null;
  managerId: number | null; managerName: string; talkSec: number; dealId: number | null;
}

/** Розкриття одного стану блоку D. */
export async function noDealList(from: string, to: string, s: MissedScope, state: NoDealState):
Promise<{ rows: NoDealListRow[]; truncated: boolean }> {
  const { sql, params } = noDealListSql(from, to, s, state);
  const r = await pool.query<{
    uniqueid: string; at: string; client_phone: string | null; client_key: string | null;
    manager_id: number | null; manager_name: string | null; billsec: number; deal_id: string | null;
  }>(sql, params);
  const capped = capRows(r.rows);
  const rows = capped.rows.map((x) => ({
    uniqueid: x.uniqueid, at: x.at, phone: x.client_phone, clientKey: x.client_key,
    managerId: x.manager_id,
    managerName: x.manager_id == null ? OWNERLESS_LABEL : (x.manager_name ?? `#${String(x.manager_id)}`),
    talkSec: Number(x.billsec), dealId: x.deal_id == null ? null : Number(x.deal_id),
  }));
  return { rows, truncated: capped.truncated };
}

export { DAY_BUCKETS };
export type { DayBucket, MissedScope, MissedManagerRow, NoDealState };

/* ═══════════════ «НЕ ПЕРЕДЗВОНИЛИ ЗА 24 ГОД», ЗАДАЧА З КНОПКИ, ЗВІТ ТИЖНЯ, ЦІЛЬ (ТЗ Юлі 12.10.2026) ═══════════════ */

export interface NoCallbackRow {
  uniqueid: string; at: string; phone: string; clientKey: string | null; managerId: number | null; managerName: string | null;
  teamId: number | null; teamName: string | null; dealId: number | null; missedN: number;
  taskId: number | null; taskDeadline: string | null;
}
export async function missedNoCallback(from: string, to: string, s: MissedScope, now: Date): Promise<{ rows: NoCallbackRow[]; truncated: boolean }> {
  const { sql, params } = noCallbackSql(from, to, s, now.toISOString());
  const r = await pool.query<{ uniqueid: string; calldate: Date; client_phone: string; client_key: string | null; manager_id: number | null;
    manager_name: string | null; team_id: number | null; team_name: string | null; deal_id: string | null; missed_n: number;
    task_id: number | null; task_deadline: string | null }>(sql, params);
  const rows = r.rows.map((x) => ({ uniqueid: x.uniqueid, at: x.calldate.toISOString(), phone: x.client_phone, clientKey: x.client_key,
    managerId: x.manager_id, managerName: x.manager_name, teamId: x.team_id, teamName: x.team_name,
    dealId: x.deal_id == null ? null : Number(x.deal_id), missedN: Number(x.missed_n), taskId: x.task_id, taskDeadline: x.task_deadline }));
  return { rows: rows.slice(0, NO_CALLBACK_LIMIT), truncated: rows.length > NO_CALLBACK_LIMIT };
}

/** Відкрита задача «передзвонити» на номер (журнал `missed_call_tasks`) — щоб кнопка не створила дубль. */
export async function openMissedTask(phone: string): Promise<{ id: number; deadline: string | null } | null> {
  const r = await pool.query<{ id: number; deadline: Date | null }>(openTaskForPhoneSql("$1"), [phone]);
  const x = r.rows[0];
  return x ? { id: x.id, deadline: x.deadline ? x.deadline.toISOString().slice(0, 10) : null } : null;
}

/**
 * Задача з кнопки (ТЗ, розділ 5) — у задачник на менеджера (дедлайн сьогодні, високий пріоритет, автор — хто натиснув)
 * і В ТОЙ САМИЙ журнал `missed_call_tasks`, що й автозадача: тому вона закривається тим самим `closeCandidatesSql`
 * після вихідної розмови від 10 с, а повторна кнопка бачить «Задача вже є». Усе — однією транзакцією з блокуванням рядка
 * журналу: дві кнопки одночасно не створять двох задач.
 */
export async function createMissedButtonTask(p: { phone: string; managerId: number; missedAt: Date; today: string; title: string;
  description: string; authorUserId: number | null; department: string | null }): Promise<{ created: true; id: number } | { created: false; id: number; deadline: string | null }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`missed-task:${p.phone}`]);
    const ex = (await c.query<{ id: number; deadline: Date | null }>(openTaskForPhoneSql("$1"), [p.phone])).rows[0];
    if (ex) { await c.query("ROLLBACK"); return { created: false, id: ex.id, deadline: ex.deadline ? ex.deadline.toISOString().slice(0, 10) : null }; }
    const id = (await c.query<{ id: number }>(
      `INSERT INTO tasks (title, description, status, deadline, assignee_id, priority, department, task_type, created_by)
       VALUES ($1, $2, 'not_started', $3::date, $4, 'high', $5, 'simple', $6) RETURNING id`,
      [p.title, p.description, p.today, p.managerId, p.department ?? "Пропущені дзвінки", p.authorUserId])).rows[0]!.id;
    await c.query(
      `INSERT INTO missed_call_tasks (manager_id, client_phone, kday, task_id, missed_count, last_signal_at)
       VALUES ($1, $2, $3::date, $4, 1, $5)
       ON CONFLICT (manager_id, client_phone, kday) DO UPDATE SET task_id = EXCLUDED.task_id, closed_at = NULL,
         last_signal_at = EXCLUDED.last_signal_at, updated_at = now()`,
      [p.managerId, p.phone, p.today, id, p.missedAt.toISOString()]);
    await c.query("COMMIT");
    return { created: true, id };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

/** Звіт тижня (ТЗ, розділ 6): відділ, кожна команда і «Без відповідального» — Σ рядків = відділ (критерій приймання). */
export async function missedWeekReport(monday: string, s: MissedScope, norm: number | null) {
  const cur = weekRange(monday), prev = weekRange(monday, -1);
  const cell = (x: { missed: number; callback: number; medianMin: number | null }): WeekCell => ({ missed: x.missed, callback: x.callback, medianMin: x.medianMin });
  const teamCell = (t: MissedTeamRow): WeekCell => ({ missed: t.missed, callback: t.callbackSelf + t.callbackColleague, medianMin: t.medianMin });
  const withOwnerless = ownerlessInScope(s);
  const own: MissedScope = { ...s, teamIds: [], ownerless: true };
  const [dc, dp, tc, tp, oc, op] = await Promise.all([
    missedSummary(cur.from, cur.to, s), missedSummary(prev.from, prev.to, s),
    missedByTeam(cur.from, cur.to, s), missedByTeam(prev.from, prev.to, s),
    withOwnerless ? missedSummary(cur.from, cur.to, own) : null, withOwnerless ? missedSummary(prev.from, prev.to, own) : null,
  ]);
  const prevBy = new Map(tp.map((t) => [t.teamId, teamCell(t)]));
  const rows = [
    weekRow("dept", "Відділ", cell(dc), cell(dp), norm),
    ...tc.map((t) => weekRow(`team:${String(t.teamId)}`, t.name, teamCell(t), prevBy.get(t.teamId) ?? null, norm)),
    ...(oc ? [weekRow("ownerless", OWNERLESS_LABEL, cell(oc), op ? cell(op) : null, norm)] : []),
  ];
  return { week: cur, prevWeek: prev, norm, rows, text: weekReportText(cur, rows, norm) };
}

/** Ціль «передзвонили за 24 год, %» — остання встановлена (історія в `missed_callback_norm`); `null` — ще не задано. */
export async function callbackNorm(): Promise<{ norm: number | null; setBy: string | null; setAt: string | null }> {
  const r = await pool.query<{ norm: number; set_by_name: string | null; set_at: Date }>(
    "SELECT norm, set_by_name, set_at FROM missed_callback_norm ORDER BY set_at DESC, id DESC LIMIT 1");
  const x = r.rows[0];
  return x ? { norm: x.norm, setBy: x.set_by_name, setAt: x.set_at.toISOString() } : { norm: null, setBy: null, setAt: null };
}
export async function setCallbackNorm(norm: number, userId: number | null, name: string | null): Promise<void> {
  await pool.query("INSERT INTO missed_callback_norm (norm, set_by, set_by_name) VALUES ($1, $2, $3)", [norm, userId, name]);
}
