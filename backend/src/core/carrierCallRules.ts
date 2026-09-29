import { normForQuote, type GeminiOutcome, type Turn } from "./callAiProviders.js";

/**
 * 🚚 ПЕРЕВІЗНИКИ ЗА РОЗМОВОЮ — правила й рубрика (ТЗ 29.09.2026 «Перевізники за розмовою», сесія CRM → дашборд).
 *
 * Етап «Дзвінки на мобільні» (Кваліфікація) Ringostat наповнює сам — угода на кожен дзвінок на мобільний
 * менеджера. Фільтр на боці CRM раз на 10 хв прибирає тих, кого знає за списками. Ми слухаємо РЕШТУ:
 * угоди, що й далі стоять на етапі, коли фільтр уже встиг, — і кажемо, хто дзвонив. У Kommo нічого не пишемо.
 *
 * ⚖️ УСІ ЧИСЛА НИЖЧЕ — РІШЕННЯ РОМАНА 29.09.2026, а не налаштування «на око» (METRICS_GLOSSARY §17):
 *   · лише угоди ПІСЛЯ фільтра: «фільтр 100% правильний — прибраних ігноруємо»;
 *   · старт — ті, що висять зараз, далі нові; «зразу після фільтра», а не щогодини;
 *   · розмова від 10 с; коротша або жодної — номер пропускаємо;
 *   · вердикт на НОМЕР діє 30 днів; якщо першу розмову не розібрати — слухаємо ще одну, не більше двох;
 *   · окрема стеля мобільних $15/міс усередині спільних; досягнуто — один раз у Telegram;
 *   · текст розмови зберігаємо 12 місяців, далі видаляємо; вердикт і цитата лишаються.
 * «15 хв» — моя пропозиція в плані (фільтр ходить раз на 10 хв + запас), яку Роман прийняв разом із планом.
 */

export const CARRIER_STAGE = { pipelineId: 8921928, statusId: 70419108 } as const;

export const CARRIER_RULE = {
  /** Угода молодша за це — фільтр CRM міг ще не пройти; беремо наступним проходом. */
  minAgeMin: 15,
  talkMinSec: 10,
  /** Дзвінок, що створив угоду, буває на хвилини раніше за саму угоду. */
  windowBeforeMin: 10,
  windowAfterHours: 24,
  reuseDays: 30,
  maxTalks: 2,
  /** Скільки днів дзвінки мобільних тримаються в черзі під нашою межею (і не прибираються годинною джобою). */
  keepDays: 30,
  retentionMonths: 12,
} as const;

export const CARRIER_BUDGET = { monthCapUsd: 15, opPrefix: "carrier_", label: "мобільні" } as const;

/** Мітки в журналі витрат: усі з префіксом `carrier_`, тож додаткова стеля бачить їх разом. */
export const CARRIER_OPS = {
  stt: "carrier_stt",
  analysis: "carrier_analysis",
  pilotStt: "carrier_pilot_stt",
  pilotAnalysis: "carrier_pilot_analysis",
} as const;

/** Поріг, з якого вердикт вважається впевненим (ТЗ, крок 3; поріг для АВТОМАТИЧНИХ дій у CRM — окремо, Сергій). */
export const CARRIER_THRESHOLD = 0.85;

export const RUBRIC_CARRIER_V1 = "carrier-v1";

/**
 * Номер з назви угоди. Ringostat називає угоду номером того, хто дзвонив (`380XXXXXXXXX`) — так само
 * `ringostat_calls.client_phone`. Заміряно 29.09.2026: назва-номер у 1 052 угод етапу за два тижні,
 * у 938 збігається з номером контакту. Інша назва — угоду вже переназвали руками, номер невідомий: пропускаємо.
 */
export function phoneFromDealName(name: string | null | undefined): string | null {
  const s = (name ?? "").trim();
  return /^380\d{9}$/.test(s) ? s : null;
}

/** Чи встиг фільтр CRM: угода старша за `minAgeMin`. Час створення Kommo — секунди UNIX. */
export function oldEnough(createdAtSec: number, now: Date, minAgeMin: number = CARRIER_RULE.minAgeMin): boolean {
  return Number.isFinite(createdAtSec) && now.getTime() - createdAtSec * 1000 >= minAgeMin * 60_000;
}

// ─── Рубрика carrier-v1 ─────────────────────────────────────────────────────

export type CallerRole = "client" | "carrier" | "other" | "unclear";

export const CARRIER_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "1–2 речення: хто дзвонив і навіщо" },
    manager_channel: { type: "string", enum: ["0", "1", "unknown"], description: "номер каналу менеджера UTS, визначений зі змісту" },
    caller_role: { type: "string", enum: ["client", "carrier", "other", "unclear"], description: "хто співрозмовник менеджера" },
    caller_role_confidence: { type: "number", description: "впевненість від 0 до 1" },
    caller_role_quote: { type: "string", description: "дослівний уривок зі слів СПІВРОЗМОВНИКА (не менеджера), на підставі якого вирішено; немає — порожньо" },
  },
  required: ["summary", "manager_channel", "caller_role", "caller_role_confidence", "caller_role_quote"],
} as const;

