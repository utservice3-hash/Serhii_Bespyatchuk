// Правки зустрічі 17.11.2026, пункт «Пропущені»: замір ЛИШЕ ЧИТАННЯМ (BEGIN READ ONLY … ROLLBACK). Kommo не чіпає.
// Запуск — у локальній сесії Романа на сервері (стенд або прод-чекаут ПІСЛЯ збірки цієї гілки чи main — потрібен dist):
//   cd <repo>/backend && nice -n 20 node /tmp/m-missed-1711.mjs
// Секретів не друкує: лише кількості, дати, id угод і задач. Номер — той, що названо на зустрічі.
//
// Що міряє (і навіщо — `plan-fixes-1711.md`, прохід 4):
//   A. +380676766044: чому «не фільтрується» — скільки вхідних, скільки з них пропущені за правилом екрана,
//      чи є в CRM історія перевізника (core/carrierHistory), чи стоїть пропуск задачі, чи є відкриті задачі «Передзвонити».
//   B. 7 днів: скільки пропущених на екрані «Пропущені» (core/missedCallsRules, та сама основа) і скільки з них
//      ① уже мають передзвін ≥10 с, ② від номерів, які ядро вважає перевізниками за історією CRM,
//      ③ від номерів, по яких задачу не ставили як перевізнику (missed_call_skips). Саме ці частини зустріч хоче «прибрати».
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const { Client } = require("pg");
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^(DATABASE_URL)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
process.env.JWT_SECRET ??= "unused"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
const rules = await import(process.cwd() + "/dist/core/missedCallsRules.js");
const ch = await import(process.cwd() + "/dist/core/carrierHistory.js");

const PHONE = "380676766044";
const show = (title, rows) => { console.log(`\n── ${title} (${rows.length})`); for (const r of rows) console.log("  " + Object.values(r).map((v) => (v instanceof Date ? v.toISOString().slice(0, 16) : v)).join(" | ")); };
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query("BEGIN READ ONLY");
try {
  const today = (await c.query("SELECT (now() AT TIME ZONE 'Europe/Kyiv')::date::text AS d")).rows[0].d;
  const from30 = (await c.query("SELECT ((now() AT TIME ZONE 'Europe/Kyiv')::date - 30)::text AS d")).rows[0].d;
  const from7 = (await c.query("SELECT ((now() AT TIME ZONE 'Europe/Kyiv')::date - 7)::text AS d")).rows[0].d;
  console.log("сьогодні (Київ):", today, "· 30 днів з", from30, "· 7 днів з", from7);

  // ── A. Номер із зустрічі
  // Перевірка існування предмета ДО чисел (правило 15): у якому форматі номер лежить у таблиці дзвінків.
  show("A0 формати номера в ringostat_calls (за весь час)", (await c.query(
    `SELECT client_phone, COUNT(*)::int AS calls, MIN(calldate) AS first, MAX(calldate) AS last
       FROM ringostat_calls WHERE regexp_replace(COALESCE(client_phone, ''), '\\D', '', 'g') LIKE '%676766044' GROUP BY 1`)).rows);
  show("A1 дзвінки номера за 30 днів: тип · результат · з розмовою", (await c.query(
    `SELECT call_type, disposition, (billsec > 0) AS talked, COUNT(*)::int AS n
       FROM ringostat_calls WHERE client_phone = $1 AND (calldate AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
      GROUP BY 1, 2, 3 ORDER BY 4 DESC`, [PHONE, from30])).rows);
  const base30 = rules.missedBaseCte(from30, today, {});
  show("A2 пропущені номера на екрані за 30 днів (та сама основа, що екран) · передзвін", (await c.query(
    `${base30.cte} SELECT calldate, manager_id, bucket, cb_at, cb_billsec FROM withNext WHERE client_phone = $${base30.params.length + 1} ORDER BY calldate`,
    [...base30.params, PHONE])).rows);
  show("A3 історія перевізника в CRM (угода «Перевізник», якщо ядро так вважає; NULL — ні)", (await c.query(
    `SELECT ${ch.carrierHistorySql("$1")} AS carrier_deal`, [PHONE])).rows);
  show("A4 угоди номера (назва або телефон контакту): воронка · статус · причина відмови", (await c.query(
    `SELECT d.kommo_id, d.pipeline_id, d.status_id, d.reject_reason, d.created_at_kommo
       FROM deals d WHERE regexp_replace(d.name, '\\D', '', 'g') = $1
     UNION
     SELECT d.kommo_id, d.pipeline_id, d.status_id, d.reject_reason, d.created_at_kommo
       FROM contact_phones cp JOIN deal_contacts dc ON dc.contact_id = cp.contact_id JOIN deals d ON d.kommo_id = dc.deal_kommo_id
      WHERE cp.phone = $1 ORDER BY 5 DESC LIMIT 20`, [PHONE])).rows);
  show("A5 пропуск задачі як перевізнику (missed_call_skips)", (await c.query(
    `SELECT kday, manager_id, reason, carrier_deal FROM missed_call_skips WHERE client_phone = $1 ORDER BY kday DESC LIMIT 20`, [PHONE])).rows);
  show("A6 задачі «Передзвонити» по номеру", (await c.query(
    `SELECT id, status, assignee_id, created_at FROM tasks WHERE title LIKE '%676766044%' ORDER BY created_at DESC LIMIT 20`)).rows);

  // ── B. 7 днів: яку частину пропущених зустріч хоче прибрати
  const b7 = rules.missedBaseCte(from7, today, {});
  show("B1 пропущені на екрані за 7 днів: усього · уже передзвонили ≥10 с · перевізник за історією CRM · пропуск задачі як перевізнику · без відповідального", (await c.query(
    `${b7.cte}, x AS (
       SELECT w.*, ${ch.carrierHistorySql("w.client_phone", "NULL::bigint", "h_")} AS carrier_deal,
              EXISTS (SELECT 1 FROM missed_call_skips s WHERE s.client_phone = w.client_phone
                         AND s.kday = (w.calldate AT TIME ZONE 'Europe/Kyiv')::date) AS skipped
         FROM withNext w)
     SELECT COUNT(*)::int AS missed,
            COUNT(*) FILTER (WHERE cb_at IS NOT NULL)::int AS called_back,
            COUNT(*) FILTER (WHERE carrier_deal IS NOT NULL)::int AS carrier_history,
            COUNT(*) FILTER (WHERE skipped)::int AS task_skipped_carrier,
            COUNT(*) FILTER (WHERE cb_at IS NULL AND carrier_deal IS NULL)::int AS left_if_both_removed,
            COUNT(*) FILTER (WHERE manager_id IS NULL)::int AS ownerless
       FROM x`, b7.params)).rows);
} finally {
  await c.query("ROLLBACK");
  await c.end();
}
