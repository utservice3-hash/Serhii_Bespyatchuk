import type { PromiseState } from "./callAiPromise.js";

/**
 * 📊 ЗВІТ ТІМЛІДА «ПЕРШИЙ ДОТИК» (ТЗ «звіт тімліда» 30.09.2026, п.6). Чисте ядро над ТИМИ САМИМИ рядками, що й
 * вкладка «Перший дотик» (`aiCallsList`), — тож число в таблиці й пул заявок за ним розійтись не можуть: пул — це
 * рівно ті рядки, з яких пораховано клітинку. Рахуються лише розмови У ЗВІТІ (запити на перевезення, `inReport`).
 *
 *   прийнято заявок        — розмови у звіті;
 *   з них розібрано        — є витяг моделі (знаменник відсотка: нерозібране не читається як «ціну не назвали»);
 *   озвучено ціну          — розібрано й ціну обговорили;
 *   без ціни й коментаря   — розібрано, ціни не було, «Чому не озвучено ціну» ніхто не написав;
 *   домовленостей          — розібрано й є обіцянка менеджера ПЕРЕДЗВОНИТИ (месенджер не перевіряється й сюди не йде);
 *   виконано               — передзвонив до терміну (з розмовою чи лише спробами) — той, хто обіцяв; або позначено
 *                            «передзвонив поза телефонією» (мобільний, месенджер, інший номер — 01.10.2026);
 *   запізнився             — передзвонив, але після терміну;
 *   не передзвонив         — його дзвінка немає, а дзвінки вже синхронізовано за термін.
 */

export interface ReportRowIn {
  uniqueid: string;
  calledAt: string;
  managerId: number | null;
  managerName: string | null;
  teamName: string | null;
  inReport: boolean;
  state: string;
  priceDiscussed: boolean | null;
  promiseState: PromiseState | null;
  typeCheck: boolean;
  priceNote: { text: string } | null;
  missedNote: { text: string } | null;
}

export interface ManagerLine {
  managerId: number | null;
  managerName: string;
  teamName: string | null;
  accepted: number;
  analysed: number;
  priceVoiced: number;
  /** Частка від розібраних; `null` — розібраних немає (не 0 %). */
  pricePct: number | null;
  noPriceNoComment: number;
  agreements: number;
  done: number;
  late: number;
  missed: number;
}

const CALL_PROMISE: ReadonlySet<PromiseState> = new Set(["kept_talk", "kept_attempt_only", "kept_offline", "client_called", "late", "pending", "broken"]);

export const isAnalysed = (r: ReportRowIn): boolean => r.inReport && r.state === "done";
export const noPrice = (r: ReportRowIn): boolean => isAnalysed(r) && r.priceDiscussed === false;
export const noPriceNoComment = (r: ReportRowIn): boolean => noPrice(r) && !r.priceNote;
export const hasAgreement = (r: ReportRowIn): boolean => isAnalysed(r) && r.promiseState != null && CALL_PROMISE.has(r.promiseState);
/** Банер (п.6.3): лише «не передзвонив», і лише поки тімлід не написав «Опрацьовано». */
export const inBanner = (r: ReportRowIn): boolean => r.inReport && r.promiseState === "broken" && !r.missedNote;

function line(rows: readonly ReportRowIn[], managerId: number | null, managerName: string, teamName: string | null): ManagerLine {
  const mine = rows.filter((r) => r.inReport);
  const analysed = mine.filter(isAnalysed);
  const priceVoiced = analysed.filter((r) => r.priceDiscussed === true).length;
  return {
    managerId, managerName, teamName,
    accepted: mine.length,
    analysed: analysed.length,
    priceVoiced,
    pricePct: analysed.length ? Math.round((priceVoiced / analysed.length) * 1000) / 10 : null,
    noPriceNoComment: mine.filter(noPriceNoComment).length,
    agreements: mine.filter(hasAgreement).length,
    done: mine.filter((r) => hasAgreement(r) && (r.promiseState === "kept_talk" || r.promiseState === "kept_attempt_only" || r.promiseState === "kept_offline")).length,
    late: mine.filter((r) => hasAgreement(r) && r.promiseState === "late").length,
    missed: mine.filter((r) => hasAgreement(r) && r.promiseState === "broken").length,
  };
}

export interface TeamReport {
  managers: ManagerLine[];
  total: ManagerLine;
  banner: { total: number; byManager: { managerId: number | null; managerName: string; count: number }[] };
}

/** Рядок на менеджера (той, хто говорив) + «Разом». Менеджер без привʼязки — окремим рядком «Менеджер невідомий». */
export function teamReport(rows: readonly ReportRowIn[]): TeamReport {
  const groups = new Map<string, ReportRowIn[]>();
  for (const r of rows) {
    const k = r.managerId == null ? "none" : String(r.managerId);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  const managers = [...groups.values()].map((g) => line(g, g[0].managerId, g[0].managerName ?? "Менеджер невідомий", g[0].teamName))
    .filter((l) => l.accepted > 0)
    .sort((a, b) => a.managerName.localeCompare(b.managerName, "uk"));
  const bannerRows = rows.filter(inBanner);
  const byManager = [...groups.values()].map((g) => ({ managerId: g[0].managerId, managerName: g[0].managerName ?? "Менеджер невідомий", count: g.filter(inBanner).length }))
    .filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
  return { managers, total: line(rows, null, "Разом", null), banner: { total: bannerRows.length, byManager } };
}

export type PoolFilter = "all" | "noPrice" | "noComment" | "missed" | "typeCheck";
/** Пул заявок менеджера (п.6.2) і його швидкі фільтри — ті самі предикати, що й клітинки таблиці. */
export function poolRows<T extends ReportRowIn>(rows: readonly T[], managerId: number | null | "all", f: PoolFilter): T[] {
  return rows.filter((r) => r.inReport && (managerId === "all" || r.managerId === managerId)
    && (f === "all" || (f === "noPrice" && noPrice(r)) || (f === "noComment" && noPriceNoComment(r))
      || (f === "missed" && hasAgreement(r) && r.promiseState === "broken") || (f === "typeCheck" && r.typeCheck)));
}
