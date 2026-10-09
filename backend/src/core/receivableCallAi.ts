import type { Db } from "./adCallFacts.js";
import { callDateLine, dialogText, normForQuote, type GeminiOutcome, type Turn } from "./callAiProviders.js";

/**
 * 💬 РОЗБІР РОЗМОВИ ПРО БОРГ (задача 4631, прохід 2; Роман 09.10.2026 «закінчуй всю цю задачу»).
 *
 * Розмова, прикріплена до дати домовленості в «Дебіторці», розпізнається тією самою чергою, що й перший дотик
 * (`callAiTick`), і розбирається ОКРЕМОЮ рубрикою: модель відповідає лише на те, що потрібно тімліду на планерці, —
 * що пообіцяли заплатити, скільки, коли, хто обіцяв і чому затримка. Рубрика першого дотику на ці дзвінки НЕ ставиться:
 * вони не реклама, і її питання (ціна, заперечення, наступний крок продажу) тут не мають сенсу.
 *
 * Бюджет — у межах загальної стелі AI ($50 на місяць, схвалено Сергієм 22.09). Заміряно 09.10.2026: 90 змін дати за
 * 30 днів, тож навіть якщо кожну підкріплять розмовою, це ~90 розмов × ~$0.015 ≈ $1.5 на місяць.
 */

export const RUBRIC_DEBT_V1 = "debt-payment-v1";
/** Нижче — недодзвін або «алло, передзвоню»: розпізнавати нема чого (той самий поріг, що в першому дотику). */
export const DEBT_TALK_MIN_SEC = 15;
/** Дзвінки з журналу перенесень старші за це не розбираються — історія давнього боргу не варта витрат. */
export const DEBT_LOOKBACK_DAYS = 60;

export interface DebtResult {
  /** 1–2 речення: про що говорили. */
  summary: string;
  manager_channel: "0" | "1" | "unknown";
  /** Клієнт пообіцяв заплатити (усю суму або частину) у названий строк. */
  promised: boolean;
  /** Названа сума обіцяного платежу в гривнях; `null` — суму не назвали. */
  amount_uah: number | null;
  /** Дата обіцяного платежу YYYY-MM-DD; `null` — дату не назвали. */
  pay_date: string | null;
  /** Обіцяли лише частину боргу. */
  partial: boolean;
  /** Що сказали про решту боргу; порожньо — нічого. */
  remainder: string;
  /** Хто обіцяв: імʼя й/або посада, якщо прозвучали; порожньо — невідомо. */
  who: string;
  /** Причина затримки, якщо назвали. */
  delay_reason: string;
  /** Домовлений наступний крок (платіжка на пошту, дзвінок у четвер тощо). */
  next_step: string;
  /** Дослівна цитата клієнта з обіцянкою; порожньо — обіцянки немає. */
  quote: string;
  /** Цитату знайдено в одному каналі розшифровки; `null` — цитати немає. Ставить код, не модель. */
  quote_found?: boolean | null;
}

export const DEBT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "1–2 речення українською: про що говорили щодо боргу" },
    manager_channel: { type: "string", enum: ["0", "1", "unknown"], description: "номер каналу менеджера UTS, визначений зі змісту" },
    promised: { type: "boolean", description: "true — клієнт пообіцяв заплатити (всю суму або частину) у конкретний строк" },
    amount_uah: { type: "integer", description: "сума обіцяного платежу в гривнях; 0 — суму не назвали" },
    pay_date: { type: "string", description: "дата обіцяного платежу YYYY-MM-DD, обчислена від дати розмови; порожньо — дату не назвали" },
    partial: { type: "boolean", description: "true — обіцяли лише частину боргу" },
    remainder: { type: "string", description: "що сказали про решту боргу; порожньо, якщо нічого" },
    who: { type: "string", description: "хто з боку клієнта обіцяв: імʼя та/або посада, якщо прозвучали; порожньо — невідомо" },
    delay_reason: { type: "string", description: "названа причина затримки оплати; порожньо, якщо не назвали" },
    next_step: { type: "string", description: "домовлений наступний крок одним реченням; порожньо, якщо немає" },
    quote: { type: "string", description: "дослівна коротка цитата клієнта з обіцянкою оплати; порожньо, якщо обіцянки немає" },
  },
  required: ["summary", "manager_channel", "promised", "amount_uah", "pay_date", "partial", "remainder", "who", "delay_reason", "next_step", "quote"],
} as const;

