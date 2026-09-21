/**
 * 📊 «НАЙМ → ЗВЕДЕННЯ»: воронка рекрутингу (18.09.2026, етап 2 плану за зустріччю 15.09).
 *
 * Іван (огляд Хурми): «статистика по статусах: скільки додано нових, скільком написали перше
 * повідомлення, скільком призначили співбесіду, скільки було співбесід… усього відмов, відсоток
 * відмов кандидата і відмов компанії — де ми на якому етапі найбільше втрачаємо кандидатів».
 *
 * КОГОРТА — кандидати, ДОДАНІ за період (київські дати, обидва кінці включно). «Дійшов до етапу» —
 * найдальший етап, який людина мала будь-коли (історія статусів + поточний): хто перескочив «перше
 * повідомлення» одразу в «призначено», теж пройшов «перше повідомлення». Тому воронка не зростає вниз.
 * Конверсія — від ПОПЕРЕДНЬОГО етапу (відносна) і від першого (загальна).
 */
import type { Db } from "./secrets.js";
import { HiringError } from "./hiring.js";
import { offerState } from "./offers.js";

export const FUNNEL_STAGES = [
  ["new", "Нові"], ["contacted", "Перше повідомлення"], ["planned", "Призначено співбесіду"], ["done", "Співбесіда відбулась"],
  ["lead", "Співбесіда з тімлідом"], ["candidate", "Кандидат + команда"], ["training", "На навчанні"], ["manager", "Менеджер"],
] as const;
const RANK: Record<string, number> = Object.fromEntries(FUNNEL_STAGES.map(([k], i) => [k, i]));
/** Бічні статуси не просувають воронку: «не прийшов» — це «призначено», «недозвон» — «новий». */
const SIDE_RANK: Record<string, number> = { noshow: RANK.planned, noanswer: RANK.new };
const rankOf = (s: string | null | undefined) => (s == null ? -1 : RANK[s] ?? SIDE_RANK[s] ?? -1);

export interface FunnelCandidate {
  id: number; source: string | null; status: string; visited: string[];
  refusal_side: string | null; refusal_reason: string | null; reserved: boolean; vacancies: { id: number; title: string }[];
}

export interface FunnelStage { key: string; label: string; count: number; fromPrev: number | null; fromFirst: number | null; lost: number }

/** Найдальший етап людини: історія статусів + поточний. */
export const reachedRank = (c: Pick<FunnelCandidate, "status" | "visited">) =>
  Math.max(0, rankOf(c.status), ...c.visited.map(rankOf));

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** Чиста воронка з когорти. Тримає #573/#574. */
export function buildFunnel(cs: FunnelCandidate[]): FunnelStage[] {
  const reached = FUNNEL_STAGES.map((_, i) => cs.filter((c) => reachedRank(c) >= i).length);
  return FUNNEL_STAGES.map(([key, label], i) => ({
    key, label, count: reached[i],
    fromPrev: i === 0 ? null : pct(reached[i], reached[i - 1]),
    fromFirst: i === 0 ? null : pct(reached[i], reached[0]),
    lost: i === FUNNEL_STAGES.length - 1 ? 0 : reached[i] - reached[i + 1],
  }));
}

/** Відмови: кандидата / компанії (чорний список — теж компанії), частки від усієї когорти й від відмов, топ причин. */
export function buildRefusals(cs: FunnelCandidate[]) {
  const refused = cs.filter((c) => c.status === "refused" || c.status === "black");
  const side = (c: FunnelCandidate) => (c.status === "black" ? "company" : c.refusal_side === "candidate" ? "candidate" : c.refusal_side === "company" ? "company" : "unknown");
  const bySide = { candidate: 0, company: 0, unknown: 0 };
  const reasons = new Map<string, { side: string; label: string; n: number }>();
  for (const c of refused) {
    const sd = side(c); bySide[sd]++;
    const label = c.refusal_reason ?? (c.status === "black" ? "чорний список" : "причину не вказано");
    const k = `${sd}|${label}`;
    reasons.set(k, { side: sd, label, n: (reasons.get(k)?.n ?? 0) + 1 });
  }
  return {
    total: refused.length, share: pct(refused.length, cs.length), ...bySide,
    candidateShare: pct(bySide.candidate, refused.length), companyShare: pct(bySide.company, refused.length),
    reasons: [...reasons.values()].sort((a, b) => b.n - a.n),
  };
}

/** Розріз (джерело чи вакансія): скільки додано і скільки дійшло до ключових етапів. */
export function buildCut(cs: FunnelCandidate[], keyOf: (c: FunnelCandidate) => { key: string; label: string }[]) {
  const rows = new Map<string, { key: string; label: string; added: number; interviews: number; candidates: number; managers: number; refused: number }>();
  for (const c of cs) for (const k of keyOf(c)) {
    const r = rows.get(k.key) ?? { key: k.key, label: k.label, added: 0, interviews: 0, candidates: 0, managers: 0, refused: 0 };
    const rr = reachedRank(c);
    r.added++; if (rr >= RANK.done) r.interviews++; if (rr >= RANK.candidate) r.candidates++; if (rr >= RANK.manager) r.managers++;
    if (c.status === "refused" || c.status === "black") r.refused++;
    rows.set(k.key, r);
  }
  return [...rows.values()].sort((a, b) => b.added - a.added);
}

