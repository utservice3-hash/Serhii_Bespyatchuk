/**
 * 📊 ІСТОРІЯ ЗАМОВЛЕНЬ КЛІЄНТА ПО МІСЯЦЯХ — ГРОШІ Й КІЛЬКІСТЬ З ОДНИХ І ТИХ САМИХ КОШИКІВ (задача 11218; зустріч по
 * дашборду 25.11.2026: графік «Періодичність замовлень» за 6 місяців прямо в рядку «З ким говорити»).
 *
 * Вхід — рядки ядра грошей «клієнт × місяць» (`money.fromInvoiceByClientBucket`): сума й число угод кошика. Тут лише
 * розкладання по вікну місяців; самі гроші й угоди рахує `core/money.ts`. Обидва масиви будуються ОДНИМ проходом, тож
 * стовпчик «скільки замовлень» і сума «з рахунку» того ж місяця не можуть розійтись.
 *
 * Чиста функція без імпортів — гейт `#11218` виконує її на фікстурі.
 */
export interface BucketRow { clientKey: string; bucket: string; revenue: number; deals: number }
export interface OrderHistory { money: Map<string, number[]>; deals: Map<string, number[]> }

/**
 * `months` — вікно `YYYY-MM` від найстаршого до найновішого; `inList` — чи клієнт у списку екрана.
 * Кошик поза вікном і клієнт поза списком не враховуються; два кошики одного місяця складаються.
 * Клієнта без жодного кошика у вікні в мапах немає — читач сам вирішує, що показати (нулі).
 */
export function foldOrderHistory(rows: readonly BucketRow[], months: readonly string[], inList: (clientKey: string) => boolean): OrderHistory {
  const money = new Map<string, number[]>(), deals = new Map<string, number[]>();
  for (const h of rows) {
    if (!inList(h.clientKey)) continue;
    const idx = months.indexOf(h.bucket.slice(0, 7));
    if (idx < 0) continue;
    const m = money.get(h.clientKey) ?? months.map(() => 0);
    m[idx] += h.revenue;
    money.set(h.clientKey, m);
    const d = deals.get(h.clientKey) ?? months.map(() => 0);
    d[idx] += h.deals;
    deals.set(h.clientKey, d);
  }
  return { money, deals };
}

/**
 * 📅 «ЗА ЦЕЙ РІК» (задача 11219; зустріч 25.11.2026: «оборот і дохід клієнта за цей рік»). Поточний календарний рік за
 * Києвом: від 1 січня до сьогодні включно. `today` — київська дата `YYYY-MM-DD`.
 * ⚠️ Прочитання «цей рік = календарний» — наше; «останні 12 місяців» дали б інше число. Екран підписує рік цифрою.
 */
export function thisYearWindow(today: string): { year: number; from: string; to: string } {
  const year = Number(today.slice(0, 4));
  return { year, from: `${today.slice(0, 4)}-01-01`, to: today.slice(0, 10) };
}
