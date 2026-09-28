/**
 * 🗂 БІЗНЕС-АСИСТЕНТ, прохід 1: операції з базою для Претензій і Судового реєстру.
 * Правила без бази — `core/baRules.ts`. Кожна зміна пише рядок історії (`ba_events`) тим самим
 * викликом: історія картки не має права розійтись із самою карткою.
 *
 * `Db` — будь-що з `query`: пул для читання, клієнт транзакції для запису (роут відкриває
 * транзакцію, тож перенос у суд — справа, копії файлів і дві події — або всі, або жоден).
 */
import {
  CLAIM_STATUS_LABEL, CASE_STATUS_LABEL, DOC_TYPE_LABEL, CLAIM_DOC_TYPES, CASE_DOC_TYPES,
  isClaimStatus, isCaseStatus, isDocType, needsCourtCase, caseTitleFor, debtSnapshot, parseDateOrNull,
  type ClaimStatus, type CaseStatus, type DocType, type ReceivableRowLike,
} from "./baRules.js";

export interface Db { query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>; }

export class BaError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

type Owner = "claim" | "case";
const DATE = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;
const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

async function logEvent(db: Db, kind: Owner, id: number, actor: number | null, what: string): Promise<void> {
  await db.query(`INSERT INTO ba_events (owner_kind, owner_id, actor_id, what) VALUES ($1, $2, $3, $4)`, [kind, id, actor, what]);
}

const text = (v: unknown, max = 4000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
function money(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw new BaError(400, "Сума боргу має бути невідʼємним числом");
  return Math.round(n * 100) / 100;
}
function days(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new BaError(400, "Дні прострочення мають бути цілим невідʼємним числом");
  return n;
}
function date(v: unknown, label: string): string | null {
  if (v === undefined) return null; // поле не передали (нова картка без дати) — порожньо, а не помилка
  const d = parseDateOrNull(v);
  if (d === undefined) throw new BaError(400, `${label}: дата у форматі РРРР-ММ-ДД`);
  return d;
}

// ── Претензії ────────────────────────────────────────────────────────────────
const CLAIM_COLS = `c.id, c.company, c.client_key, c.debt_amount, c.overdue_days, ${DATE("c.sent_on")} AS sent_on,
  c.essence, c.status, c.result, c.source, ${TS("c.archived_at")} AS archived_at, ${TS("c.created_at")} AS created_at,
  k.id AS case_id,
  (SELECT count(*)::int FROM ba_files f WHERE f.owner_kind = 'claim' AND f.owner_id = c.id) AS files`;

function shapeClaim(r: any) {
  return {
    id: r.id, company: r.company, clientKey: r.client_key,
    debtAmount: r.debt_amount == null ? null : Number(r.debt_amount), overdueDays: r.overdue_days,
    sentOn: r.sent_on, essence: r.essence, status: r.status as ClaimStatus, statusLabel: CLAIM_STATUS_LABEL[r.status as ClaimStatus],
    result: r.result ?? "", source: r.source, archived: r.archived_at != null, archivedAt: r.archived_at,
    createdAt: r.created_at, caseId: r.case_id ?? null, files: Number(r.files ?? 0),
  };
}

export async function listClaims(db: Db) {
  const r = await db.query(`SELECT ${CLAIM_COLS} FROM ba_claims c LEFT JOIN ba_court_cases k ON k.claim_id = c.id
    ORDER BY c.sent_on DESC NULLS FIRST, c.id DESC`);
  return r.rows.map(shapeClaim);
}

async function filesOf(db: Db, kind: Owner, id: number) {
  const r = await db.query(`SELECT id, doc_type, name, mime, size_bytes, from_claim_file_id, ${TS("created_at")} AS created_at
      FROM ba_files WHERE owner_kind = $1 AND owner_id = $2 ORDER BY created_at DESC, id DESC`, [kind, id]);
  return r.rows.map((f: any) => ({ id: f.id, docType: f.doc_type as DocType, docTypeLabel: DOC_TYPE_LABEL[f.doc_type as DocType],
    name: f.name, mime: f.mime, size: f.size_bytes, fromClaim: f.from_claim_file_id != null, createdAt: f.created_at }));
}
async function eventsOf(db: Db, kind: Owner, id: number) {
  const r = await db.query(`SELECT ${TS("e.at")} AS at, e.what, COALESCE(NULLIF(btrim(u.full_name), ''), split_part(u.email, '@', 1)) AS actor
      FROM ba_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.owner_kind = $1 AND e.owner_id = $2 ORDER BY e.at DESC, e.id DESC LIMIT 200`, [kind, id]);
  return r.rows.map((e: any) => ({ at: e.at, what: e.what, actor: e.actor ?? null }));
}

export async function claimCard(db: Db, id: number) {
  const r = await db.query(`SELECT ${CLAIM_COLS} FROM ba_claims c LEFT JOIN ba_court_cases k ON k.claim_id = c.id WHERE c.id = $1`, [id]);
  if (!r.rows[0]) throw new BaError(404, "Претензію не знайдено");
  return { ...shapeClaim(r.rows[0]), fileList: await filesOf(db, "claim", id), events: await eventsOf(db, "claim", id) };
}

/** Поля претензії з тіла запиту. `partial` — для збереження: відсутнє поле не чіпаємо. */
function claimFields(body: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || "company" in body) {
    const company = text(body.company, 300);
    if (!company) throw new BaError(400, "Вкажіть компанію-адресата");
    out.company = company;
  }
  if (!partial || "debtAmount" in body) out.debt_amount = money(body.debtAmount);
  if (!partial || "overdueDays" in body) out.overdue_days = days(body.overdueDays);
  if (!partial || "sentOn" in body) out.sent_on = date(body.sentOn, "Дата відправки");
  if (!partial || "essence" in body) out.essence = text(body.essence);
  if (!partial || "result" in body) out.result = text(body.result) || null;
  if (!partial || "status" in body) {
    const s = body.status ?? (partial ? undefined : "problem");
    if (!isClaimStatus(s)) throw new BaError(400, "Невідомий статус претензії");
    out.status = s;
  }
  return out;
}

