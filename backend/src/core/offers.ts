/**
 * 📄 ОФЕР КАНДИДАТУ — ОПЕРАЦІЇ З БАЗОЮ (18.09.2026, етап 3). Правила шаблону — `offerTemplate.ts`.
 *
 * Офер — звичайний документ розділу «Офери» в «Документах»: адресат — акаунт кандидата, версії,
 * sha256, підпис кодом і нагадування вже є там. Тут лише «шаблон → заповнений .docx → документ».
 *
 * 🔴 СТАН ОФЕРУ НЕ ЗБЕРІГАЄТЬСЯ ОКРЕМО. «Надіслано / підписано / на перевірці / застарів» береться з
 * документа й підписів тією самою `signatureState`, що й у «Документах» — два стани однієї речі
 * розійшлися б (урок DoD: один стан, а не паралельний прапорець). Тримає #579.
 *
 * Диск — параметром (`store`/`load`): гейти пишуть у тимчасову теку, прод — у теку документів
 * (вона в нічному бекапі).
 */
import { extractMarkers, fillDocx, autoFieldOf, OfferTemplateError, markerKey } from "./offerTemplate.js";
import { signatureState } from "./docAccess.js";
import { HiringError, type Db } from "./hiring.js";

export type Store = (display: string, buf: Buffer) => Promise<{ storedName: string; sha256: string }>;
export type Load = (storedName: string) => Promise<Buffer>;

const kyivDate = (d = new Date()) => d.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" });
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function listTemplates(db: Db) {
  return (await db.query<{ id: number; title: string; markers: string[]; is_active: boolean; created_at: string; author: string | null }>(
    `SELECT t.id, t.title, t.markers, t.is_active, t.created_at, COALESCE(NULLIF(u.full_name, ''), u.email) AS author
       FROM offer_templates t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.is_active DESC, t.title`)).rows
    .map((t) => ({ ...t, fields: t.markers.map((m) => ({ marker: m, auto: autoFieldOf(m) })) }));
}

