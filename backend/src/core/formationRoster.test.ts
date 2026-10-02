import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

/**
 * #1300 — СКЛАД «ФОРМУВАННЯ ПЛАНУ» = ТІ, КОМУ СТАВИМО ПЛАН (02.10.2026, задача 4892). Звільнений у дашборді
 * Шевчук Назар лишався у формуванні, бо роут дивився лише на `m.is_active` з Kommo. Тепер — `hasPlanSql`:
 * «звільнений» і «завершує» плану не мають; неактивний у Kommo — теж; активний — є (дзеркало).
 * 🧨 Червоніє, якщо повернути `m.is_active` без стану роботи або зламати фільтр команди.
 */
test("#1300 ФОРМУВАННЯ ПЛАНУ: звільнений, «завершує» й неактивний у Kommo — без плану; активний — у складі", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id, name) VALUES (5, 'РПК'), (6, 'РНК') ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id, is_active) VALUES
      (1, 'Активний', 5, true), (2, 'Звільнений у дашборді', 5, true), (3, 'Завершує', 5, true),
      (4, 'Неактивний у Kommo', 5, false), (5, 'Інша команда', 6, true), (6, 'Без команди', NULL, true)
      ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO manager_work_state (manager_id, state) VALUES (2, 'dismissed'), (3, 'finishing')`);
    // ⚠️ `DATABASE_URL` — ДО імпорту ядра: `db/pool` читає конфіг на імпорті (той самий прийом, що в #843).
    process.env.DATABASE_URL = scratch.url;
    process.env.JWT_SECRET ??= "test";
    process.env.KOMMO_BASE_URL ??= "https://x.invalid";
    process.env.KOMMO_API_TOKEN ??= "x";
    const { formationRoster } = await import("./plans.js");
    const team5 = (await formationRoster(c, 5)).map((r) => r.name);
    assert.deepEqual(team5, ["Активний"], "🔴 у формуванні команди — не рівно ті, кому ставимо план");
    const all = (await formationRoster(c, null)).map((r) => r.name).sort();
    assert.deepEqual(all, ["Активний", "Інша команда"].sort(), "🔴 без фільтра команди — звільнені або «без команди» в складі");
  } finally {
    await c.end();
    scratch.dispose();
  }
});