export async function createClaim(db: Db, actor: number, body: any): Promise<number> {
  const f = claimFields(body ?? {}, false);
  const r = await db.query<{ id: number }>(
    `INSERT INTO ba_claims (company, debt_amount, overdue_days, sent_on, essence, result, status, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8) RETURNING id`,
    [f.company, f.debt_amount, f.overdue_days, f.sent_on, f.essence, f.result, f.status, actor]);
  const id = r.rows[0].id;
  await logEvent(db, "claim", id, actor, `Створено вручну · статус «${CLAIM_STATUS_LABEL[f.status as ClaimStatus]}»`);
  if (f.status === "court") await transferToCourt(db, actor, id);
  return id;
}

/**
 * Перенос у суд: справа з претензії + копії рядків усіх її файлів + по події в обох картках.
 * Викликається лише коли справи ще немає (`needsCourtCase`), а `claim_id UNIQUE` у схемі — другий
 * рубіж: подвійний виклик упреться в базу, а не тихо створить другу справу.
 */
async function transferToCourt(db: Db, actor: number, claimId: number): Promise<number> {
  const c = (await db.query<{ company: string }>(`SELECT company FROM ba_claims WHERE id = $1`, [claimId])).rows[0];
  const k = await db.query<{ id: number }>(
    `INSERT INTO ba_court_cases (title, plaintiff, defendant, status, claim_id, created_by)
     VALUES ($1, 'ТОВ «ЮТС»', $2, 'prep', $3, $4) RETURNING id`, [caseTitleFor(c.company), c.company, claimId, actor]);
  const caseId = k.rows[0].id;
  const copied = await db.query(
    `INSERT INTO ba_files (owner_kind, owner_id, doc_type, name, stored_name, mime, size_bytes, from_claim_file_id, created_by, created_at)
     SELECT 'case', $1, doc_type, name, stored_name, mime, size_bytes, id, $3, created_at
       FROM ba_files WHERE owner_kind = 'claim' AND owner_id = $2`, [caseId, claimId, actor]);
  const n = copied.rowCount ?? 0;
  await logEvent(db, "case", caseId, actor, `Створено з претензії «${c.company}», перенесено документів: ${n}`);
  await logEvent(db, "claim", claimId, actor, `Справу створено в Судовому реєстрі, перенесено документів: ${n}`);
  return caseId;
}

