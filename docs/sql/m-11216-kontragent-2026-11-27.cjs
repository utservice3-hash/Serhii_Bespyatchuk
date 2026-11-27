// ЗАМІР ДО ЗАДАЧ 11225 / 11231 / 11223 (27.11.2026, «роби замір» Романа). Базу лише ЧИТАЄ (BEGIN READ ONLY … ROLLBACK),
// у 1С і Kommo лише GET. Секретів не друкує (токен — лише в заголовку). Запуск із теки backend прод-чекауту:
//   cd <repo>/backend && nice -n 20 node /tmp/m11216.cjs
// Кожен розділ незалежний: упав один (немає доступу до 1С чи Kommo) — решта друкується, причина названа словами.
//
//   A  11225 «клієнт = контрагент із рахунку»: у скількох оплачених угод 1С знає контрагента, у скількох компанія
//      Kommo має код; скільки нинішніх клієнтів РОЗПАДЕТЬСЯ (кілька контрагентів під одним ключем) і скільки
//      ЗІЛЛЄТЬСЯ (один контрагент під кількома ключами), якщо ключем стане назва контрагента з 1С.
//   B  11231 «рахунки 1С без угоди»: скільки рядків реалізацій (`costinvoice`) та оплат (`paydata`) 1С віддає БЕЗ
//      номера угоди (зараз синк їх відкидає), за роками й сумою; і скільки мають номер угоди, якої немає в `deals`.
//   C  11223 «розмова = дзвінок на номер із картки компанії»: у скількох постійних клієнтів компанія Kommo має свій
//      номер (поле PHONE компанії — у базі його немає), і скільки розмов за 90 днів припадає на такі номери.
const fs = require("node:fs");
const { createRequire } = require("node:module");
const req = createRequire(process.cwd() + "/package.json");
const { Client } = req("pg");
const WANT = ["DATABASE_URL", "KOMMO_BASE_URL", "KOMMO_API_TOKEN", "RECEIVABLES_1C_URL"];
if (fs.existsSync(".env")) for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && WANT.includes(m[1]) && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const ONEC = process.env.RECEIVABLES_1C_URL || "http://193.200.173.188:8010/rest-bk/hs/service/debit-balance-account-361";
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "--only=ABC").slice(7).toUpperCase();

