import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AI_TENDER_TAG, companyPayload, contactPayload, leadName, leadPayload, pushLeads, pzMode, responsibleProblem,
  type KommoPushDeps, type PendingLead, type PushStore,
} from "./prozorroPush.js";
import { parseProzorroSettings, saveProzorroResponsible } from "./prozorroSettings.js";
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
 * #2363 — РЕЖИМ: «live» — лише точне слово; «off» — вимкнено; усе інше (порожньо, описка) — пробний. Описка в змінній не
 * вмикає запис у CRM (той самий принцип, що в `carrierClose.closeModeOf`).
 * 🧨 Червоніє, якщо описка чи порожнеча увімкне бойовий режим.
 */
test("#2363 РЕЖИМ: «live» — лише точне слово; порожньо й описка — пробний; «off» — вимкнено", () => {
  assert.deepEqual(["", "live", " live ", "Live", "LIVE", "lve", "off", "dry", undefined].map((x) => pzMode(x)),
    ["dry", "live", "live", "dry", "dry", "dry", "off", "dry", "dry"], "🔴 описка чи порожнеча вмикає запис у Kommo");
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

/** Фейкова БД для налаштувань: варіанти, поточний вибір, журнал. */
function fakeDb(options: number[], current: number | null) {
  const state = { current, log: [] as unknown[][] };
  const db: Db = {
    query: (async (sql: string, params?: unknown[]) => {
      if (/FROM managers m JOIN teams t/.test(sql)) return { rows: options.map((id) => ({ id, name: `L${String(id)}`, team: "Лідогенерація" })) };
      if (/SELECT responsible_manager_id AS m FROM prozorro_settings/.test(sql)) return { rows: [{ m: state.current }] };
      if (/INSERT INTO prozorro_settings \(/.test(sql)) { state.current = (params?.[0] as number | null) ?? null; return { rows: [] }; }
      if (/INSERT INTO prozorro_settings_log/.test(sql)) { state.log.push(params ?? []); return { rows: [] }; }
      throw new Error(`неочікуваний SQL: ${sql.slice(0, 80)}`);
    }) as Db["query"],
  };
  return { db, state };
}

/**
 * #2365 — НАЛАШТУВАННЯ: лише адмін (GET і PUT, і в роуті, і в матриці доступу — з дзеркалом «адмін бачить»); вибрати можна
 * лише активного лідогена з Kommo; зняти (null) — можна; кожна зміна — у журнал «було → стало», без зміни — журналу немає.
 * 🧨 Червоніє, якщо відкрити не-адміну, дозволити вибрати не лідогена, писати журнал на повтор чи не писати на зміну.
 */
test("#2365 НАЛАШТУВАННЯ: лише адмін; лише активний лідоген із Kommo; зняти можна; журнал «було → стало» лише на зміну", async () => {
  const routes = SRC("routes/settings.ts");
  for (const m of ["get", "put"]) {
    assert.match(routes, new RegExp(`settingsRouter\\.${m}\\("/prozorro", async \\(req, res\\) => \\{\\n {2}if \\(req\\.auth!\\.roleKey !== "admin"\\) \\{ res\\.status\\(403\\)`),
      `🔴 ${m.toUpperCase()} /settings/prozorro без межі «лише адмін»`);
  }
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js") as { ACCESS_MATRIX: { method: string; path: string; allow: string[]; deny: string[] }[] };
  const g = ACCESS_MATRIX.find((r) => r.method === "GET" && r.path === "/api/settings/prozorro");
  const p = ACCESS_MATRIX.find((r) => r.method === "PUT" && r.path === "/api/settings/prozorro");
  assert.deepEqual(g?.allow, ["admin"], "🔴 GET у матриці не «лише адмін» (або дзеркало: адміну закрито)");
  assert.ok(g?.deny.includes("manager") && g.deny.includes("team_lead") && p?.deny.includes("manager"), "🔴 матриця не стереже заборону");

  assert.deepEqual(parseProzorroSettings({ managerId: 12 }), { ok: true, managerId: 12 });
  assert.deepEqual(parseProzorroSettings({ managerId: null }), { ok: true, managerId: null });
  assert.equal(parseProzorroSettings({ managerId: "12" }).ok, false);
  assert.equal(parseProzorroSettings({}).ok, false);

  const f = fakeDb([12, 13], null);
  const who = { userId: 50, name: "Роман" };
  assert.deepEqual(await saveProzorroResponsible(f.db, 99, who), { ok: false, error: "Можна вибрати лише активного лідогена з акаунтом Kommo" },
    "🔴 вибрано не лідогена / неактивного");
  assert.deepEqual([await saveProzorroResponsible(f.db, 12, who), f.state.current, f.state.log], [{ ok: true, changed: true }, 12, [[null, 12, 50, "Роман"]]]);
  assert.deepEqual([await saveProzorroResponsible(f.db, 12, who), f.state.log.length], [{ ok: true, changed: false }, 1], "🔴 повтор без зміни записано в журнал");
  assert.deepEqual([await saveProzorroResponsible(f.db, null, who), f.state.current, f.state.log[1]], [{ ok: true, changed: true }, null, [12, null, 50, "Роман"]],
    "🔴 зняти вибір не можна або зняття не в журналі");
});

/**
 * #2366 — НАЗВА ЕТАПУ «Тендер AI» у реєстрі назв: інакше «Які угоди рахуємо» й розкриття покажуть сирий id.
 * 🧨 Червоніє, якщо прибрати назву.
 */
test("#2366 НАЗВА ЕТАПУ: «8921936:113258624» = «Тендер AI» у реєстрі назв", async () => {
  const { stageName } = await import("./stageNames.js") as { stageName: (p: number, s: number) => string };
  assert.equal(stageName(8921936, 113258624), "Тендер AI", "🔴 етап «Тендер AI» показується сирим id");
});
