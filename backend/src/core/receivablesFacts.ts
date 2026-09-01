/**
 * 📇 ФАКТИ ПРО РАХУНКИ ДЕБІТОРКИ — юрособа, стан перевізника, вік, звʼязок з CRM.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМИЙ МОДУЛЬ, А НЕ ЩЕ ОДИН ЗАПИТ У РОУТІ.
 * Класифікація тут — ЧИСТІ ФУНКЦІЇ від рядка. SQL лише привозить сирі поля;
 * жодного `CASE` з бізнес-правилом у тексті запиту немає. Це навмисно: правило,
 * записане в SQL, неможливо ані просаботувати гейтом, ані переюзати — і саме так
 * у нас уже двічі народжувалась друга копія правила (чипи «новий/постійний»,
 * `hasPriorPaidSql`). Тут копія одна, і вона тестується без БД.
 *
 * ⏱ І ДРУГЕ, НЕ МЕНШ ВАЖЛИВЕ: ЗАПИТ РІВНО ОДИН.
 * Заміряно 24.08.2026: RTT до Neon = 30 мс (медіана 10 прогонів «SELECT 1»),
 * а весь екран дебіторки — 303 рахунки на 72 клієнтів. Тобто тут ціна не в
 * важкості запиту, а в КІЛЬКОСТІ походів: кожен новий блок окремим запитом
 * коштував би +30 мс НЕЗАЛЕЖНО від того, що він рахує. Тому сирі рядки їдуть
 * одним походом, а всі зрізи (плитки, ярлики, фільтри, aging) складаються з
 * ОДНОГО масиву в памʼяті. Тримає гейт `#158`.
 */

/** Звʼязок рахунку з угодою Kommo. Три стани, і вони РІЗНІ за діагнозом. */
export type LinkState =
  /** № угоди є, угода знайдена — повний контекст із CRM. */
  | "kommo"
  /**
   * № угоди немає (порожній Comment у 1С). Рахунок виставлено НАПРЯМУ в 1С,
   * повз CRM, тож угоди не існує **ЗА ЗАДУМОМ** (рішення власника 24.08.2026).
   * Це ПОВНОЦІННА КАТЕГОРІЯ, а не «даних бракує».
   */
  | "one_c"
  /**
   * № угоди Є, але угоди в `deals` НЕМАЄ. 🔴 ІНШИЙ ДІАГНОЗ, ніж `one_c`: там
   * угоди немає за задумом, тут вона МАЛА Б БУТИ (одруківка в 1С або угоду
   * видалили в Kommo). Зводити їх в одну клітинку = повторити «архів ≠ давно
   * втрачений». Рішення власника 24.08.2026: окремий ярлик.
   */
  | "broken_link";

/** Наша юрособа, від якої виставлено рахунок. */
export type Entity = "uts" | "avtomuv" | "fop" | "unknown";

/** Чому юрособа невідома. Три різні причини — три різні підписи й три різні дії. */
export type EntityUnknownReason =
  | "one_c"           // виставлено через 1С — колонки «Організація» 1С ще не віддає
  | "broken_link"     // лінк не веде на угоду
  | "no_payment_type"; // угода є, але «форма оплати» в CRM не заповнена

/** Чи оплачено перевізника. `na` — ВІДПОВІДЬ «не знаємо», а НЕ «не оплачено». */
export type CarrierPaid = "paid" | "unpaid" | "na";

/**
 * Чому стан перевізника невідомий.
 * 🔴 `out_of_map` — угода є, але її воронки немає в `pipeline_stage_map`
 * (заміряно: воронка 8868280, 1 рахунок, 9 000 ₴). Назвати «не оплачено» ми не
 * маємо права: етапи тієї воронки нам не відомі взагалі, тож це «не знаємо».
 */
export type CarrierNaReason = "one_c" | "broken_link" | "out_of_map";

export type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";

