import { missedBaseCte, missedDispSql, dealInWindowLateral, CALLBACK_MIN_TALK_SEC, type MissedScope } from "./missedCallsRules.js";
import { carrierHistorySql } from "./carrierHistory.js";
import { phoneForTask } from "./missedCallSignal.js";

/**
 * 📵 «НЕ ПЕРЕДЗВОНИЛИ ЗА 24 ГОД», КНОПКА ЗАДАЧІ, ЗВІТ ТИЖНЯ, ЦІЛЬ (ТЗ Юлі 12.10.2026, розділи 4–7). Чисті правила й форма
 * запитів — без `db/pool`, щоб гейти виконували їх у звичайному `npm test`.
 *
 * Визначення пропущеного, передзвону й медіани — ТІ САМІ, що на екрані (`missedCallsRules`, ТЗ: «нічого не змінюємо»).
 * Новий тут лише блок: пропущений, після якого вже минуло 24 год і з цим номером ДОСІ не було жодної розмови від 10 с
 * (ні нашого передзвону, ні вхідного від клієнта); перевізники за історією CRM — поза блоком (`carrierHistorySql`, той
 * самий, що в автозадачі). Розмова з'явилась — рядок зникає сам, бо умова «досі не було» перестає виконуватись.
 */

export const NO_CALLBACK_LIMIT = 500;

/** Один рядок на номер — НАЙСТАРІШИЙ пропущений без розмови: кілька пропущених від одного клієнта — одна дія. */
export function noCallbackSql(from: string, to: string, s: MissedScope, nowIso: string): { sql: string; params: unknown[] } {
  const { cte, params } = missedBaseCte(from, to, s);
  params.push(nowIso);
  const now = `$${String(params.length)}::timestamptz`;
  const sql = `${cte}
    , pending AS (
      SELECT DISTINCT ON (w.client_phone) w.*
        FROM withNext w
       WHERE ${missedDispSql("w")}
         AND w.client_phone IS NOT NULL
         AND w.calldate <= ${now} - interval '24 hours'
         AND NOT EXISTS (
           SELECT 1 FROM ringostat_calls x
            WHERE x.client_phone = w.client_phone AND x.billsec >= ${String(CALLBACK_MIN_TALK_SEC)}
              AND x.calldate > w.calldate AND x.calldate <= ${now})
         AND ${carrierHistorySql("w.client_phone")} IS NULL
       ORDER BY w.client_phone, w.calldate)
    SELECT w.uniqueid, w.calldate, w.client_phone, w.client_key, w.manager_id, mg.name AS manager_name,
           w.team_at AS team_id, tm.name AS team_name, dl.kommo_id AS deal_id,
           (SELECT count(*)::int FROM withNext z WHERE z.client_phone = w.client_phone AND ${missedDispSql("z")} AND z.calldate >= w.calldate) AS missed_n,
           ot.id AS task_id, to_char(ot.deadline, 'YYYY-MM-DD') AS task_deadline
      FROM pending w
      LEFT JOIN managers mg ON mg.id = w.manager_id
      LEFT JOIN teams tm ON tm.id = w.team_at
      ${dealInWindowLateral("w")}
      LEFT JOIN LATERAL (${openTaskForPhoneSql("w.client_phone")}) ot ON TRUE
     ORDER BY w.calldate, w.client_phone
     LIMIT ${String(NO_CALLBACK_LIMIT + 1)}`;
  return { sql, params };
}

/**
 * Відкрита задача «передзвонити» на цей номер — та, що в журналі `missed_call_tasks` (автозадача 📵 АБО поставлена
 * кнопкою) і ще не закрита. Саме журнал, а не пошук за назвою: назву людина може змінити, а журнал — ні.
 */
export function openTaskForPhoneSql(phoneExpr: string): string {
  return `SELECT t.id, t.deadline FROM missed_call_tasks l JOIN tasks t ON t.id = l.task_id
            WHERE l.client_phone = ${phoneExpr} AND l.closed_at IS NULL AND t.status <> 'done'
            ORDER BY t.deadline NULLS LAST, t.id LIMIT 1`;
}

export type TaskState = "none" | "open" | "overdue";
/** Статус задачі в рядку: прострочена — дедлайн уже минув (за Києвом). */
export function taskState(taskId: number | null, deadline: string | null, today: string): TaskState {
  if (taskId == null) return "none";
  return deadline != null && deadline < today ? "overdue" : "open";
}

export const hoursSince = (at: Date, now: Date): number => Math.floor((now.getTime() - at.getTime()) / 3_600_000);

/** Назва задачі з кнопки (ТЗ, розділ 5): «📵 Передзвонити: [клієнт або номер]». */
export const BUTTON_TITLE_PREFIX = "📵 Передзвонити";
/**
 * Імʼя клієнта з назви угоди. Угоди з дзвінків Kommo часто називає самим номером («380671234567»), і тоді в колонці
 * «Клієнт» стояв би той самий номер удруге (видно на проді 16.10.2026) — а читається це як «клієнта знаємо». Назва без
 * жодної літери — не імʼя: `null`, на екрані «клієнт невідомий».
 */
export function clientNameOf(dealName: string | null | undefined): string | null {
  const n = dealName?.trim();
  if (!n) return null;
  return /^[\d\s+()\-.]+$/.test(n) ? null : n;
}

