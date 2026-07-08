import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";
import { runReadOnly } from "./readQuery.js";

/**
 * АІ-відповідач для розділу «Робота з АІ»: читає історію чату ai_messages
 * (з вкладеними зображеннями), відповідає через Claude, вміє діставати
 * статистику з БД (query_db, read-only) і будувати віджети в розділі
 * «Мої звіти» (create_widget/list_widgets/update_widget/delete_widget).
 * Реплаї йдуть асинхронно після POST /ai-work — фронт добирає їх полінгом.
 */

const MODEL = "claude-opus-4-8";
const MAX_TOOL_ITERATIONS = 14;
const HISTORY_LIMIT = 40;

// Absolute origin so Anthropic can fetch attached images (served publicly at
// /api/files/*). Override with PUBLIC_BASE_URL if the domain changes.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "https://dashboard.uts.ua").replace(/\/$/, "");

const SYSTEM_PROMPT = `Ти — АІ-аналітик дашборду відділу продажів логістичної компанії UTS (Україна).
Співрозмовники: операційний директор (КВП) та його асистент. Твоя робота — будувати статистику,
відповідати на питання про продажі й дані CRM, пояснювати цифри, а НА ЗАПИТ — створювати віджети
(графіки/таблиці/KPI) у розділі дашборду «Мої звіти». Відповідай українською, стисло і по суті.
Формат — звичайний текст (без markdown-таблиць з |, чат їх не рендерить): списки, короткі рядки «показник: значення».

ДЖЕРЕЛО ДАНИХ: Postgres-БД дашборду (дзеркало CRM Kommo — єдиного джерела істини). Інструмент
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
deal_stage_events(kommo_id, status_id, pipeline_id, funnel_stage, changed_at),
lead_transfer_events(kommo_id, changed_at, ...), receivables(client_key, client_name, manager_id, amount, ...),
tasks(assignee_manager_id, task_type, metric, target_value, actual_value, status, deadline, metrics_json),
ad_budget_daily(day, budget_plan, budget_fact, conversions, clicks), sync_state.

ВІДЖЕТИ «МОЇ ЗВІТИ» (create_widget): коли просять «додай графік/звіт/віджет у дашборд» — створюй віджет.
- sql: ОДИН read-only SELECT/WITH. Колонки результату мають точно відповідати config.
- chart_type + config:
  • 'kpi' — одна цифра. Результат = 1 рядок. config: {"value":"<колонка>","label":"<підпис>","format":"money"|"number"}.
  • 'bar' / 'line' — config: {"x":"<колонка-підпис>","series":[{"key":"<колонка>","label":"<легенда>"}],"format":"money"|"number"}.
    Результат — рядки, впорядковані по осі X (напр. по тижнях/менеджерах).
  • 'table' — config: {"columns":[{"key":"<колонка>","label":"<заголовок>","format":"money"|"number"|"text"}]}.
- visibility: 'admin' (лише КВП/адміни, дефолт) / 'leads' (тімліди й адміни) / 'all' (усі користувачі).
- ПЕРЕД створенням ЗАВЖДИ прожени sql через query_db, переконайся що колонки й цифри правильні, лише потім create_widget.
- Після створення коротко підтвердь: назва + де зʼявиться («у розділі „Мої звіти"»).
- Зміна наявного — update_widget за id (спершу list_widgets). Видалення — delete_widget.

Ти можеш ЧИТАТИ дані й КЕРУВАТИ ВЛАСНИМИ віджетами. Змінювати код дашборду, писати в CRM чи деплоїти ти НЕ можеш —
такі прохання чемно переадресовуй розробнику через власника. Якщо надіслали скрін — розглянь його й дай по суті.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "query_db",
    description:
      "Виконати ОДИН read-only SQL-запит (SELECT/WITH) до Postgres-БД дашборду. Повертає рядки в JSON. Таймаут 20с.",
    input_schema: {
      type: "object",
      properties: { sql: { type: "string", description: "Один SELECT/WITH-запит без крапки з комою в кінці" } },
      required: ["sql"],
    },
  },
  {
    name: "create_widget",
    description:
      "Створити віджет у розділі дашборду «Мої звіти» (графік/таблиця/KPI). Спершу перевір sql через query_db.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        chart_type: { type: "string", enum: ["table", "bar", "line", "kpi"] },
        sql: { type: "string", description: "Один read-only SELECT/WITH; колонки мають відповідати config" },
        config: { type: "object", description: "Опис рендеру: x/series/columns/value/label/format (див. системний промпт)" },
        visibility: { type: "string", enum: ["admin", "leads", "all"], description: "Хто бачить (дефолт admin)" },
      },
      required: ["title", "chart_type", "sql"],
    },
  },
  {
    name: "list_widgets",
    description: "Перелік наявних віджетів «Мої звіти» (id, назва, тип, видимість).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "update_widget",
    description: "Оновити наявний віджет за id (передавай лише поля, що змінюються).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        title: { type: "string" },
        chart_type: { type: "string", enum: ["table", "bar", "line", "kpi"] },
        sql: { type: "string" },
        config: { type: "object" },
        visibility: { type: "string", enum: ["admin", "leads", "all"] },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_widget",
    description: "Видалити віджет «Мої звіти» за id.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
];

type ToolInput = Record<string, unknown>;

async function execTool(name: string, input: ToolInput, userId: number | null): Promise<string> {
  try {
    switch (name) {
      case "query_db": {
        const r = await runReadOnly(String(input.sql ?? ""));
        return JSON.stringify(r.ok ? { rowCount: r.rowCount, truncated: r.truncated, rows: r.rows } : { error: r.error });
      }
      case "create_widget": {
        const sql = String(input.sql ?? "");
        const check = await runReadOnly(sql);
        if (!check.ok) return JSON.stringify({ error: `SQL не виконався: ${check.error}` });
        const r = await pool.query<{ id: number }>(
          `INSERT INTO ai_widgets (title, chart_type, sql, config, visibility, created_by,
             sort_order)
           VALUES ($1,$2,$3,$4,$5,$6, COALESCE((SELECT MAX(sort_order)+1 FROM ai_widgets),0))
           RETURNING id`,
          [
            String(input.title ?? "Звіт"),
            String(input.chart_type ?? "table"),
            sql,
            input.config ? JSON.stringify(input.config) : null,
            ["admin", "leads", "all"].includes(String(input.visibility)) ? String(input.visibility) : "admin",
            userId,
          ]
        );
        return JSON.stringify({ ok: true, id: r.rows[0].id, previewRows: check.rows.slice(0, 3) });
      }
      case "list_widgets": {
        const r = await pool.query(
          `SELECT id, title, chart_type, visibility, sort_order FROM ai_widgets ORDER BY sort_order, id`
        );
        return JSON.stringify({ widgets: r.rows });
      }
      case "update_widget": {
        const id = Number(input.id);
        if (!id) return JSON.stringify({ error: "Потрібен id" });
        if (input.sql != null) {
          const check = await runReadOnly(String(input.sql));
          if (!check.ok) return JSON.stringify({ error: `SQL не виконався: ${check.error}` });
        }
        const sets: string[] = [];
        const vals: unknown[] = [];
        const add = (col: string, v: unknown) => { sets.push(`${col} = $${sets.length + 1}`); vals.push(v); };
        if (input.title != null) add("title", String(input.title));
        if (input.chart_type != null) add("chart_type", String(input.chart_type));
        if (input.sql != null) add("sql", String(input.sql));
        if (input.config !== undefined) add("config", input.config ? JSON.stringify(input.config) : null);
        if (input.visibility != null && ["admin", "leads", "all"].includes(String(input.visibility)))
          add("visibility", String(input.visibility));
        if (!sets.length) return JSON.stringify({ error: "Нема що оновлювати" });
        vals.push(id);
        const r = await pool.query(
          `UPDATE ai_widgets SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING id`,
          vals
        );
        return JSON.stringify(r.rowCount ? { ok: true, id } : { error: "Віджет не знайдено" });
      }
      case "delete_widget": {
        const r = await pool.query(`DELETE FROM ai_widgets WHERE id = $1`, [Number(input.id)]);
        return JSON.stringify(r.rowCount ? { ok: true } : { error: "Віджет не знайдено" });
      }
      default:
        return JSON.stringify({ error: `Невідомий інструмент ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

