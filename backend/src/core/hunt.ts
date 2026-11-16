/**
 * 🎯 ХАНТИНГ (15–16.11.2026, ТЗ Івана, погоджено Сергієм) — «Радар Ларді» і «Воронка кандидатів».
 *
 * Джерело радару (прохід 3) — ПОДІЇ `lardi_proposal_events` над заявками `lardi_proposals`:
 *  · 'live' — живий скан `syncLardi` кожні 15 хв (`core/lardiSync.ts`): публікація на `dateCreate`, підняття на
 *    `dateRepeat` — справжній час Ларді. Лише з них рахуються «за годину», години публікації й автоповтор;
 *  · 'archive' — одноразово перенесений архів `collectLardi` (35 днів): час = наш скан раз на 3 год, без області й
 *    країни. Тому архівні контакти не потрапляють у фільтр області, а «за годину» для них завжди 0.
 * Пошук Ларді з 12.11.2026 віддає 403 (не оплачено «Розширений доступ до API») — доки так, у радарі лише архів.
 * Контакт (менеджер) = `ckey`: найменший номер телефону цифрами, без телефону — «компанія|імʼя».
 * Свої компанії (ЮТС, АвтоМув) — поза радаром за назвою і за `OWN_LARDI_REF_IDS`. Тримає #3960–#3969.
 */
import type { Db } from "./secrets.js";
import { botLike, typicalHours } from "./lardiSync.js";

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

/** Ключ контакту з телефонів Ларді: найменший номер цифрами. Чиста — щоб її однаково рахували радар, скан і воронка. */
export function contactKey(phones: unknown, company: string | null, face: string | null): string {
  const nums = (Array.isArray(phones) ? phones : []).map((p) => String((p as { n?: unknown })?.n ?? "").replace(/\D/g, "")).filter(Boolean).sort();
  return nums[0] ?? `${(company ?? "").trim().toLowerCase()}|${(face ?? "").trim().toLowerCase()}`;
}

/** Телефон частково прихований до дії «Показати» (ТЗ п.9): лишаємо код країни/оператора й 2 останні цифри. */
export const maskPhone = (n: string) => { const d = n.replace(/\D/g, ""); return d.length < 7 ? "•••" : `+${d.slice(0, 5)} ••• •• ${d.slice(-2)}`; };

/** Сутності HTML у назвах Ларді («&quot;Балі Сервіс&quot;») — одна розшифровка для всіх читачів. */
export const unentity = (s: string | null) => (s ?? "").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();

/** Свої компанії — поза радаром (ТЗ п.4). За назвою — завжди; за ID на Ларді — коли їх назвуть (ВІДКРИТЕ ПИТАННЯ ТЗ п.11). */
export const OWN_COMPANY_SQL = `COALESCE(company, '') !~* '^\\s*(ютс|uts|автомув|automove)\\M'`;
export const OWN_LARDI_REF_IDS: readonly number[] = [];

// Події за 30 днів із полями заявки. Країна NULL (архів) читається як Україна: архів збирався лише по наших маршрутах.
const EVENTS_CTE = `
k AS (
  SELECT e.kind AS side, e.type, e.at, e.source, p.id AS pid, p.ref_id, p.ckey, p.company, p.face, p.phones,
         p.from_town AS frm, p.to_town AS tox, p.from_area, p.price AS total, p.auto_repeat,
         (COALESCE(p.from_country, 'UA') <> 'UA' OR COALESCE(p.to_country, 'UA') <> 'UA') AS intl,
         EXISTS (SELECT 1 FROM lardi_shippers s WHERE s.ref_id = p.ref_id) AS shipper
    FROM lardi_proposal_events e
    JOIN lardi_proposals p ON p.kind = e.kind AND p.id = e.proposal_id
   WHERE e.at >= now() - interval '30 days' AND ${OWN_COMPANY_SQL.replace("company", "p.company")}
     AND NOT (COALESCE(p.ref_id, 0) = ANY ($OWN::bigint[])))`;
const ownIds = () => [...OWN_LARDI_REF_IDS];
/** Підставляє номер параметра з ID своїх компаній у CTE. */
const cte = (n: number) => EVENTS_CTE.replace("$OWN", `$${String(n)}`);

export interface RadarRow {
  key: string; face: string; company: string; phones: string[]; h1: number; d1: number; d7: number; d30: number; cargo: number; lorry: number;
  pricePct: number; top: { dir: string; n: number }[]; lastSeen: string; candidate: { id: number; stage: HuntStage } | null;
  intl: number; area: string | null; shipper: boolean; bot: boolean; hours: { from: number; to: number; n: number } | null; live: boolean;
}

/** Топ-2 напрямки за кількістю — чиста, щоб гейт перевіряв саме правило. */
export function topDirections(dirs: string[], n = 2): { dir: string; n: number }[] {
  const m = new Map<string, number>();
  for (const d of dirs) m.set(d, (m.get(d) ?? 0) + 1);
  return [...m].map(([dir, c]) => ({ dir, n: c })).sort((a, b) => b.n - a.n || a.dir.localeCompare(b.dir, "uk")).slice(0, n);
}

