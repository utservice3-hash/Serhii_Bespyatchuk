import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { SHARED_PHONE_CAP, clientCallsSql, othersOnPhone } from "./sharedPhoneCalls.js";
import { notCarrierCallSql } from "./carrierPhones.js";

/**
 * 📞 ЗАДАЧА 9061 — розмови на номерах, що є в контактах кількох клієнтів (ТЗ Юлі 16.11.2026, Роман «роби» 18.11).
 * Правило й заміри — `core/sharedPhoneCalls.ts` і `METRICS_GLOSSARY.md` §14c.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * #9061 ЖИВИЙ SQL — від контактів Kommo до розмов клієнта, на одній фікстурі по обидва боки кожної межі:
 * - номер у 2 клієнтів → розмова в обох, і прямо звʼязана розмова в її власника рахується РАЗ і без позначки;
 * - номер у 6 клієнтів (стеля + 1) → розмова нікому не додається, лише прямо звʼязаному;
 * - номер у клієнта й «названиенеуказано» → не спільний (дженерик-ключ не клієнт);
 * - номер перевізника на спільному номері → не розмова;
 * - застарілий рядок таблиці зникає, повторний прохід нічого не переписує;
 * - `ringostat_calls.client_key` після проходу той самий;
 * - «розмова від 10 с» (`leadFactsFor`) і «📞 дзвінків за місяць» (`CALLS_BY_MONTH_SQL`) бачать спільну розмову.
 * 🧨 Червоніє, якщо зняти стелю, прибрати умову «не звʼязаний напряму» (подвійний рахунок), позначити пряму розмову
 *    спільною (позначка в 454 з 612 рядків, приймання 18.11), прибрати виключення
 *    дженерик-ключа, загубити фільтр перевізника, переписати `client_key` або повернути читача на `ringostat_calls`.
 */
