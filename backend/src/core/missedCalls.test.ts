import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyCall, isMissed, foldManagerRows, missedPeriod, missedSummarySql, missedByManagerSql,
  OWNERLESS_LABEL, MISSED_DEFAULT_DAYS, type MissedManagerRaw,
} from "./missedCallsRules.js";
import { dayBucketOf, dayBucketCase, DAY_BUCKETS } from "./dayBuckets.js";
import { needsBackendEnv } from "../testMode.js";

/**
 * #431…#438 — ПРОПУЩЕНІ ВХІДНІ (ТЗ-1, 14.09.2026).
 *
 * Гейти стережуть рівно ті чотири місця, де цей екран може збрехати ТИХО — тобто
 * віддати правдоподібне число, а не помилку:
 *   ① означення пропущеного (BUSY усередині, CLIENT NO ANSWER зовні);
 *   ② склейка плечей — і саме та її форма, що не втрачає дзвінки без менеджера;
 *   ③ рядок «без відповідального», який і є половиною предмета;
 *   ④ медіана замість середнього і київська межа доби.
 *
 * 🔴 ЖОДЕН ІЗ НИХ НЕ ПОТРЕБУЄ ЖИВОЇ БД — і це умова, а не зручність. Гейт, який
 * скіпається в кожному доступному оточенні, не є гейтом; він є наміром.
 */

const S = (): string => missedSummarySql("2026-08-17", "2026-09-15", {}).sql;

test("#431 ОЗНАЧЕННЯ: пропущений — це вхідний, нульовий, із NO ANSWER або BUSY", () => {
  // По один бік межі — рахується. BUSY тут за рішенням власника 15.09.2026: лінія
  // зайнята означає, що клієнт НЕ ДОДЗВОНИВСЯ, а не що ми відповіли.
  for (const d of ["NO ANSWER", "BUSY"]) {
    for (const t of ["in", "transitin"]) {
      assert.equal(classifyCall({ callType: t, billsec: 0, disposition: d }), "missed",
        `🔴 ${t}/${d} перестав бути пропущеним`);
    }
  }
  // По другий бік — НЕ рахується, і кожна причина названа своїм словом.
  assert.equal(classifyCall({ callType: "out", billsec: 0, disposition: "NO ANSWER" }), "outbound",
    "🔴 наш недодзвін клієнту зарахований як пропущений НАМИ");
  assert.equal(classifyCall({ callType: "in", billsec: 42, disposition: "ANSWERED" }), "talk",
    "🔴 відповідана розмова потрапила в пропущені");
  assert.equal(isMissed({ callType: "in", billsec: 1, disposition: "NO ANSWER" }), false,
    "🔴 розмова на 1 секунду важливіша за disposition — інакше склейка порахує її двічі");
});

