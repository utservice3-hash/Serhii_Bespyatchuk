/**
 * 🔗 ЄДИНИЙ ШЛЯХ, ЯКИМ ВІДПОВІДАЛЬНИЙ ПОТРАПЛЯЄ В `receivables`.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ МОДУЛЬ, А НЕ ДВА ВИКЛИКИ ПОРУЧ. Відповідального треба
 * перерахувати у ДВОХ моментах: щосинку (усі клієнти) і одразу після дії адміна
 * (один клієнт). Поки це два шматки коду, дописати правило в один і забути в
 * другому — справа рядка, і екран півдня показував би старого відповідального
 * при новому override. Тут обидва випадки — один виклик із різним фільтром.
 *
 * Читає `receivable_invoices` (джерело правди про рахунки) і пише лише поля
 * ВІДПОВІДАЛЬНОГО в `receivables`. Суми не чіпає взагалі: переприв'язка людини
 * не сміє рухати гроші, і це перевіряє `#131`.
 *
 * 🔴 ГОТІВКОВІ РЯДКИ ТЕПЕР ТЕЖ ТУТ (23.08.2026). Раніше вони сюди не потрапляли
 * ДВІЧІ: у синку вставлялись ПІСЛЯ перерахунку, та ще й `UPDATE` мав
 * `AND source = 'sheet'`. Наслідок бачив власник на живому екрані: «МГЕР
 * (готівка)» стояв «без відповідального», а в підсумку «По відповідальних» його
 * 224 917 ₴ зараховувались Семенюку. Список читав `owner_source` (дефолтний
 * `none`), підсумок — `manager_id` (заповнений із CRM).
 *
 * ⚠️ Прибрати лише фільтр `'sheet'` було б НЕДОСТАТНЬО — рядка ще не існувало б
 * на момент виклику. Порядок і межа — дві причини одного бага, і лікуються разом.
 *
 * ⚠️ Ручне призначення для готівки і далі не приймається (роут відмовляє по
 * їхньому ключу явно): їх щосинку перебудовує CRM, тож override відкотився б сам,
 * а «кнопка, що не тримає» гірша за відсутню. Змінилось лише те, що підпис
 * тепер каже правду про АВТОМАТИЧНОГО відповідального.
 */

import {
  resolveOwner, resolveCashOwner,
  type ManagerFact, type OwnerOverride, type OwnerRow, type OwnerSource, type Responsible,
} from "./receivablesOwner.js";

