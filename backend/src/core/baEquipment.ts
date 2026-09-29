/**
 * 🗂 БІЗНЕС-АСИСТЕНТ, прохід 2 (29.09.2026): Облік техніки.
 *
 * Одиниця техніки — рядок реєстру (як у таблиці Даші «Облік техніки 2026»), видача — окремий рядок
 * із кому/коли/повернення. «На руках» = є видача без дати повернення; одна одиниця не може бути
 * на руках у двох людей — межу тримає частковий унікальний індекс, а не лише цей код (#983).
 * Видають БУДЬ-ЯКОМУ співробітнику з реєстру `employees` (відповідь Даші 29.09.2026).
 *
 * `Db` і `BaError` — ті самі, що в претензіях: роут відкриває транзакцію, тож видача й подія в
 * історії одиниці — або обидві, або жодна.
 */
import { BaError, type Db } from "./baClaims.js";
import { parseDateOrNull, DOC_TYPE_LABEL, type DocType } from "./baRules.js";

const DATE = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;
const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const text = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function logEvent(db: Db, equipmentId: number, actor: number | null, what: string): Promise<void> {
  await db.query(`INSERT INTO ba_events (owner_kind, owner_id, actor_id, what) VALUES ('equipment', $1, $2, $3)`, [equipmentId, actor, what]);
}
function date(v: unknown, label: string, required = false): string | null {
  if (v === undefined && !required) return null;
  const d = parseDateOrNull(v);
  if (d === undefined) throw new BaError(400, `${label}: дата у форматі РРРР-ММ-ДД`);
  if (d === null && required) throw new BaError(400, `${label}: обовʼязкова`);
  return d;
}
function price(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw new BaError(400, "Ціна має бути невідʼємним числом");
  return Math.round(n * 100) / 100;
}
function url(v: unknown): string | null {
  const s = text(v, 1000);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) throw new BaError(400, "Посилання має починатися з http:// або https://");
  return s;
}

/** Співробітники для вибору «кому видати»: лише id, ПІБ і стан — жодних телефонів, дат, ІПН (#984). */
export async function employeesForIssue(db: Db) {
  const r = await db.query<{ id: number; full_name: string; status: string }>(
    `SELECT id, full_name, status FROM employees WHERE COALESCE(btrim(full_name), '') <> '' ORDER BY (status = 'active') DESC, full_name`);
  return r.rows.map((e) => ({ id: e.id, fullName: e.full_name, status: e.status }));
}

const ITEM_COLS = `q.id, q.inv_no, q.kind, q.model, ${DATE("q.purchased_on")} AS purchased_on, q.price, q.purchase_url,
  q.location, q.comment, ${TS("q.archived_at")} AS archived_at,
  i.id AS issue_id, i.holder_name, i.employee_id, e.status AS employee_status, ${DATE("e.dismissed_at")} AS employee_dismissed_on,
  ${DATE("i.issued_on")} AS issued_on,
  (SELECT count(*)::int FROM ba_files f WHERE f.owner_kind = 'issue' AND f.owner_id = i.id) AS contract_files,
  (SELECT ${DATE("max(x.returned_on)")} FROM ba_equipment_issues x WHERE x.equipment_id = q.id) AS last_returned_on`;
const ITEM_FROM = `FROM ba_equipment q
  LEFT JOIN ba_equipment_issues i ON i.equipment_id = q.id AND i.returned_on IS NULL
  LEFT JOIN employees e ON e.id = i.employee_id`;

function shapeItem(r: any) {
  const holder = r.issue_id == null ? null : {
    issueId: r.issue_id, name: r.holder_name, employeeId: r.employee_id, issuedOn: r.issued_on,
    // «Звільнений, не повернено» — людина звільнена за реєстром, а видача відкрита (#983).
    dismissed: r.employee_status === "dismissed", dismissedOn: r.employee_dismissed_on ?? null,
    contractFiles: Number(r.contract_files ?? 0),
  };
  return {
    id: r.id, invNo: r.inv_no, kind: r.kind, model: r.model, purchasedOn: r.purchased_on,
    price: r.price == null ? null : Number(r.price), purchaseUrl: r.purchase_url, location: r.location, comment: r.comment,
    archived: r.archived_at != null, holder, lastReturnedOn: r.last_returned_on ?? null,
  };
}

export async function listEquipment(db: Db) {
  const r = await db.query(`SELECT ${ITEM_COLS} ${ITEM_FROM} ORDER BY i.issued_on DESC NULLS LAST, q.kind, q.id`);
  return r.rows.map(shapeItem);
}