test("#431b ДЗЕРКАЛО: те, що НЕ пропущене, називає себе, а не мовчить", () => {
  // Правило проєкту: стан, що стверджує причину, не може бути смітником для кількох
  // різних відмов. Тому «не пропущений» має ЧОТИРИ значення, а не булеве false.
  for (const d of ["VOICEMAIL", "CLIENT NO ANSWER", "ANSWERED"]) {
    assert.equal(classifyCall({ callType: "in", billsec: 0, disposition: d }), "excluded",
      `🔴 ${d} злився з пропущеними — 85 дзвінків за 30 днів зникли б у чужому числі`);
  }
  // 🔴 NULL-ПАСТКА. У SQL `disposition IN (…)` при NULL дає NULL, і рядок не
  // потрапляє В ЖОДНУ гілку — зникає з підсумку, не з'явившись у жодному числі.
  // Той самий клас уже коштував 159 угод на `traf_type`.
  assert.equal(classifyCall({ callType: "in", billsec: 0, disposition: null }), "excluded",
    "🔴 дзвінок без disposition провалився між гілками — саме так зникають рядки");
  // І дзеркало в SQL: `excluded` означений ДОПОВНЕННЯМ, а не другим переліком.
  assert.match(S(), /disposition IS NULL OR NOT \(/,
    "🔴 виключені рахуються власним переліком — NULL не потрапить у жодне число");
});

test("#432 СКЛЕЙКА: форма з LAG, і вона рахується ПІСЛЯ звуження до вхідних", () => {
  const sql = S();
  // ✅ Склейка є і вона віконна.
  assert.match(sql, /LAG\(b\.calldate\)/,
    "🔴 склейка плечей зникла — число завищиться на ~7.4%, як уже було заміряно");
  assert.match(sql, /PARTITION BY b\.manager_id/,
    "🔴 менеджер випав із ключа склейки");
  // 🔴 І САМЕ НЕ ТА ФОРМА, ЩО ПОРУЧ. `mergedNotExists` звіряє плечі рівністю
  // `p.manager_id = a.manager_id`; при NULL це дає NULL → NOT EXISTS завжди
  // істинний → жоден дзвінок БЕЗ ВІДПОВІДАЛЬНОГО не склеюється. А таких 48.5%.
  assert.doesNotMatch(sql, /NOT EXISTS/,
    "🔴 повернулась форма NOT EXISTS — половина екрана (48.5% без менеджера) завищена");
  // 🔴 ФІЛЬТР ДО СКЛЕЙКИ. `call_type` не входить у ключ склейки, тож на несортованому
  // наборі вхідний недодзвін і вихідний недодзвін на той самий номер у межах 120 с
  // злились би в один рядок. LAG мусить бігти по ВЖЕ звуженому `base`, не по таблиці.
  assert.match(sql, /FROM base b/,
    "🔴 LAG побіг не по звуженому набору");
  assert.doesNotMatch(sql, /LAG\(rc\./,
    "🔴 склейка рахується по сирій таблиці — вона з'їсть вихідні плечі разом із вхідними");
});

test("#433 КИЇВ: межа періоду і межа доби — обидві за Києвом", () => {
  const sql = S();
  const kyiv = (sql.match(/AT TIME ZONE 'Europe\/Kyiv'/g) ?? []).length;
  // Три місця: фільтр періоду + dow + hr. Менше — означає, що якесь із них поїхало
  // в UTC: дзвінок 23:59 31.12 за Києвом потрапив би в 01.01, а вечір зсунувся б на
  // три години, не зачепивши ЖОДНОЇ суми — тобто інваріант Σ цього не побачить.
  assert.ok(kyiv >= 3,
    `🔴 київських меж лише ${String(kyiv)} із 3 — щось рахується за UTC`);
  assert.match(sql, /\)::date BETWEEN \$1 AND \$2/,
    "🔴 межа періоду перестала бути двобічною по даті — останній день міг зникнути");
});

test("#434 БЕЗ ВІДПОВІДАЛЬНОГО: окремий рядок, і Σ рядків == «всього»", () => {
  const raw: MissedManagerRaw[] = [
    { managerId: 7, name: "Яцик", teamId: 1, missed: 10, callbackSelf: 4, callbackColleague: 2, clientSelf: 3, medianMin: 12 },
    { managerId: null, name: null, teamId: null, missed: 20, callbackSelf: 0, callbackColleague: 9, clientSelf: 5, medianMin: 40 },
    { managerId: 9, name: "Дмитрук", teamId: 1, missed: 5, callbackSelf: 1, callbackColleague: 1, clientSelf: 0, medianMin: 8 },
  ];
  const { rows, total } = foldManagerRows(raw);

  // Інваріант, заради якого гейт існує: прибери «нічиїх» — і Σ перестане сходитись.
  assert.equal(total.missed, 35, "🔴 підсумок розійшовся з рядками");
  assert.equal(rows.reduce((n, r) => n + r.missed, 0), total.missed,
    "🔴 Σ рядків ≠ «всього» — рядок кудись подівся");
  assert.equal(rows.length, 3, "🔴 зник цілий рядок таблиці");

  // Рядок існує, названий, і названий НЕ словом «нічий»: у `orphanClients.ts` воно
  // вже означає клієнта без активного менеджера — інший предмет.
  const own = rows.find((r) => r.managerId === null);
  assert.ok(own, "🔴 рядок «без відповідального» зник — а це 48.5% предмета екрана");
  assert.equal(own.name, OWNERLESS_LABEL);
  assert.doesNotMatch(OWNERLESS_LABEL.toLowerCase(), /нічи/,
    "🔴 підпис зіткнувся зі значенням слова «нічий» на екрані клієнтів");

  // Він стоїть ОСТАННІМ попри найбільше число — це не людина, і сортувати його
  // разом із людьми означало б поставити «нікого» на перше місце рейтингу.
  assert.equal(rows[rows.length - 1]?.managerId, null, "🔴 «без відповідального» вліз у рейтинг людей");
  assert.equal(rows[0]?.name, "Яцик", "🔴 люди перестали сортуватись за спаданням");

  // «Не передзвонили» — похідне, і воно теж мусить сходитись.
  assert.deepEqual(rows.map((r) => r.noCallback), [4, 3, 11], "🔴 «не передзвонили» рахується неправильно");

  // 🔴 МЕДІАНИ НЕ ДОДАЮТЬСЯ. Підсумкова медіана тут мусить бути null, інакше екран
  // покаже число, яке не є ні медіаною, ні середнім.
  assert.equal(total.medianMin, null,
    "🔴 підсумок вигадав медіану з медіан — справжня береться одним запитом у missedSummary");
});

test("#435 МЕДІАНА, А НЕ СЕРЕДНЄ", () => {
  // Заміряно 15.09.2026: медіана 19 хв, середнє 183 хв — майже вдесятеро. Розподіл
  // хвостатий, і ціль «з 60% до 36%», поставлена на середньому, міряла б хвіст.
  for (const sql of [S(), missedByManagerSql("2026-08-17", "2026-09-15", {}).sql]) {
    assert.match(sql, /PERCENTILE_CONT\(0\.5\) WITHIN GROUP/,
      "🔴 медіана зникла");
    assert.doesNotMatch(sql, /AVG\s*\(/i,
      "🔴 з'явилось середнє — воно покаже 183 хв там, де робота відділу це 19 хв");
  }
});

test("#436 ВІДРА ДОБИ: приклад по ОБИДВА боки кожної межі", () => {
  // Фікстура з одного значення не перевіряє властивості — потрібні обидва боки.
  assert.equal(dayBucketOf(3, 11), "work");
  assert.equal(dayBucketOf(3, 9), "work", "🔴 дев'ята ранку випала з робочого часу");
  assert.equal(dayBucketOf(3, 8), "night", "🔴 восьма ранку стала робочою");
  assert.equal(dayBucketOf(3, 17), "work");
  assert.equal(dayBucketOf(3, 18), "evening", "🔴 18:00 лишилась робочим часом");
  assert.equal(dayBucketOf(3, 20), "evening");
  assert.equal(dayBucketOf(3, 21), "night", "🔴 21:00 лишилась вечором");
  // 🔴 ВИХІДНІ ПЕРЕВІРЯЮТЬСЯ ПЕРШИМИ. Субота об 11:00 — це weekend, а не work.
  // Переставиш дві перші гілки — і вихідні мовчки розчиняться в робочому часі:
  // `work` виросте, `weekend` впаде до нуля, а СУМА лишиться тією самою.
  assert.equal(dayBucketOf(6, 11), "weekend", "🔴 субота об 11:00 стала робочим часом");
  assert.equal(dayBucketOf(0, 11), "weekend", "🔴 неділя об 11:00 стала робочим часом");
  assert.equal(dayBucketOf(0, 2), "weekend", "🔴 вихідні програли ночі");
  // Дзеркало: JS і SQL — одне правило, і воно живе в одному файлі.
  for (const b of DAY_BUCKETS) {
    assert.ok(dayBucketCase().includes(`'${b}'`), `🔴 відро ${b} зникло з SQL`);
  }
});

test("#437 ПОРОЖНІЙ ПЕРІОД НЕ ДОЇЖДЖАЄ ДО SQL", () => {
  // `BETWEEN NULL AND NULL` — не помилка: він чесно віддає НУЛЬ РЯДКІВ, і екран
  // показує «пропущених 0», що читається як чудова новина. Порожній результат —
  // провал, доки не доведено, що перевірці було що знаходити.
  const d = missedPeriod(null, null, "2026-09-15");
  assert.equal(d.to, "2026-09-15");
  assert.equal(d.from, "2026-08-17", `🔴 дефолтне вікно не ${String(MISSED_DEFAULT_DAYS)} днів`);
  // Обидва задані — проходять наскрізь, без «розумної» підміни.
  assert.deepEqual(missedPeriod("2026-01-01", "2026-01-31", "2026-09-15"),
    { from: "2026-01-01", to: "2026-01-31" });
  // Заданий лише кінець — вікно відлічується від НЬОГО, а не від сьогодні.
  assert.equal(missedPeriod(null, "2026-03-31", "2026-09-15").from, "2026-03-02",
    "🔴 вікно відлічилось від сьогодні, а не від обраного кінця періоду");
});

test("#438 МЕЖА: роут оголошений і в матриці, і в tab-гейті", () => {
  // DoD п.2: новий роут без запису в матриці — це «зелено там, куди ми не дивились»,
  // а без МЕЖІ він потрапляє у відому діру `/api/dashboard/*`. Потрібні обидва.
  const SRC = (rel: string): string =>
    readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
  assert.match(SRC("auth/routeTab.ts"), /pre\("\/api\/dashboard\/missed-calls"\), tabs: \["missed-calls"\]/,
    "🔴 роут лишився без tab-гейта — решта /api/dashboard/* живе без межі, і він став би ще одним");
  assert.match(SRC("auth/accessMatrix.ts"), /path: "\/api\/dashboard\/missed-calls"/,
    "🔴 роут зник із матриці доступу");
});

/**
 * #439 — ЄДИНИЙ ТУТ ГЕЙТ, ЯКИЙ СПРАВДІ ВИКОНУЄ SQL.
 *
 * 🔴 НАВІЩО ВІН ПОТРІБЕН ПОРУЧ ІЗ ВОСЬМОМА ВИЩЕ. Ті перевіряють ТЕКСТ запиту й
 * чисті функції; жоден із них не знає, чи Postgres узагалі виконає цей рядок.
 * Рівно так `core/dayItems.ts` колись пройшов `tsc` (SQL у шаблонному рядку не
 * типізується взагалі), пройшов усі 240 тестів — і впав би на першому ж кліку:
 * псевдонім `day` без `AS`. Тут таких псевдонімів немає, але гарантувати це
 * читанням — те саме, що гарантувати відсутність друкарської помилки уважністю.
 *
 * ⚠️ Кластер піднімається свій і ходить через `pg.Client` НАПРЯМУ, а не через
 * `db/pool.js`: той модульний синглтон, і `pool.end()` у чужому `finally` поклав
 * би 13 сусідніх тестів, жоден із яких до цього файлу стосунку не має.
 *
 * ⚠️ На ПРОД-сервері бінарів PostgreSQL немає (БД зовнішня, Neon) → чесний `skip`
 * із причиною через `skipReason()`, і запис у `ALLOWED_PROD_SKIPS`. У `npm test`
 * він ОБОВʼЯЗКОВИЙ.
 */
test("#439 ЖИВИЙ SQL: обидва запити виконуються на схемі з нуля, інваріанти сходяться", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING");
    await c.query("INSERT INTO managers(id,name,team_id,is_active) VALUES (1,'Яцик',1,true),(2,'Дмитрук',1,true) ON CONFLICT DO NOTHING");
    const rows: [string, string, string, string | null, number, number | null, string][] = [
      // два плеча ОДНОГО дзвінка (40 с < 120 с) → мусять стати одним
      ["u1", "2026-09-10 10:00:00+03", "in", "NO ANSWER", 0, 1, "+380501110001"],
      ["u2", "2026-09-10 10:00:40+03", "transitin", "NO ANSWER", 0, 1, "+380501110001"],
      // те саме БЕЗ МЕНЕДЖЕРА — випадок, який форма NOT EXISTS не склеює
      ["u3", "2026-09-10 11:00:00+03", "in", "NO ANSWER", 0, null, "+380501110002"],
      ["u4", "2026-09-10 11:00:30+03", "transitin", "NO ANSWER", 0, null, "+380501110002"],
      ["u5", "2026-09-10 12:00:00+03", "in", "BUSY", 0, 2, "+380501110003"],
      // чотири виключені — мусять бути названі, а не зникнути
      ["u6", "2026-09-10 13:00:00+03", "in", "VOICEMAIL", 0, 2, "+380501110004"],
      ["u7", "2026-09-10 13:10:00+03", "in", "CLIENT NO ANSWER", 0, 2, "+380501110005"],
      ["u8", "2026-09-10 13:20:00+03", "in", "ANSWERED", 0, 2, "+380501110006"],
      ["u9", "2026-09-10 13:30:00+03", "in", null, 0, 2, "+380501110007"],
      // 23:59 за Києвом в ОСТАННІЙ день періоду — межа, що колись ховала 251 угоду
      ["u10", "2026-09-15 23:59:00+03", "in", "NO ANSWER", 0, 1, "+380501110008"],
      ["u11", "2026-09-12 11:00:00+03", "in", "NO ANSWER", 0, 1, "+380501110009"],  // субота
      ["u12", "2026-09-10 14:00:00+03", "in", "ANSWERED", 95, 1, "+380501110010"],  // розмова
      ["u13", "2026-09-10 10:15:00+03", "out", "ANSWERED", 60, 1, "+380501110001"], // сам, +15 хв
      ["u14", "2026-09-10 11:30:00+03", "out", "ANSWERED", 45, 2, "+380501110002"], // колега, +30 хв
      ["u15", "2026-09-10 12:20:00+03", "in", "ANSWERED", 30, 2, "+380501110003"],  // клієнт сам
      // 🔴 ХВІСТ, БЕЗ ЯКОГО ФІКСТУРА НЕ ВІДРІЗНЯЄ МЕДІАНУ ВІД СЕРЕДНЬОГО: на двох
      // значеннях вони РІВНІ. Спіймано на собі під час перевірки. Тепер {15,30,600}.
      ["u16", "2026-09-11 09:00:00+03", "in", "NO ANSWER", 0, 2, "+380501110011"],
      ["u17", "2026-09-11 19:00:00+03", "out", "ANSWERED", 50, 2, "+380501110011"],
    ];
    for (const r of rows) {
      await c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,manager_id,client_phone)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)`, r);
    }
    const A = missedSummarySql("2026-08-17", "2026-09-15", {});
    const a = (await c.query(A.sql, A.params)).rows[0] as Record<string, string>;
    const B = missedByManagerSql("2026-08-17", "2026-09-15", {});
    const b = (await c.query(B.sql, B.params)).rows as { manager_id: number | null; missed: string }[];
    const n = (k: string): number => Number(a[k]);

    assert.equal(n("missed"), 6, "🔴 склейка або означення пропущеного зламані");
    assert.equal(n("ownerless"), 1, "🔴 плеча без менеджера не склеїлись — саме тут NOT EXISTS і бреше");
    assert.equal(n("excluded"), 4, "🔴 виключені зникли замість того, щоб назватись");
    assert.equal(n("callback"), 3);
    assert.equal(n("callback_self"), 2, "🔴 «передзвонив сам» розійшовся з «передзвонив колега»");
    assert.equal(n("callback_colleague"), 1);
    assert.equal(n("client_self"), 1, "🔴 клієнт, що передзвонив сам, зарахований як наш передзвін");
    assert.equal(n("b_weekend"), 1, "🔴 субота об 11:00 не потрапила у вихідні");
    assert.equal(n("median_min"), 30, "🔴 медіана {15,30,600} має бути 30; середнє тут дало б 215");

    // Три інваріанти, кожен ОДНИМ виміром — не «було N, стало N−5» на живому знаменнику.
    assert.equal(n("b_work") + n("b_evening") + n("b_weekend") + n("b_night"), n("missed"),
      "🔴 Σ відер ≠ пропущені — відро загубилось");
    assert.equal(b.reduce((s, r) => s + Number(r.missed), 0), n("missed"),
      "🔴 Σ рядків таблиці ≠ підсумок");
    assert.ok(b.some((r) => r.manager_id === null),
      "🔴 рядок «без відповідального» не приїхав із бази — а це 48.5% предмета");
  } finally { await c.end(); scratch.dispose(); }
});

test("#440 РОЛІ В МАТРИЦІ Й У СИДІ — ОДИН І ТОЙ САМИЙ СПИСОК", () => {
  /**
   * 🔴 ДВА СПИСКИ, ЯКІ ЗОБОВʼЯЗАНІ ЗБІГАТИСЬ, І НІХТО ЇХ НЕ ЗВІРЯЄ. Матриця каже,
   * кому роут МАЄ відповісти 200; сид у `schema.sql` вирішує, хто справді отримає
   * ключ екрана, а `roleHasTab` — fail-closed. Розійдуться — роль, дописана лише в
   * матрицю, дістане 403, і побачимо ми це аж на `acceptMatrix`, тобто після викату.
   *
   * ⚠️ Саме цей клас уже коштував проєкту: «UI дозволяє створити роль, а гейт вимагає
   * коміт» (борг 18) і `#15` червоний на прийманні наступного ж викату.
   */
  const SRC = (rel: string): string =>
    readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");

  const row = /path: "\/api\/dashboard\/missed-calls", cls: "GET",\s*\n\s*allow: \[([^\]]*)\]/
    .exec(SRC("auth/accessMatrix.ts"));
  assert.ok(row, "🔴 рядок матриці для /missed-calls не знайдено");
  const inMatrix = [...row[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

  const seed = /screen_access \|\| '\{"missed-calls":true\}'::jsonb\s*\n\s*WHERE key IN \(([^)]*)\)/
    .exec(SRC("db/schema.sql"));
  assert.ok(seed, "🔴 сид ключа екрана `missed-calls` не знайдено в schema.sql");
  const inSeed = [...seed[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

  assert.deepEqual(inMatrix, inSeed,
    `🔴 списки розійшлись — матриця обіцяє 200 тим, кому сид не дає ключа (або навпаки).`
    + ` Матриця: ${inMatrix.join(",")} · сид: ${inSeed.join(",")}`);
});

test("#454 КЛАМП: менеджер без manager_id бачить НІКОГО, а не всю компанію", async () => {
  const { missedScopeFor, missedSummarySql } = await import("./missedCallsRules.js");
  const mgr = (managerId: number | null) => ({ role: "manager", managerId, teamId: null });

  // 🔴 ДІРА, ЗАРАДИ ЯКОЇ ГЕЙТ. Без фолбеку тут був би null — і ядро пропустило б фільтр.
  assert.equal(missedScopeFor(mgr(null), {}).managerId, -1,
    "🔴 менеджер без manager_id отримав порожній скоуп — побачить дзвінки ВСІЄЇ компанії");

  // 🔴 І -1 МУСИТЬ СПРАВДІ ДАВАТИ ФІЛЬТР. Повернути -1 мало: якщо ядро вважає його
  // «фільтра немає», діра лишається під іншим числом (правило 7).
  const sql = missedSummarySql("2026-09-01", "2026-09-15", missedScopeFor(mgr(null), {})).sql;
  assert.match(sql, /rc\.manager_id = \$3/, "🔴 -1 не поставив фільтра — ядро прочитало його як «без обмежень»");

  // 🪞 ДЗЕРКАЛО: звичайний менеджер бачить себе, а не -1.
  assert.deepEqual(missedScopeFor(mgr(7), {}), { managerId: 7, teamId: null },
    "🔴 звичайний менеджер перестав бачити власні дзвінки");

  // Менеджер не розширює доступ параметрами запиту.
  assert.deepEqual(missedScopeFor(mgr(7), { managerId: "99", teamId: "3" }), { managerId: 7, teamId: null },
    "🔴 менеджер підставив чужий managerId у запит і побачив чужі дзвінки");

  // Тімлід без команди — теж «нікого», тімлід із командою — свою.
  assert.equal(missedScopeFor({ role: "team_lead", managerId: null, teamId: null }, {}).teamId, -1);
  assert.equal(missedScopeFor({ role: "team_lead", managerId: null, teamId: 3 }, { teamId: "9" }).teamId, 3,
    "🔴 тімлід підставив чужу команду в запит");

  // Адмін — те, що попросили.
  assert.deepEqual(missedScopeFor({ role: "admin", managerId: null, teamId: null }, { managerId: "5" }),
    { managerId: 5, teamId: null });
});

test("#449 ПІДРОУТИ ЕКРАНА — ТІ САМІ МЕЖІ, ЩО В ГОЛОВНОГО", () => {
  /**
   * Усі `/api/dashboard/missed-calls*` ловить ОДИН tab-гейт, тож сервер пускає роль у всі
   * одразу. Рядок матриці, що казав би про підроут інакше, був би неправдою — і першим же
   * `acceptMatrix` після викату розійшовся б із живим продом.
   */
  const SRC = (rel: string): string =>
    readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
  const src = SRC("auth/accessMatrix.ts");
  const rows = [...src.matchAll(
    /path: "(\/api\/dashboard\/missed-calls[^"]*)", cls: "GET",\s*\n\s*allow: \[([^\]]*)\], deny: \[([^\]]*)\]/g)];
  const norm = (x: string) => [...x.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort().join(",");
  // Порожній збіг — провал: без нього гейт зеленів би й тоді, коли рядків немає зовсім.
  assert.ok(rows.length >= 4, `🔴 знайдено лише ${String(rows.length)} рядків missed-calls у матриці — очікувалось 4`);
  const main = rows.find((r) => r[1] === "/api/dashboard/missed-calls");
  assert.ok(main, "🔴 головного рядка /api/dashboard/missed-calls не знайдено");
  for (const r of rows) {
    assert.equal(norm(r[2]), norm(main[2]), `🔴 ${r[1]}: allow розійшовся з головним роутом`);
    assert.equal(norm(r[3]), norm(main[3]), `🔴 ${r[1]}: deny розійшовся з головним роутом`);
  }
});

test("#450 «ЩО СТАЛОСЬ ДАЛІ» — НАЙРАНІША ПОДІЯ, І ЧОТИРИ ВІДПОВІДІ, А НЕ ДВІ", async () => {
  const { nextStep } = await import("./missedCallsRules.js");
  assert.deepEqual(nextStep({ cbMin: 15, cbTalked: true, csMin: null }), { kind: "callback_talked", minutes: 15 });
  assert.deepEqual(nextStep({ cbMin: 20, cbTalked: false, csMin: null }), { kind: "callback_no_answer", minutes: 20 },
    "🔴 передзвін без розмови назвався «додзвонились»");
  assert.deepEqual(nextStep({ cbMin: null, cbTalked: null, csMin: 40 }), { kind: "client_self", minutes: 40 });
  assert.deepEqual(nextStep({ cbMin: null, cbTalked: null, csMin: null }), { kind: "nothing", minutes: null });
  // 🔴 КЛІЄНТ БУВ ПЕРШИМ — це його швидкість, а не наша. Назвати це «ми передзвонили»
  // означало б приписати відділу чужу реакцію.
  assert.equal(nextStep({ cbMin: 40, cbTalked: true, csMin: 3 }).kind, "client_self",
    "🔴 клієнт передзвонив сам через 3 хв, а рядок записав це як наш передзвін через 40");
  // 🪞 І навпаки: ми були першими — наш передзвін, хоч клієнт теж потім набрав.
  assert.equal(nextStep({ cbMin: 3, cbTalked: true, csMin: 40 }).kind, "callback_talked");
  // Нічия — наш передзвін (ми діяли не пізніше).
  assert.equal(nextStep({ cbMin: 10, cbTalked: false, csMin: 10 }).kind, "callback_no_answer");
});

test("#451 «УГОДИ НЕМАЄ» — ТРИ СТАНИ, І «НЕ ЗНАЄМО, ХТО ДЗВОНИВ» НЕ Є «ЗАЯВКУ НЕ ЗАВЕЛИ»", async () => {
  const { noDealState, NO_DEAL_STATES, noDealCountsSql } = await import("./missedCallsRules.js");
  assert.equal(noDealState(null, false), "unknown");
  // 🔴 Сентинел: порожній і пробільний ключ — не ключ.
  assert.equal(noDealState("", false), "unknown", "🔴 порожній client_key записався в «клієнт є, заявки немає»");
  assert.equal(noDealState("   ", true), "unknown", "🔴 пробільний client_key прочитався як відомий клієнт");
  assert.equal(noDealState("k1", true), "has_deal");
  assert.equal(noDealState("k1", false), "no_deal");
  assert.deepEqual([...NO_DEAL_STATES], ["unknown", "has_deal", "no_deal"]);
  // Дзеркало в SQL: сентинел ловиться й там, а не лише в JS.
  assert.match(noDealCountsSql("2026-09-01", "2026-09-15", {}).sql, /btrim\(a\.client_key\) = ''/,
    "🔴 SQL-стан не бачить порожнього ключа — у базі він піде в «заявки немає»");
});

/**
 * #452 — ЖИВИЙ SQL БЛОКІВ C і D. Два правила, які без виконання не довести:
 *  ① розкриття = число: рядків у списку рівно стільки, скільки в числі поруч;
 *  ② межі вікна угоди — з ОБОХ боків (−1 доба в, −2 доби поза; рівно +7 в, +8 поза).
 * Кластер свій, через `pg.Client` напряму (не `db/pool.js` — його `end()` поклав би
 * сусідів). На проді бінарів PostgreSQL немає → чесний skip, записаний у реєстр.
 */
test("#452 ЖИВИЙ SQL БЛОКІВ C і D: розкриття == число, межі вікна угоди з обох боків", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const R = await import("./missedCallsRules.js");
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING");
    await c.query("INSERT INTO managers(id,name,team_id,is_active) VALUES (1,'Яцик',1,true),(2,'Дмитрук',1,true) ON CONFLICT DO NOTHING");
    const call = (id: string, at: string, type: string, disp: string | null, sec: number, mgr: number | null, phone: string, key: string | null) =>
      c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,manager_id,client_phone,client_key)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, at, type, disp, sec, mgr, phone, key]);
    const deal = (id: number, key: string, at: string) =>
      c.query("INSERT INTO deals(kommo_id, client_key, created_at_kommo) VALUES ($1,$2,$3)", [id, key, at]);

    // ── БЛОК C: день 2026-09-10 ──
    await call("m1", "2026-09-10 10:00:00+03", "in", "NO ANSWER", 0, 1, "P1", "k1");
    await call("m1cb", "2026-09-10 10:15:00+03", "out", "ANSWERED", 60, 1, "P1", "k1");      // наш, +15, розмова
    await call("m2", "2026-09-10 11:00:00+03", "in", "NO ANSWER", 0, 2, "P2", null);
    await call("m2cs", "2026-09-10 11:05:00+03", "in", "ANSWERED", 30, 2, "P2", null);       // клієнт сам, +5 — ПЕРШИЙ
    await call("m2cb", "2026-09-10 11:40:00+03", "out", "ANSWERED", 20, 2, "P2", null);      // наш, +40 — пізніше
    await call("m3", "2026-09-10 12:00:00+03", "in", "NO ANSWER", 0, null, "P3", "k3");
    await call("m4", "2026-09-10 12:00:40+03", "transitin", "NO ANSWER", 0, null, "P3", "k3"); // плече m3, без менеджера
    await call("m5", "2026-09-10 13:00:00+03", "in", "BUSY", 0, 1, "P4", null);
    await call("m5cb", "2026-09-10 13:20:00+03", "out", "NO ANSWER", 0, 1, "P4", null);      // наш, +20, без розмови
    await call("x1", "2026-09-10 14:00:00+03", "in", "VOICEMAIL", 0, 1, "P5", null);         // виключений — не в списку
    await deal(900, "k1", "2026-09-10 12:00:00+03");                                          // угода m1 у вікні

    // ── БЛОК D: відповідані вхідні 2026-09-05 ──
    await call("a1", "2026-09-05 10:00:00+03", "in", "ANSWERED", 50, 1, "Q1", null);        // unknown
    await call("a2", "2026-09-05 11:00:00+03", "in", "ANSWERED", 50, 1, "Q2", "   ");       // unknown (сентинел)
    await call("a3", "2026-09-05 12:00:00+03", "in", "ANSWERED", 50, 2, "Q3", "kd");
    await deal(901, "kd", "2026-09-04 13:00:00+03");                                          // −23 год → В вікні
    await call("a4", "2026-09-05 13:00:00+03", "in", "ANSWERED", 50, 2, "Q4", "ke");
    await deal(902, "ke", "2026-09-13 14:00:00+03");                                          // +8 діб 1 год → ПОЗА
    await call("a5", "2026-09-05 14:00:00+03", "in", "ANSWERED", 50, 1, "Q5", "kf");
    await deal(903, "kf", "2026-09-03 13:00:00+03");                                          // −2 доби → ПОЗА
    await call("a6", "2026-09-05 15:00:00+03", "in", "ANSWERED", 50, 1, "Q6", "kg");
    await call("a7", "2026-09-05 15:00:30+03", "transitin", "ANSWERED", 40, 1, "Q6", "kg");  // плече a6
    await deal(904, "kg", "2026-09-12 15:00:00+03");                                          // рівно +7 діб → В вікні

    // ① РОЗКРИТТЯ = ЧИСЛО, блок C
    const A = R.missedSummarySql("2026-09-10", "2026-09-10", {});
    const missed = Number((await c.query(A.sql, A.params)).rows[0].missed);
    const L = R.missedListSql("2026-09-10", {});
    const list = (await c.query(L.sql, L.params)).rows as { uniqueid: string; cb_min: string | null; cb_talked: boolean | null; cs_min: string | null; deal_id: string | null }[];
    assert.equal(missed, 4, "🔴 підсумок дня не той — склейка або означення зламані");
    assert.equal(list.length, missed, `🔴 у списку ${String(list.length)} рядків, а поруч число ${String(missed)} — розкриття сперечається з числом`);
    assert.ok(!list.some((r) => r.uniqueid === "m4"), "🔴 плече без менеджера не склеїлось і дало зайвий рядок");
    assert.ok(!list.some((r) => r.uniqueid === "x1"), "🔴 голосова пошта потрапила в список пропущених");

    const step = (id: string) => {
      const r = list.find((x) => x.uniqueid === id)!;
      return R.nextStep({ cbMin: r.cb_min == null ? null : Number(r.cb_min), cbTalked: r.cb_talked, csMin: r.cs_min == null ? null : Number(r.cs_min) });
    };
    assert.deepEqual(step("m1"), { kind: "callback_talked", minutes: 15 });
    assert.deepEqual(step("m2"), { kind: "client_self", minutes: 5 }, "🔴 клієнт був першим, а рядок назвав наш передзвін");
    assert.deepEqual(step("m3"), { kind: "nothing", minutes: null });
    assert.deepEqual(step("m5"), { kind: "callback_no_answer", minutes: 20 });
    assert.equal(list.find((x) => x.uniqueid === "m1")!.deal_id, "900", "🔴 угода клієнта у вікні не підтягнулась");

    // ② БЛОК D: партиція + межі вікна
    const D = R.noDealCountsSql("2026-09-01", "2026-09-15", {});
    const d = (await c.query(D.sql, D.params)).rows[0] as Record<string, number>;
    // m2cs теж відповіданий вхідний без ключа → unknown. a6+a7 — одне плече.
    assert.equal(Number(d.answered), 7, "🔴 відповідані вхідні пораховано неправильно (або плечі не склеїлись)");
    assert.equal(Number(d.unknown), 3, "🔴 невідомий номер (NULL або пробіли) не потрапив у «не знайдено в CRM»");
    assert.equal(Number(d.has_deal), 2, "🔴 межа вікна: −23 год або рівно +7 діб мали бути ВСЕРЕДИНІ");
    assert.equal(Number(d.no_deal), 2, "🔴 межа вікна: −2 доби або +8 діб мали бути ПОЗА");
    assert.equal(Number(d.unknown) + Number(d.has_deal) + Number(d.no_deal), Number(d.answered),
      "🔴 три стани не складаються в ціле — дзвінок провалився між станами");

    // ① РОЗКРИТТЯ = ЧИСЛО, блок D — для КОЖНОГО стану
    const key = { unknown: "unknown", has_deal: "has_deal", no_deal: "no_deal" } as const;
    for (const st of R.NO_DEAL_STATES) {
      const Q = R.noDealListSql("2026-09-01", "2026-09-15", {}, st);
      const n = (await c.query(Q.sql, Q.params)).rowCount;
      assert.equal(n, Number(d[key[st]]), `🔴 розкриття «${st}» дає ${String(n)} рядків, а число — ${String(d[key[st]])}`);
    }
  } finally { await c.end(); scratch.dispose(); }
});

