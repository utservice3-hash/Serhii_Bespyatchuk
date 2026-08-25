import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { skipReason, type Scratch, type Unavailable } from "../db/scratchDb.js";

/**
 * 🗓 #220–#220c — МЕХАНІЗМ ТИЖНЕВОЇ ЦІЛІ, ПЕРЕВІРЕНИЙ НЕЗАЛЕЖНО ВІД ДНЯ ТИЖНЯ.
 *
 * 🔴 ПРИВІД: ГЕЙТ, ЩО ЧЕРВОНІВ ЗА КАЛЕНДАРЕМ. `#56b` і `#61b` вимагали «≥3 ручних
 * тижневих цілей ПРЯМО ЗАРАЗ» від живого прода. Заміряно 25.08.2026 на бойовій базі:
 * 92.4% тижневих парасольок (85 із 92) закінчуються В ПʼЯТНИЦЮ, а нові тімліди
 * заводять щопонеділка о 08:44-09:24. Отже щосуботи й щонеділі таких цілей **нуль**,
 * і в понеділок до ~09:00 теж нуль — реконструкція по днях за 6 тижнів дала рівно
 * цей візерунок без жодного винятку. Тобто обидва гейти були червоні **~30% часу**
 * не через дефект, а через день тижня.
 *
 * 🔴 ЧОМУ ЦЕ ГІРШЕ ЗА ВІДСУТНІЙ ГЕЙТ. Перевірку, що червоніє не з нашої вини, за два
 * тижні починають гортати очима — рівно так ми зняли `#137e`. Гейт, який ігнорують,
 * не стереже нічого, але створює відчуття, що стереже.
 *
 * ✅ ЩО ЗМІНЕНО: механізм переїхав СЮДИ, на scratch-БД із власною фікстурою. Період
 * парасольки сіється як `сьогодні−3 … сьогодні+3`, тож покриття існує в БУДЬ-ЯКИЙ
 * день — і саботаж підміни `manual ?? dynamic` червоніє в суботу так само, як у
 * вівторок. Живі дані перевіряє `#221`, але вже РІВНІСТЮ, а не кількістю.
 *
 * ⚠️ ЧЕСНА МЕЖА, СКАЗАНА ВГОЛОС: день-незалежність тут **за побудовою фікстури**, а
 * не «перевірена в суботу» — я прогонив ці гейти у вівторок. Фікстура не питає, який
 * сьогодні день; вона будує період ВІД нього.
 *
 * ⚠️ ДРУГА МЕЖА: на прод-сервері бінарів PostgreSQL немає, тож тут буде чесний `skip`
 * із причиною. Саме тому `npm test` (дев) записаний ОКРЕМИМ КРОКОМ у процедуру
 * деплою — інакше цей гейт стеріг би те, що можуть не запустити.
 *
 * 🔴 `core/plans.ts` НЕ ЧІПАВСЯ ЖОДНИМ РЯДКОМ — це файл контракту (CLAUDE.md:479-483).
 * Кличеться справжня `effectiveWeekTargets`, а не її переказ; саботаж під час
 * приймання накладається тимчасово й відкочується.
 */

const SCHEMA = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
/** Кластер один на файл: піднімати другий — це класти спільний пул (CLAUDE.md). */
let shared: Scratch | Unavailable | null = null;
/** Чи дійшло до імпорту ядра — інакше закривати нічого. */
let poolUsed = false;

/** Сьогодні по-київськи — те саме, що передає роут (`dashboard.ts`). */
const kyivToday = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const shift = (iso: string, days: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

interface Umbrella { kind: string | null; amount: number; from: string; to: string }

/**
 * Готує чисту базу з мінімальним набором, якого вимагає ланцюг
 * `effectiveWeekTargets → dynamicTarget → managerPlan`: команда, АКТИВНИЙ менеджер і
 * місячний план (без плану менеджер не потрапляє в `dyn`, а отже й у видачу).
 */
async function seed(url: string, umbrellas: Umbrella[]): Promise<void> {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await c.query(readFileSync(SCHEMA, "utf8"));
    const month = kyivToday().slice(0, 7) + "-01";
    await c.query("INSERT INTO teams (id, name) VALUES (77, 'Тест-команда') ON CONFLICT DO NOTHING");
    await c.query("INSERT INTO managers (id, name, team_id, is_active) VALUES (701, 'Тестовий Менеджер', 77, true)");
    await c.query(
      "INSERT INTO plans (manager_id, plan_date, metric, planned_value) VALUES (701, $1, 'payment_amount', 100000)",
      [month]);
    for (const u of umbrellas) {
      await c.query(
        `INSERT INTO tasks (title, status, assignee_id, task_type, auto, period_kind, period_start, period_end, metrics_json)
         VALUES ('парасолька', 'not_started', 701, 'kpi_period', true, $1, $2, $3, $4::jsonb)`,
        [u.kind, u.from, u.to, JSON.stringify([{ metric: "payment_amount", target: u.amount }])]);
    }
  } finally {
    await c.end();
  }
}

