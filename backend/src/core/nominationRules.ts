/**
 * 🏆 НОМІНАЦІЇ ТИЖНЯ — ЧИСТІ ПРАВИЛА (без жодного імпорту, щоб гейти бігли без `.env`).
 *
 * Звідки задача: щовівторка Даша збирала презентацію руками, а числа їй писали тімліди в чаті
 * «Керівники» — кожен своїм способом (заміряно 21.09.2026: у РНК рахували від «успішно
 * реалізовано», Яцик — від дати завантаження; нічиї губились). Тепер число рахує ядро за ОДНИМ
 * правилом, тімлід лише підтверджує або виправляє з причиною, у вівторок 08:00 тиждень фіксується.
 *
 * Рішення 21.09.2026 (Роман): правило «як на Звіті» — гроші = «Факт» Звіту (②), авто = колонка
 * «Авто» (дата завантаження); нічия — показуємо всіх; тімліди змагаються у своїй команді; рядок про
 * себе тімлід не виправляє — лише керівництво; фіксація — вівторок 08:00; порогу маржі немає.
 * Що рахує кожна номінація — `NOMINATIONS` нижче; звідки число — `core/nominations.ts`.
 */

/** Редакція правила — пишеться в кожен зафіксований тиждень. Змінив означення → нова редакція. */
export const NOMINATION_RULE_VERSION = "2026-09-21·report-A";

/** Номінації менеджерів + (22.09.2026) номінації лідогенераторів із префіксом `lg`. */
export type NominationKey = "maxDeal" | "cars" | "revenue" | "marginPct" | "intl" | "lgMaxDeal" | "lgCars" | "lgQuotes" | "lgIntl";
export type Unit = "uah" | "count" | "pct";
export interface NominationDef {
  key: NominationKey; label: string; hint: string; unit: Unit;
  /**
   * «Рахуємо / Не рахуємо» простими словами для тімліда (затверджено Романом 22.09.2026). Описують
   * ЧИННИЙ код, а не бажання: зміниш означення — перепиши й ці рядки (#656). `hint` лишається для слайдів.
   */
  rule: string; notCounted: string;
  /**
   * У CRM цього числа немає (22.09.2026, лідогенератори): звʼязку «угода → лідогенератор» у Kommo немає, тож
   * система нічого не пропонує, а число вводить тімлід лідогенерації або керівництво («Свої дані»).
   * Порожнеча тоді — не «ніхто не набрав», а «даних ще немає».
   */
  noCrm?: boolean;
}

/** Порядок = порядок на екрані й на слайді. Підпис каже, ЯКУ колонку Звіту взято. */
export const NOMINATIONS: readonly NominationDef[] = [
  { key: "maxDeal", label: "Найбільший разовий зазор", hint: "найбільша маржа однієї угоди у «Факті» Звіту", unit: "uah",
    rule: "найбільша маржа однієї угоди у «Факті»: оплата отримана або успішно реалізовано за тиждень.",
    notCounted: "завантажені, але ще не оплачені й не успішні угоди." },
  { key: "cars", label: "Найбільша к-сть поставлених авто", hint: "колонка «Авто» Звіту (дата завантаження)", unit: "count",
    rule: "угоди з датою завантаження в цьому тижні — як «Авто» на Звіті.",
    notCounted: "угоди, що лише зайшли в оплату чи успіх." },
  { key: "revenue", label: "Найбільший результат за тиждень", hint: "«Факт» Звіту: оплата отримана + успішно реалізовано", unit: "uah",
    rule: "«Факт» — оплата отримана + успішно реалізовано, за датою входу в етап; сторно віднімається.",
    notCounted: "завантажені, але ще не оплачені угоди." },
  { key: "marginPct", label: "Найбільший % маржі", hint: "маржа угоди ÷ «Расход 1» (виплата водію)", unit: "pct",
    rule: "маржа угоди ÷ «Расход 1» (виплата водію), серед угод «Факту».",
    notCounted: "угоди без «Расходу 1»." },
  { key: "intl", label: "Найбільша к-сть міжнародних", hint: "«Авто» з «Тип запиту = Міжнародні»", unit: "count",
    rule: "«Авто» з «Типом запиту = Міжнародні».",
    notCounted: "угоди з порожнім «Типом запиту»." },
];
/**
 * 📣 РЕЙТИНГ ЛІДОГЕНЕРАТОРІВ (22.09.2026, слайд 4 Даші). «Прорахунки» — з CRM, як у вкладці «Лідогенерація»
 * (`leadgenStats().quotes`: входи в «Кваліфіковано» воронок Продзвону; за 14–20.09 — Демчук 36, як у Даші).
 * Зазор, авто й міжнародні лідогенератора в CRM не повʼязані з людиною — їх вводять тімлід лідогенерації
 * або керівництво з причиною (рішення Романа 22.09: «залишай можливість тімлідам і Даші змінювати числа»).
 */
