import test from "node:test";
import assert from "node:assert/strict";
import { needsBackendEnv } from "../testMode.js";
import { expectBucketOf, EXPECT_BUCKETS, EXPECT_BUCKET_UA } from "./expectSplit.js";

/**
 * ⏳ #26q / #26r — ЧОТИРИ ВІДРА ЗОНИ ОЧІКУВАННЯ.
 *
 * Розподіл праці між ними навмисний і названий:
 *   `#26q` ЖИВИЙ — партиція на прод-даних ОДНИМ викликом, плюс звірка двох форм
 *          правила (SQL проти чистої функції) на тих самих рядках;
 *   `#26r` ФІКСТУРНИЙ — межі, яких у живих даних НЕМАЄ. Угод «без дати» сьогодні
 *          нуль, тож живий гейт на них був би зеленим на зламаному коді просто
 *          тому, що стану немає. Той самий урок, що `#26n③`.
 */

test("#26r МЕЖІ ВІДЕР — по обидва боки кожної, включно з тією, якої немає в даних", () => {
  const today = "2026-09-03";

  // 🔴 ГОЛОВНИЙ ВИПАДОК: угода БЕЗ дати має потрапити в НАЗВАНЕ відро, а не зникнути.
  //    У живих даних таких нуль (заміряно 03.09.2026: 0 із 378), тому це можливо
  //    перевірити лише фікстурою.
  for (const порожнє of [null, undefined, ""])
    assert.equal(expectBucketOf(порожнє, today), "noDate",
      `🔴 угода з ${JSON.stringify(порожнє)} випала з класифікації — у партиції зʼявилась діра, `
      + "і на екрані сума частин перестане дорівнювати цілому");

  // Межа «прострочено»: САМЕ сьогодні ще НЕ прострочено, вчора — вже.
  assert.equal(expectBucketOf("2026-09-02", today), "overdue", "🔴 вчорашня дата не прострочена");
  assert.equal(expectBucketOf("2026-09-03", today), "thisMonth",
    "🔴 СЬОГОДНІШНЯ дата порахована простроченою — межа зсунулась на день");

  // Межа «цього місяця» / «пізніше» — по КАЛЕНДАРНОМУ місяцю, не по «+30 днів».
  assert.equal(expectBucketOf("2026-09-30", today), "thisMonth", "🔴 останній день місяця випав із «цього місяця»");
  assert.equal(expectBucketOf("2026-10-01", today), "later", "🔴 перше число наступного місяця не стало «пізніше»");
  // І дзеркало через рік: грудень 2026 проти грудня 2027 — однаковий місяць, різний рік.
  assert.equal(expectBucketOf("2027-09-15", today), "later",
    "🔴 той самий МІСЯЦЬ іншого РОКУ порахований як «цього місяця» — порівняння втратило рік");

  // Кожне відро має підпис, і підписи різні: відро без імені на екрані не існує.
  const назви = EXPECT_BUCKETS.map((b) => EXPECT_BUCKET_UA[b]);
  assert.equal(new Set(назви).size, EXPECT_BUCKETS.length, `🔴 підписи відер не унікальні: ${назви.join(", ")}`);
  for (const n of назви) assert.ok(n && n.trim().length > 2, `🔴 порожній підпис відра: «${n}»`);
});

