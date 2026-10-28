import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fxInvoiceRows, type UnpaidFxSource } from "./receivablesFxSql.js";
import { normalizeClientName } from "../utils/clientName.js";

/**
 * 💱 Валютна дебіторка всередині основної (Сергій 28.10.2026: «ніяким чином не поєднується з функціоналом основної»;
 * Роман 28.10 — «роби як пропонуєш»). Гейти `#1294`–`#1294d` (вільні в `main` і в усіх гілках на 28.10.2026); наступники
 * знятих `#1293`–`#1293c` (окрема вкладка).
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const src = (o: Partial<UnpaidFxSource>): UnpaidFxSource => ({ number: "3011", date: "2026-10-02", contractor: "E-TRADE GROUP SP.z o.o", edrpou: null, currency: "EUR",
  remaining: 1570, manager: "Хомік (1С)", dealId: 62700001, comment: null, ...o });

/**
 * #1294 — РАХУНКИ 1С → РЯДКИ ДЕБІТОРКИ. Гривневі пропускаються (їх веде 361); ключ клієнта — той самий `normalizeClientName`,
 * що в рахунків 361 (інакше склейка, ліміти й домовленість не знайшли б клієнта); ≈ ₴ — за курсом синку з копійками; курсу
 * немає — `null`, а не нуль; без назви — пропуск.
 * 🧨 Червоніє, якщо гривневий рахунок потрапить удруге, ключ піде іншим правилом чи нестача курсу стане нулем.
 */
