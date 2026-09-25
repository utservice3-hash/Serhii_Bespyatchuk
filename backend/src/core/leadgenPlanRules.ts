import { monthsInRange, monthEndOf, workingDaysBetween } from "./dates.js";

/**
 * 📋 ПЛАНИ ЛІДГЕНІВ І РОСТЕР ЕКРАНА «ЛІДОГЕНЕРАЦІЯ» — ЧИСТІ ПРАВИЛА (рішення власника 25.09.2026).
 *
 * 🔴 ЧОМУ ОКРЕМИЙ ЧИСТИЙ МОДУЛЬ. Ядро з пулом (`leadgenPlans.ts`, `leadgenStats.ts`) тягне
 * `db/pool.js` → `config.js`, який кидає без `DATABASE_URL` ще на імпорті. Межі тут — ХТО в
 * ростері, хто кому подає план, як план ділиться на період — мусять саботуватись ВХОДОМ у
 * звичайному `npm test`, а не HTTP-пробою (правило 14). Єдиний імпорт — `dates.ts`, теж чистий.
 *
 * Що вирішив власник (25.09.2026), дослівно за змістом:
 *  1. Рядки людей на вкладці — ЛИШЕ активні учасники команди «Лідогенерація» (поточний склад).
 *     Усі інші, хто мав події лідоген-етапів у періоді, — ОКРЕМИМ блоком «Інші, не з команди»
 *     зі своїми лічильниками. Підсумки відділу НЕ змінюються: вони рахують усіх (дашборд —
 *     дзеркало CRM, ховати роботу заборонено). Тімлід бачить лише свою команду; блок «Інші» —
 *     лише ролям рівня компанії.
 *  2. План — на ті самі лічильники, що вже на екрані: ліди, ОПР, прорахунки. Не нові предикати.
 *  4. Виконання плану (кільце, вердикт, пілюлі) = прорахунки факт ÷ прорахунки план; ліди й
 *     ОПР — другорядним «факт / план». Плану немає — показуємо як було (конверсія) з підписом
 *     «плану немає», а НЕ фальшиві 0 %.
 */

/** Три лічильники, на які ставиться план, — РІВНО ті поля рядка людини, що на екрані. */
export const LEADGEN_PLAN_METRICS = ["leads", "opr", "quotes"] as const;
export type LeadgenPlanMetric = (typeof LEADGEN_PLAN_METRICS)[number];
/** Головний показник вердикту (рішення 4): прорахунки. */
export const PRIMARY_PLAN_METRIC: LeadgenPlanMetric = "quotes";

/** Рядок людини — форма `leadgenStats.LeadgenPersonRow` (структурно, без імпорту ядра). */
export interface RosterRow {
  managerId: number; name: string; teamId: number | null; teamName: string | null; isActive: boolean;
  leads: number; opr: number; quotes: number; warming: number; calls: number;
}
/** Активний учасник команди «Лідогенерація» на СЬОГОДНІ (поточний склад, а не історія). */
export interface TeamMember { managerId: number; name: string; teamId: number | null; teamName: string | null }
export type RosterTotals = Pick<RosterRow, "leads" | "opr" | "quotes" | "warming" | "calls">;

export const ZERO_TOTALS: RosterTotals = { leads: 0, opr: 0, quotes: 0, warming: 0, calls: 0 };
export function sumRoster(rows: readonly RosterTotals[]): RosterTotals {
  return rows.reduce((a, r) => ({
    leads: a.leads + r.leads, opr: a.opr + r.opr, quotes: a.quotes + r.quotes,
    warming: a.warming + r.warming, calls: a.calls + r.calls,
  }), { ...ZERO_TOTALS });
}

export interface RosterView<R extends RosterRow> {
  /** Рядки людей: учасники команди (компанія) або своя команда (тімлід). */
  rows: R[];
  /** «Інші, не з команди» — лише для рівня компанії; тімліду завжди порожньо. */
  others: R[];
  /** Підсумок відповіді: компанія — УВЕСЬ відділ (== Σ rows + Σ others); тімлід — Σ своїх рядків. */
  totals: RosterTotals;
  othersTotals: RosterTotals;
}

