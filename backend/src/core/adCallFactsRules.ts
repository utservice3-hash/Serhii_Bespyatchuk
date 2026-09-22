import { mergedLagGapExpr, mergedLagFirst } from "./callMerge.js";
import { OUTBOUND_TYPES } from "./missedCallsRules.js";

/**
 * 📞 ФАКТИ З ДЗВІНКІВ ПО РЕКЛАМНІЙ УГОДІ — БЕЗ AI, БЕЗ ТАБЛИЦІ, БЕЗ БІЗНЕС-ПОРОГІВ У КОДІ.
 *
 * ТЗ «AI-аналіз дзвінків по рекламних лідах» (22.09.2026), прохід A, коміт ①. Цей шар
 * відповідає на питання «що СТАЛОСЬ» (хто кому дзвонив і коли), а не «як поговорили».
 * Друге — робота моделі, і воно ніколи не підміняє перше: «не передзвонив» рахується тут,
 * з дзвінків Ringostat, а не з тексту розшифровки (обовʼязковий гейт ТЗ).
 *
 * 🔴 МОДУЛЬ ЧИСТИЙ: без `db/pool.js`, без `config.js`, без `metrics.ts` (той тягне пул і
 * кинув би на імпорті без `DATABASE_URL`, тобто раніше за `skip`). Рекламний предикат
 * `adDealSql` приходить ззовні ФУНКЦІЄЮ — модуль його не переписує й не копіює.
 *
 * 📐 ЗВʼЯЗКА УГОДА → ДЗВІНКИ, заміряна 22.09.2026 на 30 днях (крок 0 проходу A):
 *   • `rc.client_phone = '38' || deals.client_key` — знаходить дзвінки для 1 152 із 1 337
 *     угод з міткою «реклама» (86%) і 1 467 із 1 671 за `adDealSql`;
 *   • наявна `rc.client_key = deals.client_key` (через `contact_phones`) — лише 114, і
 *     додає понад першу рівно 5–6 угод; беремо обидві, бо обидві — факти;
 *   • через `client_key_raw` злитих клієнтів — 1 угода; не беремо (шум, окремий прохід).
 * Звідси й форма: номер у CRM — `0XXXXXXXXX`, у Ringostat — `380XXXXXXXXX`.
 *
 * ⚖️ ЩО ЛИШАЄТЬСЯ ВІДКРИТИМ ПИТАННЯМ ВЛАСНИКА і тому ПАРАМЕТР, а не константа:
 *   • поріг «розмови» (у ТЗ і в замірах 20 с — не затверджено);
 *   • вікно до створення угоди (у замірах «1 день» — не затверджено);
 *   • поріг «тиші перед закриттям» (П3);
 *   • який із двох рекламних предикатів головний (П2) — рахуються ОБИДВА прапорці.
 * Значень за замовчуванням тут немає СВІДОМО: не задано → `ParamNotSetError`, а не
 * тихе «20 с, бо так було в замірі». Вигадане правило в коді живе довше за розмову про нього.
 */

/** Системний статус Kommo «закрито не реалізовано». Факт CRM, не бізнес-правило. */
export const KOMMO_LOST_STATUS = 143;

/** Номер клієнта в CRM (нормалізований `client_key`) — український мобільний. */
export const UA_PHONE_KEY_RE = /^0[0-9]{9}$/;

/**
 * Чи можна знайти дзвінки за номером із CRM. ЧОТИРИ стани, бо причин «не можна» три і
 * вони різні (правило 3 кореневого CLAUDE.md: стан, що стверджує причину, не смітник):
 *   ok            — `0XXXXXXXXX`, шукаємо як `380XXXXXXXXX`;
 *   no_key        — клієнта в угоді немає або ключ порожній;
 *   not_ua_phone  — самі цифри, але не український мобільний (ЄДРПОУ, іноземний номер);
 *   not_phone     — у ключі є букви (назва компанії після нормалізації).
 */
