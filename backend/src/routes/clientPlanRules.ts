/**
 * 🧮 ПРАВИЛА ЦИКЛУ ЗАТВЕРДЖЕННЯ ПЛАНУ ПО КЛІЄНТУ — БЕЗ імпортів.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ ФАЙЛ. Гейт власника звучить так: «Σ у "постійні принесуть"
 * == Σ ЗАТВЕРДЖЕНИХ (не поданих і не чернеток)». Перевірити це можна двома
 * способами: прогнати роут по HTTP (важко, потрібне все оточення) або взяти ту
 * саму арифметику й ті самі SQL, що виконує роут. Другий спосіб чесний РІВНО
 * доти, доки тест і роут беруть ОДИН текст, а не схожий, — урок #21c, де
 * саботаж спершу прогнали на власноруч переписаному SQL і доказ вийшов ні про що.
 *
 * Файл не імпортує нічого (зокрема `db/pool.js` → `config.js`, який кидає без
 * DATABASE_URL ще на імпорті), тож його можна брати і в тестах без БД.
 */

export type PlanStatus = "draft" | "pending" | "approved" | "none";

export interface PlanRow { plan: number; planStatus: string }
export interface PlanTotals {
  planTotal: number;
  planApproved: number;
  byStatus: Record<string, number>;
}

/**
 * Дві суми, не одна. `planTotal` — скільки менеджер УЖЕ ВПИСАВ (щоб він бачив
 * свою роботу); `planApproved` — скільки з цього ПОГОДЖЕНО. У «постійні
 * принесуть» іде друга: незатверджений план для системи не існує. Одна цифра
 * замість двох ховала б саме ту різницю, заради якої цикл і заводили.
 */
export function planTotals(rows: PlanRow[]): PlanTotals {
  const byStatus: Record<string, number> = { draft: 0, pending: 0, approved: 0, none: 0 };
  let planTotal = 0, planApproved = 0;
  for (const r of rows) {
    planTotal += r.plan;
    if (r.planStatus === "approved") planApproved += r.plan;
    byStatus[r.planStatus] = (byStatus[r.planStatus] ?? 0) + 1;
  }
  return { planTotal, planApproved, byStatus };
}

/** Менеджер подає ПАКЕТОМ: усі його чернетки за місяць → «подано». */
export const SUBMIT_SQL = `
  UPDATE repeat_client_plans SET status='pending', submitted_at = now(), updated_at = now(), updated_by = $3
   WHERE month = $1 AND manager_id = $2 AND status = 'draft'`;

/** Тімлід затверджує ВСІ подані у своїй зоні. `scopeCond` дописується викликачем. */
export const approveAllSql = (scopeCond: string): string => `
  UPDATE repeat_client_plans rp SET status='approved', approved_by = $2, approved_at = now(), updated_at = now()
    FROM managers m
   WHERE m.id = rp.manager_id AND rp.month = $1 AND rp.status = 'pending' ${scopeCond}`;

/** Повернення на доопрацювання — назад у чернетку, з обовʼязковим коментарем. */
export const RETURN_SQL = `
  UPDATE repeat_client_plans SET status='draft', returned_at = now(), review_note = $3,
         approved_by = NULL, approved_at = NULL, submitted_at = NULL, updated_at = now(), updated_by = $4
   WHERE client_key = $1 AND month = $2 AND status <> 'draft'`;