export const LEADGEN_NOMINATIONS: readonly NominationDef[] = [
  { key: "lgMaxDeal", label: "Найбільший разовий зазор", hint: "дані тімліда лідогенерації", unit: "uah", noCrm: true,
    rule: "найбільша маржа однієї угоди, яку привів лідогенератор, — вносить тімлід або керівництво.",
    notCounted: "у CRM звʼязку угоди з лідогенератором немає, тож система числа не пропонує." },
  { key: "lgCars", label: "Найбільша кількість поставлених авто", hint: "дані тімліда лідогенерації", unit: "count", noCrm: true,
    rule: "поставлені авто за угодами, які привів лідогенератор, — вносить тімлід або керівництво.",
    notCounted: "у CRM звʼязку угоди з лідогенератором немає, тож система числа не пропонує." },
  { key: "lgQuotes", label: "Найбільша кількість прорахунків", hint: "«Прорахунки» вкладки «Лідогенерація»", unit: "count",
    rule: "входи угод у «Кваліфіковано» воронок Продзвону за тиждень — як «Прорахунки» у вкладці «Лідогенерація».",
    notCounted: "реєстр бота й угоди, що не дійшли до «Кваліфіковано»." },
  { key: "lgIntl", label: "Найбільша кількість міжнародних перевезень", hint: "дані тімліда лідогенерації", unit: "count", noCrm: true,
    rule: "міжнародні перевезення за угодами, які привів лідогенератор, — вносить тімлід або керівництво.",
    notCounted: "у CRM звʼязку угоди з лідогенератором немає, тож система числа не пропонує." },
];
export const NOMINATION_KEYS: readonly NominationKey[] = NOMINATIONS.map((n) => n.key);
export const LEADGEN_KEYS: readonly NominationKey[] = LEADGEN_NOMINATIONS.map((n) => n.key);
export const isNominationKey = (k: unknown): k is NominationKey =>
  typeof k === "string" && ((NOMINATION_KEYS as readonly string[]).includes(k) || (LEADGEN_KEYS as readonly string[]).includes(k));

/** Позначка на слайді: маржа понад 250% від виплати водію (з повідомлення Даші тімлідам). Це НЕ поріг участі. */
export const MARGIN_FLAG_PCT = 250;

// ───────────────────────── тиждень за Києвом ─────────────────────────

const KYIV = "Europe/Kyiv";
/** Київська календарна дата моменту — `YYYY-MM-DD`. */
export const kyivDate = (at: Date): string => at.toLocaleDateString("en-CA", { timeZone: KYIV });
const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Тиждень Пн–Нд, що містить київську дату `ymd`. Обидва кінці включно. */
export function weekOf(ymd: string): { from: string; to: string } {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 = неділя
  const from = addDays(ymd, -((dow + 6) % 7));
  return { from, to: addDays(from, 6) };
}
/** Минулий повний тиждень відносно моменту `at` (за Києвом). */
export const lastWeek = (at: Date): { from: string; to: string } => weekOf(addDays(weekOf(kyivDate(at)).from, -7));

/**
 * Коли тиждень фіксується: вівторок 08:00 за Києвом після його неділі. До цієї миті тиждень —
 * чернетка, яку тімліди ще правлять. Повертає київські дату й годину, а не UTC-мить: крон
 * і догін міряють «чи настало» теж за Києвом (`isFreezeDue`).
 */
export const freezeAt = (weekFrom: string): { date: string; hour: number } => ({ date: addDays(weekFrom, 8), hour: 8 });
/**
 * Та сама мить фіксації, але як UTC-момент — для зворотного відліку на екрані (#655). Київ живе то
 * в +03:00, то в +02:00 (25.10.2026 — перехід), тож зсув не вгадуємо, а перевіряємо годинником Києва.
 */
export function freezeInstant(weekFrom: string): string {
  const { date, hour } = freezeAt(weekFrom);
  const [y, m, d] = date.split("-").map(Number);
  for (const off of [3, 2]) {
    const t = new Date(Date.UTC(y, m - 1, d, hour - off));
    const h = Number(t.toLocaleString("en-GB", { timeZone: KYIV, hour: "2-digit", hour12: false }));
    if (h === hour && kyivDate(t) === date) return t.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, d, hour - 2)).toISOString();
}
export function isFreezeDue(weekFrom: string, at: Date): boolean {
  const { date, hour } = freezeAt(weekFrom);
  const today = kyivDate(at);
  if (today !== date) return today > date;
  const h = Number(at.toLocaleString("en-GB", { timeZone: KYIV, hour: "2-digit", hour12: false }));
  return h >= hour;
}

// ───────────────────────── переможець ─────────────────────────

export interface Candidate { managerId: number; value: number | null }
export type Ranked = { state: "ok"; value: number; winners: number[] } | { state: "empty" };

