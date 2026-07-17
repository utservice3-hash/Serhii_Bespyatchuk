/**
 * E2E SMOKE-QA — постійна перевірка дашборду «перед кожним показом» (як нічна звірка).
 * ЛИШЕ ЗНАХОДИТЬ, нічого не чинить. Ганяється однією командою; фейл → скрін.
 *
 * Три класи перевірок:
 *   1. МЕХАНІКА — помилки консолі; ErrorBoundary («Не вдалося показати»); dropdown 0 опцій;
 *      «NaN»/порожнє/«—» там, де має бути значення.
 *   2. ІНВАРІАНТИ — Σ менеджерів = Σ команд = відділ (факт/очік/план); конверсія ≤100%;
 *      сума бакетів очікувань = total.
 *   3. КРОС-ЕКРАН — спільні метрики (факт, прогноз, очікування) «Огляд» vs «Звіт 2.0»
 *      мають збігатись; розбіжність = FAIL + два скріни + яка формула стара.
 *
 * РЕЖИМИ:
 *   LIVE (власник):   QA_TOKEN=<admin-jwt> [QA_BASE_URL=https://dashboard.uts.ua] node qa/smoke-qa.mjs
 *   OFFLINE (фікстури): QA_FIXTURES=<dir> QA_DIST=<frontend/dist> node qa/smoke-qa.mjs
 *   Спільне:  QA_CHROMIUM=<chrome>  QA_OUT=<out-dir>
 */
import { chromium } from "playwright-core";
import http from "http";
import fs from "fs";
import path from "path";

const BASE = process.env.QA_BASE_URL || "https://dashboard.uts.ua";
const TOKEN = process.env.QA_TOKEN || "";
const FIX = process.env.QA_FIXTURES || "";
const DIST = process.env.QA_DIST || "";
const EXE = process.env.QA_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.QA_OUT || "./qa-out";
fs.mkdirSync(OUT, { recursive: true });

const uah = (n) => Math.round(Number(n)).toLocaleString("uk-UA");
const results = [];
let shotN = 0;
async function shot(page, tag) { const p = path.join(OUT, `${String(++shotN).padStart(2, "0")}_${tag}.png`); await page.screenshot({ path: p }).catch(() => {}); return p; }
function rec(kind, name, ok, detail, shots = []) { results.push({ kind, name, ok, detail, shots }); console.log(`${ok ? "✅ PASS" : "❌ FAIL"} [${kind}] ${name}${detail ? " — " + detail : ""}`); }

