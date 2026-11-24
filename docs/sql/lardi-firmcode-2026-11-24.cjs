// YouControl у «Перевірити номер на Ларді» (24.11.2026): ЖИВИЙ ЗАМІР перед прийманням. Базу лише ЧИТАЄ (BEGIN READ ONLY …
// ROLLBACK), у Ларді нічого не пише. Секретів не друкує (токени — лише в заголовках).
// Запуск — з теки backend прод-чекауту (потрібні .env і node_modules/pg, dist не потрібен):
//   cd <repo>/backend && nice -n 20 node /tmp/lardi-firmcode.cjs
// Що міряє:
//   L1  6 номерів з архіву lardi_offers за 7 днів (3 машини, 3 вантажі) → GET /v2/users/search: статус, скільки знайдено,
//       чи є в пошуку поле firmCode
//   L2  для знайдених — GET /v2/users/user/{refId} (профіль «Пользователь»): статус (403 = платний пакет!), firmCode,
//       shipper / carrier (за документацією вони там є — тип компанії, якого 13.11 не бачили)
//   Y1  РІВНО ОДИН запит GET /v1/usr/{код} до YouControl за першим знайденим кодом — ⚠ 1 ТРАНЗАКЦІЯ:
//       статус, mainEconomicActivity, economicActivities (лише коди й назви КВЕД), contractorType
const fs = require("node:fs");
const { createRequire } = require("node:module");
const req = createRequire(process.cwd() + "/package.json");
const { Client } = req("pg");
const WANT = ["DATABASE_URL", "LARDI_API_TOKEN", "LARDIWEB_LANG", "YOUCONTROL_API_KEY", "YOUSCORE_API_KEY"];
if (fs.existsSync(".env")) for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && WANT.includes(m[1]) && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const LANG = process.env.LARDIWEB_LANG || "uk";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const lardi = async (path) => {
  let r;
  try { r = await fetch(`https://api.lardi-trans.com${path}`, { headers: { Authorization: process.env.LARDI_API_TOKEN, Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(25000) }); }
  catch (e) { return { status: 0, body: null, err: e?.name || "мережа" }; }
  let body = null; try { body = await r.json(); } catch { /* не JSON */ }
  return { status: r.status, body };
};

(async () => {
  for (const k of ["DATABASE_URL", "LARDI_API_TOKEN"]) if (!process.env[k]) { console.log(`🔴 немає ${k} у .env — замір неможливий`); process.exit(1); }
  console.log("ключ YouControl:", process.env.YOUCONTROL_API_KEY ? "YOUCONTROL_API_KEY є" : process.env.YOUSCORE_API_KEY ? "лише YOUSCORE_API_KEY" : "🔴 НЕМАЄ жодного");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  let phones;
  try {
    const all = (await c.query(`SELECT count(*)::int AS n FROM lardi_offers WHERE first_seen >= now() - interval '7 days'`)).rows[0].n;
    console.log(`\n── L1 архів lardi_offers за 7 днів: ${all} заявок (простір вибору)`);
    phones = (await c.query(`
      SELECT side, ph FROM (
        SELECT DISTINCT ON (ph) o.side, right(regexp_replace(p->>'n', '\\D', '', 'g'), 9) AS ph, o.first_seen
          FROM lardi_offers o, jsonb_array_elements(COALESCE(o.phones, '[]'::jsonb)) p
         WHERE o.first_seen >= now() - interval '7 days' AND length(regexp_replace(p->>'n', '\\D', '', 'g')) >= 9
         ORDER BY ph, o.first_seen DESC) x
      ORDER BY side, first_seen DESC`)).rows;
  } finally { await c.query("ROLLBACK"); await c.end(); }
  const pick = [...phones.filter((p) => p.side === "lorry").slice(0, 3), ...phones.filter((p) => p.side === "cargo").slice(0, 3)];
  console.log(`   різних номерів: ${phones.length}; беру ${pick.length}`);

  let firstCode = null, inSearch = 0, inProfile = 0, users = 0;
  for (const p of pick) {
    const s = await lardi(`/v2/users/search?language=${LANG}&query=380${p.ph}&queryLimit=5`);
    const list = Array.isArray(s.body) ? s.body : [];
    console.log(`\n   ${p.side === "lorry" ? "машина" : "вантаж"} ·${p.ph.slice(-4)} · search ${s.status} · знайдено ${list.length}` +
      (list[0] ? ` · поля пошуку: ${Object.keys(list[0]).join(",")}` : ""));
    for (const u of list.slice(0, 2)) {
      users++;
      if (u.firmCode) inSearch++;
      const pr = await lardi(`/v2/users/user/${u.refId}?language=${LANG}`);
      const b = pr.body && typeof pr.body === "object" ? pr.body : {};
      if (b.firmCode) inProfile++;
      console.log(`     L2 «${String(u.name).slice(0, 40)}» · у пошуку firmCode=${u.firmCode ?? "∅"} · профіль ${pr.status}` +
        ` · firmCode=${b.firmCode ?? "∅"} · shipper=${b.shipper ?? "∅"} · carrier=${b.carrier ?? "∅"} · ownershipType=${JSON.stringify(b.ownershipType ?? null)}`);
      if (pr.status === 200 && !b.firmCode) console.log(`       поля профілю: ${Object.keys(b).join(",")}`);
      const code = String(b.firmCode || u.firmCode || "").replace(/[\s-]/g, "");
      if (!firstCode && /^(\d{8}|\d{10})$/.test(code)) firstCode = code;
    }
  }
  console.log(`\n── ПІДСУМОК L: користувачів ${users} · firmCode у пошуку ${inSearch} · у профілі ${inProfile}`);

  const key = process.env.YOUCONTROL_API_KEY || process.env.YOUSCORE_API_KEY;
  if (!firstCode) { console.log("── Y1 пропущено: жодного коду з Ларді — YouControl не питаю (транзакцію не витрачено)"); return; }
  if (!key) { console.log("── Y1 пропущено: немає ключа YouControl"); return; }
  const r = await fetch(`https://api.youscore.com.ua/v1/usr/${firstCode}`, { headers: { Authorization: `bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  let u = null; try { u = await r.json(); } catch { /* */ }
  console.log(`\n── Y1 YouControl /v1/usr (${firstCode.length === 10 ? "ФОП" : "юрособа"}) · статус ${r.status} (⚠ 1 транзакція)`);
  if (u && typeof u === "object") {
    console.log("   contractorType:", u.contractorType ?? "∅", "· status:", u.status ?? "∅");
    console.log("   mainEconomicActivity:", JSON.stringify(u.mainEconomicActivity ?? null));
    const acts = Array.isArray(u.economicActivities) ? u.economicActivities : null;
    console.log("   economicActivities:", acts ? acts.map((a) => `${a.isMain ? "*" : ""}${a.code} ${a.description}`).join(" | ") : "∅ (поля немає)");
    if (!acts) console.log("   верхні поля відповіді:", Object.keys(u).join(","));
  }
})().catch((e) => { console.error("🔴", e?.message || e); process.exit(1); });
