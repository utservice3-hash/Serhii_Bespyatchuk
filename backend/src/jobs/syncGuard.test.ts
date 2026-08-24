import { test } from "node:test";
import assert from "node:assert/strict";
import { skipReason, type Unavailable } from "../db/scratchDb.js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #68 — ЗАХИСТ ПІСЛЯ АВАРІЇ 10.08.2026 (синк стояв 14 год 52 хв).
 *
 * 🔴 ЩО СТАЛОСЬ, ОДНИМ АБЗАЦОМ. Прохід `syncKommo` о 18:00 підняв in-process
 * прапорець `syncRunning` і завис на запиті до БД (у лозі тієї хвилини — шквал
 * 20-секундних REQUEST TIMEOUT). `finally` рятує від ПОМИЛКИ, але не від
 * ЗАВИСАННЯ: обіцянка, що не завершилась, не виконує ні `try`, ні `catch`, ні
 * `finally`. Прапорець лишився `true` до рестарту. Далі 30 тіків поспіль виходили
 * першим рядком функції, а `runJob` записував це як `last_success_at = now()`,
 * `last_duration_ms = 0`.
 *
 * Тобто джерело правди про здоров'я джоби 30 разів поспіль казало «все добре»
 * САМЕ ТОМУ, що вона не працювала. Ані звірка, ані вартовий свіжості не мали
 * шансу — обидва дивились на успіх.
 *
 * Гейти нижче тримають ЧОТИРИ рубежі, кожен окремо:
 *   #68  — прапорець не може пережити стелю часу (корінь: 15 год → 15 хв);
 *   #68b — пропуск НЕ є успіхом (робить тишу видимою);
 *   #68c — успіх НЕ стирає `last_error` (ми втратили причину саме так);
 *   #68d — розбіжність job_runs↔sync_state ловиться (клас, невидимий обом наглядачам).
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

/** #68 — КОРІНЬ. Чиста функція, тож доводиться без БД і без Kommo. */
test("#68 ОХОРОНЕЦЬ НЕ МОЖЕ ЗАЛИПНУТИ НАЗАВЖДИ", async () => {
  const { guardDecision, MAX_RUN_MS } = await import("./syncGuardRule.js");
  const T = 1_000_000;
  assert.equal(guardDecision(false, 0, T), "run",
    "🔴 вільний охоронець мусить пускати — інакше синк не працює взагалі");
  assert.equal(guardDecision(true, T - 60_000, T), "skip",
    "🔴 прохід, що біжить хвилину, — це норма, його не можна перехоплювати");
  assert.equal(guardDecision(true, T - (MAX_RUN_MS - 1), T), "skip",
    "🔴 за мить ДО стелі ще пропуск");
  assert.equal(guardDecision(true, T - MAX_RUN_MS, T), "seize",
    "🔴 РІВНО НА СТЕЛІ прохід визнається завислим — саме тут аварія мусить закінчитись");
  assert.equal(guardDecision(true, T - 15 * 3600_000, T), "seize",
    "🔴 прохід віком 15 годин (як в аварії) ЗОБОВ'ЯЗАНИЙ бути перехопленим");
  // Невиродженість: якби функція завжди давала одне й те саме, збіги вище нічого б не доводили.
  assert.equal(new Set([
    guardDecision(false, 0, T), guardDecision(true, T - 1, T), guardDecision(true, 0, T),
  ]).size, 3, "🔴 функція видала не всі три рішення — вона вироджена, і гейт порожній");
});

/**
 * 🔴 ОДИН КЛАСТЕР НА ФАЙЛ, А НЕ НА ТЕСТ — і це не оптимізація, а правильність.
 *
 * Перша редакція піднімала свіжий scratch у КОЖНОМУ тесті. Але `db/pool.js`
 * створює пул ОДИН раз на процес і кешується разом із `DATABASE_URL`, який стояв
 * на момент першого імпорту. Тож `runJob` у другому тесті писав у базу ПЕРШОГО
 * тесту, а перевірка читала з третьої — і тест падав із «рядка немає», хоча
 * бойовий код працював правильно.
 *
 * Записую, бо це той самий клас, що й решта сьогоднішніх помилок: перевірка
 * міряла не те, що думала. Різні тести розведені різними ІМЕНАМИ джоб, а не
 * різними базами.
 */
let shared: { url: string } | Unavailable | null = null;
async function withScratch(t: { skip: (m: string) => void },
  fn: (c: import("pg").Client) => Promise<void>): Promise<void> {
  if (!shared) {
    const { provisionScratch } = await import("../db/scratchDb.js");
    shared = provisionScratch();
    if (!("unavailable" in shared)) {
      process.env.DATABASE_URL = shared.url;
      process.env.JWT_SECRET ??= "test";
      process.env.KOMMO_BASE_URL ??= "https://x.invalid";
      process.env.KOMMO_API_TOKEN ??= "x";
      const { default: pg0 } = await import("pg");
      const boot = new pg0.Client({ connectionString: shared.url });
      await boot.connect();
      await boot.query(readFileSync(SCHEMA, "utf8"));
      await boot.end();
    }
  }
  if ("unavailable" in shared) return t.skip(skipReason(shared));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: shared.url });
  await c.connect();
  try { await fn(c); } finally { await c.end(); }
}

