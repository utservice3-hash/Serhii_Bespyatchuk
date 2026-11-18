// 9230 перевірка гілки на проді: READ ONLY (запуск із PGOPTIONS="-c role=test_readonly"; БД — лише SELECT).
// Запуск з backend/ ЗІБРАНОЇ гілки: set -a && . <прод-чекаут>/backend/.env && set +a && PGOPTIONS="-c role=test_readonly" node ../docs/sql/v9230.mjs
// Що міряє: (1) Σ семи кошиків == «Створено» по кожному менеджеру за 01-18.11 і 01-31.10 (ядро гілки);
// (2) незалежний підрахунок тим самим правилом окремим SQL — скільки LinkedIn / Prozorro серед FC-угод з каналом «інше»;
// (3) скільки FC-угод має tags IS NULL (що добере backfillNullTags).
const D = `${process.cwd()}/dist`;
const m = await import(`${D}/core/metrics.js`);
const { pool } = await import(`${D}/db/pool.js`);
const role = (await pool.query("SELECT current_user AS u")).rows[0].u;
console.log("роль:", role);
if (role !== "test_readonly") { console.log("🔴 не read-only — зупинка"); await pool.end(); process.exit(1); }
for (const [from, to] of [["2026-11-01", "2026-11-18"], ["2026-10-01", "2026-10-31"]]) {
  const rows = await m.createdSplitByManager({ from, to });
  const T = { created: 0, ad: 0, lg: 0, el: 0, li: 0, pz: 0, oth: 0, nch: 0 };
  const bad = [];
  for (const r of rows) {
    const s = r.adCount + r.leadgenCount + r.elogistCount + r.linkedinCount + r.prozorroCount + r.otherCount + r.noChannelCount;
    if (s !== r.created) bad.push(`${r.name}: ${s} ≠ ${r.created}`);
    for (const k of ["new", "rep", "undef"]) {
      const c = r.sourceByKlass[k];
      if (c.adCount + c.leadgenCount + c.elogistCount + c.linkedinCount + c.prozorroCount + c.otherCount + c.noChannelCount !== c.created) bad.push(`${r.name}/${k}`);
    }
    T.created += r.created; T.ad += r.adCount; T.lg += r.leadgenCount; T.el += r.elogistCount; T.li += r.linkedinCount;
    T.pz += r.prozorroCount; T.oth += r.otherCount; T.nch += r.noChannelCount;
  }
  console.log(`\n${from}..${to}: менеджерів ${rows.length} · створено ${T.created} = реклама ${T.ad} + лідоген ${T.lg} + eLogist ${T.el} + LinkedIn ${T.li} + Prozorro ${T.pz} + без джерела ${T.oth} + не вказано ${T.nch}`);
  console.log(bad.length ? `🔴 Σ ≠ створено: ${bad.join("; ")}` : "✅ Σ семи == створено у кожного менеджера і в кожному зрізі класу");
  const top = rows.filter((r) => r.linkedinCount || r.prozorroCount).map((r) => `${r.name} LI ${r.linkedinCount} PZ ${r.prozorroCount}`);
  console.log("  по менеджерах:", top.join(" · ") || "—");
  // незалежно: окремий SQL, без ядра — FC, створені в періоді, канал 'other', активні менеджери
  const q = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE li) AS li, COUNT(*) FILTER (WHERE pz AND NOT li) AS pz,
           COUNT(*) FILTER (WHERE lead_channel = 'other' AND NOT li AND NOT pz) AS oth,
           COUNT(*) FILTER (WHERE li_any) AS li_all_channels, COUNT(*) FILTER (WHERE pz_any) AS pz_all_channels
      FROM (SELECT (lead_channel = 'other' AND (btrim(coalesce(client_source,'')) = 'LinkedIn' OR 'LinkedIn' = ANY(coalesce(tags,'{}')))) AS li,
                   (lead_channel = 'other' AND (btrim(coalesce(client_source,'')) = 'AI тендер' OR coalesce(tags,'{}') && ARRAY['AI тендер','Prozorro'])) AS pz,
                   (btrim(coalesce(client_source,'')) = 'LinkedIn' OR 'LinkedIn' = ANY(coalesce(tags,'{}'))) AS li_any,
                   (btrim(coalesce(client_source,'')) = 'AI тендер' OR coalesce(tags,'{}') && ARRAY['AI тендер','Prozorro']) AS pz_any,
                   lead_channel
              FROM deals d JOIN managers mm ON mm.id = d.manager_id AND mm.is_active
             WHERE d.pipeline_id IN (8921932, 155304)
               AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1 AND $2) x
     WHERE lead_channel = 'other' OR li_any OR pz_any`, [from, to]);
  console.log("  незалежний SQL (канал «інше»):", JSON.stringify(q.rows[0]));
}
const n = await pool.query(`SELECT COUNT(*) AS c FROM deals WHERE tags IS NULL AND pipeline_id IN (8921932,155304)
  AND (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= '2026-09-01'`);
console.log("\nFC з 01.09 з tags IS NULL:", n.rows[0].c);
await pool.end();
console.log("ГОТОВО v9230");