export const DEBT_SYSTEM_PROMPT = [
  "Ти отримуєш автоматичну розшифровку телефонної розмови менеджера логістичної компанії UTS із клієнтом, який винен",
  "UTS гроші за перевезення. Кожен рядок — час від початку розмови, номер каналу і текст. Хто з каналів менеджер — визнач",
  "зі змісту. Перший рядок запиту — дата й день тижня розмови: від неї рахуй «у четвер», «завтра», «наступного тижня».",
  "Відповідай лише про оплату боргу. Відповідь — JSON за схемою.",
  "1. promised=true лише тоді, коли клієнт сам назвав строк оплати (дату, день тижня, «до кінця тижня»). «Постараємось»,",
  "   «подивимось», «як гроші прийдуть» без строку — promised=false.",
  "2. pay_date — найраніша обіцяна дата у форматі YYYY-MM-DD. «До кінця тижня» — пʼятниця того тижня. Строк не названо — порожньо.",
  "3. amount_uah — лише сума, яку назвали вголос, у гривнях («пʼятсот тисяч» = 500000). Не вигадуй і не рахуй сам. Не назвали — 0.",
  "4. partial=true, якщо обіцяли не весь борг; що сказали про решту — у remainder.",
  "5. quote — дослівний уривок слів КЛІЄНТА з обіцянкою, без часу й номера каналу, не переказ. Обіцянки немає — порожньо.",
  "6. Якщо розмова не про борг (помилка номером, інша тема) — promised=false, а в summary так і напиши.",
].join("\n");