/** Два знаки після коми: гроші й відсотки з `numeric` не мусять програвати нічию на шумі float. */
const norm = (v: number): number => Math.round(v * 100) / 100;

/**
 * Переможець номінації серед кандидатів (#602).
 * · бере участь лише значення > 0: нуль — це «не набрав», від'ємна маржа (сторно) — не перемога;
 * · нічия — УСІ, у кого максимум (рішення 21.09.2026), у стабільному порядку id;
 * · ніхто не набрав — чесний стан `empty`, а не «0» і не вигаданий переможець.
 */
export function rankNominees(cands: readonly Candidate[]): Ranked {
  const live = cands.filter((c): c is { managerId: number; value: number } => c.value != null && Number.isFinite(c.value) && norm(c.value) > 0);
  if (live.length === 0) return { state: "empty" };
  const best = Math.max(...live.map((c) => norm(c.value)));
  const winners = live.filter((c) => norm(c.value) === best).map((c) => c.managerId).sort((a, b) => a - b);
  return { state: "ok", value: best, winners };
}

/**
 * Рейтинг команди в номінації (#652): УСІ учасники, спершу ті, хто набрав (> 0), за спаданням; нічия —
 * у порядку id, як у `rankNominees`; далі ті, хто не набрав (нуль, сторно, немає), — теж видно, не ховаємо.
 * Перше місце завжди збігається з переможцями `rankNominees` — це й стереже гейт.
 */
export interface RankRow { managerId: number; value: number | null }
export function teamRanking(cands: readonly Candidate[]): RankRow[] {
  const score = (v: number | null) => (v != null && Number.isFinite(v) && norm(v) > 0 ? norm(v) : null);
  return [...cands].map((c) => ({ managerId: c.managerId, value: c.value == null || !Number.isFinite(c.value) ? null : c.value }))
    .sort((a, b) => {
      const sa = score(a.value), sb = score(b.value);
      if (sa != null && sb != null) return sb - sa || a.managerId - b.managerId;
      if (sa != null) return -1;
      if (sb != null) return 1;
      return (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.managerId - b.managerId;
    });
}

/** Відбиток того, що бачив тімлід: якщо CRM після підтвердження змінився — підтвердження протухло. */
export const fingerprint = (r: Ranked): string => (r.state === "empty" ? "empty" : `${r.winners.join(",")}=${r.value}`);

// ───────────────────────── рішення тімліда ─────────────────────────

/** `retract` (22.09.2026) — «скасувати своє рішення»: рядок знову чекає. Історія лише дописується. */
export type ReviewAction = "confirm" | "override" | "retract";
export interface Review { action: ReviewAction; crmFingerprint: string; overrideManagerIds: number[] | null; overrideValue: number | null; reason: string | null }
export type Final =
  | { status: "confirmed" | "unconfirmed"; winners: number[]; value: number | null; reason: null; stale: boolean }
  | { status: "overridden"; winners: number[]; value: number; reason: string; stale: boolean }
  | { status: "empty"; winners: []; value: null; reason: null; stale: boolean };

/**
 * Фінальний результат = CRM + останнє рішення тімліда.
 * · виправлення діє завжди (воно свідоме й підписане причиною), але `stale` каже, що CRM відтоді змінився;
 * · підтвердження діє лише доки CRM показує ТЕ САМЕ, що бачив тімлід; змінилось — рядок знову «не підтверджено».
 */
export function applyReview(crm: Ranked, reviewIn: Review | null): Final {
  // «Скасувати» = рішення немає: рядок чекає, і пропозиція системи — з CRM зараз (#654).
  const review = reviewIn?.action === "retract" ? null : reviewIn;
  const fp = fingerprint(crm);
  const stale = review != null && review.crmFingerprint !== fp;
  if (review?.action === "override" && review.overrideManagerIds?.length && review.overrideValue != null && review.reason) {
    return { status: "overridden", winners: [...review.overrideManagerIds].sort((a, b) => a - b), value: review.overrideValue, reason: review.reason, stale };
  }
  if (crm.state === "empty") return { status: "empty", winners: [], value: null, reason: null, stale };
  const confirmed = review?.action === "confirm" && !stale;
  return { status: confirmed ? "confirmed" : "unconfirmed", winners: crm.winners, value: crm.value, reason: null, stale };
}

/**
 * Хто може підтвердити/виправити рядок (#605).
 * · керівництво (`role === "admin"` — сюди підіймаються ceo/opdir/kvp правом `admin_scope`) — будь-яку команду;
 * · тімлід — лише свою команду, і НЕ рядок, де переможець (за CRM або у виправленні) — він сам (рішення 21.09.2026);
 * · решта — ніхто.
 */
export function canReview(
  who: { role: string; teamId: number | null; managerId: number | null },
  row: { teamId: number; crmWinners: readonly number[]; overrideManagerIds?: readonly number[] | null },
): { ok: true } | { ok: false; why: string } {
  if (who.role === "admin") return { ok: true };
  if (who.role !== "team_lead") return { ok: false, why: "підтверджують лише тімлід команди і керівництво" };
  if (who.teamId == null || who.teamId !== row.teamId) return { ok: false, why: "тімлід підтверджує лише свою команду" };
  const self = who.managerId;
  if (self != null && (row.crmWinners.includes(self) || (row.overrideManagerIds ?? []).includes(self))) {
    return { ok: false, why: "рядок про себе підтверджує керівництво, а не тімлід" };
  }
  return { ok: true };
}

/** Перевірка тіла запиту рішення (#605b): виправлення без переможця, числа або причини — відмова. */
export function validateReview(body: unknown):
  { ok: true; value: { weekFrom: string; teamId: number; nomination: NominationKey; action: ReviewAction; overrideManagerIds: number[] | null; overrideValue: number | null; reason: string | null } }
  | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const weekFrom = typeof b.weekFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.weekFrom) ? b.weekFrom : null;
  if (!weekFrom || weekOf(weekFrom).from !== weekFrom) return { ok: false, error: "weekFrom — понеділок тижня у форматі YYYY-MM-DD" };
  const teamId = Number(b.teamId);
  if (!Number.isInteger(teamId) || teamId <= 0) return { ok: false, error: "teamId обовʼязковий" };
  if (!isNominationKey(b.nomination)) return { ok: false, error: "невідома номінація" };
  if (b.action === "confirm" || b.action === "retract") return { ok: true, value: { weekFrom, teamId, nomination: b.nomination, action: b.action, overrideManagerIds: null, overrideValue: null, reason: null } };
  if (b.action !== "override") return { ok: false, error: "action — confirm, override або retract" };
  const ids = Array.isArray(b.overrideManagerIds) ? b.overrideManagerIds.map(Number).filter((x) => Number.isInteger(x) && x > 0) : [];
  if (ids.length === 0) return { ok: false, error: "вкажіть переможця" };
  const value = Number(b.overrideValue);
  if (b.overrideValue == null || b.overrideValue === "" || !Number.isFinite(value) || value <= 0) return { ok: false, error: "вкажіть число більше за нуль" };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 3) return { ok: false, error: "виправлення без причини не зберігається" };
  return { ok: true, value: { weekFrom, teamId, nomination: b.nomination, action: "override", overrideManagerIds: [...new Set(ids)], overrideValue: value, reason } };
}

