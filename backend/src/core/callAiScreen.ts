import type { Db } from "./adCallFacts.js";
import { adDealFirstTalksSql } from "./adCallFactsRules.js";
import { OUTBOUND_TYPES } from "./missedCallsRules.js";
import type { MissedScope } from "./missedCallsRules.js";
import { ELEVENLABS_STT_MODEL, GEMINI_MODEL, FIRST_TOUCH_SHOWN_RUBRICS, FIRST_TOUCH_RUBRICS, type AnalysisResult, type Turn } from "./callAiProviders.js";
import { LLM_PROVIDER, STT_PROVIDER, RINGOSTAT_POLICY, RECORDING_MAX_BYTES, type AdPredicate } from "./callAiPilot.js";
import { downloadRecording, type DownloadOutcome } from "./ringostatRecording.js";
import { FIRST_TOUCH_RULE, firstTouchExclusionSql } from "./callAiTick.js";
import { monthSpend } from "./callAiPipeline.js";
import { adCallFacts } from "./adCallFacts.js";
import { silentBeforeClose, type AdCallFactsParams } from "./adCallFactsRules.js";
import { typeVerdict, type TypeOverride } from "./callAiType.js";
import type { ConversationType } from "./callAiProviders.js";
import { loadTunables, type FirstTouchTunables } from "./firstTouchTunables.js";
import { offHours, reactionMinutes } from "./leadReaction.js";
import { countingDeadline, promiseDeadline, promiseState, worstPromiseState, withOfflineMark, type CallFact, type DeadlineBasis, type ModelPromise, type PromiseState } from "./callAiPromise.js";

/**
 * 🤫 «ТИША ПЕРЕД ЗАКРИТТЯМ» (П3, рішення Романа 29.09.2026): угоду закрито «не реалізовано» пізніше ніж
 * через 24 год після останньої розмови, і за цей час на номер не було жодного нашого вихідного. Прапорці —
 * лише за період ПІСЛЯ оголошення норми менеджерам; дати ще немає (`normFrom: null`) → рахуємо, але на
 * екрані прапорця не показуємо.
 */
export const SILENCE_RULE: Readonly<{ minGapHours: number; normFrom: string | null }> = { minGapHours: 24, normFrom: null };

/** Воронки Кваліфікації (New і стара) — окрема група на екрані (П8-Б). Повний цикл — 8921932. */
const QUALIFICATION_PIPELINES = new Set([8921928, 7336928]);
const FULL_CYCLE_PIPELINE = 8921932;
export type PipelineGroup = "full" | "qualification" | "other";
export const pipelineGroupOf = (id: number | null): PipelineGroup =>
  id == null ? "other" : QUALIFICATION_PIPELINES.has(id) ? "qualification" : id === FULL_CYCLE_PIPELINE ? "full" : "other";

/**
 * 🎧 ЕКРАН «ПЕРШИЙ ДОТИК · AI» — ЛИШЕ ПЕРЕГЛЯД (прохід 1, рішення Романа 28.09.2026).
 *
 * Модуль без пулу: базу дає роут (`pool`) або гейт (scratch). Вибірка — ТА САМА, що в джобі
 * (`adDealFirstTalksSql` + `FIRST_TOUCH_RULE`, METRICS_GLOSSARY §15): друга копія правила «що
 * таке перший дотик» розійшлася б із першою мовчки. Тому екран показує рівно ті дзвінки, які
 * джоба бере в роботу, — і ті, до яких вона ще не дійшла, теж: зі станом, а не пропуском.
 *
 * 🔒 ДОСТУП (рішення Романа 28.09.2026): вкладка — admin, kvp, ceo, opdir, team_lead; тімлід бачить
 * лише дзвінки своєї команди (за тим, ХТО ДЗВОНИВ — дотик належить йому, як у §12). ПОВНИЙ текст
 * розмови — лише admin і kvp; решта бачить витяг із цитатами.
 *
 * ⚖️ ПЕРІОД — за датою СТВОРЕННЯ угоди (Київ), як у правилі вибірки: інакше лічильник екрана й
 * черга джоби рахували б різні множини. Межі одні на обидва боки.
 */

/** Ролі, яким видно повну розшифровку. Решта ролей вкладки — лише цитати. */
export const TRANSCRIPT_ROLES: ReadonlySet<string> = new Set(["admin", "kvp"]);

/**
 * Чи можна цьому акаунту повний текст розмови — ЗА КЛЮЧЕМ РОЛІ (`roleKey`), а не за сумісною
 * роллю (`role`). 🔴 Приймання 28.09.2026: у токені CEO, опдира й КВП `role === "admin"` (право
 * `admin_scope`), тож перевірка за `role` віддала б повний текст CEO й опдиру, хоча рішення
 * власника — лише адмін і КВП. Гейти ядра цього не бачили: вони кликали ядро з ключем напряму.
 */
export function transcriptAllowed(auth: { role?: string; roleKey?: string | null }, roles: ReadonlySet<string> = TRANSCRIPT_ROLES): boolean {
  return auth.roleKey != null && roles.has(auth.roleKey);
}

/**
 * Хто бачить повний текст розмови на «Першому дотику · AI» (рішення Романа 29.09.2026: «відкривай повні тексти
 * для ceo і оп диру»). Окремий набір, а НЕ розширення `TRANSCRIPT_ROLES`: той самий `transcriptAllowed` без
 * другого аргументу стереже «Перевізників за розмовою», а про них рішення не було.
 */
