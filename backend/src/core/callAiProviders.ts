import { fetchWithRetry, VendorError, type HttpDeps, type RetryPolicy } from "./callAiHttp.js";

/**
 * 🤖 АДАПТЕРИ ПОСТАЧАЛЬНИКІВ: розпізнавання (ElevenLabs Scribe v2, по каналах) і аналіз
 * (Google Gemini 3.8 Flash). Рішення власника 22.09.2026, бюджет ~$50/міс.
 *
 * ТЗ «AI-аналіз дзвінків по рекламних лідах», прохід A, коміт ③.
 *
 * 📐 КОНТРАКТИ ЗВІРЕНО З ОФІЦІЙНОЮ ДОКУМЕНТАЦІЄЮ 22.09.2026 (читання сторінок, жодного виклику).
 * Те, що документація лишила суперечливим, тут обробляється в ОБИДВА боки, а не вгадується:
 *   • ElevenLabs: канал слова береться з `words[].channel_index` — у прикладі відповіді верхнього
 *     `channel_index` у транскрипті немає; верхній — лише запасний шлях, далі позиція в масиві;
 *   • ElevenLabs: моно-файл при `use_multi_channel=true` приходить ОДНОКАНАЛЬНОЮ формою;
 *   • Gemini: `responseFormat.text.{mimeType: "APPLICATION_JSON", schema}` — чинний шлях (старі `responseSchema` /
 *     `_responseJsonSchema` позначені deprecated); `thinkingLevel` рядком `low`, як у REST-прикладі
 *     (`minimal` на 3.8 Flash — помилка); `temperature` НЕ шлемо (для Gemini 3.x — «remove»).
 * ✅ ПЕРЕВІРЕНО ЖИВИМ API 28.09.2026: `mimeType` приймається лише переліком `APPLICATION_JSON` (рядок
 *   `application/json` — 400); `thinkingLevel` приймається і `low`, і `LOW`; Scribe v2 бере WAV 8 кГц стерео.
 *
 * 🔒 Ключ приходить ПАРАМЕТРОМ і їде ЛИШЕ заголовком (`xi-api-key` / `x-goog-api-key`), не в URL.
 */

// ─── ElevenLabs Speech to Text ──────────────────────────────────────────────

export const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
export const ELEVENLABS_STT_MODEL = "scribe_v2";

/**
 * Поля форми. `use_multi_channel` — кожен канал стерео окремо (менеджер і клієнт не змішуються);
 * `diarize=false` — обовʼязково для multichannel. Мова — автовизначення: розмови бувають і
 * українською, і російською, а примусова мова зіпсувала б другу.
 */
export const STT_FORM_FIELDS: Readonly<Record<string, string>> = {
  model_id: ELEVENLABS_STT_MODEL,
  use_multi_channel: "true",
  diarize: "false",
  timestamps_granularity: "word",
  tag_audio_events: "false",
};

/**
 * 🎙 МОНО-ЗАПИС (Роман 08.10.2026, «чому тут немає каналів»): ~5% записів Ringostat віддає ОДНИМ каналом — обидва
 * голоси змішані, і `use_multi_channel` повертав усю розмову однією реплікою. Для такого файла — розділення за
 * ГОЛОСОМ (`diarize`, рівно два мовці): мовець стає «каналом» 0/1, а хто з них менеджер — модель визначає зі змісту,
 * як і для стерео. Голос плутається частіше за канал, тому екран підписує такий запис окремо.
 */
export const STT_MONO_FORM_FIELDS: Readonly<Record<string, string>> = {
  model_id: ELEVENLABS_STT_MODEL,
  use_multi_channel: "false",
  diarize: "true",
  num_speakers: "2",
  timestamps_granularity: "word",
  tag_audio_events: "false",
};

/** `speaker_3` → 3; що інше — null. */
function speakerIndex(v: unknown): number | null {
  const m = typeof v === "string" ? /^speaker_(\d+)$/.exec(v) : null;
  return m ? Number(m[1]) : null;
}

