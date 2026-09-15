import { test } from "node:test";
import assert from "node:assert/strict";
import { needsBackendEnv } from "../testMode.js";
import { PAYMENT_REQUEST_PIPELINE, PAYMENT_REQUEST_STATUSES, paymentRequestsSql, requestStatusOf, summarize, toPaymentRequestRows } from "./paymentRequests.js";
import { carrierNameFrom } from "./carrierPayment.js";

/**
 * #401 — РЕЄСТР БЕРЕ ЗАЯВКИ ПО ВОРОНЦІ, А НЕ ПО НАЗВІ; скоуп стоїть ПІСЛЯ фільтра воронки;
 * невідомий етап НАЗИВАЄ СЕБЕ числом, а не ховається під «інше». Червоніє, якщо прибрати
 * фільтр `pipeline_id`, поставити `cond` перед ним або віддати невідомому етапу чужий kind.
 */
test("#401 РЕЄСТР ЗАЯВОК: фільтр по воронці 7341740, скоуп після нього, невідомий етап названий", () => {
  const sql = paymentRequestsSql("AND m.id = $3");
  assert.match(sql, /d\.pipeline_id = 7341740\b/, "реєстр не фільтрує по воронці «Оплата перевозчикам»");
  assert.ok(sql.indexOf("pipeline_id") < sql.indexOf("AND m.id = $3"), "скоуп стоїть перед фільтром воронки");
  // 🧑 «Хто подав» — менеджер ВИХІДНОЇ угоди, не відповідальний за Автосделку (бухгалтерія).
  assert.match(sql, /LEFT JOIN deals src ON src\.kommo_id = d\.source_deal_id/, "менеджер береться не з вихідної угоди");
  assert.doesNotMatch(sql, /m\.id = d\.manager_id/, "скоуп знову по відповідальному за Автосделку — менеджери побачать порожньо");
  assert.match(sql, /AT TIME ZONE 'Europe\/Kyiv'\)::date BETWEEN \$1 AND \$2/, "період не за Києвом або не включно");
  assert.equal(PAYMENT_REQUEST_PIPELINE, 7341740);
  assert.equal(requestStatusOf(142).kind, "paid");
  assert.equal(requestStatusOf(143).kind, "rejected");
  assert.deepEqual(requestStatusOf(999), { label: "етап #999", kind: "unknown" });
  // 🪞 Назва перевізника: перше непорожнє з двох полів, у порядку «Назва» → «Компания».
  assert.equal(carrierNameFrom("  ", "ФОП Лупина"), "ФОП Лупина");
  assert.equal(carrierNameFrom("ТОВ Альфа", "ФОП Лупина"), "ТОВ Альфа");
  assert.equal(carrierNameFrom(null, ""), null);
});

/**
 * #401b — ПІДСУМОК рахує кожен стан, порожній стан — нуль (а не відсутність ключа),
 * сума без amount не ламає Σ. Червоніє, якщо загубити стан або рахувати null як NaN.
 */
test("#401b РЕЄСТР ЗАЯВОК: підсумок по станах, порожній стан = 0, null-сума не ламає Σ", () => {
  const rows = toPaymentRequestRows([
    { kommo_id: 1, name: "a", submitted_on: "2026-09-01", client_key: "k", client_name: "K", carrier_name: "ФОП", carrier_edrpou: null, carrier_pay_type: "ФОП", carrier_pay_amount: "1000", status_id: 60434924, source_deal_id: "77", manager_id: 1, manager_name: "М", team_id: 1 },
    { kommo_id: 2, name: "b", submitted_on: "2026-09-02", client_key: "k", client_name: "K", carrier_name: null, carrier_edrpou: null, carrier_pay_type: "ТОВ", carrier_pay_amount: null, status_id: 142, source_deal_id: null, manager_id: 1, manager_name: "М", team_id: 1 },
    { kommo_id: 3, name: "c", submitted_on: "2026-09-03", client_key: null, client_name: null, carrier_name: "ТОВ", carrier_edrpou: "123", carrier_pay_type: "ТОВ", carrier_pay_amount: 2500, status_id: 142, source_deal_id: 78, manager_id: 2, manager_name: "Н", team_id: 1 },
  ], "https://x.kommo.com/");
  assert.equal(rows[0].crmUrl, "https://x.kommo.com/leads/detail/1");
  assert.equal(rows[0].sourceDealId, 77); assert.equal(rows[1].sourceDealId, null);
  const s = summarize(rows);
  assert.deepEqual(s.pending, { n: 1, amount: 1000 });
  assert.deepEqual(s.paid, { n: 2, amount: 2500 });
  assert.deepEqual(s.rejected, { n: 0, amount: 0 });
  assert.deepEqual(s.unknown, { n: 0, amount: 0 });
  assert.equal(Object.keys(PAYMENT_REQUEST_STATUSES).length, 6);
});

/**
 * #401c ЖИВИЙ — ЕТАПИ ВОРОНКИ В KOMMO == СЛОВНИК РЕЄСТРУ, поіменно. Новий етап у CRM без
 * рядка тут показувався б як «етап #N» — гейт вимагає, щоб це сталося свідомо.
 * 🪞 І дзеркало: Σ сум реєстру за останні 30 днів == прямому SUM по базі за той самий
 * фільтр, одним викликом (правило 18: інваріант, не «було N — стало N-5»).
 */
test("#401c ЖИВИЙ: етапи воронки 7341740 == словнику; Σ реєстру == SUM по базі", { ...needsBackendEnv() }, async () => {
  const { kommoRequest } = await import("../kommo/client.js");
  const { pool } = await import("../db/pool.js");
  const pipe = await kommoRequest<{ _embedded?: { statuses?: { id: number; name: string }[] } }>(`/api/v4/leads/pipelines/${PAYMENT_REQUEST_PIPELINE}`);
  const live = (pipe._embedded?.statuses ?? []).map((s) => s.id).sort();
  assert.ok(live.length > 0, "Kommo не віддав етапів — перевірці нема що знаходити");
  assert.deepEqual(live, Object.keys(PAYMENT_REQUEST_STATUSES).map(Number).sort(), "етапи воронки в Kommo розійшлися зі словником реєстру");
  const to = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const from = new Date(Date.now() - 30 * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const r = await pool.query(paymentRequestsSql(""), [from, to]);
  const rows = toPaymentRequestRows(r.rows, "https://x");
  const direct = await pool.query<{ s: string | null; n: string }>(
    `SELECT sum(carrier_pay_amount) AS s, count(*) AS n FROM deals d
      WHERE d.pipeline_id = $3 AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1 AND $2`, [from, to, PAYMENT_REQUEST_PIPELINE]);
  const sum = Object.values(summarize(rows)).reduce((a, x) => a + x.amount, 0);
  assert.equal(rows.length, Number(direct.rows[0].n));
  assert.ok(Math.abs(sum - Number(direct.rows[0].s ?? 0)) < 0.01, `Σ реєстру ${sum} ≠ SUM бази ${direct.rows[0].s}`);
});