/**
 * «Погодитись з рештою» (#654): одним запитом — підтвердження кількох номінацій ОДНІЄЇ команди.
 * Що саме погоджувати, вирішує сервер (лише ті, де є CRM-переможець, рішення ще немає і дозволено
 * `canReview`); тут — лише форма тіла.
 */
export function validateBulkConfirm(body: unknown): { ok: true; value: { weekFrom: string; teamId: number; nominations: NominationKey[] } } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const weekFrom = typeof b.weekFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.weekFrom) ? b.weekFrom : null;
  if (!weekFrom || weekOf(weekFrom).from !== weekFrom) return { ok: false, error: "weekFrom — понеділок тижня у форматі YYYY-MM-DD" };
  const teamId = Number(b.teamId);
  if (!Number.isInteger(teamId) || teamId <= 0) return { ok: false, error: "teamId обовʼязковий" };
  const list = Array.isArray(b.nominations) ? b.nominations : [];
  if (list.length === 0 || !list.every(isNominationKey)) return { ok: false, error: "nominations — непорожній перелік відомих номінацій" };
  return { ok: true, value: { weekFrom, teamId, nominations: [...new Set(list as NominationKey[])] } };
}

// ───────────────────────── переможець відділу ─────────────────────────

export interface TeamWinner { teamId: number; dept: "rpk" | "rnk" | "lg"; winners: readonly number[]; value: number | null }
/**
 * Переможець відділу (ВРПК / ВРНК) = найкращий серед ФІНАЛЬНИХ переможців команд (з урахуванням
 * виправлень). Нічия між командами — усі. Порожньо в усіх командах — `empty`.
 */
export function deptWinners(rows: readonly TeamWinner[], dept: "rpk" | "rnk"): Ranked & { teams?: number[] } {
  const cands: Candidate[] = [];
  const teamOf = new Map<number, number>();
  for (const r of rows) if (r.dept === dept && r.value != null) for (const w of r.winners) { cands.push({ managerId: w, value: r.value }); teamOf.set(w, r.teamId); }
  const ranked = rankNominees(cands);
  if (ranked.state === "empty") return ranked;
  return { ...ranked, teams: [...new Set(ranked.winners.map((w) => teamOf.get(w)!))] };
}

// ───────────────────────── вигляд тижня і рядки знімка ─────────────────────────

