import { pool } from "../db/pool.js";
import { fetchCompaniesByIds } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";
import { companyPhones } from "../core/companyCode.js";

/**
 * ☎️ РАЗОВЕ ДОЗАПОВНЕННЯ ТЕЛЕФОНІВ КАРТОК КОМПАНІЙ (задача 7359, 03.11.2026).
 *
 * Синк віднині пише `kommo_companies.phones` сам, але лише для компаній свого вікна. Ця джоба дочитує решту — тих,
 * у кого `phones IS NULL` («ще не прочитано»). Заміряно 03.11: 22 726 компаній → ~91 запит по 250.
 * Темп і замок — як у `backfillCompanies`: 700 мс між запитами (після IP-бану 08.07.2026), під `job_locks`, щоб
 * `syncKommo` пропускав прохід. Компанія, якої Kommo не віддав (видалена), лишається NULL — і це видно як «не прочитано».
 * Повторний запуск безпечний: бере лише NULL.
 *
 * Запуск на проді (разово, після викату): `node -e "import('./dist/jobs/backfillCompanyPhones.js').then(m=>m.backfillCompanyPhones()).then(r=>{console.log(r);process.exit(0)})"`.
 */
/** Запис телефонів пачки компаній: `$1` — id, `$2` — JSON-масиви номерів. Лише ще не прочитані (`phones IS NULL`). */
export const COMPANY_PHONES_UPDATE_SQL = `
  UPDATE kommo_companies k SET phones = ARRAY(SELECT jsonb_array_elements_text(v.ph)), updated_at = now()
    FROM (SELECT UNNEST($1::bigint[]) AS id, UNNEST($2::jsonb[]) AS ph) v
   WHERE k.company_id = v.id AND k.phones IS NULL`;

const BATCH = 250;
const THROTTLE_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CompanyPhonesBackfill { todo: number; requests: number; written: number; withPhone: number; leftNull: number }

export async function backfillCompanyPhones(): Promise<CompanyPhonesBackfill> {
  return withHeavyJobLock("backfillCompanyPhones", async () => {
    const ids = (await pool.query<{ company_id: string }>(
      "SELECT company_id FROM kommo_companies WHERE phones IS NULL ORDER BY company_id")).rows.map((r) => Number(r.company_id));
    let requests = 0, written = 0, withPhone = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const companies = await fetchCompaniesByIds(ids.slice(i, i + BATCH));
      requests++;
      if (companies.length) {
        const phones = companies.map((c) => companyPhones(c.custom_fields_values));
        withPhone += phones.filter((p) => p.length > 0).length;
        const r = await pool.query(COMPANY_PHONES_UPDATE_SQL, [companies.map((c) => c.id), phones.map((p) => JSON.stringify(p))]);
        written += r.rowCount ?? 0;
      }
      if ((i / BATCH) % 10 === 0) console.log(`  ${String(Math.min(i + BATCH, ids.length))}/${String(ids.length)} · записано ${String(written)} · з телефоном ${String(withPhone)}`);
      await sleep(THROTTLE_MS);
    }
    const leftNull = Number((await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM kommo_companies WHERE phones IS NULL")).rows[0].n);
    return { todo: ids.length, requests, written, withPhone, leftNull };
  });
}
