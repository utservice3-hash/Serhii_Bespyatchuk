import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BankTx } from "./txSource.js";

/**
 * 💳 РОБОЧА КАРТКА «Беспятчук white (Моно)» ЗАМІСТЬ КАРТКИ СТУПАКІВСЬКОГО (Тетяна 13.11.2026: «так само, як з картою Саші»):
 *  1. № рахунку до надходжень — менеджери вносять (картка в списку рахунків правила);
 *  2. розшифровку витрат вносять ЛИШЕ «люди картки» (`bank_accounts.out_editors`: Тетяна й Яцик), бухгалтерія бачить;
 *     менеджерам витрати закриті;
 *  3. надходження бачать усі, ОКРІМ «З гривневого рахунку ФОП».
 * Гейти `#3930`–`#3930c`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

async function lazy() {
  // ліниво: txSource → core/bankReport → db/pool, а пул кидає на імпорті без DATABASE_URL (правило зони testing)
  process.env.DATABASE_URL ??= "postgres://unused/none";
  for (const k of ["JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  return { ...(await import("./txSource.js")), ...(await import("./bankIdent.js")), ...(await import("../core/bankReport.js")) };
}

/**
 * #3930 — ХТО ЩО БАЧИТЬ НА КАРТЦІ, по обидва боки кожної межі (`canSeeTxRow`, та сама функція, що в «№ рахунку» й розшифровці):
 * поповнення «З гривневого рахунку ФОП» — лише з `view_private_finance`, оплата від людини — усім; витрати картки — з правом
 * АБО «людині картки» (за id), іншому тімліду — ні; на рахунку без «людей картки» — як було. Поповнення — свій переказ
 * (№ рахунку не потрібен), оплата від людини — ні. Картка (id 9) — у списку рахунків правила «№ рахунку».
 * 🧨 Червоніє, якщо поповнення побачить менеджер, витрати — чужий тімлід, або поповнення почне вимагати № рахунку.
 */
