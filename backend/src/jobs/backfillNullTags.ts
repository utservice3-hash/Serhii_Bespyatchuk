import { pool } from "../db/pool.js";
import { extractTags, fetchLeadsByIds } from "../kommo/client.js";
import { FC_PIPELINES } from "../core/metrics.js";
import { LINKEDIN_TAG } from "../core/linkedinDeals.js";
import { PROZORRO_TAGS } from "../core/prozorroSource.js";
import { withHeavyJobLock } from "./jobLock.js";

/**
 * 🏷 РАЗОВИЙ ДОБІР ТЕГІВ для угод Повного циклу, у яких `deals.tags` ще NULL (задача 9230, 18.11.2026).
 *
 * Навіщо: колонки Звіту «зі створених: LinkedIn / Prozorro» беруть ознаку і з тегу. Синк пише `tags` лише угодам свого
 * вікна, тож угода, яку не чіпали після появи колонки (17.11.2026), лишається з `tags = NULL` і йде лише за джерелом.
 * Заміряно 18.11.2026: NULL у 3 559 з 6 296 угод Повного циклу, створених з 01.09.
 *
 * Чому не за подіями «тег додано», як `backfillLinkedinTags`: угода менеджера, яку Kommo створює з тендерної угоди
 * бота, приходить уже з тегом, і події «тег додано» на ній може не бути. Тут простіше й повніше: беремо ВСІ такі угоди
 * за id і читаємо їхні поточні теги з Kommo (250 на запит). Пише лише колонку `tags` і лише рядкам із `tags IS NULL`.
 * Запис — під `withHeavyJobLock`, як решта бекфілів (`syncKommo` на цей час пропускає прохід); сухий прогін замка не бере.
 *
 *   node dist/jobs/backfillNullTags.js                       # сухий прогін, угоди з 2026-09-01: лише числа, без запису
 *   node dist/jobs/backfillNullTags.js --since=2026-06-01    # інший початок (дата створення угоди, по-київськи)
 *   node dist/jobs/backfillNullTags.js --write               # записати — ЛИШЕ після «так» Романа
 *
 * Оборотність: колонку `tags` синк і так перезаписує кожним проходом угоди; відкат коду колонку не чистить.
 */
export async function backfillNullTags(opts: { since: string; write: boolean }): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) throw new Error(`--since має бути РРРР-ММ-ДД, отримано «${opts.since}»`);
  // Сухий прогін лише читає (SELECT і GET у Kommo, ~15 запитів), тож замок не бере: інакше сам замір писав би в
  // `job_locks` прода й зупиняв `syncKommo`. Запис — під замком, як решта бекфілів.
  const run = (fn: () => Promise<void>): Promise<void> => (opts.write ? withHeavyJobLock("backfill", fn) : fn());
  await run(async () => {
    const ids = (await pool.query<{ kommo_id: string }>(
      `SELECT kommo_id::text AS kommo_id FROM deals
        WHERE tags IS NULL AND pipeline_id = ANY($1::bigint[])
          AND (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
        ORDER BY kommo_id`, [FC_PIPELINES, opts.since])).rows.map((r) => Number(r.kommo_id));
    console.log(`backfillNullTags: угод Повного циклу з ${opts.since} без прочитаних тегів: ${String(ids.length)}.`);
    const watch = [LINKEDIN_TAG, ...PROZORRO_TAGS];
    const withTag = new Map<string, number>(watch.map((t) => [t, 0]));
    let read = 0, anyTags = 0, noTagsKey = 0, updated = 0;
    for (let i = 0; i < ids.length; i += 250) {
      const batch = ids.slice(i, i + 250);
      const leads = await fetchLeadsByIds(batch);
      read += leads.length;
      for (const lead of leads) {
        const tags = extractTags(lead);
        if (tags == null) { noTagsKey++; continue; }
        if (tags.length) anyTags++;
        for (const t of watch) if (tags.includes(t)) withTag.set(t, (withTag.get(t) ?? 0) + 1);
        if (opts.write) {
          const r = await pool.query(`UPDATE deals SET tags = $2::text[] WHERE kommo_id = $1 AND tags IS NULL`, [lead.id, tags]);
          updated += r.rowCount ?? 0;
        }
      }
    }
    console.log(`  прочитано з Kommo: ${String(read)} із ${String(ids.length)} · Kommo не віддав (видалені?): ${String(ids.length - read)} · без ключа тегів: ${String(noTagsKey)}`);
    console.log(`  мають хоч один тег: ${String(anyTags)} · ${watch.map((t) => `«${t}» ${String(withTag.get(t) ?? 0)}`).join(" · ")}`);
    console.log(opts.write ? `  ЗАПИСАНО: оновлено рядків ${String(updated)}.` : "  СУХИЙ ПРОГІН: нічого не записано (додай --write).");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-09-01";
  backfillNullTags({ since, write: process.argv.includes("--write") })
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
