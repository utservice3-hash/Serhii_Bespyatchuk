// 8719 замір: READ ONLY. Запуск: cd <repo>/backend && node /tmp/m8719.cjs
// SQL і ltvSourceLabel згенеровано зі збірки гілки (не копія руками): той самий запит, що stored() у core/leadgenLtv.ts.
const { Client } = require(process.cwd()+"/node_modules/pg");
const fs=require("fs");
if(!process.env.DATABASE_URL){ for (const l of fs.readFileSync(".env","utf8").split("\n")){ const m=l.match(/^DATABASE_URL=(.*)$/); if(m) process.env.DATABASE_URL=m[1].replace(/^["\x27]|["\x27]$/g,""); } }
const { SOURCE_UNSET, SOURCE_NO_LEAD, SOURCE_LINKEDIN, SOURCE_PROZORRO } = {"SOURCE_UNSET":"джерело не проставлене","SOURCE_NO_LEAD":"лід лідгена не знайдено","SOURCE_LINKEDIN":"LinkedIn","SOURCE_PROZORRO":"Prozorro"};
function ltvSourceLabel(lead) {
    if (!lead.found)
        return SOURCE_NO_LEAD;
    if (lead.linkedin)
        return SOURCE_LINKEDIN;
    if (lead.prozorro)
        return SOURCE_PROZORRO;
    const s = (lead.source ?? "").trim();
    return s || SOURCE_UNSET;
}
const SQL = "SELECT c.client_key, c.lg_manager_id, c.client_name, c.deals, c.ltv, c.state, c.pz_id, c.first_deal_id,\n       (pz.kommo_id IS NOT NULL) AS lead_found, pz.client_source AS lead_source,\n       COALESCE((COALESCE(btrim(pz.client_source), '') = 'LinkedIn' OR 'LinkedIn' = ANY(COALESCE(pz.tags, '{}'::text[]))), false) AS lead_li, COALESCE((COALESCE(btrim(pz.client_source), '') = 'AI тендер' OR COALESCE(pz.tags, '{}'::text[]) && ARRAY['AI тендер', 'Prozorro']::text[]), false) AS lead_pz,\n       fd.client_source AS first_source\n  FROM leadgen_ltv_clients c\n  LEFT JOIN deals pz ON pz.kommo_id = c.pz_id\n  LEFT JOIN deals fd ON fd.kommo_id = c.first_deal_id";
(async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  await c.query("BEGIN READ ONLY");
  const n=(await c.query("SELECT COUNT(*)::int AS n FROM leadgen_ltv_clients")).rows[0].n;
  console.log("ІСНУЄ leadgen_ltv_clients, рядків", n); if(!n) throw new Error("таблиця порожня — заміряти нема що");
  const t0=Date.now(); const rows=(await c.query(SQL)).rows; const ms=Date.now()-t0;
  console.log("рядків запиту", rows.length, "за", ms, "мс");
  const by=new Map(); let ltv=0, rep=0, act=0, diffFirst=0;
  for(const r of rows){
    const s=ltvSourceLabel({found:r.lead_found, linkedin:r.lead_li, prozorro:r.lead_pz, source:r.lead_source});
    const x=by.get(s)||{clients:0,ltv:0,repeat:0,active:0}; x.clients++; x.ltv+=Number(r.ltv); if(r.deals>=2)x.repeat++; if(r.state==="active")x.active++; by.set(s,x);
    ltv+=Number(r.ltv); if(r.deals>=2)rep++; if(r.state==="active")act++;
    if((r.first_source||"").trim()!==(r.lead_source||"").trim()) diffFirst++;
  }
  console.table([...by.entries()].sort((a,b)=>b[1].ltv-a[1].ltv).map(([s,x])=>({source:s,clients:x.clients,ltv:Math.round(x.ltv),repeat:x.repeat,repeatPct:Math.round(x.repeat/x.clients*100),active:x.active})));
  const sum=(k)=>[...by.values()].reduce((a,x)=>a+x[k],0);
  console.log("РАЗОМ шапка: клієнтів",rows.length,"LTV",Math.round(ltv),"постійних",rep,"працюють",act);
  console.log("РАЗОМ розклад: клієнтів",sum("clients"),"LTV",Math.round(sum("ltv")),"постійних",sum("repeat"),"працюють",sum("active"));
  console.log("клієнтів, у яких джерело ліда ≠ джерелу першої угоди менеджера:", diffFirst);
  const am=rows.filter(r=>/амтр/i.test(r.client_name||""));
  console.log("АМТРІКС:", JSON.stringify(am.map(r=>({name:r.client_name,pz:r.pz_id,lead_source:r.lead_source,first_source:r.first_source,ltv:r.ltv,deals:r.deals}))));
  await c.query("ROLLBACK"); await c.end();
})().catch(e=>{console.error("ПОМИЛКА",e.message);process.exit(1)});

