/**
 * 🎯 ХАНТИНГ (15.11.2026, ТЗ Івана, погоджено Сергієм) — проходи 1–2: «Радар Ларді» і «Воронка кандидатів».
 *
 * Джерело радару — архів `lardi_offers`, який збирає `collectLardi` (кожні 3 год по ~110 наших маршрутах). Це НЕ весь
 * Ларді і не живий скан: живий `syncLardi` (прохід 3) можливий лише з пакетом «Розширений доступ до API», а він не діє
 * з 12.11.2026 (пошук 403). Тому:
 *  · рахуємо УНІКАЛЬНІ заявки (`side`, `offer_id`): одну заявку збирач бачить кілька разів (заміряно 30 днів: 192 тис.
 *    записів = 80 тис. заявок);
 *  · «за годину» й «години публікації» не рахуємо: `first_seen` — час НАШОГО скану раз на 3 год, а не публікації;
 *  · тип компанії Ларді не віддає взагалі (заміряно 13.11), тож вантажовласників від експедиторів не відсіяти.
 * Контакт (менеджер) = `contact_key`: найменший номер телефону цифрами, без телефону — «компанія|імʼя».
 * Свої компанії (ЮТС) виключаються за назвою. Тримає #3960–#3965.
 */
import type { Db } from "./secrets.js";

export class HuntError extends Error { constructor(public status: number, message: string) { super(message); } }

export const HUNT_STAGES = [
  ["picked", "Обрано"], ["call", "Дзвінок"], ["interview", "Співбесіда"], ["approval", "Погодження"], ["offer", "Оффер"], ["hired", "Вийшов на роботу"],
] as const;
export type HuntStage = (typeof HUNT_STAGES)[number][0] | "rejected";
const STAGE_KEYS = new Set<string>([...HUNT_STAGES.map(([k]) => k), "rejected"]);
export const REJECT_REASONS = [["salary", "Зарплата"], ["not_ready", "Не готовий переходити"], ["not_fit", "Не підійшов"], ["other", "Інше"]] as const;
const REASON_KEYS = new Set<string>(REJECT_REASONS.map(([k]) => k));

/** Поіменний доступ (рішення Романа 15.11): роль не дає нічого, навіть адмінська. */
export async function huntAllowed(db: Db, userId: number): Promise<boolean> {
  return ((await db.query(`SELECT 1 FROM hunt_access WHERE user_id = $1`, [userId])).rowCount ?? 0) > 0;
}

/** Ключ контакту з телефонів Ларді: найменший номер цифрами. Чиста — щоб її однаково рахували радар і воронка. */
export function contactKey(phones: unknown, company: string | null, face: string | null): string {
  const nums = (Array.isArray(phones) ? phones : []).map((p) => String((p as { n?: unknown })?.n ?? "").replace(/\D/g, "")).filter(Boolean).sort();
  return nums[0] ?? `${(company ?? "").trim().toLowerCase()}|${(face ?? "").trim().toLowerCase()}`;
}

/** Телефон частково прихований до дії «Показати» (ТЗ п.9): лишаємо код країни/оператора й 2 останні цифри. */
export const maskPhone = (n: string) => { const d = n.replace(/\D/g, ""); return d.length < 7 ? "•••" : `+${d.slice(0, 5)} ••• •• ${d.slice(-2)}`; };

/** Сутності HTML у назвах Ларді («&quot;Балі Сервіс&quot;») — одна розшифровка для всіх читачів. */
export const unentity = (s: string | null) => (s ?? "").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();

/** Свої компанії — поза радаром (ТЗ п.4). Поки немає ID на Ларді — за назвою. */
export const OWN_COMPANY_SQL = `COALESCE(company, '') !~* '^\\s*(ютс|uts|автомув|automove)\\M'`;

// Унікальні заявки за 30 днів із ключем контакту. `ph` рахується в SQL тим самим правилом, що `contactKey`.
const OFFERS_CTE = `
o AS (
  SELECT DISTINCT ON (side, offer_id) side, offer_id, company, face, phones, frm, tox, total, first_seen,
         (SELECT min(regexp_replace(p->>'n', '\\D', '', 'g')) FROM jsonb_array_elements(COALESCE(phones, '[]'::jsonb)) p) AS ph
    FROM lardi_offers
   WHERE first_seen >= now() - interval '30 days' AND ${OWN_COMPANY_SQL}
   ORDER BY side, offer_id, first_seen),
k AS (SELECT o.*, COALESCE(NULLIF(ph, ''), lower(btrim(COALESCE(company, ''))) || '|' || lower(btrim(COALESCE(face, '')))) AS ckey FROM o)`;

export interface RadarRow {
  key: string; face: string; company: string; phones: string[]; d1: number; d7: number; d30: number; cargo: number; lorry: number;
  pricePct: number; top: { dir: string; n: number }[]; lastSeen: string; candidate: { id: number; stage: HuntStage } | null;
}

