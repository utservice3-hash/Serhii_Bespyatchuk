import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { collectFrom, runCases } from "./testkit/shim.js";

/**
 * 🚚 КОНФІГУРАТОР ВАНТАЖУ В АВТО (12.10.2026) — пакет Сергія `roman-package-konfigurator`, макет v3.
 *
 * #1610–#1612 — ПОРТ його vitest-файлів на `node:test`: тести перенесено ДОСЛІВНО (`testkit/*.cases.ts`, змінено лише
 * імпорти) і проганяються через прокладку `testkit/shim.ts`; гейт називає кожен випадок, що впав.
 * #1613 — справжній роут на тимчасовій базі через HTTP із токенами різних ролей: межі доступу з ТЗ §8.
 * #1614 — таблиці закрито від моделі. #1615 — three.js r128 з нашого сервера — рівно той файл, що в npm.
 */

const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");

async function cases(load: () => Promise<unknown>, min: number, what: string) {
  const list = await collectFrom(load);
  assert.ok(list.length >= min, `🔴 ${what}: випадків ${list.length} < ${min} — перевірці нічого проганяти`);
  const bad = await runCases(list);
  assert.deepEqual(bad, [], `🔴 ${what}: впали ${bad.length} із ${list.length}`);
}

/**
 * #1610 — РУШІЙ = МАКЕТ: 40 названих сценаріїв проти еталона, знятого з макета, і 60 випадкових (фіксоване зерно)
 * проти самого рушія макета (`fixtures/mockup-v2-engine.cjs`). Порівнюється все, що бачить менеджер.
 * 🧨 Червоніє, якщо змінити розкладку, правило «ще влізе», вагу чи порядок місць хоч в одному сценарії.
 */
test("#1610 РУШІЙ = МАКЕТ: 40 еталонних сценаріїв і 60 випадкових — розкладка, «не влізло», «ще влізе», вага", async () => {
  await cases(() => import("./testkit/engineParity.cases.js"), 101, "паритет з макетом");
});

/**
 * #1611 — РУШІЙ: кейси Сергія (палети, рулони, насип, догруз), ручне пересування, арки, інваріанти на 80 випадкових
 * сценаріях (місця не перетинаються й не виходять за кузов).
 * 🧨 Червоніє, якщо зламати перевірку перетину, межі кузова чи арку.
 */
test("#1611 РУШІЙ: кейси Сергія, види вантажів, ручне пересування, арки, інваріанти на 80 сценаріях", async () => {
  await cases(() => import("./testkit/cargoEngine.cases.js"), 17, "рушій");
});

/**
 * #1612 — ДОВІДНИК: блок SEED у `schema.sql` = `cargoDefaults.ts` (через `cargoSeed.seedSql()`), палети рушія =
 * довідник, рішення інтервʼю (вантажопідйомності й розміри), перевірка розрахунку перед збереженням, підпис історії.
 * 🧨 Червоніє, якщо поправити сід руками в схемі чи стандарт у коді без схеми.
 */
test("#1612 ДОВІДНИК: сід у schema.sql = стандарт у коді; перевірка розрахунку; підпис рядка історії", async () => {
  await cases(() => import("./testkit/cargoState.cases.js"), 8, "довідник і стан");
});

/**
 * #1613 — ЖИВИЙ API через HTTP на тимчасовій базі (ТЗ §8: права перевіряє сервер, не лише інтерфейс):
 *  - довідник читають усі з вкладкою «Калькулятор»; HR (без вкладки) — 403 на все, і на three.js теж;
 *  - менеджер і тімлід змінити довідник не можуть (403); адмін, СЕО, ОД — можуть; «стандарт» повертає сід;
 *  - історія: свій розрахунок — так; чужий за id — 404 (не 403); тімлід бачить лише свої; адмін — усі;
 *  - збереження: імʼя з картки, підпис з назви авто довідника; зламаний стан — 400 словами.
 * 🪞 Пари заборона/дозвіл — у кожному пункті. 🧨 Червоніє, якщо прибрати `adminOnly`, фільтр `created_by` чи гейт вкладки.
 */