export const PERIODS = { h1: "1 hour", d1: "today", d7: "7 days", d30: "30 days" } as const;
type Period = keyof typeof PERIODS;

/**
 * Радар: найактивніші контакти за подіями (`new` + `repeat`, ТЗ п.6). `period` — сортування й відбір (h1/d1/d7/d30;
 * d1 = сьогодні за Києвом). Фільтри: `side`, `dir` (ua/intl), `area` (область відправки), `ctype` (no_shippers/shippers),
 * `hideBots`, `show` (усі / не у воронці / у воронці), `q`.
 */
export async function radar(db: Db, opts: { period?: unknown; days?: unknown; show?: unknown; q?: unknown; side?: unknown; dir?: unknown; area?: unknown; ctype?: unknown; hideBots?: unknown }) {
  const legacy = { 1: "d1", 7: "d7", 30: "d30" } as Record<number, Period>;
  const period: Period = typeof opts.period === "string" && opts.period in PERIODS ? opts.period as Period : legacy[Number(opts.days)] ?? "d30";
  const show = opts.show === "new" || opts.show === "funnel" ? opts.show : "all";
  const side = opts.side === "cargo" || opts.side === "lorry" ? opts.side : null;
  const dir = opts.dir === "ua" || opts.dir === "intl" ? opts.dir : null;
  const ctype = opts.ctype === "no_shippers" || opts.ctype === "shippers" ? opts.ctype : null;
  const area = typeof opts.area === "string" && opts.area.trim() ? opts.area.trim().slice(0, 80) : null;
  const hideBots = opts.hideBots === true || opts.hideBots === "1" || opts.hideBots === "true";
  const q = typeof opts.q === "string" ? opts.q.trim().toLowerCase().slice(0, 80) : "";
  const since = period === "h1" ? `now() - interval '1 hour'` : period === "d1" ? `(date_trunc('day', now() AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv')`
    : period === "d7" ? `now() - interval '7 days'` : `now() - interval '30 days'`;
  const rows = (await db.query<{ ckey: string; face: string; company: string; phones: unknown; h1: number; d1: number; d7: number; d30: number;
    cargo: number; lorry: number; price_pct: number; dirs: string[]; last_seen: string; intl: number; area: string | null; shipper: boolean;
    auto: boolean; live_times: string[] | null }>(
    `WITH ${cte(6)}, f AS (
       SELECT * FROM k
        WHERE ($1::text IS NULL OR side = $1)
          AND ($2::text IS NULL OR ($2 = 'intl') = intl)
          AND ($3::text IS NULL OR ($3 = 'shippers') = shipper)
          AND ($4::text IS NULL OR from_area ILIKE '%' || $4 || '%')
          AND ($5 = '' OR lower(COALESCE(face, '') || ' ' || COALESCE(company, '') || ' ' || COALESCE(phones::text, '')) LIKE '%' || $5 || '%'))
     SELECT ckey, max(face) AS face, max(company) AS company, (array_agg(phones ORDER BY at DESC))[1] AS phones,
            count(*) FILTER (WHERE at >= now() - interval '1 hour')::int AS h1,
            count(*) FILTER (WHERE at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv'))::int AS d1,
            count(*) FILTER (WHERE at >= now() - interval '7 days')::int AS d7,
            count(*)::int AS d30,
            count(*) FILTER (WHERE side = 'cargo')::int AS cargo, count(*) FILTER (WHERE side = 'lorry')::int AS lorry,
            round(100.0 * count(DISTINCT (side, pid)) FILTER (WHERE total IS NOT NULL) / greatest(count(DISTINCT (side, pid)), 1))::int AS price_pct,
            array_agg(COALESCE(frm, '—') || ' → ' || COALESCE(tox, '—')) AS dirs,
            max(at)::text AS last_seen, count(*) FILTER (WHERE intl)::int AS intl,
            mode() WITHIN GROUP (ORDER BY from_area) AS area, bool_or(shipper) AS shipper, bool_or(auto_repeat) AS auto,
            array_agg(at::text ORDER BY at) FILTER (WHERE source = 'live') AS live_times
       FROM f
      GROUP BY ckey
     HAVING count(*) FILTER (WHERE at >= ${since}) > 0
      ORDER BY ${period} DESC, d30 DESC
      LIMIT 300`, [side, dir, ctype, area, q, ownIds()])).rows;
  const cands = new Map((await db.query<{ contact_key: string; id: number; stage: HuntStage }>(
    `SELECT contact_key, id, stage FROM hunt_candidates WHERE stage <> 'rejected'`)).rows.map((r) => [r.contact_key, { id: r.id, stage: r.stage }]));
  const out: RadarRow[] = rows.map((r) => {
    const live = r.live_times ?? [];
    return {
      key: r.ckey, face: unentity(r.face) || "без імені", company: unentity(r.company) || "без назви",
      phones: (Array.isArray(r.phones) ? r.phones : []).map((p) => maskPhone(String((p as { n?: unknown }).n ?? ""))),
      h1: r.h1, d1: r.d1, d7: r.d7, d30: r.d30, cargo: r.cargo, lorry: r.lorry, pricePct: r.price_pct,
      top: topDirections(r.dirs), lastSeen: r.last_seen, candidate: cands.get(r.ckey) ?? null,
      intl: r.intl, area: r.area, shipper: r.shipper, bot: botLike(live, r.auto), hours: typicalHours(live), live: live.length > 0,
    };
  }).filter((r) => (show === "all" || (show === "new" ? !r.candidate : !!r.candidate)) && !(hideBots && r.bot));
  const st = (await db.query<{ archive_until: string | null; live_until: string | null; live_since: string | null; err: string | null; err_at: string | null; ok_at: string | null }>(
    `SELECT (SELECT max(at)::text FROM lardi_proposal_events WHERE source = 'archive') AS archive_until,
            (SELECT max(last_seen_at)::text FROM lardi_proposals WHERE source = 'live') AS live_until,
            (SELECT min(first_seen_at)::text FROM lardi_proposals WHERE source = 'live') AS live_since,
            j.last_error AS err, j.last_error_at::text AS err_at, j.last_success_at::text AS ok_at
       FROM (SELECT 1) one LEFT JOIN job_runs j ON j.name = 'syncLardi'`)).rows[0];
  const areas = (await db.query<{ a: string }>(
    `SELECT DISTINCT from_area AS a FROM lardi_proposals WHERE from_area IS NOT NULL AND last_seen_at >= now() - interval '30 days' ORDER BY 1 LIMIT 60`)).rows.map((r) => r.a);
  // Помилка «свіжа», якщо вона пізніша за останній успіх (успіх не стирає `last_error`, jobs-sync.md).
  const liveError = st?.err && (!st.ok_at || (st.err_at ?? "") > st.ok_at) ? st.err : null;
  return {
    period, rows: out.slice(0, 200), areas,
    dataUntil: st?.live_until ?? st?.archive_until ?? null,
    live: { since: st?.live_since ?? null, until: st?.live_until ?? null, error: liveError, errorAt: liveError ? st?.err_at ?? null : null },
    archiveUntil: st?.archive_until ?? null,
    totals: {
      offers: out.reduce((a, r) => a + r[period], 0), contacts: out.length,
      companies: new Set(out.map((r) => r.company)).size, bots: out.filter((r) => r.bot).length,
      notInFunnel: out.filter((r) => !r.candidate).length, inFunnel: cands.size,
    },
  };
}

