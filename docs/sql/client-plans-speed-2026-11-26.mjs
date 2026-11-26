// Швидкість списку постійних клієнтів (`GET /dashboard/client-plans`), тред 26.11.2026. ЛИШЕ ЧИТАННЯ.
//
// Що робить: викликає обробник роуту В ПРОЦЕСІ (без HTTP і без сервера) від імені адміністратора і для кожного
// звернення до бази записує, коли воно почалось і скільки тривало. Так видно, які читання важкі, скільки їх летить
// одночасно і скільки часу йде «по черзі».
//
// Режими (усі лише читають):
//   node cp.mjs [YYYY-MM]                      — два проходи цієї збірки (пам'ять відповіді перед кожним скидається),
//                                                і третій, якщо збірка вміє пам'ятати відповідь: «з пам'яті».
//   node cp.mjs [YYYY-MM] --against=<backend>  — ПОРІВНЯННЯ ДВОХ ЗБІРОК на тих самих даних у ту саму хвилину:
//                                                інша → ця → інша. Друкує час і відбиток відповіді кожного проходу.
//                                                «інша == інша» означає, що дані за цей час не зрушили; тоді
//                                                «ця == інша» доводить, що нова збірка віддає ту саму відповідь.
//   … --scope=team:6 | --scope=manager:41     — те саме від імені тімліда команди або менеджера (типово адміністратор).
//   … --scope=team:auto | --scope=manager:auto — команду або менеджера скрипт обирає сам: у кого найбільше клієнтів
//                                                у списку адміністратора (охоплення гарантовано непорожнє).
//                                                Друкує лише id і кількість.
//   … --brief                                  — без таблиць окремих читань: рядок на прохід і підсумок.
//   node cp.mjs [YYYY-MM] --explain[=N]        — після проходів показує план бази (EXPLAIN ANALYZE, BUFFERS) для N
//                                                найважчих читань (типово 5). Кожне з них виконується ще раз.
//
// Захист: зʼєднання відкриваються з `default_transaction_read_only=on` (стартовий пакет зʼєднання, як у test:prod),
// і скрипт сам перевіряє це ПЕРШИМ запитом кожної збірки — без «on» далі не йде. EXPLAIN ANALYZE виконує лише ті
// запити, які обробник щойно виконав сам, і під тим самим замком. Kommo, задачник, файли не чіпає; нічого не пише;
// сервер не рестартує; розклад джоб не стартує (імпортується лише роутер, не `index.js`).
//
// Що друкує: час кожного читання, кількість рядків, хто покликав (файл і функція з dist), перші слова SQL (без
// параметрів), відбиток відповіді (sha256), у плані бази — рядки плану з ЗАТЕРТИМИ текстовими значеннями ('…').
// Назв клієнтів, телефонів, сум, значень із .env НЕ друкує.
//
// Запуск (на сервері, з каталогу бекенда, бо потрібні його dist, node_modules і .env):
//   cd ~/uts.ua/dashboard/backend && nice -n 20 node /tmp/cp.mjs
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const RO = "-c default_transaction_read_only=on";
process.env.PGOPTIONS = [process.env.PGOPTIONS, RO].filter(Boolean).join(" ");

