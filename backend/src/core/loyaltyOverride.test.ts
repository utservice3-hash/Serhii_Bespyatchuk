import { test } from "node:test";
import assert from "node:assert/strict";
import { skipReason, type Unavailable } from "../db/scratchDb.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildOverrideUpsert } from "./loyaltyOverride.js";

/**
 * #32 — «ПРИБРАТИ З ПОСТІЙНИХ» НЕ МАЄ ЗНІМАТИ ВІДПОВІДАЛЬНОГО.
 *
 * 🔴 ЧОМУ ЦЕ ВЗАГАЛІ ТЕСТ. Дія повертається в картку клієнта, і її тіло —
 * `{clientKey, hidden}`, без решти полів. Стара версія роута писала відсутні
 * поля як `NULL`, тобто одним кліком «прибрати» знімала б `pinned_manager_id` —
 * закріпленого менеджера, який 04.08.2026 оголошено ЄДИНИМ джерелом для трьох
 * екранів. Помітити це на екрані було б неможливо: `COALESCE(закріплений,
 * основний)` мовчки віддала б другу гілку, і виглядало б як «так і було».
 *
 * 🔴 ЧОМУ ПРОТИ БАЗИ, А НЕ ПО ПАРАМЕТРАХ. Перевіряти масив `params` означало б
 * переписати в тесті ту саму логіку й порівняти її саму з собою. Правило живе в
 * `CASE WHEN $8` усередині SQL — тож виконуємо справжній запит.
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

test("#32 UPSERT оверрайду: передані поля — пишуться, НЕпередані — лишаються", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'Менеджер А',1,true) ON CONFLICT DO NOTHING`);

    const run = async (body: Record<string, unknown>) => {
      const q = buildOverrideUpsert(body, null);
      await c.query(q.sql, q.params);
      return (await c.query<{ hidden: boolean; pinned_manager_id: number | null; note: string | null; force_regular: boolean }>(
        `SELECT hidden, pinned_manager_id, note, force_regular FROM loyalty_overrides WHERE client_key = 'к'`)).rows[0];
    };

    // (1) Закріплюємо менеджера — як це робить форма передачі відповідального.
    let row = await run({ clientKey: "к", pinnedManagerId: 10, note: "передано КВП" });
    assert.equal(row.pinned_manager_id, 10, "закріплення не записалось — далі перевіряти нічого");
    assert.equal(row.note, "передано КВП");

    // (2) І ТЕПЕР — інша дія тим самим апсертом (сезонність), щоб перевірити те саме
    // правило «непередані поля лишаються».
    // ⚠️ `hidden` тут БІЛЬШЕ НЕМАЄ: прибирання клієнта переїхало в окрему дію
    // `/client-archive` (дата + причина + хто), а запис `hidden` прибрано, щоб не
    // лишити ТИХИЙ NO-OP — поле писалось би, а жоден запит його вже не читає.
    // Саме прибирання й повернення перевіряє гейт #38.
    // ⚠️ ПРИМІТКА ЇДЕ РАЗОМ ІЗ ПРАПОРЦЕМ — І ЦЕ НЕ ПРИКРАСА ТЕСТУ.
    // `INSERT … ON CONFLICT` — це СПЕКУЛЯТИВНА вставка: Postgres перевіряє
    // CHECK на ЗАПРОПОНОВАНОМУ рядку (EXCLUDED) ДО того, як побачить конфлікт і
    // змерджить його з наявним. Тому `force_regular = true` без `note` падає
    // навіть тоді, коли примітка вже лежить у рядку й нікуди не дінеться.
    // Це не обхід правила «примітка обовʼязкова», а рівно воно: доводить його
    // #40 (`assert.rejects` на прапорець без примітки).
    row = await run({ clientKey: "к", forceRegular: true, note: "домовленість власника" });
    assert.equal(row.force_regular, true, "🔴 передане поле не записалось");
    assert.equal(row.pinned_manager_id, 10,
      "🔴 РЕГРЕС: апсерт ЗНЯВ закріпленого менеджера — саме та тиха втрата, "
      + "заради якої правило й існує");
    assert.equal(row.note, "домовленість власника", "🔴 передана примітка не записалась");

    // (3) ДЗЕРКАЛО №1: зняти назад — теж лише одним полем.
    row = await run({ clientKey: "к", forceRegular: false });
    assert.equal(row.force_regular, false, "🔴 зняття не спрацювало — дія не зворотна");
    assert.equal(row.pinned_manager_id, 10, "🔴 зняття прибрало закріплення");

    // (4) ДЗЕРКАЛО №2 — без нього тест зеленів би й тоді, якби поле стало
    // НЕЗМІННИМ узагалі: явний null мусить ЗНІМАТИ закріплення, інакше ми
    // полагодили б одну діру, викопавши другу.
    row = await run({ clientKey: "к", pinnedManagerId: null });
    assert.equal(row.pinned_manager_id, null,
      "🔴 явне «зняти закріплення» не спрацювало — поле стало невидаляльним");
    assert.equal(row.hidden, false, "hidden не мав змінитись від запиту про закріплення");
  } finally {
    await c.end();
    scratch.dispose();
  }
});
