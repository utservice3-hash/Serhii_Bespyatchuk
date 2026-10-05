import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🗂 Бізнес-асистент, ТТН автоматично (05.10.2026): гейт синку в ОКРЕМОМУ файлі — він підключає
 * спільний пул (`db/pool.js`, синглтон) до одноразової бази, і в одному процесі з іншими гейтами
 * пул створився б раніше з чужою адресою (правило про scratch-кластер і спільний пул, testing.md).
 */
/**
 * #1401 — ЖИВИЙ SQL СИНКУ: `ttn_files` пише СПРАВЖНЯ вставка `syncKommo.upsertDeal` — і на
 * вставці, і на оновленні (файл прикріпили пізніше / видалили). Без цього нова колонка лишилась би
 * NULL назавжди для нових угод, а гейт на ядро ТТН зеленів би на фікстурі, яку пише тест.
 * 🧨 Червоніє, якщо загубити колонку у вставці чи в `ON CONFLICT … SET`.
 */
test("#1401 ЖИВИЙ SQL СИНКУ: upsertDeal пише deals.ttn_files і на вставці, і на оновленні", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  const { pool } = await import("../db/pool.js");
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO managers (id, name, kommo_user_id) VALUES (11, 'М', 555) ON CONFLICT DO NOTHING`);
    const { upsertDeal } = await import("../jobs/syncKommo.js");
    const now = Math.floor(Date.now() / 1000);
    const file = (n: number) => ({ value: { file_uuid: `u${n}`, version_uuid: `v${n}`, file_name: `ttn${n}.pdf`, file_size: 1, is_deleted: false } });
    const deal = (vals: unknown[] | null) => ({ id: 9001, name: "Угода", price: 1000, pipeline_id: 8921932, status_id: 142, responsible_user_id: 555,
      created_at: now, updated_at: now, closed_at: now,
      custom_fields_values: vals == null ? [] : [{ field_id: 2097291, values: vals }] });
    const mgr = new Map([[555, 11]]);
    const ttn = async () => (await c.query(`SELECT ttn_files FROM deals WHERE kommo_id = 9001`)).rows[0]?.ttn_files;
    await upsertDeal(deal([file(1), file(2)]) as never, mgr, new Map(), new Map());
    assert.equal(await ttn(), 2, "🔴 вставка синку не записала ttn_files");
    await upsertDeal(deal(null) as never, mgr, new Map(), new Map());
    assert.equal(await ttn(), 0, "🔴 оновлення синку не переписало ttn_files (файл ТТН видалили в CRM)");
    await upsertDeal(deal([file(3)]) as never, mgr, new Map(), new Map());
    assert.equal(await ttn(), 1, "🔴 оновлення синку не підхопило пізніше прикріплену ТТН");
  } finally {
    await pool.end().catch(() => {});
    await c.end();
    scratch.dispose();
  }
});

