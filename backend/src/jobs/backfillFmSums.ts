import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractFmIncome, extractFmExpense, LEADS_BY_IDS_MAX } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";

/**
 * 💰 РАЗОВИЙ БЕКФІЛ СУМ ЗА ПРАВИЛОМ ФІНАНСИСТА (`deals.fm_income` / `fm_expense`, прохід 2б, 01.10.2026).
 *
 * Синк пише ці колонки щопрохід, але лише угодам, які Kommo відтоді змінював. Автоматичним рядкам «ФМ» потрібні
 * угоди воронки «Повний цикл», що стосуються періодів від 29.12.2025 (дата створення, загрузки чи закриття) —
 * саме вони потрапляють у фільтри фінансиста. Решту бази НЕ тягнемо (урок КРОКУ 1.4: 35 тис. угод випалили
 * compute-квоту Neon). Перед записом — сухий прогін з кількістю.
 *
 * 🔒 Під `withHeavyJobLock`: `UPDATE` по `deals` конкурує з `syncKommo`. Батчі по 250 у порядку `kommo_id`,
 * кожен — окремий короткий запит; збій посередині втрачає лише батч, повторний запуск догонить решту (`IS NULL`).
 *
 *   node dist/jobs/backfillFmSums.js            # сухий прогін
 *   node dist/jobs/backfillFmSums.js --write    # із записом
 */
export async function backfillFmSums(opts: { write?: boolean; since?: string } = {}) {
  const since = opts.since ?? "2025-12-29";
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
      for (const l of leads.sort((a, b) => a.id - b.id)) {
        const r = await pool.query(`UPDATE deals SET fm_income = $2, fm_expense = $3 WHERE kommo_id = $1`, [l.id, extractFmIncome(l), extractFmExpense(l)]);
        updated += r.rowCount ?? 0;
      }
      console.log(`  батч ${i / LEADS_BY_IDS_MAX + 1}: отримано ${leads.length}, разом оновлено ${updated}`);
    }
    return { candidates: ids.length, fetched, updated };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backfillFmSums({ write: process.argv.includes("--write") })
    .then((r) => { console.log(JSON.stringify(r)); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
