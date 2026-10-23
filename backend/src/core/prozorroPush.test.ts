import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AI_TENDER_TAG, companyPayload, contactPayload, leadName, leadPayload, pushLeads, responsibleProblem,
  type KommoPushDeps, type PendingLead, type PushStore,
} from "./prozorroPush.js";
import { activeNiches, canEditSettings, parseConfig, saveConfig, type PzConfig } from "./prozorroSettings.js";
import { parsePeriod } from "./prozorroStats.js";
import type { Db } from "./adCallFacts.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const lead = (p: Partial<PendingLead> = {}): PendingLead => ({ id: 1, edrpou: "45740219", uaId: "UA-2026-10-22-000400-a",
  companyName: "ТОВ ДІЗЕЛЬ ЕНЕРДЖИ", address: "07415, село Погреби, вул. Шлях, 1б", contactName: "Ірина", phone: "+380670000000",
  email: "sales@example.ua", title: "Дизельні генератори", card: "Тендер: Дизельні генератори", kommoCompanyExisting: null, ...p });

/**
 * #2360 — КУДИ В KOMMO (рішення TOP Weekly 22.10.2026; id створено й звірено в Kommo того ж дня): угода — «Продзвін» 8921936
 * → «Тендер AI» 113258624, «Источник клиента» = «AI тендер» (6348927), тег «AI тендер», компанія й контакт; бюджету НЕМАЄ.
 * Контакт — ТЕЖ із джерелом «AI тендер» (поле 2097595, значення 6348929): Олександр — «тегати контакт». Компанія — з ЄДРПОУ.
 * 🧨 Червоніє, якщо зламати будь-який id, загубити джерело на контакті, покласти суму тендера в бюджет чи прибрати тег.
 */
test("#2360 КУДИ: «Продзвін» → «Тендер AI», джерело «AI тендер» на угоді й контакті, тег, без бюджету, ЄДРПОУ на компанії", () => {
  const l = leadPayload(lead(), 7181916, 111, 222) as Record<string, unknown> & { _embedded: Record<string, unknown> };
  assert.deepEqual([l.pipeline_id, l.status_id, l.responsible_user_id], [8921936, 113258624, 7181916], "🔴 угода не в «Продзвін» → «Тендер AI» або не на лідогені");
  assert.deepEqual(l.custom_fields_values, [{ field_id: 2098035, values: [{ enum_id: 6348927 }] }], "🔴 угода без джерела «AI тендер»");
  assert.deepEqual(l._embedded, { tags: [{ name: "AI тендер" }], companies: [{ id: 111 }], contacts: [{ id: 222 }] });
  assert.ok(!("price" in l), "🔴 у бюджет угоди потрапила сума — це закупівля клієнта, а не наша маржа");
  assert.equal(l.name, "Тендер: Дизельні генератори");
  const c = contactPayload(lead(), 7181916) as { custom_fields_values: unknown[]; _embedded: unknown; name: string };
  assert.deepEqual(c.custom_fields_values, [
    { field_id: 2097595, values: [{ enum_id: 6348929 }] },
    { field_code: "PHONE", values: [{ value: "+380670000000", enum_code: "WORK" }] },
    { field_code: "EMAIL", values: [{ value: "sales@example.ua", enum_code: "WORK" }] },
  ], "🔴 контакт без джерела «AI тендер» — угода закриється, і походження контакту загубиться");
  assert.deepEqual(c._embedded, { tags: [{ name: AI_TENDER_TAG }] });
  assert.deepEqual((contactPayload(lead({ phone: null, email: null, contactName: null }), 1) as { custom_fields_values: unknown[]; name: string }),
    { name: "ТОВ ДІЗЕЛЬ ЕНЕРДЖИ", responsible_user_id: 1, custom_fields_values: [{ field_id: 2097595, values: [{ enum_id: 6348929 }] }],
      _embedded: { tags: [{ name: "AI тендер" }] } }, "без телефону й пошти — порожніх полів не шлемо, імʼя — назва компанії");
  const co = companyPayload(lead(), 7181916) as { custom_fields_values: unknown[] };
  assert.deepEqual(co.custom_fields_values, [{ field_id: 466493, values: [{ value: "45740219" }] },
    { field_code: "ADDRESS", values: [{ value: "07415, село Погреби, вул. Шлях, 1б" }] }], "🔴 компанія без ЄДРПОУ — наступного разу її не знайдемо");
  assert.equal(leadName(lead({ title: "x".repeat(400) })).length, 250, "🔴 довга назва тендера не обрізана — Kommo відхилить угоду");
  assert.equal(leadName(lead({ title: null })), "Тендер: ТОВ ДІЗЕЛЬ ЕНЕРДЖИ");
});

