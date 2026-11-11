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
  /**
   * 🔴 ХУК ТЕЖ МУСИТЬ БУТИ ЛІНИВИМ — І САМЕ ТУТ Я ЦЕ ЗАБУВ (виправлено 14.09.2026).
   * Правило «імпорти в БД-тестах ліниві» я застосував усередині тестів і проґавив у
   * `after`: він імпортував `db/pool.js` БЕЗУМОВНО, а `config.js` кидає на відсутньому
   * `DATABASE_URL` ще НА ІМПОРТІ. Наслідок асиметричний і тому підступний: обидва гейти
   * чесно скіпались із названою причиною, а САМ ФАЙЛ падав — тобто вивід казав
   * «✖ adsCohort.test.js» без жодного тексту, і це читалось як зламаний продукт, а не як
   * зламаний тест. На стенді й проді `.env` є, тож воно не спливало ніде, крім машини
   * розробника — того самого місця, де перевірку й запускають найчастіше.
   */
  if (!process.env.DATABASE_URL) return;
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

/**
 * #3311 — «НАДІЙШЛО ПО ДНЯХ» == ПЛИТЦІ «ЗАРОБИЛИ» (Роман 02.11.2026). Колонка «Надійшло» — поденна розкладка того самого
 * числа, що стоїть у плитці, тож Σ днів мусить дорівнювати `receivedByChannel(...).ad` гривня в гривню й угода в угоду.
 * Обидві сторони беруться в одну мить (правило 18). Рівність, а не кількість — істинна й на порожньому вікні.
 * 🧨 Червоніє, якщо поденна функція піде своїм фільтром (не `adDealSql`), іншим анкером дня чи загубить угоди без менеджера.
 */
test("#3311 ЖИВА БД: Σ «надійшло» по днях == плитці «Заробили», гривня й угода", needsBackendEnv(), async (t) => {
  const { getSettings } = await import("../routes/settings.js");
  const money = await import("./money.js");
  const { emptyPeriodSkip } = await import("../testMode.js");
  const { adSources } = await getSettings();
  const [days, tile] = await Promise.all([money.adReceivedByDay({ from: FROM, to: TO }, adSources),
    money.receivedByChannel({ from: FROM, to: TO }, adSources)]);
  const skip = emptyPeriodSkip("грошей із реклами у вікні заміру", tile.ad.deals, `${FROM}..${TO}`);
  if (skip) return t.skip(skip);
  const sum = days.reduce((s, d) => ({ revenue: s.revenue + d.revenue, deals: s.deals + d.deals }), { revenue: 0, deals: 0 });
  assert.deepEqual([Math.round(sum.revenue * 100), sum.deals], [Math.round(tile.ad.revenue * 100), tile.ad.deals],
    `🔴 Σ днів ${String(sum.revenue)} ₴ / ${String(sum.deals)} угод ≠ плитці ${String(tile.ad.revenue)} ₴ / ${String(tile.ad.deals)} угод`);
  const busiest = [...days].sort((a, b) => b.deals - a.deals)[0];
  const one = await money.receivedByChannel({ from: busiest.day, to: busiest.day }, adSources);
  assert.deepEqual([busiest.revenue, busiest.deals], [one.ad.revenue, one.ad.deals],
    `🔴 ${busiest.day}: рядок дня не дорівнює плитці, обраній на цей один день`);
});

/**
 * #3312 — «ПРИНЕСЛИ ЛІДИ ДНЯ» == Σ ЦІН «ОПЛАЧЕНО» В РОЗКРИТТІ, ПО КОЖНОМУ ДНЮ (правило «розкриття пояснює число»).
 * Обидва рахуються тим самим `pop` (`dealCohortCte`), тож рівність — за побудовою, і гейт стереже, щоб так і лишилось.
 * 📐 Перша редакція звіряла ОДИН день (найбільше оплачених) — і саботаж «рахувати й неоплачені» лишив її ЗЕЛЕНОЮ: у тому
 * дні угоди «в роботі» мали нульову ціну. Тому тепер — КОЖЕН день вікна, плюс доказ, що у вікні є неоплачені угоди з
 * ненульовою ціною (інакше рівність не відрізняла б «лише 142» від «усі»).
 * 🧨 Червоніє, якщо гроші когорти рахувати іншим фільтром (не 142) чи іншою популяцією, ніж розкриття.
 */
