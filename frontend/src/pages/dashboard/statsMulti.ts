/**
 * 📈 КІЛЬКА ПОКАЗНИКІВ НА ОДНОМУ ГРАФІКУ «СТАТИСТИК» (задача 5707, п.2 ТЗ Юлії 14.10.2026: «вибрати кілька одночасно і
 * бачити їх разом, щоб видно було зв'язок; якщо в різних одиницях — дві осі, ліва і права»).
 *
 * Правила живуть ФУНКЦІЯМИ, а не виразами в JSX: їх виконують гейти `#2447`–`#2449` (той самий прийом, що `statsGran.ts`).
 *   • не більше `MAX_METRICS` показників (основний + до двох доданих) — інакше лінії злипаються;
 *   • не більше `MAX_UNITS` одиниць — осей у графіка лише дві: перша одиниця — ліва вісь, друга — права;
 *   • кілька показників — ОДИН скоуп (компанія АБО одна команда): 3 показники × 7 команд = 21 лінія, і зв'язку не видно;
 *   • напрямок (unit-серія) не поєднується: у нього власний розріз, не компанія й не команда.
 * Нових метрик тут немає — лише наявні серії `/api/statistics/series`.
 */

export const MAX_METRICS = 3;
export const MAX_UNITS = 2;

export type MultiMetric = { key: string; label: string; unit?: string; unitScope?: string; monthOnly?: boolean; weekOnly?: boolean };
export type AxisId = "left" | "right";

/** Одиниця осі: ₴, %, хв — як у метрики; без одиниці — штуки. */
export const unitKey = (m: { unit?: string }): string => m.unit ?? "шт";

/** Одиниці в порядку появи: перша — ліва вісь, друга — права. */
export function unitsOf(ms: { unit?: string }[]): string[] {
  const out: string[] = [];
  for (const m of ms) { const u = unitKey(m); if (!out.includes(u)) out.push(u); }
  return out;
}

/** Вісь лінії — за ОДИНИЦЕЮ її показника, а не за порядком лінії: два показники в гривнях ділять одну вісь. */
export function axisOf(units: string[], unit: string): AxisId {
  return units.indexOf(unit) === 1 ? "right" : "left";
}

/**
 * Чи можна додати показник до графіка, де вже є `selected` (основний — першим). Відмова завжди з причиною словами —
 * вимкнений пункт без пояснення читається як поломка.
 */
export function canAdd(selected: MultiMetric[], cand: MultiMetric): { ok: true } | { ok: false; reason: string } {
  if (selected.some((m) => m.key === cand.key)) return { ok: false, reason: "уже на графіку" };
  if (selected.some((m) => m.unitScope) || cand.unitScope)
    return { ok: false, reason: "напрямок має власний розріз (не компанія й не команда) — з іншими показниками його не поєднати" };
  if (selected.some((m) => m.monthOnly || m.weekOnly) || cand.monthOnly || cand.weekOnly)
    return { ok: false, reason: "цей показник має лише один крок — на спільному графіку точки не зійдуться" };
  if (selected.length >= MAX_METRICS) return { ok: false, reason: `на одному графіку — не більше ${MAX_METRICS} показників` };
  const units = unitsOf(selected);
  const u = unitKey(cand);
  if (!units.includes(u) && units.length >= MAX_UNITS)
    return { ok: false, reason: `третя одиниця («${u}») — осей лише дві: ліва для «${units[0]}», права для «${units[1]}»` };
  return { ok: true };
}

/**
 * Скоупи, що малюються: один показник — усі вибрані (як було); кілька — РІВНО ОДИН: перший вибраний у порядку легенди,
 * а якщо не вибрано нічого — перший у легенді (зазвичай компанія).
 */
export function drawnScopes(metricCount: number, order: string[], visible: Set<string>): string[] {
  const vis = order.filter((k) => visible.has(k));
  if (metricCount <= 1) return vis;
  const one = vis[0] ?? order[0];
  return one == null ? [] : [one];
}

export type MultiLine = { dataKey: string; metricKey: string; label: string; unit: string; yAxisId: AxisId };

/** Лінії графіка з кількома показниками: одна на показник (скоуп один), вісь — за одиницею. */
export function multiLines(ms: MultiMetric[]): MultiLine[] {
  const units = unitsOf(ms);
  return ms.map((m, j) => ({ dataKey: `m${j}`, metricKey: m.key, label: m.label, unit: unitKey(m), yAxisId: axisOf(units, unitKey(m)) }));
}

type Resp = { series: { scopeKey: string; points: { period: string; value: number }[] }[] } | null | undefined;

/** Рядки для recharts: період → `m{j}` = значення показника `j` в ОДНОМУ скоупі. Порожній показник лінії не дає, але й не ламає інших. */
export function multiRows(resps: Resp[], scopeKey: string | null): Record<string, number | string>[] {
  const map = new Map<string, Record<string, number | string>>();
  resps.forEach((r, j) => {
    const s = r?.series.find((x) => x.scopeKey === scopeKey);
    for (const p of s?.points ?? []) {
      const row = map.get(p.period) ?? { period: p.period };
      row[`m${j}`] = p.value;
      map.set(p.period, row);
    }
  });
  return [...map.keys()].sort().map((k) => map.get(k)!);
}