export async function equipmentCard(db: Db, id: number) {
  const r = await db.query(`SELECT ${ITEM_COLS} ${ITEM_FROM} WHERE q.id = $1`, [id]);
  if (!r.rows[0]) throw new BaError(404, "Техніку не знайдено");
  const issues = await db.query(
    `SELECT i.id, i.holder_name, i.employee_id, e.status AS employee_status, ${DATE("i.issued_on")} AS issued_on, ${DATE("i.returned_on")} AS returned_on
       FROM ba_equipment_issues i LEFT JOIN employees e ON e.id = i.employee_id
      WHERE i.equipment_id = $1 ORDER BY i.issued_on DESC, i.id DESC`, [id]);
  const files = await db.query(
    `SELECT id, owner_id, doc_type, name, mime, size_bytes, ${TS("created_at")} AS created_at FROM ba_files
      WHERE owner_kind = 'issue' AND owner_id = ANY($1::int[]) ORDER BY created_at DESC, id DESC`,
    [issues.rows.map((x: any) => x.id)]);
  const events = await db.query(
    `SELECT ${TS("e.at")} AS at, e.what, COALESCE(NULLIF(btrim(u.full_name), ''), split_part(u.email, '@', 1)) AS actor
       FROM ba_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.owner_kind = 'equipment' AND e.owner_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT 200`, [id]);
  return {
    ...shapeItem(r.rows[0]),
    issues: issues.rows.map((x: any) => ({
      id: x.id, name: x.holder_name, employeeId: x.employee_id, dismissed: x.employee_status === "dismissed",
      issuedOn: x.issued_on, returnedOn: x.returned_on,
      files: files.rows.filter((f: any) => f.owner_id === x.id).map((f: any) => ({
        id: f.id, docType: f.doc_type as DocType, docTypeLabel: DOC_TYPE_LABEL[f.doc_type as DocType],
        name: f.name, mime: f.mime, size: f.size_bytes, createdAt: f.created_at,
      })),
    })),
    events: events.rows.map((e: any) => ({ at: e.at, what: e.what, actor: e.actor ?? null })),
  };
}

function itemFields(body: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || "kind" in body) {
    const k = text(body.kind, 200);
    if (!k) throw new BaError(400, "Вкажіть тип техніки (ноутбук, телефон…)");
    out.kind = k;
  }
  if (!partial || "invNo" in body) out.inv_no = text(body.invNo, 100);
  if (!partial || "model" in body) out.model = text(body.model, 300);
  if (!partial || "purchasedOn" in body) out.purchased_on = date(body.purchasedOn, "Дата придбання");
  if (!partial || "price" in body) out.price = price(body.price);
  if (!partial || "purchaseUrl" in body) out.purchase_url = url(body.purchaseUrl);
  if (!partial || "location" in body) out.location = text(body.location, 200);
  if (!partial || "comment" in body) out.comment = text(body.comment);
  return out;
}

export async function createEquipment(db: Db, actor: number, body: any): Promise<number> {
  const f = itemFields(body ?? {}, false);
  const r = await db.query<{ id: number }>(
    `INSERT INTO ba_equipment (kind, inv_no, model, purchased_on, price, purchase_url, location, comment, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [f.kind, f.inv_no, f.model, f.purchased_on, f.price, f.purchase_url, f.location, f.comment, actor]);
  await logEvent(db, r.rows[0].id, actor, "Додано в облік");
  return r.rows[0].id;
}

export async function updateEquipment(db: Db, actor: number, id: number, body: any): Promise<void> {
  const exists = (await db.query(`SELECT 1 FROM ba_equipment WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!exists) throw new BaError(404, "Техніку не знайдено");
  const f = itemFields(body ?? {}, true);
  const keys = Object.keys(f);
  if (!keys.length) return;
  await db.query(`UPDATE ba_equipment SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => f[k])]);
  await logEvent(db, id, actor, "Змінено дані техніки");
}

export async function setEquipmentArchived(db: Db, actor: number, id: number, archived: boolean): Promise<void> {
  if (archived) {
    const open = (await db.query(`SELECT 1 FROM ba_equipment_issues WHERE equipment_id = $1 AND returned_on IS NULL`, [id])).rows[0];
    if (open) throw new BaError(409, "Техніка на руках — спершу оформіть повернення");
  }
  const r = await db.query(`UPDATE ba_equipment SET archived_at = ${archived ? "now()" : "NULL"}, archived_by = ${archived ? "$2" : "NULL"}, updated_at = now()
    WHERE id = $1 ${archived ? "AND archived_at IS NULL" : "AND archived_at IS NOT NULL"}`, archived ? [id, actor] : [id]);
  if (!r.rowCount) throw new BaError(409, archived ? "Техніка вже в архіві" : "Техніка не в архіві");
  await logEvent(db, id, actor, archived ? "Перенесено в архів (списано)" : "Повернуто з архіву");
}

/** Видача: співробітник із реєстру, дата. Одиниця вже на руках — 409, а не друга видача (#983). */
export async function issueEquipment(db: Db, actor: number, equipmentId: number, body: any): Promise<number> {
  const item = (await db.query<{ archived: boolean }>(`SELECT archived_at IS NOT NULL AS archived FROM ba_equipment WHERE id = $1 FOR UPDATE`, [equipmentId])).rows[0];
  if (!item) throw new BaError(404, "Техніку не знайдено");
  if (item.archived) throw new BaError(409, "Техніка в архіві — видати не можна");
  const employeeId = Number(body?.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) throw new BaError(400, "Оберіть співробітника");
  const emp = (await db.query<{ full_name: string; status: string }>(`SELECT full_name, status FROM employees WHERE id = $1`, [employeeId])).rows[0];
  if (!emp) throw new BaError(404, "Співробітника не знайдено в реєстрі");
  if (emp.status === "dismissed") throw new BaError(409, "Співробітника звільнено — видати техніку не можна");
  const issuedOn = date(body?.issuedOn, "Дата видачі", true)!;
  let id: number;
  try {
    id = (await db.query<{ id: number }>(
      `INSERT INTO ba_equipment_issues (equipment_id, employee_id, holder_name, issued_on, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [equipmentId, employeeId, emp.full_name, issuedOn, actor])).rows[0].id;
  } catch (e: any) {
    if (e?.code === "23505") throw new BaError(409, "Ця техніка вже на руках — спершу оформіть повернення");
    throw e;
  }
  await logEvent(db, equipmentId, actor, `Видано: ${emp.full_name}, ${issuedOn}`);
  return id;
}