/** Сирий рядок рахунку — рівно те, що привозить `INVOICE_FACTS_SQL`. */
export interface RawInvoiceRow {
  clientKey: string;
  clientName: string | null;
  amount: number;
  invoiceDate: string | null;   // YYYY-MM-DD
  invoiceNo: string | null;
  /** ЄДРПОУ клієнта з 1С. Другий барʼєр зіставлення платежу — див. `core/paymentMatch`. */
  edrpou: string | null;
  dealId: number | null;        // № угоди з коментаря 1С (з `service_url`)
  dealFound: boolean;           // чи знайшлась ця угода в `deals`
  paymentType: string | null;   // «форма оплати» Kommo
  statusId: number | null;
  pipelineId: number | null;
  stageMapped: boolean;         // чи є (pipeline_id, status_id) у `pipeline_stage_map`
  /** 🗑 Рахунок списано як безнадійний — у суму НЕ входить, але видимий підписом. */
  writtenOff: boolean;
  /**
   * 🏢 ЮРОСОБА КЛІЄНТА, ВІД ЯКОЇ ПРИЙШОВ РАХУНОК (`receivable_invoices.client_key_raw`).
   *
   * 🔴 НЕ ПЛУТАТИ З `entity` НИЖЧЕ. `Entity` у цьому модулі — це НАША компанія
   * (ЮТС / Автомув / ФОП), тобто хто виставив рахунок. `counterpartyKey` — це
   * ЧИЯ компанія винна, тобто клієнт. Слово «юрособа» на екрані вживається до
   * обох, і саме тому тут воно не вживається до жодного: одне слово на два
   * значення — та сама хвороба, яку ми вже ловили.
   *
   * Ключ сирий і НІКОЛИ не перезаписується склейкою — на відміну від
   * `clientKey`, який після обʼєднання стає канонічним. Саме тому розклад
   * «яка компанія скільки винна» відтворюється й ПІСЛЯ злиття, а розʼєднання
   * поверне старий вигляд без жодного розплутування даних.
   */
  counterpartyKey: string | null;
  // 🚚 Скільки заплачено перевізнику і чи домовлені умови. `null` в обох —
  // «не знаємо», і це ТРЕТІЙ стан, а не нуль (заміряно: тип порожній у 84 із 279).
  carrierPayAmount: number | null;
  carrierPayType: string | null;
  /**
   * 💰 Скільки ЗАРОБИЛИ на угоді (`deals.price` — у цьому продукті це вже маржа)
   * і ПОВНА сума угоди (знаменник). Обидва `null` — «рахувати нема з чого»,
   * і це НЕ нуль: нуль означав би «заробили нічого».
   */
  earned: number | null;
  clientPay: number | null;
  /** Скільки МИ ВИННІ перевізнику («Расход 1») — не плутати із заявкою. */
  carrierObligation: number | null;
  ageDays: number | null;       // днів від дати рахунку
}

/** Класифікований рахунок — те, з чого фронт складає геть усе на екрані. */
export interface InvoiceFact extends RawInvoiceRow {
  linkState: LinkState;
  entity: Entity;
  entityReason: EntityUnknownReason | null;
  carrierPaid: CarrierPaid;
  carrierReason: CarrierNaReason | null;
  aging: AgingBucket | null;
}

/**
 * 🚚 «ПЕРЕВІЗНИК ОПЛАЧЕНИЙ» — ЯВНИЙ СПИСОК `status_id`, І ІНАКШЕ НЕ МОЖНА.
 *
 * `funnel_stage` цю межу НЕ виражає: заміряно 24.08.2026 на живому проді, під
 * `invoiced` лежать ШІСТЬ статусів, зокрема `69716312` («Очікуємо оплату від
 * замовника (перевізник оплачений)» — 118 рахунків / 3.09 млн) і `69716304`
 * (рахунок ще не оплачено перевізнику — 66 / 2.53 млн). Тобто фільтр по
 * `funnel_stage = 'invoiced'` зарахував би 2.53 млн як «перевізник оплачений».
 * `approved` злипає ще гірше — ДЕСЯТЬ статусів.
 *
 * Склад: етап 8 обох FC-воронок (сама назва стадії стверджує факт оплати
 * перевізника) + усе, що ПІСЛЯ нього по ланцюгу — етап 9 «Оплата отримана» і
 * етап 10 «Успішна»: туди угода не потрапляє, не пройшовши через оплату
 * перевізника. Звірку зі `seedKommoMapping.sql` тримає `#153` — він і виявив, що звіряти
 * треба ПАРУ (воронка, статус), а не сам статус.
 */
