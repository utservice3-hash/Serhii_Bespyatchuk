import { test } from "node:test";
import assert from "node:assert/strict";
import { skipReason, type Unavailable } from "../db/scratchDb.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dedupeDealContactPairs, dedupeById, type DealContactPair } from "./dealContactPairs.js";

/**
 * #24 — ІНЦИДЕНТ 03.08.2026: syncKommo ліг на «ON CONFLICT DO UPDATE command cannot
 * affect row a second time». Тест відтворює РІВНО той вхід, що клав прод.
 */

test("#24 БАТЧ ІЗ ДУБЛЕМ ПАРИ: вставляється ОДИН раз, без винятку", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    // Той самий SQL, що виконує upsertDealContacts.
    const SQL = `INSERT INTO deal_contacts (deal_kommo_id, contact_id, is_main, updated_at)
       SELECT * FROM (SELECT UNNEST($1::bigint[]) AS d, UNNEST($2::bigint[]) AS c,
                             UNNEST($3::boolean[]) AS m, now() AS u) v
       ON CONFLICT (deal_kommo_id, contact_id)
       DO UPDATE SET is_main = EXCLUDED.is_main, updated_at = now()`;

    // ── САБОТАЖ: БЕЗ дедупу той самий вхід МУСИТЬ впасти. Без цієї половини
    // тест зеленів би й тоді, коли Postgres узагалі не проти дублікатів.
    await assert.rejects(
      () => c.query(SQL, [[11, 11], [77, 77], [true, false]]),
      /affect row a second time/,
      "🔴 Postgres прийняв дубль — тоді фікс нічого не рятує, і тест доводить порожнечу");

    // ── З дедупом — проходить, і лишається РІВНО один рядок.
    const raw: DealContactPair[] = [
      { dealId: 11, contactId: 77, isMain: true },
      { dealId: 11, contactId: 77, isMain: false },   // дубль пари
      { dealId: 12, contactId: 77, isMain: true },
    ];
    const ded = dedupeDealContactPairs(raw);
    assert.equal(ded.length, 2, "дедуп мав лишити дві РІЗНІ пари");
    await c.query(SQL, [ded.map((p) => p.dealId), ded.map((p) => p.contactId), ded.map((p) => p.isMain)]);
    const rows = (await c.query<{ n: string; m: boolean }>(
      `SELECT COUNT(*) n, bool_or(is_main) m FROM deal_contacts WHERE deal_kommo_id = 11`)).rows[0];
    assert.equal(Number(rows.n), 1, "пара має бути вставлена рівно один раз");
    assert.equal(rows.m, false,
      "🔴 переміг ПЕРШИЙ запис. Останній = свіжіша сторінка, тож саме його is_main має лягти");

    // ── ІДЕМПОТЕНТНІСТЬ: повторний прогін оновлює, а не падає.
    await c.query(SQL, [[11], [77], [true]]);
    assert.equal(Number((await c.query(`SELECT COUNT(*) n FROM deal_contacts WHERE deal_kommo_id=11`)).rows[0].n), 1);
  } finally {
    await c.end();
    scratch.dispose();
  }
});

test("#24b ДЕДУП УГОД у пагінації — причина, а не наслідок", () => {
  // 🔴 Дублікат створювала НЕ Kommo, а наш код: сторінки тягнуться паралельно, і
  // угода, оновлена між запитами, потрапляє у дві сторінки. Замір це підтвердив:
  // дублів контакта ВСЕРЕДИНІ угоди — 0 із 748.
  const pages = [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 1, name: "a (свіжіша сторінка)" }];
  const out = dedupeById(pages);
  assert.equal(out.length, 2, "угода, що прийшла двічі, має лишитись одна");
  assert.equal(out.find((x) => x.id === 1)?.name, "a (свіжіша сторінка)",
    "🔴 переміг перший знімок — тоді свіжіші дані з пізнішої сторінки губились би");
});

test("#24c ДЗЕРКАЛО: дедуп НЕ склеює різні пари й різні угоди", () => {
  // Без дзеркала «фікс» міг би звестись до «лишаємо один рядок на угоду» — і
  // угода з двома РІЗНИМИ контактами тихо втратила б один звʼязок.
  const ded = dedupeDealContactPairs([
    { dealId: 11, contactId: 77, isMain: true },
    { dealId: 11, contactId: 88, isMain: false },
    { dealId: 12, contactId: 77, isMain: false },
  ]);
  assert.equal(ded.length, 3, "🔴 злиплись різні пари — це втрата звʼязків, а не дедуп");
  assert.equal(dedupeById([{ id: 1 }, { id: 2 }, { id: 3 }]).length, 3);
});

test("#24d КОД СПРАВДІ ЙОГО КЛИЧЕ — а не «фікс лежить поруч»", () => {
  // Двічі траплялось, що правка тихо не застосувалась, а звіт казав «зроблено».
  const roots = [path.join(import.meta.dirname, ".."), path.join(import.meta.dirname, "..", "..", "src")];
  const read = (rel: string): string => {
    for (const r of roots) { try { return readFileSync(path.join(r, rel), "utf8"); } catch { /* далі */ } }
    assert.fail(`не знайдено ${rel} — перевірка не має права мовчки пропускатись`);
  };
  assert.match(read("jobs/syncKommo.ts"), /dedupeDealContactPairs\(/,
    "🔴 upsertDealContacts не викликає дедуп — інцидент повториться");
  assert.match(read("kommo/client.ts"), /return dedupeById\(deals\)/,
    "🔴 fetchAllDeals не дедупить угоди — причина лишилась");
});