/**
 * 👥 РОСТЕР ЕКРАНА. `rows` — усі люди з подіями лідоген-етапів у періоді (ядро, ТІ САМІ предикати,
 * що й завжди); `members` — активні учасники команди; `scopeTeamId` — з `leadgenAuthScope`
 * (`null` = компанія, число = команда тімліда).
 *
 * Компанія: рядки = УСІ учасники (без подій — нульовим рядком: план є і в того, хто ще нічого не
 * зробив, і «немає рядка» читалося б як «немає людини»); інші = решта людей із подіями;
 * `totals` = Σ усіх людей із подіями — те саме число, що було до розділу (рішення 1: підсумки
 * відділу не змінюються). Звідси інваріант `Σ rows + Σ others == totals`, і нульові рядки
 * його не рушать.
 *
 * Тімлід: рядки = ті, хто в його команді (межа та сама, що й була, — `teamId` рядка), плюс
 * нульові рядки учасників його команди без подій. Блоку «Інші» немає; `totals` = Σ рядків.
 *
 * 🔴 Скоуп звужує ВІДПОВІДЬ, а не домен (правило 1): учасником людину робить поточний склад
 * команди, а не те, хто дивиться.
 */
export function leadgenRosterView<R extends RosterRow>(
  rows: readonly R[], members: readonly TeamMember[], scopeTeamId: number | null, zeroRow: (m: TeamMember) => R,
): RosterView<R> {
  if (scopeTeamId == null) {
    const ids = new Set(members.map((m) => m.managerId));
    const has = new Set(rows.map((r) => r.managerId));
    const team = rows.filter((r) => ids.has(r.managerId))
      .concat(members.filter((m) => !has.has(m.managerId)).map(zeroRow));
    const others = rows.filter((r) => !ids.has(r.managerId));
    return { rows: team, others, totals: sumRoster(rows), othersTotals: sumRoster(others) };
  }
  const own = rows.filter((r) => r.teamId === scopeTeamId);
  const has = new Set(own.map((r) => r.managerId));
  const team = own.concat(members.filter((m) => m.teamId === scopeTeamId && !has.has(m.managerId)).map(zeroRow));
  return { rows: team, others: [], totals: sumRoster(team), othersTotals: { ...ZERO_TOTALS } };
}

/** Розбіжності інваріанта «Σ рядків + Σ інших == підсумок»; порожньо = сходиться. */
export function rosterInvariantBreaks(v: RosterView<RosterRow>): string[] {
  const a = sumRoster(v.rows), b = sumRoster(v.others);
  const out: string[] = [];
  for (const k of Object.keys(ZERO_TOTALS) as (keyof RosterTotals)[]) {
    if (a[k] + b[k] !== v.totals[k]) out.push(`${k}: ${a[k]} + ${b[k]} ≠ ${v.totals[k]}`);
  }
  return out;
}

// ─────────────────────────── ПЛАН НА ПЕРІОД ───────────────────────────

/** Затверджені значення людини по місяцях: `month` ('YYYY-MM-01') → метрика → значення. */
export type ApprovedByMonth = Map<string, Partial<Record<LeadgenPlanMetric, number>>>;
export type PeriodPlan = Record<LeadgenPlanMetric, number | null>;

/**
 * 📅 ПЛАН НА ОБРАНИЙ ПЕРІОД — ТОЙ САМИЙ розклад, що в Звіті продажів (`/report-plan`):
 * місячний план ділиться РІВНОМІРНО по робочих днях (`workingDaysBetween`, Пн–Пт) і береться
 * частка, що припадає на перетин періоду з місяцем. Для цілого місяця — рівно план місяця.
 *
 * ⚠️ Плану хоч на ОДИН місяць періоду немає → `null` для цієї метрики, а не «частковий план»:
 * інакше факт усього періоду ділився б на план його частини, і відсоток брехав би вгору.
 */
