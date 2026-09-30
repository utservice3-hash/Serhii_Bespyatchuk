import { pool } from "../db/pool.js";
import { forEachLeadAutoCreatedNotePage } from "../kommo/client.js";
import { parseLeadChildLink, type LeadChildLink } from "../kommo/leadChildLink.js";
import { processInChunks } from "./chunkWindow.js";

/**
 * 🔗 «З ЯКОЇ УГОДИ СТВОРЕНО ЦЮ» — примітки Kommo `lead_auto_created` → `lead_child_links` (30.09.2026).
 *
 * Навіщо: гроші з передач лідгена звʼязували передачу з угодою менеджера здогадом «той самий
 * client_key у межах 2 хв». Коли в угоді Продзвону не заповнено клієнта, здогад мовчить, і гроші
 * лідгена зникають (угода 62668945, 15 000 ₴, Сердюк). Примітка Kommo — точний звʼязок, без здогаду.
 *
 * Той самий каркас, що `syncTransfers`: порції ≤24 год (`processInChunks`) і вотермарк, що рухається
 * лише по завершених порціях (`last_child_link_at`); з `sinceUnix` — бекфіл, вотермарк не чіпає.
 * Імпортер: у лозі — СКІЛЬКИ привезено, а не лише «без помилок» (правило «зелена джоба ≠ дані йдуть»).
 */
let running = false;

export async function storeLeadChildLinks(links: readonly LeadChildLink[]): Promise<number> {
  if (!links.length) return 0;
  const values: unknown[] = [];
  const tuples = links.map((l, j) => {
    values.push(l.parentId, l.childId, new Date(l.createdAt * 1000));
    return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`;
  }).join(",");
  const r = await pool.query(
    `INSERT INTO lead_child_links (parent_id, child_id, created_at) VALUES ${tuples}
     ON CONFLICT (parent_id, child_id) DO NOTHING`, values);
  return r.rowCount ?? 0;
}

export async function syncLeadChildLinks(opts: { sinceUnix?: number; untilUnix?: number } = {}): Promise<void> {
  if (running) {
    console.warn("syncLeadChildLinks: previous run still in progress — skipping this tick.");
    return;
  }
  running = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const isBackfill = opts.sinceUnix != null;
    let sinceUnix = opts.sinceUnix;
    if (sinceUnix == null) {
      const r = await pool.query<{ last_child_link_at: Date | null }>(`SELECT last_child_link_at FROM sync_state WHERE id = 1`);
      const last = r.rows[0]?.last_child_link_at;
      sinceUnix = last ? Math.floor(last.getTime() / 1000) - 300 : now - 2 * 24 * 3600;
    }
    const untilUnix = opts.untilUnix ?? now;
    let stored = 0, skipped = 0;
    const total = await processInChunks(
      sinceUnix, untilUnix,
      (from, to) => forEachLeadAutoCreatedNotePage(from, to, async (notes) => {
        const links: LeadChildLink[] = [];
        for (const n of notes) { const l = parseLeadChildLink(n); if (l) links.push(l); else skipped++; }
        stored += await storeLeadChildLinks(links);
      }),
      isBackfill ? null
        : (chunkUntil) => pool.query(`UPDATE sync_state SET last_child_link_at = $1 WHERE id = 1`, [new Date(chunkUntil * 1000)]).then(() => {})
    );
    console.log(`Lead child links: ${total} notes scanned, ${stored} new pairs, ${skipped} not parsed (${sinceUnix}..${untilUnix}).`);
  } finally {
    running = false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const monthsArg = process.argv.find((a) => a.startsWith("--months="));
  const months = monthsArg ? Number(monthsArg.split("=")[1]) : null;
  syncLeadChildLinks(months ? { sinceUnix: Math.floor(Date.now() / 1000) - months * 30 * 24 * 3600 } : {})
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
