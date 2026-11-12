import { pool } from "../db/pool.js";
import { fetchLeadsByIdsLean, LEADS_BY_IDS_MAX } from "../kommo/client.js";
import { isKommoPaused } from "../kommo/pause.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";
import { jobSkip, type JobSkip } from "./jobRuns.js";
import { kyivToday } from "../core/dates.js";
import { leadgenHandoffMoney } from "../core/leadgenStats.js";
import { FIELD_QUOTE_RATING, parseQuoteRating } from "../core/leadgenRatings.js";

/**
 * ⭐ ОЦІНКИ ПРОРАХУНКІВ З KOMMO → `deals.quote_rating` (задача 7537). Щогодини о :40 за Києвом.
 *
 * Чому окрема джоба, а не рядок у `syncKommo`: поле зʼявилось 04.11.2026, і оцінки, поставлені до викату, звичайний
 * синк (він бере лише ЗМІНЕНІ угоди) не побачив би ніколи. Ця джоба щоразу перечитує з Kommo угоди менеджерів з
 * передач лідгенів за останні `WINDOW_DAYS` днів — це і дозаповнення, і щогодинне оновлення одним шляхом; оцінку,
 * яку менеджер поставив чи змінив через тиждень після передачі, вона теж підхопить. Пише ЛИШЕ свою колонку.
 *
 * Kommo не віддала угоду, яку ми просили, — її оцінку НЕ чіпаємо (зникла з відповіді ≠ «оцінку зняли»).
 * Порожня відповідь на непорожній запит — помилка, а не «оцінок немає».
 */
const guard = createRunGuard("syncQuoteRatings");
export const WINDOW_DAYS = 62;
const BATCH = Math.min(200, LEADS_BY_IDS_MAX);

export interface QuoteRatingsReport { asked: number; got: number; rated: number; changed: number }

const dayShift = (ymd: string, days: number): string => {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
};

export async function syncQuoteRatings(): Promise<QuoteRatingsReport | GuardSkip | JobSkip> {
  if (isKommoPaused()) return jobSkip("Kommo на паузі (KOMMO_PAUSED)");
  return guard(async () => {
    const to = kyivToday();
    const hm = await leadgenHandoffMoney(dayShift(to, -WINDOW_DAYS), to, { teamId: null, managerId: null });
    const ids = [...new Set(hm.deals.flatMap((d) => (d.inPeriod && d.dealId != null ? [d.dealId] : [])))];
    const report: QuoteRatingsReport = { asked: ids.length, got: 0, rated: 0, changed: 0 };
    for (let i = 0; i < ids.length; i += BATCH) {
      const part = ids.slice(i, i + BATCH);
      const leads = await fetchLeadsByIdsLean(part);
      if (leads.length === 0) throw new Error(`Kommo повернула 0 угод на запит ${String(part.length)} — оцінки не оновлено`);
      const got: number[] = [], vals: (number | null)[] = [];
      for (const l of leads) {
        const raw = l.custom_fields_values?.find((f) => f.field_id === FIELD_QUOTE_RATING)?.values?.[0]?.value;
        const v = parseQuoteRating(raw);
        got.push(l.id); vals.push(v);
        if (v != null) report.rated++;
      }
      report.got += got.length;
      const r = await pool.query(
        `UPDATE deals d SET quote_rating = v.rating
           FROM unnest($1::bigint[], $2::smallint[]) AS v(id, rating)
          WHERE d.kommo_id = v.id AND d.quote_rating IS DISTINCT FROM v.rating`, [got, vals]);
      report.changed += r.rowCount ?? 0;
    }
    console.log(`syncQuoteRatings: угод з передач за ${String(WINDOW_DAYS)} дн. ${String(report.asked)}, Kommo віддала ${String(report.got)}, `
      + `з оцінкою ${String(report.rated)}, змінено ${String(report.changed)}`);
    return report;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncQuoteRatings()
    .then((r) => { console.log(JSON.stringify(r)); return pool.end(); })
    .catch((err) => { console.error(err); process.exit(1); });
}
