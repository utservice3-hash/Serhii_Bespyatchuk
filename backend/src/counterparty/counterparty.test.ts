import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { runRegistered } from "./pkgTests/vitestShim.js";
import { cpRoleOf, youScoreFromOurEnv } from "./roles.js";
import { MIRROR_NOTE, effectiveDays, legacyRow, mirrorPlan } from "./legacyLimits.js";
import { ROLE_DECLARATIONS } from "../db/roleDeclarations.js";
import { ACCOUNTING_ROLE_KEY, registryRoleOf } from "../minusRegistry/roles.js";

/**
 * 🤝 «РЕЄСТРИ ТА УЗГОДЖЕННЯ + ЛІМІТИ КЛІЄНТІВ» (пакет Сергія 23–24.10.2026). Тести пакета (vitest, 6 файлів) перенесено
 * ДОСЛІВНО в `pkgTests/*.spec.ts` через `vitestShim` — один гейт на файл пакета, падає з переліком проваленого.
 * Далі — наш стик: ролі, дзеркало в «Активну дебіторку», фронт, і наскрізний прогін через НАШ вхід на scratch-БД.
 * Макетні e2e пакета (Playwright) у набір не входять — їх замінює скріншот приймання.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

async function pkgSpec(load: () => Promise<unknown>, min: number) {
  await load();
  const r = await runRegistered();
  assert.ok(r.ran >= min, `перевірок пакета ${r.ran} (чекали ≥ ${min}) — файл не зареєструвався або загубив кейси`);
  assert.deepEqual(r.failed, [], `провалено ${r.failed.length} з ${r.ran}:\n${r.failed.join("\n")}`);
}

/**
 * #2400 — УЗГОДЖЕННЯ: права (менеджер — свої, тім-лід — команди, Сергій і бухгалтерія — усі, staff — нічого), дії за
 * статусом, нормалізація й порівняння умов, тексти помилок. Червоніє, якщо дати чужий запит, дію не тому або змінити текст.
 */
test("#2400 УЗГОДЖЕННЯ КОНТРАГЕНТА: права, дії за статусом, умови й тексти — тести пакета дослівно", async () => {
  await pkgSpec(() => import("./pkgTests/counterparty.spec.js"), 9);
});

/** #2401 — РОЗРАХУНОК ПРИБУТКУ (ПДВ / без ПДВ / готівка, підказки, формула). Червоніє на зміні коефіцієнта чи округлення. */
test("#2401 РОЗРАХУНОК УМОВ: прибуток за формами оплати, рядки й підказки — тести пакета дослівно", async () => {
  await pkgSpec(() => import("./pkgTests/cpCalc.spec.js"), 16);
});

/**
 * #2402 — ЛІМІТИ КЛІЄНТІВ: рядки реєстру, звʼязок ліміт↔боржник, комірки, плитки (`overdueSplit`), дата оплати, бейдж.
 * Кейс «комірка «Ліміти»» (`limitCellHtml`) — фронтовий модуль, його тексти тримає `#2407`.
 */
test("#2402 ЛІМІТИ КЛІЄНТІВ: рядки, звʼязок з боржником, комірки, плитки, дата оплати — тести пакета дослівно", async () => {
  await pkgSpec(() => import("./pkgTests/clientLimits.spec.js"), 7);
});

/** #2403 — КЛІЄНТ YouScore: ключ лише в заголовку, 202 → повтор, лічильник транзакцій, помилки людською мовою. Мережі немає. */
test("#2403 YouScore-КЛІЄНТ: ключ у заголовку, 202 → повтор, лічильник транзакцій, помилки для людини — тести пакета", async () => {
  await pkgSpec(() => import("./pkgTests/youscoreClient.spec.js"), 7);
});

/** #2404 — РОЗБІР YouScore (ЄДР, суди, виконавчі, власники) і повторна перевірка «що змінилось». На фікстурах пакета. */
test("#2404 YouScore-РОЗБІР і ПОВТОРНА ПЕРЕВІРКА: ЄДР, суди, виконавчі, власники, зміни — тести пакета на фікстурах", async () => {
  await pkgSpec(async () => { await import("./pkgTests/youscoreParse.spec.js"); await import("./pkgTests/repeatCheck.spec.js"); }, 15);
});