const argv = process.argv.slice(2);
const month = argv.find((a) => /^\d{4}-\d{2}$/.test(a));
const flag = (name) => { const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`)); return a == null ? null : (a.includes("=") ? a.slice(a.indexOf("=") + 1) : ""); };
const againstDir = flag("against");
const explainN = flag("explain") == null ? 0 : (Number(flag("explain")) || 5);
/** `--brief`: без таблиць окремих читань, лише рядок на прохід і підсумок (для повторних порівнянь в інших охопленнях). */
const brief = flag("brief") != null;
const scopeArg = /^(team|manager):(\d+|auto)$/.exec(flag("scope") ?? "");
if (flag("scope") != null && !scopeArg) { console.log("🔴 --scope має бути team:<id> | manager:<id> | team:auto | manager:auto"); process.exit(2); }
/** Від чийого імені викликати: адміністратор, тімлід команди або менеджер. Охоплення рахує сам обробник. */
let AUTH = !scopeArg ? { userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null }
  : scopeArg[1] === "team" ? { userId: 0, role: "team_lead", roleKey: "team_lead", managerId: null, teamId: Number(scopeArg[2]) }
    : { userId: 0, role: "manager", roleKey: "manager", managerId: Number(scopeArg[2]), teamId: null };

/** Перші слова SQL одним рядком: упізнати запит, не друкуючи параметрів. */
const label = (q) => {
  const text = typeof q === "string" ? q : (q && typeof q.text === "string" ? q.text : "?");
  return text.replace(/\s+/g, " ").trim().slice(0, 90);
};
/** Хто покликав: перший кадр стека з dist (функція й файл:рядок) — багато запитів ядра починаються однаково. */
const caller = () => {
  const lines = String(new Error().stack ?? "").split("\n").slice(2);
  // Обгортка стелі одночасності (`core/limitAll.js`) — не «хто покликав»: шукаємо перший кадр поза нею.
  const mineOnly = lines.filter((l) => l.includes("/dist/") && !l.includes("/node_modules/"));
  const hit = mineOnly.find((l) => !l.includes("/core/limitAll.js")) ?? mineOnly[0];
  if (!hit) return "?";
  const m = hit.match(/at (?:async )?(?:(\S+) \()?.*?\/dist\/([^):]+):(\d+)/);
  return m ? `${m[2]}:${m[3]}${m[1] ? " " + m[1] : ""}` : hit.trim().slice(0, 60);
};

/** Завантажує одну збірку: пул (перевірений на «лише читання»), обробник, пам'ять відповіді (якщо збірка її має). */
async function load(dir, name) {
  const dist = (p) => pathToFileURL(path.join(dir, "dist", p)).href;
  if (!existsSync(path.join(dir, "dist", "routes", "dashboard.js"))) {
    console.log(`🔴 ${name}: немає dist/routes/dashboard.js у ${dir}`); process.exit(2);
  }
  const { pool } = await import(dist("db/pool.js"));
  const ro = (await pool.query("SHOW default_transaction_read_only")).rows[0]?.default_transaction_read_only;
  if (ro !== "on") {
    console.log(`🔴 ${name}: зʼєднання НЕ лише для читання (default_transaction_read_only = ${ro}) — зупиняюсь, нічого не виконано`);
    await pool.end(); process.exit(3);
  }
  const st = { log: null, t0: 0 };
  const rawQuery = pool.query.bind(pool);
  const timed = (orig, self) => function (...args) {
    const cb = typeof args[args.length - 1] === "function";
    if (!st.log || cb) return orig.apply(self ?? this, args);
    const rec = { at: performance.now() - st.t0, ms: 0, rows: null, sql: label(args[0]), who: caller(), err: null, args };
    st.log.push(rec);
    const s = performance.now();
    return orig.apply(self ?? this, args).then(
      (r) => { rec.ms = performance.now() - s; rec.rows = Array.isArray(r?.rows) ? r.rows.length : null; return r; },
      (e) => { rec.ms = performance.now() - s; rec.err = String(e?.message ?? e).slice(0, 120); throw e; },
    );
  };
  pool.query = timed(pool.query, pool);
  const origConnect = pool.connect.bind(pool);
  pool.connect = async function (...args) {
    if (typeof args[0] === "function") return origConnect(...args);
    const c = await origConnect();
    if (!c.__timed) { c.query = timed(c.query, c); c.__timed = true; }
    return c;
  };
  const { dashboardRouter } = await import(dist("routes/dashboard.js"));
  const layer = dashboardRouter.stack.find((l) => l.route?.path === "/client-plans" && l.route.methods.get);
  if (!layer) { console.log(`🔴 ${name}: роуту /client-plans у dist немає`); await pool.end(); process.exit(4); }
  let cache = null;
  if (existsSync(path.join(dir, "dist", "core", "scopeCache.js"))) cache = (await import(dist("core/scopeCache.js"))).clientPlansCache ?? null;
  return { name, pool, rawQuery, st, layer, cache };
}

/** Один виклик обробника. `fresh` — перед викликом скинути пам'ять відповіді, щоб міряти саме збирання. */
async function once(b, title, { fresh = true, table = true } = {}) {
  if (fresh && b.cache) b.cache.invalidate();
  b.st.log = []; b.st.t0 = performance.now();
  let status = 200, body = null;
  const res = { status(x) { status = x; return res; }, json(v) { body = v; return res; }, setHeader() { return res; }, set() { return res; } };
  const req = { auth: AUTH, query: month ? { month } : {}, params: {}, body: {}, headers: {} };
  for (const l of b.layer.route.stack) await l.handle(req, res, (e) => { if (e) throw e; });
  const wall = performance.now() - b.st.t0;
  const recs = b.st.log; b.st.log = null;

  // Час, коли в польоті було хоча б одне читання (обʼєднання відрізків), і найбільше читань одночасно.
  const iv = recs.map((r) => [r.at, r.at + r.ms]).sort((a, c) => a[0] - c[0]);
  let busy = 0, end = -1;
  for (const [a, c] of iv) { if (c <= end) continue; busy += c - Math.max(a, end); end = c; }
  const edges = recs.flatMap((r) => [[r.at, 1], [r.at + r.ms, -1]]).sort((a, c) => a[0] - c[0] || a[1] - c[1]);
  let cur = 0, peak = 0; for (const [, d] of edges) { cur += d; if (cur > peak) peak = cur; }
  const sum = recs.reduce((s, r) => s + r.ms, 0);
  const s0 = performance.now();
  const json = body ? JSON.stringify(body) : "";
  const ser = performance.now() - s0;
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);

  console.log(`\n=== ${title} (${scopeArg ? scopeArg[0] : "адміністратор"}): статус ${status}, клієнтів ${body?.clients?.length ?? "?"}, місяць ${body?.month ?? "?"} ===`);
  console.log(`усього ${Math.round(wall)} мс · читань ${recs.length} · одночасно щонайбільше ${peak} · у базі (хоч одне читання в польоті) ${Math.round(busy)} мс · `
    + `поза базою (Node) ${Math.round(wall - busy)} мс · сума всіх читань ${Math.round(sum)} мс · `
    + `відповідь ${Math.round(Buffer.byteLength(json) / 1024)} КБ, у JSON за ${Math.round(ser)} мс · відбиток ${hash}`);
  if (table && !brief && recs.length) {
    console.log("  №  старт,мс  трив,мс  рядків  запит");
    recs.forEach((r, i) => console.log(
      `${String(i + 1).padStart(3)}  ${String(Math.round(r.at)).padStart(8)}  ${String(Math.round(r.ms)).padStart(7)}  ${String(r.rows ?? "-").padStart(6)}  ${r.err ? "🔴 " + r.err + " · " : ""}[${r.who}] ${r.sql}`));
    console.log("  — найважчі десять —");
    [...recs].sort((a, c) => c.ms - a.ms).slice(0, 10).forEach((r) => console.log(
      `     ${String(Math.round(r.ms)).padStart(6)} мс  (${Math.round((r.ms / Math.max(wall, 1)) * 100)}% проходу)  [${r.who}] ${r.sql.slice(0, 60)}`));
  }
  return { wall, n: recs.length, peak, hash, status, body, recs };
}

/** Шляхи, де дві відповіді різняться, — БЕЗ значень (лише місце й тип), щонайбільше `max`. */
function diffPaths(a, b, max = 20) {
  const out = [];
  const walk = (x, y, p) => {
    if (out.length >= max) return;
    if (x === y) return;
    const tx = x === null ? "null" : Array.isArray(x) ? "array" : typeof x, ty = y === null ? "null" : Array.isArray(y) ? "array" : typeof y;
    if (tx !== ty) { out.push(`${p}: тип ${tx} проти ${ty}`); return; }
    if (tx === "array") {
      if (x.length !== y.length) { out.push(`${p}: довжина ${x.length} проти ${y.length}`); return; }
      for (let i = 0; i < x.length; i++) walk(x[i], y[i], `${p}[${i}]`);
    } else if (tx === "object") {
      const kx = Object.keys(x), ky = Object.keys(y);
      if (kx.join("|") !== ky.join("|")) { out.push(`${p}: інший набір або порядок полів (${kx.length} проти ${ky.length})`); return; }
      for (const k of kx) walk(x[k], y[k], `${p}.${k}`);
    } else out.push(`${p}: інше значення (${tx})`);
  };
  walk(a, b, "відповідь");
  return out;
}

/** План бази для найважчих читань проходу. Текстові значення в рядках плану затираються: там бувають ключі клієнтів. */
async function explain(b, recs, n) {
  const seen = new Set();
  const top = [...recs].filter((r) => !r.err).sort((a, c) => c.ms - a.ms).filter((r) => {
    const k = r.who + "|" + r.sql; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, n);
  for (const r of top) {
    const q = r.args[0];
    const text = typeof q === "string" ? q : q?.text;
    const values = typeof q === "string" ? r.args[1] : q?.values;
    if (typeof text !== "string" || !/^\s*(SELECT|WITH)\b/i.test(text)) { console.log(`\n--- план: [${r.who}] пропущено (не SELECT) ---`); continue; }
    console.log(`\n--- план: ${Math.round(r.ms)} мс у проході · [${r.who}] ${r.sql.slice(0, 70)} ---`);
    try {
      const p = await b.rawQuery(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${text}`, values ?? []);
      for (const row of p.rows) {
        const line = String(row["QUERY PLAN"] ?? "").replace(/'(?:[^']|'')*'/g, "'…'");
        console.log("  " + (line.length > 230 ? line.slice(0, 230) + " …" : line));
      }
    } catch (e) { console.log(`  🔴 план не знято: ${String(e?.message ?? e).replace(/'(?:[^']|'')*'/g, "'…'").slice(0, 200)}`); }
  }
}