export interface NominationCell {
  nomination: NominationKey;
  crm: Ranked;
  final: Final;
  /** Угода-доказ для «разового зазору» і «% маржі» (переможця за CRM; при нічиї — першого). */
  deal: { id: number; price?: number; cost?: number; url?: string } | null;
  /** Рейтинг команди (#652). `null` — тиждень зафіксовано до 22.09.2026, рейтинг тоді не зберігався. */
  ranking: RankRow[] | null;
  /** Хто і коли ухвалив останнє рішення по рядку (лише чернетка; знімок цього не зберігає). */
  review: { action: ReviewAction; by: string | null; at: string } | null;
}
export interface TeamWeek {
  teamId: number; teamName: string; dept: "rpk" | "rnk" | "lg"; members: { id: number; name: string }[]; noCostDeals: number; cells: NominationCell[];
  /** Тімліди команди зараз (для «про тімліда — за вами» в Даші). У знімку — порожньо: ростер людей поточний, не історичний. */
  leads: { managerId: number | null; name: string }[];
}
export interface DeptWinner { dept: "rpk" | "rnk"; nomination: NominationKey; state: "ok" | "empty"; value: number | null; winners: number[]; teams: number[] }
export interface WeekView {
  weekFrom: string; weekTo: string;
  state: "draft" | "frozen";
  frozenAt: string | null; ruleVersion: string;
  freezeDueAt: string; // київська дата + година фіксації, для підпису «фіксація вт … о 08:00»
  freezeInstant: string; // та сама мить як UTC — для зворотного відліку
  teams: TeamWeek[];
  depts: DeptWinner[];
  names: Record<number, string>;
  /**
   * Рейтинг лідогенераторів — окремо від `teams` (не в переможцях відділів і не в звірці зі Звітом). У знімок не йде:
   * живе й правиться після фіксації (рішення ревʼю 22.09.2026).
   */
  leadgen: TeamWeek | null;
  /** Статистика відділу РНК · конверсія (живе CRM + правки Даші й тімлідів; у знімок не йде). */
  rnkConv: RnkConv | null;
}

/* ───────────────────────── статистика відділу РНК · конверсія (22.09.2026) ───────────────────────── */

/**
 * Рядок таблиці «Найкраща конверсія» (слайд 5 Даші). Система пропонує «Конв. реклама» Звіту
 * (`metrics.conversionByManager(…, "ad")`: створені рекламні угоди тижня → скільки дійшли до грошової зони),
 * а Даша або тімлід команди можуть поставити свої «цільові ліди / успіх» і вибрати, хто йде на слайд.
 */
export interface ConvRow {
  managerId: number; name: string; teamId: number;
  taken: number; won: number; pct: number | null;
  crm: { taken: number; won: number };
  own: { by: string | null; at: string } | null;
  onSlide: boolean;
}
export interface RnkConv { rows: ConvRow[]; comment: { text: string; by: string | null; at: string } | null }
/**
 * Правка таблиці: `set` — свої числа (ліди, успіх); `reset` — повернути числа CRM; `slide` — лише чи йде рядок
 * на слайд; `comment` — коментар. Числа й вибір слайда живуть НЕЗАЛЕЖНО (ревʼю 22.09): поставити галочку не
 * заморожує числа, а виправити число не перебудовує вибір інших рядків.
 */
export interface ConvEdit {
  managerId: number | null; action: "set" | "reset" | "slide" | "comment";
  taken: number | null; won: number | null; onSlide: boolean | null; comment: string | null; by: string | null; at: string;
}
/** Скільки рядків іде на слайд, поки ніхто не вибрав руками (у Даші — 2–4). Лише типовий вибір, Даша його змінює. */
export const CONV_DEFAULT_ON_SLIDE = 4;
const pct2 = (won: number, taken: number): number | null => (taken > 0 ? Math.round((won / taken) * 10000) / 100 : null);

/**
 * Таблиця конверсії (#661): система + правки. Остання правка по людині перемагає; «reset» повертає число
 * системи; коментар — остання правка без людини. Хто на слайді: явний вибір, інакше — 4 найкращі за %,
 * при рівності — з більшою кількістю лідів. Відсоток — до сотих (4/24 = 16,67%, а не «17,00%»).
 */
