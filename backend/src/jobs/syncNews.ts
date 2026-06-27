import { pool } from "../db/pool.js";

const FEEDS = [
  "https://logistics-ukraine.com/feed/",
  "https://usm.media/feed/",
];

interface RssItem {
  title: string;
  link: string;
  description: string;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&#39;/g, "'")
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z#0-9]+;/gi, "")
    .trim();
}

function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  for (const b of blocks) {
    const title = decode(/<title>([\s\S]*?)<\/title>/.exec(b)?.[1] ?? "");
    const link = decode(/<link>([\s\S]*?)<\/link>/.exec(b)?.[1] ?? "");
    const description = decode(/<description>([\s\S]*?)<\/description>/.exec(b)?.[1] ?? "").slice(0, 600);
    if (title) items.push({ title, link, description });
  }
  return items;
}

/** Pulls fresh logistics industry news from RSS and inserts up to 3 new items
 *  per run into the 'logistics' news category, de-duplicated by title. */
export async function syncNews(): Promise<void> {
  const collected: RssItem[] = [];
  for (const url of FEEDS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      collected.push(...parseRss(await res.text()).slice(0, 5));
    } catch (err) {
      console.error(`News feed failed ${url}:`, (err as Error).message);
    }
  }

  let inserted = 0;
  for (const item of collected) {
    if (inserted >= 3) break;
    const exists = await pool.query(`SELECT 1 FROM news WHERE title = $1 LIMIT 1`, [item.title]);
    if (exists.rowCount) continue;
    const body = item.description ? `${item.description}\n\n${item.link}` : item.link;
    await pool.query(
      `INSERT INTO news (category, title, body, author) VALUES ('logistics', $1, $2, 'UTSAI')`,
      [item.title, body]
    );
    inserted++;
  }
  console.log(`News sync: inserted ${inserted} logistics items from ${collected.length} fetched.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncNews()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
