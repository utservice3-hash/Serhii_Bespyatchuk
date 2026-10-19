import type { Db } from "./adCallFacts.js";
import { OWNER_NAME_SQL } from "./absences.js";

/**
 * 🏖 ВІДПУСТКА: КОНТРОЛЬ ПРАВИЛ І «ХТО У ВІДПУСТЦІ СЬОГОДНІ» (задача 5149, регламент «Менеджер у відпустці»,
 * розділ 7, пп.1 і 5; Роман 19.10.2026).
 *
 * П.5 регламенту: «при спробі поставити другу людину з команди на ті самі дати або відпустку довше 9 днів —
 * попередження і підтвердження КВП». Роман 19.10.2026: погоджувати такі може й Операційний директор.
 *   • довше 9 — КАЛЕНДАРНИХ днів (розділ 1: «до 9 календарних днів поспіль»), тобто 10 і більше;
 *   • накладка — з іншою людиною тієї самої команди, чия відпустка не відхилена (і погоджена, і «на погодженні»:
 *     обидві претендують на ті самі дати). Своя друга відпустка, інша команда, безкомандний акаунт — не накладка.
 *
 * 🔴 Позначка НЕ зберігається — рахується щоразу з поточних рядків. Скасували іншу відпустку — правило знято саме,
 * і не буває «чекає КВП» через накладку, якої вже немає.
 *
 * Хто погоджує порушення — ЯВНИЙ перелік ролей, а не `admin_scope`: адмінський рівень має й фінансист, а
 * відпустки він погоджувати не мусить. Адмін лишається (найвищий рівень, і досі погоджував усе).
 */

export const VACATION_MAX_DAYS = 9;
export const VACATION_RULE_APPROVERS: readonly string[] = ["kvp", "opdir", "admin"];
export const VACATION_RULE_APPROVER_LABEL = "КВП або Операційний директор";

export function canApproveVacationRules(roleKey: string): boolean {
  return VACATION_RULE_APPROVERS.includes(roleKey);
}

/** Календарних днів у [start, end] включно. */
export function calendarDays(start: string, end: string): number {
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86_400_000) + 1;
}

export interface VacationSpan {
  id: number | null;
  userId: number | null;
  managerId: number | null;
  teamId: number | null;
  start: string;
  end: string;
  status: string;
  ownerName?: string | null;
}

export type VacationIssue =
  | { kind: "long"; days: number }
  | { kind: "overlap"; withId: number | null; withName: string | null; start: string; end: string };

const sameOwner = (a: VacationSpan, b: VacationSpan) =>
  (a.userId != null && a.userId === b.userId) || (a.managerId != null && a.managerId === b.managerId);

/** Чиста форма правила: що порушує відпустка `cand` серед `peers` (рядки можуть містити й саму `cand`). */
export function vacationIssues(cand: VacationSpan, peers: readonly VacationSpan[]): VacationIssue[] {
  const out: VacationIssue[] = [];
  const days = calendarDays(cand.start, cand.end);
  if (days > VACATION_MAX_DAYS) out.push({ kind: "long", days });
  if (cand.teamId != null) {
    for (const p of peers) {
      if (p.status === "rejected" || p.teamId !== cand.teamId) continue;
      if (cand.id != null && p.id === cand.id) continue;
      if (sameOwner(cand, p)) continue;
      if (p.start <= cand.end && p.end >= cand.start) {
        out.push({ kind: "overlap", withId: p.id, withName: p.ownerName ?? null, start: p.start, end: p.end });
      }
    }
  }
  return out;
}

const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/** Текст причини. `showNames=false` — для менеджера: календар колег йому закритий, тож без імені. */
export function issueText(i: VacationIssue, showNames: boolean): string {
  if (i.kind === "long") return `відпустка ${String(i.days)} днів — довше ${String(VACATION_MAX_DAYS)}`;
  const who = showNames && i.withName ? i.withName : "інша людина з команди";
  return `${who} у відпустці ${dm(i.start)}–${dm(i.end)}, дати накладаються`;
}

/** Відпустки команд `$1` (int[]), що перетинають [$2, $3], — кандидати в накладку. */
export const VACATION_PEERS_SQL = `
  SELECT a.id, a.user_id, a.manager_id, a.team_id, a.status, ${OWNER_NAME_SQL} AS owner_name,
         to_char(a.start_date, 'YYYY-MM-DD') AS start_date, to_char(a.end_date, 'YYYY-MM-DD') AS end_date
    FROM team_calendar_absences a
    LEFT JOIN managers m ON m.id = a.manager_id
    LEFT JOIN users u ON u.id = a.user_id
   WHERE a.kind = 'vacation' AND a.status <> 'rejected'
     AND a.team_id = ANY($1::int[]) AND a.start_date <= $3 AND a.end_date >= $2`;

interface PeerRow { id: number; user_id: number | null; manager_id: number | null; team_id: number | null; status: string; owner_name: string | null; start_date: string; end_date: string }
const toSpan = (r: PeerRow): VacationSpan => ({ id: r.id, userId: r.user_id, managerId: r.manager_id, teamId: r.team_id,
  start: r.start_date, end: r.end_date, status: r.status, ownerName: r.owner_name });

/** Порушення для кількох відпусток одним запитом. Ключ — `id` кандидата (null-кандидат — під ключем -1). */
export async function vacationIssuesFor(db: Db, cands: readonly VacationSpan[]): Promise<Map<number, VacationIssue[]>> {
  const out = new Map<number, VacationIssue[]>();
  if (!cands.length) return out;
  const teams = [...new Set(cands.map((c) => c.teamId).filter((t): t is number => t != null))];
  let peers: VacationSpan[] = [];
  if (teams.length) {
    const from = cands.reduce((a, c) => (c.start < a ? c.start : a), cands[0].start);
    const to = cands.reduce((a, c) => (c.end > a ? c.end : a), cands[0].end);
    peers = (await db.query<PeerRow>(VACATION_PEERS_SQL, [teams, from, to])).rows.map(toSpan);
  }
  for (const c of cands) out.set(c.id ?? -1, vacationIssues(c, peers));
  return out;
}

/**
 * Хто у відпустці на дату `$1` (погоджена, тип «відпустка»), до якого числа. `scope` — додаткові умови з `$n`
 * (той самий роль-скоуп, що в календарі). Кілька відпусток підряд — береться найпізніший кінець серед тих, що
 * покривають дату.
 */
export function onVacationSql(scope: string): string {
  return `SELECT a.manager_id, a.user_id, to_char(MAX(a.end_date), 'YYYY-MM-DD') AS until
            FROM team_calendar_absences a
           WHERE a.kind = 'vacation' AND a.status = 'approved'
             AND a.start_date <= $1::date AND a.end_date >= $1::date ${scope}
           GROUP BY a.manager_id, a.user_id`;
}
