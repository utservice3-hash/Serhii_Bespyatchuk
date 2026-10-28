import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { groupFx, inScope, type FxRaw } from "./receivablesFx.js";

/**
 * 💱 Валютна дебіторка у вкладці «Дебіторка» (задача 7136; Сергій 26.10.2026, Роман 28.10 — «роби як пропонуєш»).
 * Гейти `#1293`–`#1293c` (вільні в `main` і в усіх гілках на 28.10.2026).
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const raw = (o: Partial<FxRaw>): FxRaw => ({ number: "3011", date: "2026-09-17", organization: "АвтоМув", contractor: "ТОВ «Альфа»", edrpou: "111", currency: "EUR",
  invoiceSum: 1800, paidSum: 0, remaining: 1800, realized: false, partiallyPaid: false, dueDate: null, manager1c: "Шевчук (1С)", dealId: 61000001,
  managerId: 4, managerName: "Шевчук", teamId: 5, ...o });

/**
 * #1293 — СКОУП І ПІДСУМОК. Клієнт — за ЄДРПОУ (без нього — за назвою); видно, якщо хоч один його рахунок у скоупі, і тоді
 * з УСІМА рахунками (як гривнева дебіторка, рішення власника 27.08); менеджер — лише свої клієнти, тімлід — команда, а
 * звужений до чужого менеджера — нуль (умови через І). Підсумок — по валютах окремо; гривня — за курсом синку, курсу немає —
 * `null` і лічильник, а не нуль; днів — від дати рахунку; «без реалізації» рахується.
 * 🧨 Червоніє, якщо менеджер побачить чужого клієнта, валюти зіллються в одне число чи нестача курсу стане нулем.
 */
test("#1293 СКОУП І ПІДСУМОК: клієнт за ЄДРПОУ з усіма рахунками, менеджер — свої, валюти окремо, без курсу — не нуль", () => {
  const rows = [
    raw({}), raw({ number: "3087", date: "2026-10-02", remaining: 1420, managerId: 7, managerName: "Яцик", teamId: 6 }),
    raw({ number: "4001", contractor: "ФОП Бета", edrpou: null, remaining: 288, realized: true, managerId: 7, managerName: "Яцик", teamId: 6, date: "2026-04-23" }),
    raw({ number: "4002", contractor: "Гамма LLC", edrpou: null, currency: "USD", remaining: 500, managerId: null, managerName: null, teamId: null, dealId: null, date: "2026-10-20" }),
  ];
  const rates = { EUR: 48.4, USD: null };
  const all = groupFx(rows, { managerId: null, teamId: null }, rates, "2026-10-28");
  assert.deepEqual(all.clients.map((c) => [c.name, c.invoices.length, c.days]), [["ФОП Бета", 1, 188], ["ТОВ «Альфа»", 2, 41], ["Гамма LLC", 1, 8]], "🔴 клієнти, групування чи дні");
  assert.deepEqual(all.totals.byCurrency, { EUR: 3508, USD: 500 }, "🔴 валюти злились чи загубились");
  assert.deepEqual([all.totals.uah, all.totals.uahMissing, all.totals.notRealized, all.totals.invoices], [Math.round(1800 * 48.4) + Math.round(1420 * 48.4) + Math.round(288 * 48.4), 1, 3, 4], "🔴 гривня, нестача курсу чи «без реалізації»");
  assert.equal(all.clients.find((c) => c.name === "Гамма LLC")!.uah, null, "🔴 без курсу показано нуль гривень");
  const shevchuk = groupFx(rows, { managerId: 4, teamId: null }, rates, "2026-10-28");
  assert.deepEqual(shevchuk.clients.map((c) => [c.name, c.invoices.map((i) => i.number)]), [["ТОВ «Альфа»", ["3011", "3087"]]], "🔴 менеджер: не свій клієнт чи обрізані рахунки клієнта");
  assert.deepEqual(groupFx(rows, { managerId: null, teamId: 6 }, rates, "2026-10-28").clients.map((c) => c.name), ["ФОП Бета", "ТОВ «Альфа»"], "🔴 тімлід — не своя команда");
  assert.deepEqual(groupFx(rows, { managerId: 4, teamId: 6 }, rates, "2026-10-28").clients, [], "🔴 тімлід розширився чужим менеджером");
  assert.equal(inScope({ managerId: null, teamId: null }, { managerId: 4, teamId: null }), false, "🔴 рахунок без угоди потрапив менеджеру");
});

