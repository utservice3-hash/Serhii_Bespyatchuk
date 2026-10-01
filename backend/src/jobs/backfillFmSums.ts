import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractFmIncome, extractFmExpense, LEADS_BY_IDS_MAX } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";

/**
 * 💰 РАЗОВИЙ БЕКФІЛ СУМ ЗА ПРАВИЛОМ ФІНАНСИСТА (`deals.fm_income` / `fm_expense`, прохід 2б, 01.10.2026).
 *
 * Синк пише ці колонки щопрохід, але лише угодам, які Kommo відтоді змінював. Автоматичним рядкам «ФМ» потрібні
 * угоди воронки «Повний цикл» від тижня 28.09.2026 (дата створення, загрузки чи закриття — разом із майбутніми
 * датами загрузки): автоматика рахує з 05.10, минуле — числа з таблиці (рішення Романа 01.10.2026). Заміряно: 1 041 угода.
 * Решту бази НЕ тягнемо (урок КРОКУ 1.4: 35 тис. угод випалили
 * compute-квоту Neon). Перед записом — сухий прогін з кількістю.
 *
 * 🔒 Під `withHeavyJobLock`: `UPDATE` по `deals` конкурує з `syncKommo`. Батчі по 250 у порядку `kommo_id`,
 * кожен — ОДИН запит `UPDATE … FROM unnest(…)`; збій посередині втрачає лише батч, повторний запуск догонить решту (`IS NULL`).
 *
 *   node dist/jobs/backfillFmSums.js            # сухий прогін
 *   node dist/jobs/backfillFmSums.js --write    # із записом
 *   node dist/jobs/backfillFmSums.js --since=2026-09-01 --write   # вужче вікно
 */
export async function backfillFmSums(opts: { write?: boolean; since?: string } = {}) {
  const since = opts.since ?? "2026-09-28"; // тиждень перед стартом автоматики (FM_AUTO_FROM): минуле — з таблиці
  const ids = (await pool.query<{ kommo_id: string }>(
    `SELECT kommo_id FROM deals
      WHERE pipeline_id = 8921932 AND fm_income IS NULL AND fm_expense IS NULL
        AND (created_at_kommo >= $1::date OR load_at >= $1::date OR closed_at_kommo >= $1::date)
      ORDER BY kommo_id`, [since])).rows.map((r) => Number(r.kommo_id));
  console.log(`угод до перерахунку: ${ids.length} (з ${since})`);
  if (!opts.write) return { candidates: ids.length, updated: 0, fetched: 0 };
  return withHeavyJobLock("backfillFmSums", async () => {
    let fetched = 0, updated = 0;
    for (let i = 0; i < ids.length; i += LEADS_BY_IDS_MAX) {
      const leads = await fetchLeadsByIds(ids.slice(i, i + LEADS_BY_IDS_MAX));
      fetched += leads.length;
      // один UPDATE на батч (не 250): Neon платить за кожен запит, а рядки беруться в порядку kommo_id, як у синку
      const sorted = leads.sort((a, b) => a.id - b.id);
      const r = await pool.query(`UPDATE deals d SET fm_income = x.inc, fm_expense = x.exp
          FROM unnest($1::bigint[], $2::numeric[], $3::numeric[]) AS x(id, inc, exp) WHERE d.kommo_id = x.id`,
        [sorted.map((l) => l.id), sorted.map(extractFmIncome), sorted.map(extractFmExpense)]);
      updated += r.rowCount ?? 0;
      console.log(`  батч ${i / LEADS_BY_IDS_MAX + 1}: отримано ${leads.length}, разом оновлено ${updated}`);
    }
    return { candidates: ids.length, fetched, updated };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8);
  backfillFmSums({ write: process.argv.includes("--write"), since })
    .then((r) => { console.log(JSON.stringify(r)); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
