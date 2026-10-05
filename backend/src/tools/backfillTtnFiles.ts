/**
 * 🗂 РАЗОВЕ ДОТЯГУВАННЯ `deals.ttn_files` для ТТН-моніторингу (05.10.2026, рішення Романа).
 *
 * Нова колонка заповнюється звичайним `syncKommo` лише для угод, які змінились ПІСЛЯ викату. Старі
 * угоди (закриті місяці тому) синк уже не побачить — тож їх дотягуємо раз, читаючи Kommo по id.
 * Пишеться ЛИШЕ одна колонка; у CRM нічого не пишеться.
 *
 * Запуск (на сервері, у теці `backend`, після викату):
 *   node dist/tools/backfillTtnFiles.js --dry                     # порахувати, НІЧОГО не писати
 *   node dist/tools/backfillTtnFiles.js --write [--from=2026-04-01]
 *
 * Обсяг 05.10.2026: 3 793 угоди квітень–вересень → ≈16 запитів по 250 id (межа `fetchLeadsByIds`).
 * Під `withHeavyJobLock`: `syncKommo` побачить heartbeat і пропустить прохід, а не накладеться
 * й не пробʼє ліміт Kommo. Ідемпотентно: бере лише угоди з `ttn_files IS NULL`.
 * Угода, якої Kommo не віддав (видалена), лишається NULL і ВИДНА числом «не повернув Kommo».
 */
import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractTtnFiles } from "../kommo/client.js";
import { withHeavyJobLock } from "../jobs/jobLock.js";
import { TTN_PIPELINE_ID, TTN_STATUS_ID, TTN_PAYMENT_TYPES } from "../core/baRules.js";

const WRITE = process.argv.includes("--write");
const FROM = process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? "2026-04-01";
const BATCH = 250;

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM)) throw new Error("--from у форматі РРРР-ММ-ДД");
  const ids = (await pool.query<{ kommo_id: string; ym: string }>(
    `SELECT kommo_id, to_char((closed_at_kommo AT TIME ZONE 'Europe/Kyiv'), 'YYYY-MM') AS ym FROM deals
      WHERE pipeline_id = $1 AND status_id = $2 AND payment_type = ANY($3::text[]) AND ttn_files IS NULL
        AND (closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $4::date
      ORDER BY kommo_id`, [TTN_PIPELINE_ID, TTN_STATUS_ID, [...TTN_PAYMENT_TYPES], FROM])).rows;
  const byMonth: Record<string, number> = {};
  for (const r of ids) byMonth[r.ym] = (byMonth[r.ym] ?? 0) + 1;
  console.log(`угод без ttn_files з ${FROM}: ${ids.length} · по місяцях: ${JSON.stringify(byMonth)} · запитів до Kommo: ${Math.ceil(ids.length / BATCH)}`);
  if (!WRITE) { console.log("\n— це `--dry`: у базу НЕ записано нічого. Запис: --write"); await pool.end(); return; }

  const res = await withHeavyJobLock("backfillTtnFiles", async () => {
    let written = 0, attached = 0, missing = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH).map((x) => Number(x.kommo_id));
      const leads = await fetchLeadsByIds(chunk);
      const got = new Map(leads.map((l) => [l.id, extractTtnFiles(l)]));
      missing += chunk.filter((id) => !got.has(id)).length;
      for (const [id, n] of got) {
        await pool.query(`UPDATE deals SET ttn_files = $2 WHERE kommo_id = $1 AND ttn_files IS NULL`, [id, n]);
        written++;
        if (n > 0) attached++;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return { written, attached, missing };
  });
  console.log(`✅ записано угод: ${res.written} · з них з ТТН: ${res.attached} · не повернув Kommo: ${res.missing}`);
  await pool.end();
}

main().catch(async (e) => { console.error("🔴", (e as Error).message); await pool.end().catch(() => undefined); process.exit(1); });
