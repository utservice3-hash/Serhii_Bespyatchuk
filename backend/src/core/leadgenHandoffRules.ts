/**
 * 💰 ГРОШІ З ПЕРЕДАНИХ ЛІДІВ — ЧИСТІ ПРАВИЛА, БЕЗ ЖОДНОГО ІМПОРТУ.
 *
 * Передача = угода Продзвону входить у «Кваліфіковано» (142) у київську дату періоду;
 * вона веде до угоди МЕНЕДЖЕРА (той самий `client_key`, Кваліфікація або повний цикл,
 * створена від −10 до +120 с від входу), і гроші — це стан ТІЄЇ угоди ЗАРАЗ.
 * Правила 1–6 — рішення власника 22.09.2026; тут живуть 2–4, у вигляді чистих функцій.
 *
 * ⚓ АНКЕР — ДАТА ПЕРЕДАЧІ (когорта), СТАН — ЗАРАЗ. Це свідомо НЕ дохід ядра (там — дата
 * входу в етап і дедуп 9∪10), і екран це підписує. Порівнювати ці суми з «Доходом
 * лідогену» КВП не можна: відповіді на різні питання.
 *
 * 🔴 НУЛЬОВИЙ СПИСОК ІМПОРТІВ — УМОВА ІСНУВАННЯ ФАЙЛА (гейт `#407`). Гейти мусять дістати
 * ці функції без `pool` → `config`, інакше весь файл гейтів гине в оточенні без `.env`.
 * Id стадій і воронок сюди НЕ імпортуються — їх передає викличник (`ClassRules`).
 */

/** Стан угоди менеджера ЗАРАЗ — з грошового ядра (`money.handoffDealStates`). */
export type ManagerDealClass = "success" | "paid" | "expect" | "work" | "lost";
/**
 * Клас рядка списку: `none` — угоди менеджера немає; `same` — угоду вже пораховано іншою передачею;
 * `regular` — угода ПОСТІЙНОГО клієнта (`isRegularAt`): у гроші лідгена не йде (задача 4668, п.5).
 */
export type LeadgenDealClass = ManagerDealClass | "none" | "same" | "regular";

export interface LeadgenMoneyCell { n: number; sum: number; priced: number }
export interface LeadgenHandoffMoney {
  handoffs: number; unlinked: number; lost: number; sameDeal: number;
  success: LeadgenMoneyCell; paid: LeadgenMoneyCell; expect: LeadgenMoneyCell; work: LeadgenMoneyCell;
  /** Передачі в угоди постійних клієнтів — поза грошима лідгена, але НАЗВАНІ числом (невидиме читається як «таких немає»). */
  regular: LeadgenMoneyCell;
  /**
   * «Очікування» — друге головне число поруч з «Успішними» (задача 4668, п.6): оплата отримана +
   * зона «Очікуємо», тобто `paid ∪ expect`. ПОХІДНЕ, у тотожність передач не входить (не двоїти).
   */
  waiting: LeadgenMoneyCell;
  /**
   * 💰 ГРОШІ ЗА ПРАВИЛОМ ЯРОСЛАВА (30.09.2026) — головні два числа екрана:
   *  • `earned` («Успішні») — угоди менеджера, що стали «Успішна угода» В ПЕРІОДІ (дата закриття), з передач
   *    БУДЬ-ЯКОЇ давності: «прорахунок могли передати хоч пів року тому — сума рахується в місяць успіху»;
   *  • `pending` («Очікування») — угоди, у яких АВТО ПОЇХАЛО в періоді (перший вхід у «Авто працює» чи далі),
   *    а зараз вони «Оплата отримана» або в зоні «Очікуємо».
   * Решта полів — КОГОРТА передач періоду («що сталося з переданим цього періоду»); у тотожність когорти
   * `earned`/`pending` не входять. Постійні клієнти й «та сама угода» — поза грошима, як і в когорті.
   */
  earned: LeadgenMoneyCell;
  pending: LeadgenMoneyCell;
}

/**
 * ⏱ ВІКНО ЗВʼЯЗКУ «передача → угода менеджера», секунди від входу в 142. Угоду менеджера CRM
 * створює САМА в момент кваліфікації; −10 с покриває розбіжність годинників подій і угод,
 * +120 с — затримку автоматизації. Ширше вікно почне ловити чужі угоди того самого клієнта.
 */
export const LINK_BEFORE_SEC = 10;
export const LINK_AFTER_SEC = 120;

/** Один вхід угоди Продзвону в 142 — з угодою менеджера, яку знайшло вікно (або без неї). */
export interface HandoffEntry {
  pzId: number;              // угода Продзвону
  lgId: number;              // ПОТОЧНИЙ `deals.manager_id` угоди Продзвону — атрибуція
  lgTeamId: number | null;   // його команда — межа тімліда, та сама, що в рядках
  at: number;                // момент входу, мс — порядок передач
  day: string;               // київська дата входу, 'YYYY-MM-DD'
  dealId: number | null;     // угода менеджера для ЦЬОГО входу
  /** `client_key` угоди МЕНЕДЖЕРА, а без неї — угоди Продзвону (правило «постійний клієнт»). Немає — постійним не буде. */
  clientKey?: string | null;
}

const byTime = (a: HandoffEntry, b: HandoffEntry) => a.at - b.at || a.pzId - b.pzId;