export interface SttWord { start: number | null; end: number | null; text: string; channel: number }
export interface SttChannel { index: number; language: string | null; words: SttWord[] }
export interface SttResult {
  channels: SttChannel[];
  /** Як назвав постачальник; для multichannel — «across all channels», тобто НЕ обовʼязково оплачене. */
  audioDurationSec: number | null;
  transcriptionId: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Розбір відповіді: і `transcripts[]` (multichannel), і плоска форма (моно / одноканальна). */
export function parseSttResponse(json: unknown): SttResult {
  if (!json || typeof json !== "object") throw new VendorError("ElevenLabs", "bad_response", null, "тіло не є обʼєктом");
  const o = json as Record<string, unknown>;
  const parts: { t: Record<string, unknown>; pos: number }[] = Array.isArray(o.transcripts)
    ? (o.transcripts as unknown[]).map((t, pos) => ({ t: (t ?? {}) as Record<string, unknown>, pos }))
    : Array.isArray(o.words) ? [{ t: o, pos: 0 }] : [];
  if (!parts.length) {
    const asyncShape = typeof o.request_id === "string" && typeof o.message === "string";
    throw new VendorError("ElevenLabs", "bad_response", null,
      asyncShape ? "прийшла асинхронна відповідь без розшифровки" : "немає ні transcripts, ні words");
  }
  const byChannel = new Map<number, SttChannel>();
  for (const { t, pos } of parts) {
    const fallback = num(t.channel_index) ?? pos;
    const lang = str(t.language_code);
    const words = Array.isArray(t.words) ? (t.words as Record<string, unknown>[]) : [];
    for (const w of words) {
      const type = str(w?.type);
      if (type && type !== "word") continue; // spacing / audio_event — не слова
      const text = str(w?.text)?.trim();
      if (!text) continue;
      const channel = num(w.channel_index) ?? speakerIndex(w.speaker_id) ?? fallback;
      let ch = byChannel.get(channel);
      if (!ch) { ch = { index: channel, language: lang, words: [] }; byChannel.set(channel, ch); }
      ch.words.push({ start: num(w.start), end: num(w.end), text, channel });
    }
    if (!words.length && !byChannel.has(fallback)) byChannel.set(fallback, { index: fallback, language: lang, words: [] });
  }
  return {
    channels: [...byChannel.values()].sort((a, b) => a.index - b.index),
    audioDurationSec: num(o.audio_duration_secs),
    transcriptionId: str(o.transcription_id),
  };
}

export interface Turn { channel: number; start: number | null; end: number | null; text: string; lang: string | null }

/**
 * Слова обох каналів → репліки в порядку часу. Сусідні слова одного каналу — одна репліка.
 * Порогу паузи тут немає свідомо: репліка закінчується, коли заговорив ІНШИЙ канал, — це факт
 * запису, а не налаштування. Слово без часу стає за попереднім словом свого каналу.
 */
export function toTurns(r: SttResult): Turn[] {
  const flat: { t: number; order: number; w: SttWord; lang: string | null }[] = [];
  let order = 0;
  for (const ch of r.channels) {
    let prev = 0;
    for (const w of ch.words) {
      const t = w.start ?? prev;
      prev = t;
      flat.push({ t, order: order++, w, lang: ch.language });
    }
  }
  flat.sort((a, b) => a.t - b.t || a.w.channel - b.w.channel || a.order - b.order);
  const turns: Turn[] = [];
  for (const { w, lang } of flat) {
    const last = turns[turns.length - 1];
    if (last && last.channel === w.channel) {
      last.text += ` ${w.text}`;
      if (w.end != null) last.end = w.end;
    } else {
      turns.push({ channel: w.channel, start: w.start, end: w.end, text: w.text, lang });
    }
  }
  return turns;
}

export interface SttAudio { bytes: Uint8Array; contentType: string }

export async function elevenLabsTranscribe(deps: HttpDeps, apiKey: string, audio: SttAudio, policy: RetryPolicy,
  opts: { mono?: boolean } = {}): Promise<SttResult> {
  const fields = opts.mono ? STT_MONO_FORM_FIELDS : STT_FORM_FIELDS;
  const init = (): RequestInit => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("file", new Blob([audio.bytes.slice()], { type: audio.contentType }), "call.wav");
    return { method: "POST", headers: { "xi-api-key": apiKey }, body: fd };
  };
  const res = await fetchWithRetry(deps, { vendor: "ElevenLabs", url: ELEVENLABS_STT_URL, init, secrets: [apiKey] }, policy);
  let json: unknown;
  try { json = await res.json(); } catch { throw new VendorError("ElevenLabs", "bad_response", res.status, "тіло не JSON"); }
  return parseSttResponse(json);
}