export interface CarrierPaidStage { pipelineId: number; statusId: number }

/**
 * 🔴 ПАРА (ВОРОНКА, СТАТУС), А НЕ САМ СТАТУС — І ЦЕ НЕ ПЕДАНТИЗМ.
 *
 * Перша редакція звіряла лише `status_id`, і гейт `#153` це впіймав: `142` у
 * Kommo НЕ глобальний. У Продзвіні (`8921936`) той самий `142` означає
 * «КВАЛІФІКОВАНО / заявку на прорахунок отримано» і мапиться в
 * `quote_requested`. Тобто рахунок, привʼязаний до угоди Продзвіну, дістав би
 * ярлик «перевізник оплачений» — рівно клас «статус без корзини», лише в
 * дзеркальний бік.
 *
 * Сьогодні це недосяжно (заміряно 24.08.2026: звʼязані рахунки лежать у
 * воронках 8921932 і 8868280), і саме тому воно й прожило б непоміченим до
 * першого рахунку з іншої воронки.
 */
export const CARRIER_PAID_STAGES: readonly CarrierPaidStage[] = [
  { pipelineId: 8921932, statusId: 69716312 }, // Очікуємо оплату від замовника (перевізник оплачений)
  { pipelineId: 155304,  statusId: 25044997 }, // те саме у старій воронці
  { pipelineId: 8921932, statusId: 69716460 }, // Оплата отримана
  { pipelineId: 155304,  statusId: 60412544 }, // Оплата отримана
  { pipelineId: 8921932, statusId: 142 },      // Успішна угода
  { pipelineId: 155304,  statusId: 142 },      // Успішна угода (стара воронка)
];

export const isCarrierPaidStage = (pipelineId: number | null, statusId: number | null): boolean =>
  pipelineId != null && statusId != null
  && CARRIER_PAID_STAGES.some((x) => x.pipelineId === pipelineId && x.statusId === statusId);

/**
 * 🏛 ДЖЕРЕЛО ЮРОСОБИ — ЗА ІНТЕРФЕЙСОМ, а не `if` по `payment_type` у роуті.
 *
 * Сьогодні юрособу виводимо з «форми оплати» Kommo (рішення власника: безнал
 * без ПДВ → Автомув · безнал з ПДВ → ЮТС · готівка → ФОП · валюта → Автомув).
 * Завтра 1С віддасть колонку «Організація», і тоді зʼявиться ДРУГА реалізація
 * цього ж інтерфейсу — а не ще одна гілка всередині першої. Тримає `#155`.
 */
export interface EntityResolver {
  readonly name: string;
  resolve(row: RawInvoiceRow): { entity: Entity; reason: EntityUnknownReason | null };
}

const PAYMENT_TYPE_TO_ENTITY: Record<string, Entity> = {
  "Безнал без НДС": "avtomuv",
  "ВАЛЮТА": "avtomuv",
  "Безнал с НДС": "uts",
  "Наличные": "fop",
};

/** Юрособа з «форми оплати» Kommo — чинна реалізація. */
export const fromKommoPaymentType: EntityResolver = {
  name: "kommo-payment-type",
  resolve(row) {
    if (row.dealId == null) return { entity: "unknown", reason: "one_c" };
    if (!row.dealFound) return { entity: "unknown", reason: "broken_link" };
    const e = row.paymentType ? PAYMENT_TYPE_TO_ENTITY[row.paymentType] : undefined;
    // 🔴 Порожня «форма оплати» — це UNKNOWN З ВЛАСНИМ ПІДПИСОМ, а не мовчазне
    // приліплювання до найбільшої юрособи. Заміряно: 7 рахунків / 124 300 ₴.
    // Дірка закривається ДАНИМИ (менеджери заповнюють у CRM), не здогадом коду.
    return e ? { entity: e, reason: null } : { entity: "unknown", reason: "no_payment_type" };
  },
};

export function classifyLink(row: RawInvoiceRow): LinkState {
  if (row.dealId == null) return "one_c";
  return row.dealFound ? "kommo" : "broken_link";
}

