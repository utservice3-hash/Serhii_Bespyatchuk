// Приймання «Клієнти з реклами · за LTV» (PR #32): фільтри й посилання на Kommo. READ ONLY.
// Запуск НА СЕРВЕРІ в бойовому докруті (той самий dist, що крутить прод):
//   cd ~/uts.ua/dashboard/backend && set -a && . ./.env && set +a && PGOPTIONS='-c default_transaction_read_only=on' nice -n 20 node /tmp/acc-ads.mjs
// Рахує ТИМ САМИМ кодом, що роут /ads/clients (adClients + adClientLinks з dist), а фільтри — справжнім модулем фронта
// (adsClientFilter.ts, транспіляцією, як гейт #3318b). Нічого не пише: PGOPTIONS робить кожну транзакцію read-only.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

if (!/default_transaction_read_only=on/.test(process.env.PGOPTIONS ?? "")) throw new Error("без PGOPTIONS read-only не запускаю");
const ver = JSON.parse(readFileSync("dist/version.json", "utf8"));
console.log("dist sha:", ver.sha ?? ver);

const ts = createRequire(process.cwd() + "/package.json")("typescript");
const src = readFileSync("../frontend/src/pages/dashboard/sections/adsClientFilter.ts", "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const F = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const { pool } = await import(process.cwd() + "/dist/db/pool.js");
const { adClients } = await import(process.cwd() + "/dist/core/adClients.js");
const { adClientLinks } = await import(process.cwd() + "/dist/core/adClientLinks.js");
const { kommoCompanyUrl, kommoContactUrl, kommoLeadUrl } = await import(process.cwd() + "/dist/core/kommoLinks.js");
const { kyivToday } = await import(process.cwd() + "/dist/core/dates.js");

try {
  const ads = (await pool.query("SELECT data->'adSources' AS a FROM app_settings WHERE id=1")).rows[0]?.a;
  if (!Array.isArray(ads) || !ads.length) throw new Error("adSources порожній — замір недійсний");
  const today = kyivToday(), from = `${today.slice(0, 4)}-01-01`;
  const t0 = Date.now();
  const r = await adClients(from, today, ads);
  const t1 = Date.now();
  const links = await adClientLinks(r.clients.map((c) => c.clientKey));
  const t2 = Date.now();
  console.log(`період ${from}..${today} · клієнтів ${r.clients.length} · adClients ${t1 - t0} мс · adClientLinks ${t2 - t1} мс`);
  if (!r.clients.length) throw new Error("порожньо — замір недійсний");

  const url = (t) => !t ? null : t.kind === "company" ? kommoCompanyUrl(t.id) : t.kind === "contact" ? kommoContactUrl(t.id) : kommoLeadUrl(t.id);
  const rows = r.clients.map((c) => ({ ...c, kommoKind: links.get(c.clientKey)?.kind ?? null, kommoUrl: url(links.get(c.clientKey)) }));

  const E = F.EMPTY_FILTER, n = (p) => F.filterAdsClients(rows, { ...E, ...p }).length;
  console.log("\n=== ФІЛЬТРИ (вкладка «Усі», без групи складу)");
  console.log("усі:", n({}), "· угод від 2/3/5/10:", n({ minDeals: 2 }), n({ minDeals: 3 }), n({ minDeals: 5 }), n({ minDeals: 10 }));
  const tg = n({ camp: "tagged" }), ut = n({ camp: "untagged" });
  console.log("з міткою:", tg, "· без мітки:", ut, "· разом:", tg + ut, tg + ut === rows.length ? "✅ = усі" : "🔴 ≠ усі");
  console.log("тип ВІП/регулярний/епізодичний/без типу/разовий:", ["vip", "regular", "episodic", "unknown", "once"].map((t) => n({ type: t })).join(" / "));
  console.log("стан працює/спить/втрачений/невідомий:", ["active", "sleeping", "lost", "none"].map((s) => n({ state: s })).join(" / "));
  const s = F.summarizeAdsClients(rows);
  console.log("підсумок «Усі»:", JSON.stringify(s), "· totals ядра:", JSON.stringify(r.totals));

  console.log("\n=== ПОСИЛАННЯ НА KOMMO");
  const kinds = {}; for (const x of rows) kinds[x.kommoKind ?? "НЕМАЄ"] = (kinds[x.kommoKind ?? "НЕМАЄ"] ?? 0) + 1;
  console.log("види:", JSON.stringify(kinds), rows.every((x) => x.kommoUrl) ? "✅ у всіх є посилання" : "🔴 є клієнти без посилання");
  const host = new Set(rows.map((x) => x.kommoUrl && new URL(x.kommoUrl).host)); console.log("хости посилань:", [...host].join(", "));
  const show = (x) => console.log(`  ${x.name} → ${x.kommoKind} ${x.kommoUrl?.replace(/^https?:\/\/[^/]+/, "")}`);
  const bin = rows.filter((x) => /бінарт/i.test(x.name)); console.log("БІНАРТ:"); bin.forEach(show); if (!bin.length) console.log("  🔴 не знайдено");
  console.log("фізособи (контакт), перші 3:"); rows.filter((x) => x.kommoKind === "contact").slice(0, 3).forEach(show);
  console.log("на угоду, перші 3:"); rows.filter((x) => x.kommoKind === "deal").slice(0, 3).forEach(show);
} finally {
  await pool.end();
}
