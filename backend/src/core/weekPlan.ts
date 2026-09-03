import { pool } from "../db/pool.js";
import { fixedWeekBlocks, workingDaysBetween, monthEndOf } from "./dates.js";
import { weekPlanOf, weekWorkingDays } from "./weekPlanMath.js";
import { receivedByMgr } from "./money.js";

/**
 * 🗓 ДИНАМІЧНИЙ ПЛАН ТИЖНЯ (рішення власника 06.08.2026).
 *
 * Місячний план розподіляється на тижні, а недобір або перевиконання
 * автоматично перерозподіляються на період, що ЛИШИВСЯ:
 *
 *     planWeek = залишок × (робочих днів у цьому тижні)
 *                        ÷ (робочих днів від початку тижня до кінця місяця)
 *     залишок  = план місяця − факт ② на ПОЧАТОК тижня
 *
 * 🔴 БАЗИС — РОБОЧІ ДНІ, А НЕ «ТИЖНІ, ЩО ЛИШИЛИСЬ». Це не стилістика, це
 * різниця між досяжною й недосяжною ціллю. Останній «тиждень» серпня 2026 —
 * це ОДИН день (31.08, понеділок). Поділ залишку на кількість тижнів дав би
 * цьому дню ПОВНУ тижневу норму, тобто ціль, яку фізично не виконати. Поділ
 * на робочі дні дає йому його одноденну частку.
 *
 * Наслідок, який і є перевіркою: за робочими днями ДЕННИЙ ТЕМП цілі однаковий
 * у всіх тижнях місяця (`залишок ÷ робочих днів, що лишились`), за тижнями —
 * ні, і саме обрізаний тиждень вилітає в рази. На цьому стоїть гейт `#48b`.
 *
 * 📐 Приклад власника, план 100 000, серпень 2026 (21 робочий день) — звірено:
 *   Т1 03–07 (5 дн): 100 000 × 5/21 = 23 810
 *   Т2 10–14 (5 дн): залишок 80 000 × 5/16 = 25 000
 *   Т3 17–21 (5 дн): залишок 55 000 × 5/11 = 25 000
 *   Т5 31.08 (1 дн): залишок × 1/1 — рівно своя одноденна частка
 *
 * 🔴 ОДИН КАЛЕНДАР НА ВЕСЬ ПРОДУКТ. Робочі дні беруться з `workingDaysBetween`
 * (`core/dates.ts`) — ТОГО САМОГО джерела, що живить «треба ₴/день» і «17 дн.»
 * на картці менеджера. Другий календар тут не заводиться: два календарі — це
 * дві правди, і розходяться вони мовчки.
 *
 * ⚠️ І ЦЕ ТРЕБА СКАЗАТИ ВГОЛОС, А НЕ «ПОЛАГОДИТИ МОВЧКИ»: `workingDaysBetween`
 * рахує Пн–Пт і **держсвята НЕ враховує**. Поруч у `plans.ts` живе
 * `presentWorkingDaysByManager`, який свята враховує (і ще віднімає погоджені
 * відсутності), але він per-manager і живить ІНШУ величину («день»). Тобто
 * розбіжність у продукті вже є, і вона НЕ створена цим кодом. Вирівнювати обидва
 * календарі — окреме рішення власника: воно зрушить «треба ₴/день» на всіх
 * екранах одразу, тож робити його побічним ефектом тижневого плану не можна.
 */

// Формула живе в `weekPlanMath.ts` (чистий модуль, без БД) — і ре-експортується
// звідси, щоб споживачі мали ОДНУ точку входу, а гейти могли перевіряти арифметику
// без `DATABASE_URL`. Див. коментар там: розділення не косметичне.
export { weekPlanOf, weekWorkingDays } from "./weekPlanMath.js";
export type { WeekPlanInput, WeekPlanResult } from "./weekPlanMath.js";

export interface WeekPlanRow {
  managerId: number;
  weekStart: string;
  plan: number;
  overPlan: number;
  monthPlan: number;
  factBefore: number;
  wdWeek: number;
  wdRest: number;
  /** `null` — рахується наживо (тиждень ще не почався); інакше — звідки знімок. */
  source: "live" | "backfill" | null;
  /** Знімок ВІДНОВЛЕНО ретроспективно, а не збережено в момент. Чесна межа, видима в UI. */
  reconstructed: boolean;
}

