// ДВА ЗАМІРИ ОДНИМ ЗАПУСКОМ (27.11.2026). Базу лише ЧИТАЄ (BEGIN READ ONLY … ROLLBACK), у 1С один GET, у Kommo не ходить.
// Секретів не друкує. Запуск із теки backend прод-чекауту:  cd <repo>/backend && nice -n 20 node /tmp/m2.cjs
//
//   D  ВІДСІВ ПЕРЕВІЗНИКІВ: ціна скорочення паузи 15 хв → 2 хв (Роман 27.11: «спершу порахуй ціну»). Пауза — це
//      `CARRIER_RULE.minAgeMin`: угоду етапу «Дзвінки на мобільні» беремо лише старшу за 15 хв, щоб фільтр CRM (раз на 10 хв)
//      встиг прибрати знайомих. Питання: скільки угод фільтр прибирає САМ між 2-ю і 15-ю хвилиною (їх ми почнемо обробляти),
//      скільки з них мають розмову від 10 с і не впізнаються безплатно, і скільки коштує один AI-розбір.
//   E  11225: ЄДРПОУ в оплатах 1С (`paydata`, поле ERPOU, яке синк зараз викидає) — у скількох оплат 2026 року воно є і
//      скільки постійних клієнтів зіллється / розпадеться, якщо ключем стане код.
const fs = require("node:fs");
const { createRequire } = require("node:module");
const req = createRequire(process.cwd() + "/package.json");
const { Client } = req("pg");
const WANT = ["DATABASE_URL", "RECEIVABLES_1C_URL"];
if (fs.existsSync(".env")) for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && WANT.includes(m[1]) && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const ONEC = process.env.RECEIVABLES_1C_URL || "http://193.200.173.188:8010/rest-bk/hs/service/debit-balance-account-361";
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "--only=DE").slice(7).toUpperCase();
const DAYS = 30, PIPE = 8921928, STAGE = 70419108;
const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "—");
const money = (n) => Math.round(n).toLocaleString("uk-UA").replace(/ | /g, " ");
const head = (s) => console.log(`\n══ ${s}`);
async function section(c, name, fn) {
  await c.query(`SAVEPOINT s`);
  try { await fn(); await c.query(`RELEASE SAVEPOINT s`); }
  catch (e) { await c.query(`ROLLBACK TO SAVEPOINT s`).catch(() => undefined); console.log(`🔴 ${name}: не вийшло — ${e?.message || e}`); }
}