/** Новий шаблон: .docx з хоча б однією міткою `{{…}}`. Мітки зберігаються — форма знає поля без читання файла. */
export async function createTemplate(db: Db, actorId: number, title: unknown, buf: Buffer | null, store: Store) {
  const t = typeof title === "string" ? title.trim().slice(0, 120) : "";
  if (!t) throw new HiringError(400, "Назва шаблону порожня");
  if (!buf || !buf.length) throw new HiringError(400, "Файл шаблону відсутній");
  let markers: string[];
  try { markers = extractMarkers(buf); } catch (e) { throw new HiringError(400, (e as Error).message); }
  if (!markers.length) throw new HiringError(400, "У шаблоні немає жодної мітки {{…}} — нічого підставляти");
  const { storedName } = await store(`шаблон-${t}.docx`, buf);
  const r = await db.query<{ id: number }>(
    `INSERT INTO offer_templates (title, stored_name, markers, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [t, storedName, JSON.stringify(markers), actorId]);
  return { id: r.rows[0].id, markers };
}

export async function setTemplateActive(db: Db, id: number, active: boolean) {
  const r = await db.query(`UPDATE offer_templates SET is_active = $2 WHERE id = $1`, [id, active]);
  if (!r.rowCount) throw new HiringError(404, "Шаблон не знайдено");
}

type Card = { id: number; full_name: string; phone: string | null; email: string | null; position: string | null; status: string;
  user_id: number | null; offer_doc_id: number | null; team: string | null; lead: string | null; vacancy: string | null };

async function card(db: Db, id: number, lock = false): Promise<Card> {
  const c = (await db.query<Card>(
    `SELECT c.id, c.full_name, c.phone, c.email, c.position, c.status, c.user_id, c.offer_doc_id, t.name AS team,
            (SELECT COALESCE(NULLIF(u.full_name, ''), m.name) FROM users u LEFT JOIN managers m ON m.id = u.manager_id
              WHERE u.team_id = c.team_id AND COALESCE(u.role_override, u.role) = 'team_lead' AND u.is_active ORDER BY u.id LIMIT 1) AS lead,
            (SELECT COALESCE(v.position, v.title) FROM hiring_candidate_vacancies cv JOIN hiring_vacancies v ON v.id = cv.vacancy_id
              WHERE cv.candidate_id = c.id ORDER BY cv.created_at LIMIT 1) AS vacancy
       FROM hiring_candidates c LEFT JOIN teams t ON t.id = c.team_id WHERE c.id = $1${lock ? " FOR UPDATE OF c" : ""}`, [id])).rows[0];
  if (!c) throw new HiringError(404, "Кандидата не знайдено");
  return c;
}

const autoValue = (c: Card, field: string): string | null => ({
  ПІБ: c.full_name, Посада: c.position ?? c.vacancy, Команда: c.team, Тімлід: c.lead, Дата: kyivDate(), Телефон: c.phone, Пошта: c.email,
} as Record<string, string | null>)[field] ?? null;

async function template(db: Db, id: unknown) {
  const tid = Number(id);
  if (!Number.isInteger(tid) || tid <= 0) throw new HiringError(400, "Оберіть шаблон");
  const t = (await db.query<{ id: number; title: string; stored_name: string; markers: string[]; is_active: boolean }>(
    `SELECT id, title, stored_name, markers, is_active FROM offer_templates WHERE id = $1`, [tid])).rows[0];
  if (!t) throw new HiringError(404, "Шаблон не знайдено");
  return t;
}

/** Стан оферу кандидата — з документа й підписів (`signatureState`), без власного прапорця. */
export async function offerState(db: Db, candidateId: number, now = new Date()) {
  const c = await card(db, candidateId);
  if (!c.offer_doc_id) return { state: "none" as const, docId: null, version: null, name: null, sentAt: null };
  const d = (await db.query<{ id: number; name: string; version: number; sha256: string; archived_at: string | null; sent_at: string | null }>(
    `SELECT f.id, f.name, f.version, f.sha256, f.archived_at,
            (SELECT max(e.at) FROM doc_events e WHERE e.file_id = f.id AND e.kind = 'sent') AS sent_at
       FROM doc_files f WHERE f.id = $1`, [c.offer_doc_id])).rows[0];
  if (!d) return { state: "none" as const, docId: null, version: null, name: null, sentAt: null };
  const sigs = (await db.query<{ version: number; sha256: string; method: string; approved_at: string | null; rejected_at: string | null }>(
    `SELECT version, sha256, method, approved_at, rejected_at FROM doc_signatures WHERE file_id = $1`, [d.id])).rows
    .map((s) => ({ version: s.version, sha256: s.sha256, method: s.method, approvedAt: s.approved_at, rejectedAt: s.rejected_at }));
  const st = signatureState({ version: d.version, sha256: d.sha256, section: "offer" }, sigs as never, now, d.sent_at);
  return { state: st.kind, days: st.days, docId: d.id, version: d.version, name: d.name, sentAt: d.sent_at };
}

/** Форма оферу: поля шаблону з тим, що дашборд знає сам; решту — дописати. */
export async function offerForm(db: Db, candidateId: number, templateId: unknown) {
  const c = await card(db, candidateId);
  const t = await template(db, templateId);
  return {
    template: { id: t.id, title: t.title },
    fields: t.markers.map((m) => { const auto = autoFieldOf(m); return { marker: m, auto, value: auto ? autoValue(c, auto) : null }; }),
  };
}

/**
 * Сформувати офер. Кандидат — з акаунтом (адресат документа) і в «кандидат + команда» / «на навчанні».
 * Перший раз — новий документ розділу «Офери»; далі — НОВА ВЕРСІЯ того самого документа: інша sha256,
 * тож підпис попередньої версії для нової не рахується (`signatureState` → «застарів»). Тримає #577/#578.
 */
export async function generateOffer(db: Db, actorId: number, candidateId: number, templateId: unknown, manual: unknown, store: Store, load: Load) {
  const c = await card(db, candidateId, true);
  if (c.status !== "candidate" && c.status !== "training") throw new HiringError(409, "Офер — для статусів «кандидат + команда» і «на навчанні»");
  if (!c.user_id) throw new HiringError(409, "У кандидата ще немає акаунта — офер нікому надіслати");
  const t = await template(db, templateId);
  if (!t.is_active) throw new HiringError(409, "Шаблон вимкнено");
  const extra = manual && typeof manual === "object" ? manual as Record<string, unknown> : {};
  const byKey = new Map(Object.entries(extra).map(([k, v]) => [markerKey(k), v == null ? "" : String(v)]));
  const values: Record<string, string> = {};
  for (const m of t.markers) {
    const typed = byKey.get(markerKey(m));
    const auto = autoFieldOf(m);
    const v = typed != null && typed.trim() !== "" ? typed : auto ? autoValue(c, auto) : null;
    if (v != null) values[m] = v;
  }
  let out: Buffer;
  try { out = fillDocx(await load(t.stored_name), values); }
  catch (e) { if (e instanceof OfferTemplateError) throw new HiringError(e.status, e.message, e.fields ? { fields: e.fields } : undefined); throw e; }
  const display = `Офер — ${c.full_name}.docx`;
  const { storedName, sha256 } = await store(display, out);
  const cur = c.offer_doc_id ? (await db.query<{ id: number; version: number; archived_at: string | null }>(
    `SELECT id, version, archived_at FROM doc_files WHERE id = $1 FOR UPDATE`, [c.offer_doc_id])).rows[0] : null;
  let docId: number, version: number;
  if (cur && !cur.archived_at) {
    docId = cur.id; version = cur.version + 1;
    await db.query(`INSERT INTO doc_file_versions (file_id, version, stored_name, sha256, mime, size_bytes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [docId, version, storedName, sha256, DOCX_MIME, out.length, actorId]);
    await db.query(`UPDATE doc_files SET stored_name = $2, sha256 = $3, version = $4, mime = $5, size_bytes = $6, name = $7, reminded_at = NULL, updated_at = now() WHERE id = $1`,
      [docId, storedName, sha256, version, DOCX_MIME, out.length, display]);
    await db.query(`INSERT INTO doc_events (file_id, kind, actor_id, details) VALUES ($1, 'version', $2, $3), ($1, 'sent', $2, $4)`,
      [docId, actorId, JSON.stringify({ version, sha256, template: t.title }), JSON.stringify({ version })]);
  } else {
    version = 1;
    docId = (await db.query<{ id: number }>(
      `INSERT INTO doc_files (folder_id, name, stored_name, category, mime, size_bytes, created_by, section, addressee_user_id, description, version, sha256)
       VALUES (NULL, $1, $2, 'Офер', $3, $4, $5, 'offer', $6, $7, 1, $8) RETURNING id`,
      [display, storedName, DOCX_MIME, out.length, actorId, c.user_id, `Сформовано з шаблону «${t.title}» у «Наймі»`, sha256])).rows[0].id;
    await db.query(`INSERT INTO doc_file_versions (file_id, version, stored_name, sha256, mime, size_bytes, created_by) VALUES ($1, 1, $2, $3, $4, $5, $6)`,
      [docId, storedName, sha256, DOCX_MIME, out.length, actorId]);
    await db.query(`INSERT INTO doc_events (file_id, kind, actor_id, details) VALUES ($1, 'sent', $2, $3)`, [docId, actorId, JSON.stringify({ version: 1, template: t.title })]);
    await db.query(`UPDATE hiring_candidates SET offer_doc_id = $2, updated_at = now() WHERE id = $1`, [candidateId, docId]);
  }
  await db.query(`INSERT INTO hiring_events (candidate_id, kind, comment, actor_id) VALUES ($1, 'offer', $2, $3)`,
    [candidateId, version === 1 ? `офер сформовано з шаблону «${t.title}»` : `офер оновлено (версія ${version}, шаблон «${t.title}») — потрібен новий підпис`, actorId]);
  return { docId, version, name: display };
}

/** Стан оферів для списку кандидатів (дошка навчання, зведення). */
export async function offerStates(db: Db, now = new Date()) {
  const ids = (await db.query<{ id: number }>(`SELECT id FROM hiring_candidates WHERE offer_doc_id IS NOT NULL`)).rows;
  const out: Record<number, string> = {};
  for (const { id } of ids) out[id] = (await offerState(db, id, now)).state;
  return out;
}