/**
 * 📌 ПРАВИЛО 2: ОДНА ПЕРЕДАЧА НА УГОДУ ПРОДЗВОНУ ЗА ПЕРІОД.
 *
 * Якщо угода заходила в 142 кілька разів, передача одна, а угода менеджера береться з
 * ПЕРШОГО входу, що її МАЄ; нема такого — перший вхід, без угоди. Інакше повторний вхід,
 * який таки створив угоду, показувався б «без угоди менеджера» лише тому, що перший
 * вхід був порожній. Порядок результату — за моментом ОБРАНОГО входу.
 */
export function pickHandoffs<T extends HandoffEntry>(entries: readonly T[]): T[] {
  const first = new Map<number, T>();
  const linked = new Map<number, T>();
  for (const e of [...entries].sort(byTime)) {
    if (!first.has(e.pzId)) first.set(e.pzId, e);
    if (e.dealId != null && !linked.has(e.pzId)) linked.set(e.pzId, e);
  }
  return [...first.keys()].map((pz) => linked.get(pz) ?? first.get(pz)!).sort(byTime);
}

/**
 * 🔁 ПОСТІЙНИЙ КЛІЄНТ НА ДАТУ ПЕРЕДАЧІ (правило Ярослава, задача 4668, п.5; 30.09.2026).
 *
 * «Клієнт вважається постійним, якщо було 2+ успішних перевезень» — рахуються успіхи, закриті ДО
 * моменту передачі. Виняток: «якщо від останнього успішного пройшло 3 місяці, угода знову
 * потрапляє до лідгена, і успіх зараховується йому» — тож постійний лише той, у кого останній
 * успіх СВІЖІШИЙ за 3 місяці до дати передачі. Рівно 3 місяці тому — «пройшло», вже не постійний.
 *
 * Чому «до передачі», а не «за всю історію»: друга угода, що виросла з САМОЇ передачі, робила б
 * клієнта постійним заднім числом — і вчорашні гроші лідгена зникали б. Заодно це закриває другий
 * виняток Ярослава (прорахунок на 2 авто → менеджер створює другу угоду): угоди з цієї передачі
 * закриваються ПІСЛЯ неї й постійним клієнта не роблять.
 *
 * `successes` — успіхи клієнта (`money.clientSuccessHistory`): момент закриття, мс, і його київська дата.
 */
export const REGULAR_MIN_SUCCESSES = 2;
export const REGULAR_FRESH_MONTHS = 3;
export interface ClientSuccess { at: number; day: string }

/**
 * Київська дата на `n` календарних місяців раніше, день обрізано до довжини місяця (31.05 − 3 = 28.02).
 * Цілими місяцями (рік×12 + місяць), а НЕ `setUTCMonth`: той від 31-го перескакує місяць (борг 19 кореня).
 */
