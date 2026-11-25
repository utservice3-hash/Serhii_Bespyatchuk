/**
 * 📵 ПРОПУЩЕНІ ДЗВІНКИ НА «СТАТИСТИКАХ» (Роман 25.11.2026: «із вкладки пропущених забрати графіки, перенести все у
 * Статистики, щоб не дублювалась інформація»). Чистий модуль без БД: як точки ядра `core/missedCalls.missedSeries`
 * стають рядами екрана «Статистики». Самі числа рахує ТЕ САМЕ ядро, що й вкладку (перевізники поза, плечі склеєні,
 * передзвін за 24 год, розмова від 10 с) — тут лише вибір лінії й показника.
 *
 * 🔴 ЛІНІЇ — З ВІДПОВІДІ ЯДРА, А НЕ З `LIVE_TEAMS`. Заміряно 26.11.2026 на проді: ядро віддає 9 команд, і чотирьох
 * (Лідогенерація, Демчук, Хомік, Комерційний відділ) у `LIVE_TEAMS` немає; «Без відповідального» — 831 із 1 483 за
 * жовтень. Перелік із `LIVE_TEAMS` тихо загубив би ці лінії, і Σ ліній розійшлась би з компанією.
 *
 * 🔒 СКОУП — ДЗЕРКАЛО `missedScopeFor` (кламп вкладки), а не загального набору «Статистик»: менеджер — лише свої,
 * тімлід — своя команда й її менеджери БЕЗ лінії компанії (рішення Романа 26.11.2026, картка «Ні, як зараз»: перенос
 * не відкриває тімліду чисел, яких він на вкладці не бачить), решта — компанія й усі лінії ядра.
 */
import type { MissedSeries, MissedSeriesPoint } from "../core/missedCallsRules.js";

/** Блок рядів на `/api/statistics/series` (`block=missed`). Межа доступу — вкладка «Пропущені дзвінки» (`blockDenied`). */
export const MISSED_BLOCK = "missed";

/** Показники екрана — ті самі чотири, що були чипами графіка «Динаміка» на вкладці. */
export const MISSED_METRICS = ["missed_count", "missed_nocb_pct", "missed_cb_median", "missed_self_pct"] as const;
export type MissedMetric = (typeof MISSED_METRICS)[number];
export const isMissedMetric = (m: string): m is MissedMetric => (MISSED_METRICS as readonly string[]).includes(m);

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/**
 * Значення точки. Частки — з лічильників САМОЇ точки (не середнє відсотків); точка без пропущених дає `null`, тобто
 * точки немає («не було» ≠ «0%»). Медіана — та, що порахувало ядро для цієї точки; медіани не усереднюються.
 */
export function missedMetricValue(metric: MissedMetric, p: MissedSeriesPoint): number | null {
  switch (metric) {
    case "missed_count": return p.missed;
    case "missed_nocb_pct": return pct(p.missed - p.callback, p.missed);
    case "missed_cb_median": return p.missed > 0 ? p.medianMin : null;
    case "missed_self_pct": return pct(p.clientSelf, p.missed);
  }
}

/** Розріз рядка «Статистик» → ключ серії ядра. Менеджер і тімлід питають ядро зі своїм скоупом, і їхня лінія — «total». */
export function missedSeriesKey(scopeType: string, scopeKey: string): string {
  if (scopeType === "company" || scopeType === "manager") return "total";
  if (scopeType === "team_lead") return `team:${scopeKey}`;
  return scopeKey; // "noteam" / "ownerless"
}

/** Точки однієї лінії: значення показника, точки без значення пропущено. */
export function missedPointsOf(series: readonly MissedSeries[], key: string, metric: MissedMetric): { period: string; value: number }[] {
  const s = series.find((x) => x.key === key);
  if (!s) return [];
  return s.points.flatMap((p) => { const v = missedMetricValue(metric, p); return v == null ? [] : [{ period: p.period, value: v }]; });
}

export interface MissedScopeSpec { scopeType: string; scopeKey: string; scopeName: string; teamId: number | null; managerId: number | null }

/**
 * Лінії компанії-глядача: «Компанія» і далі КОЖНА серія ядра в його порядку (команди за спаданням, «Поза командами»,
 * «Без відповідального»). Команда — `team_lead` зі своїм id (на неї діє позначка розформованої), решта — `missed_part`.
 */
export function missedCompanySet(series: readonly MissedSeries[]): MissedScopeSpec[] {
  const out: MissedScopeSpec[] = [{ scopeType: "company", scopeKey: "company", scopeName: "Компанія", teamId: null, managerId: null }];
  for (const s of series) {
    if (s.key === "total") continue;
    const m = /^team:(\d+)$/.exec(s.key);
    if (m) out.push({ scopeType: "team_lead", scopeKey: m[1], scopeName: s.name ?? `Команда #${m[1]}`, teamId: Number(m[1]), managerId: null });
    else out.push({ scopeType: "missed_part", scopeKey: s.key, scopeName: s.name ?? s.key, teamId: null, managerId: null });
  }
  return out;
}

/** Хто який набір ліній бачить — рівно як кламп вкладки (`missedScopeFor`): за РОЛЛЮ, не за наявністю manager_id. */
export type MissedViewer = { kind: "manager"; managerId: number | null } | { kind: "team_lead"; teamId: number | null } | { kind: "company" };
export function missedViewerOf(auth: { role: string; managerId: number | null; teamId: number | null }): MissedViewer {
  if (auth.role === "manager") return { kind: "manager", managerId: auth.managerId };
  if (auth.role === "team_lead") return { kind: "team_lead", teamId: auth.teamId };
  return { kind: "company" };
}

/**
 * Набір ліній глядача. Менеджер — лише «Мої»; тімлід — своя команда й її менеджери, БЕЗ лінії компанії (рішення Романа
 * 26.11.2026); без привʼязки (немає manager_id / team_id) — порожньо, а не компанія (правило 7: порожній скоуп не
 * виражається «фільтра немає»). Решта — компанія й усі лінії ядра (`missedCompanySet`).
 */
export function missedSetFor(v: MissedViewer, ctx: { teamName?: string | null; managers?: readonly { id: number; name: string }[]; series?: readonly MissedSeries[] }): MissedScopeSpec[] {
  if (v.kind === "manager") return v.managerId == null ? [] : [{ scopeType: "manager", scopeKey: String(v.managerId), scopeName: "Мої", teamId: null, managerId: v.managerId }];
  if (v.kind === "team_lead") {
    if (v.teamId == null) return [];
    return [
      { scopeType: "team_lead", scopeKey: String(v.teamId), scopeName: ctx.teamName ?? `Команда #${String(v.teamId)}`, teamId: v.teamId, managerId: null },
      ...(ctx.managers ?? []).map((m): MissedScopeSpec => ({ scopeType: "manager", scopeKey: String(m.id), scopeName: m.name, teamId: null, managerId: m.id })),
    ];
  }
  return missedCompanySet(ctx.series ?? []);
}

/** Кінець ряду — учора за Києвом: частка «не передзвонили» за сьогодні ще не мала доби на передзвін (як на вкладці). */
export function missedSeriesTo(to: string, today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.toISOString().slice(0, 10);
  return to < y ? to : y;
}
