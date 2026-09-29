import { OUTBOUND_TYPES_FOR_PROMISE, promiseOutcome, type OutboundCall } from "./adCallFactsRules.js";

/**
 * 🤝 «ОБІЦЯВ І НЕ ПЕРЕДЗВОНИВ» — ТЕРМІН І РЕЗУЛЬТАТ ОБІЦЯНКИ МЕНЕДЖЕРА (рішення Романа 29.09.2026,
 * `docs/AI_CALLS_QUESTIONS_2026-09-21.md`, П4–П7 і уточнення).
 *
 * Модель лише ЧИТАЄ слова: канал обіцянки, вид строку («хвилини» / «день» / «не названо»), число
 * хвилин або дату, умовність. ТОЧНИЙ час терміну рахує цей модуль, а виконання — дзвінки Ringostat.
 * Від тексту аналізу до «передзвонив» не доходить нічого, крім «де і до коли».
 *
 *   П4-Б — обіцянка = будь-яке «повернусь до вас», зокрема умовне; рахуємо лише обіцянки МЕНЕДЖЕРА;
 *   П5   — строк як пообіцяв; «завтра» → кінець завтрашнього дня; часу не названо → 20 хв;
 *          УМОВНА без часу («як знайду авто — наберу») → кінець наступного робочого дня;
 *   П6-Б — «передзвонив (розмова)» / «лише спроби» / «нічого»; дзвінок колеги зараховується;
 *          дзвінок клієнта — окремим станом «клієнт подзвонив сам»;
 *   П7   — прапорець на тому, хто обіцяв (менеджер розмови), а не на відповідальному угоди;
 *   месенджер — «не перевіряється»: Ringostat Viber/Telegram не бачить, а П6-Б рахує лише дзвінки.
 *
 * ⏰ «ЗАПІЗНИВСЯ» (Роман 29.09.2026, «з твоїми пропозиціями»): перший замір на проді дав 54 «не передзвонив»,
 * і 21 з них — передзвін до 30 хв ПІСЛЯ терміну («дві-три хвилиночки» → через 8 хв). Тепер наш вихідний у
 * межах 2 год після терміну — «запізнився» (жовтий), а «не передзвонив» — лише коли до терміну + 2 год
 * нашого дзвінка не було зовсім.
 * 🔄 СИНК RINGOSTAT ІДЕ РАЗ НА ~30 ХВ: дзвінок 10 хв тому ще може не лежати в базі. Тож «не передзвонив» —
 * лише коли дзвінки вже синхронізовано за межу `термін + 2 год` (`knownUntil`), інакше — «чекає».
 */

export type PromiseChannel = "call" | "message" | "other";
export type DeadlineKind = "minutes" | "day" | "none";

export interface ModelPromise {
  who: "manager" | "client";
  what: string;
  deadline_text: string;
  channel: PromiseChannel;
  deadline_kind: DeadlineKind;
  deadline_minutes: number;
  deadline_date: string;
  conditional: boolean;
}

/** Часу не названо — 20 хвилин (Роман 29.09.2026: «зазвичай це 20 хвилин після дзвінку»). */
export const DEFAULT_PROMISE_MINUTES = 20;
/** Стеля для «через N хвилин»: більше тижня в хвилинах — не хвилини, а помилка читання. */
const MAX_MINUTES = 7 * 24 * 60;
/** Дата «до дня Д» не далі за 60 днів від розмови — інакше помилка читання, а не обіцянка. */
const MAX_DAYS_AHEAD = 60;

const kyivDate = (d: Date): string => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

/** Мить, коли в Києві `date` `hh:mm:ss`. Зсув беремо з самої дати — літній і зимовий час сходяться. */
export function kyivLocalToUtc(date: string, time: string): Date {
  const guess = new Date(`${date}T${time}Z`);
  const shown = new Date(guess.toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" }).replace(" ", "T") + "Z");
  return new Date(guess.getTime() - (shown.getTime() - guess.getTime()));
}

/** Остання секунда київського дня. */
export const endOfKyivDay = (date: string): Date => kyivLocalToUtc(date, "23:59:59");

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Наступний робочий день (пн–пт) після київської дати моменту. Свят календар не знає — як і решта дашборду. */
export function nextWorkingDay(at: Date): string {
  let d = addDays(kyivDate(at), 1);
  for (;;) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return d;
    d = addDays(d, 1);
  }
}