/** Піднімає кластер (один на файл) і віддає готовий до виклику модуль ядра. */
async function coreWith(t: { skip: (r: string) => void }, umbrellas: Umbrella[]) {
  if (!shared) {
    const { provisionScratch } = await import("../db/scratchDb.js");
    shared = provisionScratch();
  }
  // 🔴 ЧЕРЕЗ `skipReason`, А НЕ СИРИМ РЯДКОМ. «Немає бінарів PostgreSQL» (норма на
  //    проді) і «кластер не піднявся» (оточення зламалось) — РІЗНІ речі: другий несе
  //    маркер, яким вартовий знімає дозвіл навіть із зареєстрованого скіпу. Сирий
  //    рядок стер би цю різницю, і `#220*` у реєстрі прикрили б справжню поломку —
  //    рівно та діра, яку закрив Б2 у `scratchDb.ts`.
  if ("unavailable" in shared) { t.skip(skipReason(shared)); return null; }
  // ⚠️ `plans.js` тягне `db/pool.js` → `config.js`, який кидає на відсутньому
  // DATABASE_URL ще НА ІМПОРТІ, тож змінні ставимо ДО імпорту (пастка з CLAUDE.md).
  process.env.DATABASE_URL = shared.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  await seed(shared.url, umbrellas);
  poolUsed = true;
  return await import("./plans.js");
}

const WEEK = (amount: number): Umbrella => {
  const t = kyivToday();
  return { kind: "week", amount, from: shift(t, -3), to: shift(t, 3) };
};

/**
 * #220 — РУЧНА ЦІЛЬ ПЕРЕКРИВАЄ ДИНАМІЧНУ, ЯКИЙ БИ НЕ БУВ ДЕНЬ.
 *
 * 🧨 САБОТАЖ: у `core/plans.ts` замінити `man != null ? man : dynamic` на `dynamic` —
 * гейт червоніє в будь-який день тижня, бо покриття тут своє, а не з календаря прода.
 */
test("#220 ручна тижнева ціль перекриває динамічну — незалежно від дня тижня", async (t) => {
  const plans = await coreWith(t, [WEEK(15000)]);
  if (!plans) return;
  const month = kyivToday().slice(0, 7) + "-01";
  const eff = await plans.effectiveWeekTargets({ month }, kyivToday());

  const row = eff.get(701);
  assert.ok(row, "🔴 менеджера немає у видачі — фікстура не дійшла до `dyn`, перевіряти нічого");
  assert.equal(row.isManual, true, "🔴 тижнева парасолька не прочиталась як ручна ціль");
  assert.equal(row.manual, 15000);
  assert.equal(row.target, 15000, "🔴 ручна ціль НЕ перекрила динамічну — це і є той саботаж");

  // ⚠️ Порожній результат = ПРОВАЛ: якби `dynamic` випадково дорівнював 15000,
  // перекриття було б невидиме, і зелений колір нічого не означав би.
  assert.notEqual(row.dynamic, 15000,
    `🔴 динамічна ціль збіглася з ручною (${row.dynamic}) — на такій фікстурі підміну не видно`);
});

