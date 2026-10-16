/**
 * 🏆 ЗВІТ КВП — ЯДРО (задача 5605, ТЗ Юлі 12.10.2026, макет «Звіт КВП - ядро»): чисті правила таблиці «Команди: тиждень
 * і місяць». Без React — гейт бекенду виконує цей модуль. Числа беруться з ТОГО САМОГО `/kvp-report`, що й решта екрана:
 * тиждень — `weeks[].plan/fact/expected` (очікування = оплати з ПЛАНОВОЮ датою в цьому тижні, `expectedByManagerDay`),
 * місяць — `plan / revenue / expectedThisMonth`. Своїх формул грошей тут немає.
 */

export type CloseKind = "closed" | "real" | "risk" | "no" | "none";
export interface CloseStatus {
  kind: CloseKind;
  /** Частка очікуваного, що має прийти, щоб закрити план тижня (0..1); `null` — коли рахувати нема з чого. */
  share: number | null;
  /** Скільки бракує навіть з усім очікуваним (₴); 0 — коли вистачає. */
  short: number;
}

export const CLOSE_LABEL: Record<CloseKind, string> = {
  closed: "Закрито", real: "Реально", risk: "Під ризиком", no: "Не закриється", none: "—",
};

/** Пороги з ТЗ, розділ 3: «реально» — до 50% очікуваного, «під ризиком» — 50–85%, понад 85% — «не закриється». */
export const CLOSE_REAL_MAX = 0.5;
export const CLOSE_RISK_MAX = 0.85;

/**
 * Статус «Закриємо?» по тижню (ТЗ, розділ 3). Треба = план − факт; дивимось, яку частку очікуваних оплат тижня це
 * становить. Плану немає — статусу немає («—»), а не «закрито»: нуль плану не означає виконання.
 */
export function weekCloseStatus(plan: number, fact: number, expected: number): CloseStatus {
  if (!(plan > 0)) return { kind: "none", share: null, short: 0 };
  if (fact >= plan) return { kind: "closed", share: 0, short: 0 };
  const need = plan - fact;
  const exp = Math.max(0, expected);
  if (exp <= 0 || need > exp) return { kind: "no", share: exp > 0 ? need / exp : null, short: need - exp };
  const share = need / exp;
  return { kind: share <= CLOSE_REAL_MAX ? "real" : share <= CLOSE_RISK_MAX ? "risk" : "no", share, short: 0 };
}

/** Другий рядок під статусом — словами, як у макеті. */
export function closeNote(s: CloseStatus, fmt: (v: number) => string): string | null {
  if (s.kind === "none" || s.kind === "closed") return null;
  if (s.short > 0) return `бракує ${fmt(s.short)} навіть з оплатами`;
  return s.share == null ? null : `має прийти ${String(Math.round(s.share * 100))}% очікуваного`;
}

export const pctOfPlan = (v: number, plan: number): number | null => (plan > 0 ? Math.round((v / plan) * 100) : null);

/** Мінімальна форма тижня й рядка з `/kvp-report` — щоб гейт міг подати свою фікстуру. */
export interface WeekLike { idx: number; plan: number; fact: number; expected: number; isCurrent: boolean }
export interface MgrLike { managerId: number; name: string; plan: number; revenue: number; expectedThisMonth: number; weeks?: WeekLike[] }
export interface TeamLike { teamId: number | null; name: string | null; kind: string; plan: number; revenue: number; expectedThisMonth: number; weeks?: WeekLike[]; managers?: MgrLike[] }

export interface Money3 { plan: number; fact: number; withExp: number }
export interface CoreRow { key: string; name: string; week: Money3; month: Money3; managers: CoreRow[] }

const zero = (): Money3 => ({ plan: 0, fact: 0, withExp: 0 });
const add = (a: Money3, b: Money3): Money3 => ({ plan: a.plan + b.plan, fact: a.fact + b.fact, withExp: a.withExp + b.withExp });
const isEmpty = (r: { week: Money3; month: Money3 }) =>
  !r.week.plan && !r.week.fact && !r.week.withExp && !r.month.plan && !r.month.fact && !r.month.withExp;

