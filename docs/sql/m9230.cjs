// 9230 замір: READ ONLY (БД — BEGIN READ ONLY … ROLLBACK; Kommo — лише GET). Запуск: cd <repo>/backend && nice -n 20 node /tmp/m9230.cjs
// Секретів не друкує: лише кількості, id, назви значень, тегів і угод.
const { Client } = require(process.cwd() + "/node_modules/pg");
const fs = require("fs");
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL|KOMMO_BASE_URL|KOMMO_API_TOKEN)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const RX = /prozorro|прозор|тендер|tender|linked|лінкед|линкед/i;
const kget = async (p) => {
  const r = await fetch(process.env.KOMMO_BASE_URL + p, { headers: { Authorization: "Bearer " + process.env.KOMMO_API_TOKEN } });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error("Kommo " + p.split("?")[0] + " → " + r.status);
  return r.json();
};
const show = (title, rows) => { console.log(`\n── ${title} (${rows.length})`); for (const r of rows) console.log("  " + Object.values(r).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)).join(" | ")); };
(async () => {
  // ── Kommo: значення «Источник клиента» (угода) і «Источник клиента» контакту, теги угод — лише схожі на LinkedIn/Prozorro
  try {
    const cf = await kget("/api/v4/leads/custom_fields/2098035");
    console.log("ПОЛЕ УГОДИ", cf.id, cf.name, "значень:", (cf.enums || []).length);
    console.log("  усі значення:", (cf.enums || []).map((e) => `${e.id}=${e.value}`).join(" · "));
    let tags = [], page = 1;
    for (;;) { const t = await kget(`/api/v4/leads/tags?limit=250&page=${page}`); const b = t?._embedded?.tags ?? []; tags.push(...b); if (b.length < 250) break; page++; }
    console.log("ТЕГІВ УГОД:", tags.length, "схожі:", JSON.stringify(tags.filter((t) => RX.test(t.name)).map((t) => ({ id: t.id, name: t.name }))));
  } catch (e) { console.log("KOMMO впав —", e.message, "(БД нижче однаково йде)"); }

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  try {
    const FC = "d.pipeline_id IN (8921932,155304)";
    const SINCE = "(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= '2026-09-01'";
    const LI = "(COALESCE(btrim(d.client_source),'') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(d.tags,'{}'::text[])))";
    const PZ = `(d.client_source ~* 'prozorro|прозор|тендер' OR EXISTS (SELECT 1 FROM unnest(COALESCE(d.tags,'{}'::text[])) t WHERE t ~* 'prozorro|прозор|тендер'))`;

    show("1. FC, створені з 01.09: джерело → угод", (await c.query(
      `SELECT COALESCE(NULLIF(btrim(d.client_source),''),'(порожньо)') AS src, count(*)::int AS n FROM deals d WHERE ${FC} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC`)).rows);
    show("2. FC, створені з 01.09: покриття тегів (NULL = синк ще не читав)", (await c.query(
      `SELECT CASE WHEN d.tags IS NULL THEN 'tags NULL' WHEN cardinality(d.tags)=0 THEN 'без тегів' ELSE 'є теги' END AS k, count(*)::int AS n FROM deals d WHERE ${FC} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC`)).rows);
    show("3. Усі угоди: теги, схожі на LinkedIn/Prozorro/тендер → угод", (await c.query(
      `SELECT t AS tag, count(*)::int AS n FROM deals d, unnest(d.tags) t WHERE t ~* 'prozorro|прозор|тендер|linked' GROUP BY 1 ORDER BY 2 DESC`)).rows);
    show("4. Усі угоди: джерело, схоже на LinkedIn/Prozorro/тендер → воронка → угод", (await c.query(
      `SELECT d.client_source AS src, d.pipeline_id AS pipe, count(*)::int AS n, min(d.created_at_kommo) AS first, max(d.created_at_kommo) AS last
         FROM deals d WHERE d.client_source ~* 'prozorro|прозор|тендер|linked' GROUP BY 1,2 ORDER BY 3 DESC`)).rows);
    show("5. Угоди «схожі на Prozorro» (джерело або тег): воронка × місяць створення", (await c.query(
      `SELECT d.pipeline_id AS pipe, to_char(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv','YYYY-MM') AS ym, count(*)::int AS n
         FROM deals d WHERE ${PZ} GROUP BY 1,2 ORDER BY 2 DESC, 3 DESC`)).rows);
    show("6. FC «схожі на Prozorro» з 01.09: канал × менеджер", (await c.query(
      `SELECT COALESCE(d.lead_channel,'NULL') AS ch, COALESCE(m.name,'—') AS mgr, d.client_source AS src, array_to_string(d.tags, ',') AS tags, count(*)::int AS n
         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id WHERE ${FC} AND ${SINCE} AND ${PZ} GROUP BY 1,2,3,4 ORDER BY 5 DESC LIMIT 40`)).rows);
    show("7. prozorro_leads: записані в Kommo → угода в deals → дочірня угода в FC (lead_child_links)", (await c.query(
      `SELECT count(*) FILTER (WHERE pl.kommo_lead_id IS NOT NULL)::int AS pushed,
              count(d.kommo_id)::int AS in_deals,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_child_links l JOIN deals ch ON ch.kommo_id = l.child_id
                                             WHERE l.parent_id = pl.kommo_lead_id AND ch.pipeline_id IN (8921932,155304)))::int AS child_fc,
              min(pl.pushed_at) AS first, max(pl.pushed_at) AS last
         FROM prozorro_leads pl LEFT JOIN deals d ON d.kommo_id = pl.kommo_lead_id`)).rows);
    show("8. Дочірні FC-угоди від тендерних: джерело/теги/канал → угод", (await c.query(
      `SELECT COALESCE(ch.client_source,'(порожньо)') AS src, COALESCE(array_to_string(ch.tags, ','),'NULL') AS tags, COALESCE(ch.lead_channel,'NULL') AS chn, count(*)::int AS n
         FROM prozorro_leads pl JOIN lead_child_links l ON l.parent_id = pl.kommo_lead_id JOIN deals ch ON ch.kommo_id = l.child_id
        WHERE ch.pipeline_id IN (8921932,155304) GROUP BY 1,2,3 ORDER BY 4 DESC`)).rows);
    show("9. LinkedIn за правилом §20, FC, створені з 01.09: канал × новизна-проксі", (await c.query(
      `SELECT COALESCE(d.lead_channel,'NULL') AS ch, count(*)::int AS n FROM deals d WHERE ${FC} AND ${SINCE} AND ${LI} GROUP BY 1 ORDER BY 2 DESC`)).rows);
    show("10. LinkedIn за правилом §20, FC, створені 01-18.11: менеджер → угод (активний?)", (await c.query(
      `SELECT COALESCE(m.name,'—') AS mgr, m.is_active AS active, count(*)::int AS n FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
        WHERE ${FC} AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN '2026-11-01' AND '2026-11-18' AND ${LI} GROUP BY 1,2 ORDER BY 3 DESC`)).rows);
    show("11. Бєлясова: угоди з 01.10 — джерело/теги/етап (LinkedIn-подібні і етап «LinkedIn» Кваліфікації)", (await c.query(
      `SELECT d.kommo_id, d.pipeline_id AS pipe, d.status_id AS st, d.client_source AS src, array_to_string(d.tags, ',') AS tags, d.lead_channel AS ch, d.client_key IS NOT NULL AS has_key, d.created_at_kommo AS created, left(d.name, 40) AS name
         FROM deals d JOIN managers m ON m.id = d.manager_id
        WHERE m.name ILIKE 'Бєлясова%' AND d.created_at_kommo >= '2026-10-01'
          AND (${LI} OR d.status_id = 113486296 OR d.client_source ~* 'linked' OR EXISTS (SELECT 1 FROM unnest(COALESCE(d.tags,'{}'::text[])) t WHERE t ~* 'linked'))
        ORDER BY d.created_at_kommo`)).rows);
    show("12. Бєлясова: угоди з 01.11 — джерело → угод", (await c.query(
      `SELECT COALESCE(NULLIF(btrim(d.client_source),''),'(порожньо)') AS src, d.pipeline_id AS pipe, count(*)::int AS n
         FROM deals d JOIN managers m ON m.id = d.manager_id WHERE m.name ILIKE 'Бєлясова%' AND d.created_at_kommo >= '2026-11-01' GROUP BY 1,2 ORDER BY 3 DESC`)).rows);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
  console.log("\nГОТОВО m9230");
})().catch((e) => { console.error("ПОМИЛКА", e.message); process.exit(1); });