/**
 * 🔴 ВІДСУТНІСТЬ УГОДИ ≠ ФАКТ НЕОПЛАТИ.
 * Заміряно: якби «1С» віддавало `unpaid`, фінансист побачив би **1 589 000 ₴**
 * фальшивої неоплати — 28% від справжніх 5 663 227 ₴. Тримає `#152`.
 */
export function classifyCarrierPaid(row: RawInvoiceRow): { state: CarrierPaid; reason: CarrierNaReason | null } {
  if (row.dealId == null) return { state: "na", reason: "one_c" };
  if (!row.dealFound) return { state: "na", reason: "broken_link" };
  if (!row.stageMapped) return { state: "na", reason: "out_of_map" };
  return isCarrierPaidStage(row.pipelineId, row.statusId)
    ? { state: "paid", reason: null }
    : { state: "unpaid", reason: null };
}

export function agingBucket(ageDays: number | null): AgingBucket | null {
  if (ageDays == null) return null;
  if (ageDays <= 30) return "0-30";
  if (ageDays <= 60) return "31-60";
  if (ageDays <= 90) return "61-90";
  return "90+";
}

/** Класифікація одного рахунку — ЄДИНЕ місце, де сирий рядок стає фактом. */
export function classifyInvoice(row: RawInvoiceRow, resolver: EntityResolver = fromKommoPaymentType): InvoiceFact {
  const ent = resolver.resolve(row);
  const carrier = classifyCarrierPaid(row);
  return {
    ...row,
    linkState: classifyLink(row),
    entity: ent.entity,
    entityReason: ent.reason,
    carrierPaid: carrier.state,
    carrierReason: carrier.reason,
    aging: agingBucket(row.ageDays),
  };
}

// ───────────────────────────── ЗВЕДЕННЯ ─────────────────────────────

export interface Tally { n: number; amount: number }
export type TallyBy<K extends string> = Record<K, Tally>;

const add = <K extends string>(m: TallyBy<K>, k: K, amount: number) => {
  const cur = m[k] ?? { n: 0, amount: 0 };
  m[k] = { n: cur.n + 1, amount: cur.amount + amount };
};

/** Зведення по ОДНОМУ клієнту — те, з чого малюються ярлики в його рядку. */
export interface ClientFacts {
  clientKey: string;
  invoices: number;
  amount: number;
  link: TallyBy<LinkState>;
  entity: TallyBy<Entity>;
  carrier: TallyBy<CarrierPaid>;
  aging: TallyBy<AgingBucket>;
  entityReasons: EntityUnknownReason[];
  carrierReasons: CarrierNaReason[];
  /** Воронки поза `pipeline_stage_map` — НАЗИВАЄМО, а не ховаємо (рішення власника). */
  pipelinesOutOfMap: number[];
  oldestAgeDays: number | null;
  /**
   * 💰 Заробіток і повна сума угод — ЗА УГОДАМИ, а не за рахунками.
   * Кілька рахунків можуть указувати на ОДНУ угоду, і тоді підсумовування по
   * рахунках порахувало б заробіток двічі. Той самий дедуп, що в грошових
   * метриках ядра (етапи 9∪10 рахуються РАЗ по угоді).
   */
  earned: number | null;
  clientPay: number | null;
  /** 🗑 Списано як безнадійне: скільки рядків і на скільки. У `amount` НЕ входить. */
  writtenOffN: number;
  writtenOffAmount: number;
  /**
   * 🏢 РОЗКЛАД БОРГУ ПО ЮРОСОБАХ КЛІЄНТА — ключ `client_key_raw`, назва всередині.
   *
   * 🔴 ОДНА СТРУКТУРА, А НЕ ДВІ ПОРУЧ. Спокуса тримати суми в `TallyBy` і назви
   * в окремій мапі велика, бо `add()` уже є. Але два джерела одного факту
   * розходяться мовчки — рівно те, від чого застерігає доккоментар `foldFacts`
   * («порахуй їх окремо — і одного дня вони розійдуться»). Тому назва їде разом
   * із сумою, в тому самому запису.
   *
   * Списані рахунки сюди НЕ входять — так само, як не входять у `amount`.
   * Через це Σ розкладу == `amount` за побудовою, і це не збіг, а інваріант:
   * обидва числа набираються в одному циклі після того самого `continue`.
   */
  counterparty: Record<string, { name: string | null; n: number; amount: number }>;
}

