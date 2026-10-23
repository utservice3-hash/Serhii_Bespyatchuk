import type { Db } from "./adCallFacts.js";
import { CONTACT_SOURCE_AI_TENDER, CONTACT_SOURCE_FIELD, LEAD_SOURCE_AI_TENDER, LEAD_SOURCE_FIELD, PZ_PIPELINE, PZ_TENDER_STATUS } from "./prozorroPush.js";

/**
 * ✅ ГОТОВНІСТЬ PROZORRO-ЛІДІВ — «що буде далі» й перевірка перед бойовим режимом (задача #5299; Роман 23.10.2026: «не до кінця
 * розумію, як зрозуміти, чи запуститься збірка… хочеться якесь підтвердження налаштувань»).
 *
 * Лише ЧИТАННЯ: з нашої бази (точка відліку, останній прохід, скільки знаходимо) і з Kommo (етап «Тендер AI» і значення
 * «AI тендер» на місці). Kommo питаємо не частіше ніж раз на 10 хв — вкладку відкривають, а ліміт Kommo спільний.
 */

export const RUN_HOUR = 6;
export const RUN_MINUTE = 5;
export const KOMMO_CHECK_TTL_MS = 10 * 60_000;

/** Київська дата й час (години, хвилини) для моменту `now` — без бібліотек, через Intl (переходи на літній/зимовий час враховано). */
function kyivParts(now: Date): { date: string; h: number; m: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), m: Number(p.minute) };
}
const nextDate = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Наступний ранковий збір за Києвом: сьогодні о 06:05, якщо ще не настало, інакше завтра. Крон теж за Києвом (`index.ts`). */
export function nextRunKyiv(now: Date): { date: string; time: string } {
  const k = kyivParts(now);
  const before = k.h < RUN_HOUR || (k.h === RUN_HOUR && k.m < RUN_MINUTE);
  return { date: before ? k.date : nextDate(k.date), time: `0${String(RUN_HOUR)}:0${String(RUN_MINUTE)}` };
}

export interface KommoSetupCheck { ok: boolean; problems: string[]; checkedAt: string }
type Get = <T>(path: string) => Promise<T>;

/** Чи на місці в Kommo те, куди пишемо: етап «Тендер AI» у «Продзвоні», «AI тендер» у полі джерела угоди й контакту. */
export async function checkKommoSetup(get: Get, now: Date = new Date()): Promise<KommoSetupCheck> {
  const problems: string[] = [];
  try {
    const p = await get<{ _embedded?: { statuses?: { id: number }[] } }>(`/api/v4/leads/pipelines/${String(PZ_PIPELINE)}`);
    if (!(p._embedded?.statuses ?? []).some((s) => s.id === PZ_TENDER_STATUS)) problems.push("у воронці «Продзвін» немає етапу «Тендер AI»");
    const lf = await get<{ enums?: { id: number }[] }>(`/api/v4/leads/custom_fields/${String(LEAD_SOURCE_FIELD)}`);
    if (!(lf.enums ?? []).some((e) => e.id === LEAD_SOURCE_AI_TENDER)) problems.push("у полі «Источник клиента» угоди немає значення «AI тендер»");
    const cf = await get<{ enums?: { id: number }[] }>(`/api/v4/contacts/custom_fields/${String(CONTACT_SOURCE_FIELD)}`);
    if (!(cf.enums ?? []).some((e) => e.id === CONTACT_SOURCE_AI_TENDER)) problems.push("у полі «Источник клиента» контакту немає значення «AI тендер»");
  } catch (e) {
    problems.push(`не вдалось перевірити Kommo: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
  }
  return { ok: problems.length === 0, problems, checkedAt: now.toISOString() };
}

/** Кеш перевірки Kommo на 10 хв (модульний; невдала перевірка теж кешується — щоб не бомбити Kommo при збої). */
export function cachedKommoCheck(get: Get, ttlMs: number = KOMMO_CHECK_TTL_MS, clock: () => number = Date.now) {
  let last: { at: number; value: KommoSetupCheck } | null = null;
  return async (): Promise<KommoSetupCheck> => {
    if (last && clock() - last.at < ttlMs) return last.value;
    const value = await checkKommoSetup(get, new Date(clock()));
    last = { at: clock(), value };
    return value;
  };
}

export interface Readiness {
  nextRun: { date: string; time: string };
  /** Точку відліку пройдено: перший прохід уже записав тендери; ліди — лише після неї. */
  baselineDone: boolean;
  baselineAt: string | null;
  lastRun: { at: string | null; error: string | null };
  kommo: KommoSetupCheck;
  /** Скільки переможців у середньому знаходимо за день (останні до 7 повних днів після точки відліку); null — ще мало даних. */
  avgFoundPerDay: number | null;
}

export async function loadReadiness(db: Db, kommoCheck: () => Promise<KommoSetupCheck>, now: Date = new Date()): Promise<Readiness> {
  const b = (await db.query<{ at: Date | null }>(`SELECT min(first_seen_at) AS at FROM prozorro_tenders`)).rows[0]?.at ?? null;
  const job = (await db.query<{ ok: Date | null; err: string | null; err_at: Date | null }>(
    `SELECT last_success_at AS ok, last_error AS err, last_error_at AS err_at FROM job_runs WHERE name = 'prozorroLeads'`)).rows[0];
  const freshErr = job?.err && job.err_at && (!job.ok || job.err_at > job.ok) ? job.err : null;
  let avg: number | null = null;
  if (b) {
    const days = Math.min(7, Math.floor((now.getTime() - new Date(b).getTime()) / 86_400_000));
    if (days >= 1) {
      const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM prozorro_leads WHERE created_at > $1::timestamptz - make_interval(days => $2)`,
        [now.toISOString(), days])).rows[0]?.n ?? 0;
      avg = Math.round(n / days);
    }
  }
  return {
    nextRun: nextRunKyiv(now),
    baselineDone: b != null,
    baselineAt: b ? new Date(b).toISOString() : null,
    lastRun: { at: job?.ok ? new Date(job.ok).toISOString() : null, error: freshErr },
    kommo: await kommoCheck(),
    avgFoundPerDay: avg,
  };
}