/** Київська дата «сьогодні» — той самий вираз, що всюди в ядрі. */
async function kyivToday(): Promise<string> {
  const r = await pool.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'Europe/Kyiv')::date,'YYYY-MM-DD') d`);
  return r.rows[0].d;
}

/**
 * 🔴 ЧИТАННЯ НЕ ПИШЕ. ФУНКЦІЯ БІЛЬШЕ НЕ ВМІЄ МОРОЗИТИ — НЕ «за замовчуванням», А ВЗАГАЛІ.
 *
 * 📐 ЗАМІРЯНО НА ПРОДІ 03.09.2026, ОБИДВІ ПОЛОВИНИ ОДНИМ ПРОГОНОМ. Ця функція мала
 * `opts.freeze` з дефолтом «морозити», і два ЧИТАЛЬНІ шляхи його не передавали:
 * `effectiveWeekTargets` (а через неї `/report-plan`, `/kvp-report`, `/manager-report`)
 * і `/kvp-report` напряму. Тобто відкриття екрана ПИСАЛО в базу.
 *
 * Наслідок, спійманий гейтом `#211f` і доведений заміром:
 *     GET /kvp-report за ЛИПЕНЬ під роллю test_readonly
 *     → error: permission denied for table weekly_plan_snapshots
 *       at freezeWeekPlans (weekPlan.js:164) <- weekPlansForMonth <- effectiveWeekTargets
 *
 * 🔑 І ЧОМУ ЦЕ ВИГЛЯДАЛО ВИПАДКОВИМ. Морозиться пара (АКТИВНИЙ менеджер × тиждень).
 * Менеджер, найнятий пізніше, не має рядків за раніші місяці — отже КОЖЕН місяць до
 * його найму пише на першому ж читанні. Під повними правами воно тихо добиває рядки,
 * місяць стає повним, і червоне зникає само. Одноразове червоне, що самолікується, —
 * тобто рівно те, що читається як флак. Заміряно: серпень 290 рядків при очікуваних
 * 300, найсвіжіший перший знімок — 01.08.2026; вікно гейта (серпень) через це зелене,
 * а липень червонів.
 *
 * ⚠️ ЧОМУ ПРИБРАНО ОПЦІЮ, А НЕ ПОСТАВЛЕНО `freeze: false` У ДВОХ ВИКЛИКАХ. Прапорець
 * із дефолтом «писати» — це запрошення повернути дефект: наступний виклик, написаний
 * через місяць, знову його не передасть. Тепер ЄДИНИЙ писар — `backfillWeekPlans`,
 * і він викликається джобою, а не екраном.
 */
/**
 * План тижня для всіх менеджерів у скоупі, із ЗАМОРОЖЕННЯМ.
 *
 * Порядок навмисний: спершу дивимось у знімки, і лише за їх відсутності рахуємо.
 * Тиждень, який ВЖЕ почався і знімка не має, фіксується тут-таки — інакше перший
 * же перегляд екрана після понеділка давав би вже поповзле число.
 *
 * ⚠️ ЧАСОВИЙ ПОЯС — КИЇВ, і це не формальність: добу телефонії ми вже одного разу
 * втратили на `getUTC*`. «Тиждень почався» вирішує КИЇВСЬКА дата з БД, а не дата
 * процесу.
 */
export async function weekPlansForMonth(
  scope: { managerId?: number | null; teamId?: number | null },
  monthStart: string,
  /**
   * Місячний план по менеджеру — ПАРАМЕТРОМ, а не імпортом `plans.managerPlan`.
   * 🔴 Це не стиль: `plans.ts` кличе цей модуль, тож імпорт у зворотний бік дав би
   * цикл `plans ↔ weekPlan`. Рантайм-безпечний цикл у нас уже є (`money ↔ metrics`),
   * і саме тому другий заводити не варто — там він неминучий, тут його можна просто
   * не створювати. Заразом видно, що `plans-grid` лишається ЄДИНИМ джерелом місячного
   * плану: тижневий похідний від нього і власного плану не має.
   */
  planByMgr: Map<number, number>,
): Promise<WeekPlanRow[]> {
  const today = await kyivToday();
  const weeks = fixedWeekBlocks(monthStart);
  const monthEnd = monthEndOf(monthStart);
  const ids = [...planByMgr.keys()].filter((id) => !scope.managerId || id === scope.managerId);
  if (!ids.length) return [];

  const snapRes = await pool.query<{ manager_id: number; week_start: string; plan: string; month_plan: string; fact_before: string; working_days_week: number; working_days_rest: number; source: "live" | "backfill" }>(
    `SELECT manager_id, to_char(week_start,'YYYY-MM-DD') week_start, plan, month_plan, fact_before,
            working_days_week, working_days_rest, source
       FROM weekly_plan_snapshots WHERE month_start = $1 AND manager_id = ANY($2)`, [monthStart, ids]);
  const snaps = new Map(snapRes.rows.map((r) => [`${r.manager_id}:${r.week_start}`, r]));

  // Факт ② «на початок тижня» = з 1-го числа до дня ПЕРЕД стартом тижня. Один
  // запит на тиждень (≤6 на місяць) — свідомо, бо `receivedByMgr` не вміє віддати
  // наростаючий підсумок по днях одним викликом, а писати сюди власний SQL по
  // виручці ЗАБОРОНЕНО: гроші рахує лише ядро.
  const factBefore = new Map<string, number>();
  for (const w of weeks) {
    if (w.from <= monthStart) continue;                    // перший блок: фактів «до» немає
    const prevEnd = new Date(w.from + "T00:00:00Z"); prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
    const rows = await receivedByMgr({ from: monthStart, to: prevEnd.toISOString().slice(0, 10), teamId: scope.teamId ?? null, managerId: scope.managerId ?? null });
    for (const r of rows) factBefore.set(`${r.managerId}:${w.from}`, r.revenue);
  }

  const out: WeekPlanRow[] = [];
  for (const id of ids) {
    const monthPlan = planByMgr.get(id) ?? 0;
    for (const w of weeks) {
      const key = `${id}:${w.from}`;
      const snap = snaps.get(key);
      if (snap) {
        out.push({
          managerId: id, weekStart: w.from, plan: Number(snap.plan),
          overPlan: Math.max(0, Number(snap.fact_before) - Number(snap.month_plan)),
          monthPlan: Number(snap.month_plan), factBefore: Number(snap.fact_before),
          wdWeek: snap.working_days_week, wdRest: snap.working_days_rest,
          source: snap.source, reconstructed: snap.source === "backfill",
        });
        continue;
      }
      const wdWeek = weekWorkingDays(w);
      const wdRest = workingDaysBetween(w.from, monthEnd);
      const fb = factBefore.get(key) ?? 0;
      const res = weekPlanOf({ monthPlan, factBefore: fb, wdWeek, wdRest });
      const row: WeekPlanRow = {
        managerId: id, weekStart: w.from, plan: res.plan, overPlan: res.overPlan,
        monthPlan, factBefore: fb, wdWeek, wdRest, source: null, reconstructed: false,
      };
      out.push(row);
    }
  }
  return out;
}