export interface FactTotals {
  invoices: number;
  amount: number;
  earned: number | null;
  clientPay: number | null;
  writtenOffN: number;
  writtenOffAmount: number;
  link: TallyBy<LinkState>;
  entity: TallyBy<Entity>;
  carrier: TallyBy<CarrierPaid>;
  aging: TallyBy<AgingBucket>;
  entityReason: TallyBy<EntityUnknownReason>;
  carrierReason: TallyBy<CarrierNaReason>;
  pipelinesOutOfMap: number[];
}

const emptyClient = (clientKey: string): ClientFacts => ({
  clientKey, invoices: 0, amount: 0,
  link: {} as TallyBy<LinkState>, entity: {} as TallyBy<Entity>,
  carrier: {} as TallyBy<CarrierPaid>, aging: {} as TallyBy<AgingBucket>,
  entityReasons: [], carrierReasons: [], pipelinesOutOfMap: [], oldestAgeDays: null,
  earned: null, clientPay: null, writtenOffN: 0, writtenOffAmount: 0,
  counterparty: {},
});

/**
 * Складає факти в зведення по клієнтах І в загальні підсумки — ЗА ОДИН прохід
 * по тому самому масиву.
 *
 * 🔴 ЧОМУ РАЗОМ, А НЕ ДВОМА ФУНКЦІЯМИ. Плитки вгорі й ярлики в рядках — це те
 * саме число, подане двічі. Порахуй їх окремо — і одного дня вони розійдуться
 * мовчки, бо джерело спільне, а вираз різний. Рівно так «Команда за місяць 12%»
 * жила поруч із плиткою «11.8%». Тут вихід один, тож розійтись їм нема як.
 */