test("#453 «СПИСОК ОБРІЗАНО» — ЛИШЕ КОЛИ ОБРІЗАНО: рівно стеля → ні, стеля + 1 → так", async () => {
  const { capRows, missedListSql, noDealListSql, MISSED_LIST_LIMIT } = await import("./missedCallsRules.js");
  const arr = (n: number) => Array.from({ length: n }, (_, i) => i);
  // По один бік межі: рядків рівно стільки, скільки стеля — показано все, «обрізано» неправда.
  assert.equal(capRows(arr(5), 5).truncated, false,
    "🔴 рівно стеля рядків — а екран каже «список обрізаний», хоча показав усе");
  assert.equal(capRows(arr(5), 5).rows.length, 5);
  // По другий: на один більше — обрізано, і показано рівно стелю.
  assert.equal(capRows(arr(6), 5).truncated, true, "🔴 зайвий рядок прийшов, а обрізання не визнано");
  assert.equal(capRows(arr(6), 5).rows.length, 5, "🔴 показано більше за стелю");
  assert.equal(capRows([], 5).truncated, false);
  // І запит мусить брати той самий зайвий рядок — інакше доказу обрізання не буде ніколи.
  for (const sql of [missedListSql("2026-09-15", {}).sql, noDealListSql("2026-09-01", "2026-09-15", {}, "no_deal").sql]) {
    assert.ok(sql.includes(`LIMIT ${String(MISSED_LIST_LIMIT + 1)}`),
      "🔴 запит бере рівно стелю — обрізання неможливо відрізнити від повного списку");
  }
});

