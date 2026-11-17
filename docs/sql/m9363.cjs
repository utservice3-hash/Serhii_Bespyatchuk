// 9363 замір: READ ONLY (БД — BEGIN READ ONLY … ROLLBACK; Kommo — лише GET). Запуск: cd <repo>/backend && node /tmp/m9363.cjs
// Секретів не друкує: лише кількості, id, назви етапів і значень.
const { Client } = require(process.cwd() + "/node_modules/pg");
const fs = require("fs");
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL|KOMMO_BASE_URL|KOMMO_API_TOKEN)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const kget = async (p) => {
  const r = await fetch(process.env.KOMMO_BASE_URL + p, { headers: { Authorization: "Bearer " + process.env.KOMMO_API_TOKEN } });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error("Kommo " + p.split("?")[0] + " → " + r.status);
  return r.json();
};
(async () => {
  // ── Kommo: значення поля «Источник клиента», теги, назви етапів
  const cf = await kget("/api/v4/leads/custom_fields/2098035");
  console.log("ПОЛЕ", cf.id, cf.name, "значень:", (cf.enums || []).length);
  console.log("ENUM LinkedIn:", JSON.stringify((cf.enums || []).filter((e) => /linked/i.test(e.value))));
  let tags = [], page = 1;
  for (;;) { const t = await kget(`/api/v4/leads/tags?limit=250&page=${page}`); const b = t?._embedded?.tags ?? []; tags.push(...b); if (b.length < 250) break; page++; }
  console.log("ТЕГІВ УГОД УСЬОГО:", tags.length, "схожі на LinkedIn:", JSON.stringify(tags.filter((t) => /linked|лінк|линк/i.test(t.name)).map((t) => ({ id: t.id, name: t.name }))));
  const pl = await kget("/api/v4/leads/pipelines");
  const stName = new Map();
  for (const p of pl._embedded.pipelines) for (const s of p._embedded.statuses) stName.set(`${p.id}:${s.id}`, `${p.name} / ${s.name}`);
  // Чи віддає API теги у списку угод (той самий запит, що синк)
  const sample = await kget("/api/v4/leads?limit=50&with=contacts,companies&order[updated_at]=desc");
  const ls = sample?._embedded?.leads ?? [];
  console.log("СПИСОК УГОД (як синк): угод", ls.length, "з ключем _embedded.tags:", ls.filter((l) => Array.isArray(l._embedded?.tags)).length,
    "з непорожніми тегами:", ls.filter((l) => (l._embedded?.tags ?? []).length > 0).length);
  // Угоди з тегом LinkedIn: фільтра по тегу Kommo v4 не приймає (400), тож повний прохід списку угод і перевірка _embedded.tags.
  try {
    const lt = tags.filter((t) => /linked/i.test(t.name)).map((t) => t.id);
    let total = 0, pg = 1; global.tagIds = [];
    for (;;) { const r = await kget(`/api/v4/leads?limit=250&page=${pg}`); const b = r?._embedded?.leads ?? []; total += b.length;
      for (const x of b) if ((x._embedded?.tags ?? []).some((g) => lt.includes(g.id))) global.tagIds.push(x.id);
      if (b.length < 250 || pg >= 200) break; pg++; await new Promise((z) => setTimeout(z, 200)); }
    console.log(`ПРОХІД УГОД: переглянуто ${total} (сторінок ${pg}), з тегом LinkedIn ${global.tagIds.length}`);
  } catch (e) { console.log("ТЕГ: прохід упав —", e.message, "(частина БД нижче однаково йде)"); }
  // ── БД
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query("BEGIN READ ONLY");
  const q = async (label, sql, args = []) => { const r = await c.query(sql, args); console.log("\n=== " + label); console.table(r.rows); return r.rows; };
  await q("client_source схожі на LinkedIn", `SELECT client_source, COUNT(*)::int n FROM deals WHERE client_source ILIKE '%linked%' GROUP BY 1`);
  const byStage = await c.query(`SELECT pipeline_id, status_id, (closed_at_kommo IS NOT NULL) closed, COUNT(*)::int n,
      to_char(MIN(created_at_kommo AT TIME ZONE 'Europe/Kyiv'),'YYYY-MM-DD') first, to_char(MAX(created_at_kommo AT TIME ZONE 'Europe/Kyiv'),'YYYY-MM-DD') last
    FROM deals WHERE client_source = 'LinkedIn' GROUP BY 1,2,3 ORDER BY n DESC`);
  console.log("\n=== Джерело LinkedIn: по поточному етапу");
  console.table(byStage.rows.map((r) => ({ stage: stName.get(`${r.pipeline_id}:${r.status_id}`) ?? `${r.pipeline_id}:${r.status_id}`, closed: r.closed, n: r.n, first: r.first, last: r.last })));
  await q("Джерело LinkedIn: по місяцю створення", `SELECT to_char(created_at_kommo AT TIME ZONE 'Europe/Kyiv','YYYY-MM') m, COUNT(*)::int n,
      COUNT(*) FILTER (WHERE manager_id IS NULL)::int no_manager FROM deals WHERE client_source = 'LinkedIn' GROUP BY 1 ORDER BY 1`);
  await q("Етап «LinkedIn» (linkedin_stage_deals) проти джерела", `SELECT COUNT(*)::int stage_all, COUNT(*) FILTER (WHERE NOT s.moved_in)::int stage_created,
      COUNT(d.kommo_id)::int in_deals, COUNT(*) FILTER (WHERE d.client_source = 'LinkedIn')::int src_linkedin,
      COUNT(*) FILTER (WHERE d.kommo_id IS NOT NULL AND d.client_source IS DISTINCT FROM 'LinkedIn')::int src_other
    FROM linkedin_stage_deals s LEFT JOIN deals d ON d.kommo_id = s.kommo_id`);
  await q("Джерело інше на угодах етапу", `SELECT COALESCE(d.client_source,'(порожньо)') src, COUNT(*)::int n FROM linkedin_stage_deals s JOIN deals d ON d.kommo_id = s.kommo_id
     WHERE d.client_source IS DISTINCT FROM 'LinkedIn' GROUP BY 1 ORDER BY 2 DESC`);
  await q("Джерело LinkedIn, але не на етапі «LinkedIn» ніколи", `SELECT COUNT(*)::int n FROM deals d WHERE d.client_source = 'LinkedIn'
     AND NOT EXISTS (SELECT 1 FROM linkedin_stage_deals s WHERE s.kommo_id = d.kommo_id)`);
  if (global.tagIds?.length) await q("Тег LinkedIn проти джерела (угоди з БД)", `SELECT COUNT(*)::int tagged, COUNT(d.kommo_id)::int in_deals,
      COUNT(*) FILTER (WHERE d.client_source = 'LinkedIn')::int also_src, COUNT(*) FILTER (WHERE d.kommo_id IS NOT NULL AND d.client_source IS DISTINCT FROM 'LinkedIn')::int tag_only
    FROM unnest($1::bigint[]) u(id) LEFT JOIN deals d ON d.kommo_id = u.id`, [global.tagIds]);
  await c.query("ROLLBACK"); await c.end();
})().catch((e) => { console.error("ПОМИЛКА", e.message); process.exit(1); });
