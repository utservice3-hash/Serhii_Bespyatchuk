/**
 * 🔄 `syncDealResponsible` — зміни відповідального УСПІШНИХ угод «Повного циклу» поточного й минулого місяця з Kommo у
 * `deal_responsible_events`, щоночі о 04:50 (+ разовий бекфіл `--month=2026-09`). Потрібно «Результату місяця»: угоду
 * рахуємо тому, хто був відповідальним У МОМЕНТ ЗАКРИТТЯ (23.10.2026: 15.10 угоди Янчевського перепризначили на
 * Михальчевську). Події питаються ПО УГОДАХ (`fetchResponsibleEventsForLeads`, 10 за запит): потоком їх ~3 000 на добу.
 * Пропуск — `jobSkip`, а не успіх; обсяг — у підсумку. Лише читає Kommo.
 */
import { pool } from "../db/pool.js";
import { fetchResponsibleEventsForLeads } from "../kommo/client.js";
import { jobSkip } from "./jobRuns.js";
import { FULL_CYCLE_PIPELINES, monthsToCheck } from "../core/monthResult.js";

const CEILING_MS = 30 * 60_000;
let running: number | null = null;

export async function syncDealResponsible(opts: { months?: string[] } = {}): Promise<unknown> {
  if (running && Date.now() - running < CEILING_MS) return jobSkip("Відповідальні угод: попередній прохід ще йде");
  running = Date.now();
  try {
    const months = opts.months ?? monthsToCheck(new Date());
    const ids = (await pool.query<{ id: string }>(`SELECT kommo_id::text AS id FROM deals WHERE status_id = 142 AND pipeline_id = ANY($1)
        AND date_trunc('month', closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date = ANY($2::date[])`, [[...FULL_CYCLE_PIPELINES], months])).rows.map((x) => Number(x.id));
    const ev = await fetchResponsibleEventsForLeads(ids);
    if (ev.length) await pool.query(`INSERT INTO deal_responsible_events (kommo_id, changed_at, from_user_id, to_user_id)
      SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::bigint[], $4::bigint[]) ON CONFLICT (kommo_id, changed_at) DO NOTHING`,
    [ev.map((e) => e.entityId), ev.map((e) => new Date(e.changedAt * 1000)), ev.map((e) => e.fromUserId ?? null), ev.map((e) => e.toUserId)]);
    await pool.query(`INSERT INTO deal_responsible_state (id, watermark) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET watermark = now()`);
    return { months, deals: ids.length, events: ev.length };
  } finally { running = null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.find((a) => a.startsWith("--month="));
  syncDealResponsible(arg ? { months: arg.slice(8).split(",").map((m) => `${m.slice(0, 7)}-01`) } : {})
    .then((r) => console.log("syncDealResponsible:", JSON.stringify(r))).catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