export function monthsBackDay(day: string, n: number): string {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)), d = Number(day.slice(8, 10));
  const t = y * 12 + (m - 1) - n;
  const ty = Math.floor(t / 12), tm = (t % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${String(tm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function isRegularAt(successes: readonly ClientSuccess[], h: { at: number; day: string }): boolean {
  const before = successes.filter((s) => s.at < h.at);
  if (before.length < REGULAR_MIN_SUCCESSES) return false;
  const lastDay = before.reduce((a, s) => (s.day > a ? s.day : a), before[0].day);
  return lastDay > monthsBackDay(h.day, REGULAR_FRESH_MONTHS);
}

/** Історія успіхів по `client_key` — вхід класифікації. Порожня — постійних немає (не «невідомо»). */
export type ClientHistory = ReadonlyMap<string, readonly ClientSuccess[]>;
const NO_HISTORY: ClientHistory = new Map();

/** Стан угоди менеджера й її бюджет — те, що віддає грошове ядро. */
export interface DealState {
  cls: ManagerDealClass; price: number;
  /** Київська дата закриття угоди менеджера (для «Успішних» — дата успіху). */
  closedDay?: string | null;
  /** Київська дата першого входу в етап «авто поїхало» (`ClassRules.autoWent`). */
  autoDay?: string | null;
}
/**
 * Класифікована передача. `successDay`/`autoDay` — якорі грошей: заповнені лише там, де гроші ЦІЄЇ передачі
 * можуть рахуватись (успіх / оплачено-очікуємо); у `none`/`same`/`regular` — `null`, щоб не двоїти й не рахувати
 * виключене. `inPeriod` ставить `handoffView`: чи сама передача в періоді (когорта), а не лише її гроші.
 */
export type ClassifiedHandoff<T extends HandoffEntry> = T & {
  cls: LeadgenDealClass; price: number; successDay: string | null; autoDay: string | null; inPeriod?: boolean;
};

/**
 * 📌 ПРАВИЛО 3 + 4: КЛАС КОЖНОЇ ОБРАНОЇ ПЕРЕДАЧІ.
 *
 * Угода менеджера рахується РАЗ: друга передача в ту саму угоду — `same` (гроші не двоїмо),
 * перша за часом її забирає. Передача без угоди — `none`. Угода постійного клієнта на дату
 * передачі — `regular` (поза грошима, `isRegularAt`). Решта — стан угоди ЗАРАЗ.
 *
 * 🔴 Угода без стану — це ДЕФЕКТ, а не «в роботі». Угоди з `deals` не видаляються, тож стан
 * є в кожної знайденої; якщо ні — хтось розвʼязав два запити. Мовчазний фолбек у «в роботі»
 * вигадав би стан, якого CRM не казала, тому тут голосна помилка з id.
 */
export function classifyHandoffs<T extends HandoffEntry>(
  picked: readonly T[], states: ReadonlyMap<number, DealState>, history: ClientHistory = NO_HISTORY,
  ownedEarlier: ReadonlySet<number> = new Set(),
): ClassifiedHandoff<T>[] {
  // Угоди, які забрали передачі РАНІШЕ за період, — для когорти вже «та сама угода» (гроші в них рахуються там).
  const seen = new Set<number>(ownedEarlier);
  return picked.map((h) => {
    const noAnchor = { successDay: null, autoDay: null };
    if (h.dealId == null) return Object.assign({}, h, { cls: "none" as const, price: 0 }, noAnchor);
    const st = states.get(h.dealId);
    if (!st) throw new Error(`угода менеджера ${h.dealId} (передача ${h.pzId}) без стану з грошового ядра`);
    if (h.clientKey && isRegularAt(history.get(h.clientKey) ?? [], h)) return Object.assign({}, h, { cls: "regular" as const, price: st.price }, noAnchor);
    if (seen.has(h.dealId)) return Object.assign({}, h, { cls: "same" as const, price: st.price }, noAnchor);
    seen.add(h.dealId);
    return Object.assign({}, h, {
      cls: st.cls, price: st.price,
      successDay: st.cls === "success" ? st.closedDay ?? null : null,
      autoDay: st.cls === "paid" || st.cls === "expect" ? st.autoDay ?? null : null,
    });
  });
}

const cell = (): LeadgenMoneyCell => ({ n: 0, sum: 0, priced: 0 });

/** Порожній підсумок — для місяця чи людини без передач (нуль, який СКАЗАЛИ дані). */
export function emptyHandoffMoney(): LeadgenHandoffMoney {
  return { handoffs: 0, unlinked: 0, lost: 0, sameDeal: 0, success: cell(), paid: cell(), expect: cell(), work: cell(),
    regular: cell(), waiting: cell(), earned: cell(), pending: cell() };
}

/**
 * Підсумок над УЖЕ класифікованими передачами. Тотожність, яку тримає гейт:
 * `handoffs = unlinked + sameDeal + lost + regular.n + Σ n(success, paid, expect, work)`;
 * `waiting` — похідне `paid + expect`, у тотожність не входить.
 * `priced` — скільки з `n` мають бюджет ≠ 0 (у «в роботі» його здебільшого ще немає).
 */
export function aggregateHandoffMoney(rows: readonly { cls: LeadgenDealClass; price: number }[]): LeadgenHandoffMoney {
  const out = emptyHandoffMoney();
  for (const r of rows) {
    out.handoffs++;
    if (r.cls === "none") { out.unlinked++; continue; }
    if (r.cls === "same") { out.sameDeal++; continue; }
    if (r.cls === "lost") { out.lost++; continue; }
    const add = (c: LeadgenMoneyCell) => { c.n++; c.sum += r.price; if (r.price !== 0) c.priced++; };
    add(out[r.cls]);
    if (r.cls === "paid" || r.cls === "expect") add(out.waiting);
  }
  return out;
}

/** Межа, у якій ВІДПОВІДАЄМО: команда тімліда та/або одна людина. `null` — без звуження. */
export interface HandoffScope { teamId: number | null; managerId: number | null }

export interface HandoffView<T extends HandoffEntry> {
  rows: ClassifiedHandoff<T>[];
  totals: LeadgenHandoffMoney;
  byPerson: { managerId: number; money: LeadgenHandoffMoney }[];
}

/**
 * 🔴 ПРАВИЛО 3 — СКОУП ЗВУЖУЄ ВІДПОВІДЬ, А НЕ РОЗРАХУНОК (♾ правила 1–2 кореня).
 *
 * «Одна передача на угоду Продзвону» і «та сама угода» вирішуються над УСІМ доменом
 * періоду, і лише ПОТІМ результат звужується до команди чи людини. Зворотний порядок дає
 * кожному скоупу свою правду: передача людини з команди Б, чию угоду менеджера першою
 * забрала людина з команди А, у відділі — `same`, а в тімліда Б — «успішна». Кожна
 * відповідь поодинці виглядала б правильною. Тримає `#672` (фікстура саме така).
 *
 * `domain` — УСІ входи періоду, не звужені. Звузити їх ДО виклику — рівно та помилка.
 */
export function handoffView<T extends HandoffEntry>(
  domain: readonly T[], states: ReadonlyMap<number, DealState>, scope: HandoffScope, history: ClientHistory = NO_HISTORY,
  period?: DayIn,
): HandoffView<T> {
  const inP: DayIn = period ?? (() => true);
  // Когорта: передачі періоду, одна на угоду Продзвону. «Та сама угода» — і щодо передач РАНІШЕ за період:
  // угода менеджера належить першій передачі, що до неї привела, в якому б місяці та не була.
  const inDomain = domain.filter((h) => inP(h.day));
  const firstAt = inDomain.reduce((a, h) => Math.min(a, h.at), Infinity);
  const ownedEarlier = new Set(domain.filter((h) => !inP(h.day) && h.at < firstAt && h.dealId != null).map((h) => h.dealId!));
  const cohort = classifyHandoffs(pickHandoffs(inDomain), states, history, ownedEarlier)
    .filter((h) => inScope(scope, h.lgTeamId, h.lgId)).map((h) => Object.assign(h, { inPeriod: true }));
  // Гроші — з УСІХ передач домену (будь-якої давності): угода менеджера належить першій передачі, що до неї
  // привела; «Успішні» — за датою успіху в періоді, «Очікування» — за датою авто в періоді.
  const money = anchoredRows(domain, states, history, inP).filter((h) => inScope(scope, h.lgTeamId, h.lgId));
  const key = (h: { pzId: number; dealId: number | null }) => `${h.pzId}|${h.dealId}`;
  const inCohort = new Set(cohort.map(key));
  const rows = [...cohort, ...money.filter((h) => !inCohort.has(key(h))).map((h) => Object.assign(h, { inPeriod: false }))];
  const persons = [...new Set(rows.map((h) => h.lgId))].sort((a, b) => a - b);
  const byPerson = persons.map((managerId) => ({
    managerId,
    money: withAnchored(aggregateHandoffMoney(cohort.filter((h) => h.lgId === managerId)), money.filter((h) => h.lgId === managerId), inP),
  }));
  return { rows, totals: withAnchored(aggregateHandoffMoney(cohort), money, inP), byPerson };
}

/** Предикат «київська дата в періоді» — одна форма на період, місяць тренду й одиницю розбивки. */
export type DayIn = (day: string) => boolean;
export const dayInRange = (from: string, to: string): DayIn => (d) => d >= from && d <= to;

/**
 * Передачі домену, чиї ГРОШІ потрапляють у період: класифікація над УСІМ доменом у порядку часу (перша
 * передача забирає угоду менеджера, решта — `same`), без вибору «одна на угоду Продзвону» — повторна
 * кваліфікація веде до ІНШОЇ угоди менеджера і має свої гроші.
 */
export function anchoredRows<T extends HandoffEntry>(
  domain: readonly T[], states: ReadonlyMap<number, DealState>, history: ClientHistory, inP: DayIn,
): ClassifiedHandoff<T>[] {
  const sorted = domain.filter((h) => h.dealId != null).sort(byTime);
  return classifyHandoffs(sorted, states, history)
    .filter((h) => (h.successDay != null && inP(h.successDay)) || (h.autoDay != null && inP(h.autoDay)));
}

/** «Успішні» й «Очікування» периоду над класифікованими передачами (`anchoredRows`). */
export function anchoredMoney(rows: readonly { cls: LeadgenDealClass; price: number; successDay: string | null; autoDay: string | null }[], inP: DayIn):
  { earned: LeadgenMoneyCell; pending: LeadgenMoneyCell } {
  const earned = cell(), pending = cell();
  const add = (c: LeadgenMoneyCell, price: number) => { c.n++; c.sum += price; if (price !== 0) c.priced++; };
  for (const r of rows) {
    if (r.cls === "success" && r.successDay != null && inP(r.successDay)) add(earned, r.price);
    else if ((r.cls === "paid" || r.cls === "expect") && r.autoDay != null && inP(r.autoDay)) add(pending, r.price);
  }
  return { earned, pending };
}

function withAnchored(m: LeadgenHandoffMoney, anchored: readonly ClassifiedHandoff<HandoffEntry>[], inP: DayIn): LeadgenHandoffMoney {
  const a = anchoredMoney(anchored, inP);
  return Object.assign(m, { earned: a.earned, pending: a.pending });
}

/**
 * Воронки й статуси, з яких складено клас. Єдиний екземпляр — `HANDOFF_CLASS_RULES` у реєстрі
 * корзин (`moneyBuckets.ts`); `#683` звіряє його з `FC_PIPELINES`, `STAGE_SUCCESS`, `STAGE_PAID`,
 * `EXPECT_ZONE` ядра й 143. Тут їх немає, щоб правило лишалось чистим.
 */
export interface ClassRules {
  fcPipelines: readonly number[]; success: readonly number[]; paid: readonly number[];
  expectZone: readonly number[]; lostStatus: number;
  /** Етапи «авто поїхало» (від «Авто працює» далі, без 142) — дата машини для «Очікування». */
  autoWent: readonly number[];
}

/**
 * 📌 ПРАВИЛО 4 — КЛАС УГОДИ МЕНЕДЖЕРА ЗАРАЗ. Порядок гілок — рішення, а не стиль:
 *  • `success` — повний цикл, 142 І `closed_at` є (той самий предикат, що success у `moneySourceSql`);
 *  • `paid`    — повний цикл, «Оплата отримана»;
 *  • `expect`  — повний цикл, зона «Очікуємо» І борг НЕ списаний (як усі «очікувані» з 26.08);
 *                списаний у зоні — `lost`: грошей там уже не чекають;
 *  • `lost`    — 143 у БУДЬ-ЯКІЙ воронці (у Кваліфікації це «Не цільові» / «Сміття»);
 *  • `work`    — усе інше, зокрема 142 Кваліфікації (ще не повний цикл) і 142 без `closed_at`.
 */
export function managerDealClass(
  d: { pipelineId: number; statusId: number; closed: boolean; writtenOff: boolean }, r: ClassRules,
): ManagerDealClass {
  const fc = r.fcPipelines.includes(d.pipelineId);
  if (fc && r.success.includes(d.statusId) && d.closed) return "success";
  if (fc && r.paid.includes(d.statusId)) return "paid";
  if (fc && r.expectZone.includes(d.statusId)) return d.writtenOff ? "lost" : "expect";
  if (d.statusId === r.lostStatus) return "lost";
  return "work";
}

// ─────────────────────── ФОРМА ВІДПОВІДІ — ЯВНИМИ ПОЛЯМИ ───────────────────────
// Роути не збирають відповідь спредом (`#17e2`): нове поле в підсумку не має поїхати назовні
// саме. Тому кожне поле тут назване, а роут кличе ці функції.

const cellWire = (c: LeadgenMoneyCell): LeadgenMoneyCell => ({ n: c.n, sum: c.sum, priced: c.priced });

export function handoffMoneyWire(m: LeadgenHandoffMoney): LeadgenHandoffMoney {
  return {
    handoffs: m.handoffs, unlinked: m.unlinked, lost: m.lost, sameDeal: m.sameDeal,
    success: cellWire(m.success), paid: cellWire(m.paid), expect: cellWire(m.expect), work: cellWire(m.work),
    regular: cellWire(m.regular), waiting: cellWire(m.waiting), earned: cellWire(m.earned), pending: cellWire(m.pending),
  };
}

export function personMoneyWire(managerId: number, m: LeadgenHandoffMoney): LeadgenHandoffMoney & { managerId: number } {
  const w = handoffMoneyWire(m);
  return {
    managerId, handoffs: w.handoffs, unlinked: w.unlinked, lost: w.lost, sameDeal: w.sameDeal,
    success: w.success, paid: w.paid, expect: w.expect, work: w.work, regular: w.regular, waiting: w.waiting,
    earned: w.earned, pending: w.pending,
  };
}

export function bucketMoneyWire(bucket: string, m: LeadgenHandoffMoney): LeadgenHandoffMoney & { bucket: string } {
  const w = handoffMoneyWire(m);
  return {
    bucket, handoffs: w.handoffs, unlinked: w.unlinked, lost: w.lost, sameDeal: w.sameDeal,
    success: w.success, paid: w.paid, expect: w.expect, work: w.work, regular: w.regular, waiting: w.waiting,
    earned: w.earned, pending: w.pending,
  };
}

export function bucketPersonMoneyWire(bucket: string, managerId: number, m: LeadgenHandoffMoney):
  LeadgenHandoffMoney & { bucket: string; managerId: number } {
  const w = handoffMoneyWire(m);
  return {
    bucket, managerId, handoffs: w.handoffs, unlinked: w.unlinked, lost: w.lost, sameDeal: w.sameDeal,
    success: w.success, paid: w.paid, expect: w.expect, work: w.work, regular: w.regular, waiting: w.waiting,
    earned: w.earned, pending: w.pending,
  };
}

// ─────────────────────── РЯДОК СПИСКУ «ГРОШІ З ПЕРЕДАЧ» ───────────────────────

/** Вхід у 142 з описом обох угод — усе, що дає запит звʼязку, крім грошей (їх дає `money.ts`). */
export interface HandoffLinkInfo extends HandoffEntry {
  pzName: string | null; pzClient: string | null;
  dealName: string | null; dealClient: string | null; salesManager: string | null;
  dealReason: string | null; closedDay: string | null; planPayDay: string | null;
}

/** Одна передача в списку «Гроші з передач» — форма, яку читає екран. */
export interface LeadgenHandoffDeal {
  day: string; lgId: number; pzId: number; dealId: number | null;
  route: string | null; client: string | null; salesManager: string | null; stage: string | null;
  cls: LeadgenDealClass; price: number; closedDay: string | null; planPayDay: string | null;
  reason: string | null; url: string | null;
  /** Дата «авто поїхало» (для «Очікування»); `null` — ще не поїхало або не про гроші. */
  autoDay: string | null;
  /** Передача — у вибраному періоді; `false` — передано раніше, а в період потрапили її ГРОШІ. */
  inPeriod: boolean;
}

/** Порожній або з самих пробілів текст CRM — «не заповнено», а не порожній підпис. */
export const blankToNull = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

/**
 * Залежності рядка, що живуть поза чистим модулем: назви стадій (`stageNames.stageName`), воронки
 * Кваліфікації (`leadgenStages.QUALIFICATION_PIPELINES`) і посилання в CRM (`kommoLeadUrl`).
 * Передає їх ядро; `#684b` на живій базі доводить, що передає саме ці.
 */
export interface HandoffRowDeps {
  stageName: (pipelineId: number, statusId: number) => string;
  qualificationPipelines: readonly number[];
  leadUrl: (kommoId: number) => string;
}

/**
 * 📋 РЯДОК СПИСКУ ПЕРЕДАЧ (правило 8 і макет, ревʼю F4). Кожне поле — рішення, тож тут, а не в `map`:
 *  • `route`/`client` — з угоди МЕНЕДЖЕРА; немає угоди або поле порожнє — з угоди Продзвону;
 *  • `salesManager`, `closedDay`, `planPayDay` — лише коли угода менеджера є (`none` — `null`);
 *  • `stage` — поточна стадія угоди менеджера; Кваліфікацію видно одразу префіксом
 *    «Кваліфікація · », бо це ще НЕ повний цикл; без угоди — `null`;
 *  • `reason` — ЛИШЕ для `lost`: причина відмови в угоді, що ще в роботі чи вже «та сама», —
 *    стара й читалась би як причина провалу;
 *  • `url` — угода менеджера, а без неї — угода Продзвону (посилання є завжди).
 */
export function handoffDealRow(
  h: ClassifiedHandoff<HandoffLinkInfo>, st: { pipelineId: number; statusId: number } | undefined, deps: HandoffRowDeps,
): LeadgenHandoffDeal {
  const linked = h.dealId != null;
  let stage: string | null = null;
  if (linked && st) {
    const name = deps.stageName(st.pipelineId, st.statusId);
    stage = deps.qualificationPipelines.includes(st.pipelineId) ? `Кваліфікація · ${name}` : name;
  }
  return {
    day: h.day, lgId: h.lgId, pzId: h.pzId, dealId: h.dealId,
    route: blankToNull(linked ? h.dealName : null) ?? blankToNull(h.pzName),
    client: blankToNull(linked ? h.dealClient : null) ?? blankToNull(h.pzClient),
    salesManager: linked ? h.salesManager : null,
    stage,
    cls: h.cls, price: h.price,
    closedDay: linked ? h.closedDay : null,
    planPayDay: linked ? h.planPayDay : null,
    reason: h.cls === "lost" ? blankToNull(h.dealReason) : null,
    url: deps.leadUrl(h.dealId ?? h.pzId),
    autoDay: h.autoDay, inPeriod: h.inPeriod !== false,
  };
}

// ─────────────────────── МЕЖА ТІМЛІДА — ОДИН ПОМІЧНИК НА ТРИ РОУТИ ЕКРАНА ───────────────────────

/**
 * 🔒 СКОУП ВІДПОВІДІ З РОЛІ — ЄДИНЕ МІСЦЕ, ДЕ ВІН ОБЧИСЛЮЄТЬСЯ для `/leadgen-stats`,
 * `/leadgen-trend` і `/leadgen-handoff-deals` (рішення власника 22.09.2026, правило 7).
 *  • тімлід — лише своя команда; без команди — `-1` (жодної), а НЕ `null` (весь відділ):
 *    порожній скоуп не можна виражати значенням, що означає «без обмеження» (♾ правило 7);
 *  • менеджер — ніщо (`-1`/`-1`). Роут відмовляє йому першим оператором; тут — друга лінія,
 *    щоб помилковий виклик дав порожнечу, а не чужі гроші;
 *  • решта (адмін-рівень, фінансист, КВП…) — весь відділ.
 *
 * 🔴 НАВІЩО ОКРЕМОЮ ФУНКЦІЄЮ (ревʼю F1). Скоуп писався в кожному обробнику літералом, і жоден
 * гейт не дивився, ЩО саме передано в ядро: `{ teamId: null, … }` у роуті давав тімліду гроші
 * всього відділу при повністю зеленому наборі. Тепер роут не складає скоуп сам — `#681b`
 * вимагає, щоб у ядро йшов саме результат цієї функції (або `clamp.scope`, що з неї ж).
 */
export function leadgenAuthScope(auth: { role: string; teamId: number | null | undefined }): HandoffScope {
  if (auth.role === "manager") return { teamId: -1, managerId: -1 };
  if (auth.role === "team_lead") return { teamId: auth.teamId ?? -1, managerId: null };
  return { teamId: null, managerId: null };
}

export type HandoffDealsScope = { ok: true; scope: HandoffScope } | { ok: false; status: 403 };

/**
 * 🔒 ХТО ЯКИЙ СПИСОК ПЕРЕДАЧ БАЧИТЬ — та сама межа, що в рядків `/leadgen-stats`
 * (`leadgenAuthScope`), плюс одна людина:
 *  • менеджер — 403 (роут перевіряє це першим оператором; тут — друга лінія);
 *  • тімлід — лише своя команда; `managerId` людини з ЧУЖОЇ команди (або невідомої) — 403,
 *    а не порожній список: порожнеча читалась би як «у неї нуль передач»;
 *  • решта — будь-кого, або весь відділ.
 * `managerTeamId` — команда запитаної людини (`undefined` — такої людини немає).
 */
export function handoffDealsScope(
  auth: { role: string; teamId: number | null | undefined },
  managerId: number | null, managerTeamId: number | null | undefined,
): HandoffDealsScope {
  if (auth.role === "manager") return { ok: false, status: 403 };
  const base = leadgenAuthScope(auth);
  if (base.teamId != null && managerId != null && managerTeamId !== base.teamId) return { ok: false, status: 403 };
  return { ok: true, scope: { teamId: base.teamId, managerId } };
}

// ─────────────────────── ВІКНО ТРЕНДУ ───────────────────────

/**
 * 📅 ВІКНО ТРЕНДУ: `months` календарних місяців, що закінчуються місяцем `to`. Перший день —
 * перше число найранішого місяця. Рахується ЦІЛИМИ місяцями (рік×12 + місяць), а не
 * `setUTCMonth` від `to`: той від 31-го числа перескакує місяць (борг 19 кореня).
 * Межі: `months` поза 1…24 обрізається.
 */
export const TREND_MONTHS_DEFAULT = 12;
export const TREND_MONTHS_MAX = 24;
export function trendWindow(to: string, months: number): { from: string; months: number; monthStarts: string[] } {
  const n = Math.min(TREND_MONTHS_MAX, Math.max(1, Math.trunc(months)));
  const y = Number(to.slice(0, 4)), m = Number(to.slice(5, 7));
  const end = y * 12 + (m - 1);
  const monthStarts: string[] = [];
  for (let t = end - n + 1; t <= end; t++) {
    monthStarts.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`);
  }
  return { from: monthStarts[0], months: n, monthStarts };
}

// ─────────────────────── РОЗБИВКА І ТРЕНД — ЧИСТА ЗБІРКА З РЯДКІВ ЗАПИТІВ ───────────────────────
// Ядро (`leadgenStats.ts`) лише виконує запити й кличе ці функції. Збірка тут, щоб її можна було
// перевірити викликом без бази (`#682`): ревʼю F2 показало, що підміна ростеру дзвінків чи
// дедупу грошей у тренді проходила при зеленому наборі — жоден тест збірки не виконував.

/** Одна людина в одній одиниці: ті самі пʼять показників, що в рядку, і команда — для межі тімліда. */
export interface LeadgenPersonBucketRow {
  bucket: string; managerId: number; teamId: number | null;
  calls: number; leads: number; opr: number; quotes: number; warming: number;
}
/** Рядок запиту стадій у формі з одиницею (`stageCountsQuery(…, grain)`), уже числами. */
export interface StageBucketRow {
  bucket: string; managerId: number; teamId: number | null;
  leads: number; opr: number; quotes: number; warming: number;
}
/** Рядок запиту дзвінків у формі з одиницею: успішні дзвінки людини в одиниці. */
export interface CallBucketRow { bucket: string; managerId: number; calls: number }

/**
 * 📅 ЗЛИТТЯ СТАДІЙ І ДЗВІНКІВ ПО ОДИНИЦЯХ. Ростер — люди з подіями стадій (як у рядках):
 *  • `rosterPerBucket = false` (день/тиждень усередині ОДНОГО періоду) — ростер = люди періоду:
 *    дзвінок у вівторок рахується й тоді, коли стадій того дня не було, рівно як у рядку;
 *  • `true` (місяці тренду) — кожен місяць є ОКРЕМИМ періодом `/leadgen-stats`, тож і ростер
 *    свій: людина без подій у місяці не отримує в ньому дзвінків, як у `/leadgen-stats` того місяця.
 * Дзвінки людини, якої немає в ростері періоду, не потрапляють нікуди — як у запиті рядків.
 */
export function mergeBucketRows(
  stages: readonly StageBucketRow[], calls: readonly CallBucketRow[], rosterPerBucket: boolean,
): LeadgenPersonBucketRow[] {
  const key = (b: string, m: number) => `${b}|${m}`;
  const rows = new Map<string, LeadgenPersonBucketRow>();
  const teamOf = new Map<number, number | null>();
  for (const r of stages) {
    teamOf.set(r.managerId, r.teamId);
    rows.set(key(r.bucket, r.managerId), {
      bucket: r.bucket, managerId: r.managerId, teamId: r.teamId, calls: 0,
      leads: r.leads, opr: r.opr, quotes: r.quotes, warming: r.warming,
    });
  }
  for (const c of calls) {
    const row = rows.get(key(c.bucket, c.managerId));
    if (row) { row.calls += c.calls; continue; }
    if (rosterPerBucket || !teamOf.has(c.managerId)) continue;
    rows.set(key(c.bucket, c.managerId), { bucket: c.bucket, managerId: c.managerId, teamId: teamOf.get(c.managerId) ?? null,
      calls: c.calls, leads: 0, opr: 0, quotes: 0, warming: 0 });
  }
  return [...rows.values()].sort((a, b) => a.bucket.localeCompare(b.bucket) || a.managerId - b.managerId);
}

/** Людина в скоупі відповіді — та сама межа, що в `handoffView`. */
const inScope = (s: HandoffScope, teamId: number | null, managerId: number): boolean =>
  (s.teamId == null || teamId === s.teamId) && (s.managerId == null || managerId === s.managerId);

/** Відділ (або команда) по одиницях = сума людей. `only` — одиниці, що мусять бути у відповіді навіть нулем. */
export function sumBuckets(rows: readonly LeadgenPersonBucketRow[], only?: readonly string[]):
  { bucket: string; calls: number; leads: number; opr: number; quotes: number; warming: number }[] {
  const by = new Map<string, { bucket: string; calls: number; leads: number; opr: number; quotes: number; warming: number }>();
  for (const b of only ?? []) by.set(b, { bucket: b, calls: 0, leads: 0, opr: 0, quotes: 0, warming: 0 });
  for (const r of rows) {
    if (only && !by.has(r.bucket)) continue;
    const x = by.get(r.bucket) ?? { bucket: r.bucket, calls: 0, leads: 0, opr: 0, quotes: 0, warming: 0 };
    x.calls += r.calls; x.leads += r.leads; x.opr += r.opr; x.quotes += r.quotes; x.warming += r.warming;
    by.set(r.bucket, x);
  }
  return [...by.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** Рядок людини в одиниці — у формі відповіді, явними полями (без команди). */
export function personBucketWire(r: LeadgenPersonBucketRow):
  { bucket: string; managerId: number; calls: number; leads: number; opr: number; quotes: number; warming: number } {
  return { bucket: r.bucket, managerId: r.managerId, calls: r.calls, leads: r.leads, opr: r.opr, quotes: r.quotes, warming: r.warming };
}

export interface TrendMoneyBucket {
  bucket: string; totals: LeadgenHandoffMoney; byPerson: { managerId: number; money: LeadgenHandoffMoney }[];
}
export interface TrendAssembly { monthStarts: string[]; byPerson: LeadgenPersonBucketRow[]; money: TrendMoneyBucket[] }

/**
 * 📈 ЗБІРКА ТРЕНДУ: кожен місяць — ОКРЕМИЙ період `/leadgen-stats`.
 *  • лічильники й дзвінки — `mergeBucketRows(…, true)`: ростер свій на місяць;
 *  • гроші з передач — `handoffView` над передачами ЛИШЕ цього місяця: вибір передачі й «та сама
 *    угода» в межах місяця, як у `/leadgen-stats` того місяця (угода менеджера, до якої привели
 *    передачі двох різних місяців, рахується в кожному з них — бо кожен місяць свій період);
 *  • місяць, що цілком лежить до першої події журналу (`firstDay`), не звітується: база його не
 *    памʼятає, «0» там був би вигадкою (♾ правило 17). `firstDay = null` — подій немає зовсім.
 * Вхід — рядки запитів за ВСЕ вікно у формі з місяцем; `#682` вимагає, щоб кожен місяць збігався
 * з тією самою збіркою над одним цим місяцем.
 */
export function assembleTrend<T extends HandoffEntry>(input: {
  monthStarts: readonly string[]; stages: readonly StageBucketRow[]; calls: readonly CallBucketRow[];
  links: readonly T[]; states: ReadonlyMap<number, DealState>; firstDay: string | null; scope: HandoffScope;
  history?: ClientHistory;
}): TrendAssembly {
  const { firstDay, scope } = input;
  const monthStarts = firstDay == null ? [] : input.monthStarts.filter((m) => m.slice(0, 7) >= firstDay.slice(0, 7));
  const byPerson = mergeBucketRows(input.stages, input.calls, true).filter((r) => inScope(scope, r.teamId, r.managerId));
  const money = monthStarts.map((ms): TrendMoneyBucket => {
    const ym = ms.slice(0, 7);
    // Той самий `handoffView`, що й `/leadgen-stats` місяця: когорта — передачі місяця, гроші — з усього домену.
    const v = handoffView(input.links, input.states, scope, input.history, (d) => d.slice(0, 7) === ym);
    return { bucket: ms, totals: v.totals, byPerson: v.byPerson };
  });
  return { monthStarts, byPerson, money };
}

// ─────────────────────── ГРОШІ ПО ТИЖНЯХ І ДНЯХ ПЕРІОДУ (задача 4668, п.6) ───────────────────────

/** Понеділок тижня київської дати `day` ('YYYY-MM-DD') — той самий ключ, що `bucketKeySql("week")`. */
export function mondayOf(day: string): string {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  const dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 📅 ГРОШІ З ПЕРЕДАЧ ПО ОДИНИЦЯХ ПЕРІОДУ — розклад ТИХ САМИХ класифікованих передач, що й підсумок
 * періоду, за днем передачі (день або понеділок тижня). Одна передача й «та сама угода» вирішені над
 * періодом (`handoffView`), тож Σ одиниць == підсумку періоду ЗАВЖДИ (`#1092`) — на відміну від
 * лічильників стадій, де угода з двома входами в різні тижні рахується в кожному.
 * Вхід — `rows` уже звуженого скоупу (межа тімліда з того самого `handoffView`).
 */
export function handoffMoneyBuckets<T extends HandoffEntry>(
  rows: readonly ClassifiedHandoff<T>[], grain: "day" | "week", period: DayIn = () => true,
): TrendMoneyBucket[] {
  // Три якорі — три розклади: когорта за днем передачі, «Успішні» — за днем успіху, «Очікування» — за днем авто.
  const k = (d: string) => (grain === "day" ? d : mondayOf(d));
  const cohort = new Map<string, ClassifiedHandoff<T>[]>(), money = new Map<string, ClassifiedHandoff<T>[]>();
  const put = (m: Map<string, ClassifiedHandoff<T>[]>, b: string, r: ClassifiedHandoff<T>) => { const xs = m.get(b) ?? []; xs.push(r); m.set(b, xs); };
  for (const r of rows) {
    if (r.inPeriod !== false && period(r.day)) put(cohort, k(r.day), r);
    if (r.cls === "success" && r.successDay != null && period(r.successDay)) put(money, k(r.successDay), r);
    else if ((r.cls === "paid" || r.cls === "expect") && r.autoDay != null && period(r.autoDay)) put(money, k(r.autoDay), r);
  }
  const buckets = [...new Set([...cohort.keys(), ...money.keys()])].sort();
  return buckets.map((bucket): TrendMoneyBucket => {
    const cs = cohort.get(bucket) ?? [], ms = money.get(bucket) ?? [];
    const inB: DayIn = (d) => k(d) === bucket && period(d);
    const persons = [...new Set([...cs, ...ms].map((h) => h.lgId))].sort((a, b) => a - b);
    return {
      bucket, totals: withAnchored(aggregateHandoffMoney(cs), ms, inB),
      byPerson: persons.map((managerId) => ({ managerId,
        money: withAnchored(aggregateHandoffMoney(cs.filter((h) => h.lgId === managerId)), ms.filter((h) => h.lgId === managerId), inB) })),
    };
  });
}

// ─────────────────────── ПАРАМЕТРИ ЗАПИТІВ ЕКРАНА ЛІДОГЕНУ ───────────────────────
// Чисті, щоб їх межі перевірялись викликом, а не читанням роуту. Порожній рядок у query —
// «не задано» (той самий урок, що `dateParam`: `?grain=` доходить до сервера як "").

/** `grain` для `/leadgen-stats`: `null` — не задано; `"bad"` — задано щось інше, ніж день/тиждень (400). */
export function parseLeadgenGrain(v: unknown): "day" | "week" | null | "bad" {
  if (v === undefined || v === null || v === "") return null;
  return v === "day" || v === "week" ? v : "bad";
}

/**
 * `months` для `/leadgen-trend`: не задано — 12; ціле — обрізається до 1…24; не ціле — `null` (400).
 * Обрізання, а не відмова: «дай 36 місяців» — зрозуміле прохання з відомою стелею.
 */
export function parseTrendMonths(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return TREND_MONTHS_DEFAULT;
  if (typeof v !== "string" || !/^-?\d+$/.test(v.trim())) return null;
  return Math.min(TREND_MONTHS_MAX, Math.max(1, Number(v.trim())));
}

/** `managerId`: не задано — `null`; додатне ціле — число; будь-що інше — `"bad"` (400). */
export function parseManagerIdParam(v: unknown): number | null | "bad" {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d+$/.test(v.trim())) return "bad";
  const n = Number(v.trim());
  return n > 0 && Number.isSafeInteger(n) ? n : "bad";
}