export const CARRIER_SYSTEM_PROMPT = [
  "Ти отримуєш автоматичну розшифровку телефонної розмови менеджера логістичної компанії UTS.",
  "Людина подзвонила менеджеру на мобільний. Треба визначити, ХТО це: клієнт, перевізник чи хтось інший.",
  "Розшифровку зроблено по двох каналах запису; кожен рядок — час від початку розмови, номер каналу і текст.",
  "Хто з каналів менеджер UTS — визнач зі змісту розмови.",
  "caller_role:",
  "  carrier — у співрозмовника є транспорт і він шукає вантаж, пропонує перевезення чи свою машину, питає про оплату за вже виконаний рейс; водій шукає роботу на своїй машині.",
  "  client — йому треба щось перевезти: шукає машину, питає ціну чи умови перевезення. Якщо людина і сама возить, і просить перевезти («возимо самі, але на Молдову машин нема — порахуйте») — це client: він просить перевезти.",
  "  other — розмова не про перевезення: реклама, опитування, вакансії не на своїй машині, помилка номера, кур'єрська доставка.",
  "  unclear — розмова обірвалась, не чути, розмови по суті немає.",
  "Правила:",
  "1. Вирішуй лише за тим, що прямо сказано. Нічого не домислюй.",
  "2. caller_role_quote — дослівний уривок зі слів СПІВРОЗМОВНИКА (не менеджера), без часу й номера каналу. Немає такого уривка — порожній рядок.",
  "3. caller_role_confidence — наскільки ти впевнений, від 0 до 1. Для unclear — не більше 0.5.",
  "4. Пиши українською.",
].join("\n");

const mmss = (sec: number | null): string => {
  if (sec == null) return "--:--";
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function buildCarrierRequest(turns: readonly Turn[], maxOutputTokens: number): Record<string, unknown> {
  const text = turns.map((t) => `[${mmss(t.start)}] Канал ${String(t.channel)}: ${t.text}`).join("\n");
  return {
    system_instruction: { parts: [{ text: CARRIER_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: CARRIER_SCHEMA } },
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens,
    },
  };
}

/**
 * Де знайдено цитату. Лише `counterpart` підтверджує вердикт: ТЗ вимагає слів СПІВРОЗМОВНИКА, і фраза
 * менеджера «ви ж перевізник?» не доводить нічого. `side_unknown` — модель не змогла сказати, хто менеджер,
 * тож і бік цитати невідомий; це не підтвердження.
 */
export type QuoteCheck = "counterpart" | "manager" | "absent" | "empty" | "side_unknown";

export interface CarrierResult {
  summary: string;
  manager_channel: "0" | "1" | "unknown";
  caller_role: CallerRole;
  caller_role_confidence: number;
  caller_role_quote: string;
  quote_check?: QuoteCheck;
}

const ROLES: readonly string[] = ["client", "carrier", "other", "unclear"];

export function validateCarrier(x: unknown): { ok: true; value: CarrierResult } | { ok: false; why: string } {
  if (!x || typeof x !== "object") return { ok: false, why: "не обʼєкт" };
  const o = x as Record<string, unknown>;
  for (const k of ["summary", "caller_role_quote"]) if (typeof o[k] !== "string") return { ok: false, why: `поле ${k} не рядок` };
  if (!["0", "1", "unknown"].includes(o.manager_channel as string)) return { ok: false, why: "manager_channel поза переліком" };
  if (!ROLES.includes(o.caller_role as string)) return { ok: false, why: "caller_role поза переліком" };
  const c = o.caller_role_confidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) return { ok: false, why: "caller_role_confidence не число 0..1" };
  return { ok: true, value: o as unknown as CarrierResult };
}

/** Шукаємо цитату по каналах окремо (урок `verifyQuotes`: склейка каналів ламає справжні цитати). */
export function checkCarrierQuote(r: CarrierResult, turns: readonly Turn[]): QuoteCheck {
  const n = normForQuote(r.caller_role_quote);
  if (!n) return "empty";
  const byChannel = new Map<number, string>();
  for (const t of turns) byChannel.set(t.channel, `${byChannel.get(t.channel) ?? ""} ${t.text}`);
  const hit = new Set<number>();
  for (const [ch, text] of byChannel) if (` ${normForQuote(text)} `.includes(` ${n} `)) hit.add(ch);
  if (!hit.size) return "absent";
  if (r.manager_channel === "unknown") return "side_unknown";
  const mgr = Number(r.manager_channel);
  return [...hit].some((ch) => ch !== mgr) ? "counterpart" : "manager";
}

export function interpretCarrier(out: GeminiOutcome, turns: readonly Turn[]): { ok: true; result: CarrierResult } | { ok: false; why: string } {
  if (out.blockReason) return { ok: false, why: `запит заблоковано постачальником: ${out.blockReason}` };
  if (out.finishReason && out.finishReason !== "STOP") return { ok: false, why: `модель не завершила відповідь: ${out.finishReason}` };
  if (!out.text) return { ok: false, why: "модель повернула порожню відповідь" };
  let parsed: unknown;
  try { parsed = JSON.parse(out.text); } catch { return { ok: false, why: "відповідь моделі не JSON" }; }
  const v = validateCarrier(parsed);
  if (!v.ok) return { ok: false, why: `відповідь моделі не за схемою: ${v.why}` };
  return { ok: true, result: { ...v.value, quote_check: checkCarrierQuote(v.value, turns) } };
}

export const CARRIER_KIT = {
  build: (turns: readonly Turn[], maxOutputTokens: number) => buildCarrierRequest(turns, maxOutputTokens),
  interpret: interpretCarrier,
};

/**
 * Кошик на екрані. Роль клієнт/перевізник показуємо впевненою лише з порогом І підтвердженою цитатою
 * співрозмовника; інакше — «нижче порогу». «Інше» цитати не вимагає: там нема що доводити.
 */
export type CarrierBucket = CallerRole | "low";

export function carrierBucket(r: Pick<CarrierResult, "caller_role" | "caller_role_confidence" | "quote_check">,
  threshold: number = CARRIER_THRESHOLD): CarrierBucket {
  if (r.caller_role === "unclear") return "unclear";
  if (r.caller_role_confidence < threshold) return "low";
  if (r.caller_role !== "other" && r.quote_check !== "counterpart") return "low";
  return r.caller_role;
}
