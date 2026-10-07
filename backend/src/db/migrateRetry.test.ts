import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { withMigrationRetry, isRetryableMigrationError, retryDelayMs, MIGRATION_ATTEMPTS } from "./migrateRetry.js";

/**
 * 🔁 #776–#776b — ПОВТОР МІГРАЦІЇ ПРИ ВЗАЄМНОМУ БЛОКУВАННІ (01.10.2026). Привід: викат 749d894 двічі впав на
 * `deadlock detected`, третій ручний запуск пройшов.
 */
const pgErr = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

/**
 * #776 — повторюємо ЛИШЕ конкуренцію за блокування; дефект схеми падає одразу; вичерпані спроби — остання помилка.
 * Обидва боки межі (правило 11): 40P01 → повтор і успіх; 42P01 → жодного повтору.
 * 🧨 Червоніє, якщо повторювати все підряд (дефект схеми крутився б 5 разів і ховався за «спробуємо ще»)
 * або не повторювати deadlock (повернувся б сьогоднішній ручний перезапуск).
 */
test("#776 МІГРАЦІЯ: повтор лише на deadlock/блокуванні, дефект схеми — одразу", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  let n = 0;
  const ok = await withMigrationRetry(async () => { n++; if (n < 3) throw pgErr("40P01"); return "applied"; }, { sleep, log: () => {} });
  assert.equal(ok, "applied", "🔴 після двох deadlock міграція не дійшла до кінця");
  assert.equal(n, 3, "🔴 кількість спроб не та");
  assert.deepEqual(waits, [retryDelayMs(2), retryDelayMs(3)], "🔴 паузи між спробами не ті");

  let m = 0;
  await assert.rejects(withMigrationRetry(async () => { m++; throw pgErr("42P01"); }, { sleep, log: () => {} }),
    (e: { code?: string }) => e.code === "42P01", "🔴 дефект схеми загублено або підмінено");
  assert.equal(m, 1, "🔴 дефект схеми (42P01) повторювали — він з повтором не лікується");

  let k = 0;
  await assert.rejects(withMigrationRetry(async () => { k++; throw pgErr("40P01"); }, { sleep, log: () => {} }),
    (e: { code?: string }) => e.code === "40P01", "🔴 після вичерпаних спроб назовні не та помилка");
  assert.equal(k, MIGRATION_ATTEMPTS, "🔴 спроб не стільки, скільки обіцяно");

  for (const c of ["40P01", "40001", "55P03"]) assert.ok(isRetryableMigrationError(pgErr(c)), `🔴 ${c} не повторюється`);
  for (const c of ["42P01", "42601", "23505"]) assert.ok(!isRetryableMigrationError(pgErr(c)), `🔴 ${c} повторюється`);
  assert.ok(!isRetryableMigrationError(new Error("без коду")), "🔴 помилка без коду визнана конкуренцією");

  // Бойовий шлях справді йде через повтор — інакше гейт доводив би функцію, якої ніхто не кличе.
  const migrate = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "db", "migrate.ts"), "utf8");
  assert.match(migrate, /await withMigrationRetry\(\(\) => pool\.query\(sql\)\)/, "🔴 migrate.ts виконує схему без повтору");
});

/**
 * #776b — ПОВТОР БЕЗПЕЧНИЙ: багатооператорний запит відкочується ЦІЛКОМ, якщо падає посередині. Саме на цьому
 * стоїть «повтор починає з того самого стану». Перевіряється на живому кластері, бо це властивість Postgres і
 * драйвера, а не нашого коду.
 * 🧨 Червоніє, якщо `pg` почне слати оператори окремо (тоді перша половина схеми лишалась би після deadlock).
 */
test("#776b МІГРАЦІЯ: невдала спроба схеми не лишає НІЧОГО — повтор безпечний", async (t) => {
  const { provisionScratch, skipReason } = await import("./scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) return t.skip(skipReason(s));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  try {
    await c.connect();
    await assert.rejects(c.query(`CREATE TABLE mig_probe_a (id int); INSERT INTO mig_probe_a VALUES (1); SELECT * FROM mig_probe_missing;`));
    const left = await c.query(`SELECT to_regclass('mig_probe_a') AS t`);
    assert.equal(left.rows[0].t, null, "🔴 перша половина невдалої «схеми» лишилась у базі — повтор не з того самого стану");
    // 🪞 дзеркало: успішний багатооператорний запит лишає все
    await c.query(`CREATE TABLE mig_probe_b (id int); INSERT INTO mig_probe_b VALUES (1);`);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM mig_probe_b`)).rows[0].n, 1, "🔴 успішна схема не застосувалась");
  } finally {
    await c.end().catch(() => {});
    s.dispose();
  }
});