/** #68b — ПРОПУСК НЕ Є УСПІХОМ. Саме ця підміна ховала аварію 30 тіків поспіль. */
test("#68b ПРОПУСК пишеться пропуском, а не успіхом", async (t) => {
  await withScratch(t, async (c) => {
    const { runJob, jobSkip } = await import("./jobRuns.js");
    await runJob("t68", async () => { /* справжня робота */ });
    const okRow = (await c.query(`SELECT * FROM job_runs WHERE name='t68'`)).rows[0];
    assert.ok(okRow.last_success_at, "🔴 успіх не записався — перевіряти нічого");
    const successAt = new Date(okRow.last_success_at).getTime();

    await runJob("t68", async () => jobSkip("попередній прохід ще біжить"));
    const skipRow = (await c.query(`SELECT * FROM job_runs WHERE name='t68'`)).rows[0];
    assert.equal(new Date(skipRow.last_success_at).getTime(), successAt,
      "🔴 ПРОПУСК ЗРУШИВ `last_success_at` — це і є аварія 10.08.2026: джоба не працює, "
      + "а звітує успіхом, і жоден наглядач цього не бачить");
    assert.equal(skipRow.consecutive_skips, 1, "🔴 лічильник пропусків не росте — тиша лишається невидимою");
    assert.ok(skipRow.last_skip_reason?.includes("біжить"), "🔴 причина пропуску не збережена");

    await runJob("t68", async () => jobSkip("знову"));
    assert.equal((await c.query(`SELECT consecutive_skips FROM job_runs WHERE name='t68'`)).rows[0].consecutive_skips, 2,
      "🔴 другий пропуск не додався");
    // 🪞 Дзеркало: успіх ОБНУЛЯЄ лічильник, інакше він назавжди лишиться «в аварії».
    await runJob("t68", async () => { /* знову працює */ });
    assert.equal((await c.query(`SELECT consecutive_skips FROM job_runs WHERE name='t68'`)).rows[0].consecutive_skips, 0,
      "🔴 успіх не обнулив лічильник — сигналізація застрягне в аварії й перестане щось означати");
  });
});

/** #68c — УСПІХ НЕ СТИРАЄ ПОМИЛКУ. Так ми втратили причину першої аварії. */
test("#68c УСПІХ НЕ ЗАТИРАЄ last_error", async (t) => {
  await withScratch(t, async (c) => {
    const { runJob } = await import("./jobRuns.js");
    await runJob("t68c", async () => { throw new Error("причина-яку-не-можна-втрачати"); });
    const err = (await c.query(`SELECT * FROM job_runs WHERE name='t68c'`)).rows[0];
    assert.ok(err.last_error?.includes("не-можна-втрачати"), "🔴 помилка не записалась");
    await runJob("t68c", async () => { /* успіх */ });
    const after = (await c.query(`SELECT * FROM job_runs WHERE name='t68c'`)).rows[0];
    assert.ok(after.last_error?.includes("не-можна-втрачати"),
      "🔴 успіх стер текст помилки — рівно так 10.08.2026 зникла причина, що почала аварію, "
      + "ще до того, як ми про аварію дізнались");
    assert.ok(new Date(after.last_success_at) > new Date(after.last_error_at),
      "🔴 свіжість тепер визначається порівнянням дат, і воно мусить працювати");
  });
});

/** #68d — РОЗБІЖНІСТЬ ДВОХ ДЖЕРЕЛ. Її не бачив жоден наглядач поодинці. */
test("#68d РОЗБІЖНІСТЬ job_runs↔sync_state видно запитом", async (t) => {
  await withScratch(t, async (c) => {
    await c.query(`INSERT INTO sync_state (id, last_success_at) VALUES (1, now() - interval '15 hours')
                   ON CONFLICT (id) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`);
    await c.query(`INSERT INTO job_runs (name, last_success_at, last_duration_ms, consecutive_skips)
                   VALUES ('syncKommo', now(), 0, 0)
                   ON CONFLICT (name) DO UPDATE SET last_success_at = now()`);
    const r = await c.query<{ gap_min: string; dur: number }>(
      `SELECT EXTRACT(EPOCH FROM jr.last_success_at - ss.last_success_at)/60 AS gap_min,
              jr.last_duration_ms AS dur
         FROM job_runs jr, sync_state ss WHERE jr.name='syncKommo' AND ss.id=1`);
    const gap = Number(r.rows[0].gap_min);
    assert.ok(gap > 90,
      `🔴 розрив ${Math.round(gap)} хв не перевищив поріг — умова аварії не відтворилась, `
      + "а порожня перевірка це ПРОВАЛ, не успіх");
    assert.equal(Number(r.rows[0].dur), 0,
      "🔴 нульова тривалість — другий підпис тієї самої поломки, він мусить бути видимий");
  });
});

/** #68e — ХТО ТРИМАЄ ЗАМОК. Безіменний warn не давав відрізнити норму від удушення. */
test("#68e ЗАМОК НАЗИВАЄ ТРИМАЧА І ТРИВАЛІСТЬ", async (t) => {
  await withScratch(t, async (c) => {
    await c.query(`INSERT INTO job_locks (name, started_at, heartbeat_at)
                   VALUES ('reconcileNightly', now() - interval '4 minutes', now())`);
    const { heavyJobHolder } = await import("./jobLock.js");
    const h = await heavyJobHolder();
    assert.ok(h, "🔴 замок зі свіжим heartbeat не побачено — синк ганявся б поверх важкої джоби");
    assert.equal(h.name, "reconcileNightly", "🔴 тримача не названо — у лозі знову буде безіменний рядок");
    assert.ok(h.heldSec >= 200 && h.heldSec <= 300,
      `🔴 тривалість утримання ${h.heldSec} с не схожа на 4 хв — без неї не відрізнити норму від мертвого замка`);
    // 🪞 Дзеркало: протухлий heartbeat НЕ вважається живим замком, інакше мертва
    // джоба душила б синк вічно — рівно те, від чого heartbeat і вигадали.
    await c.query(`UPDATE job_locks SET heartbeat_at = now() - interval '10 minutes'`);
    assert.equal(await heavyJobHolder(), null,
      "🔴 протухлий замок досі вважається живим — синк ніколи не відновиться сам");
  });
});