/**
 * #220b — МІСЯЧНА ПАРАСОЛЬКА НЕ СТАЄ ТИЖНЕВОЮ ЦІЛЛЮ.
 *
 * 🔴 Це те покриття, яке `#61b` давав лише в будні: баг «Андрусенко 0 / 135к», де
 * тижневою ціллю підставився МІСЯЧНИЙ план до копійки.
 *
 * 🔴 ФІКСТУРА СІЄ ЛИШЕ МІСЯЧНУ, І ЦЕ НЕ СПРОЩЕННЯ — ЦЕ УМОВА ВІДТВОРЕННЯ. Перша
 * редакція сіяла ОБИДВІ (тижневу й місячну) і була БЕЗЗУБОЮ: `ORDER BY period_start
 * ASC, id ASC` разом із `manual.set()` віддає перемогу останньому рядку, а місячна
 * починається раніше — тож тижнева вигравала навіть із прибраним фільтром, і саботаж
 * лишався зеленим. Спіймано саботажем, не читанням. У самого бага тижневої задачі не
 * було ЗОВСІМ — саме тому місячна й пролізла.
 *
 * 🧨 САБОТАЖ: прибрати `period_kind = 'week'` із запиту в `plans.ts` — гейт червоніє,
 * бо місячні 135 000 стають «ручною тижневою ціллю».
 */
test("#220b місячна парасолька, що покриває сьогодні, не підставляється як тижнева", async (t) => {
  const t0 = kyivToday();
  const monthStart = t0.slice(0, 7) + "-01";
  const monthEnd = shift(new Date(Date.UTC(Number(t0.slice(0, 4)), Number(t0.slice(5, 7)), 1))
    .toISOString().slice(0, 10), -1);
  const plans = await coreWith(t, [{ kind: "month", amount: 135000, from: monthStart, to: monthEnd }]);
  if (!plans) return;

  const row = (await plans.effectiveWeekTargets({ month: monthStart }, t0)).get(701);
  assert.ok(row, "🔴 менеджера немає у видачі");
  // ⚠️ Непорожність ПЕРЕД читанням нуля: місячна парасолька справді покриває сьогодні,
  // інакше «ручної цілі немає» було б істинним із зовсім іншої причини.
  assert.ok(monthStart <= t0 && t0 <= monthEnd, "🔴 фікстура не покриває сьогодні — гейт вироджений");
  assert.equal(row.isManual, false,
    `🔴 місячна парасолька стала ручною тижневою ціллю (${row.manual}) — це баг «Андрусенко 0/135к»`);
  assert.equal(row.target, row.dynamic, "🔴 при відсутності ТИЖНЕВОЇ цілі має стояти динамічна");
});

/**
 * #220c — FAIL-CLOSED: нерозпізнаний тип періоду в ручну ціль НЕ потрапляє.
 *
 * Краще показати динамічний план, ніж чужу цифру з підписом «задано вручну».
 *
 * 🧨 САБОТАЖ: послабити фільтр до `period_kind IS DISTINCT FROM 'month'` — гейт
 * червоніє, бо парасолька без типу почне вигравати.
 */
test("#220c парасолька без period_kind не стає ручною ціллю", async (t) => {
  const t0 = kyivToday();
  const plans = await coreWith(t, [{ kind: null, amount: 99999, from: shift(t0, -3), to: shift(t0, 3) }]);
  if (!plans) return;

  const row = (await plans.effectiveWeekTargets({ month: t0.slice(0, 7) + "-01" }, t0)).get(701);
  assert.ok(row, "🔴 менеджера немає у видачі");
  assert.equal(row.isManual, false,
    `🔴 ціль без типу періоду прочиталась як ручна (${row.manual}) — fail-closed зламано`);
  assert.equal(row.target, row.dynamic, "🔴 при відсутності ручної цілі має стояти динамічна");
});

/**
 * 🔴 ПУЛ ЗАКРИВАЄМО ПЕРЕД ЗНЯТТЯМ КЛАСТЕРА. Інакше `dispose()` гасить postmaster, а
 * відкриті зʼєднання `db/pool.js` падають із «Connection terminated unexpectedly» —
 * і файл повертає ненульовий код при ТРЬОХ зелених гейтах. Спіймано першим же
 * прогоном; той самий порядок стоїть у `core/stuckTalk.test.ts:110-112`.
 */
test.after(async () => {
  if (poolUsed) await (await import("../db/pool.js")).pool.end();
  if (shared && !("unavailable" in shared)) shared.dispose();
});