// ─── Gemini: аналіз розшифровки ─────────────────────────────────────────────

export const GEMINI_MODEL = "gemini-3.8-flash";
export const geminiGenerateUrl = (model: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

/**
 * Рубрика ПІЛОТА: лише ВИТЯГ фактів із розмови з дослівними цитатами — ціна, заперечення,
 * обіцянки, наступний крок. Оцінки немає: критеріїв і калібрування власник ще не затвердив
 * (ТЗ: «не вводимо оцінку 1–10 без критеріїв»). Нова рубрика = нова версія = новий рядок.
 * Хто з каналів менеджер — модель визначає зі змісту, а пілот звіряє на слух: у CRM і в
 * Ringostat цього факту немає (ВІДКРИТЕ ПИТАННЯ, заміряється пілотом).
 */
export const RUBRIC_PILOT_V0 = "pilot-v0";

/**
 * Рубрика «ОБІЦЯВ І НЕ ПЕРЕДЗВОНИВ» (рішення Романа 29.09.2026, П4–П7): до обіцянки додано канал,
 * вид і величину строку, умовність. Модель лише ЧИТАЄ слова; термін рахує `core/callAiPromise.ts`,
 * виконання — дзвінки Ringostat. Нова рубрика — нові рядки аналізу, старі `pilot-v0` лишаються.
 */
export const RUBRIC_FIRST_TOUCH_V1 = "first-touch-v1";
/** Рубрика, яку зараз ганяє джоба і показує екран. */
/**
 * Рубрика з ТИПОМ РОЗМОВИ (ТЗ «звіт тімліда» 30.09.2026): модель каже, чи це запит на перевезення, чи сміття
 * (перевізник, продавець, пошук роботи, помилка номером, розмови немає, інше), з упевненістю й причиною. Решта
 * полів — як у v1. Рішення «у звіт чи у Виключені» — не модель, а `core/callAiType.ts`.
 */
export const RUBRIC_FIRST_TOUCH_V2 = "first-touch-v2";
/**
 * Рубрика з ВТРАЧЕНИМ ЛІДОМ (рішення власника 05.10.2026 після перегляду «Виключених»): новий тип `lead_lost` —
 * клієнт звертався по перевезення, але запит уже неактуальний (вирішив сам, пішов до інших). Він у звіті, окремою
 * колонкою. Ще два правила: домовленість передзвонити чи підтверджена актуальність — це запит, навіть без деталей;
 * розмитнення — наша послуга, тобто запит. Решта полів — як у v2.
 */
export const RUBRIC_FIRST_TOUCH_V3 = "first-touch-v3";
/**
 * Рубрика «НЕЗРУЧНО ГОВОРИТИ — ПРОСИВ ПЕРЕДЗВОНИТИ» (рішення Романа 09.10.2026): тип `call_later` і поле
 * `callback_request` — клієнт сам попросив передзвонити пізніше. Прохання стає обовʼязком менеджера (строк — названий
 * клієнтом або кінець наступного робочого дня, `core/callAiPromise.ts`), а запит і ціна в такій розмові не рахуються.
 * 🔴 ЛИШЕ ДЛЯ НОВИХ РОЗМОВ: джоба ставить v4 у чергу тільки тим розшифровкам, яких v2/v3 ще не розібрали
 * (`transcriptsWithoutShown`), — старі розбори не переписуються, і старі цифри не зсуваються. Окремі старі розмови —
 * лише явним запуском (`tools/firstTouchReanalyze`).
 */
export const RUBRIC_FIRST_TOUCH_V4 = "first-touch-v4";
export const RUBRIC_CURRENT = RUBRIC_FIRST_TOUCH_V4;
/** Попередні рубрики з типом розмови: розмова, вже розібрана будь-якою з них, автоматично v4 не отримує. */
export const FIRST_TOUCH_LEGACY_TYPED: readonly string[] = [RUBRIC_FIRST_TOUCH_V3, RUBRIC_FIRST_TOUCH_V2];
/** Усі версії рубрики «Першого дотику» — «дзвінок має рекламний розбір» не залежить від того, чи вже переаналізовано. */
export const FIRST_TOUCH_RUBRICS: readonly string[] = [RUBRIC_PILOT_V0, RUBRIC_FIRST_TOUCH_V1, RUBRIC_FIRST_TOUCH_V2, RUBRIC_FIRST_TOUCH_V3, RUBRIC_FIRST_TOUCH_V4];
/**
 * Що показувати, поки розмову не переаналізовано новою рубрикою: поточна, а якщо її ще немає — попередня з типом
 * розмови (v2). Без цього після зміни рубрики список годину показував би «у черзі» замість наявного розбору.
 */
export const FIRST_TOUCH_SHOWN_RUBRICS: readonly string[] = [RUBRIC_FIRST_TOUCH_V4, RUBRIC_FIRST_TOUCH_V3, RUBRIC_FIRST_TOUCH_V2];

/** Типи розмови (ТЗ 30.09.2026; `lead_lost` — 05.10.2026). У звіт ідуть `cargo_request` і `lead_lost`; решта — у «Виключені». */
export const CONVERSATION_TYPES = ["cargo_request", "lead_lost", "call_later", "carrier", "vendor", "job_seeker", "wrong_number", "no_dialog", "other"] as const;
export type ConversationType = typeof CONVERSATION_TYPES[number];

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2–3 речення: про що розмова" },
    manager_channel: { type: "string", enum: ["0", "1", "unknown"], description: "номер каналу менеджера UTS, визначений зі змісту" },
    client_request: { type: "string", description: "що клієнт хоче перевезти або замовити; порожньо, якщо не прозвучало" },
    price: {
      type: "object",
      properties: {
        discussed: { type: "boolean", description: "true — лише якщо МЕНЕДЖЕР назвав клієнту суму чи діапазон за це перевезення (правило 9)" },
        quote: { type: "string", description: "дослівно, як менеджер назвав ціну; порожньо, якщо не назвав" },
      },
      required: ["discussed", "quote"],
    },
    objections: {
      type: "array",
      items: { type: "object", properties: { what: { type: "string" }, quote: { type: "string" } }, required: ["what", "quote"] },
    },
    promises: {
      type: "array",
      items: {
        type: "object",
        properties: {
          who: { type: "string", enum: ["manager", "client"] },
          what: { type: "string" },
          deadline_text: { type: "string", description: "строк дослівно, як прозвучав; порожньо, якщо строку не було" },
          quote: { type: "string" },
          channel: { type: "string", enum: ["call", "message", "other"], description: "як виконати: call — зателефонувати; message — надіслати у Viber, Telegram, WhatsApp, SMS чи пошту; other — інше" },
          deadline_kind: { type: "string", enum: ["minutes", "day", "none"], description: "minutes — названо тривалість або годину сьогодні; day — названо день; none — часу не названо" },
          deadline_minutes: { type: "integer", description: "для minutes — хвилин від кінця розмови; інакше 0" },
          deadline_date: { type: "string", description: "для day — дата YYYY-MM-DD, обчислена від дати розмови; інакше порожньо" },
          conditional: { type: "boolean", description: "true, якщо обіцянка залежить від події («як знайду авто», «як буде пропозиція»)" },
        },
        required: ["who", "what", "deadline_text", "quote", "channel", "deadline_kind", "deadline_minutes", "deadline_date", "conditional"],
      },
    },
    next_step: { type: "string" },
    conversation_type: { type: "string", enum: [...CONVERSATION_TYPES], description: "тип розмови за правилом 7" },
    type_confidence: { type: "number", description: "упевненість у типі від 0 до 1" },
    type_reason: { type: "string", description: "одне речення: чому саме цей тип" },
    price_value: { type: "string", description: "названа ціна дослівно з валютою («18000 грн»); порожньо, якщо суми не прозвучало" },
    callback_request: {
      type: "object",
      description: "правило 10: клієнт сам попросив передзвонити йому пізніше",
      properties: {
        asked: { type: "boolean", description: "true — клієнт попросив передзвонити пізніше («зараз незручно», «потім наберіть», «я на роботі»)" },
        quote: { type: "string", description: "дослівні слова клієнта; порожньо, якщо прохання не було" },
        deadline_text: { type: "string", description: "час, який назвав клієнт, дослівно; порожньо, якщо не назвав" },
        deadline_kind: { type: "string", enum: ["minutes", "day", "none"], description: "як у правилі 6; none — час не названо («пізніше», «потім»)" },
        deadline_minutes: { type: "integer", description: "для minutes — хвилин від кінця розмови; інакше 0" },
        deadline_date: { type: "string", description: "для day — дата YYYY-MM-DD від дати розмови; інакше порожньо" },
      },
      required: ["asked", "quote", "deadline_text", "deadline_kind", "deadline_minutes", "deadline_date"],
    },
  },
  required: ["summary", "manager_channel", "client_request", "price", "objections", "promises", "next_step",
    "conversation_type", "type_confidence", "type_reason", "price_value", "callback_request"],
} as const;