export function foldFacts(facts: InvoiceFact[]): { byClient: Map<string, ClientFacts>; totals: FactTotals } {
  const byClient = new Map<string, ClientFacts>();
  // Дедуп угод — СПІЛЬНИЙ для клієнта й підсумку: одна угода рахується раз.
  const seenDeal = new Set<number>();
  const totals: FactTotals = {
    invoices: 0, amount: 0, earned: null, clientPay: null,
    writtenOffN: 0, writtenOffAmount: 0,
    link: {} as TallyBy<LinkState>, entity: {} as TallyBy<Entity>,
    carrier: {} as TallyBy<CarrierPaid>, aging: {} as TallyBy<AgingBucket>,
    entityReason: {} as TallyBy<EntityUnknownReason>, carrierReason: {} as TallyBy<CarrierNaReason>,
    pipelinesOutOfMap: [],
  };
  for (const f of facts) {
    let c = byClient.get(f.clientKey);
    if (!c) { c = emptyClient(f.clientKey); byClient.set(f.clientKey, c); }

    // 🔴 СПИСАНЕ НЕ ВХОДИТЬ У СУМУ, АЛЕ ВИДНО ОКРЕМИМ ЧИСЛОМ.
    // Рішення власника: списання ЗМЕНШУЄ плитку — це визнання втрати, а не
    // «сховати з очей». Але плитка, що мовчки просіла, читається як поломка,
    // тому поруч завжди «списано: N на X ₴» (урок «Прострочено (понад ліміт)»).
    if (f.writtenOff) {
      c.writtenOffN++; c.writtenOffAmount += f.amount;
      totals.writtenOffN++; totals.writtenOffAmount += f.amount;
      continue;
    }

    c.invoices++; c.amount += f.amount;
    totals.invoices++; totals.amount += f.amount;

    // 💰 Заробіток і знаменник — РАЗ НА УГОДУ. Два рахунки однієї угоди інакше
    // подвоїли б маржу, і вона виглядала б правдоподібно.
    if (f.dealId != null && f.dealFound && !seenDeal.has(f.dealId)) {
      seenDeal.add(f.dealId);
      if (f.earned != null) c.earned = (c.earned ?? 0) + f.earned;
      if (f.clientPay != null) c.clientPay = (c.clientPay ?? 0) + f.clientPay;
      if (f.earned != null) totals.earned = (totals.earned ?? 0) + f.earned;
      if (f.clientPay != null) totals.clientPay = (totals.clientPay ?? 0) + f.clientPay;
    }

    // 🏢 Розклад по юрособах клієнта — В ТОМУ САМОМУ проході, після того самого
    // `continue`, що виключає списані. Інакше Σ розкладу і `amount` набирались би
    // за різними правилами й розійшлись би на першому ж списанні.
    // Ключ — сирий; його брак («рахунок без raw-ключа») має власне значення
    // «невідома юрособа», а не тихе злиття з канонічним.
    {
      const ck = f.counterpartyKey ?? "";
      const cur = c.counterparty[ck] ?? { name: f.clientName, n: 0, amount: 0 };
      c.counterparty[ck] = { name: cur.name ?? f.clientName, n: cur.n + 1, amount: cur.amount + f.amount };
    }

    add(c.link, f.linkState, f.amount);       add(totals.link, f.linkState, f.amount);
    add(c.entity, f.entity, f.amount);        add(totals.entity, f.entity, f.amount);
    add(c.carrier, f.carrierPaid, f.amount);  add(totals.carrier, f.carrierPaid, f.amount);
    if (f.aging) { add(c.aging, f.aging, f.amount); add(totals.aging, f.aging, f.amount); }

    if (f.entityReason) {
      if (!c.entityReasons.includes(f.entityReason)) c.entityReasons.push(f.entityReason);
      add(totals.entityReason, f.entityReason, f.amount);
    }
    if (f.carrierReason) {
      if (!c.carrierReasons.includes(f.carrierReason)) c.carrierReasons.push(f.carrierReason);
      add(totals.carrierReason, f.carrierReason, f.amount);
    }
    if (f.carrierReason === "out_of_map" && f.pipelineId != null) {
      if (!c.pipelinesOutOfMap.includes(f.pipelineId)) c.pipelinesOutOfMap.push(f.pipelineId);
      if (!totals.pipelinesOutOfMap.includes(f.pipelineId)) totals.pipelinesOutOfMap.push(f.pipelineId);
    }
    if (f.ageDays != null && (c.oldestAgeDays == null || f.ageDays > c.oldestAgeDays)) c.oldestAgeDays = f.ageDays;
  }
  return { byClient, totals };
}

// ───────────────────────────── ЗАВАНТАЖЕННЯ ─────────────────────────────

/**
 * 🧾 ОДИН ЗАПИТ НА ВЕСЬ ЕКРАН. SQL віддає СИРІ поля — жодного бізнес-правила в
 * тексті (див. шапку модуля). № угоди дістаємо з `service_url`, бо саме туди
 * `syncReceivables` кладе розібраний коментар 1С; окремої колонки `deal_id`
 * у таблиці немає, і заводити її задля цього проходу означало б міграцію без
 * потреби.
 *
 * ⚠️ СКОУП — ПО КЛЮЧАХ КЛІЄНТІВ, а не по `ri.manager_id`. Рядок клієнта у
 * `receivables` фільтрується по ВІДПОВІДАЛЬНОМУ, а рахунок у
 * `receivable_invoices` носить менеджера САМОГО РАХУНКУ — це різні люди після
 * override або склейки. Фільтруй тут по `ri.manager_id` — і в тімліда зʼявились
 * би факти для клієнтів, яких немає в його списку (і навпаки), тобто Σ плиток
 * розійшлася б із Σ рядків. Гейт `#150` ловить саме це.
 */