export function planForPeriod(approved: ApprovedByMonth, from: string, to: string): PeriodPlan {
  const out: PeriodPlan = { leads: 0, opr: 0, quotes: 0 };
  for (const mo of monthsInRange(from, to)) {
    const me = monthEndOf(mo);
    const wdMonth = workingDaysBetween(mo, me);
    const oF = mo > from ? mo : from, oT = me < to ? me : to;
    const frac = wdMonth > 0 && oF <= oT ? workingDaysBetween(oF, oT) / wdMonth : 0;
    const vals = approved.get(mo);
    for (const k of LEADGEN_PLAN_METRICS) {
      const v = vals?.[k];
      if (out[k] == null) continue;
      if (v == null) { out[k] = null; continue; }
      out[k] = (out[k] as number) + v * frac;
    }
  }
  for (const k of LEADGEN_PLAN_METRICS) if (out[k] != null) out[k] = Math.round((out[k] as number) * 10) / 10;
  return out;
}

/**
 * Темп — частка робочих днів періоду, що минули на `today` (київська дата). Та сама формула,
 * що в `statusOf` Звіту продажів: період ще не почався → 0; закінчився → 1.
 */
export function periodElapsed(from: string, to: string, today: string): number {
  const total = workingDaysBetween(from, to);
  if (total <= 0) return 1;
  if (today < from) return 0;
  const done = workingDaysBetween(from, today < to ? today : to);
  return Math.min(1, done / total);
}

export type PlanLevel = "g" | "a" | "r";
export type PlanExec =
  | { kind: "none" }                                   // затвердженого плану немає
  | { kind: "zero" }                                   // план затверджено нулем — оцінювати нема з чим
  | { kind: "plan"; fact: number; plan: number; pct: number; level: PlanLevel };

/**
 * 🎯 ВИКОНАННЯ ПЛАНУ — пороги й темп ТІ САМІ, що в Звіті продажів (`statusOf`):
 * (факт ÷ план) ÷ темп ≥ 1 — у цілі, ≥ 0.7 — близько, нижче — нижче цілі.
 * Плану немає — `none`, і екран пише «плану немає»; НІКОЛИ не 0 %.
 */
export function planExecution(fact: number, plan: number | null, elapsed: number): PlanExec {
  if (plan == null) return { kind: "none" };
  if (!(plan > 0)) return { kind: "zero" };
  const r = (fact / plan) / (elapsed || 1);
  return { kind: "plan", fact, plan, pct: Math.round((fact / plan) * 100), level: r >= 1 ? "g" : r >= 0.7 ? "a" : "r" };
}

export interface PersonPlanView { managerId: number; plan: PeriodPlan; exec: PlanExec }
export interface TeamPlanView {
  /** Людей у рядках і скільки з них мають план прорахунків на ВЕСЬ період. */
  total: number; planned: number;
  /** Факт прорахунків УСІХ рядків команди (з безплановими — як у Звіті продажів) і Σ планів. */
  fact: number; plan: number | null; exec: PlanExec;
}

/**
 * План і виконання для кожного рядка + команди. Команда — Σ планів тих, у кого він є; факт —
 * УСІХ рядків (рішення власника для продажів 06.08.2026: безпланові піднімають відсоток, і це
 * показується підписом «план є у N з M», а не ховається).
 */
export function planView(
  rows: readonly RosterRow[], approved: ReadonlyMap<number, ApprovedByMonth>,
  from: string, to: string, today: string,
): { elapsed: number; byPerson: PersonPlanView[]; team: TeamPlanView } {
  const elapsed = periodElapsed(from, to, today);
  const byPerson = rows.map((r): PersonPlanView => {
    const plan = planForPeriod(approved.get(r.managerId) ?? new Map(), from, to);
    return { managerId: r.managerId, plan, exec: planExecution(r[PRIMARY_PLAN_METRIC], plan[PRIMARY_PLAN_METRIC], elapsed) };
  });
  const withPlan = byPerson.filter((p) => p.plan[PRIMARY_PLAN_METRIC] != null);
  const fact = rows.reduce((s, r) => s + r[PRIMARY_PLAN_METRIC], 0);
  const plan = withPlan.length ? Math.round(withPlan.reduce((s, p) => s + (p.plan[PRIMARY_PLAN_METRIC] as number), 0) * 10) / 10 : null;
  return {
    elapsed, byPerson,
    team: { total: rows.length, planned: withPlan.length, fact, plan, exec: planExecution(fact, plan, elapsed) },
  };
}

// ─────────────────────────── ХТО ПОДАЄ / ЗАТВЕРДЖУЄ ───────────────────────────

