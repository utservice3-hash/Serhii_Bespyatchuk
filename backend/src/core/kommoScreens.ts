/**
 * 📎 СКРІН ПЕРЕПИСКИ З УГОДИ KOMMO → КОНТАКТ КЛІЄНТА З AI-КОМЕНТАРЕМ (задача 8347).
 *
 * ТЗ Юлі 06.11 (п.3): менеджер кріпить скрін переписки ЛИШЕ в угоду Kommo; дашборд сам його підтягує, AI читає й пише
 * коротко, про що домовились, і скрін рахується контактом. Кнопка «＋ Контакт» лишається як була.
 * Рішення Романа 11.11.2026 («1 так 2 ТІЛЬКИ З СЬОГОДНІ 3 так 4 так»):
 *   1. контактом рахується ЛИШЕ скрін, у якому AI побачив переписку з клієнтом (`chat`); фото ТТН, документи й інше видно
 *      в картці, але контактом вони не є;
 *   2. лише скріни, прикріплені з 11.11.2026 (`SCREENS_FROM_ISO`) — старих не підтягуємо;
 *   3. усі угоди, де відомий клієнт (`deals.client_key`), а не лише клієнти екрана «Клієнти та реактивація»;
 *   4. дата контакту — коли скрін прикріпили в Kommo (`created_at` нотатки), а не дата на самому скріні.
 *
 * Файл до себе НЕ копіюємо: показуємо з Kommo на запит (`kommo/client.ts` → `kommoDriveFile`), у нас лежить лише текст AI.
 * Рядок живе в `client_contacts` з каналом `kommo` — тож його без окремої логіки бачать усі читачі контактів; правило «лише
 * переписка» вони беруть звідси одним предикатом (`countsAsContactSql`), і перелік читачів стереже гейт.
 *
 * Чисті правила — вгорі; запити з явним `db` — нижче.
 */
export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}

/** 11.11.2026 00:00 за Києвом (UTC+2). Раніше прикріплених скрінів не беремо (рішення Романа 11.11, п.2). */
export const SCREENS_FROM_ISO = "2026-11-10T22:00:00.000Z";
export const SCREENS_FROM_UNIX = Math.floor(Date.parse(SCREENS_FROM_ISO) / 1000);

/** Канал контакту для скріна з угоди. У перелік «＋ Контакт» його НЕ додаємо: руками такий запис не створюється. */
export const KOMMO_CHANNEL = "kommo";
export const KOMMO_CHANNEL_LABEL = "Скрін у Kommo";

/** Що Gemini приймає картинкою (png/jpeg/webp/heic/heif). Розширення — з `original_name` нотатки. */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", heif: "image/heif",
};

export function imageMimeOf(name: string | null | undefined): string | null {
  const ext = String(name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

/** Нотатка-вкладення угоди так, як її віддає `/api/v4/leads/notes` (лише потрібні поля). */
export interface AttachmentNote {
  id: number;
  entityId: number;
  createdBy: number;
  /** unix-секунди */
  createdAt: number;
  noteType: string;
  isDrive: boolean;
  fileUuid: string | null;
  originalName: string | null;
}

export type SkipReason = "not_attachment" | "not_drive" | "not_image" | "system" | "too_old";

/**
 * Чи це скрін, який беремо: вкладення з файлів Kommo, картинка, прикріплена ЛЮДИНОЮ, не раніше дати старту.
 * Причину відмови повертаємо, а не `false`: лог називає, скільки чого відкинули (правило 4 — разом із предикатом
 * їде число, скільки він НЕ впізнав).
 */
export function screenVerdict(n: AttachmentNote): { take: true; mime: string } | { take: false; why: SkipReason } {
  if (n.noteType !== "attachment") return { take: false, why: "not_attachment" };
  if (!n.isDrive || !n.fileUuid) return { take: false, why: "not_drive" };
  const mime = imageMimeOf(n.originalName);
  if (!mime) return { take: false, why: "not_image" };
  if (!n.createdBy) return { take: false, why: "system" };
  if (n.createdAt < SCREENS_FROM_UNIX) return { take: false, why: "too_old" };
  return { take: true, mime };
}

// ─── Що на картинці: рубрика AI ─────────────────────────────────────────────

export const SCREEN_RUBRIC = "kommo-screen-v1";
/** Операція в `ai_spend_ledger` — спільна стеля Gemini (`CALL_AI_LLM_MONTH_CAP_USD`) рахує й її. */
export const SCREEN_OPERATION = "screen_analysis";
export const SCREEN_KINDS = ["chat", "document", "photo", "other"] as const;
export type ScreenKind = typeof SCREEN_KINDS[number];
export const SCREEN_KIND_LABEL: Readonly<Record<ScreenKind, string>> = {
  chat: "переписка", document: "документ", photo: "фото", other: "інше",
};

/** Рішення Романа 11.11, п.1: контактом рахується лише переписка. Ще не прочитаний AI скрін — теж не контакт. */
export function countsAsContact(channel: string, aiKind: string | null): boolean {
  return channel !== KOMMO_CHANNEL || aiKind === "chat";
}

/**
 * ТЕ САМЕ правило мовою SQL — для КОЖНОГО читача, що рахує «контакт був». Один вираз на всіх: розійдись два читачі,
 * і «Останній контакт» на «Плані місяця» стверджував би одне, а «працюють» на «З ким говорити» — інше.
 */
export function countsAsContactSql(alias: string): string {
  return `(${alias}.channel <> '${KOMMO_CHANNEL}' OR ${alias}.ai_kind = 'chat')`;
}

export const SCREEN_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...SCREEN_KINDS],
      description: "chat — скрін переписки з клієнтом (Viber, Telegram, WhatsApp, SMS, пошта); document — документ, рахунок, ТТН, накладна, договір, скан; photo — фото вантажу, авто, місця; other — інше" },
    summary: { type: "string",
      description: "лише для chat: 1–2 речення українською — про що домовились з клієнтом або що він відповів, і наступний крок чи дату, якщо названо; для інших типів — порожньо" },
  },
  required: ["kind", "summary"],
} as const;

