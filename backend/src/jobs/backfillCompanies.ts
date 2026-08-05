import { pool } from "../db/pool.js";
import { fetchLeadsByIds, fetchCompaniesByIds, type KommoDeal, type KommoCompany } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";
import { runJob } from "./jobRuns.js";
import { splitCompanyCodes } from "../core/companyCode.js";
import { companyFieldValue, COMPANY_FIELD_EDRPOU, COMPANY_FIELD_IPN } from "../kommo/client.js";

/**
 * 🏢 БЕКФІЛ «угода → компанія → код» за 12 місяців.
 *
 * Штатно звʼязок і коди пише `syncKommo` зі свого вікна — але угоди, які давно не
 * рухались, у це вікно не потрапляють. Без бекфілу правило дублів за кодом бачило б
 * лише свіжі угоди, тобто мовчки працювало б на частині даних.
 *
 * 🔴 ТЕМП ВАЖЛИВІШИЙ ЗА ШВИДКІСТЬ. Після IP-бану 08.07.2026 темп до Kommo свідомо
 * знижений. Тому: помісячно, з паузою між батчами, під `job_locks` (щоб `syncKommo`
 * пропускав прохід і потоки не наклались), із друком ОБСЯГУ на кожному місяці —
 * «зелена джоба ≠ дані йдуть», для імпортера перевіряють привезене, а не мовчання.
 *
 * ⚠️ ДВА ВИДИ ЗАПИТІВ, і рахуємо їх ОКРЕМО:
 *   · `fetchLeadsByIds` — щоб дізнатись, ЯКІ компанії привʼязані до угод (250/запит);
 *   · `fetchCompaniesByIds` — щоб отримати кастом-поля з кодом (250/запит).
 * У штатному синку другий вид уже виконується заради назви компанії, тож там
 * бекфіл нічого не додає — додає лише цей разовий прохід.
 */

const BATCH = 250;
/** Пауза між батчами. 400 мс ≈ 2.5 запити/с — удвічі повільніше за ліміт Kommo. */
const THROTTLE_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CompanyBackfillStats {
  months: number; deals: number; leadRequests: number; companyRequests: number;
  companies: number; withCode: number; links: number;
}

async function upsertBatch(deals: KommoDeal[], companies: KommoCompany[]): Promise<{ links: number; withCode: number }> {
  let withCode = 0;
  if (companies.length) {
    const uniq = [...new Map(companies.map((c) => [c.id, c])).values()];
    const codes = uniq.map((c) => splitCompanyCodes(
      companyFieldValue(c, COMPANY_FIELD_EDRPOU), companyFieldValue(c, COMPANY_FIELD_IPN)));
    withCode = codes.filter((c) => c.edrpou || c.ipn).length;
    await pool.query(
      `INSERT INTO kommo_companies (company_id, name, edrpou_raw, edrpou, ipn_raw, ipn, updated_at)
       SELECT * FROM (SELECT UNNEST($1::bigint[]) AS id, UNNEST($2::text[]) AS nm,
                             UNNEST($3::text[]) AS er, UNNEST($4::text[]) AS e,
                             UNNEST($5::text[]) AS ir, UNNEST($6::text[]) AS i, now() AS u) v
       ON CONFLICT (company_id) DO UPDATE SET
         name = EXCLUDED.name, edrpou_raw = EXCLUDED.edrpou_raw, edrpou = EXCLUDED.edrpou,
         ipn_raw = EXCLUDED.ipn_raw, ipn = EXCLUDED.ipn, updated_at = now()`,
      [uniq.map((c) => c.id), uniq.map((c) => c.name ?? null),
       uniq.map((c) => companyFieldValue(c, COMPANY_FIELD_EDRPOU)), codes.map((c) => c.edrpou),
       uniq.map((c) => companyFieldValue(c, COMPANY_FIELD_IPN)), codes.map((c) => c.ipn)]);
  }
  // Дедуп пар — той самий урок 03.08.2026: один INSERT не може зачепити рядок двічі.
  const seen = new Set<string>();
  const dealIds: number[] = [], companyIds: number[] = [];
  for (const d of deals)
    for (const c of d._embedded?.companies ?? []) {
      const k = `${d.id}|${c.id}`;
      if (seen.has(k)) continue;
      seen.add(k); dealIds.push(d.id); companyIds.push(c.id);
    }
  if (dealIds.length)
    await pool.query(
      `INSERT INTO deal_companies (deal_kommo_id, company_id, updated_at)
       SELECT * FROM (SELECT UNNEST($1::bigint[]) AS d, UNNEST($2::bigint[]) AS c, now() AS u) v
       ON CONFLICT (deal_kommo_id, company_id) DO UPDATE SET updated_at = now()`,
      [dealIds, companyIds]);
  return { links: dealIds.length, withCode };
}