const KYIV = (col: string) => `(${col} AT TIME ZONE 'Europe/Kyiv')::date`;
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Зведення за період. Фільтри — вакансія й джерело. Межі — київські дати, обидва кінці включно
 * (правило проєкту: `col <= $to` різав останній день). Тримає #575.
 */
export async function hiringSummary(db: Db, q: { from?: unknown; to?: unknown; vacancyId?: unknown; source?: unknown }) {
  if (!isDate(q.from) || !isDate(q.to) || q.from > q.to) throw new HiringError(400, "Вкажіть період: from ≤ to, РРРР-ММ-ДД");
  const params: unknown[] = [q.from, q.to];
  let where = `${KYIV("c.created_at")} BETWEEN $1 AND $2`;
  const vac = q.vacancyId != null && q.vacancyId !== "" ? Number(q.vacancyId) : null;
  if (vac != null && Number.isInteger(vac)) { params.push(vac); where += ` AND EXISTS (SELECT 1 FROM hiring_candidate_vacancies cv WHERE cv.candidate_id = c.id AND cv.vacancy_id = $${params.length})`; }
  if (typeof q.source === "string" && q.source) {
    if (q.source === "—") where += ` AND NULLIF(btrim(c.source), '') IS NULL`;
    else { params.push(q.source); where += ` AND c.source = $${params.length}`; }
  }
  const cs = (await db.query<FunnelCandidate>(
    `SELECT c.id, NULLIF(btrim(c.source), '') AS source, c.status, c.refusal_side, rr.label AS refusal_reason, (c.reserved_at IS NOT NULL) AS reserved,
            COALESCE((SELECT array_agg(DISTINCT e.to_status) FROM hiring_events e WHERE e.candidate_id = c.id AND e.to_status IS NOT NULL), '{}') AS visited,
            COALESCE((SELECT json_agg(json_build_object('id', v.id, 'title', v.title)) FROM hiring_candidate_vacancies cv
                        JOIN hiring_vacancies v ON v.id = cv.vacancy_id WHERE cv.candidate_id = c.id), '[]') AS vacancies
       FROM hiring_candidates c LEFT JOIN hiring_refusal_reasons rr ON rr.id = c.refusal_reason_id
      WHERE ${where}`, params)).rows;
  const side = {
    noshow: cs.filter((c) => c.status === "noshow" || c.visited.includes("noshow")).length,
    noanswer: cs.filter((c) => c.status === "noanswer" || c.visited.includes("noanswer")).length,
    reserved: cs.filter((c) => c.reserved).length,
  };
  // Офери когорти — стан із документа й підпису (`offerState`), як у картці й на дошці навчання.
  const withOffer = (await db.query<{ id: number }>(
    `SELECT id FROM hiring_candidates WHERE offer_doc_id IS NOT NULL AND id = ANY($1::int[])`, [cs.map((c) => c.id)])).rows;
  const offers = { sent: withOffer.length, signed: 0, pending: 0, outdated: 0 };
  for (const { id } of withOffer) {
    const st = (await offerState(db, id)).state;
    if (st === "signed") offers.signed++; else if (st === "outdated") offers.outdated++; else offers.pending++;
  }
  const vacClosed = (await db.query<{ month: string; result: string | null; n: number }>(
    `SELECT to_char(closed_on, 'YYYY-MM') AS month, close_result AS result, count(*)::int AS n FROM hiring_vacancies
      WHERE closed_on BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY 1, 2`, [q.from, q.to])).rows;
  const vacOpen = (await db.query<{ n: number; need: number }>(
    `SELECT count(*)::int AS n, COALESCE(sum(need), 0)::int AS need FROM hiring_vacancies WHERE status IN ('open','in_work','paused')`)).rows[0];
  const staff = (await db.query<{ hired: number; dismissed: number; active: number }>(
    `SELECT count(*) FILTER (WHERE hired_at BETWEEN $1 AND $2)::int AS hired,
            count(*) FILTER (WHERE dismissed_at BETWEEN $1 AND $2)::int AS dismissed,
            count(*) FILTER (WHERE status <> 'dismissed')::int AS active FROM employees`, [q.from, q.to])).rows[0];
  const dismissReasons = (await db.query<{ reason: string; n: number }>(
    `SELECT COALESCE(NULLIF(btrim(dismiss_reason), ''), 'причину не вказано') AS reason, count(*)::int AS n FROM employees
      WHERE dismissed_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [q.from, q.to])).rows;
  const byPosition = (await db.query<{ position: string; n: number }>(
    `SELECT COALESCE(NULLIF(btrim(position), ''), 'посада не вказана') AS position, count(*)::int AS n FROM employees
      WHERE status <> 'dismissed' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`)).rows;
  return {
    period: { from: q.from, to: q.to }, total: cs.length,
    funnel: buildFunnel(cs), refusals: buildRefusals(cs), side,
    bySource: buildCut(cs, (c) => [{ key: c.source ?? "—", label: c.source ?? "джерело не вказано" }]),
    byVacancy: buildCut(cs, (c) => (c.vacancies.length ? c.vacancies.map((v) => ({ key: String(v.id), label: v.title })) : [{ key: "—", label: "без вакансії" }])),
    vacancies: { open: vacOpen.n, need: vacOpen.need, closed: vacClosed },
    offers,
    staff: { ...staff, dismissReasons, byPosition },
  };
}