/** Повернення з датою. Дата раніша за видачу — 400 (CHECK у схемі — другий рубіж). */
export async function returnIssue(db: Db, actor: number, issueId: number, body: any): Promise<void> {
  const iss = (await db.query<{ equipment_id: number; holder_name: string; issued_on: string; returned_on: string | null }>(
    `SELECT equipment_id, holder_name, ${DATE("issued_on")} AS issued_on, ${DATE("returned_on")} AS returned_on
       FROM ba_equipment_issues WHERE id = $1 FOR UPDATE`, [issueId])).rows[0];
  if (!iss) throw new BaError(404, "Видачу не знайдено");
  if (iss.returned_on) throw new BaError(409, "Повернення вже оформлено");
  const returnedOn = date(body?.returnedOn, "Дата повернення", true)!;
  if (returnedOn < iss.issued_on) throw new BaError(400, "Дата повернення раніша за дату видачі");
  await db.query(`UPDATE ba_equipment_issues SET returned_on = $2, updated_at = now() WHERE id = $1`, [issueId, returnedOn]);
  await logEvent(db, iss.equipment_id, actor, `Повернено: ${iss.holder_name}, ${returnedOn}`);
}

/**
 * Скасувати помилково внесене повернення: видача знову «на руках». Якщо одиницю вже видали
 * іншому — 409 (частковий унікальний індекс), бо двох власників водночас бути не може.
 */
export async function undoReturn(db: Db, actor: number, issueId: number): Promise<void> {
  const iss = (await db.query<{ equipment_id: number; holder_name: string; returned_on: string | null }>(
    `SELECT equipment_id, holder_name, ${DATE("returned_on")} AS returned_on FROM ba_equipment_issues WHERE id = $1 FOR UPDATE`, [issueId])).rows[0];
  if (!iss) throw new BaError(404, "Видачу не знайдено");
  if (!iss.returned_on) throw new BaError(409, "Повернення не оформлено — скасовувати нічого");
  try {
    await db.query(`UPDATE ba_equipment_issues SET returned_on = NULL, updated_at = now() WHERE id = $1`, [issueId]);
  } catch (e: any) {
    if (e?.code === "23505") throw new BaError(409, "Техніку вже видано іншому — скасувати повернення не можна");
    throw e;
  }
  await logEvent(db, iss.equipment_id, actor, `Скасовано повернення: ${iss.holder_name} (знову на руках)`);
}

/** Файл договору до видачі. Перевірка типу документа — той самий перелік, що в правилах. */
export async function issueExists(db: Db, issueId: number): Promise<number> {
  const r = (await db.query<{ equipment_id: number }>(`SELECT equipment_id FROM ba_equipment_issues WHERE id = $1`, [issueId])).rows[0];
  if (!r) throw new BaError(404, "Видачу не знайдено");
  return r.equipment_id;
}