test("#1294 РАХУНКИ → РЯДКИ: гривня пропускається, ключ — як у 361, ≈ ₴ за курсом синку, без курсу — null, без назви — пропуск", () => {
  const rows = fxInvoiceRows([src({}), src({ number: "1", currency: "UAH", remaining: 9000 }), src({ number: "2", currency: "USD", remaining: 200 }),
    src({ number: "3", contractor: "   " }), src({ number: "4", remaining: 333.336 })], { EUR: 50.8522, USD: null });
  assert.deepEqual(rows.map((r) => r.invoiceNo), ["3011", "2", "4"], "🔴 гривня чи безіменний потрапили");
  assert.equal(rows[0].clientKey, normalizeClientName("E-TRADE GROUP SP.z o.o"), "🔴 ключ клієнта не тим правилом, що в 361");
  assert.deepEqual([rows[0].amountFx, rows[0].amountFxUah], [1570, Math.round(1570 * 50.8522 * 100) / 100], "🔴 ≈ ₴ не за курсом синку");
  assert.deepEqual([rows[1].currency, rows[1].amountFx, rows[1].amountFxUah], ["USD", 200, null], "🔴 без курсу — не null");
  assert.equal(rows[2].amountFx, 333.34, "🔴 копійки валюти");
  assert.deepEqual([rows[0].dealId, rows[0].managerHint], [62700001, "Хомік (1С)"], "🔴 угода чи менеджер 1С загубились");
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
 * #1294b — ЖИВИЙ SQL: ВАЛЮТНИЙ КЛІЄНТ ПРАЦЮЄ ЯК ОСНОВНИЙ, ГРИВНЯ НЕ ЗМІНЮЄТЬСЯ. Σ `receivables.amount` (плитки, КВП, журнал
 * «Фінансів») — та сама, що без валютних; чисто валютний клієнт отримує відповідального з валютних рахунків; боргом у
 * лімітах (`DEBTORS_SQL`) і довіднику клієнтів він є (≈ ₴); списаний валютний рахунок виходить із валютного боргу, а
 * списання пам'ятає валюту й суму у валюті.
 * 🧨 Червоніє, якщо валюта потрапить у гривню, чисто валютний клієнт лишиться без відповідального чи ліміти його не побачать.
 */
test("#1294b ЖИВИЙ SQL: валютний клієнт — відповідальний, ліміти, списання у валюті; Σ гривні та сама", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { FX_UAH_SQL, FX_BY_CURRENCY_SQL } = await import("./receivablesFxSql.js");
  const { recomputeOwners } = await import("./receivablesOwnerStore.js");
  const { DEBTORS_SQL } = await import("../counterparty/debtSourceDb.js");
  const { WRITEOFF_TARGETS_SQL } = await import("./receivablesWriteoff.js");
  try {
    await c.query(`INSERT INTO teams (id, name) VALUES (5, 'Т5')`);
    await c.query(`INSERT INTO managers (id, name, team_id, kommo_user_id) VALUES (4, 'Хомік', 5, 11739992), (7, 'Яцик', 5, 3379102)`);
    await c.query(`INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, manager_id, invoice_no, invoice_date, amount) VALUES
      ('гривнякл', 'гривнякл', 'Гривня Кл', 7, 'U1', CURRENT_DATE - 10, 50000)`);
    await c.query(`INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, manager_id, invoice_no, invoice_date, amount, currency, amount_fx, amount_fx_uah) VALUES
      ('etrade', 'etrade', 'E-TRADE', 4, 'E1', CURRENT_DATE - 14, 0, 'EUR', 1570, 79838.95),
      ('etrade', 'etrade', 'E-TRADE', 4, 'E2', CURRENT_DATE - 5, 0, 'EUR', 1000, 50852.20),
      -- Свіжіший дрібний рахунок ІНШОГО менеджера: без ваги валюти (усі суми 0) тай-брейк «свіжіша дата» віддав би клієнта йому.
      ('etrade', 'etrade', 'E-TRADE', 7, 'E4', CURRENT_DATE - 1, 0, 'EUR', 100, 5085.22),
      ('гривнякл', 'гривнякл', 'Гривня Кл', 7, 'E3', CURRENT_DATE - 3, 0, 'USD', 200, 9120.16)`);
    // Агрегат так, як його будує синк: Σ amount по клієнту (валютні — нулі).
    await c.query(`INSERT INTO receivables (client_key, client_name, amount) SELECT client_key, min(client_name), sum(amount) FROM receivable_invoices GROUP BY client_key`);
    assert.equal(Number((await c.query(`SELECT sum(amount) AS s FROM receivables`)).rows[0].s), 50000, "🔴 валюта потрапила в гривневу суму");
    await recomputeOwners(c as never);
    const owners = (await c.query(`SELECT client_key, manager_id, owner_source FROM receivables ORDER BY client_key`)).rows;
    assert.deepEqual(owners.map((o) => [o.client_key, o.manager_id]), [["etrade", 4], ["гривнякл", 7]], "🔴 чисто валютний клієнт без відповідального чи відповідальний не за сумою у валюті");
    const fx = (await c.query(`SELECT r.client_key, ${FX_UAH_SQL("r")}::float8 AS uah, ${FX_BY_CURRENCY_SQL("r")} AS by FROM receivables r ORDER BY r.client_key`)).rows;
    assert.deepEqual(fx.map((x) => [x.client_key, x.uah, Number(x.by.EUR ?? 0), Number(x.by.USD ?? 0)]), [["etrade", 135776.37, 2670, 0], ["гривнякл", 9120.16, 0, 200]], "🔴 валютний борг клієнта");
    const debtors = new Map((await c.query(DEBTORS_SQL)).rows.map((x) => [x.key, Number(x.debt)]));
    assert.deepEqual([debtors.get("etrade"), debtors.get("гривнякл")], [135776.37, 59120.16], "🔴 ліміти не бачать валютного боргу");
    const target = (await c.query(WRITEOFF_TARGETS_SQL(true), ["etrade", "E1"])).rows[0];
    assert.deepEqual([Number(target.amount), target.currency, Number(target.amount_fx)], [0, "EUR", 1570], "🔴 списання не знає валюти");
    await c.query(`INSERT INTO users (id, email, password_hash, role, is_active) VALUES (50, 'a@t', 'x', 'admin', true)`);
    await c.query(`INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note, written_off_by, currency, amount_fx) VALUES ('etrade', 'E1', 0, 'клієнт банкрут', 50, 'EUR', 1570)`);
    const after = (await c.query(`SELECT ${FX_UAH_SQL("r")}::float8 AS uah, ${FX_BY_CURRENCY_SQL("r")} AS by FROM receivables r WHERE r.client_key = 'etrade'`)).rows[0];
    assert.deepEqual([after.uah, Number(after.by.EUR)], [55937.42, 1100], "🔴 списаний валютний рахунок лишився в боргу");
  } finally { await s.dispose(); }
});

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
/**
 * Хто читає `receivables` і що вирішив щодо валюти. `fx` — рахує борг разом із валютним (≈ ₴): ліміти, вибір відповідального,
 * рядок клієнта. `uah` — лише гривня (валюту окремо не додає: журнал «Дебіторка 1С», де валютна — свій рядок). `none` — суми
 * не читає (лише «клієнт у дебіторці», ліміти, дедлайни). Новий читач — свідоме рішення тут, а не тихе «як вийшло».
 */
const READERS: Record<string, "fx" | "uah" | "none"> = {
  "core/financeKpi.ts": "uah", "core/metrics.ts": "fx", "core/receivablesOwnerStore.ts": "fx",
  "counterparty/debtSourceDb.ts": "fx", "counterparty/clientDirectoryDb.ts": "fx", "counterparty/legacyLimits.ts": "none",
  "jobs/reactCycleSweep.ts": "none", "jobs/receivableDeadlineTasks.ts": "none", "jobs/reactivateLeads.ts": "none",
  "jobs/buildPaymentFile.ts": "fx", "routes/dashboard.ts": "fx",
};