async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  // Кластер уже піднятий: впало підключення чи схема — зупинити його, інакше тест висить вічно на живому postgres.
  try {
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  } catch (e) { await c.end().catch(() => undefined); scratch.dispose(); throw e; }
  return { c, dispose: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #1293b — ЖИВИЙ SQL: ТЕ САМЕ ДЖЕРЕЛО, ТОЙ САМИЙ КУРС. Синк (`replaceUnpaid`) памʼятає курс, з яким рахував підсумок, і
 * «Дебіторка» рахує ≈ грн саме за ним, тож Σ вкладки == рядок журналу «Фінансів»; гривневі рахунки сюди не потрапляють;
 * менеджер рахунку — з угоди CRM (`deals.manager_id`), а не з тексту 1С.
 * 🧨 Червоніє, якщо вкладка й «Фінанси» розійдуться в гривні чи менеджер візьметься не з угоди.
 */
test("#1293b ЖИВИЙ SQL: курс синку збережено, Σ вкладки == журнал «Фінансів», гривня не потрапляє, менеджер — з угоди", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { replaceUnpaid } = await import("./unpaidSync.js");
  const { loadReceivablesFx } = await import("./receivablesFx.js");
  const db = c as unknown as import("./finance.js").Db;
  try {
    await c.query(`INSERT INTO teams (id, name) VALUES (5, 'Т5')`);
    await c.query(`INSERT INTO managers (id, name, team_id) VALUES (4, 'Шевчук', 5), (7, 'Яцик', 5)`);
    await c.query(`INSERT INTO deals (kommo_id, manager_id) VALUES (61000001, 4), (61000002, 7)`);
    const inv = (o: Record<string, unknown>) => ({ uid: String(o.number), number: "", date: "2026-10-01", organization: "АвтоМув", contractor: "ТОВ «Альфа»", edrpou: "111", currency: "EUR",
      invoiceSum: 1000, paidSum: 0, remaining: 1000, realized: false, partiallyPaid: false, debtAccount: null, dueDate: null, manager: "Хтось з 1С", dealId: 61000001, comment: null, ...o });
    await replaceUnpaid(db, [inv({ number: "1" }), inv({ number: "2", remaining: 333.33, dealId: 61000002 }), inv({ number: "3", currency: "UAH", remaining: 50000 }),
      inv({ number: "4", currency: "USD", remaining: 200, contractor: "Бета", edrpou: "222", dealId: null })] as never, { EUR: 48.4123, USD: 41.5 });
    const fx = await loadReceivablesFx(db, { managerId: null, teamId: null }, "2026-10-28");
    const journal = (await c.query(`SELECT total_uah::float8 AS uah, eur::float8 AS eur, usd::float8 AS usd FROM receivables_fx_totals ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.deepEqual([fx.rates.EUR, fx.rates.USD], [48.4123, 41.5], "🔴 курс синку не збережено");
    assert.deepEqual([fx.totals.byCurrency.EUR, fx.totals.byCurrency.USD, fx.totals.byCurrency.UAH], [journal.eur, journal.usd, undefined], "🔴 валюта вкладки ≠ журнал чи гривня потрапила");
    assert.ok(Math.abs(fx.totals.uah - journal.uah) <= 1, `🔴 гривня вкладки ${fx.totals.uah} ≠ «Фінанси» ${journal.uah}`);
    const alpha = fx.clients.find((x) => x.edrpou === "111")!;
    assert.deepEqual(alpha.invoices.map((i) => [i.number, i.manager]).sort(), [["1", "Шевчук"], ["2", "Яцик"]], "🔴 менеджер не з угоди CRM");
    assert.deepEqual((await loadReceivablesFx(db, { managerId: 7, teamId: null }, "2026-10-28")).clients.map((x) => x.invoices.length), [2], "🔴 менеджер не бачить клієнта з усіма рахунками");
  } finally { await s.dispose(); }
});

/**
 * #1293c — ПРОВОДКА. Роут — у межі «Дебіторки» і ПЕРШИМ ділом той самий `receivablesScope`; у матриці — ті самі ролі, що
 * в рахунків гривневої дебіторки; вкладка «Валютна» рендерить список, рядок над «Активною» веде на неї, а плитки гривневої
 * дебіторки валютних грошей НЕ отримують (окремо — рішення 28.10).
 * 🧨 Червоніє, якщо роут піде без скоупу, валюта додасться до гривні чи вкладка зникне.
 */
test("#1293c ПРОВОДКА: роут під receivablesScope, матриця як у рахунків, вкладка й рядок над «Активною», до гривні не додається", async () => {
  const d = SRC("routes/dashboard.ts");
  assert.match(d, /dashboardRouter\.get\("\/receivables\/fx", async \(req, res\) => \{\n\s*const sc = receivablesScope\(req\.auth!, req\.query\);\n\s*if \(!sc\.ok\) return/, "🔴 роут без скоупу дебіторки першим");
  assert.match(SRC("auth/routeTab.ts"), /\{ test: pre\("\/api\/dashboard\/receivables"\), tabs: \["receivables"\] \}/, "🔴 межа вкладки «Дебіторка» зникла");
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js");
  const row = (p: string) => ACCESS_MATRIX.find((x) => x.method === "GET" && x.path === p);
  assert.deepEqual([...(row("/api/dashboard/receivables/fx")?.allow ?? [])].sort(), [...(row("/api/dashboard/receivables/invoices")?.allow ?? ["?"])].sort(), "🔴 у матриці не ті ролі, що в рахунків дебіторки");
  assert.ok(row("/api/dashboard/receivables/fx")!.deny.includes("hr"), "🔴 HR не в забороні");
  const sec = FE("pages/dashboard/sections/ReceivablesSection.tsx");
  assert.match(sec, /\["fx", "Валютна"\]/, "🔴 вкладки «Валютна» немає");
  assert.match(sec, /tab === "fx" \? \(\n\s*<ReceivablesFxTab fx=\{fx\}/, "🔴 вкладка не рендерить список");
  assert.match(sec, /<FxBanner fx=\{fx\} onOpen=\{\(\) => setTab\("fx"\)\} \/>\n\s*<ReceivablesTiles/, "🔴 немає рядка над «Активною дебіторкою»");
  const tiles = sec.slice(sec.indexOf("<ReceivablesTiles"), sec.indexOf("/>", sec.indexOf("<ReceivablesTiles")));
  assert.doesNotMatch(tiles, /fx/i, "🔴 валютна додана до плиток гривневої дебіторки");
  assert.match(SRC("core/unpaidSync.ts"), /rate_eur = EXCLUDED\.rate_eur, rate_usd = EXCLUDED\.rate_usd/, "🔴 синк не памʼятає курс");
});