export type PhoneState = "ok" | "no_key" | "not_ua_phone" | "not_phone";
export const PHONE_STATES: readonly PhoneState[] = ["ok", "no_key", "not_ua_phone", "not_phone"];

export function classifyClientKey(key: string | null | undefined): PhoneState {
  if (key == null || key.trim() === "") return "no_key";
  if (UA_PHONE_KEY_RE.test(key)) return "ok";
  if (/^[0-9]+$/.test(key)) return "not_ua_phone";
  return "not_phone";
}

/** Та сама класифікація в SQL — один вираз на обидва боки, парність тримає `#653`. */
export const phoneStateSql = (a: string): string => `(CASE
  WHEN ${a} IS NULL OR btrim(${a}) = '' THEN 'no_key'
  WHEN ${a} ~ '^0[0-9]{9}$' THEN 'ok'
  WHEN ${a} ~ '^[0-9]+$' THEN 'not_ua_phone'
  ELSE 'not_phone' END)`;

/**
 * Стан угоди за дзвінками. Сума станів == кількість відібраних угод (інваріант `#653`):
 *   no_phone  — номер не визначено І дзвінків за наявним `client_key` теж немає;
 *   no_calls  — номер є, дзвінків у вікні угоди немає;
 *   no_talks  — дзвінки є, але жодного не довше за поріг розмови;
 *   talked    — є хоча б одна розмова від порогу.
 * Жоден із них не «0 балів» і не «погано»: це стан ДАНИХ, а не оцінка менеджера.
 */
export type DealCallState = "no_phone" | "no_calls" | "no_talks" | "talked";
export const DEAL_CALL_STATES: readonly DealCallState[] = ["no_phone", "no_calls", "no_talks", "talked"];

export function dealCallState(phone: PhoneState, calls: number, talks: number): DealCallState {
  if (calls === 0) return phone === "ok" ? "no_calls" : "no_phone";
  return talks > 0 ? "talked" : "no_talks";
}

/** Параметр, який ще не затвердив власник. Текст несе «не налаштовано» → вид `config` у тривогах. */
export class ParamNotSetError extends Error {
  constructor(what: string) {
    super(`не налаштовано: ${what} (рішення власника ще немає — значення за замовчуванням у коді свідомо немає)`);
    this.name = "ParamNotSetError";
  }
}

/** Інтервал, який можна безпечно віддати Postgres параметром: «N hours» / «N days». */
const INTERVAL_RE = /^[0-9]{1,3} (hours|days)$/;