/**
 * #1294c — ПЕРЕЛІЧУВАЧ ЧИТАЧІВ ДЕБІТОРКИ. Кожен файл `backend/src`, що читає таблицю `receivables`, має явне рішення щодо
 * валюти (`READERS`); `fx` — справді бере `FX_UAH_SQL` / `amount_fx_uah`; `uah`/`none` — валюти не чіпають. Простір — УСІ
 * файли (не лише ті, де слово), і він не порожній.
 * 🧨 Червоніє, якщо зʼявиться новий читач без рішення чи «fx»-читач загубить валюту.
 */
test("#1294c ПЕРЕЛІЧУВАЧ: кожен читач receivables має рішення щодо валюти, і воно справді в коді", () => {
  const root = path.join(import.meta.dirname, "..", "..", "src");
  const files = walk(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length > 100, `🔴 обійдено лише ${files.length} файлів`);
  const readers = files.filter((f) => /(FROM|JOIN)\s+receivables(?![_\w])/i.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f).split(path.sep).join("/")).sort();
  assert.deepEqual(readers, Object.keys(READERS).sort(), "🔴 склад читачів receivables змінився — допиши рішення щодо валюти в READERS");
  for (const [f, d] of Object.entries(READERS)) {
    const s = SRC(f);
    if (d === "fx") assert.match(s, /FX_UAH_SQL|amount_fx_uah/, `🔴 ${f}: заявлено «з валютою», а валюти немає`);
    else assert.doesNotMatch(s, /amount_fx|FX_UAH_SQL/, `🔴 ${f}: заявлено «${d}», а валюту читає`);
  }
});

/**
 * #1294d — ПРОВОДКА. Синк кладе валютні рахунки в `receivable_invoices` з `amount = 0` ДО склейки й агрегату; рядок клієнта
 * несе `fx`, рахунок — валюту; списання пише валюту; гривневі платежі «Виписки» до валютних рахунків не пасуються; окремої
 * вкладки й роуту більше немає — замість них перемикач «лише валютні», а суми малює `ClientAmount` / `InvoiceAmount`.
 * 🧨 Червоніє, якщо валюта піде в `amount`, вставка опиниться після агрегату чи вкладка повернеться.
 */
test("#1294d ПРОВОДКА: синк до склейки з amount = 0, рядок і рахунок несуть валюту, списання у валюті, вкладки «Валютна» немає", () => {
  const sync = SRC("jobs/syncReceivables.ts");
  const ins = sync.indexOf("currency, amount_fx, amount_fx_uah)");
  assert.ok(ins > 0 && ins < sync.indexOf("const merged = await client.query(RECOMPUTE_RECEIVABLES_SQL);"), "🔴 валютні вставляються не до склейки");
  assert.match(sync, /VALUES \(\$1,\$1,\$2,\$3,\$4,\$5,\$6,0,\$7,\$8,\$9,\$10,\$11,\$12\)/, "🔴 гривнева сума валютного рахунку не 0");
  const d = SRC("routes/dashboard.ts");
  assert.match(d, /fx: \{ uah: r\.fxUah, byCurrency: r\.fxByCurrency \},/, "🔴 рядок клієнта без валюти");
  assert.match(d, /currency: x\.currency, amountFx: x\.amount_fx, amountFxUah: x\.amount_fx_uah,/, "🔴 рахунок без валюти");
  assert.match(d, /INSERT INTO receivable_writeoffs \(client_key_raw, invoice_no, amount, note, written_off_by, currency, amount_fx\)/, "🔴 списання без валюти");
  assert.doesNotMatch(d, /"\/receivables\/fx"/, "🔴 окремий роут валютної повернувся");
  assert.match(SRC("core/paymentMatch.ts"), /AND ri\.currency IS NULL`;/, "🔴 гривневі платежі пасуються до валютних рахунків");
  const sec = FE("pages/dashboard/sections/ReceivablesSection.tsx");
  assert.doesNotMatch(sec, /\["fx", "Валютна"\]/, "🔴 окрема вкладка «Валютна» повернулась");
  assert.match(sec, /<FxBanner clients=\{all\} only=\{onlyFx\} toggle=/, "🔴 немає підсумку й перемикача «лише валютні»");
  assert.match(sec, /<ClientAmount amount=\{c\.amount\} fx=\{c\.fx\} \/>/, "🔴 сума клієнта без валюти");
  assert.match(sec, /<InvoiceAmount amount=\{x\.amount\} currency=\{x\.currency\}/, "🔴 сума рахунку без валюти");
  assert.match(FE("pages/dashboard/sections/ReceivablesRegistry.tsx"), /<InvoiceAmount amount=\{x\.amount\} currency=\{x\.currency\}/, "🔴 реєстр рахунків без валюти");
});