test("#9061 ЖИВИЙ SQL: спільний номер — розмова кожному клієнту в межах стелі, раз, без перевізника; client_key не змінено", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    const P2 = "380501110002", P6 = "380501110006", PG = "380501110009", PC = "380987654321";
    // Угоди: по одній на клієнта, контакт = номер угоди. Номер P2 — у «а» і «б»; P6 — у «а» і к2..к6 (6 клієнтів);
    // PG — у «а» і дженерика; PC (перевізник) — у «а» і «б».
    const clients = ["а", "б", "к2", "к3", "к4", "к5", "к6", "названиенеуказано"];
    await c.query(`INSERT INTO deals(kommo_id, client_key, pipeline_id, status_id)
                   SELECT i, ck, 1, 142 FROM unnest($1::text[]) WITH ORDINALITY AS u(ck, i)`, [clients]);
    await c.query(`INSERT INTO deal_contacts(deal_kommo_id, contact_id) SELECT i, i FROM generate_series(1, $1::int) i`, [clients.length]);
    const phones: [number, string][] = [
      [1, P2], [2, P2],
      [1, P6], [3, P6], [4, P6], [5, P6], [6, P6], [7, P6],
      [1, PG], [8, PG],
      [1, PC], [2, PC],
    ];
    for (const [cid, ph] of phones) await c.query(`INSERT INTO contact_phones(contact_id, phone) VALUES ($1, $2)`, [cid, ph]);
    await c.query(`INSERT INTO carrier_phones(p9, via_lardi, via_history) VALUES ('987654321', true, false)`);
    await c.query(`INSERT INTO ringostat_calls(uniqueid, calldate, call_type, billsec, client_key, client_phone) VALUES
      ('u1', '2026-11-10T08:00:00Z', 'out', 60, 'б',  '${P2}'),
      ('u4', '2026-11-05T08:00:00Z', 'out', 30, 'а',  '${P2}'),
      ('u2', '2026-11-11T08:00:00Z', 'out', 60, 'к2', '${P6}'),
      ('u3', '2026-11-12T08:00:00Z', 'out', 60, 'б',  '${PC}'),
      ('u5', '2026-11-13T08:00:00Z', 'out', 60, 'названиенеуказано', '${PG}')`);
    // Застарілий рядок: номер, якого вже немає в жодних контактах.
    await c.query(`INSERT INTO shared_phone_clients(client_key, phone, n) VALUES ('в', '380000000000', 3)`);
    const before = (await c.query<{ k: string }>(`SELECT string_agg(uniqueid || '=' || COALESCE(client_key, '∅'), ',' ORDER BY uniqueid) AS k FROM ringostat_calls`)).rows[0].k;

    const { sharedPhonesSql } = await import("../jobs/callLinkSql.js");
    const sp = sharedPhonesSql();
    const r1 = (await c.query<{ deleted: number; written: number }>(sp.sql, sp.params)).rows[0];
    assert.deepEqual(r1, { deleted: 1, written: 10 }, "🔴 перший прохід: прибрати 1 застарілий, записати 2 (P2) + 6 (P6) + 2 (PC)");
    const rows = (await c.query<{ client_key: string; phone: string; n: number }>(
      `SELECT client_key, phone, n FROM shared_phone_clients ORDER BY phone, client_key`)).rows;
    assert.equal(rows.filter((x) => x.phone === PG).length, 0, "🔴 дженерик-ключ «названиенеуказано» зробив номер спільним");
    assert.deepEqual(rows.filter((x) => x.phone === P2).map((x) => [x.client_key, x.n]), [["а", 2], ["б", 2]]);
    assert.equal(rows.filter((x) => x.phone === P6 && x.n === 6).length, 6, "🔴 номер у 6 клієнтів не порахований як 6");
    const r2 = (await c.query<{ deleted: number; written: number }>(sp.sql, sp.params)).rows[0];
    assert.deepEqual(r2, { deleted: 0, written: 0 }, "🔴 повторний прохід переписує незмінені рядки");
    const after = (await c.query<{ k: string }>(`SELECT string_agg(uniqueid || '=' || COALESCE(client_key, '∅'), ',' ORDER BY uniqueid) AS k FROM ringostat_calls`)).rows[0].k;
    assert.equal(after, before, "🔴 крок спільних номерів переписав ringostat_calls.client_key");

    const talks = (await c.query<{ ck: string; uniqueid: string; shared_n: number }>(
      `SELECT rc.ck, rc.uniqueid, rc.shared_n FROM ${clientCallsSql("= ANY($1)")} rc
        WHERE rc.billsec > 0 AND ${notCarrierCallSql("rc")} ORDER BY rc.ck, rc.uniqueid`, [["а", "б", "к2"]])).rows;
    const of = (k: string) => talks.filter((x) => x.ck === k).map((x) => `${x.uniqueid}:${String(x.shared_n)}`);
    // shared_n > 1 — лише в розмови, що прийшла ЧЕРЕЗ спільний номер; пряма — 1, навіть на спільному номері.
    assert.deepEqual(of("а"), ["u1:2", "u4:1"],
      "🔴 «а»: має бачити розмову на P2 від «б» (u1, через спільний номер) і свою пряму (u4) РАЗ і без позначки; не бачити P6, перевізника й дженерика");
    assert.deepEqual(of("б"), ["u1:1", "u4:2"], "🔴 «б»: розмова «а» на спільному P2 не дійшла або пряма позначена спільною");
    assert.deepEqual(of("к2"), ["u2:1"], "🔴 прямо звʼязана розмова на номері поза стелею зникла або позначена спільною");

    const { leadFactsFor } = await import("./clientLeadFacts.js");
    const f = await leadFactsFor(c, ["а"], 100000);
    assert.equal(f.get("а")?.talk10, "2026-11-10", "🔴 «розмова від 10 с» не бачить розмови на спільному номері");
    const { CALLS_BY_MONTH_SQL } = await import("./clientCalls.js");
    const m = (await c.query<{ client_key: string; calls: number; talks: number }>(CALLS_BY_MONTH_SQL, [["а"], "2026-11"])).rows;
    assert.deepEqual(m.map((x) => [x.client_key, x.calls, x.talks]), [["а", 2, 2]],
      "🔴 «📞 дзвінків за місяць»: має бути 2 (u1 спільний + u4 прямий), без перевізника й номера поза стелею");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #9061b — «ЩЕ N» І СТЕЛЯ: N = скільки ІНШИХ клієнтів має номер (без самого клієнта); номер не спільний → 0.
 * Стеля — 5 (вибір за заміром 18.11, Роман може змінити), і SQL бере саме її.
 * 🧨 Червоніє, якщо рахувати разом із клієнтом, показувати «ще 0» на неспільному номері або стеля в SQL
 *    розійдеться з константою.
 */
test("#9061b «ЩЕ N»: інші клієнти номера без самого клієнта; стеля 5 і SQL бере саме її", () => {
  assert.equal(othersOnPhone(2), 1, "🔴 номер у 2 клієнтів дає не «ще 1»");
  assert.equal(othersOnPhone(5), 4);
  assert.equal(othersOnPhone(1), 0, "🔴 неспільний номер позначено спільним");
  assert.equal(othersOnPhone(null), 0);
  assert.equal(othersOnPhone(undefined), 0);
  assert.equal(SHARED_PHONE_CAP, 5, "🔴 стелю змінено без рішення (заміри — у core/sharedPhoneCalls.ts)");
  assert.match(clientCallsSql("= $1"), /spc\.n <= 5\b/, "🔴 SQL не обмежує спільний номер стелею");
  assert.match(clientCallsSql("= $1"), /rc\.client_key IS DISTINCT FROM spc\.client_key/, "🔴 пряма розмова рахуватиметься двічі");
});

/**
 * #9061c ПРОВОДКА: «З ким говорити» / «Реактивація» (остання розмова і спроби), «розмова від 10 с», «📞 дзвінків за
 * місяць» читають дзвінки через `clientCallsSql`; таблицю будує лише ПОВНИЙ прохід `linkCalls`; рядок `/client-plans`
 * несе «ще N», і екран його показує.
 * 🧨 Червоніє, якщо будь-який із читачів повернеться на `FROM ringostat_calls rc`, крок піде в пʼятихвилинний синк
 *    або позначка загубиться між ядром і екраном.
 */
test("#9061c ПРОВОДКА: читачі через clientCallsSql; таблиця — у повному проході; «ще N» доходить до екрана", () => {
  const react = codeOnly(read("backend/src/core/reactivation.ts"));
  const lt = react.slice(react.indexOf("LEFT JOIN LATERAL (\n         SELECT rc.calldate"), react.indexOf(") lt ON true"));
  assert.match(lt, /FROM \$\{clientCallsSql\("= a\.client_key"\)\} rc\b/, "🔴 «остання розмова» не бачить спільних номерів");
  const at = react.slice(react.indexOf(") lt ON true"), react.indexOf(") at ON true"));
  assert.match(at, /FROM \$\{clientCallsSql\("= a\.client_key"\)\} rc\b/, "🔴 «спроби» не бачать спільних номерів");
  assert.match(react, /lastTalkSharedWith: othersOnPhone\(r\.last_talk_shared_n\)/);
  const facts = codeOnly(read("backend/src/core/clientLeadFacts.ts"));
  assert.equal((facts.match(/FROM \$\{clientCallsSql\("= ANY\(\$1\)"\)\} rc\b/g) ?? []).length, 2, "🔴 розмова від 10 с або суть — не через clientCallsSql");
  assert.doesNotMatch(facts, /FROM ringostat_calls\b/, "🔴 clientLeadFacts знову читає ringostat_calls напряму");
  const calls = codeOnly(read("backend/src/core/clientCalls.ts"));
  assert.match(calls, /FROM \$\{clientCallsSql\("= ANY\(\$1\)"\)\} rc\b/, "🔴 «дзвінків за місяць» не бачить спільних номерів");
  const sync = codeOnly(read("backend/src/jobs/syncCalls.ts"));
  assert.match(sync, /if \(!since\) \{\s*const sp = sharedPhonesSql\(\);/, "🔴 таблиця спільних номерів будується не лише в повному проході");
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  assert.match(dash, /lastTalkSharedWith: reactByKey\.get\(c\.client_key\)\?\.lastTalkSharedWith \?\? 0,/, "🔴 рядок /client-plans не несе «ще N»");
  const fe = codeOnly(read("frontend/src/pages/dashboard/sections/ClientLeadSection.tsx"));
  assert.match(fe, /c\.lastTalk && \(c\.lastTalkSharedWith \?\? 0\) > 0 &&/, "🔴 позначка «спільний номер» не показується");
  assert.match(fe, /спільний номер · ще \{sharedLabel\(c\.lastTalkSharedWith \?\? 0\)\}/);
});