/**
 * 🔐 МЕЖІ — ДЗЕРКАЛО ФОРМУВАННЯ ПЛАНУ ПРОДАЖІВ (`core/planScope.ts`, `routes/plans.ts`):
 * подає тімлід (своя команда) або адмін-рівень; затверджує й повертає ЛИШЕ адмін-рівень
 * (`auth.role === "admin"`: адмін, СЕО, ОД, КВП, фінансист — ті самі, що в продажів).
 * ⚠️ ОДНА РІЗНИЦЯ, і вона свідома: менеджер у продажах подає СВІЙ план, а тут — ні. Роль
 * `manager` на роутах лідогену — 403 першим оператором (рішення власника: лідгени ходять як
 * `manager`, і розширення доступу — окреме рішення, якого немає).
 */
export interface LgPlanActor { role: string; teamId: number | null }
export interface LgPlanTarget { managerId: number; teamId: number | null; isMember: boolean }

/** Ролі, що не подають нікому й ніколи, — відсікаються ДО розбору тіла (той самий прийом, що `mayEverSubmit`). */
export function mayEverSubmitLeadgenPlan(role: string): boolean {
  return role === "admin" || role === "team_lead";
}
export function mayApproveLeadgenPlan(role: string): boolean {
  return role === "admin";
}

/**
 * Текст відмови на подання (видимий людині рядком) або `null` = дозволено.
 * 🔴 `null`-команда тімліда зіставляється ЯВНО: `null === null` відкрив би йому всіх без команди.
 */
export function leadgenSubmitRefusal(a: LgPlanActor, t: LgPlanTarget): string | null {
  if (!t.isMember) return "План ставиться лише активним учасникам команди «Лідогенерація»";
  if (a.role === "admin") return null;
  if (a.role === "team_lead") return a.teamId !== null && t.teamId !== null && a.teamId === t.teamId ? null : "Лише своя команда";
  return "Подання плану лідгена недоступне для цієї ролі";
}

// ─────────────────────────── ТІЛО ПОДАННЯ ───────────────────────────

export const LEADGEN_PLAN_MAX = 100_000;
export type LeadgenPlanValues = Record<LeadgenPlanMetric, number>;
export type ParsedSubmit =
  | { ok: true; managerId: number; month: string; values: LeadgenPlanValues; comment: string | null }
  | { ok: false; error: string };

/** 'YYYY-MM' або 'YYYY-MM-DD' → 'YYYY-MM-01'; інакше `null`. */
export function planMonthOf(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(v)) return null;
  return v.slice(0, 7) + "-01";
}

/** Тіло `POST /leadgen-plans/submit`: людина, місяць і ВСІ три значення — цілі, від 0 до стелі. */
export function parseLeadgenSubmit(body: unknown): ParsedSubmit {
  const b = (body ?? {}) as Record<string, unknown>;
  const managerId = b.managerId;
  if (typeof managerId !== "number" || !Number.isInteger(managerId) || managerId <= 0) return { ok: false, error: "managerId — додатне ціле" };
  const month = planMonthOf(b.month);
  if (!month) return { ok: false, error: "month — YYYY-MM" };
  const values = {} as LeadgenPlanValues;
  for (const k of LEADGEN_PLAN_METRICS) {
    const v = b[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > LEADGEN_PLAN_MAX) {
      return { ok: false, error: `${k} — ціле від 0 до ${LEADGEN_PLAN_MAX}` };
    }
    values[k] = v;
  }
  const comment = typeof b.comment === "string" && b.comment.trim() ? b.comment.trim().slice(0, 2000) : null;
  return { ok: true, managerId, month, values, comment };
}

export type LgFormationStatus = "draft" | "submitted" | "approved" | "returned";

/**
 * Стан людини з трьох рядків-метрик. Пишуться вони ЗАВЖДИ разом (одне подання = три рядки), тож
 * стан однаковий; якщо ні — показуємо найвимогливіший («на затвердженні» над рештою), а не перший-ліпший.
 */
export function personFormationStatus(statuses: readonly LgFormationStatus[]): LgFormationStatus {
  if (!statuses.length) return "draft";
  for (const s of ["submitted", "returned", "draft", "approved"] as const) if (statuses.includes(s)) return s;
  return "draft";
}