/**
 * #2405 — РОЛІ ДАШБОРДА → РОЛІ ПАКЕТА (ТЗ §3, рішення Сергія 21–23.10): погоджує ЛИШЕ Сергій (id 1) незалежно від ролі,
 * бухгалтерія — `accounting`, менеджер / тім-лід — подають, адмін / СЕО / ОД / фінансист — перегляд, решта — лише
 * перевірка (`staff`), кандидат — нічого. Ключ YouScore — наш `YOUCONTROL_API_KEY`. Кожна задекларована роль має відповідь:
 * нова роль без рішення тут — червоне.
 */
test("#2405 РОЛІ УЗГОДЖЕННЯ: Сергій погоджує, бухгалтерія бачить усе, керівники дивляться, решта — лише перевірка, ключ — наш", () => {
  const want: Record<string, string | null> = {
    admin: "viewer", team_lead: "lead", manager: "manager", kvp: "staff", financier: "viewer", hr: "staff", ceo: "viewer",
    opdir: "viewer", [ACCOUNTING_ROLE_KEY]: "accounting", candidate: null, business_assistant: "staff",
  };
  for (const d of ROLE_DECLARATIONS) {
    assert.ok(d.key in want, `роль «${d.key}» (${d.name}) задекларована, а ролі в узгодженні для неї не вирішено`);
    assert.equal(cpRoleOf({ userId: 99, roleKey: d.key }, ["1"]), want[d.key], `роль ${d.key}`);
  }
  for (const k of ["manager", "admin", "hr", ACCOUNTING_ROLE_KEY]) assert.equal(cpRoleOf({ userId: 1, roleKey: k }, ["1"]), "approver", `Сергій з роллю ${k} не погоджує`);
  assert.equal(cpRoleOf({ userId: 7, roleKey: "opdir" }, ["1"]), "viewer", "погоджує ОД, якого немає в списку");
  assert.equal(cpRoleOf({ userId: 7, roleKey: "" }, ["1"]), null);
  assert.equal(youScoreFromOurEnv({}), null, "без ключа клієнт YouScore створився");
  assert.ok(youScoreFromOurEnv({ YOUCONTROL_API_KEY: "k" }), "наш ключ YOUCONTROL_API_KEY не підхопився");
  assert.match(SRC("counterparty/roles.ts"), /CP_APPROVER_IDS \|\| process\.env\.MINUS_APPROVER_IDS/, "погоджувач узгодження розійшовся з погоджувачем реєстру");
});

/**
 * #2406 — ДЗЕРКАЛО «Ліміти клієнтів» → «Активна дебіторка» і ПЕРЕНОС наявних лімітів. По обидва боки кожної межі:
 * «від оригіналів» = дні + 10, «від рахунку» / «від вивантаження» = дні; дні поза 0…365 і порожній ліміт — не переносяться;
 * знятий ліміт прибирає дні з дебіторки, але активний сильніший за знятий; звʼязок — і за ключем, і за ЄДРПОУ юрособи.
 */
