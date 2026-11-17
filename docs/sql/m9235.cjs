// 9235 замір: READ ONLY. Запуск: cd <repo>/backend && node /tmp/m9235.cjs
const { Client } = require(process.cwd()+"/node_modules/pg");
const fs=require("fs");
if(!process.env.DATABASE_URL){ for (const l of fs.readFileSync(".env","utf8").split("\n")){ const m=l.match(/^DATABASE_URL=(.*)$/); if(m) process.env.DATABASE_URL=m[1].replace(/^["\x27]|["\x27]$/g,""); } }
const FC=[8921932,155304];
const ZONE=[100274340,69716300,98470988,69716304,69716312,10937178,42639144,42639147,25044997,62940068];
const PAID=[69716460,60412544];
const K="AT TIME ZONE 'Europe/Kyiv'";
(async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  await c.query("BEGIN READ ONLY");
  const q=async(label,sql,p=[])=>{ try{ const r=await c.query(sql,p); console.log("\n=== "+label+" ("+r.rows.length+" рядків)"); console.table(r.rows); return r.rows; }catch(e){ console.log("\n=== "+label+" ПОМИЛКА: "+e.message); return []; } };
  // 1. Задача
  const t=await c.query("SELECT to_jsonb(t) j FROM tasks t WHERE id=9235");
  console.log("=== ЗАДАЧА 9235 існує:", t.rows.length);
  if(t.rows.length){ const j=t.rows[0].j; for(const [k,v] of Object.entries(j)) if(v!==null && v!=="" ) console.log("  "+k+": "+(typeof v==="string"?v:JSON.stringify(v))); }
  await q("коментарі задачі","SELECT c.created_at, c.author_id, coalesce(u.full_name, m.name) author, left(c.body,2000) body FROM task_comments c LEFT JOIN users u ON u.id=c.author_id LEFT JOIN managers m ON m.id=u.manager_id WHERE c.task_id=9235 ORDER BY c.created_at");
  await q("історія статусу","SELECT * FROM task_status_log WHERE task_id=9235 ORDER BY 1");
  // 2. Панасюк і Дмитрук
  const pm=await q("менеджери Панасюк","SELECT m.id,m.name,m.kommo_user_id,m.team_id,t.name team,m.is_active,m.is_team_lead FROM managers m LEFT JOIN teams t ON t.id=m.team_id WHERE m.name ILIKE '%Панасюк%'");
  await q("команди Дмитрука","SELECT t.id,t.name,t.kommo_group_id,(SELECT count(*) FROM managers m WHERE m.team_id=t.id AND m.is_active) active FROM teams t WHERE t.name ILIKE '%Дмитрук%' OR t.id IN (SELECT team_id FROM managers WHERE name ILIKE '%Дмитрук%')");
  await q("Дмитрук","SELECT id,name,team_id,is_active,is_team_lead FROM managers WHERE name ILIKE '%Дмитрук%'");
  const ids=pm.map(x=>x.id); const kids=pm.map(x=>String(x.kommo_user_id));
  if(!ids.length){ console.log("ПАНАСЮКА НЕ ЗНАЙДЕНО"); await c.query("ROLLBACK"); await c.end(); return; }
  await q("логіни Панасюка","SELECT id,role,is_active,deactivated_at,deactivated_reason,manager_id FROM users WHERE manager_id=ANY($1)",[ids]);
  await q("manager_work_state","SELECT * FROM manager_work_state WHERE manager_id=ANY($1)",[ids]);
  await q("manager_team_overrides","SELECT * FROM manager_team_overrides WHERE kommo_user_id::text=ANY($1)",[kids]);
  await q("manager_team_moves","SELECT * FROM manager_team_moves WHERE manager_id=ANY($1) ORDER BY effective_from",[ids]);
  await q("manager_team_history (останні 10)","SELECT * FROM manager_team_history WHERE manager_id=ANY($1) ORDER BY 1 DESC LIMIT 10",[ids]);
  // 3. Угоди Панасюка в повному циклі
  await q("угоди Панасюка FC по статусу (відкриті)",`SELECT d.manager_id, d.pipeline_id, d.status_id, (d.status_id=ANY($2)) in_zone, count(*)::int n, sum(d.price)::bigint sum,
      count(*) FILTER (WHERE d.planned_payment_at IS NULL)::int no_date,
      count(*) FILTER (WHERE (d.planned_payment_at ${K})::date < (now() ${K})::date)::int date_past,
      max(d.updated_at_kommo) last_upd
    FROM deals d WHERE d.manager_id=ANY($1) AND d.pipeline_id=ANY($3) AND d.status_id NOT IN (142,143)
    GROUP BY 1,2,3,4 ORDER BY 4 DESC, n DESC`,[ids,ZONE,FC]);
  await q("зона очікування Панасюка: з датою / без дати",`SELECT
      count(*) FILTER (WHERE d.planned_payment_at IS NOT NULL)::int dated_n, coalesce(sum(d.price) FILTER (WHERE d.planned_payment_at IS NOT NULL),0)::bigint dated_sum,
      count(*) FILTER (WHERE d.planned_payment_at IS NOT NULL AND to_char(d.planned_payment_at ${K},'YYYY-MM')=to_char(now() ${K},'YYYY-MM'))::int this_month_n,
      coalesce(sum(d.price) FILTER (WHERE d.planned_payment_at IS NOT NULL AND to_char(d.planned_payment_at ${K},'YYYY-MM')=to_char(now() ${K},'YYYY-MM')),0)::bigint this_month_sum,
      count(*) FILTER (WHERE d.planned_payment_at IS NOT NULL AND (d.planned_payment_at ${K})::date < date_trunc('month', now() ${K})::date)::int past_months_n,
      coalesce(sum(d.price) FILTER (WHERE d.planned_payment_at IS NOT NULL AND (d.planned_payment_at ${K})::date < date_trunc('month', now() ${K})::date),0)::bigint past_months_sum,
      count(*) FILTER (WHERE d.planned_payment_at IS NULL)::int nodate_n, coalesce(sum(d.price) FILTER (WHERE d.planned_payment_at IS NULL),0)::bigint nodate_sum
    FROM deals d WHERE d.manager_id=ANY($1) AND d.pipeline_id=ANY($2) AND d.status_id=ANY($3)`,[ids,FC,ZONE]);
  await q("угоди Панасюка в інших воронках (відкриті)",`SELECT d.pipeline_id, count(*)::int n, sum(d.price)::bigint sum FROM deals d WHERE d.manager_id=ANY($1) AND NOT (d.pipeline_id=ANY($2)) AND d.status_id NOT IN (142,143) GROUP BY 1 ORDER BY n DESC`,[ids,FC]);
  await q("розбіжність manager_id і kommo_user_id у відкритих",`SELECT count(*)::int n FROM deals d WHERE d.manager_id=ANY($1) AND d.status_id NOT IN (142,143) AND d.kommo_user_id::text <> ALL($2)`,[ids,kids]);
  // 4. Гроші листопада (НАБЛИЖЕНО: перший вхід у «оплата отримана»/«успішна» в листопаді; канон — core/money.ts)
  await q("НАБЛИЖЕНО: вхід у 9/142 у листопаді по угодах Панасюка",`SELECT e.status_id, count(DISTINCT d.kommo_id)::int n, sum(d.price)::bigint sum
    FROM (SELECT kommo_id, status_id, min(changed_at) first_at FROM deal_stage_events WHERE status_id = ANY($2) OR status_id=142 GROUP BY 1,2) e
    JOIN deals d ON d.kommo_id=e.kommo_id
   WHERE d.manager_id=ANY($1) AND d.pipeline_id=ANY($3) AND (e.first_at ${K})::date BETWEEN '2026-11-01' AND (now() ${K})::date GROUP BY 1`,[ids,PAID,FC]);
  // 5. Відкриті угоди за місяцем останнього руху
  await q("відкриті FC за місяцем створення",`SELECT to_char(d.created_at_kommo ${K},'YYYY-MM') ym, count(*)::int n, sum(d.price)::bigint sum FROM deals d WHERE d.manager_id=ANY($1) AND d.pipeline_id=ANY($2) AND d.status_id NOT IN (142,143) GROUP BY 1 ORDER BY 1`,[ids,FC]);
  await q("sync_state","SELECT last_synced_at FROM sync_state WHERE id=1");
  await c.query("ROLLBACK"); await c.end();
})().catch(e=>{console.error("ПОМИЛКА",e.message);process.exit(1)});