/** Топ-2 напрямки за кількістю — чиста, щоб гейт перевіряв саме правило. */
export function topDirections(dirs: string[], n = 2): { dir: string; n: number }[] {
  const m = new Map<string, number>();
  for (const d of dirs) m.set(d, (m.get(d) ?? 0) + 1);
  return [...m].map(([dir, c]) => ({ dir, n: c })).sort((a, b) => b.n - a.n || a.dir.localeCompare(b.dir, "uk")).slice(0, n);
}

/** Радар: найактивніші контакти. `days` — період сортування (1/7/30), `show` — усі / не у воронці / у воронці. */
export async function radar(db: Db, opts: { days?: unknown; show?: unknown; q?: unknown; side?: unknown }) {
  const days = [1, 7, 30].includes(Number(opts.days)) ? Number(opts.days) : 30;
  const show = opts.show === "new" || opts.show === "funnel" ? opts.show : "all";
  const side = opts.side === "cargo" || opts.side === "lorry" ? opts.side : null;
  const q = typeof opts.q === "string" ? opts.q.trim().toLowerCase().slice(0, 80) : "";
  const col = days === 1 ? "d1" : days === 7 ? "d7" : "d30";
  const rows = (await db.query<{ ckey: string; face: string; company: string; phones: unknown; d1: number; d7: number; d30: number; cargo: number; lorry: number; price_pct: number; dirs: string[]; last_seen: string }>(
    `WITH ${OFFERS_CTE}
     SELECT ckey, max(face) AS face, max(company) AS company, (array_agg(phones ORDER BY first_seen DESC))[1] AS phones,
            count(*) FILTER (WHERE first_seen >= now() - interval '1 day')::int AS d1,
            count(*) FILTER (WHERE first_seen >= now() - interval '7 days')::int AS d7,
            count(*)::int AS d30,
            count(*) FILTER (WHERE side = 'cargo')::int AS cargo, count(*) FILTER (WHERE side = 'lorry')::int AS lorry,
            round(100.0 * count(total) / count(*))::int AS price_pct,
            array_agg(COALESCE(frm, '—') || ' → ' || COALESCE(tox, '—')) AS dirs,
            max(first_seen)::text AS last_seen
       FROM k
      WHERE ($1::text IS NULL OR side = $1)
        AND ($2 = '' OR lower(COALESCE(face, '') || ' ' || COALESCE(company, '') || ' ' || COALESCE(phones::text, '')) LIKE '%' || $2 || '%')
      GROUP BY ckey
     HAVING count(*) FILTER (WHERE first_seen >= now() - make_interval(days => $3)) > 0
      ORDER BY ${col} DESC, d30 DESC
      LIMIT 300`, [side, q, days])).rows;
  const cands = new Map((await db.query<{ contact_key: string; id: number; stage: HuntStage }>(
    `SELECT contact_key, id, stage FROM hunt_candidates WHERE stage <> 'rejected'`)).rows.map((r) => [r.contact_key, { id: r.id, stage: r.stage }]));
  const out: RadarRow[] = rows.map((r) => ({
    key: r.ckey, face: unentity(r.face) || "без імені", company: unentity(r.company) || "без назви",
    phones: (Array.isArray(r.phones) ? r.phones : []).map((p) => maskPhone(String((p as { n?: unknown }).n ?? ""))),
    d1: r.d1, d7: r.d7, d30: r.d30, cargo: r.cargo, lorry: r.lorry, pricePct: r.price_pct,
    top: topDirections(r.dirs), lastSeen: r.last_seen, candidate: cands.get(r.ckey) ?? null,
  })).filter((r) => show === "all" || (show === "new" ? !r.candidate : !!r.candidate));
  const fresh = (await db.query<{ last: string | null }>(`SELECT max(first_seen)::text AS last FROM lardi_offers`)).rows[0]?.last ?? null;
  return {
    days, rows: out.slice(0, 200), dataUntil: fresh,
    totals: {
      offers: out.reduce((a, r) => a + r[col], 0), contacts: out.length,
      companies: new Set(out.map((r) => r.company)).size,
      notInFunnel: out.filter((r) => !r.candidate).length, inFunnel: cands.size,
    },
  };
}

/** Активність контакту за 30 днів по днях + напрямки — для картки праворуч. Телефонів НЕ віддає. */
export async function contactActivity(db: Db, key: string) {
  const rows = (await db.query<{ d: string; n: number }>(
    `WITH ${OFFERS_CTE} SELECT ((first_seen AT TIME ZONE 'Europe/Kyiv')::date)::text AS d, count(*)::int AS n FROM k WHERE ckey = $1 GROUP BY 1 ORDER BY 1`, [key])).rows;
  const dirs = (await db.query<{ dir: string }>(
    `WITH ${OFFERS_CTE} SELECT COALESCE(frm, '—') || ' → ' || COALESCE(tox, '—') AS dir FROM k WHERE ckey = $1`, [key])).rows.map((r) => r.dir);
  if (!rows.length) throw new HuntError(404, "Контакт за 30 днів у архіві не знайдено");
  return { days: rows, top: topDirections(dirs, 5) };
}