export interface AdCallFactsParams {
  /** Дата СТВОРЕННЯ угоди, київська, обидва кінці включно. */
  from: string;
  to: string;
  /** «Зараз» — межа вікна відкритої угоди. Ззовні, щоб гейти були детерміновані. */
  now: Date;
  /** Поріг розмови в секундах. ВІДКРИТЕ ПИТАННЯ — без значення за замовчуванням. */
  talkMinSec: number | null | undefined;
  /** Скільки до створення угоди ще належить їй (дзвінок, з якого угоду завели). ВІДКРИТЕ ПИТАННЯ. */
  windowBefore: string | null | undefined;
  /**
   * Рекламний предикат «як у Звіті» — `adDealSql` з `core/metrics.ts`. Приходить ФУНКЦІЄЮ:
   * отримує посилання на параметр зі списком `adSources` і повертає SQL над аліасом `d`.
   */
  adDealPredicate: (srcRef: string) => string;
  /** `app_settings.data->'adSources'` — аргумент для `adDealPredicate`. */
  adSources: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Перевірка параметрів ДО запиту. Кидає, а не підставляє: див. доккоментар модуля. */
export function assertFactsParams(p: AdCallFactsParams): { talkMinSec: number; windowBefore: string } {
  if (!DATE_RE.test(p.from) || !DATE_RE.test(p.to)) throw new Error(`період має бути YYYY-MM-DD: ${p.from}…${p.to}`);
  if (p.talkMinSec == null || !Number.isInteger(p.talkMinSec) || p.talkMinSec < 1) {
    throw new ParamNotSetError("поріг розмови, секунд");
  }
  if (p.windowBefore == null || !INTERVAL_RE.test(p.windowBefore)) {
    throw new ParamNotSetError("вікно до створення угоди («N hours» / «N days»)");
  }
  return { talkMinSec: p.talkMinSec, windowBefore: p.windowBefore };
}

const inList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(",");
const OUT = inList(OUTBOUND_TYPES);

/**
 * Один запит на весь період: угоди, їхні дзвінки, склейка плечей і агрегати.
 *
 * 🔴 СКЛЕЙКА — КАНОНІЧНА (`core/callMerge.ts`), і тому рахується по УНІКАЛЬНИХ дзвінках,
 * а не по парах «угода × дзвінок». Один дзвінок буває у двох угодах того самого клієнта
 * (заміряно: 133 розмови за 30 днів); якби LAG ішов по парах, дубль того самого `uniqueid`
 * дав би gap = 0 і «склеїв» дзвінок сам із собою — друга угода втратила б його мовчки.
 *
 * 🔴 ДВА ШЛЯХИ ЗВʼЯЗКИ — `UNION`, а не `OR` у `JOIN`: кожен шлях іде своїм індексом
 * (`client_phone` / `client_key`), і `UNION` сам прибирає дзвінок, знайдений обома.
 */
export function adCallFactsSql(p: AdCallFactsParams): { sql: string; params: unknown[] } {
  const { talkMinSec, windowBefore } = assertFactsParams(p);
  const win = (alias: string) => `${alias}.calldate >= d0.created_at - $3::interval
             AND ${alias}.calldate <= COALESCE(d0.closed_at, $4::timestamptz)`;
  const sql = `
    WITH d0 AS (
      SELECT d.kommo_id, d.manager_id, d.pipeline_id, d.status_id,
             d.created_at_kommo AS created_at, d.closed_at_kommo AS closed_at, d.client_key,
             COALESCE(d.lead_channel = 'ad', false) AS is_lead_channel_ad,
             COALESCE((${p.adDealPredicate("$6::text[]")}), false) AS is_ad_deal_sql,
             ${phoneStateSql("d.client_key")} AS phone_state
        FROM deals d
       WHERE (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date
         AND (COALESCE(d.lead_channel = 'ad', false) OR COALESCE((${p.adDealPredicate("$6::text[]")}), false))
    ),
    lc AS (
      SELECT d0.kommo_id, rc.uniqueid, rc.calldate, rc.call_type, rc.billsec, rc.manager_id, rc.client_phone
        FROM d0 JOIN ringostat_calls rc
          ON d0.phone_state = 'ok' AND rc.client_phone = '38' || d0.client_key AND ${win("rc")}
      UNION
      SELECT d0.kommo_id, rc.uniqueid, rc.calldate, rc.call_type, rc.billsec, rc.manager_id, rc.client_phone
        FROM d0 JOIN ringostat_calls rc
          ON d0.client_key IS NOT NULL AND rc.client_key = d0.client_key AND ${win("rc")}
    ),
    cu AS (SELECT DISTINCT uniqueid, calldate, call_type, billsec, manager_id, client_phone FROM lc),
    cm AS (SELECT cu.uniqueid, ${mergedLagGapExpr("cu")} AS gap FROM cu),
    lf AS (SELECT lc.* FROM lc JOIN cm USING (uniqueid) WHERE ${mergedLagFirst("cm.gap")}),
    agg AS (
      SELECT d0.kommo_id, d0.manager_id, d0.pipeline_id, d0.status_id, d0.created_at, d0.closed_at,
             d0.client_key, d0.is_lead_channel_ad, d0.is_ad_deal_sql, d0.phone_state,
             count(lf.uniqueid)::int AS calls,
             count(lf.uniqueid) FILTER (WHERE lf.billsec >= $5)::int AS talks,
             min(lf.calldate) AS first_call_at,
             (array_agg(lf.call_type ORDER BY lf.calldate, lf.uniqueid) FILTER (WHERE lf.uniqueid IS NOT NULL))[1] AS first_call_type,
             min(lf.calldate) FILTER (WHERE lf.call_type IN (${OUT}) AND lf.calldate >= d0.created_at) AS first_out_after_created_at,
             max(lf.calldate) FILTER (WHERE lf.billsec >= $5) AS last_talk_at,
             (array_agg(lf.call_type ORDER BY lf.calldate DESC, lf.uniqueid DESC) FILTER (WHERE lf.billsec >= $5))[1] AS last_talk_type
        FROM d0 LEFT JOIN lf ON lf.kommo_id = d0.kommo_id
       GROUP BY d0.kommo_id, d0.manager_id, d0.pipeline_id, d0.status_id, d0.created_at, d0.closed_at,
                d0.client_key, d0.is_lead_channel_ad, d0.is_ad_deal_sql, d0.phone_state
    )
    SELECT agg.*,
           (SELECT count(*) FROM lf
             WHERE lf.kommo_id = agg.kommo_id AND lf.call_type IN (${OUT})
               AND agg.last_talk_at IS NOT NULL AND lf.calldate > agg.last_talk_at)::int AS out_after_last_talk
      FROM agg
     ORDER BY agg.created_at, agg.kommo_id`;
  return { sql, params: [p.from, p.to, windowBefore, p.now.toISOString(), talkMinSec, p.adSources] };
}

export type CallDir = "in" | "out";
const dirOf = (callType: string | null): CallDir | null =>
  callType == null ? null : (OUTBOUND_TYPES as readonly string[]).includes(callType) ? "out" : "in";

export interface AdCallFactsRow {
  kommo_id: string | number; manager_id: number | null; pipeline_id: string | number | null; status_id: string | number | null;
  created_at: Date; closed_at: Date | null; client_key: string | null;
  is_lead_channel_ad: boolean; is_ad_deal_sql: boolean; phone_state: PhoneState;
  calls: number; talks: number; first_call_at: Date | null; first_call_type: string | null;
  first_out_after_created_at: Date | null; last_talk_at: Date | null; last_talk_type: string | null;
  out_after_last_talk: number;
}

export interface AdDealCallFacts {
  kommoId: number; managerId: number | null; pipelineId: number | null; statusId: number | null;
  createdAt: Date; closedAt: Date | null;
  isLeadChannelAd: boolean; isAdDealSql: boolean;
  phoneState: PhoneState; state: DealCallState;
  calls: number; talks: number;
  firstCallAt: Date | null; firstCallDir: CallDir | null;
  firstOutAfterCreatedAt: Date | null;
  lastTalkAt: Date | null; lastTalkDir: CallDir | null;
  outAfterLastTalk: number;
  /** Хвилин від останньої розмови до закриття; null — угода відкрита або розмов не було. */
  closeGapMin: number | null;
}

export function foldFacts(r: AdCallFactsRow): AdDealCallFacts {
  const calls = Number(r.calls), talks = Number(r.talks);
  const closeGapMin = r.closed_at && r.last_talk_at
    ? Math.round((new Date(r.closed_at).getTime() - new Date(r.last_talk_at).getTime()) / 60000) : null;
  return {
    kommoId: Number(r.kommo_id), managerId: r.manager_id == null ? null : Number(r.manager_id),
    pipelineId: r.pipeline_id == null ? null : Number(r.pipeline_id), statusId: r.status_id == null ? null : Number(r.status_id),
    createdAt: new Date(r.created_at), closedAt: r.closed_at ? new Date(r.closed_at) : null,
    isLeadChannelAd: r.is_lead_channel_ad === true, isAdDealSql: r.is_ad_deal_sql === true,
    phoneState: r.phone_state, state: dealCallState(r.phone_state, calls, talks),
    calls, talks,
    firstCallAt: r.first_call_at ? new Date(r.first_call_at) : null, firstCallDir: dirOf(r.first_call_type),
    firstOutAfterCreatedAt: r.first_out_after_created_at ? new Date(r.first_out_after_created_at) : null,
    lastTalkAt: r.last_talk_at ? new Date(r.last_talk_at) : null, lastTalkDir: dirOf(r.last_talk_type),
    outAfterLastTalk: Number(r.out_after_last_talk), closeGapMin,
  };
}

/** Лічильники станів одним проходом — сума завжди дорівнює кількості угод. */
export function countStates(facts: AdDealCallFacts[]): Record<DealCallState, number> & { total: number } {
  const out = { no_phone: 0, no_calls: 0, no_talks: 0, talked: 0, total: facts.length };
  for (const f of facts) out[f.state]++;
  return out;
}

/**
 * 🤫 «ТИША ПЕРЕД ЗАКРИТТЯМ» — факт, а не звинувачення: угоду закрито «не реалізовано»
 * через щонайменше `minGapHours` після останньої розмови, і за цей час на номер не було
 * ЖОДНОГО нашого вихідного, навіть спроби. Поріг — ВІДКРИТЕ ПИТАННЯ П3, тож параметр.
 * `null` означає «не застосовно» (угода не програна, розмов не було), а не «тиші немає».
 */
export function silentBeforeClose(f: AdDealCallFacts, minGapHours: number | null | undefined): boolean | null {
  if (minGapHours == null || !(minGapHours > 0)) throw new ParamNotSetError("поріг «тиші перед закриттям», годин");
  if (f.statusId !== KOMMO_LOST_STATUS || f.closeGapMin == null) return null;
  return f.outAfterLastTalk === 0 && f.closeGapMin >= minGapHours * 60;
}

/**
 * 🤝 ЧИ ВИКОНАНО ОБІЦЯНКУ — РАХУЄТЬСЯ З ДЗВІНКІВ. Модель дає лише ДЕ і ДО КОЛИ пообіцяли
 * (`madeAt`, `deadline`); виконання визначає Ringostat. Функція навмисно НЕ приймає
 * нічого з тексту аналізу — «модель вважає, що передзвонив» сюди не доходить за побудовою.
 *
 *   no_deadline      — строк не встановлено (правило строку — П5, ще не затверджене);
 *   pending          — строк ще не минув і вихідного ще не було;
 *   kept_talk        — до строку був наш вихідний з розмовою (контакт = розмова, рішення 04.08);
 *   kept_attempt_only— до строку були лише спроби без розмови;
 *   broken           — строк минув, до нього на номер не було жодного нашого вихідного.
 * Дзвінок КОЛЕГИ зараховується (як у пропущених, рішення 15–16.09): обіцяла компанія.
 */
export type PromiseOutcome = "no_deadline" | "pending" | "kept_talk" | "kept_attempt_only" | "broken";

export interface OutboundCall { at: Date; billsec: number; callType: string }

/** Ті самі вихідні типи, що в пропущених, — реекспорт, щоб виконавець не тягнув другий модуль. */
export const OUTBOUND_TYPES_FOR_PROMISE = OUTBOUND_TYPES;

export function promiseOutcome(
  p: { madeAt: Date; deadline: Date | null },
  calls: readonly OutboundCall[],
  now: Date,
): PromiseOutcome {
  if (!p.deadline) return "no_deadline";
  const inWindow = calls.filter((c) => (OUTBOUND_TYPES as readonly string[]).includes(c.callType)
    && c.at.getTime() > p.madeAt.getTime() && c.at.getTime() <= p.deadline!.getTime());
  if (inWindow.some((c) => c.billsec > 0)) return "kept_talk";
  if (inWindow.length > 0) return "kept_attempt_only";
  return now.getTime() < p.deadline.getTime() ? "pending" : "broken";
}