type Attachment = { url?: string; name?: string };
type ChatRow = { role: "user" | "assistant"; body: string; author_name: string; attachments: Attachment[] | null };

/** Build one message's content: text + any image attachments (as URL blocks). */
function toContent(r: ChatRow): string | Anthropic.ContentBlockParam[] {
  const text = r.role === "user" ? `[${r.author_name}]: ${r.body}` : r.body;
  const imgs = (r.attachments ?? []).filter((a) => a.url && /\.(png|jpe?g|gif|webp)$/i.test(a.url));
  if (r.role !== "user" || !imgs.length) return text;
  const blocks: Anthropic.ContentBlockParam[] = [{ type: "text", text }];
  for (const a of imgs) {
    const url = a.url!.startsWith("http") ? a.url! : `${PUBLIC_BASE_URL}${a.url}`;
    blocks.push({ type: "image", source: { type: "url", url } });
  }
  return blocks;
}

/** Map chat history to API messages; drop a leading non-user turn. */
function buildMessages(rows: ChatRow[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = rows.map((r) => ({ role: r.role, content: toContent(r) }));
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
        "Додайте ключ (console.anthropic.com → API Keys) у backend/.env і перезапустіть бекенд."
    );
    return;
  }

  const hist = await pool.query<ChatRow>(
    `SELECT role, body, COALESCE(author_name, 'Користувач') AS author_name, attachments
       FROM ai_messages ORDER BY created_at DESC, id DESC LIMIT $1`,
    [HISTORY_LIMIT]
  );
  const lastRow = hist.rows[0];
  if (!lastRow || lastRow.role !== "user") return;
  const messages = buildMessages(hist.rows.reverse());
  if (!messages.length) return;

  const userId = await pool
    .query<{ author_user_id: number | null }>(
      `SELECT author_user_id FROM ai_messages WHERE role='user' ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .then((r) => r.rows[0]?.author_user_id ?? null)
    .catch(() => null);

  const client = new Anthropic({ timeout: 10 * 60 * 1000 });

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
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
      console.log(`[aiWork] tool ${tu.name}: ${JSON.stringify(tu.input).slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: await execTool(tu.name, tu.input as ToolInput, userId) });
    }
    messages.push({ role: "user", content: results });
  }

  await insertAssistantMessage(
    "Не встиг завершити (забагато кроків). Спробуйте розбити питання на менші частини."
  );
}

// Serialize replies: back-to-back user messages get answered in order.
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

/** On backend start: answer a trailing unanswered user message. */
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
