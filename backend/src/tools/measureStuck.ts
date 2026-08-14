import { pool } from "../db/pool.js";
import { stuckDealsGrouped } from "../core/metrics.js";
import { STUCK_MIN_DAYS } from "../core/stuckRule.js";

/**
 * 📏 ЖИВИЙ ЗАМІР РОЗМІРУ СПИСКУ ЗАСТРЯГЛИХ НА КІЛЬКОХ ПОРОГАХ.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ ІНСТРУМЕНТ, А НЕ РАЗОВИЙ SQL. Власник обирає поріг (14/21/30)
 * проти ЖИВОГО списку — тобто число, за яким ухвалюється рішення, мусить приходити
 * з ТОГО САМОГО коду, що малює екран. Разовий SQL «за тим самим сенсом» — це друга
 * копія правила, і вона розійдеться рівно там, де ми цього не побачимо. Тому тут
 * викликається `stuckDealsGrouped`, а не переписаний запит.
 *
 * 🔴 І ЗАМІР МАЄ ВЛАСНИЙ ДЕТЕКТОР. Числа беруться ДВІЧІ й різними шляхами:
 *   • прямим викликом на кожному порозі;
 *   • з розподілу «днів без руху», знятого ОДНИМ викликом на порозі 1.
 * Обидва шляхи мусять збігтись до одиниці. Розійшлись — замір НЕ друкується, а
 * падає: мовчазно неправильне число тут гірше за його відсутність, бо за ним
 * ухвалять рішення про поріг.
 *
 * ⚠️ СВІЖІСТЬ НАЗИВАЄТЬСЯ ВГОЛОС. Якщо на момент заміру якийсь із анкерних синків
 * відстав, список заморожений на моменті синку — і число, зняте тоді, описує вчора,
 * а не сьогодні. Тому `asOf`/`asOfStale` друкуються поруч із числами, а не десь.
 *
 * КОМАНДА (на сервері, де лежить `.env`):
 *   cd backend && set -a && . ./.env && set +a \
 *     && TEST_SCOPE=prod node --import ./dist/testReadOnly.js dist/tools/measureStuck.js
 *
 * `--import ./dist/testReadOnly.js` — не формальність: він садить зʼєднання в роль
 * `test_readonly`, тож інструмент фізично не може нічого записати.
 */

export interface StuckMeasure {
  minDays: number;
  total: number;
  sumRisk: number;
  managers: number;
  over90: number;
}

export interface StuckReport {
  asOf: string;
  asOfStale: boolean;
  asOfAgeMin: number;
  asOfJob: string | null;
  /** Уся «спрацьована» популяція у скоупі — знаменник, від якого рахуються пороги. */
  population: number;
  measures: StuckMeasure[];
  /** Розподіл «днів без руху» по всій популяції — щоб бачити криву, а не три точки. */
  histogram: { from: number; to: number | null; count: number }[];
}

const BUCKETS: [number, number | null][] = [
  [1, 6], [7, 13], [14, 20], [21, 29], [30, 59], [60, 89], [90, null],
];

/**
 * ⚠️ `fetch` — шов РІВНО ДЛЯ ГЕЙТА, і дефолт у ньому справжній. Детектор нижче
 * («два шляхи до одного числа») можна довести лише тим, що при розбіжності він
 * ПАДАЄ; ESM-неймспейс підмінити не можна (заморожений), тож підміна заходить сюди.
 * Прод-шлях параметра не передає ніколи.
 */
export async function measureStuck(thresholds: number[] = [14, 21, 30],
  fetch: typeof stuckDealsGrouped = stuckDealsGrouped): Promise<StuckReport> {
  // Поріг 1 = вся популяція, яку правило взагалі вважає «вели і не рухають».
  const all = await fetch({}, 1);
  const days = all.groups.flatMap((g) => g.deals.map((d) => d.days));
  if (!days.length)
    throw new Error("measureStuck: популяція ПОРОЖНЯ. Це провал заміру, а не «нуль застряглих» — "
      + "перевір скоуп статусів, мапінг воронок і те, чи взагалі є дані в цій базі.");

  const measures: StuckMeasure[] = [];
  for (const md of thresholds) {
    const g = await fetch({}, md);
    // 🔴 ДЕТЕКТОР: те саме число, здобуте з розподілу. Розбіжність = мовчазна поломка.
    const derived = days.filter((d) => d >= md).length;
    if (derived !== g.total)
      throw new Error(`measureStuck: на порозі ${md} прямий виклик дав ${g.total}, `
        + `а розподіл — ${derived}. Два шляхи до одного числа розійшлись — замір недійсний.`);
    measures.push({ minDays: md, total: g.total, sumRisk: Math.round(g.sumRisk),
      managers: g.managers, over90: g.over90 });
  }

  return {
    asOf: all.asOf, asOfStale: all.asOfStale, asOfAgeMin: all.asOfAgeMin, asOfJob: all.asOfJob,
    population: days.length,
    measures,
    histogram: BUCKETS.map(([from, to]) => ({ from, to,
      count: days.filter((d) => d >= from && (to == null || d <= to)).length })),
  };
}

function print(r: StuckReport): void {
  const stale = r.asOfStale
    ? `⚠️ ЗАСТАРІЛО (${r.asOfJob ?? "?"} мовчить ${r.asOfAgeMin} хв) — список заморожений, `
      + "число описує момент синку, а не зараз"
    : "свіжо";
  console.log(`\nДані станом на ${r.asOf} · ${stale}`);
  console.log(`Популяція у скоупі (вели, не рухають ≥1 дн.): ${r.population}\n`);
  console.log("поріг │ угод │ ₴ в ризику │ менеджерів │ >90 дн.");
  console.log("──────┼──────┼────────────┼────────────┼────────");
  for (const m of r.measures)
    console.log(`${String(m.minDays).padStart(5)} │ ${String(m.total).padStart(4)} │ `
      + `${m.sumRisk.toLocaleString("uk-UA").padStart(10)} │ ${String(m.managers).padStart(10)} │ ${m.over90}`);
  console.log("\nРозподіл «днів без руху» (уся популяція):");
  for (const b of r.histogram)
    console.log(`  ${String(b.from).padStart(3)}–${b.to == null ? "∞  " : String(b.to).padEnd(3)} ${String(b.count).padStart(5)}`);
  console.log(`\nДефолт у коді зараз: STUCK_MIN_DAYS = ${STUCK_MIN_DAYS} (стартове значення для заміру, не рішення).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    // 🔒 ЧИТАННЯ — І ТОЧКА. Перевіряємо РОЛЬ, а не намір: preload міг не підвантажитись
    // (саме так «TEST_SCOPE=prod npm test» колись пішов би в прод із правом на запис).
    if (process.env.TEST_SCOPE === "prod") {
      const u = await pool.query<{ u: string }>("SELECT current_user AS u");
      if (u.rows[0]?.u !== "test_readonly")
        throw new Error(`measureStuck: зʼєднання в ролі «${u.rows[0]?.u}», а не test_readonly. `
          + "Запускати ЛИШЕ через `node --import ./dist/testReadOnly.js`.");
    }
    const arg = process.argv.find((a) => a.startsWith("--days="));
    const thresholds = arg ? arg.split("=")[1].split(",").map(Number).filter((n) => n > 0) : undefined;
    print(await measureStuck(thresholds));
  })()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
