// Швидкість списку постійних клієнтів (`GET /dashboard/client-plans`), тред 26.11.2026. ЛИШЕ ЧИТАННЯ.
//
// Що робить: викликає обробник роуту В ПРОЦЕСІ (без HTTP і без сервера) від імені адміністратора, двічі поспіль,
// і для кожного звернення до бази записує, коли воно почалось і скільки тривало. Так видно, які з ~40 читань важкі
// і скільки часу йде «по черзі», а скільки одночасно.
//
// Захист: зʼєднання відкриваються з `default_transaction_read_only=on` (стартовий пакет зʼєднання, як у test:prod),
// і скрипт сам перевіряє це ПЕРШИМ запитом — без «on» далі не йде. Обробник і так лише читає; це другий рубіж.
// Kommo, задачник, файли не чіпає; нічого не пише; сервер не рестартує.
//
// Що друкує: час кожного читання, кількість рядків, хто покликав (файл і функція з dist) і перші слова SQL (без параметрів). Назв клієнтів,
// телефонів, сум, значень із .env НЕ друкує.
//
// Запуск (на сервері, з каталогу бекенда, бо потрібні його dist, node_modules і .env):
//   cd ~/uts.ua/dashboard/backend && nice -n 20 node /tmp/cp.mjs
// Навантаження: два проходи одного екрана, разом до ~20 с. Місяць — поточний (або перший аргумент YYYY-MM).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const RO = "-c default_transaction_read_only=on";
process.env.PGOPTIONS = [process.env.PGOPTIONS, RO].filter(Boolean).join(" ");

const root = process.cwd();
const dist = (p) => pathToFileURL(path.join(root, "dist", p)).href;
if (!existsSync(path.join(root, "dist", "routes", "dashboard.js"))) {
  console.log("🔴 немає dist/routes/dashboard.js — запускати з каталогу backend, де лежить зібраний dist");
  process.exit(2);
}

const { pool } = await import(dist("db/pool.js"));
const ro = (await pool.query("SHOW default_transaction_read_only")).rows[0]?.default_transaction_read_only;
if (ro !== "on") {
  console.log(`🔴 зʼєднання НЕ лише для читання (default_transaction_read_only = ${ro}) — зупиняюсь, нічого не виконано`);
  await pool.end();
  process.exit(3);
}

/** Перші слова SQL одним рядком: упізнати запит, не друкуючи параметрів. */
const label = (q) => {
  const text = typeof q === "string" ? q : (q && typeof q.text === "string" ? q.text : "?");
  return text.replace(/\s+/g, " ").trim().slice(0, 90);
};
/** Хто покликав: перший кадр стека з dist (функція й файл:рядок) — багато запитів ядра починаються однаково. */
const caller = () => {
  const lines = String(new Error().stack ?? "").split("\n").slice(2);
  const hit = lines.find((l) => l.includes("/dist/") && !l.includes("/node_modules/"));
  if (!hit) return "?";
  const m = hit.match(/at (?:async )?(?:(\S+) \()?.*?\/dist\/([^):]+):(\d+)/);
  return m ? `${m[2]}:${m[3]}${m[1] ? " " + m[1] : ""}` : hit.trim().slice(0, 60);
};

let log = null;         // куди писати поточний прохід
let t0 = 0;
const timed = (orig, self) => function (...args) {
  const cb = typeof args[args.length - 1] === "function";
  if (!log || cb) return orig.apply(self ?? this, args);
  const rec = { at: performance.now() - t0, ms: 0, rows: null, sql: label(args[0]), who: caller(), err: null };
  log.push(rec);
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
if (!layer) { console.log("🔴 роуту /client-plans у dist немає"); await pool.end(); process.exit(4); }

const month = /^\d{4}-\d{2}$/.test(process.argv[2] ?? "") ? process.argv[2] : undefined;

async function once(n) {
  log = []; t0 = performance.now();
  let status = 200, body = null;
  const res = { status(x) { status = x; return res; }, json(b) { body = b; return res; }, setHeader() { return res; }, set() { return res; } };
  const req = { auth: { userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null }, query: month ? { month } : {}, params: {}, body: {}, headers: {} };
  for (const l of layer.route.stack) await l.handle(req, res, (e) => { if (e) throw e; });
  const wall = performance.now() - t0;
  const recs = log; log = null;

  // Час, коли в польоті було хоча б одне читання (обʼєднання відрізків), і решта — робота самого Node.
  const iv = recs.map((r) => [r.at, r.at + r.ms]).sort((a, b) => a[0] - b[0]);
  let busy = 0, end = -1;
  for (const [a, b] of iv) { if (b <= end) continue; busy += b - Math.max(a, end); end = b; }
  const sum = recs.reduce((s, r) => s + r.ms, 0);
  const s0 = performance.now();
  const bytes = body ? Buffer.byteLength(JSON.stringify(body)) : 0;
  const ser = performance.now() - s0;

  console.log(`\n=== ПРОХІД ${n}: статус ${status}, клієнтів ${body?.clients?.length ?? "?"}, місяць ${body?.month ?? "?"} ===`);
  console.log(`усього ${Math.round(wall)} мс · читань ${recs.length} · у базі (хоч одне читання в польоті) ${Math.round(busy)} мс · `
    + `поза базою (Node) ${Math.round(wall - busy)} мс · сума всіх читань ${Math.round(sum)} мс · `
    + `відповідь ${Math.round(bytes / 1024)} КБ, у JSON за ${Math.round(ser)} мс`);
  console.log("  №  старт,мс  трив,мс  рядків  запит");
  recs.forEach((r, i) => console.log(
    `${String(i + 1).padStart(3)}  ${String(Math.round(r.at)).padStart(8)}  ${String(Math.round(r.ms)).padStart(7)}  ${String(r.rows ?? "-").padStart(6)}  ${r.err ? "🔴 " + r.err + " · " : ""}[${r.who}] ${r.sql}`));
  console.log("  — найважчі десять —");
  [...recs].sort((a, b) => b.ms - a.ms).slice(0, 10).forEach((r) => console.log(
    `     ${String(Math.round(r.ms)).padStart(6)} мс  (${Math.round((r.ms / Math.max(wall, 1)) * 100)}% проходу)  [${r.who}] ${r.sql.slice(0, 60)}`));
  return { wall, n: recs.length };
}

try {
  const a = await once(1);
  const b = await once(2);
  console.log(`\nПІДСУМОК: прохід 1 — ${Math.round(a.wall)} мс (${a.n} читань), прохід 2 — ${Math.round(b.wall)} мс (${b.n} читань). Нічого не записано.`);
} catch (e) {
  console.log(`🔴 обробник упав: ${String(e?.message ?? e).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
