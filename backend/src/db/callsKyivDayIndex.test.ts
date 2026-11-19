import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason, type Unavailable } from "./scratchDb.js";

/**
 * #9964 — ІНДЕКС «ДАТА ДЗВІНКА ПО-КИЄВУ» ІСНУЄ, І ПЛАНОВИК БЕРЕ ЙОГО ДЛЯ ФОРМИ З ЯДРА.
 *
 * Індекс за виразом працює лише тоді, коли вираз у запиті збігається з виразом індексу. Тому
 * гейт перевіряє не «рядок у schema.sql», а поведінку: на справжній базі, зі схемою з файла,
 * запит у формі, якою пишуть фільтр періоду, отримує план З ЦИМ індексом.
 * Дзеркало: інша форма виразу (без приведення до дати) індекс НЕ бере — інакше перевірка
 * зеленіла б на будь-якому запиті.
 */
const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
let shared: { url: string; dispose: () => void } | Unavailable | null = null;
after(() => { if (shared && !("unavailable" in shared)) shared.dispose(); });

test("#9964 ІНДЕКС «ДАТА ДЗВІНКА ПО-КИЄВУ»: є в схемі, і фільтр періоду ним користується", async (t) => {
  if (shared == null) shared = (await import("./scratchDb.js")).provisionScratch();
  if ("unavailable" in shared) return t.skip(skipReason(shared));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: shared.url });
  await c.connect();
  try {
    await c.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await c.query(readFileSync(SCHEMA, "utf8"));
    const idx = await c.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_rc_kyiv_day'`);
    assert.equal(idx.rows.length, 1, "🔴 індексу idx_rc_kyiv_day у схемі немає — фільтри періоду знову читають усю таблицю дзвінків");
    // Рядків досить, щоб послідовний прохід був дорожчим за індекс, і лише ~1% з них у вікні.
    await c.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, duration)
                   SELECT 'u' || g, now() - (g || ' minutes')::interval, 'out', 30, 30 FROM generate_series(1, 60000) g`);
    await c.query(`ANALYZE ringostat_calls`);
    const plan = async (where: string) => (await c.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT count(*) FROM ringostat_calls c WHERE ${where}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    const core = await plan(`(c.calldate AT TIME ZONE 'Europe/Kyiv')::date BETWEEN (now() AT TIME ZONE 'Europe/Kyiv')::date - 1 AND (now() AT TIME ZONE 'Europe/Kyiv')::date`);
    assert.match(core, /idx_rc_kyiv_day/,
      "🔴 фільтр періоду у формі ядра не бере індекс: вираз індексу розійшовся з виразом у запитах\n" + core);
    // 🪞 Дзеркало: інший вираз цим індексом не обслуговується.
    const other = await plan(`(c.calldate AT TIME ZONE 'UTC')::date BETWEEN (now() AT TIME ZONE 'UTC')::date - 1 AND (now() AT TIME ZONE 'UTC')::date`);
    assert.doesNotMatch(other, /idx_rc_kyiv_day/, "🔴 індекс «по-Києву» взято для виразу в UTC — перевірка нічого не розрізняє");
  } finally { await c.end(); }
});
