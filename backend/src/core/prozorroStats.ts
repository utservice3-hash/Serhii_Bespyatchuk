import type { Db } from "./adCallFacts.js";

/**
 * 📊 «ТЕНДЕРИ PROZORRO» → «Статистика» по днях (задача #5299, прохід 2 — лише те, що знає наша таблиця; Роман 23.10.2026:
 * «просто загальна статистика по днях, скільки привели»). Етапи угод у Kommo (взято в роботу / передано / перевезення) —
 * прохід 3, після затвердження визначення «дійшли до перевезення».
 *
 * Дні — за Києвом, обидва кінці включно (правило проєкту: `(col AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $from AND $to`).
 *  · «знайдено» — рядок `prozorro_leads` створено в цей день (переможець пройшов відбір; і пробний, і бойовий режим);
 *  · «записано в Kommo» — `pushed_at` у цей день.
 */
export interface PzDayRow { date: string; found: number; pushed: number }
export interface PzStats { from: string; to: string; days: PzDayRow[]; totals: { found: number; pushed: number }; lastRunAt: string | null; lastError: string | null }

export async function prozorroStats(db: Db, from: string, to: string): Promise<PzStats> {
  const r = await db.query<{ d: string; found: number; pushed: number }>(
    `WITH days AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d),
          f AS (SELECT (created_at AT TIME ZONE 'Europe/Kyiv')::date AS d, count(*)::int AS n FROM prozorro_leads
                 WHERE (created_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date GROUP BY 1),
          p AS (SELECT (pushed_at AT TIME ZONE 'Europe/Kyiv')::date AS d, count(*)::int AS n FROM prozorro_leads
                 WHERE pushed_at IS NOT NULL AND (pushed_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date GROUP BY 1)
     SELECT to_char(days.d, 'YYYY-MM-DD') AS d, coalesce(f.n, 0) AS found, coalesce(p.n, 0) AS pushed
       FROM days LEFT JOIN f ON f.d = days.d LEFT JOIN p ON p.d = days.d ORDER BY days.d`, [from, to]);
  const days = r.rows.map((x) => ({ date: x.d, found: x.found, pushed: x.pushed }));
  const job = (await db.query<{ ok: Date | null; err: string | null; err_at: Date | null }>(
    `SELECT last_success_at AS ok, last_error AS err, last_error_at AS err_at FROM job_runs WHERE name = 'prozorroLeads'`)).rows[0];
  const freshErr = job?.err && job.err_at && (!job.ok || job.err_at > job.ok) ? job.err : null;
  return {
    from, to, days,
    totals: { found: days.reduce((a, d) => a + d.found, 0), pushed: days.reduce((a, d) => a + d.pushed, 0) },
    lastRunAt: job?.ok ? new Date(job.ok).toISOString() : null,
    lastError: freshErr,
  };
}

/** Період із запиту: дві дати YYYY-MM-DD, `from ≤ to`, не довше року. Інакше — помилка з людським текстом. */
export function parsePeriod(from: unknown, to: unknown): { ok: true; from: string; to: string } | { ok: false; error: string } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof from !== "string" || typeof to !== "string" || !re.test(from) || !re.test(to)) return { ok: false, error: "Період: from і to у форматі РРРР-ММ-ДД" };
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return { ok: false, error: "Період: from не пізніше за to" };
  if ((b - a) / 86_400_000 > 366) return { ok: false, error: "Період: не довше року" };
  return { ok: true, from, to };
}