/**
 * #2361 — ЛІДОГЕН (Роман 22.10.2026: один, з «Налаштувань»): не вибраний, неактивний або без акаунта Kommo — запису НЕМАЄ,
 * причина названа; лише вибраний активний із Kommo — можна писати.
 * 🧨 Червоніє, якщо писати на порожнього, звільненого чи без акаунта (угода впала б на «Операційного директора»).
 */
test("#2361 ЛІДОГЕН: не вибраний / неактивний / без Kommo — не пишемо й кажемо чому; активний із Kommo — пишемо", () => {
  assert.match(responsibleProblem(null) ?? "", /не вибраний у «Налаштуваннях»/);
  assert.match(responsibleProblem({ managerId: 5, name: "Ірина", kommoUserId: 7, active: false }) ?? "", /«Ірина» неактивний/);
  assert.match(responsibleProblem({ managerId: 5, name: "Ірина", kommoUserId: null, active: true }) ?? "", /немає акаунта Kommo/);
  assert.equal(responsibleProblem({ managerId: 5, name: "Ірина", kommoUserId: 7, active: true }), null, "дзеркало: активний лідоген із Kommo — пишемо");
  const job = SRC("jobs/prozorroLeads.ts");
  assert.match(job, /const problem = responsibleProblem\(who\);\n {4}if \(problem\) pushWaiting = [^\n]*;\n {4}else push = await pushLeads\(/,
    "🔴 запис у Kommo не залежить від перевірки лідогена");
});

/** Фейковий Kommo: лічимо виклики, вміємо падати за сценарієм. */
function fakeKommo(o: { found?: number | null; failOn?: (step: string, l: PendingLead) => Error | null } = {}) {
  const calls: string[] = [];
  let n = 1000;
  let cur: PendingLead | null = null;
  const step = async (name: string): Promise<number> => {
    calls.push(`${name}:${String(cur?.id)}`);
    const e = cur && o.failOn ? o.failOn(name, cur) : null;
    if (e) throw e;
    return ++n;
  };
  const kommo: KommoPushDeps = {
    findCompany: async () => { calls.push(`find:${String(cur?.id)}`); return o.found ?? null; },
    createCompany: async () => step("company"),
    createContact: async () => step("contact"),
    createLead: async () => step("lead"),
    addNote: async () => { await step("note"); },
  };
  const saved: number[] = [];
  const failed: [number, string][] = [];
  const store: PushStore = { saved: async (id) => { saved.push(id); }, failed: async (id, e) => { failed.push([id, e]); } };
  const wrap = (rows: PendingLead[]) => rows.map((r) => new Proxy(r, { get: (t, k) => { cur = t; return (t as unknown as Record<string | symbol, unknown>)[k]; } }));
  return { kommo, store, calls, saved, failed, wrap };
}

/**
 * #2362 — КОМПАНІЯ ВЖЕ Є («працюємо як з новою угодою», 22.10): є в нашому довіднику — не шукаємо й не створюємо; знайшлась
 * у Kommo за ЄДРПОУ — не створюємо; немає ніде — створюємо. Угода нова в усіх трьох випадках.
 * 🧨 Червоніє, якщо завести дубль наявної компанії або пропустити угоду для компанії, що вже є.
 */
test("#2362 КОМПАНІЯ: є в довіднику / знайдена в Kommo — нову не створюємо, угода нова; немає — створюємо", async () => {
  const a = fakeKommo();
  await pushLeads(a.wrap([lead({ id: 1, kommoCompanyExisting: 555 })]), 7, a.kommo, a.store);
  assert.deepEqual(a.calls, ["contact:1", "lead:1", "note:1"], "🔴 для компанії з довідника шукали або створили нову");
  const b = fakeKommo({ found: 777 });
  const tb = await pushLeads(b.wrap([lead({ id: 2 })]), 7, b.kommo, b.store);
  assert.deepEqual(b.calls, ["find:2", "contact:2", "lead:2", "note:2"], "🔴 знайдену в Kommo компанію продубльовано");
  assert.equal(tb.companiesReused, 1);
  const c = fakeKommo();
  await pushLeads(c.wrap([lead({ id: 3 })]), 7, c.kommo, c.store);
  assert.deepEqual(c.calls, ["find:3", "company:3", "contact:3", "lead:3", "note:3"], "дзеркало: компанії немає ніде — створюємо");
});

/**
 * #2364 — СТЕЛЯ І ЗБОЇ: при стелі 2 з 5 — рівно 2 угоди; збій на одному ліді — він позначений невдалим, прохід іде далі;
 * відмова Kommo в доступі (403) — стоп усього проходу; збій ПРИМІТКИ після створеної угоди — рядок записаний (угода є,
 * повтор дав би дубль), причина збережена.
 * 🧨 Червоніє, якщо прибрати стелю, зупинятись на поодинокому збої, ігнорувати 403 чи повторювати лід зі створеною угодою.
 */
test("#2364 СТЕЛЯ І ЗБОЇ: стеля 2 з 5; поодинокий збій — далі; 403 — стоп; збій примітки — угода лишається записаною", async () => {
  const five = [1, 2, 3, 4, 5].map((id) => lead({ id, kommoCompanyExisting: 9 }));
  const a = fakeKommo();
  const ta = await pushLeads(a.wrap(five), 7, a.kommo, a.store, 2);
  assert.deepEqual([ta.pending, ta.pushed, a.saved], [5, 2, [1, 2]], "🔴 стелю не дотримано");
  const b = fakeKommo({ failOn: (s, l) => (s === "lead" && l.id === 2 ? new Error("Kommo write POST /api/v4/leads failed 400: bad") : null) });
  const tb = await pushLeads(b.wrap(five.slice(0, 3)), 7, b.kommo, b.store);
  assert.deepEqual([tb.pushed, tb.failed, b.saved, b.failed.map((f) => f[0]), tb.stoppedBy], [2, 1, [1, 3], [2], null], "🔴 поодинокий збій зупинив прохід");
  const c = fakeKommo({ failOn: (s, l) => (s === "contact" && l.id === 2 ? new Error("Kommo write POST /api/v4/contacts failed 403: forbidden") : null) });
  const tc = await pushLeads(c.wrap(five.slice(0, 3)), 7, c.kommo, c.store);
  assert.deepEqual([tc.pushed, c.saved, tc.stoppedBy?.includes("403")], [1, [1], true], "🔴 після відмови Kommo в доступі прохід пішов далі");
  const d = fakeKommo({ failOn: (s) => (s === "note" ? new Error("note 500") : null) });
  const td = await pushLeads(d.wrap([lead({ id: 7, kommoCompanyExisting: 9 })]), 7, d.kommo, d.store);
  assert.deepEqual([td.pushed, d.saved], [1, [7]], "🔴 угоду створено, а рядок лишився «незаписаним» — завтра буде дубль");
  assert.match(d.failed[0]?.[1] ?? "", /угоду створено, примітку не додано: note 500/);
});

/** Фейкова БД для налаштувань: варіанти лідогенів, поточний конфіг, імена, журнал. */
function fakeDb(options: number[], start: Partial<PzConfig> = {}) {
  const state = { cfg: { responsibleManagerId: null, mode: "dry", dailyLimit: null, minAmount: 500000, nichesOff: [], ...start } as PzConfig, log: [] as unknown[][], writes: 0 };
  const db: Db = {
    query: (async (sql: string, params?: unknown[]) => {
      if (/FROM managers m JOIN teams t/.test(sql)) return { rows: options.map((id) => ({ id, name: `L${String(id)}`, team: "Лідогенерація" })) };
      if (/FROM prozorro_settings WHERE id = 1/.test(sql)) {
        const c = state.cfg;
        return { rows: [{ m: c.responsibleManagerId, mode: c.mode, daily_limit: c.dailyLimit, min_amount: String(c.minAmount), niches_off: c.nichesOff }] };
      }
      if (/SELECT id, name FROM managers WHERE id = ANY/.test(sql)) return { rows: ((params?.[0] as number[]) ?? []).map((id) => ({ id, name: `L${String(id)}` })) };
      if (/INSERT INTO prozorro_settings \(/.test(sql)) {
        const [m, mode, dl, ma, no] = params as [number | null, PzConfig["mode"], number | null, number, string[]];
        state.cfg = { responsibleManagerId: m, mode, dailyLimit: dl, minAmount: ma, nichesOff: no }; state.writes++; return { rows: [] };
      }
      if (/INSERT INTO prozorro_settings_log/.test(sql)) { state.log.push(params ?? []); return { rows: [] }; }
      throw new Error(`неочікуваний SQL: ${sql.slice(0, 80)}`);
    }) as Db["query"],
  };
  return { db, state };
}

/**
 * #2365 — НАЛАШТУВАННЯ на екрані (Роман 23.10.2026): лише адмін (GET і PUT у `routes/prozorro.ts` і в матриці — з дзеркалом
 * «адмін бачить»); межі полів (режим, ліміт 1..500 або без, сума 0..100 млн, ніші лише з ТЗ і хоч одна лишається); вибрати
 * можна лише активного лідогена; уже вибраного й згодом неактивного можна лишити; журнал — рядок НА ПОЛЕ, людськими
 * словами; без змін — нічого не пишемо.
 * 🧨 Червоніє, якщо відкрити не-адміну, пропустити поза межами, вибрати не лідогена, писати журнал на повтор чи не на зміну.
 */
test("#2365 НАЛАШТУВАННЯ: лише адмін; межі полів; лише активний лідоген; журнал по полях людськими словами; без змін — тиша", async () => {
  const routes = SRC("routes/prozorro.ts");
  for (const m of ["get", "put"]) {
    assert.match(routes, new RegExp(`prozorroRouter\\.${m}\\("/settings", async \\(req, res\\) => \\{\\n {2}if \\(!canEditSettings\\(req\\.auth!\\.roleKey\\)\\) \\{ res\\.status\\(403\\)`),
      `🔴 ${m.toUpperCase()} /prozorro/settings без межі «адмін і ОД»`);
  }
  assert.deepEqual(["admin", "opdir", "ceo", "kvp", "manager", null].map((r) => canEditSettings(r)), [true, true, false, false, false, false],
    "🔴 налаштування не адміну й ОД (Сергій — opdir) або відкрито ширше");
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js") as { ACCESS_MATRIX: { method: string; path: string; allow: string[]; deny: string[] }[] };
  const g = ACCESS_MATRIX.find((r) => r.method === "GET" && r.path === "/api/prozorro/settings");
  const p = ACCESS_MATRIX.find((r) => r.method === "PUT" && r.path === "/api/prozorro/settings");
  assert.deepEqual(g?.allow, ["admin", "opdir"], "🔴 GET налаштувань у матриці не «адмін і ОД» (або дзеркало: Сергію закрито)");
  assert.ok(g?.deny.includes("kvp") && g.deny.includes("ceo") && g.deny.includes("manager") && p?.deny.includes("manager"), "🔴 матриця не стереже заборону");

  const ok = { responsibleManagerId: 12, mode: "live", dailyLimit: 5, minAmount: 500000, nichesOff: ["Медицина (важке)"] };
  assert.deepEqual(parseConfig(ok), { ok: true, value: ok });
  assert.equal(parseConfig({ ...ok, dailyLimit: null }).ok, true, "дзеркало: без ліміту — можна");
  for (const [bad, why] of [[{ ...ok, mode: "LIVE" }, "режим"], [{ ...ok, dailyLimit: 0 }, "ліміт 0"], [{ ...ok, dailyLimit: 501 }, "ліміт 501"],
    [{ ...ok, minAmount: -1 }, "сума"], [{ ...ok, nichesOff: ["Вигадана"] }, "ніша не з ТЗ"],
    [{ ...ok, nichesOff: Object.keys(activeNiches([])) }, "усі ніші вимкнено"], [{ ...ok, responsibleManagerId: "12" }, "лідоген рядком"]] as const) {
    assert.equal(parseConfig(bad).ok, false, `🔴 пропущено поза межами: ${why}`);
  }

  const who = { userId: 50, name: "Роман" };
  const f = fakeDb([12, 13]);
  assert.deepEqual(await saveConfig(f.db, { ...f.state.cfg, responsibleManagerId: 99 }, who), { ok: false, error: "Можна вибрати лише активного лідогена з акаунтом Kommo" },
    "🔴 вибрано не лідогена / неактивного");
  assert.deepEqual(await saveConfig(f.db, { responsibleManagerId: 12, mode: "live", dailyLimit: 5, minAmount: 200000, nichesOff: [] }, who), { ok: true, changed: 4 });
  assert.deepEqual(f.state.log.map((l) => l.slice(0, 3)), [["режим", "пробний", "бойовий"], ["лідоген", "не вибрано", "L12"], ["ліміт на день", "без ліміту", "5"],
    ["мінімальна сума", "500 000 ₴", "200 000 ₴"]], "🔴 журнал не по полях або не людськими словами");
  assert.deepEqual([await saveConfig(f.db, { ...f.state.cfg }, who), f.state.log.length, f.state.writes], [{ ok: true, changed: 0 }, 4, 1], "🔴 повтор без змін записано");
  const g2 = fakeDb([13], { responsibleManagerId: 12 });
  assert.deepEqual(await saveConfig(g2.db, { ...g2.state.cfg, minAmount: 300000 }, who), { ok: true, changed: 1 },
    "🔴 вибраний, але вже неактивний лідоген блокує збереження інших полів");
});

/**
 * #2368 — ДЖОБА БЕРЕ НАЛАШТУВАННЯ З БАЗИ (екран), а не зі змінних сервера: режим, сума, ліміт на день, ніші; вимкнена ніша
 * не шукається; змінних `PROZORRO_*` у конфігу більше немає (друге джерело правди розійшлося б із екраном).
 * 🧨 Червоніє, якщо повернути змінні сервера, ігнорувати вимкнені ніші чи ліміт.
 */
test("#2368 ДЖОБА: режим, сума, ліміт і ніші — з налаштувань екрана; вимкнена ніша не шукається; змінних сервера немає", () => {
  const job = SRC("jobs/prozorroLeads.ts");
  assert.match(job, /const cfg = await loadConfig\(pool\);/, "🔴 джоба не читає налаштування з бази");
  assert.match(job, /niches: activeNiches\(cfg\.nichesOff\), now, minAmount: cfg\.minAmount, mode,/, "🔴 ніші чи сума не з налаштувань");
  assert.match(job, /pushLeads\([^\n]*cfg\.dailyLimit \?\? Number\.POSITIVE_INFINITY\)/, "🔴 ліміт на день не з налаштувань");
  assert.doesNotMatch(SRC("config.ts") + job, /PROZORRO_|config\.prozorro/, "🔴 повернулись змінні сервера — друге джерело правди");
  const on = activeNiches(["Медицина (важке)"]);
  assert.ok(!("Медицина (важке)" in on) && "Енергетика/електрика" in on && Object.keys(on).length === 7, "🔴 вимкнена ніша лишилась у пошуку");
});

/**
 * #2369 — СТАТИСТИКА ПО ДНЯХ: дні за Києвом, ОБИДВА кінці включно, і для «знайдено», і для «записано в Kommo» (правило
 * проєкту, баг 251 угоди); період — дві дати, from ≤ to, не довше року.
 * 🧨 Червоніє, якщо повернути `<= $to` по часовій мітці, прибрати київський пояс чи пропустити кривий період.
 */
test("#2369 СТАТИСТИКА: дні за Києвом обидва кінці включно; період — дві дати, from ≤ to, не довше року", () => {
  const sql = SRC("core/prozorroStats.ts");
  for (const col of ["created_at", "pushed_at"]) {
    assert.match(sql, new RegExp(`\\(${col} AT TIME ZONE 'Europe/Kyiv'\\)::date BETWEEN \\$1::date AND \\$2::date`), `🔴 ${col}: не київський день або не обидва кінці`);
  }
  assert.deepEqual(parsePeriod("2026-10-24", "2026-10-24"), { ok: true, from: "2026-10-24", to: "2026-10-24" }, "дзеркало: один день — можна");
  for (const [a, b] of [["2026-10-25", "2026-10-24"], ["24.10.2026", "2026-10-25"], ["2025-01-01", "2026-10-24"], [undefined, "2026-10-24"]]) {
    assert.equal(parsePeriod(a, b).ok, false, `🔴 пропущено кривий період ${String(a)}…${String(b)}`);
  }
});

/**
 * #2370 — ЕКРАН ПІДКЛЮЧЕНО: пункт «Тендери Prozorro» у групі «Клієнти» без поля `roles` (видимість — `screen_access`);
 * вкладку видано адміну, СЕО, ОД, КВП; `/api/prozorro` під межею вкладки `prozorro`; екран — статичним імпортом (#225).
 * 🧨 Червоніє, якщо прибрати пункт, роздати вкладку менеджерам, зняти межу маршруту чи імпортувати екран ліниво.
 */
test("#2370 ЕКРАН: пункт у «Клієнтах», вкладка — адмін/СЕО/ОД/КВП, маршрут під вкладкою, статичний імпорт", async () => {
  const fe = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
  const layout = fe("components/Layout.tsx");
  const clients = layout.slice(layout.indexOf('label: "Клієнти"'), layout.indexOf('label: "Робота"'));
  assert.match(clients, /\{ key: "prozorro", label: "Тендери Prozorro", icon: "🏛" \}/, "🔴 пункту «Тендери Prozorro» немає в групі «Клієнти» (або з полем roles)");
  const sql = SRC("db/schema.sql");
  assert.match(sql, /'\{"prozorro":true\}'::jsonb\n {2}WHERE key IN \('admin', 'ceo', 'opdir', 'kvp'\) AND NOT \(screen_access \? 'prozorro'\);/,
    "🔴 вкладку видано не тим ролям");
  const { tabsForPath } = await import("../auth/routeTab.js") as { tabsForPath: (p: string) => string[] | null };
  assert.deepEqual([tabsForPath("/api/prozorro/stats"), tabsForPath("/api/prozorro/settings")], [["prozorro"], ["prozorro"]], "🔴 маршрут без межі вкладки");
  const dash = fe("pages/Dashboard.tsx");
  assert.match(dash, /^import \{ ProzorroSection \} from "\.\/dashboard\/sections\/ProzorroSection";$/m, "🔴 екран не статичним імпортом");
  assert.match(dash, /\{section === "prozorro" && <ProzorroSection roleKey=\{auth\?\.roleKey \?\? null\} \/>\}/, "🔴 екран не рендериться в розділі prozorro");
});

/**
 * #2366 — НАЗВА ЕТАПУ «Тендер AI» у реєстрі назв: інакше «Які угоди рахуємо» й розкриття покажуть сирий id.
 * 🧨 Червоніє, якщо прибрати назву.
 */
test("#2366 НАЗВА ЕТАПУ: «8921936:113258624» = «Тендер AI» у реєстрі назв", async () => {
  const { stageName } = await import("./stageNames.js") as { stageName: (p: number, s: number) => string };
  assert.equal(stageName(8921936, 113258624), "Тендер AI", "🔴 етап «Тендер AI» показується сирим id");
});