export function buildRnkConv(system: readonly { managerId: number; name: string; teamId: number; taken: number; won: number }[], edits: readonly ConvEdit[]): RnkConv {
  const nums = new Map<number, ConvEdit>(); // остання правка ЧИСЕЛ (set / reset)
  const slide = new Map<number, boolean>();  // останній ЯВНИЙ вибір «на слайд»
  let comment: RnkConv["comment"] = null;
  for (const e of edits) {
    if (e.action === "comment") comment = e.comment ? { text: e.comment, by: e.by, at: e.at } : null;
    else if (e.managerId == null) continue;
    else if (e.action === "slide") { if (e.onSlide != null) slide.set(e.managerId, e.onSlide); }
    else nums.set(e.managerId, e);
  }
  const rows = system.map((s): ConvRow => {
    const e = nums.get(s.managerId);
    const own = e?.action === "set" && e.taken != null && e.won != null;
    const taken = own ? e!.taken! : s.taken;
    const won = own ? e!.won! : s.won;
    return { managerId: s.managerId, name: s.name, teamId: s.teamId, taken, won, pct: pct2(won, taken), crm: { taken: s.taken, won: s.won },
      own: own ? { by: e!.by, at: e!.at } : null, onSlide: false };
  });
  // Типовий вибір — 4 найкращі за %; явний вибір рядка перемагає лише ДЛЯ ЦЬОГО рядка.
  const byPct = [...rows].filter((r) => r.pct != null).sort((a, b) => b.pct! - a.pct! || b.taken - a.taken || a.managerId - b.managerId);
  const top = new Set(byPct.slice(0, CONV_DEFAULT_ON_SLIDE).map((r) => r.managerId));
  const out = rows.map((r) => ({ ...r, onSlide: slide.has(r.managerId) ? slide.get(r.managerId)! : top.has(r.managerId) }));
  out.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.taken - a.taken || a.managerId - b.managerId);
  return { rows: out, comment };
}

/** Тіло правки таблиці конверсії (#661). Успіх не більший за ліди; усе — цілі невідʼємні. */
export function validateConvEdit(body: unknown):
  { ok: true; value: { weekFrom: string; action: ConvEdit["action"]; managerId: number | null; taken: number | null; won: number | null; onSlide: boolean | null; comment: string | null } }
  | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const weekFrom = typeof b.weekFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.weekFrom) ? b.weekFrom : null;
  if (!weekFrom || weekOf(weekFrom).from !== weekFrom) return { ok: false, error: "weekFrom — понеділок тижня у форматі YYYY-MM-DD" };
  if (b.action === "comment") {
    const c = typeof b.comment === "string" ? b.comment.trim().slice(0, 600) : "";
    return { ok: true, value: { weekFrom, action: "comment", managerId: null, taken: null, won: null, onSlide: null, comment: c } };
  }
  const managerId = Number(b.managerId);
  if (!Number.isInteger(managerId) || managerId <= 0) return { ok: false, error: "managerId обовʼязковий" };
  if (b.action === "reset") return { ok: true, value: { weekFrom, action: "reset", managerId, taken: null, won: null, onSlide: null, comment: null } };
  if (b.action === "slide") {
    if (typeof b.onSlide !== "boolean") return { ok: false, error: "onSlide — так або ні" };
    return { ok: true, value: { weekFrom, action: "slide", managerId, taken: null, won: null, onSlide: b.onSlide, comment: null } };
  }
  if (b.action !== "set") return { ok: false, error: "action — set, reset, slide або comment" };
  const taken = Number(b.taken), won = Number(b.won);
  if (!Number.isInteger(taken) || taken < 0 || !Number.isInteger(won) || won < 0) return { ok: false, error: "ліди й успіх — цілі числа від нуля" };
  if (won > taken) return { ok: false, error: "успіхів не може бути більше, ніж лідів" };
  return { ok: true, value: { weekFrom, action: "set", managerId, taken, won, onSlide: null, comment: null } };
}


/**
 * Рейтинг із рядка знімка (#653). Тижні, зафіксовані до 22.09.2026, рейтингу не мають — тоді `null`,
 * і екран чесно пише «не зберігався», а НЕ підставляє поточний CRM у зафіксований тиждень.
 */
export function rankingFromExtra(extra: unknown): RankRow[] | null {
  const r = (extra as { ranking?: unknown } | null)?.ranking;
  if (!Array.isArray(r)) return null;
  return r.filter((x): x is RankRow => !!x && Number.isInteger((x as RankRow).managerId)
    && ((x as RankRow).value === null || typeof (x as RankRow).value === "number"));
}

/** Рядки знімка з чернетки — чиста частина фіксації, винесена для гейта `#606`. */
export interface SnapshotRow { teamId: number; teamName: string; dept: "rpk" | "rnk" | "lg"; nomination: NominationKey; status: Final["status"]; managerId: number | null; managerName: string | null; value: number | null; crmManagerIds: number[]; crmValue: number | null; reason: string | null; extra: Record<string, unknown> }
export function snapshotRows(view: WeekView): SnapshotRow[] {
  const out: SnapshotRow[] = [];
  // Лідогенератори в знімок НЕ йдуть (ревʼю 22.09): живуть, як таблиця конверсії, — прорахунки з CRM + дані
  // тімліда/Даші, які можна внести й після вівторка. Так старі тижні не лишаються «без лідогену», а відкат коду
  // не ламає читання знімка рядками, яких старий код не знає.
  for (const t of view.teams) for (const c of t.cells) {
    const crmIds = c.crm.state === "ok" ? c.crm.winners : [];
    const crmValue = c.crm.state === "ok" ? c.crm.value : null;
    const extra = { stale: c.final.stale, deal: c.deal, noCostDeals: t.noCostDeals, members: t.members, ranking: c.ranking };
    const base = { teamId: t.teamId, teamName: t.teamName, dept: t.dept, nomination: c.nomination, status: c.final.status, crmManagerIds: crmIds, crmValue, reason: c.final.reason, extra };
    if (c.final.winners.length === 0) out.push({ ...base, managerId: null, managerName: null, value: c.final.value });
    else for (const w of c.final.winners) out.push({ ...base, managerId: w, managerName: view.names[w] ?? `Менеджер #${w}`, value: c.final.value });
  }
  return out;
}