test("#26q ЖИВИЙ: чотири відра — ПАРТИЦІЯ, і дві форми правила збігаються порядково",
  { ...needsBackendEnv() }, async () => {
  const { pool } = await import("../db/pool.js");
  const { expectedZoneSplit, expectBucketSql } = await import("./expectSplit.js");
  const { EXPECT_ZONE, FC_PIPELINES } = await import("./metrics.js");
  const K = "AT TIME ZONE 'Europe/Kyiv'";

  const split = await expectedZoneSplit({});

  /**
   * 🔴 ЦІЛЕ Й ЧАСТИНИ — ОДНИМ ВИКЛИКОМ (правило 18). Зона живе: заміряно 03.09.2026,
   * за 15 хвилин її сума зрушила на 6 495 ₴. Взяті двома запитами, вони розійшлися б
   * без жодного дефекту, і ми пішли б шукати помилку там, де її немає.
   */
  const pd = `(d.planned_payment_at ${K})::date`;
  const { rows } = await pool.query<{ bucket: string; pd: string | null; today: string; n: string }>(
    `WITH t AS (SELECT (now() ${K})::date AS today)
     SELECT ${expectBucketSql(pd, "(SELECT today FROM t)")} AS bucket,
            to_char(${pd}, 'YYYY-MM-DD') AS pd,
            to_char((SELECT today FROM t), 'YYYY-MM-DD') AS today,
            COUNT(*)::int n
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
      WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2)
      GROUP BY 1, 2, 3`, [FC_PIPELINES, EXPECT_ZONE]);

  // ⓪ Є що знаходити: порожня зона зробила б рівність істинною тривіально.
  const усього = rows.reduce((a, r) => a + Number(r.n), 0);
  assert.ok(усього > 100, `🔴 у зоні лише ${усього} угод — вибірка вироджена (заміряно 03.09: 378)`);

  // ① ПАРТИЦІЯ: сума чотирьох == ціле, і жодного відра поза переліком.
  const сума = EXPECT_BUCKETS.reduce((a, b) => a + split.buckets[b].deals, 0);
  assert.equal(сума, split.total.deals,
    `🔴 ${EXPECT_BUCKETS.map((b) => `${b}=${split.buckets[b].deals}`).join(" + ")} != ${split.total.deals}`);
  const чужі = [...new Set(rows.map((r) => r.bucket))].filter((b) => !EXPECT_BUCKETS.includes(b as never));
  assert.deepEqual(чужі, [], `🔴 SQL віддав відра поза переліком: ${чужі.join(", ")}`);

  /**
   * 🔴 ГІЛКА, ЯКОЇ ЖИВІ ДАНІ НЕ ТОРКАЮТЬСЯ — ПЕРЕВІРЯЄТЬСЯ SQL-ФІКСТУРОЮ.
   *
   * Знайдено власним саботажем 03.09.2026: прибрав із `CASE` гілку `IS NULL -> noDate`
   * — і ОБИДВА гейти лишились зеленими. Бо угод без дати в зоні нуль, тож гілка не
   * виконується жодного разу, а `#26r` перевіряє лише ЧИСТУ функцію. Виходило, що
   * саме те відро, заради якого все робилось, у SQL не стереже ніхто.
   *
   * Лікується не читанням тексту запиту, а ВИКОНАННЯМ його на синтетичних рядках:
   * `VALUES` не потребує жодної угоди в базі, зате проходить усі чотири гілки.
   */
  const фікстура = [null, "2026-09-02", "2026-09-03", "2026-09-30", "2026-10-01", "2027-09-15"];
  const { rows: fx } = await pool.query<{ pd: string | null; bucket: string }>(
    `SELECT to_char(v.pd, 'YYYY-MM-DD') AS pd,
            ${expectBucketSql("v.pd", "$2::date")} AS bucket
       FROM unnest($1::date[]) AS v(pd)`,
    [фікстура, "2026-09-03"]);
  assert.equal(fx.length, фікстура.length, "🔴 фікстура не доїхала до SQL цілком");
  const хиби = fx.filter((r) => expectBucketOf(r.pd, "2026-09-03") !== r.bucket)
    .map((r) => `${r.pd ?? "null"}: SQL=${r.bucket}, мало бути ${expectBucketOf(r.pd, "2026-09-03")}`);
  assert.deepEqual(хиби, [],
    "🔴 SQL-класифікація хибна на межах, яких немає в живих даних:\n   " + хиби.join("\n   "));
  assert.ok(fx.some((r) => r.bucket === "noDate"),
    "🔴 SQL не віднайшов ЖОДНОГО «без дати» навіть на фікстурі з null — гілку прибрано, "
    + "і в живих даних це не видно, бо таких угод сьогодні нуль");

  // ② ДВІ ФОРМИ ПРАВИЛА ЗБІГАЮТЬСЯ порядково. Без цього SQL і чиста функція
  //    розійшлися б мовчки, а `#26r` перевіряв би те, чого продукт не вживає.
  const розбіжні = rows.filter((r) => expectBucketOf(r.pd, r.today) !== r.bucket)
    .map((r) => `${r.pd ?? "null"}: SQL=${r.bucket} JS=${expectBucketOf(r.pd, r.today)}`);
  assert.deepEqual(розбіжні, [],
    "🔴 SQL і чиста функція класифікують по-різному — одне правило записане двічі й розійшлось:\n   "
    + розбіжні.slice(0, 5).join("\n   "));
});