async function partD(c) {
  head(`D1 · відсів · угоди з назвою-номером за ${DAYS} днів: коли вони ВПЕРШЕ змінили етап`);
  // Угода етапу: назва = номер 380XXXXXXXXX (так її називає Ringostat) і вона або зараз у воронці Кваліфікація, або її
  // перший рух був у цій воронці, або її записав наш відсів. Перший рух = найраніша подія зміни етапу після створення.
  const BASE = `
    WITH d AS (
      SELECT x.kommo_id, x.name AS phone, x.created_at_kommo AS created, x.pipeline_id, x.status_id,
             (SELECT e.changed_at FROM deal_stage_events e WHERE e.kommo_id = x.kommo_id ORDER BY e.changed_at, e.id LIMIT 1) AS first_at,
             (SELECT e.pipeline_id FROM deal_stage_events e WHERE e.kommo_id = x.kommo_id ORDER BY e.changed_at, e.id LIMIT 1) AS first_pipe,
             (SELECT e.status_id FROM deal_stage_events e WHERE e.kommo_id = x.kommo_id ORDER BY e.changed_at, e.id LIMIT 1) AS first_status,
             EXISTS (SELECT 1 FROM carrier_call_deals cd WHERE cd.kommo_id = x.kommo_id) AS ours
        FROM deals x
       WHERE x.name ~ '^380[0-9]{9}$' AND x.created_at_kommo >= now() - interval '${DAYS} days' AND x.created_at_kommo < now() - interval '4 hours'
    ), s AS (
      SELECT d.*, EXTRACT(EPOCH FROM (d.first_at - d.created)) / 60.0 AS mins,
             CASE WHEN d.first_at IS NULL THEN 'e_не рухалась'
                  WHEN d.first_at - d.created < interval '2 minutes' THEN 'a_до 2 хв'
                  WHEN d.first_at - d.created < interval '15 minutes' THEN 'b_2–15 хв'
                  WHEN d.first_at - d.created < interval '4 hours' THEN 'c_15 хв – 4 год'
                  ELSE 'd_пізніше 4 год' END AS bucket
        FROM d WHERE d.ours OR d.pipeline_id = ${PIPE} OR d.first_pipe = ${PIPE}
    )`;
  const b = (await c.query(`${BASE} SELECT bucket, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ours)::int AS ours FROM s GROUP BY 1 ORDER BY 1`)).rows;
  const total = b.reduce((a, r) => a + r.n, 0);
  console.log(`   угод етапу за ${DAYS} днів: ${total} (≈ ${Math.round(total / DAYS)} на день)`);
  for (const r of b) console.log(`   ${r.bucket.slice(2).padEnd(16)}: ${String(r.n).padStart(5)} (${pct(r.n, total)}) · з них записані нашим відсівом: ${r.ours}`);
  const tgt = (await c.query(`${BASE} SELECT first_pipe::text AS p, first_status::text AS st, COUNT(*)::int AS n FROM s WHERE bucket = 'b_2–15 хв' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 6`)).rows;
  console.log(`   куди йдуть угоди, що рухаються між 2-ю і 15-ю хв (воронка:етап · шт): ${tgt.map((r) => `${r.p}:${r.st} · ${r.n}`).join(" | ") || "немає"}`);

  head("D2 · відсів · що з прибраних за 2–15 хв довелося б слухати AI");
  const x = (await c.query(`${BASE}, y AS (
      SELECT s.kommo_id, s.phone,
             EXISTS (SELECT 1 FROM ringostat_calls rc WHERE rc.client_phone = s.phone AND rc.billsec >= 10 AND rc.recording IS NOT NULL
                        AND rc.calldate >= s.created - interval '10 minutes' AND rc.calldate <= s.created + interval '24 hours') AS talk,
             EXISTS (SELECT 1 FROM carrier_phones cp WHERE cp.p9 = right(s.phone, 9)) AS in_dir,
             EXISTS (SELECT 1 FROM carrier_call_deals cd WHERE cd.phone = s.phone AND cd.state IN ('own','reused','lardi','history')
                        AND cd.deal_created_at >= s.created - interval '30 days' AND cd.deal_created_at < s.created) AS known30
        FROM s WHERE s.bucket = 'b_2–15 хв' AND NOT s.ours)
    SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE talk)::int AS talk,
           COUNT(*) FILTER (WHERE talk AND (in_dir OR known30))::int AS talk_free,
           COUNT(*) FILTER (WHERE talk AND NOT in_dir AND NOT known30)::int AS talk_ai FROM y`)).rows[0];
  console.log(`   прибрані фільтром CRM за 2–15 хв і НЕ записані нами: ${x.n} за ${DAYS} днів`);
  console.log(`   з них з розмовою від 10 с із записом: ${x.talk} · номер уже відомий (довідник перевізників або вердикт за 30 днів): ${x.talk_free} · пішли б в AI: ${x.talk_ai} (≈ ${(x.talk_ai / DAYS).toFixed(1)} на день)`);

  head("D3 · відсів · що вже робимо і скільки це коштує");
  const st = (await c.query(`SELECT state, COUNT(*)::int AS n FROM carrier_call_deals WHERE deal_created_at >= now() - interval '${DAYS} days' GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const own = st.find((r) => r.state === "own")?.n ?? 0;
  console.log(`   записано нашим відсівом за ${DAYS} днів: ${st.reduce((a, r) => a + r.n, 0)} · за станом: ${st.map((r) => `${r.state} ${r.n}`).join(" · ")}`);
  const sp = (await c.query(`
    SELECT COALESCE(SUM(usd) FILTER (WHERE at >= now() - interval '${DAYS} days'), 0)::float AS d30,
           COALESCE(SUM(usd) FILTER (WHERE (at AT TIME ZONE 'Europe/Kyiv') >= date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv')), 0)::float AS mtd,
           COUNT(DISTINCT uniqueid) FILTER (WHERE at >= now() - interval '${DAYS} days')::int AS calls
      FROM ai_spend_ledger WHERE operation LIKE 'carrier\\_%'`)).rows[0];
  const per = sp.calls > 0 ? sp.d30 / sp.calls : 0;
  console.log(`   витрати AI на мобільні: за ${DAYS} днів ${sp.d30.toFixed(2)} $ на ${sp.calls} розмов (≈ ${per.toFixed(4)} $ за розмову) · з початку місяця ${sp.mtd.toFixed(2)} $ зі стелі 15 $`);
  console.log(`   прогноз доплати при паузі 2 хв: ${x.talk_ai} розмов × ${per.toFixed(4)} $ ≈ ${(x.talk_ai * per).toFixed(2)} $ за ${DAYS} днів (разом ≈ ${(sp.d30 + x.talk_ai * per).toFixed(2)} $)`);
  const lat = (await c.query(`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (seen_at - deal_created_at)) / 60.0)::float AS seen_med,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (seen_at - deal_created_at)) / 60.0)::float AS seen_p90,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - deal_created_at)) / 60.0) FILTER (WHERE state IN ('own','reused','lardi','history'))::float AS done_med
      FROM carrier_call_deals WHERE deal_created_at >= now() - interval '${DAYS} days' AND seen_at >= deal_created_at`)).rows[0];
  console.log(`   зараз від створення угоди до нашого запису: медіана ${lat.seen_med?.toFixed(1)} хв, 90% до ${lat.seen_p90?.toFixed(1)} хв · до вердикту: медіана ${lat.done_med?.toFixed(1)} хв`);
  console.log(`   цих самих ${x.n} угод за ${DAYS} днів (≈ ${(x.n / DAYS).toFixed(1)} на день) торкнуться й наші дії в Kommo (черговий менеджер, закриття), якщо не чекати фільтра`);
}

async function partE(c) {
  head("E · 11225 · ЄДРПОУ в оплатах 1С («paydata», поле ERPOU)");
  let rows;
  try {
    const res = await fetch(new URL("paydata", ONEC).toString(), { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json(); rows = Array.isArray(j) ? j : [j];
  } catch (e) { console.log(`   🔴 1С недосяжна звідси: ${e?.message || e}. Цей розділ запускати на сервері.`); return; }
  const y26 = rows.filter((x) => /\.2026\b/.test(String(x?.Data ?? "")));
  const code = (x) => { const d = String(x?.ERPOU ?? "").replace(/\D/g, ""); return /^(\d{8}|\d{10}|\d{12})$/.test(d) ? d : null; };
  const raw = (x) => String(x?.ERPOU ?? "").trim();
  const withDeal = y26.filter((x) => /^\d{8}$/.test(String(x?.Deal ?? "").trim()));
  const coded = withDeal.filter((x) => code(x));
  const lens = new Map(); for (const x of y26) { const k = raw(x) ? `${raw(x).replace(/\D/g, "").length} цифр` : "порожньо"; lens.set(k, (lens.get(k) || 0) + 1); }
  console.log(`   оплат 2026: ${y26.length} · з номером угоди ${withDeal.length} · з них з кодом ${coded.length} (${pct(coded.length, withDeal.length)})`);
  console.log(`   що стоїть у полі ERPOU (усі оплати 2026): ${[...lens.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  const GENERIC = /^(фізична особа|підрядник|<>|)$/i;
  const gen = withDeal.filter((x) => GENERIC.test(String(x?.Kontragent ?? "").trim()));
  console.log(`   оплат з угодою, де контрагент — «Фізична особа» / «Підрядник» / порожньо: ${gen.length} (${pct(gen.length, withDeal.length)}) · з них з кодом ${gen.filter((x) => code(x)).length}`);
  const names = new Map(), codesOfName = new Map();
  for (const x of coded) { const k = code(x), nm = String(x?.Kontragent ?? "").trim(); if (!names.has(k)) names.set(k, new Set()); names.get(k).add(nm); if (!codesOfName.has(nm)) codesOfName.set(nm, new Set()); codesOfName.get(nm).add(k); }
  console.log(`   різних кодів ${names.size} · код під кількома назвами контрагента ${[...names.values()].filter((s) => s.size > 1).length} · назва з кількома кодами ${[...codesOfName.values()].filter((s) => s.size > 1).length}`);
  const deals = [...new Set(withDeal.map((x) => String(x.Deal).trim()))];
  const map = new Map((await c.query(`
    SELECT d.kommo_id::text AS id, d.client_key, COALESCE(d.payment_type, '(порожньо)') AS pt
      FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND d.kommo_id = ANY($1::bigint[])`, [deals])).rows.map((r) => [r.id, r]));
  const reg = new Set((await c.query(`
    SELECT d.client_key FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= 2`)).rows.map((r) => r.client_key));
  const codesOf = new Map(), clientsOf = new Map(), seen = new Set(), noCodePt = new Map();
  for (const x of withDeal) {
    const d = map.get(String(x.Deal).trim()); if (!d) continue;
    seen.add(d.client_key);
    const k = code(x);
    if (!k) { noCodePt.set(d.pt, (noCodePt.get(d.pt) || 0) + 1); continue; }
    if (!codesOf.has(d.client_key)) codesOf.set(d.client_key, new Set()); codesOf.get(d.client_key).add(k);
    if (!clientsOf.has(k)) clientsOf.set(k, new Set()); clientsOf.get(k).add(d.client_key);
  }
  const stat = (keys, label) => {
    const known = keys.filter((k) => codesOf.has(k));
    const split = known.filter((k) => codesOf.get(k).size > 1);
    const merged = known.filter((k) => [...codesOf.get(k)].some((cd) => clientsOf.get(cd).size > 1));
    console.log(`   ${label}: ${keys.length} · код відомий ${known.length} (${pct(known.length, keys.length)}) · розпадеться (2+ коди) ${split.length} · зіллється з іншим клієнтом ${merged.length} · без змін ${known.length - new Set([...split, ...merged]).size}`);
  };
  stat([...seen], "клієнти з оплатою 1С у 2026");
  stat([...seen].filter((k) => reg.has(k)), "з них постійні (2+ оплати за весь час)");
  console.log(`   оплати 2026 БЕЗ коду, за формою оплати угоди: ${[...noCodePt.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "немає"}`);
  const groups = [...clientsOf.entries()].filter(([, s]) => s.size > 1).sort((a, b) => b[1].size - a[1].size);
  console.log(`   груп злиття за кодом: ${groups.length}, у них ключів ${groups.reduce((a, [, s]) => a + s.size, 0)} · приклади (до 6): ${groups.slice(0, 6).map(([cd, s]) => `${[...names.get(cd)][0]} ← ${[...s].slice(0, 4).join(" | ")}`).join("; ") || "немає"}`);
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log("🔴 немає DATABASE_URL у .env — замір неможливий"); process.exit(1); }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  try {
    console.log(`замір: пауза відсіву перевізників і ЄДРПОУ в оплатах 1С · ${new Date().toISOString()} · розділи: ${ONLY}`);
    if (ONLY.includes("D")) await section(c, "розділ D", () => partD(c));
    if (ONLY.includes("E")) await section(c, "розділ E", () => partE(c));
  } finally { await c.query("ROLLBACK").catch(() => undefined); await c.end(); }
  console.log("\nкінець заміру");
})().catch((e) => { console.error("🔴", e?.message || e); process.exit(1); });