export function buildDebtRequest(turns: readonly Turn[], maxOutputTokens: number, callAt: Date | null = null): Record<string, unknown> {
  const text = callAt ? `${callDateLine(callAt)}\n\n${dialogText(turns)}` : dialogText(turns);
  return {
    system_instruction: { parts: [{ text: DEBT_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: DEBT_SCHEMA } },
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens,
    },
  };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Сувора перевірка відповіді. Суперечлива — відмова з причиною, а не тихе виправлення: «обіцяли» без строку чи
 * «не обіцяли», але з цитатою обіцянки, — модель помилилась в одному з полів, і невідомо в якому.
 */
export function validateDebt(x: unknown): { ok: true; value: DebtResult } | { ok: false; why: string } {
  if (!x || typeof x !== "object") return { ok: false, why: "не обʼєкт" };
  const o = x as Record<string, unknown>;
  for (const k of ["summary", "remainder", "who", "delay_reason", "next_step", "quote"] as const) {
    if (!isStr(o[k])) return { ok: false, why: `${k} не рядок` };
  }
  if (!["0", "1", "unknown"].includes(o.manager_channel as string)) return { ok: false, why: "manager_channel поза переліком" };
  if (typeof o.promised !== "boolean" || typeof o.partial !== "boolean") return { ok: false, why: "promised / partial не boolean" };
  // Невідоме схема передає нулем і порожнім рядком (як рубрика першого дотику) — тут воно стає `null`, один раз.
  if (typeof o.amount_uah !== "number" || !Number.isFinite(o.amount_uah) || o.amount_uah < 0) return { ok: false, why: "amount_uah не число ≥ 0" };
  if (!isStr(o.pay_date)) return { ok: false, why: "pay_date не рядок" };
  const payDate = o.pay_date.trim() === "" ? null : o.pay_date.trim();
  if (payDate != null && (!ISO.test(payDate) || Number.isNaN(Date.parse(`${payDate}T00:00:00Z`)))) return { ok: false, why: "pay_date не дата YYYY-MM-DD" };
  if (o.promised && payDate == null) return { ok: false, why: "обіцянка без строку" };
  if (!o.promised && (o.quote as string).trim() !== "") return { ok: false, why: "обіцянки немає, а цитата обіцянки є" };
  return { ok: true, value: {
    summary: (o.summary as string).trim(), manager_channel: o.manager_channel as DebtResult["manager_channel"],
    promised: o.promised, amount_uah: o.amount_uah > 0 ? o.amount_uah : null, pay_date: payDate,
    partial: o.partial, remainder: (o.remainder as string).trim(), who: (o.who as string).trim(),
    delay_reason: (o.delay_reason as string).trim(), next_step: (o.next_step as string).trim(), quote: (o.quote as string).trim(),
  } };
}

/** Цитату шукаємо в тексті ОДНОГО каналу (як `verifyQuotes`): склейка реплік двох людей не пройде. */
export function verifyDebtQuote(r: DebtResult, turns: readonly Turn[]): DebtResult {
  const n = normForQuote(r.quote);
  if (!n) return { ...r, quote_found: null };
  const byChannel = new Map<number, string[]>();
  for (const t of turns) byChannel.set(t.channel, [...(byChannel.get(t.channel) ?? []), t.text]);
  const found = [...byChannel.values()].some((xs) => ` ${normForQuote(xs.join(" "))} `.includes(` ${n} `));
  return { ...r, quote_found: found };
}

export function interpretDebt(out: GeminiOutcome, turns: readonly Turn[]): { ok: true; result: DebtResult } | { ok: false; why: string } {
  if (out.blockReason) return { ok: false, why: `запит заблоковано постачальником: ${out.blockReason}` };
  if (out.finishReason && out.finishReason !== "STOP") return { ok: false, why: `модель не завершила відповідь: ${out.finishReason}` };
  if (!out.text) return { ok: false, why: "модель повернула порожню відповідь" };
  let parsed: unknown;
  try { parsed = JSON.parse(out.text); } catch { return { ok: false, why: "відповідь моделі не JSON" }; }
  const v = validateDebt(parsed);
  if (!v.ok) return { ok: false, why: `відповідь моделі не за схемою: ${v.why}` };
  return { ok: true, result: verifyDebtQuote(v.value, turns) };
}

export const DEBT_KIT = { build: buildDebtRequest, interpret: interpretDebt };

/**
 * Дзвінки, які треба розпізнати й розібрати: прикріплені зараз до домовленості або в журналі за `DEBT_LOOKBACK_DAYS`,
 * лише справжні розмови (від `DEBT_TALK_MIN_SEC`). Порожньо — нічого не ставимо й нічого не прибираємо.
 */
export async function receivableLinkedCallIds(db: Db): Promise<string[]> {
  const r = await db.query<{ uniqueid: string }>(
    `SELECT DISTINCT rc.uniqueid FROM ringostat_calls rc
      WHERE rc.billsec >= $1
        AND (rc.uniqueid IN (SELECT n.call_uniqueid FROM receivable_notes n WHERE n.call_uniqueid IS NOT NULL)
          OR rc.uniqueid IN (SELECT l.call_uniqueid FROM receivable_date_log l
                              WHERE l.call_uniqueid IS NOT NULL AND l.changed_at > now() - make_interval(days => $2)))`,
    [DEBT_TALK_MIN_SEC, DEBT_LOOKBACK_DAYS]);
  return r.rows.map((x) => x.uniqueid);
}

/**
 * Короткий рядок для списку: «обіцяли 500 000 ₴ до 09.10 · частина боргу · Олена, бухгалтер» / «без обіцянки: …».
 * «З ким» — пряма вимога ТЗ Юлі (AI-вижимка: «сума, дата, з ким»); невідомо — не пишемо нічого, а не вигадуємо.
 */
export function debtLine(r: Pick<DebtResult, "promised" | "amount_uah" | "pay_date" | "partial" | "summary" | "who">): string {
  const who = r.who?.trim() ? ` · ${r.who.trim()}` : "";
  if (!r.promised) return `без обіцянки оплати${r.summary ? `: ${r.summary}` : ""}${who}`;
  const sum = r.amount_uah != null ? `${Math.round(r.amount_uah).toLocaleString("uk-UA").replace(/[  ]/g, " ")} ₴` : "суму не назвали";
  const d = r.pay_date ? `${r.pay_date.slice(8, 10)}.${r.pay_date.slice(5, 7)}` : "";
  return `обіцяли ${sum}${d ? ` до ${d}` : ""}${r.partial ? " · частина боргу" : ""}${who}`;
}
