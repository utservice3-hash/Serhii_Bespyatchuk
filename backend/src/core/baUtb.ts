/**
 * 🚛 РЕЄСТР УКРТРАНСБЕЗПЕКИ (задача 6269): операції з базою. Правила без бази — `core/baUtbRules.ts`.
 * Файли й історія — ті самі `ba_files` / `ba_events`, що в «Судовому реєстрі» (`owner_kind = 'utb'`): кожна зміна пише
 * рядок історії тим самим викликом, тож історія картки не розходиться з карткою.
 *
 * Сповіщення (ТЗ: менеджеру — при призначенні, відповідальній особі — при «Передано») = задача в Задачнику на цю людину:
 * у дашборді саме задача і є каналом сповіщення. «Приймає» — той, хто веде реєстр. Дедлайну немає (ТЗ: «дедлайни на етапи
 * не ведуться»). Кому вже ставили задачу — памʼятає запис (`*_task_for`), тож повторне збереження задач не множить.
 */
import { BaError, logEvent, filesOf, eventsOf, type Db } from "./baClaims.js";
import { parseDateOrNull } from "./baRules.js";
import {
  UTB_STATUS_LABEL, isUtbStatus, utbMissingFor, needsManagerTask, needsHandlerTask, filterUtb,
  type UtbStatus, type UtbDocs, type UtbFilter,
} from "./baUtbRules.js";
import { activeManagerSql } from "./activeManager.js";

const DATE = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;
const MGR_NAME = (col: string) => `(SELECT m.name FROM managers m WHERE m.id = ${col})`;
const HAS_DOC = (t: string) => `EXISTS (SELECT 1 FROM ba_files f WHERE f.owner_kind = 'utb' AND f.owner_id = u.id AND f.doc_type = '${t}')`;

const COLS = `u.id, u.ep_number, ${DATE("u.received_on")} AS received_on, u.carrier, u.fine_amount, u.manager_id,
  ${MGR_NAME("u.manager_id")} AS manager_name, u.handler_id, ${MGR_NAME("u.handler_id")} AS handler_name,
  u.ttn_number, u.status, u.comment, u.manager_task_for, u.handler_task_for,
  ${HAS_DOC("utb_decision")} AS has_decision, ${HAS_DOC("request")} AS has_request, ${HAS_DOC("ttn")} AS has_ttn,
  (SELECT count(*)::int FROM ba_files f WHERE f.owner_kind = 'utb' AND f.owner_id = u.id) AS files`;

export interface UtbRow {
  id: number; epNumber: string; receivedOn: string; carrier: string; fineAmount: number;
  managerId: number | null; managerName: string | null; handlerId: number | null; handlerName: string | null;
  ttnNumber: string; status: UtbStatus; statusLabel: string; comment: string; docs: UtbDocs; files: number;
}
function shape(r: any): UtbRow {
  return {
    id: r.id, epNumber: r.ep_number, receivedOn: r.received_on, carrier: r.carrier, fineAmount: Number(r.fine_amount),
    managerId: r.manager_id ?? null, managerName: r.manager_name ?? null, handlerId: r.handler_id ?? null, handlerName: r.handler_name ?? null,
    ttnNumber: r.ttn_number, status: r.status as UtbStatus, statusLabel: UTB_STATUS_LABEL[r.status as UtbStatus], comment: r.comment,
    docs: { decision: !!r.has_decision, request: !!r.has_request, ttn: !!r.has_ttn }, files: Number(r.files ?? 0),
  };
}

/** Таблиця: нові надходження зверху. Фільтр — `filterUtb`, той самий, що для Excel. */
export async function listUtb(db: Db, f: UtbFilter = {}): Promise<UtbRow[]> {
  const r = await db.query(`SELECT ${COLS} FROM ba_utb_cases u ORDER BY u.received_on DESC, u.id DESC`);
  return filterUtb(r.rows.map(shape), f);
}

export async function utbCard(db: Db, id: number) {
  const r = await db.query(`SELECT ${COLS} FROM ba_utb_cases u WHERE u.id = $1`, [id]);
  if (!r.rows[0]) throw new BaError(404, "Запис реєстру не знайдено");
  return { ...shape(r.rows[0]), fileList: await filesOf(db, "utb", id), events: await eventsOf(db, "utb", id) };
}

/** Менеджери для обох виборів (ТЗ: «відповідальна особа обирається зі списку менеджерів») — лише активні. */
export async function utbManagers(db: Db): Promise<{ id: number; name: string }[]> {
  const r = await db.query<{ id: number; name: string }>(`SELECT m.id, m.name FROM managers m WHERE ${activeManagerSql("m")} ORDER BY m.name`);
  return r.rows;
}

