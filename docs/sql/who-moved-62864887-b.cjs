// Замір 2 до 62864887: що ще робив акаунт Admin (904923) 20.11 навколо 10:56 і хто взагалі переносить угоди в
// «Клієнти та реактивація». ЛИШЕ ЧИТАННЯ: Kommo тільки GET, БД у BEGIN READ ONLY … ROLLBACK. Секретів не друкує.
// Запуск: cd backend && nice -n 20 node /tmp/w2.cjs
const { Client } = require(process.cwd() + '/node_modules/pg');
const fs = require('fs');
const env = {};
for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = l.match(/^(DATABASE_URL|KOMMO_BASE_URL|KOMMO_API_TOKEN)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const ADMIN = 904923, PIPE = 8921932, REACT = 114070576;
const kyiv = (sec) => new Date(sec * 1000).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
async function kget(path) {
  const r = await fetch(env.KOMMO_BASE_URL + path, { headers: { Authorization: 'Bearer ' + env.KOMMO_API_TOKEN } });
  if (r.status === 204) return {};
  if (!r.ok) throw new Error(path.split('?')[0] + ' → HTTP ' + r.status);
  return r.json();
}
async function allEvents(q) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await kget(`/api/v4/events?limit=100&page=${page}&${q}`);
    const ev = r._embedded?.events ?? [];
    out.push(...ev);
    if (ev.length < 100) break;
    await new Promise((s) => setTimeout(s, 300));
  }
  return out.sort((a, b) => a.created_at - b.created_at);
}
const out = (k, v) => console.log('== ' + k + '\n' + v);

(async () => {
  const users = new Map();
  try { for (const x of (await kget('/api/v4/users?limit=250'))._embedded?.users ?? []) users.set(x.id, x.name); } catch {}
  const who = (id) => id === 0 ? '0 робот' : `${id} ${users.get(id) ?? '?'}`;
  const st = new Map();
  try { for (const s of (await kget(`/api/v4/leads/pipelines/${PIPE}`))._embedded?.statuses ?? []) st.set(s.id, s.name); } catch {}
  const ls = (x) => x?.lead_status ? `${x.lead_status.pipeline_id === PIPE ? '' : x.lead_status.pipeline_id + ':'}${st.get(x.lead_status.id) ?? x.lead_status.id}` : '';

  // k1: усе, що робив Admin 20.11 з 10:40 до 11:15 Києва
  try {
    const ev = await allEvents(`filter[created_by][]=${ADMIN}&filter[created_at][from]=${unix('2026-11-20T08:40:00Z')}&filter[created_at][to]=${unix('2026-11-20T09:15:00Z')}`);
    out(`k1_admin_20_11_10:40-11:15 (${ev.length})`, ev.map((e) => `${kyiv(e.created_at)} | ${e.type} | ${e.entity_type} ${e.entity_id}`
      + (ls(e.value_before?.[0]) || ls(e.value_after?.[0]) ? ` | ${ls(e.value_before?.[0])} → ${ls(e.value_after?.[0])}` : '')).join('\n'));
  } catch (e) { out('k1 ERR', e.message); }

  // k2: усі переїзди в «Клієнти та реактивація» з 12.11 — хто і звідки
  let k2 = [];
  try {
    k2 = await allEvents(`filter[type][]=lead_status_changed&filter[created_at][from]=${unix('2026-11-12T00:00:00Z')}`
      + `&filter[value_after][leads_statuses][0][pipeline_id]=${PIPE}&filter[value_after][leads_statuses][0][status_id]=${REACT}`);
    const by = new Map();
    for (const e of k2) { const k = `${who(e.created_by)} | з «${ls(e.value_before?.[0])}»`; by.set(k, (by.get(k) ?? 0) + 1); }
    out(`k2_into_react_since_12_11 (${k2.length}) — зведення`, [...by].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} × ${k}`).join('\n'));
    out('k2_by_admin_list', k2.filter((e) => e.created_by === ADMIN).map((e) => `${kyiv(e.created_at)} | lead ${e.entity_id} | з «${ls(e.value_before?.[0])}»`).join('\n'));
  } catch (e) { out('k2 ERR', e.message); }

  // БД: що дашборд писав у Kommo в ту хвилину (задачі 8345) і чи знає він угоди з k2
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  try {
    const r1 = await c.query(`SELECT id, client_key, kommo_lead_id, kommo_lead_created, kommo_task_id, kommo_pushed_at FROM client_next_steps
      WHERE kommo_pushed_at BETWEEN '2026-11-20T08:40:00Z' AND '2026-11-20T09:15:00Z' ORDER BY kommo_pushed_at`);
    out(`d1_dashboard_pushes_10:40-11:15 (${r1.rowCount})`, r1.rows.map((x) => JSON.stringify(x)).join('\n'));
    const ids = k2.filter((e) => e.created_by === ADMIN).map((e) => e.entity_id);
    const r2 = await c.query(`SELECT kommo_lead_id::text AS lead, count(*)::int AS steps, bool_or(kommo_lead_created) AS created_by_dashboard
      FROM client_next_steps WHERE kommo_lead_id = ANY($1::bigint[]) GROUP BY 1`, [ids]);
    out(`d2_admin_moves_known_to_8345 (${r2.rowCount} з ${ids.length})`, r2.rows.map((x) => JSON.stringify(x)).join('\n'));
  } finally { await c.query('ROLLBACK'); await c.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