/* ═══════════════════════ ХВОСТИ ТЗ-1 (звірка 16.09.2026, прохід 17.09.2026) ═══════════════════════ */

/**
 * #471 — РЯДОК КОМАНДИ І ЧЕСНИЙ «БЕЗ ВІДПОВІДАЛЬНОГО» У ЗРІЗІ КОМАНДИ.
 * Чисте правило: хто «Поза командами», де він стоїть, «не передзвонили» як похідне, і
 * прапорець, що забороняє показувати тімліду нуль там, де правда — «не входить у зріз».
 */
test("#471 КОМАНДИ: «Поза командами» названо й останнім; «без відповідального» є лише у зрізі компанії", async () => {
  const R = await import("./missedCallsRules.js");
  const rows = R.foldTeamRows([
    { teamId: null, name: null, missed: 50, callbackSelf: 10, callbackColleague: 5, clientSelf: 1, medianMin: 9 },
    { teamId: 2, name: "РНК", missed: 7, callbackSelf: 3, callbackColleague: 1, clientSelf: 0, medianMin: 20 },
    { teamId: 1, name: "РПК", missed: 30, callbackSelf: 12, callbackColleague: 6, clientSelf: 4, medianMin: 15 },
    { teamId: 5, name: null, missed: 1, callbackSelf: 0, callbackColleague: 0, clientSelf: 0, medianMin: null },
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["РПК", "РНК", "Команда #5", R.NO_TEAM_LABEL],
    "🔴 команди не за спаданням, або «Поза командами» вліз у рейтинг, або безіменна команда лишилась порожньою");
  assert.deepEqual(rows.map((r) => r.noCallback), [12, 3, 1, 35], "🔴 «не передзвонили» команди рахується неправильно");

  assert.equal(R.ownerlessInScope({}), true, "🔴 у зрізі компанії «без відповідального» сховано — це половина предмета");
  assert.equal(R.ownerlessInScope({ managerId: null, teamId: null }), true);
  assert.equal(R.ownerlessInScope({ teamId: 3 }), false, "🔴 тімлід побачить «Без відповідального: 0» — такі дзвінки в зріз команди не входять");
  assert.equal(R.ownerlessInScope({ managerId: 5 }), false, "🔴 менеджер побачить «Без відповідального: 0»");
  assert.equal(R.ownerlessInScope({ managerId: -1 }), false, "🔴 порожній кламп менеджера читається як «уся компанія»");

  const team = R.missedByTeamSql("2026-09-01", "2026-09-15", {}).sql;
  assert.match(team, /(?<!LEFT )JOIN managers mg ON mg\.id = w\.manager_id/, "🔴 рядки команд без звʼязки з менеджером");
  assert.doesNotMatch(team, /LEFT JOIN managers mg ON mg\.id = w\.manager_id/, "🔴 рядки команд тягнуть «без відповідального» (LEFT JOIN)");
  assert.match(team, /PERCENTILE_CONT\(0\.5\)/, "🔴 медіана команди перестала бути медіаною");
});

/** Три запити блоку A/B ОДНИМ оператором — одна мить, одна знімка бази (правило 18). */
function oneShotSql(R: typeof import("./missedCallsRules.js"), from: string, to: string, s: import("./missedCallsRules.js").MissedScope) {
  const A = R.missedSummarySql(from, to, s), B = R.missedByManagerSql(from, to, s), C = R.missedByTeamSql(from, to, s);
  assert.deepEqual([B.params, C.params], [A.params, A.params], "🔴 будівники нумерують параметри по-різному — один оператор неможливий");
  return {
    sql: `SELECT (SELECT row_to_json(a) FROM (${A.sql}) a) AS s,
                 (SELECT coalesce(json_agg(b), '[]'::json) FROM (${B.sql}) b) AS m,
                 (SELECT coalesce(json_agg(c), '[]'::json) FROM (${C.sql}) c) AS t`,
    params: A.params,
  };
}

type OneShot = {
  s: Record<string, number | string | null>;
  m: { manager_id: number | null; team_id: number | null; missed: number; callback_self: number; callback_colleague: number; client_self: number }[];
  t: { team_id: number | null; team_name: string | null; missed: number; callback_self: number; callback_colleague: number; client_self: number; median_min: number | null }[];
};

/** Інваріанти ТЗ §1.6 п.2 на одному знімку. Спільні для фікстури й живої бази. */
function assertInvariants(r: OneShot, where: string): void {
  const missed = Number(r.s.missed);
  const buckets = ["b_work", "b_evening", "b_weekend", "b_night"].reduce((n, k) => n + Number(r.s[k]), 0);
  assert.equal(buckets, missed, `🔴 ${where}: Σ чотирьох частин доби (${String(buckets)}) ≠ пропущені (${String(missed)})`);
  const sumM = r.m.reduce((n, x) => n + Number(x.missed), 0);
  assert.equal(sumM, missed, `🔴 ${where}: Σ рядків менеджерів разом із «без відповідального» (${String(sumM)}) ≠ «всього» (${String(missed)})`);
  const ownerless = r.m.filter((x) => x.manager_id === null).reduce((n, x) => n + Number(x.missed), 0);
  assert.equal(ownerless, Number(r.s.ownerless), `🔴 ${where}: рядок «без відповідального» ≠ плитка`);
  const sumT = r.t.reduce((n, x) => n + Number(x.missed), 0);
  assert.equal(sumT + ownerless, missed, `🔴 ${where}: Σ команд (${String(sumT)}) + без відповідального (${String(ownerless)}) ≠ «всього» (${String(missed)})`);
  for (const t of r.t) {
    const mine = r.m.filter((x) => x.manager_id !== null && x.team_id === t.team_id);
    for (const k of ["missed", "callback_self", "callback_colleague", "client_self"] as const) {
      const sum = mine.reduce((n, x) => n + Number(x[k]), 0);
      assert.equal(sum, Number(t[k]), `🔴 ${where}: команда ${String(t.team_name ?? t.team_id)} · ${k}: Σ менеджерів ${String(sum)} ≠ рядок команди ${String(t[k])}`);
    }
  }
}

/**
 * #460 — ЖИВИЙ SQL КОМАНД І ПРИЙМАННЯ §1.6 п.2–3 НА ФІКСТУРІ.
 *  · один оператор: Σ відер = Σ рядків = «всього», Σ команд + без відповідального = «всього»,
 *    Σ менеджерів команди = рядок команди по кожній адитивній колонці;
 *  · медіана команди — медіана її дзвінків, а не середнє медіан людей;
 *  · менеджер без команди — «Поза командами», а не зниклий;
 *  · зріз команди: «без відповідального» 0 і прапорець каже «не входить», а не «немає»;
 *  · межа доби за Києвом з ОБОХ боків: 31.12 23:59 лишається в 31.12, 01.01 00:30 (ще 31.12 за
 *    UTC) — у 01.01. Сама лише 23:59 цієї межі не стереже: за UTC це той самий день.
 */
test("#460 ЖИВИЙ SQL КОМАНД: інваріанти одним оператором, медіана команди, межа київської доби", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const R = await import("./missedCallsRules.js");
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК'),(2,'РНК') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES
      (1,'Яцик',1,true),(2,'Дмитрук',1,true),(3,'Мокляк',2,true),(4,'Без команди',NULL,true) ON CONFLICT DO NOTHING`);
    let seq = 0;
    const call = (at: string, type: string, disp: string | null, sec: number, mgr: number | null, phone: string) =>
      c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,manager_id,client_phone)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`, [`v${String(++seq)}`, at, type, disp, sec, mgr, phone]);
    // РПК: Яцик {10}, Дмитрук {20, 90} → медіана команди {10,20,90} = 20; середнє медіан людей (10+55)/2 = 32.5
    await call("2026-09-10 10:00:00+03", "in", "NO ANSWER", 0, 1, "P1"); await call("2026-09-10 10:10:00+03", "out", "ANSWERED", 30, 1, "P1");
    await call("2026-09-10 11:00:00+03", "in", "BUSY", 0, 2, "P2"); await call("2026-09-10 11:20:00+03", "out", "ANSWERED", 30, 1, "P2");
    await call("2026-09-10 12:00:00+03", "in", "NO ANSWER", 0, 2, "P3"); await call("2026-09-10 13:30:00+03", "out", "NO ANSWER", 0, 2, "P3");
    await call("2026-09-10 14:00:00+03", "in", "NO ANSWER", 0, 3, "P4");                                      // РНК, без передзвону
    await call("2026-09-10 15:00:00+03", "in", "NO ANSWER", 0, 4, "P5");                                      // поза командами
    await call("2026-09-10 16:00:00+03", "in", "NO ANSWER", 0, null, "P6");                                   // без відповідального
    await call("2026-09-10 16:00:30+03", "transitin", "NO ANSWER", 0, null, "P6");                            // його плече
    await call("2026-09-10 17:00:00+03", "in", "ANSWERED", 60, 3, "P7");                                      // розмова — не пропущений

    const run = async (from: string, to: string, s: import("./missedCallsRules.js").MissedScope) => {
      const q = oneShotSql(R, from, to, s);
      return (await c.query(q.sql, q.params)).rows[0] as OneShot;
    };
    const all = await run("2026-09-10", "2026-09-10", {});
    assert.equal(Number(all.s.missed), 6, "🔴 фікстура дала не 6 пропущених — гейт нічого не доводить");
    assertInvariants(all, "фікстура");
    const rpk = all.t.find((x) => x.team_id === 1);
    assert.equal(Number(rpk?.missed), 3);
    assert.equal(Math.round(Number(rpk?.median_min)), 20, "🔴 медіана команди — не медіана її дзвінків (32.5 = середнє медіан людей)");
    assert.ok(all.t.some((x) => x.team_id === null && Number(x.missed) === 1), "🔴 менеджер без команди зник із рядків команд");

    const team1 = await run("2026-09-10", "2026-09-10", { teamId: 1 });
    assertInvariants(team1, "зріз команди");
    assert.equal(Number(team1.s.ownerless), 0);
    assert.equal(R.ownerlessInScope({ teamId: 1 }), false, "🔴 у зрізі команди нуль «без відповідального» покажеться як правда");

    // Межа київської доби з обох боків.
    await call("2025-12-31 23:59:00+02", "in", "NO ANSWER", 0, 1, "P8");
    await call("2026-01-01 00:30:00+02", "in", "NO ANSWER", 0, 1, "P9");
    const dec31 = await run("2025-12-31", "2025-12-31", {});
    const jan1 = await run("2026-01-01", "2026-01-01", {});
    assert.equal(Number(dec31.s.missed), 1, "🔴 31.12 23:59 за Києвом вийшов за межу свого дня");
    assert.equal(Number(jan1.s.missed), 1, "🔴 01.01 00:30 за Києвом ліг у 31.12 — день рахується за UTC");
    assert.equal(Number(jan1.s.b_night), 1, "🔴 00:30 не потрапило в «ніч»");
  } finally { await c.end(); scratch.dispose(); }
});