test("#3930 КАРТКА: поповнення з ФОП — лише з правом, витрати — з правом або «людині картки», поповнення — свій переказ", async () => {
  const { canSeeTxRow, isOwnTransfer, isFopTopUp, DEFAULT_ACCOUNT_IDS, toLite } = await lazy();
  const card: BankTx = { id: 1, account_id: 9, direction: "in", booked_at: "2026-11-13T10:00:00Z", counterparty_name: "Buleziuk Vadym",
    purpose: "Від: Buleziuk Vadym", finance_only: false, out_private: true, out_editors: [8, 22], account_active: true };
  const topUp: BankTx = { ...card, counterparty_name: "З гривневого рахунку ФОП", purpose: "З гривневого рахунку ФОП" };
  const out: BankTx = { ...card, direction: "out", counterparty_name: "АЗС" };
  const P: never[] = [];
  const manager = { privateFinance: false, hiddenPayments: false, userId: 300 };
  const yatsyk = { privateFinance: false, hiddenPayments: false, userId: 22 };
  const otherLead = { privateFinance: false, hiddenPayments: false, userId: 20 };
  const buh = { privateFinance: true, hiddenPayments: false, userId: 500 };
  assert.equal(canSeeTxRow(card, manager, P), true, "🔴 оплату від людини менеджер не бачить");
  assert.equal(canSeeTxRow(topUp, manager, P), false, "🔴 поповнення з ФОП бачить менеджер");
  assert.equal(canSeeTxRow(topUp, yatsyk, P), false, "🔴 поповнення з ФОП бачить тімлід без права");
  assert.equal(canSeeTxRow(topUp, buh, P), true, "🔴 поповнення з ФОП не бачить бухгалтерія");
  assert.equal(canSeeTxRow(out, manager, P), false, "🔴 витрати картки бачить менеджер");
  assert.equal(canSeeTxRow(out, otherLead, P), false, "🔴 витрати картки бачить чужий тімлід");
  assert.equal(canSeeTxRow(out, yatsyk, P), true, "🔴 «людина картки» не бачить витрат");
  assert.equal(canSeeTxRow(out, buh, P), true, "🔴 бухгалтерія не бачить витрат картки");
  assert.equal(canSeeTxRow({ ...out, out_editors: [] }, yatsyk, P), false, "🔴 без «людей картки» тімлід побачив витрати робочої картки");
  assert.equal(canSeeTxRow({ ...topUp, account_id: 3, out_private: false, out_editors: [] }, buh, P), true);
  const rules = { ownIbans: new Set<string>(), ownNames: ["беспятчук"] };
  assert.equal(isOwnTransfer(toLite(topUp), rules), true, "🔴 поповнення з ФОП вимагатиме № рахунку");
  assert.equal(isOwnTransfer(toLite(card), rules), false, "🔴 оплата від людини стала «своїм переказом»");
  assert.deepEqual([isFopTopUp("З  гривневого\nрахунку ФОП", null), isFopTopUp(null, "Переказ з гривневого рахунку ФОП"), isFopTopUp("ФОП Іваненко", "оплата")], [true, true, false],
    "🔴 поповнення з ФОП впізнається не так");
  assert.ok(DEFAULT_ACCOUNT_IDS.includes(9) && DEFAULT_ACCOUNT_IDS.includes(11), "🔴 картка Сергія (9) не в правилі «№ рахунку» чи картку Саші (11) прибрано з історії");
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
 * #3930b — ЖИВИЙ SQL: СТРІЧКА Й AI ПРИХОВУЮТЬ ТЕ САМЕ. SQL-фрагмент стрічки (`FOP_TOPUP_LIKE`) знаходить рівно ті рядки, що
 * й `isFopTopUp` (із розірваними пробілами й переносом), AI-вью не віддає поповнень, але віддає оплату від людини; «люди
 * картки» (`out_editors`) зберігаються списком і `= ANY` знаходить саме їх.
 * 🧨 Червоніє, якщо SQL і TS розійдуться, AI побачить поповнення або колонка «людей картки» зникне зі схеми.
 */
test("#3930b ЖИВИЙ SQL: поповнення з ФОП — однаково в SQL стрічки, TS і AI-вью; «люди картки» знаходяться за id", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { FOP_TOPUP_LIKE, isFopTopUp } = await lazy();
  try {
    const acc = (await c.query(`INSERT INTO bank_accounts (company, bank, label, currency, out_private, out_editors) VALUES ('staff', 'mono', 'Картка', 'UAH', true, '{8,22}') RETURNING id`)).rows[0].id;
    const rows: [string, string, string][] = [["in", "З гривневого рахунку ФОП", "З гривневого рахунку ФОП"], ["in", "З  гривневого\nрахунку ФОП", ""],
      ["in", "Buleziuk Vadym", "Від: Buleziuk Vadym"], ["in", "ФОП Іваненко", "оплата за перевезення"], ["in", "Переказ з гривневого рахунку", "картка"], ["out", "АЗС", "Пальне"]];
    for (const [i, [d, n, p]] of rows.entries())
      await c.query(`INSERT INTO bank_transactions (account_id, direction, external_tx_id, booked_at, counterparty_name, purpose, amount, currency, amount_uah)
        VALUES ($1, $2, $3, now(), $4, $5, 100, 'UAH', 100)`, [acc, d, `x${i}`, n, p]);
    const sqlHit = (await c.query(`SELECT t.counterparty_name AS n FROM bank_transactions t WHERE ${FOP_TOPUP_LIKE} ORDER BY t.id`)).rows.map((x: { n: string }) => x.n);
    assert.deepEqual(sqlHit, rows.filter(([, n, p]) => isFopTopUp(n, p)).map(([, n]) => n), "🔴 SQL стрічки й isFopTopUp розійшлись");
    assert.equal(sqlHit.length, 2, "🔴 поповнень знайдено не два — фікстурі нічого перевіряти");
    const ai = (await c.query(`SELECT counterparty_name AS n FROM ai_bank_transactions WHERE account_id = $1 AND direction = 'in' ORDER BY id`, [acc])).rows.map((x: { n: string }) => x.n);
    assert.deepEqual(ai, ["Buleziuk Vadym", "ФОП Іваненко", "Переказ з гривневого рахунку"], "🔴 AI-вью віддає поповнення з ФОП або сховав оплату");
    const who = (await c.query(`SELECT 22 = ANY(out_editors) AS y, 20 = ANY(out_editors) AS n FROM bank_accounts WHERE id = $1`, [acc])).rows[0];
    assert.deepEqual([who.y, who.n], [true, false], "🔴 «люди картки» не знаходяться за id");
  } finally { await s.dispose(); }
});

/**
 * #3930c — ПРОВОДКА МЕЖІ. Стрічка «Виписки» отримує id людини (вхідні й вихідні) і пускає витрати картки лише «людям
 * картки»; «№ рахунку» й розшифровка передають id у `canSeeTxRow`; запис розшифровки на картці з «людьми картки» —
 * 403 усім іншим ДО розбору тексту; стан рядка каже `editable`, і фронт ховає «Розписати», коли не можна; роут кандидатів —
 * у матриці доступу лише для тих, хто керує рахунками.
 * 🧨 Червоніє, якщо стрічка забуде id (і «людина картки» не побачить витрат) чи запис розшифровки відкриється всім тімлідам.
 */
test("#3930c ПРОВОДКА: id людини в стрічці й розшифровці, запис — лише «люди картки», «Розписати» ховається, кандидати в матриці", () => {
  const bank = SRC("routes/bank.ts"), rep = SRC("core/bankReport.ts"), ident = SRC("routes/bankIdent.ts");
  assert.equal((bank.match(/canSeePrivate: roleHasPerm\(req\.auth!\.roleKey, "view_private_finance"\), userId: req\.auth!\.userId \}/g) ?? []).length, 2, "🔴 стрічка не знає, хто дивиться");
  assert.match(rep, /c\.push\(`\(NOT a\.out_private OR \$\$\{params\.length\}::int = ANY\(a\.out_editors\)\)`\)/, "🔴 витрати картки в стрічці — не за «людьми картки»");
  assert.match(rep, /if \(!f\.canSeePrivate && dir === "in"\) c\.push\(`NOT \$\{FOP_TOPUP_LIKE\}`\);/, "🔴 поповнення з ФОП видно в стрічці без права");
  assert.match(ident, /hiddenPayments: roleHasPerm\(String\(u\.role \|\| ""\), "view_hidden_payments"\),\s*userId: u\.id,/, "🔴 «№ рахунку» й розшифровка не знають, хто дивиться");
  assert.match(ident, /if \(!isOutTx\(t\)\) throw new HttpError\(400, OUT_NOT_IN_SCOPE\);\s*if \(!outEditable\(t, req\.user!\.id\)\) throw new HttpError\(403, "[^"]*"\);\s*let lines/,
    "🔴 запис розшифровки картки не обмежено «людьми картки» (або перевірка після розбору тексту)");
  assert.match(FRONT("pages/dashboard/sections/BankSection.tsx"), /canEdit: outCanEdit && outStates\[r\.id\]\.editable !== false/, "🔴 «Розписати» видно тим, хто не може вносити");
  assert.match(SRC("auth/accessMatrix.ts"), /method: "GET", path: "\/api\/bank\/accounts\/editor-candidates", cls: "GET",\s*allow: \["admin", "ceo", "opdir", "kvp", "financier"\], deny: \["hr", "team_lead", "manager"\]/,
    "🔴 роут кандидатів не в матриці");
});

