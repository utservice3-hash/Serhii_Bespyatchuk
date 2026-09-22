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
/** Клас рядка списку: `none` — угоди менеджера немає; `same` — угоду вже пораховано іншою передачею. */
export type LeadgenDealClass = ManagerDealClass | "none" | "same";

export interface LeadgenMoneyCell { n: number; sum: number; priced: number }
export interface LeadgenHandoffMoney {
  handoffs: number; unlinked: number; lost: number; sameDeal: number;
  success: LeadgenMoneyCell; paid: LeadgenMoneyCell; expect: LeadgenMoneyCell; work: LeadgenMoneyCell;
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

/** Стан угоди менеджера й її бюджет — те, що віддає грошове ядро. */
export interface DealState { cls: ManagerDealClass; price: number }
export type ClassifiedHandoff<T extends HandoffEntry> = T & { cls: LeadgenDealClass; price: number };

/**
 * 📌 ПРАВИЛО 3 + 4: КЛАС КОЖНОЇ ОБРАНОЇ ПЕРЕДАЧІ.
 *
 * Угода менеджера рахується РАЗ: друга передача в ту саму угоду — `same` (гроші не двоїмо),
 * перша за часом її забирає. Передача без угоди — `none`. Решта — стан угоди ЗАРАЗ.
 *
 * 🔴 Угода без стану — це ДЕФЕКТ, а не «в роботі». Угоди з `deals` не видаляються, тож стан
 * є в кожної знайденої; якщо ні — хтось розвʼязав два запити. Мовчазний фолбек у «в роботі»
 * вигадав би стан, якого CRM не казала, тому тут голосна помилка з id.
 */
export function classifyHandoffs<T extends HandoffEntry>(
  picked: readonly T[], states: ReadonlyMap<number, DealState>,
): ClassifiedHandoff<T>[] {
  const seen = new Set<number>();
  return picked.map((h) => {
    if (h.dealId == null) return Object.assign({}, h, { cls: "none" as const, price: 0 });
    const st = states.get(h.dealId);
    if (!st) throw new Error(`угода менеджера ${h.dealId} (передача ${h.pzId}) без стану з грошового ядра`);
    if (seen.has(h.dealId)) return Object.assign({}, h, { cls: "same" as const, price: st.price });
    seen.add(h.dealId);
    return Object.assign({}, h, { cls: st.cls, price: st.price });
  });
}

const cell = (): LeadgenMoneyCell => ({ n: 0, sum: 0, priced: 0 });

/** Порожній підсумок — для місяця чи людини без передач (нуль, який СКАЗАЛИ дані). */
export function emptyHandoffMoney(): LeadgenHandoffMoney {
  return { handoffs: 0, unlinked: 0, lost: 0, sameDeal: 0, success: cell(), paid: cell(), expect: cell(), work: cell() };
}

/**
 * Підсумок над УЖЕ класифікованими передачами. Тотожність, яку тримає гейт:
 * `handoffs = unlinked + sameDeal + lost + Σ n(success, paid, expect, work)`.
 * `priced` — скільки з `n` мають бюджет ≠ 0 (у «в роботі» його здебільшого ще немає).
 */
export function aggregateHandoffMoney(rows: readonly { cls: LeadgenDealClass; price: number }[]): LeadgenHandoffMoney {
  const out = emptyHandoffMoney();
  for (const r of rows) {
    out.handoffs++;
    if (r.cls === "none") { out.unlinked++; continue; }
    if (r.cls === "same") { out.sameDeal++; continue; }
    if (r.cls === "lost") { out.lost++; continue; }
    const c = out[r.cls];
    c.n++; c.sum += r.price; if (r.price !== 0) c.priced++;
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
  domain: readonly T[], states: ReadonlyMap<number, DealState>, scope: HandoffScope,
): HandoffView<T> {
  const all = classifyHandoffs(pickHandoffs(domain), states);
  const rows = all.filter((h) =>
    (scope.teamId == null || h.lgTeamId === scope.teamId) && (scope.managerId == null || h.lgId === scope.managerId));
  const per = new Map<number, ClassifiedHandoff<T>[]>();
  for (const h of rows) { const xs = per.get(h.lgId) ?? []; xs.push(h); per.set(h.lgId, xs); }
  const byPerson = [...per.entries()].sort((a, b) => a[0] - b[0])
    .map(([managerId, xs]) => ({ managerId, money: aggregateHandoffMoney(xs) }));
  return { rows, totals: aggregateHandoffMoney(rows), byPerson };
}

/**
 * Воронки й статуси, з яких складено клас. Передає грошове ядро СВОЇМИ константами
 * (`FC_PIPELINES`, `STAGE_SUCCESS`, `STAGE_PAID`, `EXPECT_ZONE`, 143) — тут їх немає, щоб
 * правило лишалось чистим, а константи — одними на весь продукт.
 */
export interface ClassRules {
  fcPipelines: readonly number[]; success: readonly number[]; paid: readonly number[];
  expectZone: readonly number[]; lostStatus: number;
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
  };
}

export function personMoneyWire(managerId: number, m: LeadgenHandoffMoney): LeadgenHandoffMoney & { managerId: number } {
  const w = handoffMoneyWire(m);
  return {
    managerId, handoffs: w.handoffs, unlinked: w.unlinked, lost: w.lost, sameDeal: w.sameDeal,
    success: w.success, paid: w.paid, expect: w.expect, work: w.work,
  };
}

export function bucketMoneyWire(bucket: string, m: LeadgenHandoffMoney): LeadgenHandoffMoney & { bucket: string } {
  const w = handoffMoneyWire(m);
  return {
    bucket, handoffs: w.handoffs, unlinked: w.unlinked, lost: w.lost, sameDeal: w.sameDeal,
    success: w.success, paid: w.paid, expect: w.expect, work: w.work,
  };
}

export function bucketPersonMoneyWire(bucket: string, managerId: number, m: LeadgenHandoffMoney):
  LeadgenHandoffMoney & { bucket: string; managerId: number } {
  const w = handoffMoneyWire(m);
  return {
    bucket, managerId, handoffs: w.handoffs, unlinked: w.unlinked, lost: w.lost, sameDeal: w.sameDeal,
    success: w.success, paid: w.paid, expect: w.expect, work: w.work,
  };
}

// ─────────────────────── МЕЖА ТІМЛІДА ДЛЯ СПИСКУ ПЕРЕДАЧ ───────────────────────

export type HandoffDealsScope = { ok: true; scope: HandoffScope } | { ok: false; status: 403 };

/**
 * 🔒 ХТО ЯКИЙ СПИСОК ПЕРЕДАЧ БАЧИТЬ — та сама межа, що в рядків `/leadgen-stats`.
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
  if (auth.role === "team_lead") {
    const teamId = auth.teamId ?? -1;
    if (managerId != null && managerTeamId !== teamId) return { ok: false, status: 403 };
    return { ok: true, scope: { teamId, managerId } };
  }
  return { ok: true, scope: { teamId: null, managerId } };
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