// Копія `utils/clientName.ts` → `normalizeClientName` (скрипт не залежить від dist). Розійдеться з ядром — числа A3 зсунуться.
const PHRASES = ["товариство з обмеженою відповідальністю", "общество с ограниченной ответственностью"];
const TOKENS = ["тов", "пп", "фоп", "пат", "ооо", "зат", "тзов", "прат"];
function norm(raw) {
  if (!raw) return null;
  let name = String(raw).toLowerCase();
  for (const p of PHRASES) name = name.split(p).join(" ");
  name = name.replace(/["'«»“”]/g, " ").replace(/[.,]/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = name.split(/\s+/).filter(Boolean);
  const f = words.filter((w) => !TOKENS.includes(w));
  const key = (f.length > 0 ? f : words).join("").trim();
  return key.length > 0 ? key : null;
}
const p9 = (v) => { const d = String(v ?? "").replace(/\D/g, ""); return d.length >= 9 ? d.slice(-9) : null; };
const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "—");
const money = (n) => Math.round(n).toLocaleString("uk-UA").replace(/ | /g, " ");
const head = (s) => console.log(`\n══ ${s}`);
const PAID = `FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
              WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL`;

async function section(c, name, fn) {
  await c.query(`SAVEPOINT s`);
  try { await fn(); await c.query(`RELEASE SAVEPOINT s`); }
  catch (e) { await c.query(`ROLLBACK TO SAVEPOINT s`).catch(() => undefined); console.log(`🔴 ${name}: не вийшло — ${e?.message || e}`); }
}

async function partA(c) {
  head("A1 · 11225 · оплачені угоди: що про них знає 1С і Kommo");
  const base = (await c.query(`
    WITH paid AS (SELECT d.kommo_id, d.client_key, d.payment_type, d.closed_at_kommo ${PAID})
    SELECT (p.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= DATE '2026-01-01' AS y26,
           COUNT(*)::int AS deals,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM onec_deal_invoices i WHERE i.deal_id = p.kommo_id AND btrim(COALESCE(i.kontragent,'')) <> ''))::int AS with_inv,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM onec_deal_payments i WHERE i.deal_id = p.kommo_id AND btrim(COALESCE(i.kontragent,'')) <> ''))::int AS with_pay,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM deal_companies dc WHERE dc.deal_kommo_id = p.kommo_id))::int AS with_company,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM deal_companies dc JOIN kommo_companies kc ON kc.company_id = dc.company_id
                                           WHERE dc.deal_kommo_id = p.kommo_id AND (kc.edrpou IS NOT NULL OR kc.ipn IS NOT NULL)))::int AS with_code
      FROM paid p GROUP BY 1 ORDER BY 1`)).rows;
  for (const r of base) console.log(`   ${r.y26 ? "2026 рік   " : "до 2026    "}: угод ${r.deals} · контрагент у реалізаціях 1С ${r.with_inv} (${pct(r.with_inv, r.deals)}) · в оплатах 1С ${r.with_pay} (${pct(r.with_pay, r.deals)}) · компанія в Kommo ${r.with_company} (${pct(r.with_company, r.deals)}) · код ЄДРПОУ/ІПН ${r.with_code} (${pct(r.with_code, r.deals)})`);
  const span = (await c.query(`SELECT (SELECT COUNT(*)::int FROM onec_deal_invoices) AS inv, (SELECT MIN(doc_on)::text FROM onec_deal_invoices) AS inv_from,
                                      (SELECT COUNT(*)::int FROM onec_deal_payments) AS pay, (SELECT MIN(paid_on)::text FROM onec_deal_payments) AS pay_from`)).rows[0];
  console.log(`   глибина 1С у базі: реалізацій ${span.inv} (з ${span.inv_from}), оплат ${span.pay} (з ${span.pay_from})`);
  const pt = (await c.query(`
    SELECT COALESCE(d.payment_type, '(порожньо)') AS pt, COUNT(*)::int AS n ${PAID}
       AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= DATE '2026-01-01'
       AND NOT EXISTS (SELECT 1 FROM onec_deal_invoices i WHERE i.deal_id = d.kommo_id)
       AND NOT EXISTS (SELECT 1 FROM onec_deal_payments i WHERE i.deal_id = d.kommo_id)
     GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log(`   оплачені 2026 БЕЗ жодного рядка 1С, за формою оплати: ${pt.map((r) => `${r.pt} ${r.n}`).join(" · ") || "немає"}`);

  head("A2 · 11225 · якщо ключем клієнта стане назва контрагента з 1С");
  const rows = (await c.query(`
    WITH paid AS (SELECT d.kommo_id, d.client_key ${PAID}),
         k AS (SELECT deal_id, kontragent FROM onec_deal_invoices WHERE btrim(COALESCE(kontragent,'')) <> ''
               UNION SELECT deal_id, kontragent FROM onec_deal_payments WHERE btrim(COALESCE(kontragent,'')) <> '')
    SELECT p.client_key, p.kommo_id::text AS deal, k.kontragent FROM paid p LEFT JOIN k ON k.deal_id = p.kommo_id`)).rows;
  const dealsOf = new Map(), kOfClient = new Map(), clientsOfK = new Map(), nameOfK = new Map();
  for (const r of rows) {
    if (!dealsOf.has(r.client_key)) dealsOf.set(r.client_key, new Set());
    dealsOf.get(r.client_key).add(r.deal);
    const nk = norm(r.kontragent);
    if (!nk) continue;
    nameOfK.set(nk, r.kontragent);
    if (!kOfClient.has(r.client_key)) kOfClient.set(r.client_key, new Map());
    const m = kOfClient.get(r.client_key); m.set(nk, (m.get(nk) || 0) + 1);
    if (!clientsOfK.has(nk)) clientsOfK.set(nk, new Set());
    clientsOfK.get(nk).add(r.client_key);
  }
  const all = [...dealsOf.keys()], regular = all.filter((k) => dealsOf.get(k).size >= 2);
  const stat = (keys, label) => {
    const known = keys.filter((k) => kOfClient.has(k));
    const split = known.filter((k) => kOfClient.get(k).size > 1);
    const merged = known.filter((k) => [...kOfClient.get(k).keys()].some((nk) => clientsOfK.get(nk).size > 1));
    const same = known.filter((k) => kOfClient.get(k).size === 1 && [...kOfClient.get(k).keys()][0] === k);
    console.log(`   ${label}: ${keys.length} · контрагент відомий хоч по одній угоді ${known.length} (${pct(known.length, keys.length)}) · невідомий ${keys.length - known.length}`);
    console.log(`      розпадеться (2+ контрагенти під одним клієнтом): ${split.length} · зіллється з іншим клієнтом: ${merged.length} · ключ уже збігається з назвою контрагента: ${same.length}`);
    return { split, merged };
  };
  stat(all, "усі клієнти з оплатою");
  const reg = stat(regular, "постійні (2+ оплати)");
  const groups = [...clientsOfK.entries()].filter(([, s]) => s.size > 1);
  console.log(`   груп злиття (один контрагент 1С під кількома ключами): ${groups.length}, у них ключів ${groups.reduce((a, [, s]) => a + s.size, 0)}`);
  console.log(`   приклади злиття (до 8): ${groups.sort((a, b) => b[1].size - a[1].size).slice(0, 8).map(([nk, s]) => `«${nameOfK.get(nk)}» ← ${[...s].slice(0, 4).join(" | ")}`).join("; ") || "немає"}`);
  console.log(`   приклади розпаду серед постійних (до 8): ${reg.split.sort((a, b) => kOfClient.get(b).size - kOfClient.get(a).size).slice(0, 8).map((k) => `${k} → ${[...kOfClient.get(k).keys()].slice(0, 4).map((nk) => `«${nameOfK.get(nk)}»`).join(", ")}`).join("; ") || "немає"}`);

  head("A3 · 11225 · коди: чи годиться ЄДРПОУ як ключ");
  const codes = (await c.query(`
    WITH paid AS (SELECT d.kommo_id, d.client_key ${PAID}),
         cc AS (SELECT DISTINCT p.client_key, COALESCE(kc.edrpou, kc.ipn) AS code
                  FROM paid p JOIN deal_companies dc ON dc.deal_kommo_id = p.kommo_id JOIN kommo_companies kc ON kc.company_id = dc.company_id
                 WHERE kc.edrpou IS NOT NULL OR kc.ipn IS NOT NULL)
    SELECT (SELECT COUNT(DISTINCT client_key)::int FROM cc) AS clients_with_code,
           (SELECT COUNT(DISTINCT code)::int FROM cc) AS codes,
           (SELECT COUNT(*)::int FROM (SELECT client_key FROM cc GROUP BY 1 HAVING COUNT(*) > 1) x) AS clients_many_codes,
           (SELECT COUNT(*)::int FROM (SELECT code FROM cc GROUP BY 1 HAVING COUNT(*) > 1) x) AS codes_many_clients,
           (SELECT COUNT(*)::int FROM kommo_companies) AS companies,
           (SELECT COUNT(*)::int FROM kommo_companies WHERE edrpou IS NOT NULL OR ipn IS NOT NULL) AS companies_with_code`)).rows[0];
  console.log(`   компаній Kommo в базі ${codes.companies}, з кодом ${codes.companies_with_code} (${pct(codes.companies_with_code, codes.companies)})`);
  console.log(`   клієнтів з кодом ${codes.clients_with_code} · різних кодів ${codes.codes} · клієнт із кількома кодами ${codes.clients_many_codes} · код під кількома клієнтами ${codes.codes_many_clients}`);
  const u = (await c.query(`
    SELECT COUNT(DISTINCT contractor)::int AS names, COUNT(DISTINCT contractor) FILTER (WHERE edrpou IS NOT NULL)::int AS names_code,
           COUNT(DISTINCT edrpou)::int AS codes,
           (SELECT COUNT(*)::int FROM (SELECT edrpou FROM onec_unpaid_invoices WHERE edrpou IS NOT NULL GROUP BY 1 HAVING COUNT(DISTINCT contractor) > 1) x) AS code_many_names,
           (SELECT COUNT(*)::int FROM (SELECT contractor FROM onec_unpaid_invoices WHERE edrpou IS NOT NULL GROUP BY 1 HAVING COUNT(DISTINCT edrpou) > 1) x) AS name_many_codes
      FROM onec_unpaid_invoices`)).rows[0];
  console.log(`   неоплачені рахунки 1С (єдине місце, де 1С віддає код): контрагентів ${u.names}, з кодом ${u.names_code} · кодів ${u.codes} · код під кількома назвами ${u.code_many_names} · назва з кількома кодами ${u.name_many_codes}`);
}

async function onec(name) {
  const res = await fetch(new URL(name, ONEC).toString(), { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`1С, ${name}: HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j) ? j : [j];
}
const numOf = (v) => { if (typeof v === "number") return Number.isFinite(v) ? v : null; const s = String(v ?? "").replace(/[\s  ]/g, "").replace(",", "."); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const yearOf = (v) => { const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(v ?? "").trim()); return m ? m[3] : "без дати"; };
const isUah = (cur) => /^(грн|uah)?$/i.test(String(cur ?? "").trim());

async function partB(c) {
  const known = new Set((await c.query(`SELECT kommo_id::text AS id FROM deals`)).rows.map((r) => r.id));
  console.log(`   угод у базі дашборда: ${known.size}`);
  for (const [name, label] of [["costinvoice", "реалізації"], ["paydata", "оплати клієнтів"]]) {
    head(`B · 11231 · 1С «${name}» (${label})`);
    let rows;
    try { rows = await onec(name); } catch (e) { console.log(`   🔴 1С недосяжна звідси: ${e?.message || e}. Цей розділ запускати на сервері.`); continue; }
    console.log(`   рядків у відповіді: ${rows.length} · поля рядка: ${Object.keys(rows[0] || {}).join(", ")}`);
    const cls = { "порожньо": 0, "не число": 0, "число іншої довжини": 0 }, byYear = new Map(), top = new Map(), ghost = new Map();
    let ok = 0, noSum = 0;
    for (const x of rows) {
      const sum = numOf(x?.Sum);
      if (sum == null) { noSum++; continue; }
      const deal = String(x?.Deal ?? "").trim(), y = yearOf(x?.Data), uah = isUah(x?.Currency);
      if (/^\d{8}$/.test(deal)) {
        ok++;
        if (!known.has(deal)) { const g = ghost.get(y) || { n: 0, sum: 0 }; g.n++; if (uah) g.sum += sum; ghost.set(y, g); }
        continue;
      }
      cls[!deal ? "порожньо" : /^\d+$/.test(deal) ? "число іншої довжини" : "не число"]++;
      const b = byYear.get(y) || { n: 0, sum: 0, fx: 0 }; b.n++; if (uah) b.sum += sum; else b.fx++; byYear.set(y, b);
      if (y === "2026") { const k = String(x?.Kontragent ?? "").trim() || "(без назви)"; const t = top.get(k) || { n: 0, sum: 0 }; t.n++; if (uah) t.sum += sum; top.set(k, t); }
    }
    const noDeal = rows.length - ok - noSum;
    console.log(`   з номером угоди: ${ok} · БЕЗ номера угоди: ${noDeal} (${pct(noDeal, rows.length)}) · без суми: ${noSum}`);
    console.log(`   що стоїть у полі угоди в рядків без номера: ${Object.entries(cls).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    console.log(`   без угоди за роками: ${[...byYear.entries()].sort().map(([y, b]) => `${y}: ${b.n} ряд., ${money(b.sum)} ₴${b.fx ? ` + ${b.fx} валютних` : ""}`).join(" | ") || "немає"}`);
    console.log(`   2026, без угоди, найбільші контрагенти (до 12): ${[...top.entries()].sort((a, b) => b[1].sum - a[1].sum).slice(0, 12).map(([k, t]) => `${k}: ${t.n} ряд., ${money(t.sum)} ₴`).join(" | ") || "немає"}`);
    console.log(`   номер угоди є, але такої угоди в базі дашборда немає, за роками: ${[...ghost.entries()].sort().map(([y, g]) => `${y}: ${g.n} ряд., ${money(g.sum)} ₴`).join(" | ") || "немає"}`);
  }
  head("B · 11231 · неоплачені рахунки 1С без угоди (вже в базі)");
  const u = (await c.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE deal_id IS NULL)::int AS no_deal,
       COALESCE(SUM(remaining) FILTER (WHERE deal_id IS NULL AND currency = 'UAH'), 0)::float AS no_deal_uah,
       COUNT(DISTINCT contractor) FILTER (WHERE deal_id IS NULL)::int AS no_deal_names,
       COUNT(*) FILTER (WHERE deal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.kommo_id = i.deal_id))::int AS ghost
     FROM onec_unpaid_invoices i`)).rows[0];
  console.log(`   неоплачених рахунків 2026: ${u.n} · без угоди ${u.no_deal} на ${money(u.no_deal_uah)} ₴ (контрагентів ${u.no_deal_names}) · з номером угоди, якої немає в базі: ${u.ghost}`);
}

async function kommo(path) {
  const res = await fetch(`${process.env.KOMMO_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${process.env.KOMMO_API_TOKEN}`, Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" }, signal: AbortSignal.timeout(60000) });
  if (res.status === 204) return { _embedded: { companies: [] } };
  if (!res.ok) throw new Error(`Kommo HTTP ${res.status}`);
  return res.json();
}

async function partC(c) {
  head("C · 11223 · номер у картці компанії Kommo (поле PHONE компанії)");
  if (!process.env.KOMMO_BASE_URL || !process.env.KOMMO_API_TOKEN) { console.log("   🔴 немає KOMMO_BASE_URL / KOMMO_API_TOKEN у .env — розділ пропущено"); return; }
  const links = (await c.query(`
    WITH paid AS (SELECT d.kommo_id, d.client_key ${PAID}),
         reg AS (SELECT client_key FROM paid GROUP BY 1 HAVING COUNT(*) >= 2),
         act AS (SELECT r.client_key FROM reg r WHERE EXISTS (SELECT 1 FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
                   WHERE d.client_key = r.client_key AND psm.funnel_stage = 'paid' AND d.closed_at_kommo >= now() - interval '6 months'))
    SELECT a.client_key, dc.company_id::text AS company_id
      FROM act a LEFT JOIN paid p ON p.client_key = a.client_key LEFT JOIN deal_companies dc ON dc.deal_kommo_id = p.kommo_id
     GROUP BY 1, 2`)).rows;
  const compOf = new Map();
  for (const r of links) { if (!compOf.has(r.client_key)) compOf.set(r.client_key, new Set()); if (r.company_id) compOf.get(r.client_key).add(r.company_id); }
  const clients = [...compOf.keys()], ids = [...new Set(links.map((r) => r.company_id).filter(Boolean))];
  console.log(`   постійних з оплатою за 6 міс: ${clients.length} · без жодної компанії в угодах: ${clients.filter((k) => compOf.get(k).size === 0).length} · різних компаній: ${ids.length}`);
  const CAP = 2500, take = ids.slice(0, CAP), phonesOf = new Map();
  if (ids.length > CAP) console.log(`   ⚠ компаній більше за ${CAP}; беру перші ${CAP}, числа нижче неповні`);
  let fetched = 0;
  for (let i = 0; i < take.length; i += 250) {
    const part = take.slice(i, i + 250);
    const j = await kommo(`/api/v4/companies?limit=250&${part.map((id) => `filter[id][]=${id}`).join("&")}`);
    for (const co of j?._embedded?.companies ?? []) {
      fetched++;
      const f = (co.custom_fields_values || []).find((x) => x.field_code === "PHONE");
      const ps = new Set((f?.values || []).map((v) => p9(v?.value)).filter(Boolean));
      phonesOf.set(String(co.id), ps);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`   запитів до Kommo: ${Math.ceil(take.length / 250)} · компаній отримано: ${fetched} із ${take.length}`);
  const withPhoneCo = [...phonesOf.values()].filter((s) => s.size > 0).length;
  console.log(`   компаній з номером у власній картці: ${withPhoneCo} із ${fetched} (${pct(withPhoneCo, fetched)})`);
  const cardPhones = new Map();
  for (const k of clients) { const s = new Set(); for (const id of compOf.get(k)) for (const p of phonesOf.get(id) || []) s.add(p); cardPhones.set(k, s); }
  const withCard = clients.filter((k) => cardPhones.get(k).size > 0);
  console.log(`   постійних клієнтів з номером у картці компанії: ${withCard.length} із ${clients.length} (${pct(withCard.length, clients.length)}) · без такого номера: ${clients.length - withCard.length}`);
  const allCard = [...new Set(withCard.flatMap((k) => [...cardPhones.get(k)]))];
  const inContacts = (await c.query(`SELECT COUNT(DISTINCT right(phone, 9))::int AS n FROM contact_phones WHERE right(phone, 9) = ANY($1)`, [allCard])).rows[0].n;
  const inCarriers = (await c.query(`SELECT COUNT(*)::int AS n FROM carrier_phones WHERE p9 = ANY($1)`, [allCard])).rows[0].n;
  console.log(`   номерів у картках компаній: ${allCard.length} · з них уже є серед номерів контактів: ${inContacts} · є в довіднику перевізників: ${inCarriers}`);
  const calls = (await c.query(`
    SELECT client_key, right(client_phone, 9) AS p, COUNT(*)::int AS n, MAX(calldate) AS last
      FROM ringostat_calls WHERE client_key = ANY($1) AND calldate >= now() - interval '90 days' AND billsec >= 10 AND client_phone IS NOT NULL
     GROUP BY 1, 2`, [clients])).rows;
  let onCard = 0, offCard = 0; const talked = new Set(), talkedCard = new Set(), lastOf = new Map();
  for (const r of calls) {
    const hit = cardPhones.get(r.client_key)?.has(r.p);
    if (hit) { onCard += r.n; talkedCard.add(r.client_key); } else offCard += r.n;
    talked.add(r.client_key);
    const l = lastOf.get(r.client_key); if (!l || r.last > l.last) lastOf.set(r.client_key, { last: r.last, hit });
  }
  const lastHit = [...lastOf.values()].filter((l) => l.hit).length;
  console.log(`   розмови від 10 с за 90 днів (за привʼязкою дзвінка до клієнта, без спільних номерів): на номер із картки компанії ${onCard}, на інші номери ${offCard}`);
  console.log(`   клієнтів з розмовою за 90 днів: ${talked.size} · з них хоч одна на номер із картки: ${talkedCard.size} · ВТРАТЯТЬ усі розмови за новим правилом: ${talked.size - talkedCard.size}`);
  console.log(`   остання розмова клієнта припадає на номер із картки: ${lastHit} із ${lastOf.size} (${pct(lastHit, lastOf.size)})`);
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log("🔴 немає DATABASE_URL у .env — замір неможливий"); process.exit(1); }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  try {
    console.log(`замір 11225 / 11231 / 11223 · ${new Date().toISOString()} · розділи: ${ONLY}`);
    if (ONLY.includes("A")) await section(c, "розділ A", () => partA(c));
    if (ONLY.includes("B")) await section(c, "розділ B", () => partB(c));
    if (ONLY.includes("C")) await section(c, "розділ C", () => partC(c));
  } finally { await c.query("ROLLBACK").catch(() => undefined); await c.end(); }
  console.log("\nкінець заміру");
})().catch((e) => { console.error("🔴", e?.message || e); process.exit(1); });