// ── Поля ─────────────────────────────────────────────────────────────────────
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
function amount(v: unknown): number {
  const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  if (v === null || v === "" || v === undefined || !Number.isFinite(n) || n < 0) throw new BaError(400, "Сума штрафу — невідʼємне число");
  return Math.round(n * 100) / 100;
}
function managerRef(v: unknown, label: string): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BaError(400, `${label}: оберіть зі списку`);
  return n;
}
/** Поля з тіла запиту. `partial` — збереження: відсутнє поле не чіпаємо. Статус тут не береться — його веде `updateUtb`. */
function fields(body: any, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!partial || "epNumber" in body) {
    const v = text(body.epNumber, 100);
    if (!v) throw new BaError(400, "Вкажіть № виконавчого провадження");
    out.ep_number = v;
  }
  if (!partial || "receivedOn" in body) {
    const d = parseDateOrNull(body.receivedOn);
    if (!d) throw new BaError(400, "Дата надходження заяви — у форматі РРРР-ММ-ДД");
    out.received_on = d;
  }
  if (!partial || "carrier" in body) {
    const v = text(body.carrier, 300);
    if (!v) throw new BaError(400, "Вкажіть перевізника");
    out.carrier = v;
  }
  if (!partial || "fineAmount" in body) out.fine_amount = amount(body.fineAmount);
  if (!partial || "managerId" in body) out.manager_id = managerRef(body.managerId, "Відповідальний менеджер");
  if (!partial || "handlerId" in body) out.handler_id = managerRef(body.handlerId, "Відповідальна особа");
  if (!partial || "ttnNumber" in body) out.ttn_number = text(body.ttnNumber, 100);
  if (!partial || "comment" in body) out.comment = text(body.comment, 4000);
  return out;
}
const FIELD_LABEL: Record<string, string> = {
  ep_number: "№ ВП", received_on: "дата надходження", carrier: "перевізник", fine_amount: "сума штрафу",
  manager_id: "відповідальний менеджер", handler_id: "відповідальна особа", ttn_number: "№ ТТН", comment: "коментар",
};
function uniqueOr409(e: any): never {
  if (e?.code === "23505") throw new BaError(409, "Запис із таким № виконавчого провадження вже є в реєстрі");
  throw e;
}

// ── Сповіщення ───────────────────────────────────────────────────────────────
async function ownerName(db: Db, userId: number): Promise<string> {
  const r = await db.query<{ n: string }>(`SELECT COALESCE(NULLIF(btrim(full_name), ''), split_part(email, '@', 1)) AS n FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.n ?? "власнику реєстру";
}
async function createTask(db: Db, actor: number, managerId: number, title: string, description: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO tasks (title, description, status, assignee_id, priority, department, task_type, created_by, reviewer_id)
     VALUES ($1, $2, 'not_started', $3, 'medium', 'Бізнес-асистент', 'simple', $4, $4) RETURNING id`,
    [title, description, managerId, actor]);
  return r.rows[0].id;
}
const money = (n: number) => `${n.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} грн`;

/** Задачі, які треба поставити ПІСЛЯ цього збереження. Пише `*_task_for`, щоб наступне збереження не повторило. */
async function notify(db: Db, actor: number, id: number, prevStatus: UtbStatus | null): Promise<void> {
  const u = (await db.query<any>(`SELECT ep_number, carrier, fine_amount, status, manager_id, handler_id, manager_task_for, handler_task_for
    FROM ba_utb_cases WHERE id = $1`, [id])).rows[0];
  const head = `ВП № ${u.ep_number} · перевізник ${u.carrier} · штраф ${money(Number(u.fine_amount))}`;
  if (needsManagerTask(u.manager_id, u.manager_task_for)) {
    const who = await ownerName(db, actor);
    const tid = await createTask(db, actor, u.manager_id,
      `УТБ: передати заявку і ТТН — ВП № ${u.ep_number}`,
      `${head}.\nУкртрансбезпека нарахувала штраф, який має перейти на перевізника. Передайте, будь ласка, заявку і ТТН по цьому перевезенню: ${who} (Бізнес-асистент → Реєстр Укртрансбезпеки).`);
    await db.query(`UPDATE ba_utb_cases SET manager_task_for = $2 WHERE id = $1`, [id, u.manager_id]);
    await logEvent(db, "utb", id, actor, `Менеджеру поставлено задачу передати заявку і ТТН (задача #${String(tid)})`);
  }
  if (needsHandlerTask(prevStatus ?? "new", u.status, u.handler_id, u.handler_task_for)) {
    const tid = await createTask(db, actor, u.handler_id,
      `УТБ: перевести штраф на перевізника — ВП № ${u.ep_number}`,
      `${head}.\nДокументи зібрано (постанова, заявка, ТТН) — запис передано вам. Оформіть переведення штрафу на перевізника; документи — у картці запису (Бізнес-асистент → Реєстр Укртрансбезпеки).`);
    await db.query(`UPDATE ba_utb_cases SET handler_task_for = $2 WHERE id = $1`, [id, u.handler_id]);
    await logEvent(db, "utb", id, actor, `Відповідальній особі поставлено задачу (задача #${String(tid)})`);
  }
}