function weekOf(ws: WeekLike[] | undefined, idx: number | null): Money3 {
  const w = ws?.find((x) => (idx == null ? x.isCurrent : x.idx === idx));
  return w ? { plan: w.plan, fact: w.fact, withExp: w.fact + w.expected } : zero();
}

/**
 * Рядки таблиці: команди (з менеджерами) і «Σ Відділ». Σ відділу — СУМА ПОКАЗАНИХ рядків (критерій приймання 6:
 * «сума команд дорівнює Σ Відділ»); порожні рядки (усе по нулях) не показуються — вони в сумі й так нуль.
 * `weekIdx` — тиждень місяця; `null` — поточний.
 */
export function coreRows(teams: TeamLike[], weekIdx: number | null, nameOf: (t: TeamLike) => string): { rows: CoreRow[]; dept: { week: Money3; month: Money3 } } {
  const rows: CoreRow[] = [];
  let dw = zero(), dm = zero();
  for (const t of teams) {
    const managers = (t.managers ?? []).map((m): CoreRow => ({
      key: `m:${String(m.managerId)}`, name: m.name, managers: [],
      week: weekOf(m.weeks, weekIdx),
      month: { plan: m.plan, fact: m.revenue, withExp: m.revenue + m.expectedThisMonth },
    })).filter((r) => !isEmpty(r));
    const row: CoreRow = {
      key: `t:${String(t.teamId)}:${t.kind}`, name: nameOf(t), managers,
      week: weekOf(t.weeks, weekIdx),
      month: { plan: t.plan, fact: t.revenue, withExp: t.revenue + t.expectedThisMonth },
    };
    if (isEmpty(row)) continue;
    rows.push(row);
    dw = add(dw, row.week); dm = add(dm, row.month);
  }
  return { rows, dept: { week: dw, month: dm } };
}

// ───────────── 🎧 «ПЕРШИЙ ДОТИК» У ЯДРІ: сортування й фільтр таблиці менеджерів (ТЗ 12.10, розділ 4) ─────────────

export type FtSortKey = "calls" | "score" | "price" | "promise" | "objection" | "agreed" | "success";
export interface FtLineLike { calls: number; score: number | null; price: number | null; promise: number | null;
  objection: number | null; decided: number; agreed: number; success: number }

/** Значення колонки для сортування; `null` — «не рахується» («—»), і воно завжди внизу, в обидва боки. */
export function ftSortVal(l: FtLineLike, k: FtSortKey): number | null {
  if (k === "agreed") return l.decided ? l.agreed / l.decided : null;
  if (k === "success") return l.success;
  if (k === "calls") return l.calls;
  return l[k];
}

export function sortFtLines<T extends FtLineLike>(lines: readonly T[], key: FtSortKey | null, dir: "asc" | "desc"): T[] {
  if (!key) return [...lines];
  return [...lines].sort((a, b) => {
    const x = ftSortVal(a, key), y = ftSortVal(b, key);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return dir === "asc" ? x - y : y - x;
  });
}

/**
 * Клік по картці = фільтр таблиці (ТЗ 12.10, розділ 4): лишаються менеджери, у яких Є розмови цієї картки, і поруч —
 * скільки таких. Статистика рядка — по ВСІХ його розмовах (інакше «ціна %» серед розмов без ціни була б завжди 0%).
 */
export function tileCountsByManager<R extends { managerId: number | null }>(rows: readonly R[], match: ((r: R) => boolean) | null): Map<number | null, number> | null {
  if (!match) return null;
  const m = new Map<number | null, number>();
  for (const r of rows) if (match(r)) m.set(r.managerId, (m.get(r.managerId) ?? 0) + 1);
  return m;
}