test("#2406 ДЗЕРКАЛО ЛІМІТІВ У ДЕБІТОРКУ: ефективні дні, перенос, знятий / активний, звʼязок за ключем і ЄДРПОУ", () => {
  assert.equal(effectiveDays(30, "orig"), 40);
  assert.equal(effectiveDays(30, "inv"), 30);
  assert.equal(effectiveDays(30, "od"), 30);
  assert.equal(effectiveDays(null, "orig"), null);
  const base = { client_key: "k", limit_days: 14, limit_amount: "200000", note: "стара", set_at: new Date("2026-09-01T10:00:00Z"),
    name: "ТОВ К", manager_id: "2", manager_name: "Марина", members: [{ code: "41234567", name: "" }] };
  const row = legacyRow(base)!;
  assert.equal(row.from, "inv", "перенесений ліміт рахується не від рахунку — прострочка на екрані зміниться");
  assert.equal(row.days, 14); assert.equal(row.limit, 200000); assert.equal(row.members[0].name, "ТОВ К");
  assert.match(row.note ?? "", /^діяв у дебіторці з 01\.09\.2026 \(стара\)$/);
  assert.equal(legacyRow({ ...base, limit_days: 0 })!.days, 0, "«у відстрочці відмовлено» (0) загубився");
  assert.equal(legacyRow({ ...base, limit_days: 366 }), null);
  assert.equal(legacyRow({ ...base, limit_days: null, limit_amount: "0" }), null);
  assert.equal(legacyRow({ ...base, limit_days: null })!.limit, 200000);

  const debtors = [{ key: "rivne", codes: ["41234567"] }, { key: "lviv", codes: ["31234567"] }, { key: "kyiv", codes: [] }];
  const L = (o: Partial<Parameters<typeof mirrorPlan>[0][number]>) => ({ id: "1", debtorKey: null, active: true, limit: 300000, days: 30, from: "orig" as const, members: [], ...o });
  let p = mirrorPlan([L({ members: [{ code: "41234567" }] })], debtors);
  assert.deepEqual([...p], [["rivne", { days: 40, amount: 300000 }]], "звʼязок за ЄДРПОУ не спрацював або зачепив чужого");
  p = mirrorPlan([L({ debtorKey: "kyiv", from: "inv" })], debtors);
  assert.deepEqual([...p], [["kyiv", { days: 30, amount: 300000 }]]);
  p = mirrorPlan([L({ id: "1", debtorKey: "lviv", active: false }), L({ id: "2", debtorKey: "lviv", days: 7, from: "inv" })], debtors);
  assert.deepEqual(p.get("lviv"), { days: 7, amount: 300000 }, "знятий ліміт перебив активний");
  p = mirrorPlan([L({ id: "2", debtorKey: "lviv", days: 7, from: "inv" }), L({ id: "1", debtorKey: "lviv", active: false })], debtors);
  assert.deepEqual(p.get("lviv"), { days: 7, amount: 300000 }, "знятий ліміт перебив активний (інший порядок)");
  assert.equal(mirrorPlan([L({ debtorKey: "lviv", active: false })], debtors).get("lviv"), null, "знятий ліміт лишився в дебіторці");
  assert.equal(mirrorPlan([], debtors).size, 0, "боржника без рядка в «Лімітах» зачепило");
});

/**
 * #2407 — ФРОНТ: спільна модель у фронті БАЙТ У БАЙТ бекендівська; нові каталоги пакета — без динамічних імпортів (#225),
 * без cookie-клієнта, через наш `api`; CSS — лише під `.cpx`; посилання на файли API перехоплюються (інакше 401);
 * лічильники меню; «Ліміти клієнтів» — 5-та вкладка дебіторки; колонка «Ліміти» — комірка пакета, старі олівці прибрано;
 * тексти комірки (кейс пакета, що не збирається бекендом). Червоніє на кожному з цих відступів.
 */
