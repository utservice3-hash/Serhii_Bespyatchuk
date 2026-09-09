import { pool } from "../db/pool.js";

/**
 * 💰 ПЛАН ВИТРАТ НА РЕКЛАМУ — ОДНЕ ДЖЕРЕЛО НА ВЕСЬ ПРОДУКТ.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМИЙ МОДУЛЬ, А НЕ ЗАПИТ У РОУТІ. План читають ДВА екрани — «Реклама»
 * і звіт КВП (там із нього рахується ROMI). Два запити означали б два плани на той
 * самий місяць, і розійшлися б вони тихо: кожне число окремо виглядало б правильним.
 * Рішення власника 09.09.2026 — «скрізь один план», і структурно це означає одну
 * функцію, а не домовленість писати однаково.
 *
 * 🔴 ЧОМУ ЗАМІНЮЄ ТАБЛИЧНИЙ, А НЕ СТОЇТЬ ПОРУЧ. `ad_budget_daily.budget_plan` і далі
 * приїжджає з Google-аркуша Сергія, і ми його БІЛЬШЕ НЕ ЧИТАЄМО як план. Колонка
 * лишається в таблиці навмисно: її пише синк, і прибирати запис заради «чистоти»
 * означало б зламати аркуш заради коду. Але єдиним планом для екранів є цей модуль.
 * ⚠️ Наслідок, названий вголос: щойно на місяць введено ручний план, ROMI в КВП за
 * цей місяць ПЕРЕРАХУЄТЬСЯ від нового числа. Це очікувана зміна, а не регрес.
 *
 * ⚠️ ПОРОЖНЄ — ЦЕ NULL, А НЕ НУЛЬ. Місяць без введеного плану мусить читатися як
 * «не задано» (екран пише це словами), інакше «виконання плану» ділилося б на нуль,
 * а «перевитрата» показувала б 100% там, де плану просто не ставили. Нуль тут був би
 * рівно тим фальшивим значенням, від якого стереже правило про сентинели.
 */

/** Перше число місяця за Києвом: `2026-09-17` → `2026-09-01`. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/**
 * План на місяць(і), що покривають період. Ключ — перше число місяця.
 * Місяців без введеного плану в мапі НЕМАЄ (див. «порожнє — це NULL»).
 */
export async function adPlanByMonth(from: string | null, to: string | null): Promise<Map<string, number>> {
  const r = await pool.query<{ month: string; plan: string }>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month, plan
       FROM ad_budget_manual
      WHERE ($1::date IS NULL OR month >= date_trunc('month', ($1)::date))
        AND ($2::date IS NULL OR month <= date_trunc('month', ($2)::date))
      ORDER BY month`,
    [from, to]
  );
  return new Map(r.rows.map((x) => [x.month, Number(x.plan)]));
}

/**
 * Сумарний план за період — стільки місяців, скільки він зачіпає.
 * `null`, якщо ЖОДЕН із зачеплених місяців не має плану: «не задано» ≠ «нуль».
 *
 * ⚠️ Період, що ріже місяць навпіл, бере ПОВНИЙ місячний план. Це свідомо: план —
 * величина місяця, і ділити його на дні означало б вигадати денний план, якого ніхто
 * не ставив. Екран мусить підписувати, за який саме місяць показано план.
 */
export async function adPlanForPeriod(from: string | null, to: string | null): Promise<number | null> {
  const byMonth = await adPlanByMonth(from, to);
  if (byMonth.size === 0) return null;
  return [...byMonth.values()].reduce((s, v) => s + v, 0);
}

/** Запис плану на місяць. `day` — будь-який день потрібного місяця. */
export async function setAdPlan(day: string, plan: number, userId: number | null): Promise<void> {
  await pool.query(
    `INSERT INTO ad_budget_manual (month, plan, set_by, set_at)
     VALUES (($1)::date, $2, $3, now())
     ON CONFLICT (month) DO UPDATE SET plan = EXCLUDED.plan, set_by = EXCLUDED.set_by, set_at = now()`,
    [monthStart(day), plan, userId]
  );
}