export function buttonTaskTitle(clientName: string | null, phone: string): string {
  const n = clientNameOf(clientName);
  return `${BUTTON_TITLE_PREFIX}: ${n ? n : phoneForTask(phone)}`;
}
export function buttonTaskDescription(p: { phone: string; missedAt: string; dealUrl: string | null; author: string }): string {
  return [
    `Пропущений дзвінок від ${phoneForTask(p.phone)} о ${p.missedAt}, за 24 год розмови від 10 с з цим номером не було.`,
    p.dealUrl ? `Угода: ${p.dealUrl}` : "Угоди в Kommo за цим дзвінком не знайдено.",
    "Задача закриється сама, щойно на цей номер буде вихідний дзвінок із розмовою від 10 с.",
    `Поставив: ${p.author} («Пропущені дзвінки» → «Не передзвонили за 24 год»).`,
  ].join("\n");
}

/**
 * Хто може ставити задачу з кнопки (ТЗ, розділ 8): керівництво — будь-кому, тімлід — лише менеджеру своєї команди,
 * менеджер — нікому.
 */
export const LEADERSHIP_ROLES: ReadonlySet<string> = new Set(["admin", "opdir", "ceo", "kvp"]);
export function canAssignMissedTask(auth: { role: string; roleKey?: string | null; teamId: number | null }, assigneeTeamId: number | null): boolean {
  const rk = auth.roleKey ?? auth.role;
  if (LEADERSHIP_ROLES.has(rk)) return true;
  if (rk === "team_lead" || auth.role === "team_lead") return auth.teamId != null && assigneeTeamId === auth.teamId;
  return false;
}

/** Ціль «передзвонили за 24 год, %» (ТЗ, розділ 7): ставить і змінює лише керівництво; ціле 1–100. */
export const canSetCallbackNorm = (roleKey: string | null | undefined): boolean => !!roleKey && LEADERSHIP_ROLES.has(roleKey);
export function callbackNormVerdict(v: unknown): { ok: true; norm: number } | { ok: false; error: string } {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100) return { ok: false, error: "Ціль — ціле число від 1 до 100 (%)" };
  return { ok: true, norm: n };
}
/** «у нормі / нижче норми» словом; без цілі — «ціль не задана», а не «у нормі». */
export function normStatus(pct: number | null, norm: number | null): "ok" | "below" | "no_norm" | "no_data" {
  if (norm == null) return "no_norm";
  if (pct == null) return "no_data";
  return pct >= norm ? "ok" : "below";
}

/* ═══════════════════════ ЗВІТ ТИЖНЯ (ТЗ, розділ 6) ═══════════════════════ */

/** Понеділок тижня, що містить `day` (YYYY-MM-DD). */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - wd);
  return d.toISOString().slice(0, 10);
}
export function weekRange(monday: string, shiftWeeks = 0): { from: string; to: string } {
  const a = new Date(`${monday}T00:00:00Z`); a.setUTCDate(a.getUTCDate() + shiftWeeks * 7);
  const b = new Date(a); b.setUTCDate(b.getUTCDate() + 6);
  return { from: a.toISOString().slice(0, 10), to: b.toISOString().slice(0, 10) };
}

export interface WeekCell { missed: number; callback: number; medianMin: number | null }
export const pctOf = (c: Pick<WeekCell, "missed" | "callback">): number | null => (c.missed > 0 ? Math.round((c.callback / c.missed) * 100) : null);

export interface WeekRow { key: string; name: string; missed: number; pct: number | null; medianMin: number | null; noCallback: number;
  prevPct: number | null; change: number | null; status: ReturnType<typeof normStatus> }

export function weekRow(key: string, name: string, cur: WeekCell, prev: WeekCell | null, norm: number | null): WeekRow {
  const pct = pctOf(cur), prevPct = prev ? pctOf(prev) : null;
  return { key, name, missed: cur.missed, pct, medianMin: cur.medianMin, noCallback: cur.missed - cur.callback,
    prevPct, change: pct != null && prevPct != null ? pct - prevPct : null, status: normStatus(pct, norm) };
}

/** «Скопіювати для звіту» — коротка таблиця текстом для чату. */
export function weekReportText(week: { from: string; to: string }, rows: readonly WeekRow[], norm: number | null): string {
  const d = (x: string) => `${x.slice(8, 10)}.${x.slice(5, 7)}`;
  const p = (v: number | null) => (v == null ? "—" : `${String(v)}%`);
  const head = `Пропущені дзвінки ${d(week.from)}–${d(week.to)}${norm != null ? ` · ціль ${String(norm)}%` : ""}`;
  const lines = rows.map((r) => {
    const ch = r.change == null ? "" : ` (${r.change > 0 ? "+" : ""}${String(r.change)} п.п.)`;
    const st = r.status === "ok" ? " ✅" : r.status === "below" ? " ⚠️ нижче норми" : "";
    return `${r.name}: пропущено ${String(r.missed)}, передзвонили за 24 год ${p(r.pct)}${ch}, не передзвонили ${String(r.noCallback)}${r.medianMin != null ? `, медіана ${String(r.medianMin)} хв` : ""}${st}`;
  });
  return [head, ...lines].join("\n");
}