// ── Фікстури / жива вибірка ──
const FIXMAP = { "overview": "overview.json", "manager-report": "mr_dept.json", "teams": "teamsapi.json" };
function fixFor(url) { for (const k of Object.keys(FIXMAP)) if (url.includes("/" + k)) return path.join(FIX, FIXMAP[k]); return null; }
async function apiJson(page, epPath) {
  if (FIX) { const f = fixFor(epPath); return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; }
  const r = await page.request.get(BASE + epPath, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return r.ok() ? r.json() : {};
}

// ── OFFLINE статик-сервер dist ──
let server = null;
async function startStatic() {
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png" };
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.startsWith("/api")) { res.writeHead(404); res.end("{}"); return; }
    let fp = path.join(DIST, p);
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(DIST, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise((r) => server.listen(8137, "127.0.0.1", r));
  return "http://127.0.0.1:8137";
}

const consoleErrors = [];
async function run() {
  const appBase = FIX ? await startStatic() : BASE;
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1.5 });
  await ctx.addInitScript((t) => { try { localStorage.setItem("token", t); } catch (e) {} }, TOKEN || "");
  if (FIX) {
    // мок /api з фікстур (manager-report для будь-якого рівня/періоду з dept-фікстури)
    const ov = JSON.parse(fs.readFileSync(path.join(FIX, "overview.json"), "utf8"));
    const mr = JSON.parse(fs.readFileSync(path.join(FIX, "mr_dept.json"), "utf8"));
    const tm = JSON.parse(fs.readFileSync(path.join(FIX, "teamsapi.json"), "utf8"));
    await ctx.route("**/api/**", (route) => {
      const u = route.request().url(); let b = {};
      if (u.includes("/manager-report")) b = mr;
      else if (u.includes("/overview")) b = ov;
      else if (/\/teams(\?|$)/.test(u) && !u.includes("manager-report")) b = tm;
      else if (u.includes("/auth/me")) b = { id: 1, role: "admin", managerId: null, teamId: null };
      else b = []; // невідомі ендпоінти → [] (безпечніше для .length/.map, ніж {})
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    });
  }
  const page = await ctx.newPage();
  let curView = "boot";
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/favicon|manifest|ResizeObserver/i.test(t)) consoleErrors.push(`[${curView}] ${t.slice(0, 200)}`); } });
  page.on("pageerror", (e) => consoleErrors.push(`[${curView}] pageerror: ${String(e.message).slice(0, 200)}`));

  await page.goto(appBase + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const gone = async (txt) => !(await page.getByText(txt, { exact: false }).first().isVisible().catch(() => false));
  // Нав-пункти рендеряться як «icon label» → матчимо по RegExp accessible-name.
  const NAV_RE = { "Огляд": /Огляд/, "Звіт": /Звіт$/, "Звіт 2.0": /Звіт 2\.0/ };
  const clickNav = async (label) => {
    try { await page.getByRole("button", { name: NAV_RE[label] }).first().click({ timeout: 10000 }); await page.waitForTimeout(2200); return true; }
    catch { return false; }
  };
  const clickBtn = async (name) => {
    try { await page.getByRole("button", { name, exact: true }).first().click({ timeout: 8000 }); await page.waitForTimeout(1300); return true; }
    catch { return false; }
  };

  // ── 1. МЕХАНІКА: роути ──
  for (const nav of ["Огляд", "Звіт", "Звіт 2.0"]) {
    curView = nav;
    const clicked = await clickNav(nav);
    if (!clicked) { rec("МЕХАНІКА", `роут «${nav}» — нав-пункт знайдено`, false, "кнопку навігації не знайдено", [await shot(page, `nav_${nav}`)]); continue; }
    const boundary = !(await gone("Не вдалося показати"));
    const hasNaN = /(^|[>\s])NaN([<\s]|$)/.test(await page.content());
    const shots = !boundary && !hasNaN ? [] : [await shot(page, `mech_${nav}`)];
    rec("МЕХАНІКА", `роут «${nav}» рендериться (без ErrorBoundary)`, !boundary, boundary ? "ErrorBoundary «Не вдалося показати»" : "", shots);
    rec("МЕХАНІКА", `роут «${nav}» без NaN у DOM`, !hasNaN, hasNaN ? "знайдено «NaN»" : "", shots);
  }

  // ── 1+3. Звіт 2.0: рівні, період, dropdown-и, світлофор ──
  curView = "Звіт 2.0";
  await clickNav("Звіт 2.0");
  // Рівень Відділ — світлофор ≥1 команда, перемикач «Усі менеджери» ≥1 менеджер
  try {
    await clickBtn("Відділ");
    const teamRows = await page.locator("text=/залишок|без плану/").count();
    rec("МЕХАНІКА", "світлофор команд не порожній", teamRows > 0, `рядків ~${teamRows}`, teamRows > 0 ? [] : [await shot(page, "tl_teams_empty")]);
    await clickBtn("Усі менеджери");
    await page.waitForTimeout(1200);
    const mgrRows = await page.locator("text=/залишок|без плану/").count();
    rec("МЕХАНІКА", "плоский рейтинг менеджерів не порожній", mgrRows > 0, `рядків ~${mgrRows}`, mgrRows > 0 ? [] : [await shot(page, "tl_mgrs_empty")]);
    await clickBtn("Команди");
  } catch (e) { rec("МЕХАНІКА", "світлофор", false, String(e.message).slice(0, 120), [await shot(page, "tl_err")]); }

  // Рівень Менеджер — dropdown має >0 опцій (баг, який щойно чинили)
  try {
    await clickBtn("Менеджер");
    await page.getByRole("button", { name: /— менеджер —/ }).first().click({ timeout: 12000 });
    await page.waitForTimeout(1000);
    const opts = await page.getByPlaceholder("Пошук менеджера…").count();
    const optionRows = await page.locator("div[style*='overflow'] button").count();
    const ok = opts > 0 && optionRows > 3;
    rec("МЕХАНІКА", "manager-dropdown має опції (>0)", ok, `пошук=${opts}, опцій~${optionRows}`, ok ? [await shot(page, "mgr_picker_ok")] : [await shot(page, "mgr_picker_empty")]);
    await page.keyboard.press("Escape").catch(() => {});
  } catch (e) { rec("МЕХАНІКА", "manager-dropdown", false, String(e.message).slice(0, 120), [await shot(page, "mgr_picker_err")]); }

  // Період Місяць/Тиждень на рівні Відділ — без ErrorBoundary/NaN
  await clickNav("Звіт 2.0");
  await clickBtn("Відділ");
  for (const per of ["Місяць", "Тиждень"]) {
    try {
      await clickBtn(per);
      const okB = await gone("Не вдалося показати");
      const hasNaN = /(^|[>\s])NaN([<\s]|$)/.test(await page.content());
      rec("МЕХАНІКА", `Звіт 2.0 період «${per}» ок`, okB && !hasNaN, okB ? (hasNaN ? "NaN у DOM" : "") : "ErrorBoundary", okB && !hasNaN ? [] : [await shot(page, `period_${per}`)]);
    } catch (e) { rec("МЕХАНІКА", `період «${per}»`, false, String(e.message).slice(0, 120)); }
  }
  await clickBtn("Місяць");

  // ── консольні помилки (усі види) ──
  rec("МЕХАНІКА", "без помилок у консолі", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | "), consoleErrors.length ? [await shot(page, "console_errors")] : []);

  // ── 2. ІНВАРІАНТИ (дані) ──
  const mr = await apiJson(page, "/api/dashboard/manager-report?level=department&from=2026-07-01&to=2026-07-31&granularity=month");
  try {
    const teams = mr.teams || [], mgrs = mr.managers || [], e = mr.expected;
    const sumT = (a, k) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    const deptFact = mr.revenue.fact;
    const tf = sumT(teams, "fact"), mf = sumT(mgrs, "fact");
    rec("ІНВАРІАНТ", "Σ команд.факт = відділ.факт", Math.abs(tf - deptFact) <= 1, `Σteams ${uah(tf)} vs ${uah(deptFact)}`);
    rec("ІНВАРІАНТ", "Σ менеджерів.факт = відділ.факт", Math.abs(mf - deptFact) <= 1, `Σmgrs ${uah(mf)} vs ${uah(deptFact)}`);
    rec("ІНВАРІАНТ", "Σ планів менеджерів = Σ планів команд", Math.abs(sumT(mgrs, "plan") - sumT(teams, "plan")) <= 1, `${uah(sumT(mgrs, "plan"))} vs ${uah(sumT(teams, "plan"))}`);
    const bucketSum = e.thisMonth.sum + e.nextMonth.sum + e.overdue.sum + e.later.sum + e.noDate.sum;
    rec("ІНВАРІАНТ", "сума бакетів очікувань = total", Math.abs(bucketSum - e.total.sum) <= 1, `Σбакетів ${uah(bucketSum)} vs total ${uah(e.total.sum)}`);
    for (const [k, c] of Object.entries(mr.conversions || {})) {
      const vals = [c.cohort, c.won, c.period, c.handoff].filter((x) => x != null);
      const over = vals.find((x) => x > 100);
      rec("ІНВАРІАНТ", `конверсія «${k}» ≤100%`, over == null, over != null ? `є ${over}%` : "");
    }
  } catch (e) { rec("ІНВАРІАНТ", "розрахунок", false, String(e.message).slice(0, 120)); }

  // ── 3. КРОС-ЕКРАН: Огляд vs Звіт 2.0 ──
  const ov = await apiJson(page, "/api/dashboard/overview?from=2026-07-01&to=2026-07-31");
  const crossShots = async () => { await clickNav("Огляд"); const a = await shot(page, "cross_overview"); await clickNav("Звіт 2.0"); await clickBtn("Відділ"); const b = await shot(page, "cross_report"); return [a, b]; };
  try {
    // факт — має збігатись
    const okFact = Math.round(ov.fact) === Math.round(mr.revenue.fact);
    rec("КРОС-ЕКРАН", "факт: Огляд = Звіт 2.0", okFact, `${uah(ov.fact)} vs ${uah(mr.revenue.fact)}`, okFact ? [] : await crossShots());
    // прогноз — обидва екрани кличуть ЄДИНЕ ядро metrics.buildProjection (Formula A) →
    // на тому самому місяці число має збігатись БАЙТ-У-БАЙТ (не «в межах 2%»).
    const ovProj = ov.projection?.projected, rProj = mr.revenue.projection?.projected;
    const okProj = Math.round(ovProj) === Math.round(rProj);
    rec("КРОС-ЕКРАН", "прогноз: Огляд = Звіт 2.0", okProj, `Огляд ${uah(ovProj)} (${ov.projection?.projectedPct}%) vs Звіт 2.0 ${uah(rProj)} — спільне ядро metrics.buildProjection (Formula A); мають збігатись байт-у-байт`, okProj ? [] : await crossShots());
    // очікування — обидва = ПОВНА 5-стадійна зона (expectedPaymentsByPlanned.total). Огляд
    // читає той самий бакет total, що й Звіт 2.0 → байт-у-байт (не «цей місяць»).
    const ovExp = ov.pendingPayments?.revenue ?? ov.expectedPayments?.revenue;
    const rExp = mr.expected.total.sum;
    const okExp = Math.round(ovExp) === Math.round(rExp);
    rec("КРОС-ЕКРАН", "очікування: Огляд = Звіт 2.0", okExp, `Огляд ${uah(ovExp)} vs Звіт 2.0 total ${uah(rExp)} — спільна 5-стадійна зона (expectedPaymentsByPlanned.total); мають збігатись байт-у-байт`, okExp ? [] : await crossShots());
    // дебіторка — тільки на Огляді (Звіт 2.0 не віддає) → не крос-екран, лише нотатка
    rec("КРОС-ЕКРАН", "дебіторка присутня на Огляді", ov.receivablesTotal != null, `Огляд ${uah(ov.receivablesTotal)}; Звіт 2.0 не показує (не порівнюється)`);
  } catch (e) { rec("КРОС-ЕКРАН", "порівняння", false, String(e.message).slice(0, 120)); }

  await browser.close();
  if (server) server.close();
}

await run().catch((e) => { console.error("HARNESS ERROR:", e); rec("HARNESS", "run", false, String(e.message).slice(0, 200)); });

// ── Підсумок ──
const fails = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ ts: "run", base: FIX ? "OFFLINE(fixtures)" : BASE, total: results.length, failed: fails.length, results }, null, 2));
console.log("\n══════════ ПІДСУМОК ══════════");
console.log(`Усього перевірок: ${results.length} · PASS: ${results.length - fails.length} · FAIL: ${fails.length}`);
if (fails.length) { console.log("\nFAIL-и:"); for (const f of fails) console.log(`  ❌ [${f.kind}] ${f.name} — ${f.detail}${f.shots.length ? " · скрін: " + f.shots.join(", ") : ""}`); }
console.log(`\nЗвіт: ${path.join(OUT, "report.json")} · скріни: ${OUT}`);
process.exit(fails.length ? 1 : 0);
