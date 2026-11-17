// 9235 замір 3: READ ONLY. Скільки ІСТОРІЇ Панасюка переїхало на нових відповідальних (kommo_user_id = перший відповідальний, синк його не оновлює).
const { Client } = require(process.cwd()+"/node_modules/pg");
const fs=require("fs");
if(!process.env.DATABASE_URL){ for (const l of fs.readFileSync(".env","utf8").split("\n")){ const m=l.match(/^DATABASE_URL=(.*)$/); if(m) process.env.DATABASE_URL=m[1].replace(/^["\x27]|["\x27]$/g,""); } }
const FC=[8921932,155304], PAID=[69716460,60412544], K="AT TIME ZONE 'Europe/Kyiv'";
(async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect(); await c.query("BEGIN READ ONLY");
  const q=async(label,sql,p=[])=>{ try{ const r=await c.query(sql,p); console.log("\n=== "+label+" ("+r.rows.length+" рядків)"); console.table(r.rows); }catch(e){ console.log("\n=== "+label+" ПОМИЛКА: "+e.message); } };
  await q("угоди з першим відповідальним Панасюк: зараз у кого",`SELECT m.name, (d.pipeline_id=ANY($2)) fc, count(*)::int n FROM deals d LEFT JOIN managers m ON m.id=d.manager_id WHERE d.kommo_user_id=$1 GROUP BY 1,2 ORDER BY n DESC`,[14926076,FC]);
  await q("НАБЛИЖЕНО: перший вхід у «Оплата отримана» по місяцях (FC, перший відповідальний Панасюк)",`SELECT to_char(e.first_at ${K},'YYYY-MM') ym, m.name now_on, count(*)::int n, sum(d.price)::bigint sum
    FROM (SELECT kommo_id, min(changed_at) first_at FROM deal_stage_events WHERE status_id=ANY($3) GROUP BY 1) e JOIN deals d ON d.kommo_id=e.kommo_id LEFT JOIN managers m ON m.id=d.manager_id
   WHERE d.kommo_user_id=$1 AND d.pipeline_id=ANY($2) GROUP BY 1,2 ORDER BY 1,2`,[14926076,FC,PAID]);
  await q("НАБЛИЖЕНО: успішні 142 за місяцем закриття (FC, перший відповідальний Панасюк)",`SELECT to_char(d.closed_at_kommo ${K},'YYYY-MM') ym, m.name now_on, count(*)::int n, sum(d.price)::bigint sum
    FROM deals d LEFT JOIN managers m ON m.id=d.manager_id WHERE d.kommo_user_id=$1 AND d.pipeline_id=ANY($2) AND d.status_id=142 GROUP BY 1,2 ORDER BY 1,2`,[14926076,FC]);
  await c.query("ROLLBACK"); await c.end();
})().catch(e=>{console.error("ПОМИЛКА",e.message);process.exit(1)});