export const FIRST_TOUCH_TRANSCRIPT_ROLES: ReadonlySet<string> = new Set(["admin", "kvp", "ceo", "opdir", "team_lead", "manager"]);
// ↑ ТЗ «звіт тімліда» 30.09.2026, відповідь Романа: «відкривай тімліду свою команду а менеджеру свої угоди» — роль
//   відкриває текст і запис, а ЧИЇ саме розмови — вирішує скоуп картки (тімлід — команда, менеджер — свої).

/**
 * Хто пише коментар (ТЗ п.5 і п.6.3): «Чому не озвучено ціну» — менеджер (свої), тімлід (команда), адмін;
 * «Опрацьовано» до невиконаної домовленості — лише тімлід і адмін. Скоуп — у роуті через картку.
 */
export function canWriteNote(roleKey: string | null | undefined, kind: string): boolean {
  if (kind === "price" || kind === "offline") return roleKey === "admin" || roleKey === "team_lead" || roleKey === "manager";
  if (kind === "missed" || kind === "review") return roleKey === "admin" || roleKey === "team_lead";
  return false;
}

/**
 * Стан рядка — ЧЕСНИЙ і РІЗНИЙ для кожної причини «ще не готово». Жоден не показується нулем.
 *   not_queued            — джоба ще не дійшла до дзвінка (новий, або ключів ще не було);
 *   not_enabled           — ключа постачальника немає;
 *   queued                — у черзі або вже в роботі;
 *   capped                — чекає, бо вичерпано стелю місяця;
 *   recording_unavailable — запису в Ringostat немає;
 *   stt_failed / llm_failed — постачальник відмовив після всіх спроб;
 *   llm_pending           — розшифровка є, аналіз ще не готовий;
 *   done                  — є витяг.
 */
export type AiCallState = "not_queued" | "not_enabled" | "queued" | "capped" | "recording_unavailable"
  | "stt_failed" | "no_text" | "llm_pending" | "llm_failed" | "done";
export const AI_CALL_STATES: readonly AiCallState[] = ["done", "llm_pending", "queued", "not_queued", "not_enabled",
  "capped", "recording_unavailable", "stt_failed", "no_text", "llm_failed"];

/**
 * `textEmpty` — розпізнавання завершилось, а слів у записі немає (тиша, гудки, автовідповідач). Такі розмови
 * в аналіз не йдуть (черга аналізу бере лише непорожні), і без цього стану висіли б «Аналіз у черзі» назавжди
 * (Роман 29.09.2026: «не роби аналіз для розмов без тексту, дай їм окремий статус»).
 */
export function aiCallState(stt: string | null, llm: string | null, textEmpty = false): AiCallState {
  if (stt == null) return "not_queued";
  if (stt === "not_enabled") return "not_enabled";
  if (stt === "queued" || stt === "working") return "queued";
  if (stt === "capped") return "capped";
  if (stt === "recording_unavailable") return "recording_unavailable";
  if (stt === "failed") return "stt_failed";
  // stt === "done"
  if (textEmpty) return "no_text";
  if (llm == null || llm === "queued" || llm === "working") return "llm_pending";
  if (llm === "not_enabled") return "not_enabled";
  if (llm === "capped") return "capped";
  if (llm === "failed") return "llm_failed";
  return "done";
}

export interface AiCallRow {
  kommoId: number;
  uniqueid: string;
  calledAt: string;
  direction: "in" | "out";
  billsec: number;
  dealCreatedAt: string;
  managerId: number | null;
  managerName: string | null;
  teamId: number | null;
  teamName: string | null;
  state: AiCallState;
  failure: string | null;
  summary: string | null;
  priceDiscussed: boolean | null;
  objections: number;
  promises: number;
  promisesWithDeadline: number;
  /** Цитат, яких немає в розмові (модель процитувала те, чого не казали). Нуль — норма. */
  unverifiedQuotes: number;
  /** Воронка угоди (П8-Б: Кваліфікація — окремою групою). */
  pipelineGroup: PipelineGroup;
  /** «Причина відмови» угоди з CRM — для нецільових («Дубль», «Перевізник»). */
  rejectReason: string | null;
  /** Найгірший стан обіцянок МЕНЕДЖЕРА (П4–П7); `null` — обіцянок менеджера немає або аналізу ще немає. */
  promiseState: PromiseState | null;
  /** Обіцянок менеджера в розмові. */
  managerPromises: number;
  /** П3: `true` — тиша перед закриттям; `null` — не застосовно (угода не програна або без розмов). */
  silentBeforeClose: boolean | null;
  /** Тип розмови від моделі (рубрика v2) — `null`, поки не розібрано. */
  conversationType: ConversationType | null;
  typeConfidence: number | null;
  typeReason: string | null;
  /** Названа ціна дослівно («18000 грн»); `null` — суми не прозвучало або ще не розібрано. */
  priceValue: string | null;
  /** У звіті (ТЗ 30.09.2026) чи у «Виключених» — `core/callAiType.ts`. */
  inReport: boolean;
  /** Модель не впевнена (< 0.85) — у звіті з позначкою «Перевірити тип». */
  typeCheck: boolean;
  /** Остання ручна позначка тімліда чи адміна, якщо була. */
  typeOverride: TypeOverride | null;
  /** «Чому не озвучено ціну» і «Опрацьовано» (ТЗ 30.09.2026) — `null`, якщо не писали. */
  priceNote: CallNote | null;
  missedNote: CallNote | null;
  /** «Передзвонив поза телефонією» (01.10.2026) — `null`, якщо не позначали. */
  offlineNote: CallNote | null;
  /** «Розібрано» тімлідом з черги розбору (екран D, 08.10.2026) — `null`, якщо не розбирали. */
  reviewNote: CallNote | null;
  /** Модель витягла запит клієнта (що й куди везти) — пункт «Запит» чек-листа; `false` і до аналізу. */
  hasRequest: boolean;
  /** Номер клієнта (для пулу заявок тімліда, ТЗ п.6.2) — `null`, якщо Ringostat його не дав. */
  clientPhone: string | null;
  /** ⏱ Перший наш вихідний на номер після створення угоди (`core/leadReaction.ts`); `null` — не дзвонили / невідомо. */
  firstOutboundAt: string | null;
  /** Хвилин від створення угоди до першого вихідного; рахується після згортання (від найранішої угоди). */
  reactionMin: number | null;
  /** Заявка надійшла у вихідний чи поза робочими годинами. */
  reactionOffHours: boolean;
}