const builds = [];
try {
  const mine = await load(process.cwd(), "ця збірка"); builds.push(mine);
  if (scopeArg && scopeArg[2] === "auto") {
    // Кого взяти — з самого списку адміністратора: команда або менеджер із найбільшою кількістю клієнтів у ньому.
    // Так охоплення гарантовано непорожнє (порівняння двох порожніх списків нічого не доводить).
    const field = scopeArg[1] === "team" ? "teamId" : "managerId";
    AUTH = { userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null };
    const all = await once(mine, "ВИБІР ОХОПЛЕННЯ, список адміністратора", { table: false });
    const cnt = new Map();
    for (const c of all.body?.clients ?? []) if (c[field] != null) cnt.set(c[field], (cnt.get(c[field]) ?? 0) + 1);
    const best = [...cnt.entries()].sort((a, c) => c[1] - a[1] || a[0] - c[0])[0];
    if (!best) { console.log(`🔴 --scope=${scopeArg[1]}:auto: у списку адміністратора немає кого обрати — зупиняюсь`); process.exitCode = 2; throw new Error("немає охоплення для порівняння"); }
    AUTH = scopeArg[1] === "team" ? { userId: 0, role: "team_lead", roleKey: "team_lead", managerId: null, teamId: best[0] }
      : { userId: 0, role: "manager", roleKey: "manager", managerId: best[0], teamId: null };
    scopeArg[0] = `${scopeArg[1]}:${best[0]}, обрано автоматично: найбільше клієнтів у списку (${best[1]})`;
  }
  if (againstDir != null) {
    if (!againstDir) { console.log("🔴 --against потребує шляху до каталогу backend іншої збірки"); process.exitCode = 2; }
    else {
      const other = await load(path.resolve(againstDir), "інша збірка"); builds.push(other);
      await once(other, "ІНША ЗБІРКА, розігрів", { table: false });
      const o1 = await once(other, "ІНША ЗБІРКА, прохід 1", { table: false });
      const m1 = await once(mine, "ЦЯ ЗБІРКА, прохід 1");
      const o2 = await once(other, "ІНША ЗБІРКА, прохід 2", { table: false });
      const m2 = await once(mine, "ЦЯ ЗБІРКА, прохід 2", { table: false });
      const mem = mine.cache ? await once(mine, "ЦЯ ЗБІРКА, з пам'яті", { fresh: false, table: false }) : null;
      const stable = o1.hash === o2.hash;
      const same = m1.hash === o1.hash || m1.hash === o2.hash || m2.hash === o2.hash;
      console.log(`\nПІДСУМОК ПОРІВНЯННЯ:`);
      console.log(`  інша збірка: ${Math.round(o1.wall)} і ${Math.round(o2.wall)} мс (${o1.n} читань, одночасно до ${o1.peak})`);
      console.log(`  ця збірка:   ${Math.round(m1.wall)} і ${Math.round(m2.wall)} мс (${m1.n} читань, одночасно до ${Math.max(m1.peak, m2.peak)})`
        + (mem ? ` · з пам'яті ${Math.round(mem.wall)} мс (${mem.n} читань)` : ""));
      console.log(`  дані за час заміру ${stable ? "не зрушили (інша == інша)" : "ЗРУШИЛИ (інша ≠ інша) — порівняння відповідей ненадійне, повторити"}`);
      console.log(`  відповідь ${same ? "ТА САМА (відбитки збіглись)" : "🔴 РІЗНА"}: інша ${o1.hash} / ${o2.hash} · ця ${m1.hash} / ${m2.hash}`);
      if (!same) for (const d of diffPaths(o2.body, m2.body)) console.log("    ≠ " + d);
      if (explainN) await explain(mine, m2.recs, explainN);
      console.log("\nНічого не записано.");
    }
  } else {
    const a = await once(mine, "ПРОХІД 1");
    const b = await once(mine, "ПРОХІД 2");
    const mem = mine.cache ? await once(mine, "ПРОХІД 3, з пам'яті", { fresh: false, table: false }) : null;
    if (explainN) await explain(mine, b.recs, explainN);
    console.log(`\nПІДСУМОК: прохід 1 — ${Math.round(a.wall)} мс (${a.n} читань), прохід 2 — ${Math.round(b.wall)} мс (${b.n} читань, одночасно до ${b.peak})`
      + (mem ? `, з пам'яті — ${Math.round(mem.wall)} мс (${mem.n} читань)` : "") + `. Відбитки ${a.hash} / ${b.hash}. Нічого не записано.`);
  }
} catch (e) {
  console.log(`🔴 обробник упав: ${String(e?.message ?? e).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  for (const b of builds) await b.pool.end().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