// ───────────────────────── ручні слайди презентації: ШАБЛОНИ (21.09.2026) ─────────────────────────
//
// Шаблони — зі слайдів самої Даші (`UTS_weekly_meeting_template.pptx`): поля й тексти за
// замовчуванням перенесено звідти дослівно, щоб слайд виходив таким, яким його вже знають на
// зустрічі. Реєстр ОДИН: сервер перевіряє за ним тіло, фронт будує з нього форму, а презентація
// мусить мати верстку для КОЖНОГО шаблону (#614) — «додав шаблон і забув верстку» не пройде тихо.

export type ManualKind = "newcomer" | "birthday" | "news" | "contest" | "webinar" | "custom";
export interface TemplateField {
  key: string; label: string; required: boolean; max: number; multiline?: boolean; placeholder?: string; default?: string;
  /** `employee` — вибір людини з реєстру «Співробітників» (id); на слайді дає її фото. */
  type?: "employee";
}
/** Поле «фото з реєстру» — id співробітника; на слайді замість порожнього кола стає його фото (22.09.2026). */
const PHOTO_FIELD: TemplateField = { key: "employeeId", label: "Фото — людина з реєстру «Співробітники» (необовʼязково)", required: false, max: 12, type: "employee" };
export interface SlideTemplate { key: ManualKind; label: string; fields: readonly TemplateField[] }

const CONTEST_RULES = [
  "Тривалість конкурсу — один тиждень.",
  "Вхідний квиток — мінімум 20 лідів за тиждень.",
  "У залік ідуть тільки угоди, створені по рекламі.",
  "Перемагає найбільша сума відправлених авто, а не їх кількість.",
  "Підсумки підбивають [дата] — строго те, що є в CRM.",
].join("\n");
const WEBINAR_POINTS = [
  "Прорахунок — як швидко та точно рахувати рейс, щоб не втрачати маржу",
  "Торг — техніки домовленості про кращу ставку з клієнтом",
  "Угода — як закривати рейс на максимальній сумі",
].join("\n");