export interface CallNote { text: string; byName: string | null; at: string }

interface RawRow {
  kommo_id: string | number; uniqueid: string; calldate: Date; call_type: string; billsec: number; created_at: Date;
  manager_id: number | null; manager_name: string | null; team_id: number | null; team_name: string | null;
  stt_status: string | null; stt_failure: string | null; llm_status: string | null; llm_failure: string | null;
  result: AnalysisResult | null;
  client_phone?: string | null; pipeline_id?: string | number | null; reject_reason?: string | null;
  /** Розпізнано, але слів немає: `segments` порожній. */
  stt_empty?: boolean | null;
  ov_is_cargo?: boolean | null; ov_by?: string | null; ov_at?: Date | null;
  pn_text?: string | null; pn_by?: string | null; pn_at?: Date | null;
  mn_text?: string | null; mn_by?: string | null; mn_at?: Date | null;
  on_text?: string | null; on_by?: string | null; on_at?: Date | null;
  rv_text?: string | null; rv_by?: string | null; rv_at?: Date | null;
  first_out_at?: Date | null;
}

const IN_TYPES = new Set(["in", "transitin"]);

export function foldRow(r: RawRow): AiCallRow {
  const state = aiCallState(r.stt_status, r.llm_status, r.stt_empty === true);
  const res = state === "done" ? r.result : null;
  const quotes = res ? [res.price, ...res.objections, ...res.promises] : [];
  return {
    kommoId: Number(r.kommo_id), uniqueid: r.uniqueid, calledAt: new Date(r.calldate).toISOString(),
    direction: IN_TYPES.has(r.call_type) ? "in" : "out", billsec: Number(r.billsec),
    dealCreatedAt: new Date(r.created_at).toISOString(),
    managerId: r.manager_id == null ? null : Number(r.manager_id), managerName: r.manager_name,
    teamId: r.team_id == null ? null : Number(r.team_id), teamName: r.team_name,
    state,
    failure: state === "stt_failed" || state === "recording_unavailable" ? r.stt_failure
      : state === "llm_failed" ? r.llm_failure : null,
    summary: res?.summary ?? null,
    priceDiscussed: res ? res.price.discussed : null,
    objections: res?.objections.length ?? 0,
    promises: res?.promises.length ?? 0,
    promisesWithDeadline: res?.promises.filter((p) => p.deadline_text.trim() !== "").length ?? 0,
    unverifiedQuotes: quotes.filter((q) => q.quote_found === false).length,
    pipelineGroup: pipelineGroupOf(r.pipeline_id == null ? null : Number(r.pipeline_id)),
    rejectReason: r.reject_reason ?? null,
    promiseState: null,
    managerPromises: res ? managerPromisesOf(res).length : 0,
    silentBeforeClose: null,
    ...typeFields(res, r),
    priceNote: r.pn_text ? { text: r.pn_text, byName: r.pn_by ?? null, at: r.pn_at ? new Date(r.pn_at).toISOString() : "" } : null,
    missedNote: r.mn_text ? { text: r.mn_text, byName: r.mn_by ?? null, at: r.mn_at ? new Date(r.mn_at).toISOString() : "" } : null,
    offlineNote: r.on_text ? { text: r.on_text, byName: r.on_by ?? null, at: r.on_at ? new Date(r.on_at).toISOString() : "" } : null,
    reviewNote: r.rv_text ? { text: r.rv_text, byName: r.rv_by ?? null, at: r.rv_at ? new Date(r.rv_at).toISOString() : "" } : null,
    hasRequest: (res?.client_request ?? "").trim() !== "",
    clientPhone: r.client_phone ?? null,
    firstOutboundAt: r.first_out_at ? new Date(r.first_out_at).toISOString() : null,
    reactionMin: null,
    reactionOffHours: false,
  };
}