// ── Створення й зміна ────────────────────────────────────────────────────────
/** Новий запис — завжди «Нова» (крок 1 ТЗ). Менеджера можна вказати одразу — тоді задача йому ставиться тут же. */
export async function createUtb(db: Db, actor: number, body: any): Promise<number> {
  const f = fields(body ?? {}, false);
  let id: number;
  try {
    id = (await db.query<{ id: number }>(
      `INSERT INTO ba_utb_cases (ep_number, received_on, carrier, fine_amount, manager_id, handler_id, ttn_number, comment, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [f.ep_number, f.received_on, f.carrier, f.fine_amount, f.manager_id, f.handler_id, f.ttn_number, f.comment, actor])).rows[0].id;
  } catch (e) { uniqueOr409(e); }
  await logEvent(db, "utb", id, actor, `Створено · статус «${UTB_STATUS_LABEL.new}»`);
  await notify(db, actor, id, null);
  return id;
}

/**
 * Збереження картки. Статус перевіряється по ФІНАЛЬНОМУ стану запису (поля з цього ж збереження + файли в базі):
 * чого бракує — 400 зі списком словами, і запис не змінюється (роут тримає транзакцію).
 */
export async function updateUtb(db: Db, actor: number, id: number, body: any): Promise<void> {
  await db.query(`SELECT 1 FROM ba_utb_cases WHERE id = $1 FOR UPDATE`, [id]);
  const prev = (await db.query<any>(`SELECT ${COLS} FROM ba_utb_cases u WHERE u.id = $1`, [id])).rows[0];
  if (!prev) throw new BaError(404, "Запис реєстру не знайдено");
  const before = shape(prev);
  const f = fields(body ?? {}, true);
  let next: UtbStatus = before.status;
  if (body && "status" in body) {
    if (!isUtbStatus(body.status)) throw new BaError(400, "Невідомий статус");
    next = body.status;
  }
  const after = {
    managerId: "manager_id" in f ? (f.manager_id as number | null) : before.managerId,
    handlerId: "handler_id" in f ? (f.handler_id as number | null) : before.handlerId,
    ttnNumber: "ttn_number" in f ? String(f.ttn_number) : before.ttnNumber,
    comment: "comment" in f ? String(f.comment) : before.comment,
    docs: before.docs,
  };
  const miss = utbMissingFor(next, after);
  if (miss.length) throw new BaError(400, `Статус «${UTB_STATUS_LABEL[next]}» неможливий: бракує ${miss.join(", ")}`, { missing: miss });

  // Сума з бази — рядок NUMERIC («1000.00»), з форми — число: порівнюємо значення, а не запис.
  const same = (k: string) => (k === "fine_amount" ? Number(f[k]) === Number(prev[k]) : String(f[k] ?? "") === String(prev[k] ?? ""));
  const changed = Object.keys(f).filter((k) => !same(k));
  const sets = [...changed.map((k, i) => `${k} = $${i + 2}`), ...(next !== before.status ? [`status = $${changed.length + 2}`] : [])];
  if (!sets.length) return;
  const vals = [...changed.map((k) => f[k]), ...(next !== before.status ? [next] : [])];
  try {
    await db.query(`UPDATE ba_utb_cases SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, [id, ...vals]);
  } catch (e) { uniqueOr409(e); }
  if (next !== before.status) await logEvent(db, "utb", id, actor, `Статус → «${UTB_STATUS_LABEL[next]}»`);
  if (changed.length) await logEvent(db, "utb", id, actor, `Змінено: ${changed.map((k) => FIELD_LABEL[k] ?? k).join(", ")}`);
  await notify(db, actor, id, before.status);
}
