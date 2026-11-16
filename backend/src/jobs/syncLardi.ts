import { pool } from "../db/pool.js";
import { hasLardiToken, lardiPost, LANG } from "../lardi/client.js";
import { runLardiSync, PAGE_SIZE, type Proposal, type SyncTally, type PageAnswer } from "../core/lardiSync.js";
import { recordProposals } from "../core/lardiSyncDb.js";
import type { Db } from "../core/secrets.js";

/**
 * 🛰 Живий скан Ларді для «Хантингу» (ТЗ Івана п.4) — кожні 15 хв. Правила проходу, розбір і вирок — `core/lardiSync.ts`.
 * Без токена — не працює взагалі (як `collectLardi`). Відмова Ларді (403: не оплачено «Розширений доступ до API») —
 * падіння джоби → `monitoredJobs` → «АВАРІЯ» і тривога з дедупом, а не «успіх із нулем».
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function search(kind: string, filter: Record<string, unknown>, page: number): Promise<PageAnswer> {
  const r = await lardiPost(`/v2/proposals/search/${kind}?language=${LANG}`, { filter, options: { pageNumber: page, pageSize: PAGE_SIZE } });
  if (r.status !== 200) return { code: r.status, items: null, pages: null, detail: (await r.text().catch(() => "")).slice(0, 300) };
  const j = (await r.json().catch(() => null)) as { content?: unknown; paginator?: { pages?: unknown } } | null;
  if (!j) return { code: 200, items: null, pages: null, detail: "bad JSON" };
  const pages = Number(j.paginator?.pages);
  return { code: 200, items: Array.isArray(j.content) ? j.content : [], pages: Number.isFinite(pages) && pages > 0 ? pages : null, detail: "" };
}

const record = async (items: Proposal[]) => {
  const client = await pool.connect();
  try { return await recordProposals(client as unknown as Db, items); } finally { client.release(); }
};

async function shippers(refIds: number[]): Promise<void> {
  if (!refIds.length) return;
  await pool.query(
    `INSERT INTO lardi_shippers (ref_id) SELECT unnest($1::bigint[]) ON CONFLICT (ref_id) DO UPDATE SET seen_at = now()`, [refIds]);
}

export async function syncLardi(): Promise<SyncTally | null> {
  if (!hasLardiToken()) return null;
  const t = await runLardiSync({ search, record, shippers, sleep });
  console.log(`syncLardi: запитів ${String(t.requests)} (200: ${String(t.ok)}), заявок ${String(t.seen)}, нових ${String(t.fresh)}, `
    + `подій ${String(t.events)}, не розібрано ${String(t.unparsed)}, вантажовласників ${String(t.shippers)}, пауз 429: ${String(t.retries)}`);
  return t;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncLardi().then(() => pool.end()).catch((err) => { console.error(err); process.exit(1); });
}
