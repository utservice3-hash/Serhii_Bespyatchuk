/**
 * 📉 ПЛИННІСТЬ, EXIT-ІНТЕРВʼЮ, ПРИВʼЯЗКА ДО KOMMO (18.09.2026, етапи 4–5 плану за зустріччю 15.09).
 *
 * ПЛИННІСТЬ — як у таблиці «Плинність NEW» (COUNTIFS по датах прийому/звільнення): за місяць
 *   звільнено ÷ усіх, хто ПРАЦЮВАВ у цьому місяці (прийнятий до кінця місяця і не звільнений до його
 *   початку) × 100. ⚠️ ВІДКРИТЕ ПИТАННЯ до Сергія: «середньоспискова» — так чи справжнє середнє; формула
 *   одна (`monthRow`), поміняти — одне місце. Без дати прийому людина рахується працюючою від початку —
 *   і таких видно окремим числом, а не мовчки (правило «невідоме має бути видимим»). Тримає #583.
 */
import { shortKey } from "./employeeImport.js";
import type { Db } from "./secrets.js";

export class ChurnError extends Error { constructor(public status: number, message: string) { super(message); } }

export interface ChurnPerson { hired_at: string | null; dismissed_at: string | null; dismiss_reason: string | null; position: string | null; team_label: string | null }
export interface ChurnMonth { month: string; headcount: number; hired: number; dismissed: number; turnover: number | null; early: number; noHireDate: number }

const lastDay = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
export const monthsBetween = (from: string, to: string) => {
  const out: string[] = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 120) break; }
  return out;
};
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/** Один місяць. «Ранні» — звільнені в перші 90 днів після прийому (для навчання й найму це головний сигнал). */
export function monthRow(ppl: ChurnPerson[], ym: string): ChurnMonth {
  const start = `${ym}-01`, end = lastDay(ym);
  const worked = ppl.filter((p) => (p.hired_at == null || p.hired_at <= end) && (p.dismissed_at == null || p.dismissed_at >= start));
  const dismissed = ppl.filter((p) => p.dismissed_at != null && p.dismissed_at >= start && p.dismissed_at <= end);
  return {
    month: ym, headcount: worked.length,
    hired: ppl.filter((p) => p.hired_at != null && p.hired_at >= start && p.hired_at <= end).length,
    dismissed: dismissed.length,
    turnover: worked.length ? Math.round((dismissed.length / worked.length) * 1000) / 10 : null,
    early: dismissed.filter((p) => p.hired_at != null && daysBetween(p.hired_at, p.dismissed_at!) <= 90).length,
    noHireDate: worked.filter((p) => p.hired_at == null).length,
  };
}

const top = (xs: (string | null)[], empty: string) => {
  const m = new Map<string, number>();
  for (const x of xs) { const k = (x ?? "").trim() || empty; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n).slice(0, 12);
};

/** Плинність за період місяців (РРРР-ММ, включно) + причини й посади звільнених. */
export async function churnReport(db: Db, from: unknown, to: unknown) {
  const ok = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
  if (!ok(from) || !ok(to) || from > to) throw new ChurnError(400, "Період — місяці РРРР-ММ, from ≤ to");
  const ppl = (await db.query<ChurnPerson>(
    `SELECT hired_at::text AS hired_at, dismissed_at::text AS dismissed_at, dismiss_reason, position, team_label FROM employees`)).rows;
  const months = monthsBetween(from, to).map((m) => monthRow(ppl, m));
  const inRange = ppl.filter((p) => p.dismissed_at != null && p.dismissed_at >= `${from}-01` && p.dismissed_at <= lastDay(to));
  const tot = months.reduce((a, m) => ({ dismissed: a.dismissed + m.dismissed, hired: a.hired + m.hired, early: a.early + m.early }), { dismissed: 0, hired: 0, early: 0 });
  const avgTurnover = months.filter((m) => m.turnover != null).reduce((a, m, _, arr) => a + (m.turnover! / arr.length), 0);
  return {
    months, total: { ...tot, avgTurnover: Math.round(avgTurnover * 10) / 10, active: ppl.filter((p) => p.dismissed_at == null).length },
    reasons: top(inRange.map((p) => p.dismiss_reason), "причину не вказано"),
    positions: top(inRange.map((p) => p.position), "посада не вказана"),
  };
}

/**
 * Привʼязати людей реєстру до менеджерів Kommo: спершу за «ID Kommo» з таблиці, далі — за ЄДИНИМ збігом
 * прізвища й імені серед УСІХ менеджерів (однофамільців не вгадуємо). Повторний запуск нічого не міняє.
 * Тримає #584.
 */