export async function updateClaim(db: Db, actor: number, id: number, body: any): Promise<{ caseCreated: number | null }> {
  const prev = (await db.query<{ status: ClaimStatus; case_id: number | null }>(
    `SELECT c.status, k.id AS case_id FROM ba_claims c LEFT JOIN ba_court_cases k ON k.claim_id = c.id WHERE c.id = $1 FOR UPDATE OF c`, [id])).rows[0];
  if (!prev) throw new BaError(404, "Претензію не знайдено");
  const f = claimFields(body ?? {}, true);
  const keys = Object.keys(f);
  if (keys.length) {
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    try {
      await db.query(`UPDATE ba_claims SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => f[k])]);
    } catch (e: any) {
      if (e?.code === "23505") throw new BaError(409, "По цьому клієнту вже є відкрита претензія");
      throw e;
    }
  }
  const next = (f.status as ClaimStatus | undefined) ?? prev.status;
  if (next !== prev.status) await logEvent(db, "claim", id, actor, `Статус → «${CLAIM_STATUS_LABEL[next]}»`);
  else if (keys.length) await logEvent(db, "claim", id, actor, "Змінено поля претензії");
  const caseCreated = needsCourtCase(next, prev.case_id != null) ? await transferToCourt(db, actor, id) : null;
  return { caseCreated };
}

export async function setClaimArchived(db: Db, actor: number, id: number, archived: boolean): Promise<void> {
  try {
    const r = await db.query(`UPDATE ba_claims SET archived_at = ${archived ? "now()" : "NULL"}, archived_by = ${archived ? "$2" : "NULL"}, updated_at = now()
      WHERE id = $1 ${archived ? "AND archived_at IS NULL" : "AND archived_at IS NOT NULL"}`, archived ? [id, actor] : [id]);
    if (!r.rowCount) throw new BaError(409, archived ? "Претензія вже в архіві" : "Претензія не в архіві");
  } catch (e: any) {
    if (e?.code === "23505") throw new BaError(409, "Повернути не можна: по цьому клієнту вже відкрита інша претензія");
    throw e;
  }
  await logEvent(db, "claim", id, actor, archived ? "Перенесено в архів" : "Повернуто з архіву");
}

// ── Претензія з дебіторки ────────────────────────────────────────────────────
/** Відкриті претензії по клієнтах дебіторки — щоб рядок показав «Претензія є» замість кнопки. */
export async function openClaimsByClient(db: Db): Promise<{ clientKey: string; claimId: number }[]> {
  const r = await db.query<{ client_key: string; id: number }>(
    `SELECT client_key, id FROM ba_claims WHERE client_key IS NOT NULL AND archived_at IS NULL AND status NOT IN ('paid','closed')`);
  return r.rows.map((x) => ({ clientKey: x.client_key, claimId: x.id }));
}

/**
 * Кнопка «Проблемний клієнт». Сума й дні — ЗНІМОК із рядків ядра `receivablesByClient`, які
 * роут передає сюди (гейт #754b). Відкрита претензія вже є — повертаємо її, а не створюємо другу
 * (#754c); гонку двох кліків ловить унікальний індекс.
 */
export async function claimFromReceivables(db: Db, actor: number, clientKey: string, rows: readonly ReceivableRowLike[]):
  Promise<{ id: number; created: boolean }> {
  const openSql = `SELECT id FROM ba_claims WHERE client_key = $1 AND archived_at IS NULL AND status NOT IN ('paid','closed')`;
  const existing = (await db.query<{ id: number }>(openSql, [clientKey])).rows[0];
  if (existing) return { id: existing.id, created: false };
  const snap = debtSnapshot(rows, clientKey);
  if (!snap) throw new BaError(404, "Клієнта немає в активній дебіторці");
  let id: number;
  try {
    id = (await db.query<{ id: number }>(
      `INSERT INTO ba_claims (company, client_key, debt_amount, overdue_days, status, source, created_by)
       VALUES ($1, $2, $3, $4, 'problem', 'receivables', $5) RETURNING id`,
      [snap.company, clientKey, snap.amount, snap.overdueDays, actor])).rows[0].id;
  } catch (e: any) {
    if (e?.code !== "23505") throw e;
    const again = (await db.query<{ id: number }>(openSql, [clientKey])).rows[0];
    if (!again) throw e;
    return { id: again.id, created: false };
  }
  const sum = snap.amount.toLocaleString("uk-UA", { maximumFractionDigits: 2 });
  await logEvent(db, "claim", id, actor, `Створено кнопкою «Проблемний клієнт» у дебіторці: ${sum} ₴${snap.overdueDays != null ? `, ${snap.overdueDays} днів прострочення` : ""}`);
  return { id, created: true };
}

// ── Судовий реєстр ───────────────────────────────────────────────────────────
const CASE_COLS = `k.id, k.title, k.plaintiff, k.defendant, k.case_number, ${DATE("k.filed_on")} AS filed_on,
  ${DATE("k.next_hearing_on")} AS next_hearing_on, k.status, k.claim_id, ${TS("k.archived_at")} AS archived_at,
  (SELECT count(*)::int FROM ba_files f WHERE f.owner_kind = 'case' AND f.owner_id = k.id) AS files`;
function shapeCase(r: any) {
  return { id: r.id, title: r.title, plaintiff: r.plaintiff, defendant: r.defendant, caseNumber: r.case_number,
    filedOn: r.filed_on, nextHearingOn: r.next_hearing_on, status: r.status as CaseStatus, statusLabel: CASE_STATUS_LABEL[r.status as CaseStatus],
    claimId: r.claim_id ?? null, archived: r.archived_at != null, archivedAt: r.archived_at, files: Number(r.files ?? 0) };
}
export async function listCases(db: Db) {
  const r = await db.query(`SELECT ${CASE_COLS} FROM ba_court_cases k ORDER BY k.next_hearing_on ASC NULLS LAST, k.filed_on DESC NULLS FIRST, k.id DESC`);
  return r.rows.map(shapeCase);
}
export async function caseCard(db: Db, id: number) {
  const r = await db.query(`SELECT ${CASE_COLS} FROM ba_court_cases k WHERE k.id = $1`, [id]);
  if (!r.rows[0]) throw new BaError(404, "Справу не знайдено");
  return { ...shapeCase(r.rows[0]), fileList: await filesOf(db, "case", id), events: await eventsOf(db, "case", id) };
}
function caseFields(body: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || "title" in body) {
    const t = text(body.title, 300);
    if (!t) throw new BaError(400, "Вкажіть назву справи");
    out.title = t;
  }
  if (!partial || "plaintiff" in body) out.plaintiff = text(body.plaintiff, 300);
  if (!partial || "defendant" in body) out.defendant = text(body.defendant, 300);
  if (!partial || "caseNumber" in body) out.case_number = text(body.caseNumber, 100);
  if (!partial || "filedOn" in body) out.filed_on = date(body.filedOn, "Дата подання позову");
  if (!partial || "nextHearingOn" in body) out.next_hearing_on = date(body.nextHearingOn, "Дата наступного засідання");
  if (!partial || "status" in body) {
    const s = body.status ?? (partial ? undefined : "prep");
    if (!isCaseStatus(s)) throw new BaError(400, "Невідомий статус справи");
    out.status = s;
  }
  return out;
}
export async function createCase(db: Db, actor: number, body: any): Promise<number> {
  const f = caseFields(body ?? {}, false);
  const r = await db.query<{ id: number }>(
    `INSERT INTO ba_court_cases (title, plaintiff, defendant, case_number, filed_on, next_hearing_on, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [f.title, f.plaintiff, f.defendant, f.case_number, f.filed_on, f.next_hearing_on, f.status, actor]);
  await logEvent(db, "case", r.rows[0].id, actor, "Створено вручну");
  return r.rows[0].id;
}
export async function updateCase(db: Db, actor: number, id: number, body: any): Promise<void> {
  const prev = (await db.query<{ status: CaseStatus }>(`SELECT status FROM ba_court_cases WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!prev) throw new BaError(404, "Справу не знайдено");
  const f = caseFields(body ?? {}, true);
  const keys = Object.keys(f);
  if (!keys.length) return;
  await db.query(`UPDATE ba_court_cases SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => f[k])]);
  const next = (f.status as CaseStatus | undefined) ?? prev.status;
  await logEvent(db, "case", id, actor, next !== prev.status ? `Статус → «${CASE_STATUS_LABEL[next]}»` : "Змінено поля справи");
}
export async function setCaseArchived(db: Db, actor: number, id: number, archived: boolean): Promise<void> {
  const r = await db.query(`UPDATE ba_court_cases SET archived_at = ${archived ? "now()" : "NULL"}, archived_by = ${archived ? "$2" : "NULL"}, updated_at = now()
    WHERE id = $1 ${archived ? "AND archived_at IS NULL" : "AND archived_at IS NOT NULL"}`, archived ? [id, actor] : [id]);
  if (!r.rowCount) throw new BaError(409, archived ? "Справа вже в архіві" : "Справа не в архіві");
  await logEvent(db, "case", id, actor, archived ? "Перенесено в архів" : "Повернуто з архіву");
}

// ── Файли ────────────────────────────────────────────────────────────────────
export async function insertFile(db: Db, actor: number, kind: Owner, ownerId: number,
  f: { docType: unknown; name: string; storedName: string; mime: string; size: number }): Promise<number> {
  if (!isDocType(f.docType) || !(kind === "claim" ? CLAIM_DOC_TYPES : CASE_DOC_TYPES).includes(f.docType)) {
    throw new BaError(400, "Невідомий тип документа");
  }
  const table = kind === "claim" ? "ba_claims" : "ba_court_cases";
  const exists = (await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [ownerId])).rows[0];
  if (!exists) throw new BaError(404, kind === "claim" ? "Претензію не знайдено" : "Справу не знайдено");
  const r = await db.query<{ id: number }>(
    `INSERT INTO ba_files (owner_kind, owner_id, doc_type, name, stored_name, mime, size_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [kind, ownerId, f.docType, f.name, f.storedName, f.mime, f.size, actor]);
  await logEvent(db, kind, ownerId, actor, `Додано документ «${DOC_TYPE_LABEL[f.docType]}»: ${f.name}`);
  return r.rows[0].id;
}
export async function fileForDownload(db: Db, kind: Owner, ownerId: number, fileId: number) {
  const r = await db.query<{ name: string; stored_name: string; mime: string }>(
    `SELECT name, stored_name, mime FROM ba_files WHERE id = $1 AND owner_kind = $2 AND owner_id = $3`, [fileId, kind, ownerId]);
  if (!r.rows[0]) throw new BaError(404, "Файл не знайдено");
  return r.rows[0];
}