export const ANALYSIS_SYSTEM_PROMPT = [
  "Ти отримуєш автоматичну розшифровку телефонної розмови менеджера з продажу логістичної компанії UTS із клієнтом.",
  "Розшифровку зроблено по двох каналах запису; кожен рядок — час від початку розмови, номер каналу і текст.",
  "Хто з каналів менеджер — визнач зі змісту розмови.",
  "Правила:",
  "1. Витягуй лише те, що прямо сказано в розмові. Нічого не домислюй.",
  "2. Не оцінюй менеджера і не давай порад.",
  "3. Поле quote — дослівний уривок із розшифровки (без часу й номера каналу), не переказ. Немає дослівного уривка — не додавай пункт.",
  "4. Чого в розмові немає — порожній рядок або порожній масив.",
  "5. Пиши українською.",
  "6. Обіцянка — будь-яке «повернусь до вас»: передзвоню, наберу, скину ціну, пошукаю авто, уточню, зокрема умовне («як знайду авто — наберу»). Для кожної:",
  "   channel: call — зателефонувати чи передзвонити; message — надіслати у Viber, Telegram, WhatsApp, SMS чи на пошту; other — інше.",
  "   deadline_kind: minutes — названо тривалість або годину сьогодні («за 20 хвилин», «через півгодини», «о 15:00»); day — названо день («завтра», «в понеділок», «до кінця тижня» — останній робочий день тижня); none — часу не названо («зараз», «одразу», «наберу»).",
  "   deadline_minutes: для minutes — скільки хвилин від кінця розмови (для «о 15:00» — від часу розмови до 15:00); інакше 0.",
  "   deadline_date: для day — дата YYYY-MM-DD, обчислена від дати розмови з першого рядка; інакше порожній рядок.",
  "   conditional: true, якщо виконання залежить від події, а не від часу.",
  "7. conversation_type — тип розмови:",
  "   cargo_request — людина хоче перевезти вантаж. Став його, якщо є ХОЧА Б ОДНА ознака запиту на перевезення: маршрут (звідки-куди), опис вантажу, вага чи обсяг, дата відвантаження, тип авто, питання «скільки коштує перевезти» — навіть якщо клієнт лише уточнював і нічого не домовились. Запит на розмитнення чи митне оформлення вантажу — теж cargo_request: це послуга компанії.",
  "   cargo_request також тоді, коли менеджер домовився передзвонити клієнту або клієнт підтвердив, що його запит актуальний, — навіть без жодних деталей вантажу (крім випадків, коли це явно перевізник, продавець, пошук роботи чи помилка номером).",
  "   lead_lost — клієнт звертався по перевезення (заявка, дзвінок), але тепер каже, що запит уже неактуальний: вирішив сам, знайшов інших, перевезення більше не потрібне. Став lead_lost, навіть якщо менеджер пообіцяв перевірити пізніше.",
  "   call_later — клієнтові зараз незручно говорити, і він просить передзвонити пізніше («я на роботі», «за кермом», «потім наберіть»), а про сам вантаж у розмові нічого не сказано. Якщо клієнт встиг назвати маршрут, вантаж чи дату — це cargo_request, навіть коли він теж попросив передзвонити.",
  "   carrier — перевізник пропонує машину або шукає вантаж; vendor — нам щось продають (акумулятори, пальне, рекламу, послуги); job_seeker — питання про роботу чи вакансію; wrong_number — помилились номером, шукали іншу компанію; no_dialog — автовідповідач, тиша, обрив, розмови по суті немає; other — щось інше, не про перевезення вантажу клієнта.",
  "   Будь-який тип, крім cargo_request, lead_lost і call_later, — ЛИШЕ якщо ознак запиту на перевезення немає зовсім.",
  "   type_confidence — наскільки ти впевнений у типі, від 0 до 1; type_reason — одне речення, чому так.",
  "8. price_value — названа ціна дослівно з валютою; порожньо, якщо конкретної суми не прозвучало.",
  "9. price.discussed = true ЛИШЕ тоді, коли МЕНЕДЖЕР назвав клієнту суму або діапазон за ЦЕ перевезення («буде 38 тисяч», «20–22 тисячі», «4500»). НЕ є озвученою ціною: бюджет, який назвав клієнт («до десяти», «80–85»); питання менеджера про бюджет; «вкладемось у ваш бюджет»; ціна іншого рейсу як орієнтир («з Нікополя вивозили за сто тисяч»); обіцянка порахувати пізніше. У таких випадках discussed = false, а quote і price_value — порожні.",
  "10. callback_request — чи попросив КЛІЄНТ передзвонити йому пізніше. asked = true лише на прохання клієнта («передзвоніть пізніше», «зараз незручно, наберіть потім», «я на роботі, давайте ввечері»); обіцянка менеджера передзвонити — це правило 6, а не 10. quote — дослівні слова клієнта. Час, якщо клієнт його назвав, — у deadline_text, deadline_kind, deadline_minutes і deadline_date за тими самими правилами, що в правилі 6; не назвав — deadline_kind = none. Прохання не було: asked = false, рядки порожні, deadline_kind = none, deadline_minutes = 0.",
].join("\n");