/** «Показати телефон»: повні номери + запис у журнал переглядів (ТЗ п.9). */
export async function revealPhones(db: Db, userId: number, key: unknown) {
  if (typeof key !== "string" || !key.trim()) throw new HuntError(400, "Не вказано контакт");
  const r = (await db.query<{ phones: unknown }>(
    `WITH ${OFFERS_CTE} SELECT phones FROM k WHERE ckey = $1 ORDER BY first_seen DESC LIMIT 1`, [key])).rows[0];
  const own = r ? null : (await db.query<{ phones: unknown }>(`SELECT phones FROM hunt_candidates WHERE contact_key = $1 ORDER BY id DESC LIMIT 1`, [key])).rows[0];
  const src = r ?? own;
  if (!src) throw new HuntError(404, "Контакт не знайдено");
  await db.query(`INSERT INTO hunt_phone_views (contact_key, user_id) VALUES ($1, $2)`, [key, userId]);
  return { phones: (Array.isArray(src.phones) ? src.phones : []).map((p) => String((p as { n?: unknown }).n ?? "")).filter(Boolean) };
}

const str = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const when = (v: unknown) => { if (v == null || v === "") return null; const t = Date.parse(String(v)); if (Number.isNaN(t)) throw new HuntError(400, "Дата не розпізнана"); return new Date(t).toISOString(); };