/** Коментарі «ціна» і «опрацьовано» — по одному на розмову (`alias` — таблиця з `uniqueid`). */
const notesJoin = (alias: string): string => `LEFT JOIN first_touch_notes pn ON pn.uniqueid = ${alias}.uniqueid AND pn.kind = 'price'
      LEFT JOIN first_touch_notes mn ON mn.uniqueid = ${alias}.uniqueid AND mn.kind = 'missed'
      LEFT JOIN first_touch_notes onx ON onx.uniqueid = ${alias}.uniqueid AND onx.kind = 'offline'
      LEFT JOIN first_touch_notes rvx ON rvx.uniqueid = ${alias}.uniqueid AND rvx.kind = 'review'`;
const NOTE_COLS = "pn.note AS pn_text, pn.set_by_name AS pn_by, pn.set_at AS pn_at, mn.note AS mn_text, mn.set_by_name AS mn_by, mn.set_at AS mn_at, "
  + "onx.note AS on_text, onx.set_by_name AS on_by, onx.set_at AS on_at, rvx.note AS rv_text, rvx.set_by_name AS rv_by, rvx.set_at AS rv_at";

function typeFields(res: AnalysisResult | null, r: RawRow): Pick<AiCallRow, "conversationType" | "typeConfidence" | "typeReason" | "priceValue" | "inReport" | "typeCheck" | "typeOverride"> {
  const override: TypeOverride | null = r.ov_is_cargo == null ? null
    : { isCargo: r.ov_is_cargo === true, byName: r.ov_by ?? null, at: r.ov_at ? new Date(r.ov_at).toISOString() : "" };
  const type = res?.conversation_type ?? null;
  const conf = typeof res?.type_confidence === "number" ? res.type_confidence : null;
  // Домовленість ПЕРЕДЗВОНИТИ від менеджера (а не «напишу в месенджер») — правило 05.10.2026 у `typeVerdict`.
  const callback = (res?.promises ?? []).some((p) => p.who === "manager" && p.channel === "call");
  const v = typeVerdict(type, conf, override, callback);
  return { conversationType: type, typeConfidence: conf, typeReason: res?.type_reason ?? null,
    priceValue: res?.price_value?.trim() ? res.price_value.trim() : null, inReport: v.inReport, typeCheck: v.typeCheck, typeOverride: override };
}

/** Остання ручна позначка типу для дзвінка — латеральним підзапитом (`alias` — таблиця з `uniqueid`). */
const overrideJoin = (alias: string): string => `LEFT JOIN LATERAL (SELECT o.is_cargo AS ov_is_cargo, o.set_by_name AS ov_by, o.set_at AS ov_at
      FROM call_type_overrides o WHERE o.uniqueid = ${alias}.uniqueid ORDER BY o.set_at DESC, o.id DESC LIMIT 1) ov ON true`;

/** Обіцянки менеджера з полями строку (рубрика first-touch-v1); без полів — не рахуються. */
function managerPromisesOf(res: AnalysisResult): ModelPromise[] {
  return res.promises.filter((p) => p.who === "manager" && p.channel && p.deadline_kind)
    .map((p) => ({ who: "manager", what: p.what, deadline_text: p.deadline_text, channel: p.channel!, deadline_kind: p.deadline_kind!,
      deadline_minutes: p.deadline_minutes ?? 0, deadline_date: p.deadline_date ?? "", conditional: p.conditional === true }));
}

/** Кінець розмови: початок + розмова. Від нього рахується термін і шукаються наші дзвінки. */
const callEndOf = (calledAt: string, billsec: number): Date => new Date(Date.parse(calledAt) + billsec * 1000);

/**
 * До якої миті дзвінки Ringostat уже в базі: остання успішна синхронізація, але не пізніше «зараз».
 * Синку ще не було — відомо лише «зараз» мінус нічого, тож беремо найраніше з двох (чесно: менше, ніж знаємо).
 */
async function callsKnownUntil(db: Db, now: Date): Promise<Date> {
  const r = await db.query<{ at: Date | null }>("SELECT last_success_at AS at FROM job_runs WHERE name = 'syncRingostatCalls'");
  const at = r.rows[0]?.at ? new Date(r.rows[0].at) : null;
  return at && at.getTime() < now.getTime() ? at : now;
}

/** Дзвінки на номери рядків від найранішої розмови — ОДНИМ запитом, а не по запиту на рядок. */
async function callsByPhone(db: Db, phones: readonly string[], since: Date): Promise<Map<string, (CallFact & { managerName: string | null })[]>> {
  const out = new Map<string, (CallFact & { managerName: string | null })[]>();
  if (!phones.length) return out;
  const r = await db.query<{ client_phone: string; calldate: Date; billsec: number; call_type: string; manager_id: number | null; manager_name: string | null }>(
    `SELECT rc.client_phone, rc.calldate, rc.billsec, rc.call_type, rc.manager_id, m.name AS manager_name
       FROM ringostat_calls rc LEFT JOIN managers m ON m.id = rc.manager_id
      WHERE rc.client_phone = ANY($1::text[]) AND rc.calldate >= $2 ORDER BY rc.calldate`, [[...phones], since.toISOString()]);
  for (const x of r.rows) {
    const list = out.get(x.client_phone) ?? [];
    list.push({ at: new Date(x.calldate), billsec: Number(x.billsec), callType: x.call_type,
      managerId: x.manager_id == null ? null : Number(x.manager_id), managerName: x.manager_name });
    out.set(x.client_phone, list);
  }
  return out;
}