export const SCREEN_SYSTEM_PROMPT = [
  "Ти допомагаєш керівнику відділу продажів логістичної компанії UTS (вантажні перевезення).",
  "Тобі дають картинку, яку менеджер прикріпив до угоди в CRM. Визнач, що на ній:",
  "- chat — скрін переписки менеджера з клієнтом у месенджері чи пошті;",
  "- document — документ, рахунок, ТТН, накладна, договір, скан чи фото документа;",
  "- photo — фото вантажу, автомобіля, місця завантаження;",
  "- other — усе інше.",
  "Якщо це chat — напиши summary: 1–2 короткі речення українською, про що домовились з клієнтом або що він відповів,",
  "і наступний крок чи дату, якщо вони названі в переписці. Пиши лише те, що видно на скріні, нічого не вигадуй.",
  "Для document, photo, other summary — порожній рядок.",
].join("\n");

export const SCREEN_MAX_OUTPUT_TOKENS = 1024;
/** Верхня межа вхідних токенів картинки ДО виклику (для стелі): скрін телефона — до ~2 тис., беремо із запасом. */
export const SCREEN_INPUT_TOKENS_BOUND = 4000;
/** Більші файли не шлемо: Gemini приймає до 20 МБ усього запиту, а скрін переписки на 10 МБ — не скрін. */
export const SCREEN_MAX_BYTES = 10 * 1024 * 1024;

export function buildScreenRequest(bytes: Uint8Array, mime: string): Record<string, unknown> {
  return {
    system_instruction: { parts: [{ text: SCREEN_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [
      { inline_data: { mime_type: mime, data: Buffer.from(bytes).toString("base64") } },
      { text: "Що на цій картинці?" },
    ] }],
    generationConfig: {
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: SCREEN_SCHEMA } },
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens: SCREEN_MAX_OUTPUT_TOKENS,
    },
  };
}

export type ScreenVerdict = { ok: true; kind: ScreenKind; summary: string | null } | { ok: false; why: string };

/** Відповідь моделі → тип і коментар. Переписка без коментаря — непридатна відповідь (інакше «контакт» без змісту). */
export function interpretScreen(text: string | null, blockReason: string | null = null): ScreenVerdict {
  if (blockReason) return { ok: false, why: `модель відмовила: ${blockReason}` };
  if (!text) return { ok: false, why: "порожня відповідь моделі" };
  let o: unknown;
  try { o = JSON.parse(text); } catch { return { ok: false, why: "відповідь не JSON" }; }
  const x = (o ?? {}) as { kind?: unknown; summary?: unknown };
  const kind = SCREEN_KINDS.find((k) => k === x.kind);
  if (!kind) return { ok: false, why: `невідомий тип картинки: ${String(x.kind).slice(0, 40)}` };
  const summary = typeof x.summary === "string" ? x.summary.trim().slice(0, 600) : "";
  if (kind === "chat" && !summary) return { ok: false, why: "переписка без коментаря" };
  return { ok: true, kind, summary: kind === "chat" ? summary : null };
}

// ─── Запити ─────────────────────────────────────────────────────────────────

export interface ScreenRow { noteId: number; dealId: number; fileUuid: string; fileName: string | null; mime: string; authorKommoId: number; createdAtUnix: number }

/**
 * Скріни → рядки контактів, одним запитом. Клієнт — з угоди (`deals.client_key`); угоди без клієнта не беремо
 * (рішення п.3) і повертаємо їх числом. Автор — наш користувач менеджера Kommo, якщо такий є; інакше лишається
 * Kommo-id автора, і картка назве його за `managers`. Повтор тієї самої нотатки — не новий рядок.
 */
