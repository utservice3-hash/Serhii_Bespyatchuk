import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractTakenInWork, forEachLeadNotePageByIds, forEachContactNotePageByIds } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";
import { QUALIFICATION_PIPELINES } from "../core/leadgenStages.js";

/**
 * ⏱ ДОЗАПОВНЕННЯ ДВОХ ПОДІЙ «ВЗЯТО В РОБОТУ» (вікно «Час опрацювання заявки», ТЗ Юлії 24.09.2026).
 *
 * Синк пише `taken_field_at` (поле «Взято в работу») і джоба активності — `first_call_out_at` (перший
 * вихідний дзвінок) лише ВІДТЕПЕР. Юлин критерій приймання — період 01–23.09, тож заявки з `--since`
 * (за замовчуванням 01.09.2026) перераховуються ТОЧНО, по повній історії сутностей:
 *   • поле — `fetchLeadsByIds` пачками по 250;
 *   • дзвінок — примітки угоди І примітки її контактів (Ringostat вішає дзвінки на контакт), найраніший
 *     `call_out`, не раніше створення угоди. Значення ставиться, а не `LEAST`-иться: це повна історія.
 *
 * Обсяг: лише воронки «Кваліфікація» і «Повний цикл» (там живуть заявки). Заміряно 02.10.2026 —
 * ~4 800 угод за 01–23.09, тобто ~20 запитів за полем і ~100 за примітками. Під `withHeavyJobLock`:
 * `syncKommo` на цей час пропускає проходи, щоб не скласти два потоки до Kommo.
 * CLI: `node dist/jobs/backfillTakeEvents.js [--since=2026-09-01] [--dry]`
 */
const FC = [8921932, 155304];
const BATCH_NOTES = 100;

export async function backfillTakeEvents(opts: { since: string; dry?: boolean }): Promise<{ deals: number; field: number; calls: number }> {
  // Сухий прогін нічого не пише — ні в угоди, ні в `job_locks`: його можна ганяти роллю лише-читання.
  return opts.dry ? run(opts) : withHeavyJobLock("backfill", () => run(opts));
}

async function run(opts: { since: string; dry?: boolean }): Promise<{ deals: number; field: number; calls: number }> {
  {
    const rows = (await pool.query<{ kommo_id: string; created: Date }>(
      `SELECT kommo_id, created_at_kommo AS created FROM deals
        WHERE pipeline_id = ANY($1) AND (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
        ORDER BY kommo_id`, [[...QUALIFICATION_PIPELINES, ...FC], opts.since])).rows;
    const ids = rows.map((r) => Number(r.kommo_id));
    const created = new Map(rows.map((r) => [Number(r.kommo_id), r.created.getTime() / 1000]));
    console.log(`backfillTakeEvents: угод ${ids.length} з ${opts.since}${opts.dry ? " (dry — без запису)" : ""}`);
    if (!ids.length) throw new Error("backfillTakeEvents: угод НУЛЬ — це провал, не порожня база");

    // 1) Поле «Взято в работу».
    const field = new Map<number, Date | null>();
    for (let i = 0; i < ids.length; i += 250) {
      for (const d of await fetchLeadsByIds(ids.slice(i, i + 250))) field.set(d.id, extractTakenInWork(d));
    }

    // 2) Перший вихідний дзвінок — нотатки угоди й контактів.
    const firstOut = new Map<number, number>();
    const take = (dealId: number, at: number, type: string): void => {
      const c = created.get(dealId);
      if (type !== "call_out" || c == null || at < c) return;
      const f = firstOut.get(dealId);
      if (f == null || at < f) firstOut.set(dealId, at);
    };
    for (let i = 0; i < ids.length; i += BATCH_NOTES)
      await forEachLeadNotePageByIds(ids.slice(i, i + BATCH_NOTES), async (ns) => { for (const n of ns) take(n.entityId, n.createdAt, n.noteType); });
    const link = (await pool.query<{ contact_id: string; deal_kommo_id: string }>(
      `SELECT contact_id, deal_kommo_id FROM deal_contacts WHERE deal_kommo_id = ANY($1::bigint[])`, [ids])).rows;
    const byContact = new Map<number, number[]>();
    for (const r of link) byContact.set(Number(r.contact_id), [...(byContact.get(Number(r.contact_id)) ?? []), Number(r.deal_kommo_id)]);
    const contacts = [...byContact.keys()];
    for (let i = 0; i < contacts.length; i += BATCH_NOTES)
      await forEachContactNotePageByIds(contacts.slice(i, i + BATCH_NOTES), async (ns) => {
        for (const n of ns) for (const d of byContact.get(n.entityId) ?? []) take(d, n.createdAt, n.noteType);
      });

    const fieldN = [...field.values()].filter(Boolean).length;
    console.log(`backfillTakeEvents: поле заповнене в ${fieldN}, вихідний дзвінок знайдено в ${firstOut.size} з ${ids.length}`);
    if (!opts.dry) {
      for (let i = 0; i < ids.length; i += 1000) {
        const part = ids.slice(i, i + 1000);
        await pool.query(
          `UPDATE deals d SET taken_field_at = v.f, first_call_out_at = v.co
             FROM (SELECT UNNEST($1::bigint[]) AS kommo_id, UNNEST($2::timestamptz[]) AS f, UNNEST($3::timestamptz[]) AS co) v
            WHERE d.kommo_id = v.kommo_id`,
          [part, part.map((id) => field.get(id) ?? null), part.map((id) => (firstOut.has(id) ? new Date(firstOut.get(id)! * 1000) : null))]);
      }
    }
    if (opts.dry) {
      // Для звірки з Юлиним заміром: розподіл по рекламній множині (джерела uts.ua) за 01–23.09.
      const site = (await pool.query<{ kommo_id: string }>(
        `SELECT kommo_id FROM deals WHERE kommo_id = ANY($1::bigint[])
            AND client_source IN ('Дзвінок з uts.ua','uts.ua','Callback з uts.ua')`, [ids])).rows.map((r) => Number(r.kommo_id));
      console.log(`  з них рекламних (uts.ua): ${site.length}; поле: ${site.filter((id) => field.get(id)).length}; дзвінок: ${site.filter((id) => firstOut.has(id)).length}`);
    }
    return { deals: ids.length, field: fieldN, calls: firstOut.size };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-09-01";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.error("--since=YYYY-MM-DD"); process.exit(2); }
  backfillTakeEvents({ since, dry: process.argv.includes("--dry") })
    .then((r) => { console.log("готово:", JSON.stringify(r)); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