/** `deadline` — обіцяне; `countUntil` — до якої миті зараховуємо (мінімальний дедлайн + допуск з «Налаштувань»). */
export interface PromiseCheck { deadline: string; countUntil: string; basis: DeadlineBasis; state: PromiseState }

/** Термін і стан кожної обіцянки менеджера рядка — у порядку `result.promises` (клієнтські → `null`). */
function checkPromises(res: AnalysisResult, calledAt: string, billsec: number, calls: readonly CallFact[], knownUntil: Date,
  promiserId: number | null, t: FirstTouchTunables): (PromiseCheck | null)[] {
  const end = callEndOf(calledAt, billsec);
  const after = calls.filter((c) => c.at.getTime() > end.getTime());
  return res.promises.map((p) => {
    if (p.who !== "manager" || !p.channel || !p.deadline_kind) return null;
    const mp = managerPromisesOf({ ...res, promises: [p] })[0];
    const { deadline, basis } = promiseDeadline(mp, end);
    const until = countingDeadline(deadline, basis, end, t);
    return { deadline: deadline.toISOString(), countUntil: until.toISOString(), basis, state: promiseState(mp, end, until, after, knownUntil, promiserId) };
  });
}

/** Рядок списку — ОДИН ДЗВІНОК: розмова, перша для кількох угод одного клієнта, несе всі ці угоди. */
export type AiCallListRow = Omit<AiCallRow, "kommoId"> & { kommoIds: number[] };

/**
 * Згорнути рядки «угода → перша розмова» в рядки за дзвінком. Одна розмова буває першою відразу для
 * двох угод одного клієнта (заміряно 28.09.2026: 19 дзвінків із 1 100), і тоді список показував її
 * двічі, а шапка рахувала 1 119 «перших розмов» замість 1 100. Порядок — за першою появою дзвінка;
 * угоди — за зростанням, дата створення угоди — найраніша з них.
 */
export function collapseByCall(rows: readonly AiCallRow[]): AiCallListRow[] {
  const byCall = new Map<string, AiCallListRow>();
  for (const r of rows) {
    const seen = byCall.get(r.uniqueid);
    if (seen) {
      if (!seen.kommoIds.includes(r.kommoId)) seen.kommoIds = [...seen.kommoIds, r.kommoId].sort((a, b) => a - b);
      if (r.dealCreatedAt < seen.dealCreatedAt) seen.dealCreatedAt = r.dealCreatedAt;
      // Перший вихідний рахується від створення угоди; найраніша угода дає найраніший — беремо мінімум.
      if (r.firstOutboundAt && (!seen.firstOutboundAt || r.firstOutboundAt < seen.firstOutboundAt)) seen.firstOutboundAt = r.firstOutboundAt;
      if (r.silentBeforeClose === true || (seen.silentBeforeClose == null && r.silentBeforeClose === false)) seen.silentBeforeClose = r.silentBeforeClose;
      continue;
    }
    const { kommoId, ...rest } = r;
    byCall.set(r.uniqueid, { ...rest, kommoIds: [kommoId] });
  }
  return [...byCall.values()];
}

/** Межа вибірки екрана. Більший період обрізається й це видно (`truncated`), а не мовчить. */
export const SCREEN_LIMIT = 5000;

/**
 * Список за період. Скоуп — `missedScopeFor` (той самий кламп, що в «Пропущених дзвінках»):
 * менеджер → лише свої (`-1`, якщо не привʼязаний — порожній скоуп НЕ нуль), тімлід → своя команда;
 * дзвінок без відомого менеджера бачить лише компанійна роль.
 */