/** «+ У воронку»: кандидат на етапі «Обрано» зі знімком активності на момент додавання. Двічі живим — 409. */
export async function addCandidate(db: Db, userId: number, body: { key?: unknown; interest?: unknown }) {
  const key = str(body.key, 200);
  if (!key) throw new HuntError(400, "Не вказано контакт");
  if ((await db.query(`SELECT 1 FROM hunt_candidates WHERE contact_key = $1 AND stage <> 'rejected'`, [key])).rowCount)
    throw new HuntError(409, "Цей контакт уже у воронці");
  const r = (await db.query<{ face: string; company: string; phones: unknown; d7: number; d30: number; dirs: string[] }>(
    `WITH ${OFFERS_CTE}
     SELECT max(face) AS face, max(company) AS company, (array_agg(phones ORDER BY first_seen DESC))[1] AS phones,
            count(*) FILTER (WHERE first_seen >= now() - interval '7 days')::int AS d7, count(*)::int AS d30,
            array_agg(COALESCE(frm, '—') || ' → ' || COALESCE(tox, '—')) AS dirs
       FROM k WHERE ckey = $1`, [key])).rows[0];
  if (!r || r.d30 === 0) throw new HuntError(404, "Контакт за 30 днів у архіві не знайдено");
  const source = { from: "lardi", d7: r.d7, d30: r.d30, top: topDirections(r.dirs), at: new Date().toISOString() };
  const id = (await db.query<{ id: number }>(
    `INSERT INTO hunt_candidates (contact_key, full_name, company, phones, interest, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [key, unentity(r.face) || "без імені", unentity(r.company) || null, JSON.stringify(r.phones ?? []), str(body.interest, 1000), source, userId])).rows[0].id;
  await db.query(`INSERT INTO hunt_stage_history (candidate_id, from_stage, to_stage, user_id) VALUES ($1, NULL, 'picked', $2)`, [id, userId]);
  return { id };
}

const NAME = `COALESCE(u.full_name, mm.name, u.email)`;

export async function listCandidates(db: Db, opts: { q?: unknown; archived?: unknown }) {
  const q = typeof opts.q === "string" ? opts.q.trim().toLowerCase().slice(0, 80) : "";
  const rows = (await db.query(
    `SELECT c.id, c.full_name, c.company, c.phones, c.stage, c.stage_changed_at::text, c.next_step, c.next_step_at::text, c.interest,
            c.reject_reason, (SELECT text FROM hunt_comments h WHERE h.candidate_id = c.id ORDER BY h.created_at DESC LIMIT 1) AS last_comment
       FROM hunt_candidates c
      WHERE ($1 = '' OR lower(c.full_name || ' ' || COALESCE(c.company, '') || ' ' || c.phones::text) LIKE '%' || $1 || '%')
        AND (c.stage = 'rejected') = $2
      ORDER BY c.stage_changed_at DESC`, [q, opts.archived === "1" || opts.archived === true])).rows;
  return rows.map((r) => ({ ...r, phones: (Array.isArray(r.phones) ? r.phones : []).map((p: { n?: unknown }) => String(p.n ?? "")) }));
}

export async function candidateDetail(db: Db, id: number) {
  const c = (await db.query<Record<string, any>>(`SELECT c.*, c.stage_changed_at::text AS stage_changed_at, c.next_step_at::text AS next_step_at, c.interview_at::text AS interview_at,
                                    c.created_at::text AS created_at FROM hunt_candidates c WHERE id = $1`, [id])).rows[0];
  if (!c) throw new HuntError(404, "Кандидата не знайдено");
  const comments = (await db.query<Record<string, any>>(`SELECT h.id, 'comment' AS kind, h.text, h.remind_at::text AS remind_at, h.created_at::text AS at, ${NAME} AS who
                                      FROM hunt_comments h LEFT JOIN users u ON u.id = h.user_id LEFT JOIN managers mm ON mm.id = u.manager_id
                                     WHERE h.candidate_id = $1`, [id])).rows;
  const stages = (await db.query<Record<string, any>>(`SELECT s.id, 'stage' AS kind, s.from_stage, s.to_stage, s.reason, s.at::text AS at, ${NAME} AS who
                                    FROM hunt_stage_history s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN managers mm ON mm.id = u.manager_id
                                   WHERE s.candidate_id = $1`, [id])).rows;
  const timeline = [...comments, ...stages].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const out: Record<string, any> = { ...c, phones: (Array.isArray(c.phones) ? c.phones : []).map((p: { n?: unknown }) => String(p.n ?? "")), timeline };
  return out;
}

const EDIT: [string, string, "text" | "date"][] = [
  ["fullName", "full_name", "text"], ["position", "position", "text"], ["specialization", "specialization", "text"],
  ["salaryExpectation", "salary_expectation", "text"], ["interest", "interest", "text"], ["nextStep", "next_step", "text"],
  ["nextStepAt", "next_step_at", "date"], ["interviewAt", "interview_at", "date"],
];

export async function updateCandidate(db: Db, id: number, body: Record<string, unknown>) {
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, col, kind] of EDIT) {
    if (!(k in body)) continue;
    const v = kind === "date" ? when(body[k]) : str(body[k], k === "interest" ? 1000 : 300);
    if (k === "fullName" && !v) throw new HuntError(400, "Імʼя не може бути порожнім");
    vals.push(v); sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return { changed: 0 };
  vals.push(id);
  const r = await db.query(`UPDATE hunt_candidates SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
  if (!r.rowCount) throw new HuntError(404, "Кандидата не знайдено");
  return { changed: sets.length };
}

/** Зміна етапу — завжди з записом в історію; «Відмова» лише з причиною; повернення з відмови — якщо контакт не у воронці знову. */
export async function changeStage(db: Db, userId: number, id: number, body: { to?: unknown; reason?: unknown }) {
  const to = String(body.to ?? "");
  if (!STAGE_KEYS.has(to)) throw new HuntError(400, "Невідомий етап");
  const c = (await db.query<{ stage: string; contact_key: string }>(`SELECT stage, contact_key FROM hunt_candidates WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!c) throw new HuntError(404, "Кандидата не знайдено");
  if (c.stage === to) return { stage: to };
  const reason = to === "rejected" ? String(body.reason ?? "") : null;
  if (to === "rejected" && !REASON_KEYS.has(reason!)) throw new HuntError(400, "Оберіть причину відмови");
  if (c.stage === "rejected" && (await db.query(`SELECT 1 FROM hunt_candidates WHERE contact_key = $1 AND stage <> 'rejected' AND id <> $2`, [c.contact_key, id])).rowCount)
    throw new HuntError(409, "Цей контакт уже у воронці іншою карткою");
  await db.query(`UPDATE hunt_candidates SET stage = $2, reject_reason = $3, stage_changed_at = now(), updated_at = now() WHERE id = $1`, [id, to, reason]);
  await db.query(`INSERT INTO hunt_stage_history (candidate_id, from_stage, to_stage, reason, user_id) VALUES ($1, $2, $3, $4, $5)`, [id, c.stage, to, reason, userId]);
  return { stage: to };
}

export async function addComment(db: Db, userId: number, id: number, body: { text?: unknown; remindAt?: unknown }) {
  const text = str(body.text, 3000);
  if (!text) throw new HuntError(400, "Порожній коментар");
  if (!(await db.query(`SELECT 1 FROM hunt_candidates WHERE id = $1`, [id])).rowCount) throw new HuntError(404, "Кандидата не знайдено");
  const r = (await db.query<{ id: number }>(`INSERT INTO hunt_comments (candidate_id, user_id, text, remind_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [id, userId, text, when(body.remindAt)])).rows[0];
  await db.query(`UPDATE hunt_candidates SET updated_at = now() WHERE id = $1`, [id]);
  return { id: r.id };
}
