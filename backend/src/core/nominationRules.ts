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

export type NominationKey = "maxDeal" | "cars" | "revenue" | "marginPct" | "intl";
export type Unit = "uah" | "count" | "pct";
export interface NominationDef { key: NominationKey; label: string; hint: string; unit: Unit }

/** Порядок = порядок на екрані й на слайді. Підпис каже, ЯКУ колонку Звіту взято. */
export const NOMINATIONS: readonly NominationDef[] = [
  { key: "maxDeal", label: "Найбільший разовий зазор", hint: "найбільша маржа однієї угоди у «Факті» Звіту", unit: "uah" },
  { key: "cars", label: "Найбільша к-сть поставлених авто", hint: "колонка «Авто» Звіту (дата завантаження)", unit: "count" },
  { key: "revenue", label: "Найбільший результат за тиждень", hint: "«Факт» Звіту: оплата отримана + успішно реалізовано", unit: "uah" },
  { key: "marginPct", label: "Найбільший % маржі", hint: "маржа угоди ÷ «Расход 1» (виплата водію)", unit: "pct" },
  { key: "intl", label: "Найбільша к-сть міжнародних", hint: "«Авто» з «Тип запиту = Міжнародні»", unit: "count" },
];
export const NOMINATION_KEYS: readonly NominationKey[] = NOMINATIONS.map((n) => n.key);
export const isNominationKey = (k: unknown): k is NominationKey => typeof k === "string" && (NOMINATION_KEYS as readonly string[]).includes(k);

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

/** Відбиток того, що бачив тімлід: якщо CRM після підтвердження змінився — підтвердження протухло. */
export const fingerprint = (r: Ranked): string => (r.state === "empty" ? "empty" : `${r.winners.join(",")}=${r.value}`);

// ───────────────────────── рішення тімліда ─────────────────────────

export interface Review { action: "confirm" | "override"; crmFingerprint: string; overrideManagerIds: number[] | null; overrideValue: number | null; reason: string | null }
export type Final =
  | { status: "confirmed" | "unconfirmed"; winners: number[]; value: number | null; reason: null; stale: boolean }
  | { status: "overridden"; winners: number[]; value: number; reason: string; stale: boolean }
  | { status: "empty"; winners: []; value: null; reason: null; stale: boolean };

/**
 * Фінальний результат = CRM + останнє рішення тімліда.
 * · виправлення діє завжди (воно свідоме й підписане причиною), але `stale` каже, що CRM відтоді змінився;
 * · підтвердження діє лише доки CRM показує ТЕ САМЕ, що бачив тімлід; змінилось — рядок знову «не підтверджено».
 */
export function applyReview(crm: Ranked, review: Review | null): Final {
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
  { ok: true; value: { weekFrom: string; teamId: number; nomination: NominationKey; action: "confirm" | "override"; overrideManagerIds: number[] | null; overrideValue: number | null; reason: string | null } }
  | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const weekFrom = typeof b.weekFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.weekFrom) ? b.weekFrom : null;
  if (!weekFrom || weekOf(weekFrom).from !== weekFrom) return { ok: false, error: "weekFrom — понеділок тижня у форматі YYYY-MM-DD" };
  const teamId = Number(b.teamId);
  if (!Number.isInteger(teamId) || teamId <= 0) return { ok: false, error: "teamId обовʼязковий" };
  if (!isNominationKey(b.nomination)) return { ok: false, error: "невідома номінація" };
  if (b.action === "confirm") return { ok: true, value: { weekFrom, teamId, nomination: b.nomination, action: "confirm", overrideManagerIds: null, overrideValue: null, reason: null } };
  if (b.action !== "override") return { ok: false, error: "action — confirm або override" };
  const ids = Array.isArray(b.overrideManagerIds) ? b.overrideManagerIds.map(Number).filter((x) => Number.isInteger(x) && x > 0) : [];
  if (ids.length === 0) return { ok: false, error: "вкажіть переможця" };
  const value = Number(b.overrideValue);
  if (b.overrideValue == null || b.overrideValue === "" || !Number.isFinite(value) || value <= 0) return { ok: false, error: "вкажіть число більше за нуль" };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 3) return { ok: false, error: "виправлення без причини не зберігається" };
  return { ok: true, value: { weekFrom, teamId, nomination: b.nomination, action: "override", overrideManagerIds: [...new Set(ids)], overrideValue: value, reason } };
}

// ───────────────────────── переможець відділу ─────────────────────────

export interface TeamWinner { teamId: number; dept: "rpk" | "rnk"; winners: readonly number[]; value: number | null }
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
  deal: { id: number; price?: number; cost?: number } | null;
}
export interface TeamWeek { teamId: number; teamName: string; dept: "rpk" | "rnk"; members: { id: number; name: string }[]; noCostDeals: number; cells: NominationCell[] }
export interface DeptWinner { dept: "rpk" | "rnk"; nomination: NominationKey; state: "ok" | "empty"; value: number | null; winners: number[]; teams: number[] }
export interface WeekView {
  weekFrom: string; weekTo: string;
  state: "draft" | "frozen";
  frozenAt: string | null; ruleVersion: string;
  freezeDueAt: string; // київська дата + година фіксації, для підпису «фіксація вт … о 08:00»
  teams: TeamWeek[];
  depts: DeptWinner[];
  names: Record<number, string>;
}


/** Рядки знімка з чернетки — чиста частина фіксації, винесена для гейта `#606`. */
export interface SnapshotRow { teamId: number; teamName: string; dept: "rpk" | "rnk"; nomination: NominationKey; status: Final["status"]; managerId: number | null; managerName: string | null; value: number | null; crmManagerIds: number[]; crmValue: number | null; reason: string | null; extra: Record<string, unknown> }
export function snapshotRows(view: WeekView): SnapshotRow[] {
  const out: SnapshotRow[] = [];
  for (const t of view.teams) for (const c of t.cells) {
    const crmIds = c.crm.state === "ok" ? c.crm.winners : [];
    const crmValue = c.crm.state === "ok" ? c.crm.value : null;
    const extra = { stale: c.final.stale, deal: c.deal, noCostDeals: t.noCostDeals, members: t.members };
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
// мусить мати верстку для КОЖНОГО шаблону (#611) — «додав шаблон і забув верстку» не пройде тихо.

export type ManualKind = "newcomer" | "birthday" | "news" | "contest" | "webinar" | "custom";
export interface TemplateField { key: string; label: string; required: boolean; max: number; multiline?: boolean; placeholder?: string; default?: string }
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
  ] },
  { key: "birthday", label: "День народження", fields: [
    { key: "person", label: "Кого вітаємо (у формі «Сердюка Ярослава»)", required: true, max: 80 },
    { key: "date", label: "Дата народження", required: true, max: 20, placeholder: "27.08" },
    { key: "wish", label: "Побажання", required: false, max: 300, multiline: true,
      default: "Бажаємо міцного здоровʼя, натхнення, професійних перемог і якнайбільше приємних моментів разом із командою UTS!" },
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
 * Тіло ручного слайда за шаблоном (#607, #610). Обовʼязкові поля шаблону — непорожні; зайві ключі
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
    if (v) fields[f.key] = v;
  }
  const position = Number.isInteger(Number(b.position)) ? Number(b.position) : 0;
  const title = slideListTitle(tpl.key, fields) || tpl.label;
  return { ok: true, value: { weekFrom, kind: tpl.key, fields, position, title, person: fields.person ?? null } };
}
