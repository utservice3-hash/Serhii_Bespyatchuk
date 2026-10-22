import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEACTIVATE_MISSING_MANAGERS_SQL } from "./managerKeep.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");

/**
 * #1880 — ЗАПИС «ЖИВЕ БЕЗ CRM» СИНК НЕ ВИМИКАЄ (22.10.2026, КВП Левентова Юлія: акаунт у Kommo видаляють, у дашборді
 * має лишитись усе). По обидва боки: зниклий з Kommo БЕЗ позначки — вимкнено; З позначкою — активний; присутній у Kommo —
 * активний. Синк бере саме цей SQL (інших вимикань менеджерів немає); позначка для Юлі — разова, з умовою на Kommo-id.
 * Схема з нуля; ⚠️ на прод-сервері бінарів PostgreSQL немає → `skip` через `skipReason()` і `ALLOWED_PROD_SKIPS`.
 * 🧨 Червоніє, якщо прибрати умову `keep_without_crm`, повернути в синк інлайн-SQL або загубити позначку Юлі.
 */
test("#1880 ЖИВЕ БЕЗ CRM: синк не вимикає запис із позначкою, решту зниклих вимикає; позначка Юлі разова й за Kommo-id", async (t) => {
  const sync = SRC("jobs/syncKommo.ts");
  assert.match(sync, /await pool\.query\(DEACTIVATE_MISSING_MANAGERS_SQL, \[activeKommoIds\]\);/, "🔴 синк вимикає менеджерів не спільним SQL");
  assert.doesNotMatch(sync, /UPDATE managers SET is_active = false/, "🔴 у синку лишився інлайн-SQL вимкнення — позначку обійдуть");
  const schema = SRC("db/schema.sql");
  assert.match(schema, /ALTER TABLE managers ADD COLUMN IF NOT EXISTS keep_without_crm BOOLEAN NOT NULL DEFAULT false;/);
  assert.match(schema, /UPDATE managers SET keep_without_crm = true WHERE id = 9 AND kommo_user_id = '3549691' AND NOT keep_without_crm;/,
    "🔴 позначку Юлі загублено або поставлено без перевірки Kommo-id");

  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO managers (id, name, kommo_user_id, is_active) VALUES
      (9, 'Левентова Юлія', '3549691', true), (10, 'Звільнений', '111', true), (11, 'У CRM', '222', true), (12, 'Сервісний', NULL, true)`);
    // Схема накочується вдруге (як на кожному викаті): позначка Юлі ставиться на вже наявний рядок.
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    const keep = async (id: number) => (await c.query(`SELECT keep_without_crm k FROM managers WHERE id = $1`, [id])).rows[0].k as boolean;
    assert.equal(await keep(9), true, "🔴 позначку Юлі не поставлено міграцією");
    assert.equal(await keep(10), false, "🔴 позначка дісталась не тій людині");
    await c.query(DEACTIVATE_MISSING_MANAGERS_SQL, [["222"]]);
    const act = Object.fromEntries((await c.query(`SELECT id, is_active FROM managers ORDER BY id`)).rows.map((r: { id: number; is_active: boolean }) => [r.id, r.is_active]));
    assert.deepEqual(act, { 9: true, 10: false, 11: true, 12: true },
      "🔴 Юлю вимкнено попри позначку, або зниклого без позначки не вимкнено, або зачеплено присутнього / без Kommo-id");
  } finally { await c.end(); scratch.dispose(); }
});