export async function aiCallsList(db: Db, ad: AdPredicate, from: string, to: string, now: Date, scope: MissedScope):
  Promise<{ rows: AiCallListRow[]; truncated: boolean }> {
  const tun = await loadTunables(db);
  const q = adDealFirstTalksSql({ from, to, now, talkMinSec: FIRST_TOUCH_RULE.talkMinSec, windowBefore: FIRST_TOUCH_RULE.windowBefore,
    adDealPredicate: ad.predicate, adSources: ad.adSources }, FIRST_TOUCH_RULE.flag, SCREEN_LIMIT);
  const sql = `
    SELECT ft.kommo_id, ft.uniqueid, ft.calldate, ft.call_type, ft.billsec, ft.created_at,
           ft.manager_id, m.name AS manager_name, m.team_id, tm.name AS team_name,
           t.status AS stt_status, t.failure AS stt_failure,
           a.status AS llm_status, a.failure AS llm_failure, a.result,
           rcx.client_phone, d.pipeline_id, d.reject_reason,
           (t.status = 'done' AND jsonb_array_length(COALESCE(t.segments, '[]'::jsonb)) = 0) AS stt_empty,
           ov.ov_is_cargo, ov.ov_by, ov.ov_at, ${NOTE_COLS},
           (SELECT min(e.calldate) FROM ringostat_calls e WHERE rcx.client_phone IS NOT NULL AND e.client_phone = rcx.client_phone
               AND e.call_type = ANY($15::text[]) AND e.calldate >= ft.created_at) AS first_out_at
      FROM (${q.sql}) ft
      LEFT JOIN ringostat_calls rcx ON rcx.uniqueid = ft.uniqueid
      LEFT JOIN deals d ON d.kommo_id = ft.kommo_id
      ${overrideJoin("ft")}
      ${notesJoin("ft")}
      LEFT JOIN managers m ON m.id = ft.manager_id
      LEFT JOIN teams tm ON tm.id = m.team_id
      LEFT JOIN call_transcripts t ON t.uniqueid = ft.uniqueid AND t.provider = $8 AND t.model = $9
      LEFT JOIN LATERAL (SELECT ax.status, ax.failure, ax.result FROM call_analyses ax
                  WHERE ax.transcript_id = t.id AND ax.provider = $10 AND ax.model = $11 AND ax.rubric_version = ANY($12::text[])
                  ORDER BY (ax.status = 'done') DESC, array_position($12::text[], ax.rubric_version) LIMIT 1) a ON true
     WHERE ($13::int IS NULL OR ft.manager_id = $13)
       AND ($14::int IS NULL OR m.team_id = $14)
       AND ${firstTouchExclusionSql("ft", "rcx.client_phone", tun.repeatWindowDays)}
     ORDER BY ft.calldate DESC, ft.kommo_id DESC`;
  const params = [...q.params, STT_PROVIDER, ELEVENLABS_STT_MODEL, LLM_PROVIDER, GEMINI_MODEL, [...FIRST_TOUCH_SHOWN_RUBRICS],
    scope.managerId ?? null, scope.teamId ?? null, [...OUTBOUND_TYPES]];
  const raw = (await db.query<RawRow>(sql, params)).rows;
  const rows = raw.map(foldRow);

  // П4–П7: стан обіцянок — з дзвінків Ringostat на номер після розмови.
  const phoneOf = new Map(raw.map((x) => [x.uniqueid, x.client_phone ?? null]));
  const withPromises = raw.filter((x, i) => rows[i].managerPromises > 0 && x.result && x.client_phone);
  if (withPromises.length) {
    const since = new Date(Math.min(...withPromises.map((x) => new Date(x.calldate).getTime())));
    const calls = await callsByPhone(db, [...new Set(withPromises.map((x) => x.client_phone!))], since);
    const known = await callsKnownUntil(db, now);
    raw.forEach((x, i) => {
      if (rows[i].managerPromises === 0 || !x.result) return;
      const phone = phoneOf.get(x.uniqueid);
      const checks = checkPromises(x.result, rows[i].calledAt, rows[i].billsec, phone ? calls.get(phone) ?? [] : [], known, rows[i].managerId, tun);
      rows[i].promiseState = withOfflineMark(worstPromiseState(checks.filter((c): c is PromiseCheck => c != null).map((c) => c.state)), rows[i].offlineNote != null);
    });
  }

  // П3: тиша перед закриттям — ядром фактів угоди (`adCallFacts`), тими самими параметрами вибірки.
  const factsParams: AdCallFactsParams = { from, to, now, talkMinSec: FIRST_TOUCH_RULE.talkMinSec,
    windowBefore: FIRST_TOUCH_RULE.windowBefore, adDealPredicate: ad.predicate, adSources: ad.adSources };
  const facts = new Map((await adCallFacts(db, factsParams)).map((f) => [f.kommoId, f]));
  for (const r of rows) {
    const f = facts.get(r.kommoId);
    r.silentBeforeClose = f ? silentBeforeClose(f, SILENCE_RULE.minGapHours) : null;
  }
  const out = collapseByCall(rows);
  for (const r of out) { r.reactionMin = reactionMinutes(r.dealCreatedAt, r.firstOutboundAt); r.reactionOffHours = offHours(r.dealCreatedAt); }
  return { rows: out, truncated: raw.length >= SCREEN_LIMIT };
}

export interface AiCallCard {
  row: Omit<AiCallRow, "kommoId" | "dealCreatedAt"> & { kommoIds: number[] };
  result: AnalysisResult | null;
  /** `null` — роль не має права на повний текст (`transcriptHidden`), або розшифровки ще немає. */
  turns: Turn[] | null;
  transcriptHidden: boolean;
  managerChannel: number | null;
  durationSec: number | null;
  /**
   * Запис ОДНИМ каналом (Роман 08.10.2026): `mixed` — голоси не розділено (уся розмова однією реплікою, підпис
   * «Менеджер» був би неправдою); `voices` — розділено за ГОЛОСОМ (може плутати, хто є хто); `null` — стерео.
   */
  mono: MonoKind | null;
  /** Перший наш ВИХІДНИЙ дзвінок на цей номер після розмови — факт Ringostat, не оцінка моделі. */
  nextOutboundAt: string | null;
  /** Термін і стан кожної обіцянки — у порядку `result.promises`; обіцянки клієнта → `null`. */
  promiseChecks: (PromiseCheck | null)[];
  /** Журнал ручних змін типу — від найновішої; діє перша. */
  typeHistory: { isCargo: boolean; byName: string | null; at: string }[];
  /** Дзвінки на номер після розмови (до 12, за 7 днів) — щоб стан обіцянки можна було перевірити очима. */
  callsAfter: { at: string; billsec: number; direction: "in" | "out"; managerName: string | null; byPromiser: boolean }[];
}

/**
 * Картка одного дзвінка. Скоуп перевіряється ТИМ САМИМ фільтром, що й у списку: чужий дзвінок
 * повертає `null` (роут віддасть 404), а не порожню картку — інакше існування чужої розмови
 * просочувалось би відповіддю.
 */