test("#2407 ФРОНТ УЗГОДЖЕННЯ І ЛІМІТІВ: модель = бекенд, один чанк, наш api, CSS під .cpx, вкладка й колонка в дебіторці", () => {
  for (const f of ["counterparty", "cpCalc", "cpCheck", "cpFormat", "clientLimits"])
    assert.equal(FRONT(`minusRegistry/shared/${f}.ts`), SRC(`counterparty/shared/${f}.ts`), `${f}.ts у фронті розійшовся з бекендом`);
  const dir = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "minusRegistry", "client");
  const files = ["counterparty", "clientLimits"].flatMap((d) => readdirSync(path.join(dir, d)).map((f) => `minusRegistry/client/${d}/${f}`))
    .concat(["minusRegistry/client/registriesMount.ts", "minusRegistry/client/useRegistriesCount.ts", "minusRegistry/client/regTabs.ts", "minusRegistry/client/RegistriesPage.tsx"]);
  assert.ok(files.filter((f) => /\.tsx?$/.test(f)).length >= 14, `файлів фронту пакета ${files.length} — гейт нічого не перевіряє`);
  for (const f of files.filter((x) => /\.tsx?$/.test(x))) {
    const s = FRONT(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    assert.ok(!/\blazy\(|\bimport\(/.test(s), `${f}: динамічний імпорт — другий чанк (#225)`);
    assert.ok(!/credentials:\s*['"]same-origin|\bfetch\(/.test(s), `${f}: cookie-клієнт / fetch пакета замість нашого api`);
  }
  assert.match(FRONT("minusRegistry/client/counterparty/api.ts"), /from '\.\.\/\.\.\/\.\.\/api'/, "клієнт узгодження не через наш api");
  const css = FRONT("minusRegistry/client/counterparty/cp.css").replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "");
  const sel = (css.match(/[^{}]+(?=\{)/g) ?? []).map((x) => x.trim()).filter((x) => x && !x.startsWith("@"));
  assert.ok(sel.length > 50, `селекторів у cp.css ${sel.length} — гейт нічого не перевіряє`);
  for (const x of sel) assert.ok(/\.cpx/.test(x), `cp.css: глобальний селектор «${x}» — стилі мусять бути під .cpx`);

  const page = FRONT("minusRegistry/client/RegistriesPage.tsx");
  assert.match(page, /onClickCapture=\{interceptApiLinks\}/, "посилання на файли API не перехоплюються — PDF і файли дадуть 401");
  assert.match(FRONT("minusRegistry/client/counterparty/api.ts"), /closest\?\.\('a\[href\^="\/api\/counterparty\/"\]'\)/);
  assert.match(FRONT("pages/Dashboard.tsx"), /<RegistriesPage tabs=\{regTabsFor\(auth\?\.roleKey \?\? auth\?\.role\)\}/, "вкладки сторінки не за роллю");
  const layout = FRONT("components/Layout.tsx");
  assert.match(layout, /useRegistriesCount\(60_000/, "лічильник меню «Реєстри» не рахує узгодження");
  assert.match(layout, /item\.key === "receivables" \? limitsCount/, "у пункту «Дебіторська заборгованість» немає лічильника «Лімітів клієнтів»");

  const sec = FRONT("pages/dashboard/sections/ReceivablesSection.tsx").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  assert.match(sec, /\["limits", "Ліміти клієнтів"\]/, "5-ї вкладки «Ліміти клієнтів» немає");
  assert.match(sec, /tab === "limits" \? \(\s*<ClientLimitsTab /, "вкладка «Ліміти клієнтів» нічого не малює");
  assert.match(sec, /<DebtorLimitCell debtor=\{\{ key: c\.clientKey, name: c\.clientName \}\} cell=\{debtorLimits\.cells\[c\.clientKey\]\}\s*canEdit=\{debtorLimits\.canEdit\}/,
    "колонка «Ліміти» не з «Лімітів клієнтів» або олівці не за правом сервера");
  assert.ok(!/<LimitEditor|setLimitFor/.test(sec), "старі олівці ліміту лишились поруч із новими — два редактори одного ліміту");

  const cell = FRONT("minusRegistry/client/clientLimits/debtorLimitMount.ts");
  assert.match(cell, /const ask = !canEdit && c\?\.canRequest \?/, "«Запросити зміну» бачить не лише свій клієнт без права правки");
  for (const t of ["'Запросити ліміт' : 'Запросити зміну'", "'Задати ліміт' : 'Змінити узгоджену відстрочку'", "'Задати ліміт' : 'Змінити ліміт суми'"])
    assert.ok(cell.includes(t), `у комірці «Ліміти» немає тексту ${t}`);
});

/**
 * #2408 — ВКЛАДКИ «РЕЄСТРІВ» ЗА РОЛЛЮ = СЕРВЕРНІ РОЛІ. Фронт (`regTabsFor`) — косметика, але розійдеться з сервером —
 * людина бачить вкладку з 403 або не бачить своєї. «Узгодження» — рівно там, де `cpRoleOf` не `staff`; «Мінусові угоди» —
 * де `registryRoleOf` не null (адмін-рівень — ролі `admin_scope` у БД; тут — як на проді 24.10: адмін, СЕО, ОД, КВП, фінансист).
 */
test("#2408 ВКЛАДКИ РЕЄСТРІВ ЗА РОЛЛЮ: фронт показує рівно те, що відкриє сервер", async () => {
  const fe = await import(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "minusRegistry", "client", "regTabs.ts")) as
    { regTabsFor(k: string | null | undefined): string[] };
  const adminScope = new Set(["admin", "ceo", "opdir", "kvp", "financier"]);
  for (const d of ROLE_DECLARATIONS) {
    if (d.key === "candidate") continue;   // кандидату вкладку `registries` не видано — сторінки він не відкриє
    const tabs = fe.regTabsFor(d.key);
    const cp = cpRoleOf({ userId: 99, roleKey: d.key }, ["1"]);
    const minus = registryRoleOf({ userId: 99, roleKey: d.key, adminScope: adminScope.has(d.key) }, ["1"]);
    assert.equal(tabs.includes("new"), cp !== "staff" && cp !== null, `${d.key}: «Узгодження» на фронті ≠ сервер (${cp})`);
    assert.equal(tabs.includes("minus"), minus !== null, `${d.key}: «Мінусові угоди» на фронті ≠ сервер (${minus})`);
    assert.ok(tabs.includes("check"), `${d.key}: немає «Перевірки контрагента»`);
  }
});

/**
 * #2409 — 🪞 НАСКРІЗНО ЧЕРЕЗ НАШ ВХІД (scratch-БД): ролі й вкладки (`registries` / `receivables`), перенос лімітів дебіторки
 * один раз, комірки «Ліміти» (олівці лише Сергію, «Запросити» — лише свій клієнт), ліміт від Сергія → дзеркало в
 * `client_credit_limits` і `receivables` (ефективні дні), повторне дзеркало й перенос нічого не міняють.
 */
test("#2409 🪞 ЛІМІТИ НАСКРІЗНО: наш вхід і ролі, перенос дебіторки, олівці Сергію, ліміт → дзеркало в дебіторку", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  delete process.env.MINUS_APPROVER_IDS; delete process.env.CP_APPROVER_IDS;
  delete process.env.YOUCONTROL_API_KEY; delete process.env.YOUSCORE_API_KEY;
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  let server: import("node:http").Server | null = null;
  try {
    await c.query(SRC("db/schema.sql"));
    await c.query(`INSERT INTO roles (key, name, built_in, data_scope, screen_access, permissions) VALUES ('${ACCOUNTING_ROLE_KEY}', 'Бухгалтерія', false, 'company', '{}'::jsonb, '{}'::jsonb) ON CONFLICT (key) DO NOTHING`);
    await c.query(SRC("db/schema.sql").slice(SRC("db/schema.sql").indexOf("UPDATE roles SET screen_access = screen_access || '{\"registries\":true}'")));
    await c.query(`INSERT INTO teams (id, name) VALUES (1, 'Команда Ірини'), (2, 'Інша') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id) VALUES (10, 'Марина Коваль', 1), (11, 'Олег Ткачук', 2)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, role_override, full_name, is_active, manager_id) VALUES
      (1, 'utservice3@gmail.com', 'x', 'admin', 'opdir', 'Сергій', true, NULL),
      (2, 'marina@t', 'x', 'manager', NULL, 'Марина Коваль', true, 10), (3, 'oleh@t', 'x', 'manager', NULL, 'Олег Ткачук', true, 11),
      (4, 'hr@t', 'x', 'manager', 'hr', 'HR', true, NULL), (5, 'admin2@t', 'x', 'admin', NULL, 'Інший адмін', true, NULL)`);
    await c.query(`INSERT INTO receivables (client_key, client_name, manager_id, amount, limit_days, overdue_days) VALUES
      ('k-rivne', 'ТОВ Рівне', 10, 500000, NULL, 40), ('k-lviv', 'ТОВ Львів', 11, 100000, 14, 20)`);
    await c.query(`INSERT INTO receivable_invoices (client_key, client_name, manager_id, invoice_no, invoice_date, amount, edrpou) VALUES
      ('k-rivne', 'ТОВ Рівне', 10, 'R-1', CURRENT_DATE - 40, 500000, '41234567'), ('k-lviv', 'ТОВ Львів', 11, 'L-1', CURRENT_DATE - 20, 100000, '31234567')`);
    await c.query(`INSERT INTO client_credit_limits (client_key, limit_days, limit_amount, note, set_by) VALUES ('k-lviv', 14, 200000, 'стара домовленість', 1)`);

    await import("../lib/asyncRoutes.js");
    const { default: express } = await import("express");
    const { buildCounterpartyRouter, buildClientLimitsRouter, debts } = await import("./mount.js");
    const { migrateLegacyLimits, mirrorToReceivables } = await import("./legacyLimits.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    const { pool } = await import("../db/pool.js");
    await refreshRoles();
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/counterparty", buildCounterpartyRouter());
    app.use("/api/client-limits", buildClientLimitsRouter());
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api`;
    const TOK: Record<string, string> = {
      serhii: signToken({ userId: 1, role: "admin", roleKey: "opdir", managerId: null, teamId: null } as never),
      marina: signToken({ userId: 2, role: "manager", roleKey: "manager", managerId: 10, teamId: 1 } as never),
      hr: signToken({ userId: 4, role: "company", roleKey: "hr", managerId: null, teamId: null } as never),
      admin2: signToken({ userId: 5, role: "admin", roleKey: "admin", managerId: null, teamId: null } as never),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (who: string | null, method: string, p: string, body?: unknown): Promise<{ s: number; j: any }> => {
      const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${TOK[who]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      let j: unknown = null; try { j = await r.json(); } catch { /* порожньо */ }
      return { s: r.status, j };
    };
    const ccl = async (k: string) => (await c.query(`SELECT limit_days, limit_amount::numeric::float8 AS amt, note FROM client_credit_limits WHERE client_key = $1`, [k])).rows[0];
    const recv = async (k: string) => (await c.query(`SELECT limit_days, limit_amount::numeric::float8 AS amt FROM receivables WHERE client_key = $1`, [k])).rows[0];

    // ---------- вхід, вкладки, ролі ----------
    assert.equal((await call(null, "GET", "/client-limits/by-debtor")).s, 401, "без входу пускає");
    assert.equal((await call("hr", "GET", "/client-limits/by-debtor")).s, 403, "HR бачить ліміти дебіторки");
    let r = await call("hr", "GET", "/counterparty/checks");
    assert.equal(r.s, 200, `HR не відкриває «Перевірку контрагента»: ${JSON.stringify(r.j)}`); assert.equal(r.j.me.role, "staff");
    assert.equal((await call("hr", "POST", "/counterparty/lookup", { code: "41234567" })).s, 403, "HR подає запит на узгодження");

    // ---------- перенос лімітів дебіторки: один раз ----------
    assert.deepEqual(await migrateLegacyLimits(pool), { inserted: 1, skipped: 0 });
    assert.deepEqual(await migrateLegacyLimits(pool), { inserted: 0, skipped: 0 }, "перенос не idempotent — ліміт задвоївся");

    // ---------- комірки «Ліміти» ----------
    r = await call("serhii", "GET", "/client-limits/by-debtor");
    assert.equal(r.s, 200); assert.equal(r.j.canEdit, true, "Сергій без олівців");
    assert.deepEqual([r.j.cells["k-lviv"].days, r.j.cells["k-lviv"].from, r.j.cells["k-lviv"].limit], [14, "inv", 200000], "перенесений ліміт не той");
    assert.equal(r.j.cells["k-rivne"]?.status ?? "none", "none");
    r = await call("admin2", "GET", "/client-limits/by-debtor");
    assert.equal(r.j.canEdit, false, "олівці в іншого адміна");
    r = await call("marina", "GET", "/client-limits/by-debtor");
    assert.equal(r.j.canEdit, false, "олівці в менеджера");
    assert.equal(r.j.cells["k-rivne"]?.canRequest, true, "менеджер не може запросити ліміт свого клієнта");
    assert.notEqual(r.j.cells["k-lviv"]?.canRequest, true, "менеджер запитує ліміт чужого клієнта");
    assert.equal((await call("marina", "POST", "/client-limits/set", { debtorKey: "k-rivne", limit: 300000, days: 30, from: "orig", reason: "x" })).s, 403, "менеджер задає ліміт");

    // ---------- Сергій задає ліміт → дзеркало в дебіторку ----------
    r = await call("serhii", "POST", "/client-limits/set", { debtorKey: "k-rivne", limit: 300000, days: 30, from: "orig", reason: "домовились" });
    assert.equal(r.s, 201, JSON.stringify(r.j));
    await mirrorToReceivables(pool, debts);
    assert.deepEqual(await ccl("k-rivne"), { limit_days: 40, amt: 300000, note: MIRROR_NOTE }, "дзеркало: «від оригіналів» не +10 або не записалось");
    assert.deepEqual(await recv("k-rivne"), { limit_days: 40, amt: 300000 }, "рядок дебіторки не отримав ліміт");
    assert.deepEqual(await ccl("k-lviv"), { limit_days: 14, amt: 200000, note: "стара домовленість" }, "дзеркало переписало незмінений перенесений ліміт");
    assert.deepEqual(await mirrorToReceivables(pool, debts), { set: 0, cleared: 0 }, "повторне дзеркало щось змінило");
    assert.deepEqual(await migrateLegacyLimits(pool), { inserted: 0, skipped: 0 }, "дзеркальний рядок перенісся назад як «старий»");
    r = await call("serhii", "GET", "/client-limits/by-debtor");
    assert.deepEqual([r.j.cells["k-rivne"].status, r.j.cells["k-rivne"].days, r.j.cells["k-rivne"].from], ["over", 30, "orig"], "борг 500 000 при ліміті 300 000 — не «переліміт»");
  } finally {
    await new Promise((res) => (server ? server.close(() => res(null)) : res(null)));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
  }
});