export async function insertScreens(db: Db, rows: readonly ScreenRow[]): Promise<{ inserted: number; noClient: number }> {
  if (!rows.length) return { inserted: 0, noClient: 0 };
  const r = await db.query<{ inserted: number; no_client: number }>(
    `WITH x AS (
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[])
         AS t(note_id, deal_id, file_uuid, file_name, mime, author_kommo_id, created_unix)
     ), ins AS (
       INSERT INTO client_contacts (client_key, channel, note, file_name, mime, created_by, created_at,
                                    kommo_note_id, kommo_deal_id, kommo_file_uuid, kommo_author_id, ai_status)
       SELECT d.client_key, '${KOMMO_CHANNEL}', NULL, x.file_name, x.mime,
              (SELECT u.id FROM users u JOIN managers m ON m.id = u.manager_id WHERE m.kommo_user_id = x.author_kommo_id ORDER BY u.id LIMIT 1),
              to_timestamp(x.created_unix), x.note_id, x.deal_id, x.file_uuid, x.author_kommo_id, 'queued'
         FROM x JOIN deals d ON d.kommo_id = x.deal_id
        WHERE d.client_key IS NOT NULL AND d.client_key <> ''
       ON CONFLICT (kommo_note_id) WHERE kommo_note_id IS NOT NULL DO NOTHING
       RETURNING id
     )
     SELECT (SELECT count(*) FROM ins)::int AS inserted,
            (SELECT count(*) FROM x LEFT JOIN deals d ON d.kommo_id = x.deal_id
              WHERE d.client_key IS NULL OR d.client_key = '')::int AS no_client`,
    [rows.map((x) => x.noteId), rows.map((x) => x.dealId), rows.map((x) => x.fileUuid), rows.map((x) => x.fileName),
      rows.map((x) => x.mime), rows.map((x) => x.authorKommoId), rows.map((x) => x.createdAtUnix)]);
  return { inserted: Number(r.rows[0]?.inserted ?? 0), noClient: Number(r.rows[0]?.no_client ?? 0) };
}

export interface QueuedScreen { id: number; noteId: number; fileUuid: string; mime: string; attempts: number }

/** Черга на прочитання: найстаріші першими. `capped` повертається в чергу на наступному тіку (стеля могла звільнитись). */
export async function queuedScreens(db: Db, limit: number): Promise<QueuedScreen[]> {
  const r = await db.query<{ id: number; kommo_note_id: string; kommo_file_uuid: string; mime: string; ai_attempts: number }>(
    `SELECT id, kommo_note_id::text, kommo_file_uuid, mime, ai_attempts FROM client_contacts
      WHERE channel = '${KOMMO_CHANNEL}' AND ai_status IN ('queued', 'capped')
      ORDER BY created_at, id LIMIT $1`, [limit]);
  return r.rows.map((x) => ({ id: x.id, noteId: Number(x.kommo_note_id), fileUuid: x.kommo_file_uuid, mime: x.mime, attempts: Number(x.ai_attempts) }));
}

export const SCREEN_MAX_ATTEMPTS = 3;

/** Невдача без відповіді моделі (файл не скачався, збій мережі): спроба +1; вичерпано — `failed` з причиною. */
export async function screenAttemptFailed(db: Db, id: number, why: string, final: boolean): Promise<void> {
  await db.query(
    `UPDATE client_contacts SET ai_attempts = ai_attempts + 1, ai_failure = $2,
            ai_status = CASE WHEN $3::boolean OR ai_attempts + 1 >= ${SCREEN_MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END
      WHERE id = $1`, [id, why.slice(0, 300), final]);
}

export async function markScreensCapped(db: Db, ids: readonly number[]): Promise<void> {
  if (ids.length) await db.query(`UPDATE client_contacts SET ai_status = 'capped' WHERE id = ANY($1) AND ai_status = 'queued'`, [ids]);
}

/**
 * Відповідь моделі прийшла: за неї заплачено, навіть якщо вона непридатна. Витрата і результат — ОДНИМ запитом
 * (як `runAnalysisPortion`): витрата без результату або результат без витрати розвели б стелю з журналом.
 */
export async function recordScreenResult(db: Db, a: {
  id: number; noteId: number; at: Date; provider: string;
  inputTokens: number; outputTokens: number; unitSuffix: "" | "_bound";
  usdPerInputToken: number; usdPerOutputToken: number; verdict: ScreenVerdict;
}): Promise<void> {
  const v = a.verdict;
  await db.query(
    `WITH l AS (
       INSERT INTO ai_spend_ledger (at, provider, operation, uniqueid, units, unit, unit_price_usd)
       VALUES ($2, $3, '${SCREEN_OPERATION}', $4, $5, $6, $7), ($2, $3, '${SCREEN_OPERATION}', $4, $8, $9, $10) RETURNING id
     )
     UPDATE client_contacts SET ai_status = $11, ai_kind = $12, ai_summary = $13, ai_failure = $14, ai_at = $2,
            ai_attempts = ai_attempts + 1
      WHERE id = $1 AND (SELECT count(*) FROM l) = 2`,
    [a.id, a.at.toISOString(), a.provider, `kommo_note:${String(a.noteId)}`,
      a.inputTokens, `input_tokens${a.unitSuffix}`, a.usdPerInputToken,
      a.outputTokens, `output_tokens${a.unitSuffix}`, a.usdPerOutputToken,
      v.ok ? "done" : "failed", v.ok ? v.kind : null, v.ok ? v.summary : null, v.ok ? null : v.why.slice(0, 300)]);
}
