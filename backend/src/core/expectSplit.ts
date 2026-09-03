/**
 * ⏳ ЗОНА ОЧІКУВАННЯ, РОЗБИТА ЗА ДАТОЮ ОЧІКУВАНОГО ПЛАТЕЖУ — ЧОТИРИ ВІДРА.
 *
 * Рішення власника 03.09.2026: у плитці «Очікуємо» на Звіті КВП замість одного числа
 * стоять чотири — прострочено · цього місяця · пізніше · без дати.
 *
 * 📐 ПРИВІД, ЗАМІРЯНИЙ НА ПРОДІ 03.09.2026. Плитка показувала одне число (378 угод,
 * 1.26 млн ₴) і підпис «уся зона, без прив'язки до дати». Підпис був ПРАВДИВИЙ про
 * фільтр — плитка справді не звужується датою, — але читач робив із нього хибний
 * висновок, що дат немає. Дати є: **у 100% угод зони** (378 із 378). І серед них
 * **256 прострочених** — цього на екрані не було видно ніяк.
 *
 * 🔴 МЕЖА «ПРОСТРОЧЕНО» — ЦЕ СЬОГОДНІ, А НЕ НАЗВА МІСЯЦЯ. Перший розклад робився за
 * місяцями (вересень 143 · серпень 136 · раніше 93) і давав 93 «прострочених» — а їх
 * 256, бо 3 вересня серпневі дати теж у минулому, і вересневі 1-2 числа теж. Різниця
 * між «за назвою місяця» і «за сьогодні» тут — 163 угоди.
 *
 * ⚠️ І ЧИСЛА ДРЕЙФУЮТЬ ЗА ПОБУДОВОЮ, бо межа рухається щодня. Заміряно: за 15 хвилин
 * сума зони зрушила на 6 495 ₴. Тому приймається ІНВАРІАНТ (сума чотирьох == ціле,
 * поміряні ОДНИМ викликом), а не конкретні числа — див. `#26q`.
 *
 * 🔴 ДВІ ФОРМИ ОДНОГО ПРАВИЛА, І ВОНИ ЗВІРЯЮТЬСЯ. Агрегат мусить бути в SQL (зона —
 * це запит), а фікстурний гейт потребує чистої функції, бо угод «без дати» сьогодні
 * НУЛЬ і живий гейт на них був би зеленим на зламаному коді просто тому, що стану
 * немає. Тому форм дві — і `#26q` звіряє їх одна проти одної на ЖИВИХ рядках, а
 * `#26r` перевіряє межі, яких у живих даних немає.
 */

/** Чотири відра. Порядок — як на екрані. */
export const EXPECT_BUCKETS = ["overdue", "thisMonth", "later", "noDate"] as const;
export type ExpectBucket = (typeof EXPECT_BUCKETS)[number];

/** Підписи для екрана — тут, а не у фронті: одне правило, одна назва. */
export const EXPECT_BUCKET_UA: Record<ExpectBucket, string> = {
  overdue: "прострочено",
  thisMonth: "цього місяця",
  later: "пізніше",
  noDate: "без дати",
};

/**
 * ЧИСТА КЛАСИФІКАЦІЯ — оракул для гейтів. Дати передаються київськими рядками
 * `YYYY-MM-DD`, бо саме в такому вигляді їх дає SQL: жодного `new Date()` всередині,
 * інакше зона запуску тесту тихо зсунула б межу (цього тижня ми ловились на часових
 * поясах тричі).
 */
export function expectBucketOf(planned: string | null | undefined, today: string): ExpectBucket {
  if (!planned) return "noDate";
  if (planned < today) return "overdue";
  return planned.slice(0, 7) === today.slice(0, 7) ? "thisMonth" : "later";
}

/**
 * ТА САМА КЛАСИФІКАЦІЯ В SQL. `todayParam` — плейсхолдер із київською датою
 * «сьогодні»; передається ззовні, щоб межу не рахували двічі в різних місцях.
 */
export function expectBucketSql(plannedExpr: string, todayParam: string): string {
  return `CASE
      WHEN ${plannedExpr} IS NULL THEN 'noDate'
      WHEN ${plannedExpr} < ${todayParam}::date THEN 'overdue'
      WHEN to_char(${plannedExpr}, 'YYYY-MM') = to_char(${todayParam}::date, 'YYYY-MM') THEN 'thisMonth'
      ELSE 'later'
    END`;
}

export interface ExpectSplitRow { bucket: ExpectBucket; deals: number; sum: number }
export interface ExpectSplit { today: string; buckets: Record<ExpectBucket, ExpectSplitRow>; total: ExpectSplitRow }

/**
 * Агрегат по зоні очікування, розбитий на чотири відра ОДНИМ запитом.
 *
 * 🔴 ОДИН ЗАПИТ — НЕ ОПТИМІЗАЦІЯ, А УМОВА ПРАВИЛЬНОСТІ. Зона живе: за 15 хвилин її
 * сума зрушила на 6 495 ₴. Частини й ціле, взяті двома викликами, розійшлися б без
 * жодного дефекту — і ми пішли б шукати помилку там, де її немає (правило 18).
 *
 * ⚠️ Предикат зони НЕ дублюється: береться `EXPECT_ZONE` + той самий `is_active`-JOIN,
 * що в `expectedZoneByScope`, інакше плитка і рядки під нею показували б різне.
 */
export async function expectedZoneSplit(
  scope: { managerId?: number | null; teamId?: number | null } = {},
): Promise<ExpectSplit> {
  const { pool } = await import("../db/pool.js");
  const { EXPECT_ZONE, FC_PIPELINES } = await import("./metrics.js");
  const { DEAL_NOT_WRITTEN_OFF } = await import("./writeoffScope.js");
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const p: unknown[] = [FC_PIPELINES, EXPECT_ZONE];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = ANY($2)", DEAL_NOT_WRITTEN_OFF];
  if (scope.managerId) { p.push(scope.managerId); conds.push(`d.manager_id = $${p.length}`); }
  if (scope.teamId) { p.push(scope.teamId); conds.push(`m.team_id = $${p.length}`); }
  const pd = `(d.planned_payment_at ${K})::date`;
  const r = await pool.query<{ bucket: ExpectBucket; deals: string; sum: string; today: string }>(
    `WITH t AS (SELECT (now() ${K})::date AS today)
     SELECT ${expectBucketSql(pd, "(SELECT today FROM t)")} AS bucket,
            COUNT(*)::int deals, COALESCE(SUM(d.price),0) sum,
            to_char((SELECT today FROM t), 'YYYY-MM-DD') AS today
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
      WHERE ${conds.join(" AND ")}
      GROUP BY 1, 4`, p);

  const buckets = Object.fromEntries(EXPECT_BUCKETS.map((b) => [b, { bucket: b, deals: 0, sum: 0 }])) as Record<ExpectBucket, ExpectSplitRow>;
  let today = "";
  for (const x of r.rows) {
    today = x.today;
    buckets[x.bucket] = { bucket: x.bucket, deals: Number(x.deals), sum: Number(x.sum) };
  }
  const total = EXPECT_BUCKETS.reduce(
    (acc, b) => ({ bucket: "overdue" as ExpectBucket, deals: acc.deals + buckets[b].deals, sum: acc.sum + buckets[b].sum }),
    { bucket: "overdue" as ExpectBucket, deals: 0, sum: 0 });
  return { today, buckets, total };
}
