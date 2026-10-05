import type { Db } from "./adCallFacts.js";

/**
 * 🛡 ЗАХИСТ «БЕЗ РОЗМОВИ» ВІД ПАДІННЯ RINGOSTAT (рішення 05.10.2026, після звірки статусу «Відсіву»).
 *
 * «Без розмови» — це висновок із ВІДСУТНОСТІ: у нашій базі немає розмови ≥10 с по номеру угоди. Відсутність
 * доводить щось лише тоді, коли дзвінкам БУЛО звідки прийти. Ліг Ringostat — розмов у базі немає так само, як
 * коли їх не було, і за 4 год справжній клієнт закрився б «Немає зв'язку» (правило 16 кореня: порожньо ≠ нічого).
 *
 * Дві НЕЗАЛЕЖНІ перевірки, бо кожна сліпа там, де бачить друга:
 *  ① СВІЖІСТЬ СИНКУ — `job_runs.syncCallsFresh` старший за поріг (30 хв) → крок «без розмови» не виконується
 *     ВЗАГАЛІ: угоди лишаються в черзі й закриються, щойно синк оновиться. Невідомий вік (рядка немає) —
 *     теж пауза: «не знаю» ≠ «добре».
 *  ② ДЗВІНОК, ЩО СТВОРИВ УГОДУ. Ringostat створює угоду на КОЖЕН дзвінок на мобільний, тож у базі мусить бути
 *     дзвінок цього номера поруч із часом створення. Його немає — ми не бачимо телефонію саме цієї угоди
 *     (синк «успішний», а Ringostat віддав порожньо — `syncCalls` пише успіх і на `[]`), і закривати не можна.
 *     Заміряно 05.10.2026: дзвінок є в 137 із 137 угод після старту, найдальший — у межах −10…+2 хв.
 *
 * Чого тут НЕМАЄ навмисно: закриття AI (перевізник, «Інше») захисту не потребують — без запису розмови вердикту не
 * буває за побудовою. Строк 4 год і частота синку не змінюються.
 */
export const NO_TALK_GUARD = {
  /** Джоба, чий успіх означає «свіже вікно дзвінків у базі» (кожні 3 хв, `index.ts`). */
  syncJob: "syncCallsFresh",
  /** Вікно пошуку дзвінка, що створив угоду: заміряно −10…+2 хв, запас у плюс — затримка створення угоди. */
  creatingCallBeforeMin: 10,
  creatingCallAfterMin: 10,
  /** Типові пороги (налаштування — `CARRIER_NO_TALK_SYNC_MAX_MIN` / `CARRIER_NO_TALK_SYNC_ALERT_MIN`). */
  defaultMaxAgeMin: 30,
  defaultAlertMin: 60,
} as const;

/** Хвилини з налаштувань: не число, нуль чи відʼємне — типове значення, а не NaN (з NaN пауза мовчала б вічно). */
export function minutesSetting(raw: number, def: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : def;
}

export interface NoTalkGate {
  /** Можна ставити «без розмови». */
  open: boolean;
  /** Скільки хвилин тому синк дзвінків востаннє вдався; `null` — невідомо (рядка немає). */
  syncAgeMin: number | null;
  maxAgeMin: number;
  lastSyncAt: string | null;
}

/** Чиста функція рішення: відкрито лише при ВІДОМОМУ й свіжому синку. */
export function noTalkGate(lastSyncAt: Date | null, now: Date, maxAgeMin: number): NoTalkGate {
  if (!lastSyncAt) return { open: false, syncAgeMin: null, maxAgeMin, lastSyncAt: null };
  const ageMin = (now.getTime() - lastSyncAt.getTime()) / 60_000;
  return { open: ageMin <= maxAgeMin, syncAgeMin: Math.max(0, Math.floor(ageMin)), maxAgeMin, lastSyncAt: lastSyncAt.toISOString() };
}

/** Тривога: синку немає довше за поріг тривоги (або вік невідомий). */
export function noTalkAlertDue(gate: NoTalkGate, alertMin: number): boolean {
  return gate.syncAgeMin == null || gate.syncAgeMin > alertMin;
}

/** Угода чекає «без розмови»: строк минув, і номер не має ранішої угоди, що ще чекає чи слухається. `$1` — now, `$2` — строк, хв. */
export const NO_TALK_DUE_SQL = (d: string) => `
  ${d}.state = 'waiting' AND ${d}.deal_created_at + make_interval(mins => $2) <= $1::timestamptz
  AND NOT EXISTS (SELECT 1 FROM carrier_call_deals o WHERE o.phone = ${d}.phone AND o.kommo_id <> ${d}.kommo_id
                   AND o.state IN ('own', 'waiting') AND o.deal_created_at < ${d}.deal_created_at)`;

/** У базі є дзвінок цього номера поруч зі створенням угоди (будь-якої тривалості й результату). */
export const CREATING_CALL_SQL = (d: string) => `
  EXISTS (SELECT 1 FROM ringostat_calls rc WHERE rc.client_phone = ${d}.phone
           AND rc.calldate >= ${d}.deal_created_at - make_interval(mins => ${String(NO_TALK_GUARD.creatingCallBeforeMin)})
           AND rc.calldate <= ${d}.deal_created_at + make_interval(mins => ${String(NO_TALK_GUARD.creatingCallAfterMin)}))`;

export interface NoTalkGuardState {
  gate: NoTalkGate;
  /** Угоди, у яких строк минув, але дзвінка, що їх створив, у базі немає, — не закриваються. */
  noCreatingCall: number;
}

/** Стан захисту з бази: вік синку й скільки угод тримає перевірка ②. Один і той самий для джоби, тривоги й екрана. */
export async function readNoTalkGuard(db: Db, now: Date, noTalkAfterMin: number, maxAgeMin: number): Promise<NoTalkGuardState> {
  const s = await db.query<{ last_success_at: Date | null }>(
    "SELECT last_success_at FROM job_runs WHERE name = $1", [NO_TALK_GUARD.syncJob]);
  const last = s.rows[0]?.last_success_at ?? null;
  const gate = noTalkGate(last ? new Date(last) : null, now, maxAgeMin);
  const h = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM carrier_call_deals d WHERE ${NO_TALK_DUE_SQL("d")} AND NOT ${CREATING_CALL_SQL("d")}`,
    [now.toISOString(), Math.max(0, Math.round(noTalkAfterMin))]);
  return { gate, noCreatingCall: Number(h.rows[0]?.n ?? 0) };
}
