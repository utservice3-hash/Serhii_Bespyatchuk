import type { Db } from "./adCallFacts.js";
import type { StageLead } from "./linkedinQueue.js";

/**
 * 📅 Угоди етапу «LinkedIn» від створення етапу (Роман 06.11.2026): «по старих угодах можемо просто показати скільки
 * створено і в яку дату, інші етапи не відстежуємо, тільки через бота потім». Без пулу — гейт `#3416` ганяє це на
 * scratch-базі. Джерело — Kommo: тік черги дописує тих, хто ЗАРАЗ на етапі, а раз на добу `sweepStageHistory` бере з
 * подій Kommo тих, хто з етапу вже пішов (інакше старих угод не знайти ніде: `deal_stage_events` цей етап не пише).
 */

export const SWEEP_EVERY_MS = 24 * 3600_000;

/** Дописати угоди; повтор нічого не дублює. `movedIn` — угода прийшла на етап з іншого етапу (у «створено» не йде). */
export async function recordStageDeals(db: Db, leads: readonly (StageLead & { movedIn?: boolean })[], now: Date): Promise<number> {
  if (leads.length === 0) return 0;
  const r = await db.query(
    `INSERT INTO linkedin_stage_deals (kommo_id, deal_name, created_at_kommo, moved_in, found_at)
     SELECT u.id, u.name, to_timestamp(u.created_ms / 1000.0), u.moved, $5
       FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::boolean[]) AS u(id, name, created_ms, moved)
     ON CONFLICT (kommo_id) DO UPDATE SET moved_in = linkedin_stage_deals.moved_in OR EXCLUDED.moved_in,
       deal_name = COALESCE(EXCLUDED.deal_name, linkedin_stage_deals.deal_name)
     WHERE EXCLUDED.moved_in AND NOT linkedin_stage_deals.moved_in`,
    [leads.map((l) => l.id), leads.map((l) => l.name), leads.map((l) => Math.round(l.createdAt)), leads.map((l) => l.movedIn === true), now]);
  return r.rowCount ?? 0;
}

export interface SweepDeps {
  /** Угоди, що колись пішли з етапу (події Kommo `lead_status_changed`, статус «до» = LinkedIn). */
  leftIds: () => Promise<number[]>;
  /** Угоди, що прийшли на етап з іншого етапу (статус «після» = LinkedIn). */
  movedInIds: () => Promise<number[]>;
  /** Угоди за id — назва й дата створення. */
  leads: (ids: number[]) => Promise<StageLead[]>;
}

/** Раз на добу (за `history_swept_at`): дописати тих, хто з етапу пішов, і позначити перенесених. `null` — ще рано. */
export async function sweepStageHistory(db: Db, d: SweepDeps, now: Date): Promise<{ left: number; movedIn: number } | null> {
  const st = (await db.query<{ history_swept_at: Date | null }>(`SELECT history_swept_at FROM linkedin_queue_settings WHERE id`)).rows[0];
  if (!st) return null;
  if (st.history_swept_at && now.getTime() - new Date(st.history_swept_at).getTime() < SWEEP_EVERY_MS) return null;
  const left = [...new Set(await d.leftIds())];
  const moved = new Set(await d.movedInIds());
  const ids = [...new Set([...left, ...moved])];
  const found: (StageLead & { movedIn: boolean })[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    for (const l of await d.leads(ids.slice(i, i + 200))) found.push({ ...l, movedIn: moved.has(l.id) });
  }
  await recordStageDeals(db, found, now);
  await db.query(`UPDATE linkedin_queue_settings SET history_swept_at = $1 WHERE id`, [now]);
  return { left: left.length, movedIn: moved.size };
}

export interface StageCreated { created: number; firstDay: string | null; byDay: { day: string; count: number }[] }

/** Скільки угод створено на етапі за київські дати [from, to] включно, по днях; `firstDay` — найраніша відома угода. */
export async function loadStageCreated(db: Db, from: string, to: string): Promise<StageCreated> {
  const byDay = (await db.query<{ day: string; n: number }>(
    `SELECT to_char((created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
       FROM linkedin_stage_deals
      WHERE NOT moved_in AND (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date
      GROUP BY 1 ORDER BY 1`, [from, to])).rows.map((r) => ({ day: r.day, count: r.n }));
  const first = (await db.query<{ day: string | null }>(
    `SELECT to_char(MIN((created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date), 'YYYY-MM-DD') AS day FROM linkedin_stage_deals WHERE NOT moved_in`)).rows[0];
  return { created: byDay.reduce((a, r) => a + r.count, 0), firstDay: first?.day ?? null, byDay };
}
