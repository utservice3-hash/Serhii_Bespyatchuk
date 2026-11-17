// 9235 замір 2: READ ONLY (БД) + лише GET до Kommo events. Запуск: cd <repo>/backend && node /tmp/m9235b.cjs
const { Client } = require(process.cwd()+"/node_modules/pg");
const fs=require("fs");
const env={}; for (const l of fs.readFileSync(".env","utf8").split("\n")){ const m=l.match(/^([A-Z_]+)=(.*)$/); if(m) env[m[1]]=m[2].replace(/^["\x27]|["\x27]$/g,""); }
const DB=process.env.DATABASE_URL||env.DATABASE_URL, KB=env.KOMMO_BASE_URL, KT=env.KOMMO_API_TOKEN;
if(!DB||!KB||!KT) throw new Error("немає DATABASE_URL / KOMMO_BASE_URL / KOMMO_API_TOKEN у .env");
const PAN=14926076, PAN_ID=191;
const FC=[8921932,155304];
const ZONE=[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068];
const PAID=[69716460,60412544];
const K="AT TIME ZONE 'Europe/Kyiv'";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const H={Authorization:"Bearer "+KT,"Content-Type":"application/json","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",Accept:"application/json"};
let reqs=0;
async function kget(path){ await sleep(1000); reqs++; const r=await fetch(KB+path,{headers:H}); if(r.status===204) return {status:204,data:null}; const t=await r.text(); let d=null; try{d=JSON.parse(t)}catch{}; return {status:r.status,data:d}; }
const enc=encodeURIComponent;
(async()=>{
  // ── Kommo: зміни відповідального, де ДО зміни був Панасюк ──
  const from=Math.floor(Date.parse("2026-10-01T00:00:00+03:00")/1000);
  const base=`/api/v4/events?limit=100&filter[type]=entity_responsible_changed&filter[entity]=lead&${enc("filter[created_at][from]")}=${from}`;
  let mode="server-filter", pages=0, raw=[], foreign=0, capped=false;
  for(let page=1; page<=40; page++){
    const r=await kget(`${base}&${enc("filter[value_before][responsible_user_id]")}=${PAN}&page=${page}`);
    if(page===1) console.log("KOMMO перший запит (фільтр value_before): HTTP", r.status);
    if(r.status===400){ mode="fallback"; break; }
    if(r.status!==200&&r.status!==204) throw new Error("Kommo HTTP "+r.status);
    pages++; const ev=r.data?._embedded?.events??[]; raw.push(...ev);
    if(ev.length<100||!r.data?._links?.next) break; if(page===40) capped=true;
  }
  if(mode==="fallback"){
    const from2=Math.floor(Date.parse("2026-11-10T00:00:00+02:00")/1000);
    const b2=`/api/v4/events?limit=100&filter[type]=entity_responsible_changed&filter[entity]=lead&${enc("filter[created_at][from]")}=${from2}`;
    for(let page=1; page<=120; page++){ const r=await kget(`${b2}&page=${page}`); if(r.status!==200&&r.status!==204) throw new Error("Kommo HTTP "+r.status); pages++; const ev=r.data?._embedded?.events??[]; raw.push(...ev); if(ev.length<100||!r.data?._links?.next) break; if(page===120) capped=true; }
  }
  const before=(e)=>e.value_before?.[0]?.responsible_user?.id, after=(e)=>e.value_after?.[0]?.responsible_user?.id;
  const mine=raw.filter(e=>e.entity_type==="lead"&&Number(before(e))===PAN); foreign=raw.length-mine.length;
  console.log(`KOMMO режим=${mode} сторінок=${pages} запитів=${reqs} подій=${raw.length} з них від Панасюка=${mine.length} чужих=${foreign} обрізано_лімітом=${capped}`);
  // остання передача по кожній угоді
  const last=new Map(); for(const e of mine){ const p=last.get(e.entity_id); if(!p||e.created_at>p.created_at) last.set(e.entity_id,e); }
  const tr=[...last.values()].map(e=>({id:e.entity_id,to:after(e)??null,at:new Date(e.created_at*1000).toISOString(),by:e.created_by}));
  const byDay={}; for(const x of tr){ const d=x.at.slice(0,10); byDay[d]=(byDay[d]||0)+1; } console.log("передачі за днем (UTC):",JSON.stringify(byDay));
  const byWho={}; for(const x of tr){ byWho[x.by]=(byWho[x.by]||0)+1; } console.log("хто передавав (kommo user id → угод):",JSON.stringify(byWho));
  // ── БД ──
  const c=new Client({connectionString:DB}); await c.connect(); await c.query("BEGIN READ ONLY");
  const q=async(label,sql,p=[])=>{ try{ const r=await c.query(sql,p); console.log("\n=== "+label+" ("+r.rows.length+" рядків)"); console.table(r.rows); return r.rows; }catch(e){ console.log("\n=== "+label+" ПОМИЛКА: "+e.message); return []; } };
  await q("усі угоди manager_id=191 (будь-який статус, усі роки)",`SELECT pipeline_id, CASE WHEN status_id IN (142,143) THEN status_id::text ELSE 'відкрита' END st, count(*)::int n, sum(price)::bigint sum, max(closed_at_kommo) last_closed FROM deals WHERE manager_id=$1 GROUP BY 1,2 ORDER BY n DESC`,[PAN_ID]);
  await q("угоди з kommo_user_id Панасюка",`SELECT count(*)::int n FROM deals WHERE kommo_user_id=$1`,[PAN]);
  const t=await c.query("SELECT id,title,status,comments,deadline FROM tasks WHERE id=9935"); console.log("\n=== ЗАДАЧА 9935:",JSON.stringify(t.rows[0]??null));
  await q("коментарі 9935","SELECT c.created_at, left(c.body,800) body FROM task_comments c WHERE c.task_id=9935 ORDER BY c.created_at");
  const ids=tr.map(x=>x.id);
  if(ids.length){
    await q("передані угоди: зараз у кого (усі воронки)",`SELECT m.name mgr, t.name team, m.is_active, (d.pipeline_id=ANY($2)) fc, count(*)::int n, sum(d.price)::bigint sum,
        count(*) FILTER (WHERE d.status_id NOT IN (142,143))::int open_n,
        coalesce(sum(d.price) FILTER (WHERE d.status_id=ANY($3) AND d.planned_payment_at IS NOT NULL),0)::bigint zone_dated,
        coalesce(sum(d.price) FILTER (WHERE d.status_id=ANY($3) AND d.planned_payment_at IS NULL),0)::bigint zone_nodate,
        count(*) FILTER (WHERE d.status_id=142)::int won_n
      FROM deals d LEFT JOIN managers m ON m.id=d.manager_id LEFT JOIN teams t ON t.id=m.team_id WHERE d.kommo_id=ANY($1) GROUP BY 1,2,3,4 ORDER BY n DESC`,[ids,FC,ZONE]);
    await q("передані угоди, яких НЕМАЄ в deals",`SELECT count(*)::int n FROM unnest($1::bigint[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM deals d WHERE d.kommo_id=x.id)`,[ids]);
    await q("НАБЛИЖЕНО: передані угоди, вхід у 9/142 у листопаді (за поточним менеджером)",`SELECT m.name mgr, t.name team, e.status_id, count(DISTINCT d.kommo_id)::int n, sum(d.price)::bigint sum
      FROM (SELECT kommo_id, status_id, min(changed_at) first_at FROM deal_stage_events WHERE status_id=ANY($2) OR status_id=142 GROUP BY 1,2) e
      JOIN deals d ON d.kommo_id=e.kommo_id LEFT JOIN managers m ON m.id=d.manager_id LEFT JOIN teams t ON t.id=m.team_id
     WHERE d.kommo_id=ANY($1) AND d.pipeline_id=ANY($3) AND (e.first_at ${K})::date BETWEEN '2026-11-01' AND (now() ${K})::date GROUP BY 1,2,3 ORDER BY 1`,[ids,PAID,FC]);
    const rows=await c.query(`SELECT d.kommo_id, d.pipeline_id, d.status_id, d.price::bigint price, to_char(d.planned_payment_at ${K},'YYYY-MM-DD') planned, m.name mgr, t.name team
      FROM deals d LEFT JOIN managers m ON m.id=d.manager_id LEFT JOIN teams t ON t.id=m.team_id WHERE d.kommo_id=ANY($1) AND d.pipeline_id=ANY($2) AND d.status_id NOT IN (142,143) ORDER BY d.price DESC LIMIT 80`,[ids,FC]);
    const trm=new Map(tr.map(x=>[x.id,x]));
    console.log("\n=== відкриті передані FC (до 80, за сумою)"); console.table(rows.rows.map(r=>({...r, moved:trm.get(Number(r.kommo_id))?.at.slice(0,10)})));
  }
  await c.query("ROLLBACK"); await c.end();
})().catch(e=>{console.error("ПОМИЛКА",e.message);process.exit(1)});
