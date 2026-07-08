import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";

/**
 * АІ-відповідач для розділу «Робота з АІ»: читає історію чату ai_messages,
 * відповідає через Claude і вміє діставати статистику з БД дашборду
 * інструментом query_db (лише читання, read-only транзакція + таймаут).
 * Реплаї йдуть асинхронно після POST /ai-work — фронт добирає їх полінгом.
 */

const MODEL = "claude-opus-4-8";
const MAX_TOOL_ITERATIONS = 12;
const HISTORY_LIMIT = 40;
const MAX_RESULT_ROWS = 200;

const SYSTEM_PROMPT = `Ти — АІ-аналітик дашборду відділу продажів логістичної компанії UTS (Україна).
Співрозмовники: операційний директор (КВП) та його асистент. Твоя робота — будувати статистику,
відповідати на питання про продажі й дані CRM, пояснювати цифри. Відповідай українською, стисло і по суті.
Формат — звичайний текст (без markdown-таблиць з |, чат їх не рендерить): списки, короткі рядки «показник: значення».

ДЖЕРЕЛО ДАНИХ: Postgres-БД дашборду (дзеркало CRM Kommo — єдиного джерела істини). У тебе є інструмент
query_db: один SELECT/WITH-запит за виклик, read-only. Використовуй його для БУДЬ-ЯКИХ цифр — не вигадуй.
Якщо не впевнений у колонках таблиці — спершу подивись information_schema.columns.

КЛЮЧОВІ ПРАВИЛА БІЗНЕС-ЛОГІКИ (не порушуй):
- Дати ЗАВЖДИ по-київськи, обидва кінці включно: (col AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $from AND $to.
- «Отримані кошти» = успішно реалізовано (status_id=142, за closed_at_kommo в періоді) + «оплата отримана»
  (поточний status_id IN (69716460, 60412544) — знімок, без фільтра дати). Це одна логіка скрізь.
- Воронка продажів (повний цикл) = pipeline_id IN (8921932, 155304). Лідогенерація: Продзвін 8921936/7337048,
  Реактивація 8921948. Кваліфікація: 8921928/7336928 (етап «Нова заявка від лідогенератора» 69716164/63019380).
- funnel_stage угоди — через pipeline_stage_map (pipeline_id,status_id→lead_taken/quote_requested/approved/invoiced/paid).
  «Угоди (рахунок→реалізовано)» = funnel_stage IN ('invoiced','paid') за датою створення.
  «Очікувані кошти» = знімок з етапу invoiced.
- Канал ліда deals.lead_channel: 'ad' (реклама) / 'leadgen' (лідоген) / 'other'. Конверсія = оплачені/ліди по каналу.
- Середній чек = отримані кошти ÷ кількість цих угод.
- status_id=142 — успішно, 143 — закрито/сміття (не рахувати). Мінусові угоди мають відʼємний price — сумуй як є.
- Нові клієнти = перша оплата в періоді; постійні = 2+ оплачених lifetime та активні. Клієнт = client_key.
- План виручки: plans (metric='payment_amount', plan_date=1-ше число місяця, по менеджерах).
- Менеджери managers (is_active, team_id→teams). Деактивованих не показуй, якщо не просять.

ОСНОВНІ ТАБЛИЦІ:
deals(kommo_id, name, manager_id→managers, pipeline_id, status_id, price, created_at_kommo, closed_at_kommo,
  client_name, client_key, lead_channel, utm_source, lead_generator, client_source, payment_type, last_activity_at),
managers(id, name, team_id, is_team_lead, is_active), teams(id, name),
pipeline_stage_map(pipeline_id, status_id, funnel_stage), plans(manager_id, metric, target_value, plan_date),
deal_stage_events(kommo_id, status_id, pipeline_id, funnel_stage, changed_at) — коли угода ВВІЙШЛА в етап,
lead_transfer_events(kommo_id, changed_at, ...) — передані заявки лідоген→менеджер,
receivables(client_key, client_name, manager_id, amount, ...) — дебіторка (знімок з файлу),
receivable_invoices(client_key, invoice_no, invoice_date, amount, link), monthly_carryover(month, ...),
tasks(assignee_manager_id, task_type, metric, target_value, actual_value, status, deadline, metrics_json),
funnel_plans, ad_budget_daily(day, budget_plan, budget_fact, conversions, clicks),
lardi_offers/lardi_routes/city_info/carrier_trips — калькулятор ставок, sync_state — стан синку.

ЯК ПРАЦЮВАТИ:
- Розбивай складне питання на кілька query_db-запитів; перевіряй правдоподібність результату.
- Показуй суми в гривнях округлено (наприклад «2.33 млн ₴»), кількості — точно.
- Якщо даних нема або запит неоднозначний — скажи прямо і запропонуй уточнення.
- Ти НЕ можеш змінювати дані чи код — лише читати й аналізувати. Прохання «зроби/вигрузи/зміни в CRM»
  чемно переадресовуй розробнику (Claude Code) через власника.`;

