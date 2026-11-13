/**
 * 📊 ТЕНДЕРНІ УГОДИ: СТАН І ПІДСУМКИ — ЧИСТІ ПРАВИЛА, БЕЗ ЖОДНОГО ІМПОРТУ (TOP Weekly 12.11.2026, Сергій: «пул угод… щоб ми далі
 * відстежували їх етапи — що в роботі, що не в роботі… сюди в цей екран тендери»; макет погоджено Романом 13.11.2026).
 *
 * Стан угоди Продзвону, яку створив бот, — ЗАРАЗ:
 *  · `new`    — досі на «Тендер AI» (ніхто не взяв);
 *  · `taken`  — «Взято в роботу» чи будь-який інший робочий етап Продзвону;
 *  · `opr`    — «ОПР»;
 *  · `passed` — «Кваліфіковано» (передано менеджеру), угода менеджера ще без авто;
 *  · `auto`   — угода менеджера дійшла до «авто поїхало» (`money.handoffDealStates.autoDay`);
 *  · `paid`   — угода менеджера «Оплата отримана» або «Успішна» (клас з `money.handoffDealStates`);
 *  · `closed` — угоду Продзвону закрито (143).
 * Id етапів передає викличник — модуль без імпортів.
 */

export type PzDealState = "new" | "taken" | "opr" | "passed" | "auto" | "paid" | "closed";
export interface PzStageIds { tender: number; opr: number; qualified: number; lost: number }

export function pzDealState(statusId: number, child: { cls: string; autoDay: string | null } | null, ids: PzStageIds): PzDealState {
  if (statusId === ids.lost) return "closed";
  if (statusId === ids.qualified) {
    if (child && (child.cls === "success" || child.cls === "paid")) return "paid";
    if (child && child.autoDay) return "auto";
    return "passed";
  }
  if (statusId === ids.tender) return "new";
  if (statusId === ids.opr) return "opr";
  return "taken";
}

export interface PzDealRow {
  leadId: number; url: string; day: string; company: string; amount: number | null; niche: string | null;
  manager: string | null; team: string | null; state: PzDealState; reason: string | null; talk: boolean;
  /** Повних діб від створення — для «не взято довше доби». */
  ageDays: number;
}

/** Воронка — НАКОПИЧЕНО: угода на ОПР уже була «взята», передана — уже на ОПР і т.д. */
const REACHED: Record<PzDealState, number> = { new: 0, closed: 0, taken: 1, opr: 2, passed: 3, auto: 4, paid: 5 };
export const FUNNEL_STEPS = ["Створено", "Взято в роботу", "ОПР", "Передано менеджеру", "Авто поїхало", "Оплата"] as const;
/** «Не взято довше доби» — від цієї кількості повних діб. */
export const STALE_DAYS = 1;

export interface PzPersonRow { manager: string; team: string | null; total: number; fresh: number; stale: number; work: number; passed: number; closed: number; talk: number }
export interface PzDealsSummary {
  total: number; fresh: number; work: number; passed: number; closed: number; talk: number;
  funnel: { step: string; n: number }[];
  people: PzPersonRow[];
  reasons: { reason: string; n: number }[];
  niches: { niche: string; total: number; worked: number; closed: number }[];
}

export function summarizeDeals(rows: readonly PzDealRow[]): PzDealsSummary {
  const s: PzDealsSummary = { total: rows.length, fresh: 0, work: 0, passed: 0, closed: 0, talk: 0, funnel: [], people: [], reasons: [], niches: [] };
  const reach = [0, 0, 0, 0, 0, 0];
  const people = new Map<string, PzPersonRow>(), reasons = new Map<string, number>(), niches = new Map<string, { total: number; worked: number; closed: number }>();
  for (const r of rows) {
    const passedLike = r.state === "passed" || r.state === "auto" || r.state === "paid";
    if (r.state === "new") s.fresh++; else if (r.state === "closed") s.closed++; else if (passedLike) s.passed++; else s.work++;
    if (r.talk) s.talk++;
    for (let i = 0; i <= REACHED[r.state]; i++) reach[i]++;
    const who = r.manager ?? "— без відповідального —";
    const p = people.get(who) ?? { manager: who, team: r.team, total: 0, fresh: 0, stale: 0, work: 0, passed: 0, closed: 0, talk: 0 };
    p.total++; if (r.talk) p.talk++;
    if (r.state === "new") { p.fresh++; if (r.ageDays >= STALE_DAYS) p.stale++; }
    else if (r.state === "closed") p.closed++; else if (passedLike) p.passed++; else p.work++;
    people.set(who, p);
    if (r.state === "closed") { const k = r.reason?.trim() || "причину не вказано"; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
    const nk = r.niche ?? "— без ніші —";
    const n = niches.get(nk) ?? { total: 0, worked: 0, closed: 0 };
    n.total++; if (r.state === "closed") n.closed++; else if (r.state !== "new") n.worked++;
    niches.set(nk, n);
  }
  s.funnel = FUNNEL_STEPS.map((step, i) => ({ step, n: reach[i] }));
  s.people = [...people.values()].sort((a, b) => b.fresh - a.fresh || b.total - a.total || a.manager.localeCompare(b.manager));
  s.reasons = [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
  s.niches = [...niches.entries()].map(([niche, v]) => ({ niche, ...v })).sort((a, b) => b.total - a.total);
  return s;
}