export type DeadlineBasis = "minutes" | "day" | "default_minutes" | "conditional_next_workday";

/**
 * Термін обіцянки від кінця розмови. Прочитане моделлю, але неправдоподібне (хвилин 0 чи понад тиждень,
 * дата в минулому чи далі за 60 днів) не береться на віру — падає в правило «часу не названо».
 */
export function promiseDeadline(p: Pick<ModelPromise, "deadline_kind" | "deadline_minutes" | "deadline_date" | "conditional">, callEnd: Date):
  { deadline: Date; basis: DeadlineBasis } {
  if (p.deadline_kind === "minutes" && Number.isFinite(p.deadline_minutes) && p.deadline_minutes > 0 && p.deadline_minutes <= MAX_MINUTES)
    return { deadline: new Date(callEnd.getTime() + Math.round(p.deadline_minutes) * 60_000), basis: "minutes" };
  if (p.deadline_kind === "day" && /^\d{4}-\d{2}-\d{2}$/.test(p.deadline_date)) {
    const today = kyivDate(callEnd);
    if (p.deadline_date >= today && p.deadline_date <= addDays(today, MAX_DAYS_AHEAD))
      return { deadline: endOfKyivDay(p.deadline_date), basis: "day" };
  }
  if (p.conditional) return { deadline: endOfKyivDay(nextWorkingDay(callEnd)), basis: "conditional_next_workday" };
  return { deadline: new Date(callEnd.getTime() + DEFAULT_PROMISE_MINUTES * 60_000), basis: "default_minutes" };
}

/**
 * Стан однієї обіцянки. Порядок важить: месенджер не перевіряється взагалі; наш вихідний до терміну —
 * виконано (колега теж рахується); клієнт подзвонив сам — окремий стан, а не «передзвонив»; далі —
 * чекає строку або не передзвонив.
 */
export type PromiseState = "kept_talk" | "kept_attempt_only" | "client_called" | "late" | "pending" | "broken" | "unverifiable";

/** Скільки після терміну наш дзвінок ще «запізнився», а не «не передзвонив» (Роман 29.09.2026). */
export const LATE_GRACE_MIN = 120;

export interface CallFact { at: Date; billsec: number; callType: string }

const IN_TYPES = new Set(["in", "transitin"]);

/**
 * `knownUntil` — до якої миті дзвінки Ringostat уже є в базі: пізніше з «зараз» і останнього успішного синку.
 * Поки він не перейшов межу `термін + 2 год`, відсутність дзвінка ще нічого не доводить.
 */
export function promiseState(p: Pick<ModelPromise, "channel">, madeAt: Date, deadline: Date, calls: readonly CallFact[], knownUntil: Date): PromiseState {
  if (p.channel !== "call") return "unverifiable";
  const outbound: OutboundCall[] = calls.filter((c) => (OUTBOUND_TYPES_FOR_PROMISE as readonly string[]).includes(c.callType));
  const ours = promiseOutcome({ madeAt, deadline }, outbound, knownUntil);
  if (ours === "kept_talk" || ours === "kept_attempt_only") return ours;
  const clientTalk = calls.some((c) => IN_TYPES.has(c.callType) && c.billsec > 0
    && c.at.getTime() > madeAt.getTime() && c.at.getTime() <= deadline.getTime());
  if (clientTalk) return "client_called";
  const graceEnd = deadline.getTime() + LATE_GRACE_MIN * 60_000;
  if (outbound.some((c) => c.at.getTime() > deadline.getTime() && c.at.getTime() <= graceEnd)) return "late";
  return knownUntil.getTime() < graceEnd ? "pending" : "broken";
}

/** Стан рядка — найгірший серед обіцянок менеджера. `null` — обіцянок менеджера немає. */
const RANK: PromiseState[] = ["broken", "late", "pending", "kept_attempt_only", "client_called", "kept_talk", "unverifiable"];
export function worstPromiseState(states: readonly PromiseState[]): PromiseState | null {
  for (const s of RANK) if (states.includes(s)) return s;
  return null;
}