/** Мінімум, потрібний від `pg`: підходять і `Pool`, і `PoolClient` (усередині транзакції). */
export interface Queryable {
  query<R extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Факти про менеджерів для правила: команда, ознака тімліда, активність.
 *
 * 🔴 Стани логінів віддаються ПЕРЕЛІКОМ, а не готовим булевим. Правило «логіна
 * немає ≠ звільнений» живе в `core/activeManager`, і другої його копії тут бути
 * не має — інакше половина ростера тихо стала б «звільненою» через те, що людям
 * просто не заводили доступ.
 */
export async function loadManagerFacts(c: Queryable): Promise<{
  facts: Map<number, ManagerFact>; nameById: Map<number, string>;
}> {
  const r = await c.query<{
    id: number; name: string; team_id: number | null; is_team_lead: boolean;
    is_active: boolean; logins: boolean[] | null;
  }>(
    `SELECT m.id, m.name, m.team_id, m.is_team_lead, m.is_active,
            array_remove(array_agg(u.is_active), NULL) AS logins
       FROM managers m LEFT JOIN users u ON u.manager_id = m.id
      GROUP BY m.id, m.name, m.team_id, m.is_team_lead, m.is_active`
  );
  return {
    facts: new Map(r.rows.map((m) => [m.id, {
      teamId: m.team_id, isTeamLead: m.is_team_lead,
      kommoActive: m.is_active, loginStates: m.logins ?? [],
    }])),
    nameById: new Map(r.rows.map((m) => [m.id, m.name])),
  };
}

/**
 * Ручні призначення.
 *
 * 🔴 У мапу кладеться сам ОБʼЄКТ, а не `managerId`: наявність запису і є станом
 * «авто вимкнене». Якби ми клали число, `null` (свідоме «нікого») став би
 * нерозрізненним від «запису немає», і `#127c` червонів би за побудовою.
 */
export async function loadOwnerOverrides(c: Queryable, clientKeys?: string[]): Promise<Map<string, OwnerOverride>> {
  const r = await c.query<{ client_key: string; manager_id: number | null }>(
    `SELECT client_key, manager_id FROM receivable_manager_override
      WHERE ($1::text[] IS NULL OR client_key = ANY($1))`,
    [clientKeys ?? null]
  );
  return new Map(r.rows.map((o) => [o.client_key, { managerId: o.manager_id }]));
}

export interface RecomputeResult {
  clients: number;
  bySource: Record<OwnerSource, number>;
}

/**
 * Перераховує відповідального для всіх клієнтів (`clientKeys` не задано) або для
 * названих. Повертає розклад по джерелах — щоб лог джоби казав ОБСЯГ, а не лише
 * «відпрацювала».
 */
export async function recomputeOwners(c: Queryable, clientKeys?: string[]): Promise<RecomputeResult> {
  const [{ facts, nameById }, overrides] = await Promise.all([
    loadManagerFacts(c),
    loadOwnerOverrides(c, clientKeys),
  ]);

  const inv = await c.query<{
    client_key: string; manager_id: number | null; amount: string; invoice_date: string | null;
  }>(
    `SELECT client_key, manager_id, amount,
            to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date
       FROM receivable_invoices
      WHERE ($1::text[] IS NULL OR client_key = ANY($1))`,
    [clientKeys ?? null]
  );

  const byClient = new Map<string, OwnerRow[]>();
  for (const row of inv.rows) {
    const a = byClient.get(row.client_key) ?? [];
    a.push({ managerId: row.manager_id, amount: Number(row.amount), invoiceDate: row.invoice_date });
    byClient.set(row.client_key, a);
  }

  /**
   * 🔴 ЦИКЛ ІДЕ ПО РЯДКАХ `receivables`, А НЕ ПО ГРУПАХ РАХУНКІВ. Раніше він
   * перебирав рахунки й сподівався, що для кожної групи знайдеться рядок
   * агрегату. Для готівки це не так: її рядок будується з УГОД, і «немає групи
   * рахунків» тихо означало «нікого не оновили». Тепер перебираємо саме те, що
   * оновлюємо, — і рядок без відповідника видно як `none`, а не як пропуск.
   *
   * `source` їде в `WHERE` разом із ключем: той самий `client_key` може мати і
   * готівковий рядок, і рядок із 1С, і оновити треба саме свій.
   */
  const agg = await c.query<{ client_key: string; source: string; manager_id: number | null }>(
    `SELECT client_key, source, manager_id FROM receivables
      WHERE ($1::text[] IS NULL OR client_key = ANY($1))`,
    [clientKeys ?? null]
  );

  const bySource: Record<OwnerSource, number> = {
    override: 0, "auto-majority": 0, "auto-teamlead": 0, "cash-invoice": 0, none: 0,
  };
  let clients = 0;
  for (const row of agg.rows) {
    const owner: Responsible = row.source === "cash"
      // Готівка: менеджер уже відомий із CRM, мажоритара не рахуємо.
      ? resolveCashOwner(row.manager_id)
      : resolveOwner(byClient.get(row.client_key) ?? [], facts, overrides.get(row.client_key) ?? null);
    bySource[owner.source]++;
    const res = await c.query(
      `UPDATE receivables
          SET manager_id = $2,
              manager_name_raw = $3,
              owner_source = $4,
              majority_manager_id = $5
        WHERE client_key = $1 AND source = $6`,
      [row.client_key, owner.managerId,
       // Підпис — імʼя з `managers`, а не ПІБ із коментаря 1С: друге називає
       // ТВОРЦЯ рахунку, і в рядку клієнта воно казало б не про ту людину.
       owner.managerId != null ? (nameById.get(owner.managerId) ?? "") : "",
       owner.source, owner.majorityId, row.source]
    );
    clients += res.rowCount ?? 0;
  }
  return { clients, bySource };
}