const INVOICE_FACTS_SQL = `
  SELECT ri.client_key, ri.client_name, ri.amount, ri.invoice_no, ri.edrpou,
         -- 🏢 Сирий ключ юрособи клієнта. КОЛОНКА В НАЯВНОМУ ЗАПИТІ, а не пʼятий
         -- похід: стеля #158 — чотири, і піднімати її «щоб пройшло» заборонено
         -- її ж текстом. COALESCE — бо в незлитого клієнта raw і канонічний збігаються.
         COALESCE(ri.client_key_raw, ri.client_key) AS counterparty_key,
         to_char(ri.invoice_date, 'YYYY-MM-DD') AS invoice_date,
         (now()::date - ri.invoice_date)        AS age_days,
         dl.deal_id,
         (d.kommo_id IS NOT NULL)               AS deal_found,
         d.payment_type, d.status_id, d.pipeline_id,
         d.carrier_pay_amount, d.carrier_pay_type,
         d.price AS earned, d.client_pay_amount, d.carrier_obligation,
         (psm.pipeline_id IS NOT NULL)          AS stage_mapped,
         (wo.client_key_raw IS NOT NULL)        AS written_off
    FROM receivable_invoices ri
    CROSS JOIN LATERAL (
      SELECT NULLIF(regexp_replace(COALESCE(ri.service_url, ''), '^.*/', ''), '')::bigint AS deal_id
    ) dl
    LEFT JOIN deals d ON d.kommo_id = dl.deal_id
    LEFT JOIN pipeline_stage_map psm
           ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
    -- Списання приєднуємо ДО НАЯВНОГО запиту, а не окремим походом: гейт #158
    -- стереже КІЛЬКІСТЬ запитів, і підняти його стелю «щоб пройшло» означало б
    -- пустити наступний зайвий похід у БД непоміченим.
    -- Ключ — client_key_raw: канонічний рухає склейка, і списання переїхало б
    -- на обʼєднаного клієнта, прибравши ЧУЖИЙ борг.
    -- (зворотні лапки тут заборонені — це тіло шаблонного рядка)
    LEFT JOIN receivable_writeoffs wo
           ON wo.client_key_raw = ri.client_key_raw
          AND wo.invoice_no = COALESCE(ri.invoice_no, '')
          AND wo.revoked_at IS NULL
   WHERE ri.client_key = ANY($1)
   ORDER BY ri.amount DESC`;

interface FactsDb { query<T>(sql: string, params: unknown[]): Promise<{ rows: T[] }> }

export async function loadInvoiceFacts(
  db: FactsDb, clientKeys: string[], resolver: EntityResolver = fromKommoPaymentType,
): Promise<InvoiceFact[]> {
  if (clientKeys.length === 0) return [];
  const r = await db.query<{
    client_key: string; client_name: string | null; amount: string; invoice_no: string | null;
    invoice_date: string | null; age_days: number | null; deal_id: string | null; deal_found: boolean; edrpou: string | null;
    payment_type: string | null; status_id: string | null; pipeline_id: string | null; stage_mapped: boolean; written_off: boolean;
    counterparty_key: string | null;
    carrier_pay_amount: string | null; carrier_pay_type: string | null;
    earned: string | null; client_pay_amount: string | null; carrier_obligation: string | null;
  }>(INVOICE_FACTS_SQL, [clientKeys]);
  return r.rows.map((x) => classifyInvoice({
    clientKey: x.client_key, clientName: x.client_name, amount: Number(x.amount),
    invoiceDate: x.invoice_date, invoiceNo: x.invoice_no, edrpou: x.edrpou,
    dealId: x.deal_id == null ? null : Number(x.deal_id),
    dealFound: x.deal_found === true,
    paymentType: x.payment_type, ageDays: x.age_days == null ? null : Number(x.age_days),
    statusId: x.status_id == null ? null : Number(x.status_id),
    pipelineId: x.pipeline_id == null ? null : Number(x.pipeline_id),
    stageMapped: x.stage_mapped === true,
    writtenOff: x.written_off === true,
    counterpartyKey: x.counterparty_key,
    carrierPayAmount: x.carrier_pay_amount == null ? null : Number(x.carrier_pay_amount),
    carrierPayType: x.carrier_pay_type,
    earned: x.earned == null ? null : Number(x.earned),
    clientPay: x.client_pay_amount == null ? null : Number(x.client_pay_amount),
    carrierObligation: x.carrier_obligation == null ? null : Number(x.carrier_obligation),
  }, resolver));
}

/** Текст запиту — для гейта `#158` (він рахує походи, а не читає SQL руками). */
export const __INVOICE_FACTS_SQL_FOR_TESTS = INVOICE_FACTS_SQL;