test("#1613 ЖИВИЙ API КОНФІГУРАТОРА через HTTP: довідник — лише manage_cargo, чужий розрахунок 404, тімлід лише свої", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  process.env.DATABASE_URL = scratch.url;
  for (const k of ["JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  const { pool } = await import("../db/pool.js");
  const { default: express } = await import("express");
  let server: import("node:http").Server | null = null;
  try {
    await pool.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await pool.query(`INSERT INTO teams (id, name) VALUES (9201, 'Тестова В') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO users (id, email, password_hash, role, role_override, team_id, full_name, is_active) VALUES
      (921, 'm1@c', 'x', 'manager', NULL, 9201, 'Марко Вантаж', true),
      (922, 'm2@c', 'x', 'manager', NULL, 9201, 'Марта Вантаж', true),
      (923, 'tl@c', 'x', 'team_lead', NULL, 9201, 'Тарас Вантаж', true),
      (924, 'ad@c', 'x', 'admin', 'admin', NULL, 'Адмін Вантаж', true),
      (925, 'od@c', 'x', 'manager', 'opdir', NULL, 'ОД Вантаж', true),
      (926, 'hr@c', 'x', 'manager', 'hr', NULL, 'HR Вантаж', true),
      (927, 'ceo@c', 'x', 'manager', 'ceo', NULL, 'СЕО Вантаж', true)`);
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();
    const { signToken } = await import("../auth/auth.js");
    const tok = (userId: number, roleKey: string, role: "admin" | "team_lead" | "manager" | "company" = "manager") =>
      signToken({ userId, role, roleKey, managerId: null, teamId: roleKey === "team_lead" ? 9201 : null });
    const M1 = tok(921, "manager"), M2 = tok(922, "manager"), TL = tok(923, "team_lead", "team_lead"),
      AD = tok(924, "admin", "admin"), OD = tok(925, "opdir", "company"), HR = tok(926, "hr", "company"), CEO = tok(927, "ceo", "company");
    const { cargoRouter } = await import("../routes/cargo.js");
    const app = express(); app.use("/api/cargo", cargoRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server!.address() as import("node:net").AddressInfo).port;
    const call = async (token: string | null, method: string, url: string, body?: unknown) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch(`http://127.0.0.1:${port}/api/cargo${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const txt = await r.text(); let json: any = null; try { json = JSON.parse(txt); } catch { json = txt; }
      return { status: r.status, json, type: r.headers.get("content-type") || "", len: txt.length };
    };

    // ── вхід і вкладка ──
    assert.equal((await call(null, "GET", "/reference")).status, 401, "🔴 довідник без входу");
    assert.equal((await call(HR, "GET", "/reference")).status, 403, "🔴 HR без вкладки «Калькулятор» дістав довідник");
    assert.equal((await call(HR, "GET", "/three.js")).status, 403, "🔴 three.js віддано ролі без вкладки");
    assert.equal((await call(null, "GET", "/three.js")).status, 401, "🔴 three.js без входу");
    const three = await call(M1, "GET", "/three.js");
    assert.equal(three.status, 200, "🔴 менеджер не отримав three.js");
    assert.match(three.type, /^application\/javascript/);
    assert.ok(three.len > 500_000, `🔴 three.js завеликий/замалий: ${three.len}`);

    // ── довідник: читають усі, змінює manage_cargo ──
    const { DEFAULT_VEHICLES, DEFAULT_PALLETS } = await import("./cargoDefaults.js");
    const ref = await call(M1, "GET", "/reference");
    assert.equal(ref.status, 200);
    assert.deepEqual(ref.json.vehicles.map((v: { id: string }) => v.id), DEFAULT_VEHICLES.map((v) => v.id), "🔴 сід авто не той");
    assert.deepEqual(ref.json.pallets.map((p: { key: string }) => p.key), DEFAULT_PALLETS.map((p) => p.key), "🔴 сід палет не той");
    const edited = ref.json.vehicles.map((v: { id: string; name: string }) => (v.id === "tent" ? { ...v, name: "Тент змінений" } : v));
    for (const [who, T] of [["менеджер", M1], ["тімлід", TL]] as const) {
      assert.equal((await call(T, "PUT", "/reference/vehicles", { vehicles: edited })).status, 403, `🔴 ${who} змінив довідник авто`);
      assert.equal((await call(T, "PUT", "/reference/pallets", { pallets: ref.json.pallets })).status, 403, `🔴 ${who} змінив палети`);
      assert.equal((await call(T, "POST", "/reference/reset")).status, 403, `🔴 ${who} скинув довідник`);
    }
    for (const [who, T] of [["адмін", AD], ["ОД", OD], ["СЕО", CEO]] as const) {
      const put = await call(T, "PUT", "/reference/vehicles", { vehicles: edited });
      assert.equal(put.status, 200, `🔴 ${who} не зміг змінити довідник: ${JSON.stringify(put.json)}`);
    }
    assert.equal((await call(M1, "GET", "/reference")).json.vehicles.find((v: { id: string }) => v.id === "tent").name, "Тент змінений", "🔴 зміна адміна не дійшла до менеджера");
    const badV = await call(AD, "PUT", "/reference/vehicles", { vehicles: [] });
    assert.equal(badV.status, 400, "🔴 порожній довідник авто прийнято");
    assert.equal(typeof badV.json.error, "string");
    const pal = ref.json.pallets.map((p: { key: string; l: number }) => (p.key === "euro" ? { ...p, l: 1250 } : p));
    assert.equal((await call(AD, "PUT", "/reference/pallets", { pallets: pal })).status, 200);
    const reset = await call(OD, "POST", "/reference/reset");
    assert.equal(reset.status, 200);
    assert.equal(reset.json.vehicles.find((v: { id: string }) => v.id === "tent").name, DEFAULT_VEHICLES.find((v) => v.id === "tent")!.name, "🔴 «стандарт» не повернув назву");
    assert.equal(reset.json.pallets.find((p: { key: string }) => p.key === "euro").l, 1200, "🔴 «стандарт» не повернув палету");

    // ── історія: свої / чужі ──
    const state = {
      veh: "tent", bodies: [{ L: 13600, W: 2450, H: 2700 }], kg: 20000, kgMax: null, arch: null,
      ex: { mode: "meters", split: false, kind: "free", s1: 0, s2: 0, splitY: 0, kg: 0, stop: 1 },
      items: [{ id: "i1", kind: "pallet", name: "Палети", ptype: "euro", l: 1200, w: 800, h: 1600, qty: 8, kg: 400, stop: 1, c: 1 }],
      gap: 10, multi: false, stops: { 1: "Київ" },
    };
    assert.equal((await call(M1, "POST", "/history", { state: { ...state, items: "x" }, layout: null, fit: true })).status, 400, "🔴 зламаний стан збережено");
    assert.equal((await call(HR, "POST", "/history", { state, layout: null, fit: true })).status, 403, "🔴 HR зберіг розрахунок");
    const s1 = await call(M1, "POST", "/history", { state, layout: null, fit: true });
    assert.equal(s1.status, 201, JSON.stringify(s1.json));
    assert.equal(s1.json.userName, "Марко Вантаж", "🔴 імʼя автора не з картки");
    assert.match(s1.json.vehicle, /Тент/, "🔴 підпис авто не з довідника");
    const s2 = await call(M2, "POST", "/history", { state, layout: null, fit: false });
    const s3 = await call(TL, "POST", "/history", { state, layout: null, fit: null });
    assert.deepEqual([s2.status, s3.status], [201, 201]);

    const own = await call(M1, "GET", "/history");
    assert.deepEqual([own.json.scope, own.json.rows.map((r: { id: string }) => r.id)], ["own", [s1.json.id]], "🔴 менеджер бачить не рівно свої");
    const lead = await call(TL, "GET", "/history");
    assert.deepEqual([lead.json.scope, lead.json.rows.map((r: { id: string }) => r.id)], ["own", [s3.json.id]], "🔴 тімлід бачить не лише свої (рішення 12.10)");
    for (const [who, T] of [["адмін", AD], ["ОД", OD], ["СЕО", CEO]] as const) {
      const all = await call(T, "GET", "/history");
      assert.deepEqual([all.json.scope, all.json.rows.map((r: { id: string }) => r.id).sort()], ["all", [s1.json.id, s2.json.id, s3.json.id].sort()], `🔴 ${who} бачить не всю історію`);
    }
    assert.equal((await call(M1, "GET", `/history/${s1.json.id}`)).status, 200, "🔴 свій розрахунок не відкрився");
    assert.deepEqual((await call(M1, "GET", `/history/${s1.json.id}`)).json.state.items[0].qty, 8);
    const foreign = await call(M1, "GET", `/history/${s2.json.id}`);
    assert.equal(foreign.status, 404, "🔴 чужий розрахунок відкрився або видав своє існування кодом 403");
    assert.equal((await call(TL, "GET", `/history/${s1.json.id}`)).status, 404, "🔴 тімлід відкрив розрахунок менеджера");
    assert.equal((await call(AD, "GET", `/history/${s2.json.id}`)).status, 200, "🔴 адмін не відкрив чужий розрахунок");
    assert.equal((await call(M1, "GET", "/history/abc")).status, 404);
    void M2;
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

/**
 * #1614 — РОЗРАХУНКИ ЗАКРИТО ВІД МОДЕЛІ: три таблиці конфігуратора — REVOKE після GRANT і CREATE, і в FORBIDDEN_TABLES
 * (у розрахунках — хто що возить і куди).
 * 🧨 Червоніє, якщо прибрати REVOKE, поставити його вище GRANT/CREATE або прибрати таблицю з переліку.
 */
test("#1614 таблиці конфігуратора відібрані в ai_readonly після GRANT і CREATE і є в FORBIDDEN_TABLES", () => {
  const sql = SRC("db/schema.sql");
  const grantAt = sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;");
  const revokeAt = sql.indexOf("REVOKE ALL ON cargo_vehicles, cargo_pallets, cargo_calculations FROM ai_readonly;");
  const list = /FORBIDDEN_TABLES\s*=\s*\[([\s\S]*?)\]/.exec(SRC("ai/metricTools.ts"));
  for (const tbl of ["cargo_vehicles", "cargo_pallets", "cargo_calculations"]) {
    const createAt = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tbl} (`);
    assert.ok(grantAt > 0 && createAt > 0, `🔴 не знайдено GRANT чи CREATE ${tbl}`);
    assert.ok(revokeAt > grantAt && revokeAt > createAt, `🔴 REVOKE ${tbl} немає або він вище GRANT/CREATE`);
    assert.ok(list && list[1].includes(`"${tbl}"`), `🔴 ${tbl} не в FORBIDDEN_TABLES`);
  }
});

/**
 * #1615 — THREE.JS З НАШОГО СЕРВЕРА (рішення Романа 12.10, варіант А): `vendor/three-r128.min.js` — байт у байт
 * `three@0.128.0/build/three.min.js` (sha256 нижче), і роут читає саме його. У бандлі фронту three немає (#225).
 * 🧨 Червоніє, якщо підмінити файл іншою версією або перевести роут на інший шлях.
 */
test("#1615 THREE.JS r128: вендорний файл = npm three@0.128.0, роут віддає саме його", async () => {
  const { THREE_FILE } = await import("../routes/cargo.js").catch(() => ({ THREE_FILE: "" }));
  // роут імпортує pool → без DATABASE_URL падає на імпорті; тоді шлях звіряємо за джерелом
  const file = THREE_FILE || path.join(import.meta.dirname, "..", "..", "vendor", "three-r128.min.js");
  if (!THREE_FILE) assert.match(SRC("routes/cargo.ts"), /THREE_FILE = path\.join\(import\.meta\.dirname, "\.\.", "\.\.", "vendor", "three-r128\.min\.js"\)/, "🔴 роут читає не вендорний файл");
  const buf = readFileSync(file);
  assert.equal(createHash("sha256").update(buf).digest("hex"), "9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2", "🔴 three.js — не r128 з npm");
  assert.match(buf.subarray(0, 200).toString("utf8"), /Copyright .* Three\.js Authors[\s\S]*MIT/, "🔴 без MIT-шапки");
});

const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

/**
 * #1616 — ФРОНТ КОНФІГУРАТОРА (ТЗ §0, §5):
 *  - спільний код (рушій, довідник, стан, формат) у фронті — БАЙТ У БАЙТ бекендівський: паритет #1610 доведено на
 *    бекенд-копії, тож інакше він нічого не казав би про те, що бачить менеджер;
 *  - меню й заголовок — «Калькулятор ставок та вантажу»; маршрут rates рендерить екран із двома вкладками, «Розрахунок
 *    ставки» — наявний `RatesSection` за замовчуванням; `?tab=cargo` відкриває конфігуратор;
 *  - жодного `lazy(`/`import(` (#225 — один чанк) і жодного пакета `three`: 3D тягнеться з `/cargo/three.js`;
 *  - стилі — лише під `.cargo-cfg` / `.rates-cargo`; вкладка відкривається з авто «10 т» (рішення 12.10).
 * 🧨 Червоніє, якщо розвести копію рушія, повернути `lazy`/`import('three')`, залишити старий підпис меню чи
 * написати глобальний селектор.
 */
test("#1616 ФРОНТ КОНФІГУРАТОРА: рушій = бекенд байт у байт, меню й вкладки, ?tab=cargo, один чанк, three з сервера, CSS ізольовано", () => {
  for (const f of ["cargoEngine", "cargoDefaults", "cargoState", "cargoFormat"]) {
    assert.equal(FRONT(`cargo/shared/${f}.ts`), SRC(`cargo/${f}.ts`), `🔴 ${f}.ts у фронті розійшовся з бекендом`);
  }
  const layout = FRONT("components/Layout.tsx"), dash = FRONT("pages/Dashboard.tsx"), sec = FRONT("pages/dashboard/sections/RatesAndCargoSection.tsx");
  assert.match(layout, /\{ key: "rates", label: "Калькулятор ставок та вантажу",/, "🔴 пункт меню не перейменовано");
  assert.match(sec, /export const PAGE_TITLE = "Калькулятор ставок та вантажу";/);
  assert.match(dash, /\{section === "rates" && <RatesAndCargoSection \/>\}/, "🔴 маршрут rates не рендерить екран із вкладками");
  assert.match(sec, /hidden=\{tab !== "rate"\}><RatesSection \/><\/div>/, "🔴 «Розрахунок ставки» — не наявний RatesSection");
  assert.ok(!/<h1\b/.test(FRONT("pages/dashboard/sections/RatesSection.tsx")), "🔴 у вкладці «Розрахунок ставки» знову свій заголовок — два заголовки поспіль (рішення 12.10)");
  assert.match(sec, /params\.get\("tab"\) === "cargo" \? "cargo" : "rate"/, "🔴 ?tab=cargo не відкриває конфігуратор / не rate за замовчуванням");
  const files = ["cargo/client/cargo/configurator.ts", "cargo/client/cargo/topView.ts", "cargo/client/cargo/view3d.ts", "cargo/client/cargo/schemePng.ts",
    "cargo/client/cargo/api.ts", "cargo/client/cargo/CargoConfiguratorTab.tsx", "pages/dashboard/sections/RatesAndCargoSection.tsx"];
  for (const f of files) {
    // код без коментарів: пакет згадує `import('three')` у doc-коментарі як спосіб для інших застосунків
    const s = FRONT(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    assert.ok(!/\blazy\(|\bimport\(/.test(s), `🔴 ${f}: динамічний імпорт — другий чанк (#225)`);
    assert.ok(!/from ['"]three['"]/.test(s), `🔴 ${f}: пакет three у бандлі`);
  }
  const api = FRONT("cargo/client/cargo/api.ts");
  assert.match(api, /api\.get\('\/cargo\/three\.js'/, "🔴 three.js тягнеться не з нашого сервера");
  assert.match(FRONT("cargo/client/cargo/CargoConfiguratorTab.tsx"), /user, api: cargoApi, loadThree,/);
  assert.match(FRONT("cargo/shared/cargoDefaults.ts"), /export const DEFAULT_VEHICLE_ID = 't10';/, "🔴 вкладка відкривається не з «10 т»");
  for (const [f, root] of [["cargo/client/cargo/configurator.css", ".cargo-cfg"], ["cargo/client/ratesAndCargoPage.css", ".rates-cargo"]] as const) {
    const css = FRONT(f).replace(/\/\*[\s\S]*?\*\//g, "");
    const sels: string[] = []; let buf = "";
    for (const ch of css) { if (ch === "{") { sels.push(buf.trim()); buf = ""; } else if (ch === "}") buf = ""; else buf += ch; }
    assert.ok(sels.length > 5, `🔴 ${f}: селекторів не знайдено — перевірці нічого перевіряти`);
    const global = sels.filter((s) => s && !s.startsWith("@") && !/^(from|to|\d+%)$/.test(s))
      .flatMap((s) => s.split(",")).map((s) => s.trim()).filter((s) => !s.includes(root));
    assert.deepEqual(global, [], `🔴 ${f}: глобальні селектори — чіпають стилі дашборда`);
  }
});

/**
 * #1617 — СХЕМА ЗВЕРХУ (те, що бачить перевізник на PNG і менеджер на екрані): тести пакета `topView.test.ts`
 * дослівно, проти ДЖЕРЕЛА ФРОНТУ (`testkit/frontTopView.ts` транспілює його на льоту).
 * 🧨 Червоніє, якщо зламати підписи «є», вільну довжину чи номери з розшифровкою на схемі.
 */
test("#1617 СХЕМА ЗВЕРХУ: тести пакета проти джерела фронту — підписи, вільна довжина, номери з розшифровкою", async () => {
  await cases(() => import("./testkit/topView.cases.js"), 6, "схема зверху");
});