/**
 * #461 — ПРИЙМАННЯ §1.6 п.2 НА ЖИВІЙ БАЗІ, ОДНИМ ОПЕРАТОРОМ. Останні 7 повних днів.
 * Фікстура (#460) доводить, що правило вміє сходитись; цей гейт — що воно сходиться на
 * справжніх даних, де є все, чого фікстура не вигадала (менеджери, що змінили команду,
 * плечі з трьох записів, NULL-номери).
 */
test("#461 ЖИВА БД: Σ відер = Σ рядків = всього, Σ команд + без відповідального = всього — одним оператором", needsBackendEnv(), async (t) => {
  const R = await import("./missedCallsRules.js");
  const { pool } = await import("../db/pool.js");
  const { emptyPeriodSkip } = await import("../testMode.js");
  const { kyivToday } = await import("./dates.js");
  const day = (n: number): string => { const d = new Date(`${kyivToday()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const q = oneShotSql(R, day(7), day(1), {});
  const r = (await pool.query(q.sql, q.params)).rows[0] as OneShot;
  const skip = emptyPeriodSkip("пропущених вхідних", Number(r.s.missed), `${day(7)}…${day(1)}`);
  if (skip) return t.skip(skip);
  assertInvariants(r, `жива БД ${day(7)}…${day(1)}`);
});
