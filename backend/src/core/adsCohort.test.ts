import { test, after } from "node:test";
import assert from "node:assert/strict";
import { needsBackendEnv } from "../testMode.js";

/**
 * 🧮 #392–#392b — СКЛАД РЕКЛАМНОЇ КОГОРТИ СХОДИТЬСЯ, І РОЗКРИТТЯ НЕ СПЕРЕЧАЄТЬСЯ З ЧИСЛОМ.
 *
 * 🔴 ЩО САМЕ СТЕРЕЖЕТЬСЯ І ЧОМУ ЦЕ НЕ ОЧЕВИДНО. Екран «Реклама» показує чотири числа
 * дня: узято · у роботі · дійшли до грошей · оплачено. Три з них — НОВІ (09.09.2026), і
 * рахуються вони фільтрами по `status_id` усередині спільного `dealCohortCte`. Якщо в
 * когорті трапиться статус, якого я не врахував, розклад тихо перестане сходитись:
 * кожне число окремо виглядатиме правдоподібно, а сума — ні. Саме так поводяться всі
 * помилки цього класу в проєкті («31 менеджер, чипи на 37»).
 *
 * 🔴 ЧОМУ РІВНІСТЬ, А НЕ «≥ N». Правило, куплене `#56b`/`#61b`: перевірка, привʼязана
 * до наявності даних, червоніє за календарем і за два тижні її починають гортати очима.
 * `inWork + paid + lost == entered` істинне і при 212 лідах, і при нулі — воно про
 * СКЛАД, а не про обсяг. Порожній період чесно скіпається з названою причиною.
 *
 * ⚠️ ЖИВА БД, БО ФІКСТУРА ТУТ НІЧОГО НЕ ДОВЕЛА Б. Предмет перевірки — чи покривають
 * три фільтри ВСІ статуси, які реально трапляються в когорті. Сіяна фікстура містила б
 * рівно ті статуси, які я в неї поклав, тобто доводила б мою ж гіпотезу (урок
 * `pg-copy-streams`: саботаж підтверджує лише те, що фікстура моделює).
 */

/** Вікно заміру: місяць — достатньо, щоб когорта була непорожня в будь-який день року. */
const FROM = "2026-07-01";
const TO = "2026-07-31";

/**
 * 🔴 ПУЛ ЗАКРИВАЄТЬСЯ ОДИН РАЗ НА ФАЙЛ, І ЦЕ КУПЛЕНО ДВІЧІ ЗА ОДНУ СЕСІЮ.
 * `db/pool.js` — модульний СИНГЛТОН, тож `pool.end()` у тілі першого тесту лишає
 * другий без зʼєднання: він падає з «Cannot use a pool after calling end on the pool»
 * ще на `getSettings`, НЕ дійшовши до жодного твердження. Найгірше тут те, що вивід
 * виглядає як провал ПЕРЕВІРКИ, хоча перевірка не виконувалась — тобто червоне
 * означало «тест зламаний», а читалось як «продукт зламаний».
 */
after(async () => {
  const { pool } = await import("../db/pool.js");
  await pool.end().catch(() => {});
});

test("#392 ЖИВА БД: у роботі + оплачено + втрачено == узято в роботу, по КОЖНОМУ дню", needsBackendEnv(), async (t) => {
  const { pool } = await import("../db/pool.js");
  const { getSettings } = await import("../routes/settings.js");
  const metrics = await import("./metrics.js");
  const { emptyPeriodSkip } = await import("../testMode.js");

  const { adSources } = await getSettings();
  const days = await metrics.conversionAdsByDay({ from: FROM, to: TO }, adSources);

  const total = days.reduce((s, d) => s + d.entered, 0);
  const skip = emptyPeriodSkip("платних лідів у вікні заміру", total, `${FROM}..${TO}`);
  if (skip) return t.skip(skip);

  // Розклад мусить бути ТОЧНИМ: кожна угода когорти рівно в одному стані.
  const broken = days
    .filter((d) => d.inWork + d.paid + d.lost !== d.entered)
    .map((d) => `${d.day}: узято ${d.entered} ≠ ${d.inWork} у роботі + ${d.paid} оплачено + ${d.lost} втрачено`);
  assert.deepEqual(broken, [],
    "🔴 склад когорти не сходиться — у ній є статус, якого не покриває жоден із трьох фільтрів. "
    + "Числа на екрані лишаться правдоподібними, а сума перестане бути правдою");

  // 🪞 ДЗЕРКАЛО, без якого перевірка була б однобокою: `won` (грошова зона) МУСИТЬ
  // перетинатися з `inWork` — «Виставлення рахунку» вже в грошах, але угода ще жива.
  // Якби won став підмножиною paid, це означало б, що межу MONEY_ZONE тихо звузили.
  const anyOverlap = days.some((d) => d.won > d.paid);
  assert.ok(anyOverlap,
    "🔴 у жодному дні `дійшли до грошей` не перевищує `оплачено` — це означає, що грошова "
    + "зона звузилась до 142, і підпис «дійшли до грошей» на екрані став неправдою");
});

test("#392b ЖИВА БД: склад розкриття дня == числу в комірці, поіменно", needsBackendEnv(), async (t) => {
  const { pool } = await import("../db/pool.js");
  const { getSettings } = await import("../routes/settings.js");
  const metrics = await import("./metrics.js");
  const { emptyPeriodSkip } = await import("../testMode.js");

  const { adSources } = await getSettings();
  const days = await metrics.conversionAdsByDay({ from: FROM, to: TO }, adSources);
  const busiest = [...days].sort((a, b) => b.entered - a.entered)[0];

  const skip = emptyPeriodSkip("платних лідів у вікні заміру", busiest?.entered ?? 0, `${FROM}..${TO}`);
  if (skip) return t.skip(skip);

  const deals = await metrics.adDealsByDay(busiest.day, adSources);

  // Правило «розкриття пояснює число, а не сперечається з ним»: склад і лічильник
  // мусять рахуватись ТИМ САМИМ виразом. Тут це перевіряється рівністю, а не «схожістю».
  assert.equal(deals.length, busiest.entered,
    `🔴 ${busiest.day}: у комірці ${busiest.entered}, а в розкритті ${deals.length} угод — `
    + "склад і число розійшлись, тобто хтось із них пішов власним предикатом");

  // І стани в розкритті мусять давати ті самі три числа, що й лічильник.
  const byState = { paid: 0, lost: 0, inWork: 0 };
  for (const d of deals) byState[d.state] += 1;
  assert.deepEqual(byState, { paid: busiest.paid, lost: busiest.lost, inWork: busiest.inWork },
    `🔴 ${busiest.day}: стани в розкритті не збігаються з лічильником — те саме число `
    + "рахується двома різними способами");
});
