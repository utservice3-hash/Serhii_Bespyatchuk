import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #1900b — ЖИВИЙ SQL «ЧИМ ПІДТВЕРДЖЕНО РОБОТУ» (задача 6455) на схемі з нуля, по обидва боки кожної межі.
 * Угода: увійшла в етап «від рахунку» за період — так; стала «Успішною» за період — так; зараз у роботі після рахунку
 * (вхід ДО періоду) — так (Роман 23.10); лише «Пропозицію зроблено» — ні (кейс Антонюка, правило лишається); програна —
 * ні; Успішна поза періодом — ні; не повний цикл — ні.
 * Оплата: код платника = ЄДРПОУ компанії клієнта — так (і з ведучими нулями); чужий код — ні; Сейф («лише фінанси») — ні;
 * старіша за період — ні; банківська комісія — ні.
 * ⚠️ На ПРОД-сервері бінарів PostgreSQL немає → `skip` через `skipReason()` і `ALLOWED_PROD_SKIPS`.
 * 🧨 Червоніє, якщо прибрати умову періоду, відкриті етапи, виключення програних або добір платежів звірки оплат.
 */
test("#1900b ЖИВИЙ SQL ДОКАЗІВ РОБОТИ: угода від рахунку (у періоді або в роботі), оплата за кодом компанії; межі з обох боків", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  // `money.js` тягне `db/pool.js` → конфіг вимагає змінних на імпорті (як у `#717`); пул тут не використовується — передаємо клієнт.
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    const { invoiceProofByClientKey, paymentProofByClientKey } = await import("./clientWorkProof.js");
    const db = c as unknown as import("./baClaims.js").Db;
    const deal = (id: number, ck: string, pipe: number, st: number, closed: string | null = null) =>
      c.query(`INSERT INTO deals (kommo_id, client_key, pipeline_id, status_id, closed_at_kommo) VALUES ($1,$2,$3,$4,$5)`, [id, ck, pipe, st, closed]);
    const ev = (id: number, st: number, at: string) =>
      c.query(`INSERT INTO deal_stage_events (kommo_id, status_id, pipeline_id, changed_at) VALUES ($1,$2,8921932,$3)`, [id, st, at]);
    // Період 23.09–23.10.2026.
    await deal(1, "ввійшла", 8921932, 69716300); await ev(1, 100274340, "2026-10-05 10:00+03");          // так: рахунок у періоді
    await deal(2, "успішна", 8921932, 142, "2026-10-20 12:00+03"); await ev(2, 142, "2026-10-20 12:00+03"); // так: 142 у періоді
    await deal(3, "вроботі", 8921932, 69716312); await ev(3, 69716312, "2026-08-01 10:00+03");          // так: вхід до періоду, але в роботі
    await deal(4, "пропозиція", 8921932, 69693672);                                                       // ні: до рахунку (Антонюк)
    await deal(5, "програна", 8921932, 143); await ev(5, 100274340, "2026-10-05 10:00+03");             // ні: програна
    await deal(6, "стара", 8921932, 142, "2026-08-10 12:00+03"); await ev(6, 142, "2026-08-10 12:00+03"); // ні: 142 поза періодом
    await deal(7, "продзвін", 8921936, 142, "2026-10-10 12:00+03");                                      // ні: не повний цикл
    await deal(8, "межа", 8921932, 142, "2026-09-23 00:10+03"); await ev(8, 142, "2026-09-23 00:10+03"); // так: перший день періоду за Києвом
    await deal(9, "замежею", 8921932, 142, "2026-09-22 23:50+03"); await ev(9, 142, "2026-09-22 23:50+03"); // ні: день до періоду
    const keys = ["ввійшла", "успішна", "вроботі", "пропозиція", "програна", "стара", "продзвін", "межа", "замежею"];
    const inv = await invoiceProofByClientKey(db, keys, "2026-09-23", "2026-10-23");
    assert.deepEqual([...inv.keys()].sort(), ["вроботі", "ввійшла", "межа", "успішна"].sort(),
      "🔴 доказ угодою не збігся з правилом (період, відкриті етапи, програні, повний цикл, межа за Києвом)");
    assert.deepEqual(inv.get("вроботі"), { kommoId: 3, stage: "Очікуємо оплату", at: null, open: true },
      "🔴 угода в роботі після рахунку — без назви етапу або не позначена «в роботі»");
    assert.equal(inv.get("ввійшла")?.at, "2026-10-05");
    assert.equal(inv.get("успішна")?.open, false);

    // Оплати: свій рахунок і Сейф.
    await c.query(`INSERT INTO bank_accounts (id, company, bank, label) VALUES (901, 'uts', 'privat', 'ЮТС тест')`);
    await c.query(`INSERT INTO bank_accounts (id, company, bank, label, finance_only) VALUES (902, 'uts', 'privat', 'Сейф тест', true)`);
    await c.query(`INSERT INTO kommo_companies (company_id, name, edrpou) VALUES (71, 'ТОВ Клієнт', '01234567'), (72, 'ТОВ Інший', '99999999')`);
    await deal(20, "платник", 8921932, 69693672); await c.query(`INSERT INTO deal_companies (deal_kommo_id, company_id) VALUES (20, 71)`);
    await deal(21, "мовчун", 8921932, 69693672); await c.query(`INSERT INTO deal_companies (deal_kommo_id, company_id) VALUES (21, 72)`);
    let n = 0;
    const pay = (acc: number, code: string, daysAgo: number, amount: number, fee = false) =>
      c.query(`INSERT INTO bank_transactions (account_id, direction, external_tx_id, booked_at, amount, is_bank_fee, raw_json)
               VALUES ($1, 'in', $2, now() - ($3 || ' days')::interval, $4, $5, $6)`, [acc, `t${String(++n)}`, String(daysAgo), amount, fee, JSON.stringify({ AUT_CNTR_CRF: code })]);
    await pay(901, "1234567", 3, 5000);        // так: той самий код без ведучого нуля
    await pay(901, "1234567", 1, 100, true);   // ні: банківська комісія
    await pay(902, "99999999", 2, 7000);       // ні: Сейф
    await pay(901, "99999999", 40, 8000);      // ні: старіша за 30 днів
    await pay(901, "55555555", 2, 9000);       // ні: чужий код
    const p = await paymentProofByClientKey(db, ["платник", "мовчун"], 30);
    assert.deepEqual([...p.keys()], ["платник"], "🔴 оплату приписано не тому клієнту (Сейф, комісія, старий платіж чи чужий код)");
    assert.equal(p.get("платник")?.amount, 5000, "🔴 доказ — комісія замість оплати");
    assert.equal((await paymentProofByClientKey(db, ["мовчун"], 45)).get("мовчун")?.amount, 8000, "🔴 довший період не бачить старішого платежу");
  } finally { await c.end(); scratch.dispose(); }
});