/** Активність контакту за 30 днів по днях + напрямки + години — для картки праворуч. Телефонів НЕ віддає. */
export async function contactActivity(db: Db, key: string) {
  const rows = (await db.query<{ d: string; n: number }>(
    `WITH ${cte(2)} SELECT ((at AT TIME ZONE 'Europe/Kyiv')::date)::text AS d, count(*)::int AS n FROM k WHERE ckey = $1 GROUP BY 1 ORDER BY 1`, [key, ownIds()])).rows;
  const ev = (await db.query<{ dir: string; at: string; source: string; auto_repeat: boolean }>(
    `WITH ${cte(2)} SELECT COALESCE(frm, '—') || ' → ' || COALESCE(tox, '—') AS dir, at::text AS at, source, auto_repeat FROM k WHERE ckey = $1`, [key, ownIds()])).rows;
  if (!rows.length) throw new HuntError(404, "Контакт за 30 днів не знайдено");
  const live = ev.filter((e) => e.source === "live").map((e) => e.at);
  return { days: rows, top: topDirections(ev.map((e) => e.dir), 5), hours: typicalHours(live), bot: botLike(live, ev.some((e) => e.auto_repeat)), live: live.length > 0 };
}

/** «Показати телефон»: повні номери + запис у журнал переглядів (ТЗ п.9). */
export async function revealPhones(db: Db, userId: number, key: unknown) {
  if (typeof key !== "string" || !key.trim()) throw new HuntError(400, "Не вказано контакт");
  const r = (await db.query<{ phones: unknown }>(
    `SELECT phones FROM lardi_proposals WHERE ckey = $1 ORDER BY last_seen_at DESC LIMIT 1`, [key])).rows[0];
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
    `WITH ${cte(2)}
     SELECT max(face) AS face, max(company) AS company, (array_agg(phones ORDER BY at DESC))[1] AS phones,
            count(*) FILTER (WHERE at >= now() - interval '7 days')::int AS d7, count(*)::int AS d30,
            array_agg(COALESCE(frm, '—') || ' → ' || COALESCE(tox, '—')) AS dirs
       FROM k WHERE ckey = $1`, [key, ownIds()])).rows[0];
  if (!r || r.d30 === 0) throw new HuntError(404, "Контакт за 30 днів не знайдено");
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