test("#3312 ЖИВА БД: «принесли ліди дня» == Σ цін угод «Оплачено» в розкритті, по кожному дню", needsBackendEnv(), async (t) => {
  const { getSettings } = await import("../routes/settings.js");
  const metrics = await import("./metrics.js");
  const { emptyPeriodSkip } = await import("../testMode.js");
  const { adSources } = await getSettings();
  const days = (await metrics.conversionAdsByDay({ from: FROM, to: TO }, adSources)).filter((d) => d.entered > 0);
  const skip = emptyPeriodSkip("оплачених угод із платних лідів у вікні заміру", days.reduce((s, d) => s + d.paid, 0), `${FROM}..${TO}`);
  if (skip) return t.skip(skip);
  const broken: string[] = [];
  let pricedNotPaid = 0;
  for (const d of days) {
    const deals = await metrics.adDealsByDay(d.day, adSources);
    const paidSum = deals.filter((x) => x.state === "paid").reduce((s, x) => s + x.price, 0);
    pricedNotPaid += deals.filter((x) => x.state !== "paid" && x.price !== 0).length;
    if (Math.round(d.paidMargin * 100) !== Math.round(paidSum * 100)) broken.push(`${d.day}: колонка ${String(d.paidMargin)} ₴ ≠ Σ «Оплачено» ${String(paidSum)} ₴`);
  }
  assert.deepEqual(broken, [], "🔴 «принесли ліди дня» розійшлись із розкриттям — гроші когорти рахуються не тим фільтром чи не тією популяцією");
  // 🪞 Без цього рівність вище не відрізняла б «лише оплачені» від «усі угоди дня».
  assert.ok(pricedNotPaid > 0, "у вікні немає жодної неоплаченої угоди з ціною — гейт не має чого ловити, вікно треба змінити");
});

/**
 * #3313 — СКЛАД «НАДІЙШЛО ЦЬОГО ДНЯ» == ЧИСЛУ В КОЛОНЦІ, ПО КОЖНОМУ ДНЮ (Роман 05.11.2026: «кнопка, яка показує, за які
 * угоди надійшли гроші»). Обидва беруться однією вибіркою `adReceivedFrom`, тож рівність — за побудовою; гейт стереже,
 * щоб так і лишилось. 🧨 Червоніє, якщо список піде своїм фільтром, іншим анкером дня чи загубить угоду без назви.
 */
test("#3313 ЖИВА БД: склад «надійшло цього дня» == числу в колонці, гривня й угода, по кожному дню", needsBackendEnv(), async (t) => {
  const { getSettings } = await import("../routes/settings.js");
  const money = await import("./money.js");
  const { emptyPeriodSkip } = await import("../testMode.js");
  const { adSources } = await getSettings();
  const days = (await money.adReceivedByDay({ from: FROM, to: TO }, adSources)).filter((d) => d.deals > 0);
  const skip = emptyPeriodSkip("грошей із реклами у вікні заміру", days.length, `${FROM}..${TO}`);
  if (skip) return t.skip(skip);
  const broken: string[] = [];
  for (const d of days) {
    const list = await money.adReceivedDeals(d.day, adSources);
    const sum = list.reduce((s, x) => s + x.price, 0);
    if (list.length !== d.deals || Math.round(sum * 100) !== Math.round(d.revenue * 100)) {
      broken.push(`${d.day}: колонка ${String(d.revenue)} ₴ / ${String(d.deals)} угод ≠ список ${String(sum)} ₴ / ${String(list.length)} угод`);
    }
  }
  assert.deepEqual(broken, [], "🔴 склад «надійшло» розійшовся з колонкою — список рахується не тією вибіркою");
});

/**
 * #3314 — «ЗАРОБИЛИ ЛІДИ» == «НАДІЙШЛО» ЗА ВЕСЬ ЧАС (задача #8702). Ті самі угоди й та сама маржа, лише день — дата ліда,
 * а не дата грошей. Тож без меж дат обидві суми рівні гривня в гривню й угода в угоду (обидві беруться в одну мить).
 * 🧨 Червоніє, якщо «заробили» піде іншим фільтром, загубить угоди без менеджера чи копія з двома батьками подвоїться.
 */
test("#3314 ЖИВА БД: Σ «заробили ліди» за весь час == Σ «надійшло» за весь час, гривня й угода", needsBackendEnv(), async () => {
  const { getSettings } = await import("../routes/settings.js");
  const money = await import("./money.js");
  const { adSources } = await getSettings();
  const [earned, received] = await Promise.all([money.adEarnedByDay({}, adSources), money.adReceivedByDay({}, adSources)]);
  const e = earned.reduce((s, r) => ({ rev: s.rev + r.earned, n: s.n + r.deals }), { rev: 0, n: 0 });
  const r = received.reduce((s, x) => ({ rev: s.rev + x.revenue, n: s.n + x.deals }), { rev: 0, n: 0 });
  assert.deepEqual([Math.round(e.rev * 100), e.n], [Math.round(r.rev * 100), r.n],
    `🔴 заробили ${String(e.rev)} ₴ / ${String(e.n)} угод ≠ надійшло ${String(r.rev)} ₴ / ${String(r.n)} угод`);
});

/**
 * #3314b — СКЛАД «ЗАРОБИЛИ ЛІДИ ДНЯ» == ЧИСЛУ ДНЯ, по кожному дню вікна (правило «розкриття пояснює число»).
 * 🧨 Червоніє, якщо список угод дня піде своєю вибіркою, а не `adEarnedFrom`.
 */