export async function linkKommo(db: Db) {
  const mgrs = (await db.query<{ id: number; name: string; kommo_user_id: string | null }>(
    `SELECT id, name, kommo_user_id::text AS kommo_user_id FROM managers`)).rows;
  const taken = new Set((await db.query<{ manager_id: number }>(`SELECT manager_id FROM employees WHERE manager_id IS NOT NULL`)).rows.map((r) => r.manager_id));
  const byKommo = new Map(mgrs.filter((m) => m.kommo_user_id).map((m) => [m.kommo_user_id!, m.id]));
  const byName = new Map<string, number[]>();
  for (const m of mgrs) { const k = shortKey(m.name); byName.set(k, [...(byName.get(k) ?? []), m.id]); }
  const todo = (await db.query<{ id: number; full_name: string; kommo: string | null }>(
    `SELECT id, full_name, NULLIF(regexp_replace(COALESCE(extra->>'ID Kommo', ''), '\\D', '', 'g'), '') AS kommo FROM employees WHERE manager_id IS NULL`)).rows;
  const out = { linked: 0, byId: 0, byName: 0, ambiguous: 0, none: 0 };
  for (const e of todo) {
    let mid: number | undefined = e.kommo ? byKommo.get(e.kommo) : undefined, how: "byId" | "byName" = "byId";
    if (mid == null) { const c = byName.get(shortKey(e.full_name)) ?? []; if (c.length === 1) { mid = c[0]; how = "byName"; } else if (c.length > 1) { out.ambiguous++; continue; } }
    if (mid == null || taken.has(mid)) { out.none++; continue; }
    await db.query(`UPDATE employees SET manager_id = $1, updated_at = now() WHERE id = $2`, [mid, e.id]);
    taken.add(mid); out.linked++; out[how]++;
  }
  return out;
}

const EXIT_FIELDS = ["full_name", "interview_date", "position", "tenure", "reason", "reason_detail", "rating", "missing", "recommend", "team_lead", "note", "employee_id"] as const;

function exitValues(b: Record<string, unknown>, partial: boolean) {
  const v: Record<string, unknown> = {};
  for (const k of EXIT_FIELDS) {
    if (!(k in b)) continue;
    const raw = b[k];
    if (k === "rating") {
      if (raw == null || raw === "") { v.rating = null; continue; }
      const n = Number(raw); if (!Number.isInteger(n) || n < 1 || n > 10) throw new ChurnError(400, "Оцінка — ціле від 1 до 10"); v.rating = n; continue;
    }
    if (k === "employee_id") { v.employee_id = raw == null || raw === "" ? null : Number(raw); continue; }
    const s = raw == null ? null : String(raw).trim().slice(0, 2000) || null;
    if (k === "interview_date" && s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ChurnError(400, "Дата інтервʼю — РРРР-ММ-ДД");
    v[k] = s;
  }
  if (!partial && !v.full_name) throw new ChurnError(400, "Вкажіть ПІБ");
  if (!partial && !v.interview_date) throw new ChurnError(400, "Вкажіть дату інтервʼю");
  if (partial && "full_name" in v && !v.full_name) throw new ChurnError(400, "ПІБ не може бути порожнім");
  return v;
}

/** Exit-інтервʼю: список (без видалених) і зведення — причини, середня оцінка, «порадив би». Тримає #585. */
export async function listExits(db: Db) {
  const rows = (await db.query<Record<string, unknown> & { rating: number | null; reason: string | null; recommend: string | null }>(
    `SELECT x.id, x.employee_id, x.full_name, x.interview_date::text AS interview_date, x.position, x.tenure, x.reason, x.reason_detail,
            x.rating, x.missing, x.recommend, x.team_lead, x.note, COALESCE(NULLIF(u.full_name, ''), u.email) AS author, x.created_at
       FROM exit_interviews x LEFT JOIN users u ON u.id = x.created_by WHERE x.deleted_at IS NULL ORDER BY x.interview_date DESC, x.id DESC`)).rows;
  const rated = rows.filter((r) => r.rating != null);
  const yes = rows.filter((r) => /^(так|yes|да)/i.test(r.recommend ?? "")).length, answered = rows.filter((r) => (r.recommend ?? "").trim()).length;
  return {
    rows, stats: {
      total: rows.length, avgRating: rated.length ? Math.round((rated.reduce((a, r) => a + r.rating!, 0) / rated.length) * 10) / 10 : null,
      recommendPct: answered ? Math.round((yes / answered) * 100) : null, reasons: top(rows.map((r) => r.reason), "причину не вказано"),
    },
  };
}

export async function createExit(db: Db, actorId: number, b: Record<string, unknown>) {
  const v = exitValues(b, false);
  const cols = Object.keys(v);
  const r = await db.query<{ id: number }>(
    `INSERT INTO exit_interviews (${cols.join(", ")}, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, $${cols.length + 1}) RETURNING id`,
    [...cols.map((k) => v[k]), actorId]);
  return r.rows[0].id;
}

export async function updateExit(db: Db, id: number, b: Record<string, unknown>) {
  const v = exitValues(b, true);
  const cols = Object.keys(v);
  if (!cols.length) return;
  const r = await db.query(`UPDATE exit_interviews SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 AND deleted_at IS NULL`, [id, ...cols.map((k) => v[k])]);
  if (!r.rowCount) throw new ChurnError(404, "Інтервʼю не знайдено");
}

/** Мʼяке видалення й відновлення — пара, що повертає рядок до байта. */
export async function setExitDeleted(db: Db, id: number, deleted: boolean) {
  const r = await db.query(`UPDATE exit_interviews SET deleted_at = ${deleted ? "now()" : "NULL"} WHERE id = $1 AND deleted_at IS ${deleted ? "" : "NOT "}NULL`, [id]);
  if (!r.rowCount) throw new ChurnError(404, deleted ? "Інтервʼю не знайдено" : "Інтервʼю не видалене");
}
