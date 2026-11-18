// 9363 замір 2: READ ONLY (Kommo — лише GET, БД — BEGIN READ ONLY … ROLLBACK). Події «тег додано» на угодах:
// формат value_after, скільки угод колись отримали тег LinkedIn, з якої дати, і чи є вони в нашій таблиці deals.
// Запуск: cd <repo>/backend && node /tmp/m9363b.cjs. Секретів не друкує.
const { Client } = require(process.cwd() + "/node_modules/pg");
const fs = require("fs");
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL|KOMMO_BASE_URL|KOMMO_API_TOKEN)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
const kget = async (p) => {
  const r = await fetch(process.env.KOMMO_BASE_URL + p, { headers: { Authorization: "Bearer " + process.env.KOMMO_API_TOKEN } });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error("Kommo " + p.split("?")[0] + " → " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
};
(async () => {
  const months = [];
  for (let y = 2025, m = 1; y < 2026 || (y === 2026 && m <= 11); m === 12 ? (y++, m = 1) : m++) months.push([y, m]);
  let sampleShown = false, total = 0;
  const hits = new Map(); // leadId → first unix
  const perMonth = [];
  for (const [y, m] of months) {
    const from = Math.floor(Date.UTC(y, m - 1, 1) / 1000) - 3 * 3600, to = Math.floor(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) / 1000) - 3 * 3600 - 1;
    let page = 1, n = 0, li = 0, capped = false;
    for (;;) {
      const d = await kget(`/api/v4/events?limit=100&page=${page}&filter[type]=entity_tag_added&filter[entity]=lead` +
        `&${encodeURIComponent("filter[created_at][from]")}=${from}&${encodeURIComponent("filter[created_at][to]")}=${to}`);
      const raw = d?._embedded?.events ?? [];
      for (const e of raw) {
        n++;
        if (!sampleShown) { console.log("ЗРАЗОК value_after:", JSON.stringify(e.value_after), "entity_type:", e.entity_type); sampleShown = true; }
        if (/linkedin/i.test(JSON.stringify(e.value_after ?? []))) { li++; if (!hits.has(e.entity_id) || hits.get(e.entity_id) > e.created_at) hits.set(e.entity_id, e.created_at); }
      }
      if (raw.length < 100 || !d?._links?.next) break;
      if (page >= 250) { capped = true; break; }
      page++; await sleep(150);
    }
    total += n;
    perMonth.push({ month: `${y}-${String(m).padStart(2, "0")}`, events: n, linkedin: li, capped });
  }
  console.table(perMonth);
  console.log("ПОДІЙ «тег додано» усього:", total, "· угод з тегом LinkedIn:", hits.size);
  const first = [...hits.values()].sort((a, b) => a - b)[0];
  console.log("ПЕРША постановка тегу LinkedIn:", first ? new Date(first * 1000).toISOString() : "—");
  const ids = [...hits.keys()];
  // Поточні теги цих угод — напряму з Kommo (чи тег досі стоїть)
  let still = 0;
  for (let i = 0; i < ids.length; i += 250) {
    const q = ids.slice(i, i + 250).map((id, k) => `filter[id][${k}]=${id}`).join("&");
    const d = await kget(`/api/v4/leads?limit=250&${q}`);
    for (const l of d?._embedded?.leads ?? []) if ((l._embedded?.tags ?? []).some((t) => /^linkedin$/i.test(String(t.name).trim()))) still++;
    await sleep(150);
  }
  console.log("З НИХ тег стоїть зараз:", still);
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query("BEGIN READ ONLY");
  const r = await c.query(`SELECT COUNT(*)::int AS in_deals, COUNT(*) FILTER (WHERE client_source = 'LinkedIn')::int AS also_src,
      to_char(MIN(created_at_kommo AT TIME ZONE 'Europe/Kyiv'), 'YYYY-MM-DD') AS first_created
    FROM deals WHERE kommo_id = ANY($1::bigint[])`, [ids]);
  console.log("У НАШІЙ deals:", JSON.stringify(r.rows[0]), "із", ids.length);
  await c.query("ROLLBACK"); await c.end();
})().catch((e) => { console.error("ПОМИЛКА", e.message); process.exit(1); });