export type MonoKind = "mixed" | "voices";

/** Моно-запис: скільки «каналів» у репліках — 1 → голоси змішані, ≥2 → розділені за голосом. Стерео чи невідомо → null. */
export function monoKind(audioChannels: number | null, segments: readonly { channel: number }[] | null): MonoKind | null {
  if (audioChannels !== 1) return null;
  return new Set((segments ?? []).map((s) => s.channel)).size >= 2 ? "voices" : "mixed";
}

export async function aiCallCard(db: Db, uniqueid: string, canSeeTranscript: boolean, scope: MissedScope): Promise<AiCallCard | null> {
  const r = await db.query<RawRow & { segments: Turn[] | null; duration_sec: string | null; client_phone: string | null; audio_channels: number | null }>(`
    SELECT rc.uniqueid, rc.calldate, rc.call_type, rc.billsec, rc.calldate AS created_at, 0 AS kommo_id,
           rc.manager_id, m.name AS manager_name, m.team_id, tm.name AS team_name, rc.client_phone,
           t.status AS stt_status, t.failure AS stt_failure, t.segments, t.duration_sec, t.channels AS audio_channels,
           (t.status = 'done' AND jsonb_array_length(COALESCE(t.segments, '[]'::jsonb)) = 0) AS stt_empty,
           ov.ov_is_cargo, ov.ov_by, ov.ov_at, ${NOTE_COLS},
           a.status AS llm_status, a.failure AS llm_failure, a.result
      FROM ringostat_calls rc
      ${overrideJoin("rc")}
      ${notesJoin("rc")}
      LEFT JOIN managers m ON m.id = rc.manager_id
      LEFT JOIN teams tm ON tm.id = m.team_id
      LEFT JOIN call_transcripts t ON t.uniqueid = rc.uniqueid AND t.provider = $2 AND t.model = $3
      LEFT JOIN LATERAL (SELECT ax.status, ax.failure, ax.result FROM call_analyses ax
                  WHERE ax.transcript_id = t.id AND ax.provider = $4 AND ax.model = $5 AND ax.rubric_version = ANY($6::text[])
                  ORDER BY (ax.status = 'done') DESC, array_position($6::text[], ax.rubric_version) LIMIT 1) a ON true
     WHERE rc.uniqueid = $1
       AND ($7::int IS NULL OR rc.manager_id = $7)
       AND ($8::int IS NULL OR m.team_id = $8)
       -- 🚚 Дзвінок на мобільні («Перевізники за розмовою») цією карткою не відкривається: там інші ролі, а
       -- тімлід за прямою адресою прочитав би розмову, якої його вкладка не показує. Виняток — дзвінок, що є
       -- і першою розмовою рекламної угоди (має рекламний аналіз БУДЬ-ЯКОЇ версії рубрики: під час переаналізу
       -- новою рубрикою дзвінок із розбором v1 інакше зник би з картки — спіймав #961 «Перевізників»).
       AND (NOT EXISTS (SELECT 1 FROM carrier_call_deals cd WHERE cd.uniqueid = rc.uniqueid OR cd.first_uniqueid = rc.uniqueid)
            OR EXISTS (SELECT 1 FROM call_analyses ax WHERE ax.transcript_id = t.id AND ax.rubric_version = ANY($9::text[])))`,
  [uniqueid, STT_PROVIDER, ELEVENLABS_STT_MODEL, LLM_PROVIDER, GEMINI_MODEL, [...FIRST_TOUCH_SHOWN_RUBRICS],
    scope.managerId ?? null, scope.teamId ?? null, [...FIRST_TOUCH_RUBRICS]]);
  const raw = r.rows[0];
  if (!raw) return null;
  const row = foldRow(raw);
  const deals = raw.client_phone
    ? (await db.query<{ kommo_id: string }>(
      `SELECT kommo_id::text FROM deals WHERE client_key IS NOT NULL AND '38' || client_key = $1 ORDER BY created_at_kommo DESC LIMIT 5`,
      [raw.client_phone])).rows.map((x) => Number(x.kommo_id))
    : [];
  const next = raw.client_phone
    ? (await db.query<{ at: Date | null }>(
      `SELECT min(calldate) AS at FROM ringostat_calls WHERE client_phone = $1 AND call_type = ANY($2::text[]) AND calldate > $3`,
      [raw.client_phone, [...OUTBOUND_TYPES], raw.calldate])).rows[0]?.at ?? null
    : null;
  const allowed = canSeeTranscript;
  const done = row.state === "done";
  const end = callEndOf(row.calledAt, row.billsec);
  const after = raw.client_phone
    ? (await callsByPhone(db, [raw.client_phone], end)).get(raw.client_phone) ?? [] : [];
  const nowD = new Date();
  const promiseChecks = (done && raw.result ? checkPromises(raw.result, row.calledAt, row.billsec, after, await callsKnownUntil(db, nowD), row.managerId, await loadTunables(db)) : [])
    .map((c) => (c ? { ...c, state: withOfflineMark(c.state, row.offlineNote != null) ?? c.state } : c));
  const callsAfter = after.filter((c) => c.at.getTime() > end.getTime() && c.at.getTime() <= end.getTime() + 7 * 86_400_000)
    .slice(0, 12).map((c) => ({ at: c.at.toISOString(), billsec: c.billsec, direction: IN_TYPES.has(c.callType) ? "in" as const : "out" as const,
      managerName: c.managerName, byPromiser: row.managerId != null && c.managerId === row.managerId }));
  const { kommoId: _k, dealCreatedAt: _d, ...rest } = row;
  const mc = done && raw.result ? raw.result.manager_channel : null;
  return {
    // 🩹 07.10.2026: стан рядка картки — той самий, що в списку (найгірша обіцянка + позначка «поза телефонією»).
    // Без нього `row.promiseState` лишався null з `foldRow`, і в картці НІКОЛИ не зʼявлялись поля «Передзвонив поза
    // телефонією» й «Опрацьовано» (вони показуються за цим станом) — за 6 днів на проді жодної такої позначки.
    row: { ...rest, kommoIds: deals,
      promiseState: withOfflineMark(worstPromiseState(promiseChecks.filter((c): c is PromiseCheck => c != null).map((c) => c.state)), row.offlineNote != null) },
    result: done ? raw.result : null,
    turns: allowed && raw.segments ? raw.segments : null,
    transcriptHidden: !allowed,
    managerChannel: mc === "0" ? 0 : mc === "1" ? 1 : null,
    durationSec: raw.duration_sec == null ? null : Number(raw.duration_sec),
    mono: monoKind(raw.audio_channels, raw.segments),
    nextOutboundAt: next ? new Date(next).toISOString() : null,
    promiseChecks,
    callsAfter,
    typeHistory: (await db.query<{ is_cargo: boolean; set_by_name: string | null; set_at: Date }>(
      "SELECT is_cargo, set_by_name, set_at FROM call_type_overrides WHERE uniqueid = $1 ORDER BY set_at DESC, id DESC LIMIT 20", [uniqueid]))
      .rows.map((x) => ({ isCargo: x.is_cargo === true, byName: x.set_by_name, at: new Date(x.set_at).toISOString() })),
  };
}

