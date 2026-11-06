/**
 * 🎯 «ПЕРШИЙ ДОТИК» — ЦІНУ НАЗВАНО В ПЕРШІЙ РОЗМОВІ (ТЗ-3 §3.2, 17.09.2026). ЧИСТИЙ МОДУЛЬ.
 *
 * Джерело з 02.11.2026 (задача 7237) — AI-розбір розмов екрана «Перший дотик · AI»: лічильники рахує
 * `core/firstTouch.ts` тим самим правилом, що плитка «Ціна озвучена». До того — лист зовнішнього
 * uts-bot (`first_touch_analysis`), який замовк 25.09.2026; його в Звіт більше не домішуємо.
 *
 * Тут — відбір розмов, стани й суми (чисте: без пулу, тож виконується в `npm test`):
 *  · ЧЕСНІ СТАНИ: період, у якому розбору не існувало, — «не вимірюється», а не 0 з 0; розмови,
 *    яких AI ще не розібрав, — окремим числом і ПОЗА відсотком;
 *  · дотик належить тому, хто дзвонив (менеджер розмови на екрані AI);
 *  · доступ — як у решти Звіту (менеджер бачить картки своєї команди).
 */
import { checklist, countsForTeam, type ReportRowIn } from "./firstTouchTeamReport.js";

export interface FirstTouchCounts { analyzed: number; voiced: number; noRecord: number }
export type FirstTouchState = "measured" | "not_covered";
export interface FirstTouchCell extends FirstTouchCounts { state: FirstTouchState }

/**
 * Розмови екрана AI → лічильники Звіту по менеджеру (задача 7237). Відбір — як плитка «Ціна озвучена»:
 * вкладка «Звіт» (`inReport`, як `tabRows(…, "report")`) без нецільових (`nonTarget`, як
 * `DEFAULT_LIST_FILTER`); ціна — `checklist().price`: «так» — названо, «ні» — не названо, «не рахується»
 * (втрачений лід, «передзвоніть») у знаменник не входить; нерозібрані — `noRecord`, поза відсотком.
 */
export type FirstTouchCall = ReportRowIn & { managerId: number | null; teamId: number | null; nonTarget: boolean };
export function firstTouchCountsFromCalls(calls: readonly FirstTouchCall[]): {
  byManager: Map<number, FirstTouchCounts>;
  rows: { managerId: number; teamId: number | null; counts: FirstTouchCounts }[];
  unmapped: FirstTouchCounts;
} {
  const by = new Map<number | null, { teamId: number | null; c: FirstTouchCounts }>();
  for (const r of calls) {
    // 🌱 Задача 7239 п.3 (Роман 06.11.2026 «2 а»): розмови менеджера на адаптації у Звіті не рахуються — ні в його клітинці,
    // ні в команді (інакше Σ команди ≠ Σ клітинок); їх видно окремим блоком на екрані AI і в звіті тімліда.
    if (!r.inReport || r.nonTarget || !countsForTeam(r)) continue;
    const e = by.get(r.managerId) ?? { teamId: r.teamId, c: { analyzed: 0, voiced: 0, noRecord: 0 } };
    const mark = checklist(r)?.price;
    if (mark == null) e.c.noRecord++;
    else if (mark !== "o") { e.c.analyzed++; if (mark === "y") e.c.voiced++; }
    by.set(r.managerId, e);
  }
  const byManager = new Map<number, FirstTouchCounts>();
  const rows: { managerId: number; teamId: number | null; counts: FirstTouchCounts }[] = [];
  for (const [id, e] of by) if (id != null) { byManager.set(id, e.c); rows.push({ managerId: id, teamId: e.teamId, counts: e.c }); }
  return { byManager, rows, unmapped: by.get(null)?.c ?? { analyzed: 0, voiced: 0, noRecord: 0 } };
}

/** Клітинка менеджера: чесний стан і лічильники. Період без розбору — лічильники нульові й не показуються. */
export function firstTouchCell(counts: FirstTouchCounts | undefined, covered: boolean): FirstTouchCell {
  // Оцінки є, а період «не покритий» — не буває за побудовою, але ховати наявні гірше, ніж показати.
  const has = (counts?.analyzed ?? 0) + (counts?.noRecord ?? 0) > 0;
  return {
    state: covered || has ? "measured" : "not_covered",
    analyzed: counts?.analyzed ?? 0, voiced: counts?.voiced ?? 0, noRecord: counts?.noRecord ?? 0,
  };
}

/** Відсоток «ціну названо» — від ОЦІНЕНИХ розмов; нерозібрані у знаменник не входять. `null` = нема з чого рахувати. */
export const firstTouchPct = (voiced: number, analyzed: number): number | null =>
  analyzed > 0 ? Math.round((voiced / analyzed) * 1000) / 10 : null;

/**
 * 🔴 ОЦІНКИ ЛЮДЕЙ ПОЗА РОСТЕРОМ НЕ ЗНИКАЮТЬ (рецензія 17.09.2026). Ростер Звіту — ті, кому
 * ставиться план; людина в стані «завершує» чи звільнена з нього випадає, але її розмови в
 * періоді були. Розмова несе її як менеджера, тож у «не прив'язано» вона не потрапляє — і без
 * цього числа її оцінки зникали б з екрана цілком. Рахуємо лише в межах того самого скоупу, що й
 * ростер: команда — за ПОТОЧНОЮ командою людини, менеджер — лише він сам.
 */
export function firstTouchOutsideRoster(
  rows: { managerId: number; teamId: number | null; counts: FirstTouchCounts }[],
  rosterIds: ReadonlySet<number>,
  scope: { managerId?: number | null; teamId?: number | null },
): FirstTouchCounts {
  return sumFirstTouch(rows
    .filter((r) => !rosterIds.has(r.managerId))
    .filter((r) => (scope.managerId ? r.managerId === scope.managerId : scope.teamId ? r.teamId === scope.teamId : true))
    .map((r) => r.counts));
}

export interface GlanceFirstTouch extends FirstTouchCounts { state: FirstTouchState; outside: FirstTouchCounts }

/**
 * Підсумок команди: Σ клітинок ростеру + стан + окремо «поза ростером». Стан «не вимірюється» —
 * лише коли жодна клітинка не виміряна І поза ростером оцінок немає: інакше підсумок команди
 * казав би «—» і «число неповне» за період, у якому розбору не було взагалі.
 */
export function glanceFirstTouch(cells: FirstTouchCell[], outside: FirstTouchCounts): GlanceFirstTouch {
  const measured = cells.some((c) => c.state === "measured") || outside.analyzed + outside.noRecord > 0;
  return { ...sumFirstTouch(cells), state: measured ? "measured" : "not_covered", outside };
}

/** Σ клітинок — підсумок команди. Відсоток ПОТІМ, із сум, а не середнім відсотків. */
export function sumFirstTouch(cells: FirstTouchCounts[]): FirstTouchCounts {
  return cells.reduce((s, c) => ({ analyzed: s.analyzed + c.analyzed, voiced: s.voiced + c.voiced, noRecord: s.noRecord + c.noRecord }),
    { analyzed: 0, voiced: 0, noRecord: 0 });
}
