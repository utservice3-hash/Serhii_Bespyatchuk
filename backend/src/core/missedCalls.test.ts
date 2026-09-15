import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyCall, isMissed, foldManagerRows, missedPeriod, missedSummarySql, missedByManagerSql,
  OWNERLESS_LABEL, MISSED_DEFAULT_DAYS, type MissedManagerRaw,
} from "./missedCallsRules.js";
import { dayBucketOf, dayBucketCase, DAY_BUCKETS } from "./dayBuckets.js";

/**
 * #421…#428 — ПРОПУЩЕНІ ВХІДНІ (ТЗ-1, 14.09.2026).
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

test("#421 ОЗНАЧЕННЯ: пропущений — це вхідний, нульовий, із NO ANSWER або BUSY", () => {
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

test("#421b ДЗЕРКАЛО: те, що НЕ пропущене, називає себе, а не мовчить", () => {
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

test("#422 СКЛЕЙКА: форма з LAG, і вона рахується ПІСЛЯ звуження до вхідних", () => {
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

test("#423 КИЇВ: межа періоду і межа доби — обидві за Києвом", () => {
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

test("#424 БЕЗ ВІДПОВІДАЛЬНОГО: окремий рядок, і Σ рядків == «всього»", () => {
  const raw: MissedManagerRaw[] = [
    { managerId: 7, name: "Яцик", missed: 10, callbackSelf: 4, callbackColleague: 2, clientSelf: 3, medianMin: 12 },
    { managerId: null, name: null, missed: 20, callbackSelf: 0, callbackColleague: 9, clientSelf: 5, medianMin: 40 },
    { managerId: 9, name: "Дмитрук", missed: 5, callbackSelf: 1, callbackColleague: 1, clientSelf: 0, medianMin: 8 },
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

test("#425 МЕДІАНА, А НЕ СЕРЕДНЄ", () => {
  // Заміряно 15.09.2026: медіана 19 хв, середнє 183 хв — майже вдесятеро. Розподіл
  // хвостатий, і ціль «з 60% до 36%», поставлена на середньому, міряла б хвіст.
  for (const sql of [S(), missedByManagerSql("2026-08-17", "2026-09-15", {}).sql]) {
    assert.match(sql, /PERCENTILE_CONT\(0\.5\) WITHIN GROUP/,
      "🔴 медіана зникла");
    assert.doesNotMatch(sql, /AVG\s*\(/i,
      "🔴 з'явилось середнє — воно покаже 183 хв там, де робота відділу це 19 хв");
  }
});

test("#426 ВІДРА ДОБИ: приклад по ОБИДВА боки кожної межі", () => {
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

test("#427 ПОРОЖНІЙ ПЕРІОД НЕ ДОЇЖДЖАЄ ДО SQL", () => {
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

test("#428 МЕЖА: роут оголошений і в матриці, і в tab-гейті", () => {
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
 * #429 — ЄДИНИЙ ТУТ ГЕЙТ, ЯКИЙ СПРАВДІ ВИКОНУЄ SQL.
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
test("#429 ЖИВИЙ SQL: обидва запити виконуються на схемі з нуля, інваріанти сходяться", async (t) => {
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