export async function backfillCompanies(months = 12): Promise<CompanyBackfillStats> {
  return withHeavyJobLock("backfillCompanies", async () => {
    const st: CompanyBackfillStats = {
      months, deals: 0, leadRequests: 0, companyRequests: 0, companies: 0, withCode: 0, links: 0 };

    for (let m = 0; m < months; m++) {
      // Помісячно й від найсвіжішого: якщо прохід доведеться спинити, зупинимось
      // на старих даних, а не на тих, якими користуються щодня.
      const r = await pool.query<{ kommo_id: string }>(
        `SELECT d.kommo_id FROM deals d
          WHERE (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date
                >= (date_trunc('month', CURRENT_DATE) - make_interval(months => $1))::date
            AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date
                <  (date_trunc('month', CURRENT_DATE) - make_interval(months => $2))::date
          ORDER BY d.kommo_id`, [m, m - 1]);
      const ids = r.rows.map((x) => Number(x.kommo_id));
      if (!ids.length) { console.log(`backfillCompanies: місяць -${m} — угод немає`); continue; }

      let mDeals = 0, mLinks = 0, mCompanies = 0, mWithCode = 0;
      for (let i = 0; i < ids.length; i += BATCH) {
        const leads = await fetchLeadsByIds(ids.slice(i, i + BATCH));
        st.leadRequests++;
        mDeals += leads.length;
        const companyIds = [...new Set(leads.flatMap((d) => (d._embedded?.companies ?? []).map((c) => c.id)))];
        let companies: KommoCompany[] = [];
        for (let j = 0; j < companyIds.length; j += BATCH) {
          companies = companies.concat(await fetchCompaniesByIds(companyIds.slice(j, j + BATCH)));
          st.companyRequests++;
          await sleep(THROTTLE_MS);
        }
        const res = await upsertBatch(leads, companies);
        mLinks += res.links; mCompanies += companies.length; mWithCode += res.withCode;
        await sleep(THROTTLE_MS);
      }
      st.deals += mDeals; st.links += mLinks; st.companies += mCompanies; st.withCode += mWithCode;
      // 🔴 ОБСЯГ, А НЕ «відпрацювало»: для джоби-імпортера тиша нічого не означає.
      console.log(`backfillCompanies: місяць -${m} → угод ${mDeals}, лінків ${mLinks}, `
        + `компаній ${mCompanies} (з кодом ${mWithCode})`);
    }
    console.log(`backfillCompanies ПІДСУМОК: угод ${st.deals}, лінків ${st.links}, `
      + `компаній ${st.companies} (з кодом ${st.withCode}), запитів: leads ${st.leadRequests} + `
      + `companies ${st.companyRequests} = ${st.leadRequests + st.companyRequests}`);
    return st;
  });
}

if (process.argv[1]?.endsWith("backfillCompanies.js") || process.argv[1]?.endsWith("backfillCompanies.ts")) {
  const arg = process.argv.find((a) => a.startsWith("--months="));
  const months = arg ? Number(arg.split("=")[1]) : 12;
  runJob("backfillCompanies", () => backfillCompanies(months))
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
