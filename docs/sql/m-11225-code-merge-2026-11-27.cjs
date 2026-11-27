// 11225 · СКІЛЬКИ КЛІЄНТІВ СТАНЕ, ЯКЩО ЗЛИТИ ЗАПИСИ ЗА КОДОМ ЄДРПОУ (Роман 27.11.2026: «скільки в нас буде клієнтів…
// які розпадуться, які зʼєднаються, скільки залишиться… чи є зараз дублі»). Базу лише ЧИТАЄ (BEGIN READ ONLY … ROLLBACK),
// у 1С один GET (`paydata`), у Kommo не ходить. Секретів не друкує. Запуск із теки backend прод-чекауту.
//
// Правило, яке міряємо: КОД ЛИШЕ ЗЛИВАЄ. Два ключі клієнта (`deals.client_key`), чиї оплати 1С несуть один код, стають одним
// клієнтом; ключ із кількома кодами НЕ ділиться (клієнт може мати кілька юросіб) і тягне за собою обидві групи. Тому рахуємо
// компоненти звʼязності, а не «групи на код». «Постійний» тут, як у попередніх замірах: 2+ оплачені угоди за весь час.
// Друкує ДВА варіанти: коди лише з оплат 2026 (звірка з ранковим заміром: 101 група, 223 ключі) і коди з оплат за весь час.
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
const LIST = process.argv.includes("--list");
const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "—");
const head = (s) => console.log(`\n══ ${s}`);
const code = (x) => { const d = String(x?.ERPOU ?? "").replace(/\D/g, ""); return /^(\d{8}|\d{10}|\d{12})$/.test(d) ? d : null; };
const yearOf = (x) => (String(x?.Data ?? "").match(/\.(\d{4})\b/) || [])[1] || "(без дати)";