const mmss = (sec: number | null): string => {
  if (sec == null) return "--:--";
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function dialogText(turns: readonly Turn[]): string {
  return turns.map((t) => `[${mmss(t.start)}] Канал ${String(t.channel)}: ${t.text}`).join("\n");
}

/** Перший рядок запиту: коли була розмова — від нього модель рахує «завтра» й «у понеділок». */
export function callDateLine(callAt: Date): string {
  const d = callAt.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const t = callAt.toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
  const wd = callAt.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", weekday: "long" });
  return `Розмова почалась ${d} о ${t} за Києвом, ${wd}.`;
}

export function buildAnalysisRequest(turns: readonly Turn[], maxOutputTokens: number, callAt: Date | null = null): Record<string, unknown> {
  const text = callAt ? `${callDateLine(callAt)}\n\n${dialogText(turns)}` : dialogText(turns);
  return {
    system_instruction: { parts: [{ text: ANALYSIS_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      // Перелік, а не рядок MIME: живий API 28.09.2026 на "application/json" відповів 400
      // «Invalid value at generation_config.response_format.text.mime_type». Правий був довідник, не приклад гайду.
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: ANALYSIS_SCHEMA } },
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens,
    },
  };
}

/**
 * ВЕРХНЯ межа вхідних токенів ДО виклику: байти UTF-8 усього тіла. Токен покриває щонайменше
 * один байт, тож справжнє число не більше — і стеля витрат перевіряється по межі, а не по
 * здогаду «≈3 символи на токен».
 */
export function inputTokenUpperBound(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

export interface GeminiUsage { input: number; output: number; thoughts: number }
export interface GeminiOutcome {
  text: string | null;
  finishReason: string | null;
  blockReason: string | null;
  /** Оплачений вихід = відповідь + думки (прайс: «Output price (including thinking tokens)»). */
  usage: GeminiUsage | null;
}

export function parseGeminiResponse(json: unknown): GeminiOutcome {
  if (!json || typeof json !== "object") throw new VendorError("Gemini", "bad_response", null, "тіло не є обʼєктом");
  const o = json as Record<string, unknown>;
  const um = (o.usageMetadata ?? null) as Record<string, unknown> | null;
  const usage = um ? {
    input: num(um.promptTokenCount) ?? 0,
    output: (num(um.candidatesTokenCount) ?? 0) + (num(um.thoughtsTokenCount) ?? 0),
    thoughts: num(um.thoughtsTokenCount) ?? 0,
  } : null;
  const pf = (o.promptFeedback ?? null) as Record<string, unknown> | null;
  const cand = (Array.isArray(o.candidates) ? o.candidates[0] : null) as Record<string, unknown> | null;
  const parts = ((cand?.content as Record<string, unknown> | undefined)?.parts ?? []) as Record<string, unknown>[];
  const text = parts.filter((p) => p && p.thought !== true && typeof p.text === "string").map((p) => p.text as string).join("");
  return { text: text || null, finishReason: str(cand?.finishReason), blockReason: str(pf?.blockReason), usage };
}

export async function geminiGenerate(deps: HttpDeps, apiKey: string, model: string, body: unknown, policy: RetryPolicy): Promise<GeminiOutcome> {
  const init = (): RequestInit => ({
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await fetchWithRetry(deps, { vendor: "Gemini", url: geminiGenerateUrl(model), init, secrets: [apiKey] }, policy);
  let json: unknown;
  try { json = await res.json(); } catch { throw new VendorError("Gemini", "bad_response", res.status, "тіло не JSON"); }
  return parseGeminiResponse(json);
}

// ─── Результат аналізу: перевірка форми і цитат ─────────────────────────────

export interface AnalysisResult {
  /** Поля рубрики `first-touch-v2`; у рядках v1 і `pilot-v0` їх немає. */
  conversation_type?: ConversationType; type_confidence?: number; type_reason?: string; price_value?: string;
  /** Рубрика `first-touch-v4`: клієнт сам попросив передзвонити. У старіших рядках поля немає. */
  callback_request?: CallbackRequest;
  summary: string;
  manager_channel: "0" | "1" | "unknown";
  client_request: string;
  price: { discussed: boolean; quote: string; quote_found?: boolean | null };
  objections: { what: string; quote: string; quote_found?: boolean | null }[];
  promises: {
    who: "manager" | "client"; what: string; deadline_text: string; quote: string; quote_found?: boolean | null;
    /** Поля рубрики `first-touch-v1`; у рядках `pilot-v0` їх немає. */
    channel?: "call" | "message" | "other"; deadline_kind?: "minutes" | "day" | "none";
    deadline_minutes?: number; deadline_date?: string; conditional?: boolean;
  }[];
  next_step: string;
}

export interface CallbackRequest {
  asked: boolean; quote: string; quote_found?: boolean | null; deadline_text: string;
  deadline_kind: "minutes" | "day" | "none"; deadline_minutes: number; deadline_date: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** Модель зобовʼязалась схемою — але довіряємо не обіцянці, а перевірці. */
export function validateAnalysis(x: unknown): { ok: true; value: AnalysisResult } | { ok: false; why: string } {
  if (!x || typeof x !== "object") return { ok: false, why: "не обʼєкт" };
  const o = x as Record<string, unknown>;
  for (const k of ["summary", "client_request", "next_step"]) if (!isStr(o[k])) return { ok: false, why: `поле ${k} не рядок` };
  if (!["0", "1", "unknown"].includes(o.manager_channel as string)) return { ok: false, why: "manager_channel поза переліком" };
  const p = o.price as Record<string, unknown> | undefined;
  if (!p || typeof p.discussed !== "boolean" || !isStr(p.quote)) return { ok: false, why: "price не тієї форми" };
  if (!Array.isArray(o.objections) || !o.objections.every((i) => i && isStr(i.what) && isStr(i.quote)))
    return { ok: false, why: "objections не тієї форми" };
  if (!Array.isArray(o.promises) || !o.promises.every((i) => i && ["manager", "client"].includes(i.who) && isStr(i.what)
    && isStr(i.deadline_text) && isStr(i.quote))) return { ok: false, why: "promises не тієї форми" };
  if (!o.promises.every((i) => ["call", "message", "other"].includes(i.channel) && ["minutes", "day", "none"].includes(i.deadline_kind)
    && typeof i.deadline_minutes === "number" && isStr(i.deadline_date) && typeof i.conditional === "boolean"))
    return { ok: false, why: "promises без полів строку (рубрика first-touch-v1)" };
  if (!(CONVERSATION_TYPES as readonly string[]).includes(o.conversation_type as string)) return { ok: false, why: "conversation_type поза переліком (рубрика first-touch-v2/v3)" };
  if (typeof o.type_confidence !== "number" || !(o.type_confidence >= 0 && o.type_confidence <= 1)) return { ok: false, why: "type_confidence не число 0..1" };
  if (!isStr(o.type_reason) || !isStr(o.price_value)) return { ok: false, why: "type_reason або price_value не рядок" };
  // v4: прохання клієнта передзвонити. Поле обовʼязкове в схемі, тож без нього відповідь — не тієї форми.
  const cb = o.callback_request as Record<string, unknown> | undefined;
  if (!cb || typeof cb.asked !== "boolean" || !isStr(cb.quote) || !isStr(cb.deadline_text) || !["minutes", "day", "none"].includes(cb.deadline_kind as string)
    || typeof cb.deadline_minutes !== "number" || !isStr(cb.deadline_date)) return { ok: false, why: "callback_request не тієї форми (рубрика first-touch-v4)" };
  // Суперечність не виправляємо мовчки: «просив передзвонити» без прохання — модель помилилась в одному з двох полів.
  if (o.conversation_type === "call_later" && !cb.asked) return { ok: false, why: "тип call_later, а прохання передзвонити немає" };
  return { ok: true, value: o as unknown as AnalysisResult };
}

/** Нормалізація для пошуку цитати: регістр, апострофи, розділові знаки, пробіли. */
export function normForQuote(s: string): string {
  return s.toLowerCase().replace(/[’'`ʼ]/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Кожну цитату шукаємо в самій розшифровці. `quote_found=false` — модель процитувала те, чого
 * в розмові немає; екран не покаже такий пункт як факт. Порожня цитата → `null` (нема що звіряти).
 */
export function verifyQuotes(r: AnalysisResult, turns: readonly Turn[]): AnalysisResult {
  // 🔴 ПО КАНАЛУ, А НЕ ВСІЄЮ РОЗМОВОЮ. Пілот 28.09.2026: у спільному тексті «угу» клієнта стає посеред
  // речення менеджера («рахую по угу вартості»), і 18 із 54 справжніх цитат виглядали вигаданими.
  // Цитату каже один із двох — отже її шукаємо в тексті її каналу; склейка з двох каналів не пройде.
  const byChannel = new Map<number, string[]>();
  for (const t of turns) {
    const list = byChannel.get(t.channel) ?? [];
    list.push(t.text);
    byChannel.set(t.channel, list);
  }
  const hays = [...byChannel.values()].map((xs) => ` ${normForQuote(xs.join(" "))} `);
  const found = (q: string): boolean | null => {
    const n = normForQuote(q);
    return n ? hays.some((h) => h.includes(` ${n} `)) : null;
  };
  return {
    ...r,
    price: { ...r.price, quote_found: found(r.price.quote) },
    objections: r.objections.map((i) => ({ ...i, quote_found: found(i.quote) })),
    promises: r.promises.map((i) => ({ ...i, quote_found: found(i.quote) })),
    ...(r.callback_request ? { callback_request: { ...r.callback_request, quote_found: found(r.callback_request.quote) } } : {}),
  };
}

export type AnalysisVerdict = { ok: true; result: AnalysisResult } | { ok: false; why: string };

/** Відповідь моделі → готовий результат або чесна причина відмови. */
export function interpretAnalysis(out: GeminiOutcome, turns: readonly Turn[]): AnalysisVerdict {
  if (out.blockReason) return { ok: false, why: `запит заблоковано постачальником: ${out.blockReason}` };
  if (out.finishReason && out.finishReason !== "STOP") return { ok: false, why: `модель не завершила відповідь: ${out.finishReason}` };
  if (!out.text) return { ok: false, why: "модель повернула порожню відповідь" };
  let parsed: unknown;
  try { parsed = JSON.parse(out.text); } catch { return { ok: false, why: "відповідь моделі не JSON" }; }
  const v = validateAnalysis(parsed);
  if (!v.ok) return { ok: false, why: `відповідь моделі не за схемою: ${v.why}` };
  return { ok: true, result: verifyQuotes(v.value, turns) };
}