export const SLIDE_TEMPLATES: readonly SlideTemplate[] = [
  { key: "newcomer", label: "Новий працівник", fields: [
    { key: "headline", label: "Кого вітаємо (посада, команда)", required: true, max: 140, placeholder: "Вітаємо нового менеджера РНК в команді Андрія Безпамʼятного (період адаптації)" },
    { key: "person", label: "Прізвище Імʼя", required: true, max: 80 },
    { key: "achievement", label: "Досягнення (необовʼязково)", required: false, max: 120, placeholder: "Вітаємо з 8ми поставленими машинами!" },
    { key: "wish", label: "Побажання", required: false, max: 160, default: "Легкого старту та сильних результатів!" },
    { key: "date", label: "Дата", required: false, max: 20, placeholder: "22.09.2026" },
    PHOTO_FIELD,
  ] },
  { key: "birthday", label: "День народження", fields: [
    { key: "person", label: "Кого вітаємо (у формі «Сердюка Ярослава»)", required: true, max: 80 },
    { key: "date", label: "Дата народження", required: true, max: 20, placeholder: "27.08" },
    { key: "wish", label: "Побажання", required: false, max: 300, multiline: true,
      default: "Бажаємо міцного здоровʼя, натхнення, професійних перемог і якнайбільше приємних моментів разом із командою UTS!" },
    PHOTO_FIELD,
  ] },
  { key: "news", label: "Новини", fields: [
    { key: "title", label: "Заголовок", required: false, max: 60, default: "Новини!" },
    { key: "text", label: "Новина", required: true, max: 400, multiline: true, placeholder: "Ковтонюк Тетяна переходить до команди РНК Андрія Безпамʼятного." },
    { key: "wish", label: "Побажання", required: false, max: 160, default: "Бажаємо успіхів у нових ролях та команді! 🚀" },
  ] },
  { key: "contest", label: "Конкурс тижня", fields: [
    { key: "title", label: "Заголовок", required: false, max: 60, default: "Три місця на пʼєдесталі" },
    { key: "description", label: "Умова", required: true, max: 240, multiline: true,
      default: "Перемагає той, хто відправить авто по угодах із реклами на найбільшу суму за тиждень. Прозорий залік, реальні призові." },
    { key: "prize1", label: "1 місце", required: true, max: 30, default: "1 200 грн" },
    { key: "prize2", label: "2 місце", required: true, max: 30, default: "800 грн" },
    { key: "prize3", label: "3 місце", required: true, max: 30, default: "400 грн" },
    { key: "rules", label: "Правила (кожне з нового рядка)", required: false, max: 600, multiline: true, default: CONTEST_RULES },
    { key: "total", label: "На кону цього тижня", required: false, max: 30, default: "2 400 грн" },
  ] },
  { key: "webinar", label: "Анонс / вебінар", fields: [
    { key: "title", label: "Заголовок", required: false, max: 60, default: "Навчальний вебінар" },
    { key: "description", label: "Опис", required: false, max: 200, multiline: true,
      default: "Плануємо навчальний вебінар для команди — деталі нижче. Приєднуйтесь, буде корисно." },
    { key: "when", label: "Коли", required: true, max: 40, placeholder: "ПʼЯТНИЦЯ · 16:00" },
    { key: "topic", label: "Тема", required: true, max: 120, placeholder: "Прорахунок → Торг → Угода: як заробляти на кожному перевезенні" },
    { key: "speaker", label: "Спікер", required: false, max: 60, default: "Операційний директор" },
    { key: "format", label: "Формат", required: false, max: 40, default: "Онлайн" },
    { key: "audience", label: "Для кого", required: false, max: 60, default: "Уся команда" },
    { key: "points", label: "Що розглянемо (кожен пункт з нового рядка)", required: false, max: 600, multiline: true, default: WEBINAR_POINTS },
  ] },
  { key: "custom", label: "Довільний слайд", fields: [
    { key: "title", label: "Заголовок", required: true, max: 80 },
    { key: "person", label: "Людина (необовʼязково)", required: false, max: 80 },
    { key: "body", label: "Текст", required: false, max: 600, multiline: true },
  ] },
];
/** Сумісність зі старими викликами: перелік шаблонів як «типів». */
export const MANUAL_KINDS: readonly { key: ManualKind; label: string }[] = SLIDE_TEMPLATES.map((t) => ({ key: t.key, label: t.label }));

export interface ManualSlideInput {
  weekFrom: string; kind: ManualKind; fields: Record<string, string>; position: number;
  /** Похідні для переліку в редакторі й для старих колонок: назва рядка й людина. */
  title: string; person: string | null;
}

/** Підпис рядка в переліку ручних слайдів — щоб у редакторі було видно, що це за слайд. */
export function slideListTitle(kind: ManualKind, f: Record<string, string>): string {
  const lbl = SLIDE_TEMPLATES.find((t) => t.key === kind)?.label ?? kind;
  const who = f.person || f.topic || (f.text ? f.text.slice(0, 50) : "") || f.title || "";
  return (kind === "custom" ? f.title : who ? `${lbl} · ${who}` : lbl).slice(0, 80);
}

/**
 * Тіло ручного слайда за шаблоном (#607, #613). Обовʼязкові поля шаблону — непорожні; зайві ключі
 * відкидаються; кожне поле обрізається до своєї довжини, щоб текст влазив у слайд 16:9.
 * Старий формат (`title`/`person`/`body` без `fields`) приймається як «довільний» слайд.
 */
export function validateManualSlide(body: unknown): { ok: true; value: ManualSlideInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const weekFrom = typeof b.weekFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.weekFrom) ? b.weekFrom : null;
  if (!weekFrom || weekOf(weekFrom).from !== weekFrom) return { ok: false, error: "weekFrom — понеділок тижня у форматі YYYY-MM-DD" };
  const tpl = SLIDE_TEMPLATES.find((t) => t.key === b.kind);
  if (!tpl) return { ok: false, error: "невідомий шаблон слайда" };
  const raw = (b.fields && typeof b.fields === "object" ? b.fields : { title: b.title, person: b.person, body: b.body }) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const f of tpl.fields) {
    const v = typeof raw[f.key] === "string" ? (raw[f.key] as string).trim().slice(0, f.max) : "";
    if (f.required && !v) return { ok: false, error: `заповніть поле «${f.label}»` };
    if (f.type === "employee" && v && !/^[1-9]\d{0,8}$/.test(v)) return { ok: false, error: `поле «${f.label}»: оберіть людину зі списку` };
    if (v) fields[f.key] = v;
  }
  const position = Number.isInteger(Number(b.position)) ? Number(b.position) : 0;
  const title = slideListTitle(tpl.key, fields) || tpl.label;
  return { ok: true, value: { weekFrom, kind: tpl.key, fields, position, title, person: fields.person ?? null } };
}
