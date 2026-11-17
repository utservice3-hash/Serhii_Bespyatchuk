import { pool } from "../db/pool.js";
import { extractTags, fetchLeadsByIds, forEachTagAddedEventPage } from "../kommo/client.js";
import { LINKEDIN_TAG } from "../core/linkedinDeals.js";
import { leadIdsWithTag } from "../core/linkedinTagEvents.js";
import { withHeavyJobLock } from "./jobLock.js";

/**
 * 🏷 РАЗОВИЙ ДОБІР ТЕГІВ для угод із тегом «LinkedIn» (задача 9363, «роби» Романа 17.11.2026).
 *
 * Синк пише `deals.tags` лише угодам свого вікна, тож угода, якій тег поставили до появи колонки і яку відтоді не
 * чіпали, лишилась би з `tags = NULL` і зникла б з «Усі угоди з LinkedIn». Тут: події «тег додано» помісячно →
 * угоди, яким колись додали тег LinkedIn → їхні ПОТОЧНІ теги з Kommo (тег могли й зняти) → `UPDATE deals SET tags`.
 * Пише лише колонку `tags` і лише рядкам, що вже є в `deals`; угод, яких у таблиці немає, не створює — їх називає.
 * Під `withHeavyJobLock`, як решта бекфілів: `syncKommo` на цей час пропускає прохід.
 *
 *   node dist/jobs/backfillLinkedinTags.js                    # сухий прогін з 01.2025: лише числа, без запису
 *   node dist/jobs/backfillLinkedinTags.js --write            # записати
 *   node dist/jobs/backfillLinkedinTags.js --from=2025-06     # інший початок
 *
 * Оборотність: колонку `tags` синк і так перезаписує кожним проходом; відкат коду колонку не прибирає.
 */
export async function backfillLinkedinTags(opts: { from: string; write: boolean }): Promise<void> {
  await withHeavyJobLock("backfill", async () => {
    const [fy, fm] = opts.from.split("-").map(Number);
    if (!fy || !fm) throw new Error(`--from має бути РРРР-ММ, отримано «${opts.from}»`);
    const ids = new Set<number>();
    let events = 0;
    const now = new Date();
    for (let y = fy, m = fm; y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1); m === 12 ? (y++, m = 1) : m++) {
      // Межі місяця по-київськи з запасом на годину переходу: подія на межі потрапить в обидва місяці, Set прибере дубль.
      const from = Math.floor(Date.UTC(y, m - 1, 1) / 1000) - 4 * 3600;
      const to = Math.floor(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) / 1000) - 2 * 3600;
      let found = 0;
      const r = await forEachTagAddedEventPage(from, to, async (page) => {
        const hit = leadIdsWithTag(page, LINKEDIN_TAG);
        for (const id of hit) ids.add(id);
        found += hit.length;
      });
      events += r.total;
      console.log(`  ${String(y)}-${String(m).padStart(2, "0")}: подій «тег додано» ${String(r.total)}, з тегом ${LINKEDIN_TAG} ${String(found)}${r.capped ? " ⚠️ СТЕЛЯ сторінок — місяць прочитано не весь" : ""}`);
    }
    const all = [...ids].sort((a, b) => a - b);
    console.log(`backfillLinkedinTags: подій ${String(events)}, угод із тегом ${LINKEDIN_TAG} колись: ${String(all.length)}.`);
    const known = new Set((await pool.query<{ kommo_id: string }>(`SELECT kommo_id::text AS kommo_id FROM deals WHERE kommo_id = ANY($1::bigint[])`, [all]))
      .rows.map((r) => Number(r.kommo_id)));
    const missing = all.filter((id) => !known.has(id));
    let stillTagged = 0, updated = 0, noTagsKey = 0;
    for (let i = 0; i < all.length; i += 250) {
      const batch = all.slice(i, i + 250).filter((id) => known.has(id));
      if (!batch.length) continue;
      for (const lead of await fetchLeadsByIds(batch)) {
        const tags = extractTags(lead);
        if (tags == null) { noTagsKey++; continue; }
        if (tags.includes(LINKEDIN_TAG)) stillTagged++;
        if (opts.write) {
          const r = await pool.query(`UPDATE deals SET tags = $2::text[] WHERE kommo_id = $1 AND tags IS DISTINCT FROM $2::text[]`, [lead.id, tags]);
          updated += r.rowCount ?? 0;
        }
      }
    }
    console.log(`  у нашій таблиці угод: ${String(known.size)} · тег стоїть зараз: ${String(stillTagged)} · Kommo без ключа тегів: ${String(noTagsKey)}`);
    console.log(`  немає в таблиці угод (не створюємо): ${String(missing.length)}${missing.length ? ` — ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}` : ""}`);
    console.log(opts.write ? `  ЗАПИСАНО: оновлено рядків ${String(updated)}.` : "  СУХИЙ ПРОГІН: нічого не записано (додай --write).");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const from = process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? "2025-01";
  backfillLinkedinTags({ from, write: process.argv.includes("--write") })
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