export interface AiCallsMeta {
  job: { lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null } | null;
  transcripts: Record<string, number>;
  analyses: Record<string, number>;
  spend: { stt: number; analysis: number };
  caps: { stt: number | null; analysis: number | null };
}

/** Стан конвеєра: останній тік, черга за станами, витрати місяця (Київ) проти стелі. */
export async function aiCallsMeta(db: Db, now: Date, caps: AiCallsMeta["caps"]): Promise<AiCallsMeta> {
  const j = (await db.query<{ last_success_at: Date | null; last_error: string | null; last_error_at: Date | null }>(
    "SELECT last_success_at, last_error, last_error_at FROM job_runs WHERE name = 'callAiJob'")).rows[0];
  const count = async (table: "call_transcripts" | "call_analyses") => {
    const r = await db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM ${table} GROUP BY status`);
    return Object.fromEntries(r.rows.map((x) => [x.status, Number(x.n)]));
  };
  return {
    job: j ? {
      lastSuccessAt: j.last_success_at ? new Date(j.last_success_at).toISOString() : null,
      lastError: j.last_error, lastErrorAt: j.last_error_at ? new Date(j.last_error_at).toISOString() : null,
    } : null,
    transcripts: await count("call_transcripts"),
    analyses: await count("call_analyses"),
    spend: { stt: (await monthSpend(db, STT_PROVIDER, now)).usd, analysis: (await monthSpend(db, LLM_PROVIDER, now)).usd },
    caps,
  };
}

/**
 * Ручна позначка типу (ТЗ 30.09.2026): «Це вантаж» / «Це не вантаж». Лише ДОПИСУЄ рядок журналу — попередні
 * лишаються, і видно, хто й коли змінював. Право й скоуп перевіряє роут ДО виклику.
 */
export async function setCallType(db: Db, uniqueid: string, isCargo: boolean, by: { userId: number | null; name: string | null }, at: Date): Promise<void> {
  await db.query("INSERT INTO call_type_overrides (uniqueid, is_cargo, set_by, set_by_name, set_at) VALUES ($1, $2, $3, $4, $5)",
    [uniqueid, isCargo, by.userId, by.name, at.toISOString()]);
}

export type NoteKind = "price" | "missed" | "offline" | "review";
/** Записати (або замінити) коментар виду `kind`. Порожній текст — прибрати коментар. Право й скоуп — у роуті. */
export async function setCallNote(db: Db, uniqueid: string, kind: NoteKind, text: string, by: { userId: number | null; name: string | null }, at: Date): Promise<void> {
  const t = text.trim();
  if (!t) { await db.query("DELETE FROM first_touch_notes WHERE uniqueid = $1 AND kind = $2", [uniqueid, kind]); return; }
  await db.query(`INSERT INTO first_touch_notes (uniqueid, kind, note, set_by, set_by_name, set_at) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (uniqueid, kind) DO UPDATE SET note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_by_name = EXCLUDED.set_by_name, set_at = EXCLUDED.set_at`,
  [uniqueid, kind, t, by.userId, by.name, at.toISOString()]);
}

/** Байти запису розмови з Ringostat — та сама політика повторів і стеля розміру, що й у розпізнаванні. */
export async function fetchCallRecording(url: string | null): Promise<DownloadOutcome> {
  return downloadRecording({ fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), nowMs: () => Date.now() }, url,
    { ...RINGOSTAT_POLICY, maxBytes: RECORDING_MAX_BYTES });
}