test("#3314b ЖИВА БД: склад «заробили ліди дня» == числу дня, по кожному дню", needsBackendEnv(), async (t) => {
  const { getSettings } = await import("../routes/settings.js");
  const money = await import("./money.js");
  const { emptyPeriodSkip } = await import("../testMode.js");
  const { adSources } = await getSettings();
  const days = (await money.adEarnedByDay({ from: FROM, to: TO }, adSources)).filter((d) => d.key !== null && d.deals > 0);
  const skip = emptyPeriodSkip("заробленого лідами реклами у вікні заміру", days.length, `${FROM}..${TO}`);
  if (skip) return t.skip(skip);
  const broken: string[] = [];
  for (const d of days) {
    const list = await money.adEarnedDeals(d.key as string, adSources);
    const sum = list.reduce((s, x) => s + x.price, 0);
    if (list.length !== d.deals || Math.round(sum * 100) !== Math.round(d.earned * 100)) {
      broken.push(`${String(d.key)}: число ${String(d.earned)} ₴ / ${String(d.deals)} ≠ список ${String(sum)} ₴ / ${String(list.length)}`);
    }
  }
  assert.deepEqual(broken, [], "🔴 склад «заробили ліди дня» розійшовся з числом дня");
});

/**
 * #3314c — КАМПАНІЇ СХОДЯТЬСЯ З ПЛИТКАМИ: Σ «заробили» по кампаніях (з рядком «без мітки») == Σ по днях, і Σ лідів по
 * кампаніях == Σ «Узято» ядра за той самий період. 🧨 Червоніє, якщо мітка кампанії загубить або подвоїть угоди.
 */
test("#3314c ЖИВА БД: кампанії (з «без мітки») == дні: гроші й «Узято»", needsBackendEnv(), async (t) => {
  const { getSettings } = await import("../routes/settings.js");
  const money = await import("./money.js");
  const metrics = await import("./metrics.js");
  const { emptyPeriodSkip } = await import("../testMode.js");
  const { adSources } = await getSettings();
  const s = { from: FROM, to: TO };
  const [byCamp, byDay, leadsCamp, leadsDay] = await Promise.all([money.adEarnedByCampaign(s, adSources), money.adEarnedByDay(s, adSources),
    metrics.adLeadsByCampaign(s, adSources), metrics.conversionAdsByDay(s, adSources)]);
  const skip = emptyPeriodSkip("рекламних лідів у вікні заміру", leadsDay.reduce((x, d) => x + d.entered, 0), `${FROM}..${TO}`);
  if (skip) return t.skip(skip);
  const sum = (rows: { earned: number }[]) => Math.round(rows.reduce((x, r) => x + r.earned, 0) * 100);
  assert.equal(sum(byCamp), sum(byDay), "🔴 гроші по кампаніях не сходяться з грошима по днях");
  assert.equal(leadsCamp.reduce((x, r) => x + r.leads, 0), leadsDay.reduce((x, d) => x + d.entered, 0),
    "🔴 ліди по кампаніях не сходяться з «Узято»");
});

/**
 * #3316 — КЛІЄНТИ З РЕКЛАМИ НА ЖИВІЙ БАЗІ (#8709): Σ по кампаніях == плитці, постійні в списку == Σ постійних кампаній,
 * типи не більші за постійних, маржа постійних == Σ маржі списку. 🧨 Червоніє, якщо клієнт подвоїться між кампаніями
 * (не DISTINCT ON першого ліда) чи список постійних піде своїм правилом.
 */
test("#3316 ЖИВА БД: клієнти з реклами — кампанії == плитці, список постійних == Σ постійних", needsBackendEnv(), async (t) => {
  const { getSettings } = await import("../routes/settings.js");
  const { adClients } = await import("./adClients.js");
  const { emptyPeriodSkip } = await import("../testMode.js");
  const { adSources } = await getSettings();
  const r = await adClients(FROM, TO, adSources);
  const skip = emptyPeriodSkip("клієнтів з першим рекламним лідом у вікні заміру", r.totals.clients, `${FROM}..${TO}`);
  if (skip) return t.skip(skip);
  const sum = (k: "clients" | "regular" | "regularMargin") => r.campaigns.reduce((s, c) => s + c[k], 0);
  assert.equal(sum("clients"), r.totals.clients, "🔴 клієнти по кампаніях ≠ плитці — клієнт подвоївся чи загубився");
  assert.equal(sum("regular"), r.regulars.length, "🔴 постійні по кампаніях ≠ списку постійних");
  assert.equal(Math.round(sum("regularMargin") * 100), Math.round(r.regulars.reduce((s, c) => s + c.margin, 0) * 100), "🔴 маржа постійних не сходиться");
  assert.ok(r.campaigns.every((c) => c.vip + c.regularSeg + c.episodic <= c.regular), "🔴 типів більше, ніж постійних");
  assert.equal(new Set(r.regulars.map((c) => c.clientKey)).size, r.regulars.length, "🔴 клієнт двічі в списку постійних");
});