const QUERY_DB_TOOL: Anthropic.Tool = {
  name: "query_db",
  description:
    "Виконати ОДИН read-only SQL-запит (SELECT або WITH) до Postgres-БД дашборду. " +
    "Повертає до " + MAX_RESULT_ROWS + " рядків у JSON. Таймаут 20с.",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "Один SELECT/WITH-запит без крапки з комою в кінці" },
    },
    required: ["sql"],
  },
};

/** Run a single read-only statement with a hard timeout and row cap. */
async function runReadOnlyQuery(sql: string): Promise<string> {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) {
    return JSON.stringify({ error: "Дозволені лише SELECT/WITH-запити" });
  }
  if (/;/.test(trimmed)) {
    return JSON.stringify({ error: "Лише один запит за виклик (крапка з комою всередині заборонена)" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    const res = await client.query(trimmed);
    await client.query("COMMIT");
    const rows = res.rows.slice(0, MAX_RESULT_ROWS);
    return JSON.stringify({
      rowCount: res.rowCount,
      truncated: (res.rowCount ?? 0) > MAX_RESULT_ROWS,
      rows,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    client.release();
  }
}

type ChatRow = { role: "user" | "assistant"; body: string; author_name: string };

/** Map chat history to API messages: prefix user turns with the author, merge
 *  consecutive same-role turns, drop a leading assistant turn. */
function buildMessages(rows: ChatRow[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const r of rows) {
    const text = r.role === "user" ? `[${r.author_name}]: ${r.body}` : r.body;
    const last = messages[messages.length - 1];
    if (last && last.role === r.role && typeof last.content === "string") {
      last.content += `\n\n${text}`;
    } else {
      messages.push({ role: r.role, content: text });
    }
  }
  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages;
}

async function insertAssistantMessage(body: string): Promise<void> {
  await pool.query(
    `INSERT INTO ai_messages (author_user_id, author_name, role, body) VALUES (NULL, 'АІ', 'assistant', $1)`,
    [body.slice(0, 12000)]
  );
}

async function generateReply(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    await insertAssistantMessage(
      "⚙️ АІ ще не підключений: на сервері немає ANTHROPIC_API_KEY. " +
        "Додайте ключ (console.anthropic.com → API Keys) у backend/.env і перезапустіть бекенд — після цього я відповідатиму тут і будуватиму статистику з БД."
    );
    return;
  }

  const hist = await pool.query<ChatRow>(
    `SELECT role, body, COALESCE(author_name, 'Користувач') AS author_name
       FROM ai_messages ORDER BY created_at DESC, id DESC LIMIT $1`,
    [HISTORY_LIMIT]
  );
  const messages = buildMessages(hist.rows.reverse());
  if (!messages.length || messages[messages.length - 1].role !== "user") return;

  const client = new Anthropic({ timeout: 10 * 60 * 1000 });

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: [QUERY_DB_TOOL],
      messages,
    });

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (response.stop_reason !== "tool_use" || !toolUses.length) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      await insertAssistantMessage(text || "(порожня відповідь)");
      return;
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const sql = String((tu.input as { sql?: unknown })?.sql ?? "");
      console.log(`[aiWork] query_db: ${sql.slice(0, 160).replace(/\s+/g, " ")}`);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: await runReadOnlyQuery(sql) });
    }
    messages.push({ role: "user", content: results });
  }

  await insertAssistantMessage(
    "Не встиг завершити аналіз (забагато кроків по БД). Спробуйте розбити питання на менші частини."
  );
}

// Serialize replies: user messages posted back-to-back get answered in order,
// one API run at a time (each run sees the full history anyway).
let chain: Promise<void> = Promise.resolve();

/** Fire-and-forget: schedule an AI reply to the latest chat state. */
export function scheduleAiReply(): void {
  chain = chain
    .then(() => generateReply())
    .catch(async (err) => {
      console.error("[aiWork] reply failed:", err);
      const brief =
        err instanceof Anthropic.APIError
          ? `${err.status ?? ""} ${err.name}`.trim()
          : err instanceof Error
            ? err.message
            : String(err);
      await insertAssistantMessage(`⚠️ Не вдалося сформувати відповідь (${brief.slice(0, 300)}). Спробуйте ще раз.`).catch(
        () => undefined
      );
    });
}

/** On backend start: if the last chat message is an unanswered user message,
 *  answer it (covers messages posted while the server was down). */
export async function catchUpAiChat(): Promise<void> {
  try {
    const r = await pool.query<{ role: string }>(
      `SELECT role FROM ai_messages ORDER BY created_at DESC, id DESC LIMIT 1`
    );
    if (r.rows[0]?.role === "user") scheduleAiReply();
  } catch (err) {
    console.error("[aiWork] catch-up failed:", err);
  }
}