(async () => {
  if (!process.env.DATABASE_URL) { console.log("🔴 немає DATABASE_URL у .env — замір неможливий"); process.exit(1); }
  console.log(`замір: злиття клієнтів за кодом ЄДРПОУ з оплат 1С · ${new Date().toISOString()}`);
  const res = await fetch(new URL("paydata", ONEC).toString(), { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`1С: HTTP ${res.status}`);
  const j = await res.json(); const rows = Array.isArray(j) ? j : [j];

  head("0 · чи 1С віддає оплати повністю (вранці за 2026 вийшло рівно 10 000)");
  const byYear = new Map(); for (const x of rows) byYear.set(yearOf(x), (byYear.get(yearOf(x)) || 0) + 1);
  console.log(`   рядків усього ${rows.length} · за роками: ${[...byYear.entries()].sort().map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
  const m26 = new Map(); for (const x of rows) { const m = String(x?.Data ?? "").match(/^\s*\d{1,2}\.(\d{1,2})\.2026\b/); if (m) m26.set(Number(m[1]), (m26.get(Number(m[1])) || 0) + 1); }
  console.log(`   2026 за місяцями: ${[...m26.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}: ${v}`).join(" · ") || "немає"}`);

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  try {
    // Всесвіт: кожен ключ клієнта з оплаченими угодами і скільки їх.
    const uni = (await c.query(`
      SELECT d.client_key AS k, COUNT(*)::int AS n
        FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL GROUP BY 1`)).rows;
    const paidN = new Map(uni.map((r) => [r.k, r.n]));
    const withDeal = rows.filter((x) => /^\d{8}$/.test(String(x?.Deal ?? "").trim()));
    const ids = [...new Set(withDeal.map((x) => String(x.Deal).trim()))];
    const keyOf = new Map((await c.query(`
      SELECT d.kommo_id::text AS id, d.client_key AS k
        FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND d.kommo_id = ANY($1::bigint[])`, [ids])).rows.map((r) => [r.id, r.k]));
    console.log(`\n   ключів клієнта з оплаченими угодами: ${uni.length} · постійних (2+ оплачені угоди) ${uni.filter((r) => r.n >= 2).length} · оплат 1С з номером угоди ${withDeal.length}, з них угода знайшлась серед оплачених ${withDeal.filter((x) => keyOf.has(String(x.Deal).trim())).length}`);

    const variant = (label, pays, listAll) => {
      head(label);
      const codesOf = new Map(), keysOf = new Map(), nameOf = new Map(), seen = new Set();
      for (const x of pays) {
        const k = keyOf.get(String(x.Deal).trim()); if (!k) continue;
        seen.add(k);
        const cd = code(x); if (!cd) continue;
        if (!codesOf.has(k)) codesOf.set(k, new Set()); codesOf.get(k).add(cd);
        if (!keysOf.has(cd)) keysOf.set(cd, new Set()); keysOf.get(cd).add(k);
        if (!nameOf.has(cd)) nameOf.set(cd, String(x?.Kontragent ?? "").trim());
      }
      // Компоненти звʼязності: ключі зливаються через спільний код, у тому числі ланцюжком.
      const parent = new Map(); const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
      for (const k of seen) parent.set(k, k);
      for (const ks of keysOf.values()) { const [first, ...rest] = [...ks]; for (const o of rest) parent.set(find(o), find(first)); }
      const comp = new Map(); for (const k of seen) { const r = find(k); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(k); }
      const groups = [...comp.values()];
      const merged = groups.filter((g) => g.length > 1);
      const reg = (k) => (paidN.get(k) || 0) >= 2;
      const sum = (g) => g.reduce((a, k) => a + (paidN.get(k) || 0), 0);
      const keys = [...seen];
      const regBefore = keys.filter(reg).length;
      const regAfter = groups.filter((g) => sum(g) >= 2).length;
      const bornRegular = merged.filter((g) => !g.some(reg) && sum(g) >= 2).length;
      const known = keys.filter((k) => codesOf.has(k));
      const multi = known.filter((k) => codesOf.get(k).size > 1);
      console.log(`   клієнтів (ключів) з оплатою 1С: ${keys.length} · код відомий ${known.length} (${pct(known.length, keys.length)}) · без коду ${keys.length - known.length}`);
      console.log(`   груп за одним кодом з 2+ ключами: ${[...keysOf.values()].filter((s) => s.size > 1).length} · після ланцюжків це ${merged.length} груп злиття, у них ключів ${merged.reduce((a, g) => a + g.length, 0)}`);
      console.log(`   ➜ КЛІЄНТІВ: було ${keys.length} → стане ${groups.length} (мінус ${keys.length - groups.length})`);
      console.log(`   ➜ ПОСТІЙНИХ: було ${regBefore} → стане ${regAfter} · із них стали постійними лише завдяки злиттю разових записів ${bornRegular}`);
      console.log(`   постійних ключів у групах злиття: ${merged.flat().filter(reg).length} · груп, де 2+ постійних ключі (справжній дубль постійного): ${merged.filter((g) => g.filter(reg).length > 1).length}`);
      console.log(`   ключів із 2+ кодами (НЕ ділимо, клієнт із кількома юрособами): ${multi.length}, з них постійних ${multi.filter(reg).length}`);
      const sizes = new Map(); for (const g of merged) sizes.set(g.length, (sizes.get(g.length) || 0) + 1);
      console.log(`   розмір груп злиття: ${[...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} ключі × ${v}`).join(" · ") || "немає"}`);
      const big = [...keysOf.entries()].filter(([, s]) => s.size > 5);
      console.log(`   кодів, що тягнуть більш як 5 ключів (перевірити очима, чи це не код-заглушка): ${big.length}${big.length ? " · " + big.map(([cd, s]) => `${nameOf.get(cd)} (${s.size})`).join("; ") : ""}`);
      const show = merged.sort((a, b) => sum(b) - sum(a)).slice(0, listAll ? merged.length : 10);
      console.log(`   ${listAll ? "усі групи" : "перші 10 груп"} (за кількістю оплачених угод; у дужках оплачені угоди ключа):`);
      for (const g of show) {
        const cds = [...new Set(g.flatMap((k) => [...(codesOf.get(k) || [])]))];
        console.log(`     · ${cds.map((cd) => `${nameOf.get(cd)} [${cd}]`).join(" + ")} ← ${g.sort((a, b) => (paidN.get(b) || 0) - (paidN.get(a) || 0)).map((k) => `${k} (${paidN.get(k) || 0})`).join(" | ")}`);
      }
    };
    variant("A · коди з оплат 2026 року (звірка з ранком: 101 група за кодом, 223 ключі)", withDeal.filter((x) => yearOf(x) === "2026"), LIST);
    variant("B · коди з оплат за весь час", withDeal, false);
  } finally { await c.query("ROLLBACK").catch(() => undefined); await c.end(); }
  console.log("\nкінець заміру");
})().catch((e) => { console.error("🔴", e?.message || e); process.exit(1); });