/**
 * #3930d — ВИТРАТИ Й ПОПОВНЕННЯ РОБОЧОЇ КАРТКИ В УСІХ ВИХОДАХ (наступник `#1245`, змінено 13.11.2026). Стрічка й Σ (одна
 * умова): витрати — з правом або «людям картки»; поповнення з ФОП — лише з правом. CSV-вивантаження: без права — ні витрат,
 * ні поповнень. AI-вью: ні витрат, ні поповнень, надходження від людей — так. У зіставлення оплат клієнтів картка не йде.
 * 🧨 Червоніє, якщо витрата чи поповнення проступить без права хоч в одному місці, або надходження зникне.
 */
test("#3930d КАРТКА: надходження — усім, крім поповнень з ФОП; витрати — з правом або «людям картки» (стрічка, CSV, AI); не в зіставленні", async (t) => {
  const rep = SRC("core/bankReport.ts"), st = SRC("core/bankStatement.ts");
  assert.match(rep, /if \(f\.userId != null\) \{ params\.push\(f\.userId\); c\.push\(`\(NOT a\.out_private OR \$\$\{params\.length\}::int = ANY\(a\.out_editors\)\)`\); \}\s*else c\.push\(`NOT a\.out_private`\);/,
    "🔴 стрічка / Σ показують витрати картки без права");
  assert.match(st, /const noOut = a\.out_private && !canSeePrivate \? visible\.filter\(\(x\) => x\.direction !== "out"\) : visible;/, "🔴 CSV віддає витрати картки без права");
  assert.match(st, /const shown = canSeePrivate \? noOut : noOut\.filter\(\(x\) => !\(x\.direction === "in" && isFopTopUp\(x\.counterparty_name, null\)\)\);/, "🔴 CSV віддає поповнення з ФОП без права");
  assert.match(SRC("core/paymentMatch.ts"), /AND NOT a\.finance_only AND a\.company <> 'staff' AND t\.deleted_at IS NULL/, "🔴 картка працівника в зіставленні оплат");
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    const card = (await c.query(`INSERT INTO bank_accounts (company, bank, label, currency, out_private) VALUES ('staff', 'mono', 'Картка · тест', 'UAH', true) RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO bank_transactions (account_id, direction, external_tx_id, booked_at, counterparty_name, amount, currency, fx_rate, amount_uah) VALUES
      ($1, 'in', 'c:in', '2026-10-06T10:00:00Z', 'Поповнення', 3650, 'UAH', 1, 3650), ($1, 'out', 'c:out', '2026-10-06T11:00:00Z', 'АЗС', -400, 'UAH', 1, -400),
      ($1, 'in', 'c:fop', '2026-10-06T12:00:00Z', 'З гривневого рахунку ФОП', 5000, 'UAH', 1, 5000)`, [card]);
    const ai = (await c.query(`SELECT direction, counterparty_name AS n FROM ai_bank_transactions WHERE account_id = $1 ORDER BY direction, n`, [card])).rows.map((r: { direction: string; n: string }) => `${r.direction}:${r.n}`);
    assert.deepEqual(ai, ["in:Поповнення"], "🔴 AI бачить витрати чи поповнення з ФОП, або не бачить надходжень");
    const pm = await import("../core/paymentMatch.js");
    const paid = (await c.query(pm.invoicePaymentsSql(1), [3650])).rows.length;
    assert.equal(paid, 0, "🔴 поповнення робочої картки закрило рахунок клієнта");
  } finally { await s.dispose(); }
});