/**
 * Запис знімків. `ON CONFLICT DO NOTHING` — заморожене НЕ перезаписується НІКОЛИ:
 * саме в цьому й сенс заморожування. Перезапис зробив би таблицю просто кешем.
 */
export async function freezeWeekPlans(monthStart: string, rows: WeekPlanRow[], source: "live" | "backfill"): Promise<number> {
  if (!rows.length) return 0;
  const vals: string[] = [];
  const p: unknown[] = [monthStart];
  for (const r of rows) {
    // `source` рядка перемагає аргумент: виклик може змішувати «спіймали в момент»
    // і «відновили заднім числом» в одній пачці (див. коментар про викат у четвер).
    p.push(r.managerId, r.weekStart, r.plan, r.monthPlan, r.factBefore, r.wdWeek, r.wdRest, r.source ?? source);
    const b = p.length;
    vals.push(`($${b - 7}, $${b - 6}::date, $1::date, $${b - 5}, $${b - 4}, $${b - 3}, $${b - 2}, $${b - 1}, $${b})`);
  }
  const r = await pool.query(
    `INSERT INTO weekly_plan_snapshots
       (manager_id, week_start, month_start, plan, month_plan, fact_before, working_days_week, working_days_rest, source)
     VALUES ${vals.join(",")} ON CONFLICT (manager_id, week_start) DO NOTHING`, p);
  return r.rowCount ?? 0;
}

/**
 * Ретроспективний бекфіл за тижні, що минули ДО впровадження механізму.
 *
 * 🔴 ЧЕСНА МЕЖА, ЯКУ ВИДНО В UI: ці знімки ВІДНОВЛЕНО, а не збережено в момент.
 * Факт «на початок тижня» реконструюється з поточного стану `deal_stage_events`,
 * тож якщо угода відтоді переїхала між стадіями, відновлене число відрізняється
 * від того, яке людина бачила тоді. Позначка `source='backfill'` існує саме тому,
 * що приховати цю різницю було б тихою брехнею про історію.
 */
export async function backfillWeekPlans(monthStart: string, planByMgr: Map<number, number>): Promise<{ inserted: number; weeks: number }> {
  const rows = await weekPlansForMonth({}, monthStart, planByMgr);
  const today = await kyivToday();
  /**
   * 🔴 ЯРЛИК ЛИШАЄТЬСЯ ЧЕСНИМ, І ПРАВИЛО ТУТ ТЕ САМЕ, ЩО РАНІШЕ БУЛО НА ЧИТАННІ.
   * `live` = «зафіксовано В ДЕНЬ старту тижня»; `backfill` = «відновлено заднім
   * числом». Джоба ходить щодня, тож тиждень, що починається СЬОГОДНІ, вона ловить
   * саме в момент старту — це `live` за визначенням, і назвати його `backfill` було б
   * применшенням, таким самим тихим, як зворотна брехня.
   *
   * ⚠️ Для ручного прогону за минулі місяці (`--months=N`) `weekStart === today` не
   * настає ніколи, тож там усе лишається `backfill` — контракт не змінився.
   */
  const due = rows.filter((r) => r.weekStart <= today && r.source === null)
    .map((r) => ({ ...r, source: (r.weekStart === today ? "live" : "backfill") as "live" | "backfill" }));
  const inserted = await freezeWeekPlans(monthStart, due, "backfill");
  return { inserted, weeks: new Set(due.map((r) => r.weekStart)).size };
}
