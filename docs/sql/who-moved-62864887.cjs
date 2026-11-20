// Хто переніс угоду 62864887 з «Відкладений запит» у «Клієнти та реактивація» 20.11.2026 о 10:56 Києва.
// ЛИШЕ ЧИТАННЯ: БД у BEGIN READ ONLY … ROLLBACK, Kommo — тільки GET. Секретів не друкує.
// Запуск: cd backend && nice -n 20 node /tmp/w.cjs [kommo_id]
const { Client } = require(process.cwd() + '/node_modules/pg');
const fs = require('fs');
const env = {};
for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = l.match(/^(DATABASE_URL|KOMMO_BASE_URL|KOMMO_API_TOKEN)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const ID = Number(process.argv[2] || 62864887);
const kyiv = (sec) => sec ? new Date(sec * 1000).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) : null;
const cut = (s, n = 160) => (s == null ? s : String(s).replace(/\s+/g, ' ').slice(0, n));

async function kget(path) {
  const r = await fetch(env.KOMMO_BASE_URL + path, { headers: { Authorization: 'Bearer ' + env.KOMMO_API_TOKEN } });
  if (r.status === 204) return {};
  if (!r.ok) throw new Error(path.split('?')[0] + ' → HTTP ' + r.status);
  return r.json();
}

(async () => {
  // ---------- Kommo ----------
  const out = (k, v) => console.log('== ' + k + '\n' + (typeof v === 'string' ? v : JSON.stringify(v, null, 0)));
  const users = new Map();
  try {
    const u = await kget('/api/v4/users?limit=250');
    for (const x of u._embedded?.users ?? []) users.set(x.id, x.name);
  } catch (e) { out('users ERR', e.message); }
  const who = (id) => id === 0 ? '0 (система/робот)' : `${id} ${users.get(id) ?? '?'}`;

  try {
    const a = await kget('/api/v4/account');
    out('k1_token_owner (від чийого імені пише дашборд)', who(a.current_user_id));
  } catch (e) { out('k1 ERR', e.message); }

  try {
    const p = await kget('/api/v4/leads/pipelines/8921932');
    const st = new Map((p._embedded?.statuses ?? []).map((s) => [s.id, s.name]));
    globalThis.stName = (id) => `${id} ${st.get(id) ?? ''}`;
  } catch { globalThis.stName = (id) => String(id); }

  try {
    const l = await kget(`/api/v4/leads/${ID}`);
    out('k2_lead_now', { name: l.name, pipeline: l.pipeline_id, status: stName(l.status_id), responsible: who(l.responsible_user_id),
      created: kyiv(l.created_at), updated: kyiv(l.updated_at), updated_by: who(l.updated_by) });
  } catch (e) { out('k2 ERR', e.message); }

  try {
    const ev = await kget(`/api/v4/events?filter[entity]=lead&filter[entity_id][]=${ID}&limit=100`);
    const rows = (ev._embedded?.events ?? []).sort((a, b) => a.created_at - b.created_at).map((e) => {
      const b = e.value_before?.[0], f = e.value_after?.[0];
      const ls = (x) => x?.lead_status ? `${x.lead_status.pipeline_id}:${stName(x.lead_status.id)}` : null;
      return `${kyiv(e.created_at)} | ${e.type} | by ${who(e.created_by)}`
        + (ls(b) || ls(f) ? ` | ${ls(b)} → ${ls(f)}` : '')
        + (e.type.startsWith('task') || e.type.includes('note') ? ` | ${cut(JSON.stringify(f ?? b), 120)}` : '');
    });
    out(`k3_events (${rows.length})`, rows.join('\n'));
  } catch (e) { out('k3 ERR', e.message); }

  try {
    const t = await kget(`/api/v4/tasks?filter[entity_type]=leads&filter[entity_id][]=${ID}&limit=50`);
    const rows = (t?._embedded?.tasks ?? []).map((x) => `${x.id} | створено ${kyiv(x.created_at)} by ${who(x.created_by)} | до ${kyiv(x.complete_till)}`
      + ` | ${x.is_completed ? 'виконана' : 'відкрита'} | ${cut(x.text, 120)} | результат: ${cut(x.result?.text, 80)}`);
    out(`k4_tasks (${rows.length})`, rows.join('\n'));
  } catch (e) { out('k4 ERR', e.message); }

  try {
    const n = await kget(`/api/v4/leads/${ID}/notes?limit=100`);
    const rows = (n?._embedded?.notes ?? []).sort((a, b) => a.created_at - b.created_at)
      .filter((x) => x.created_at > Date.parse('2026-11-18T00:00:00Z') / 1000)
      .map((x) => `${kyiv(x.created_at)} | ${x.note_type} | by ${who(x.created_by)} | ${cut(x.params?.text ?? JSON.stringify(x.params), 140)}`);
    out(`k5_notes_since_18_11 (${rows.length})`, rows.join('\n'));
  } catch (e) { out('k5 ERR', e.message); }

  // ---------- БД дашборда ----------
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  const Q = {
    d1_deal: [`SELECT kommo_id, pipeline_id, status_id, client_key, manager_id, created_at_kommo, updated_at_kommo FROM deals WHERE kommo_id = $1`, [ID]],
    d2_stage_events: [`SELECT * FROM deal_stage_events WHERE kommo_id = $1`, [ID]],
    d3_next_steps_by_lead: [`SELECT id, client_key, created_by, created_at, due_date, kommo_lead_id, kommo_lead_created, kommo_task_id, kommo_pushed_at, done_at, kommo_task_closed_at, kommo_error, left(text, 80) AS text FROM client_next_steps WHERE kommo_lead_id = $1`, [ID]],
    d4_next_steps_by_client: [`SELECT s.id, s.created_by, s.created_at, s.kommo_lead_id, s.kommo_task_id, s.kommo_pushed_at, s.done_at, left(s.text, 80) AS text
        FROM client_next_steps s WHERE s.client_key = (SELECT client_key FROM deals WHERE kommo_id = $1) ORDER BY s.created_at DESC LIMIT 10`, [ID]],
    d5_onec_pay_plan: [`SELECT * FROM zakaz_onec_pay_plan WHERE deal_id = $1`, [ID]],
    d6_first_touch_closes: [`SELECT * FROM first_touch_closes WHERE kommo_id = $1`, [ID]],
    d7_carrier_client_moves: [`SELECT * FROM carrier_client_moves WHERE kommo_id = $1`, [ID]],
  };
  try {
    for (const [k, [sql, args]] of Object.entries(Q)) {
      try {
        await c.query('SAVEPOINT s');
        const r = await c.query(sql, args);
        out(`${k} (${r.rowCount} рядків)`, r.rows.map((x) => JSON.stringify(x)).join('\n'));
      } catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); out(k + ' ERR', e.message); }
    }
  } finally { await c.query('ROLLBACK'); await c.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
