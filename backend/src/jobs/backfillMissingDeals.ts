import { pool } from "../db/pool.js";
import {
  fetchLeadsByIds,
  fetchContactsByIds,
  fetchCompaniesByIds,
  extractPhone,
} from "../kommo/client.js";
import { upsertDeal, reclassifyAdChannel } from "./syncKommo.js";
import { backfillClientKey } from "./backfillClientKey.js";

/**
 * MASTER_PLAN КРОК 1.4 — бекфіл угод, які Є в Kommo і фігурують у
 * `deal_stage_events`, але ніколи не потрапили в таблицю `deals`.
 *
 * Причина діри: `syncKommo` дзеркалить угоди фільтром `updated_at` (перший
 * прохід — лише `now − 180 днів`), тож угода, виграна й «заснула» до того, як
 * синк почав вести історію, у `deals` не потрапляє ніколи. Доведено: за
 * червень–грудень 2025 у `deals` бракує 25–83% виграних угод повного циклу
 * (усього ~3.8 тис.). Історичні грошові метрики через це недорахували ту саму
 * частку. `deal_stage_events` бекфіляться по часовому вікну (незалежно від
 * `updated_at`), тому вони повніші — і саме вони дають перелік відсутніх id.
 *
 * Що робить: бере DISTINCT kommo_id з `deal_stage_events` за ВСІ стадії від
 * `--from` (дефолт 2025-06-01, старт відновленої історії), яких немає в
 * `deals`; тягне їх `fetchLeadsByIds` батчами по 250 (OOM-safe, той самий шлях,
 * що й syncKommo — контакти/компанії ЛИШЕ по id угод батчу); робить
 * ON CONFLICT upsert (той самий `upsertDeal`, тож price/payment_type/unload_at/
 * manager/client_key/lead_channel заповнюються коректно й ідемпотентно).
 *
 * ПІСЛЯ upsert обов'язково: `reclassifyAdChannel` (правильний канал по «останньому
 * дотику» — інакше нові угоди матимуть лише грубий канал з extractLeadSource) і
 * `backfillClientKey` (канонізація ключа). Без цього ламаються сегменти
 * (нові/постійні/лідоген) і конверсії.
 *
 *   node dist/jobs/backfillMissingDeals.js                 # from=2025-06-01
 *   node dist/jobs/backfillMissingDeals.js --from=2025-06-01
 *
 * ⚠️ НЕ запускати паралельно з прод-синком: `touch KOMMO_PAUSED` перед стартом.
 */
export async function backfillMissingDeals(fromDate = "2025-06-01"): Promise<void> {
  const idsRes = await pool.query<{ kommo_id: string }>(
    `SELECT DISTINCT e.kommo_id
       FROM deal_stage_events e
       LEFT JOIN deals d ON d.kommo_id = e.kommo_id
      WHERE d.kommo_id IS NULL
        AND (e.changed_at AT TIME ZONE 'Europe/Kyiv')::date >= $1::date
      ORDER BY e.kommo_id`,
    [fromDate]
  );
  const ids = idsRes.rows.map((r) => Number(r.kommo_id));
  console.log(`backfillMissingDeals: ${ids.length} відсутніх угод до дотягування (from=${fromDate}).`);
  if (ids.length === 0) {
    console.log("Нічого дотягувати — діри немає.");
    return;
  }

  const managerRows = await pool.query<{ id: number; kommo_user_id: string }>(
    `SELECT id, kommo_user_id FROM managers WHERE kommo_user_id IS NOT NULL`
  );
  const managerIdByKommoUserId = new Map(
    managerRows.rows.map((row) => [Number(row.kommo_user_id), row.id])
  );

  let fetched = 0,
    upserted = 0;
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    const deals = await fetchLeadsByIds(batch);
    fetched += deals.length;

    // Контакти/компанії ЛИШЕ по id угод батчу (ніколи fetchAll* — OOM).
    const contactIds = new Set<number>();
    const companyIds = new Set<number>();
    for (const deal of deals) {
      for (const c of deal._embedded?.contacts ?? []) contactIds.add(c.id);
      for (const c of deal._embedded?.companies ?? []) companyIds.add(c.id);
    }
    const contacts: Awaited<ReturnType<typeof fetchContactsByIds>> = [];
    const contactIdArr = [...contactIds];
    for (let j = 0; j < contactIdArr.length; j += 250) {
      contacts.push(...(await fetchContactsByIds(contactIdArr.slice(j, j + 250))));
    }
    const companies: Awaited<ReturnType<typeof fetchCompaniesByIds>> = [];
    const companyIdArr = [...companyIds];
    for (let j = 0; j < companyIdArr.length; j += 250) {
      companies.push(...(await fetchCompaniesByIds(companyIdArr.slice(j, j + 250))));
    }

    const contactById = new Map(
      contacts.map((c) => [c.id, { name: c.name, phone: extractPhone(c) }])
    );
    const companyNameById = new Map(companies.map((c) => [c.id, c.name]));

    for (const deal of deals) {
      await upsertDeal(deal, managerIdByKommoUserId, companyNameById, contactById);
      upserted += 1;
    }
    console.log(`  …${Math.min(i + 250, ids.length)}/${ids.length} (fetched ${fetched}, upserted ${upserted})`);
  }

  console.log(`backfillMissingDeals: дотягнуто ${upserted} угод. Запускаю reclassifyAdChannel + backfillClientKey…`);
  const reclassified = await reclassifyAdChannel();
  console.log(`reclassifyAdChannel: перекваліфіковано канал у ${reclassified} угодах.`);
  await backfillClientKey();
  console.log(`backfillMissingDeals complete.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fromArg = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1];
  backfillMissingDeals(fromArg || "2025-06-01")
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
