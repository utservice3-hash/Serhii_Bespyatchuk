import type { PromiseState } from "./callAiPromise.js";
import { median } from "./leadReaction.js";

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
 *   не передзвонив         — його дзвінка немає, а дзвінки вже синхронізовано за термін;
 *   втрачені ліди          — розібрано, тип `lead_lost` (05.10.2026): запит став неактуальним; поруч — медіана хвилин
 *                            від заявки до першого нашого вихідного саме по втрачених. Втрачений лід — у «прийнято», але
 *                            НЕ в знаменнику ціни й не в «без ціни»: називати ціну там нікому (рішення власника 05.10).
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
  conversationType?: string | null;
  reactionMin?: number | null;
  /** Екран D (08.10.2026): чи витягла модель запит клієнта, і чи розібрав розмову тімлід. */
  hasRequest?: boolean;
  reviewNote?: { text: string } | null;
  /** Заперечення з окремої рубрики (ТЗ 08.10.2026); `null`/відсутнє — ще не розібрано цією рубрикою. */
  objection?: { present: boolean; handled: string } | null;
}

export interface ManagerLine {
  managerId: number | null;
  managerName: string;
  teamName: string | null;
  accepted: number;
  analysed: number;
  priceVoiced: number;
  /** Частка від розібраних, крім втрачених лідів; `null` — таких немає (не 0 %). */
  pricePct: number | null;
  noPriceNoComment: number;
  agreements: number;
  done: number;
  late: number;
  missed: number;
  lost: number;
  /** Медіана хвилин від заявки до першого вихідного по втрачених; `null` — втрачених немає чи дзвінків не знайдено. */
  lostReactionMedianMin: number | null;
}

const CALL_PROMISE: ReadonlySet<PromiseState> = new Set(["kept_talk", "kept_attempt_only", "kept_offline", "client_called", "late", "pending", "broken"]);

export const isAnalysed = (r: ReportRowIn): boolean => r.inReport && r.state === "done";
export const isLost = (r: ReportRowIn): boolean => isAnalysed(r) && r.conversationType === "lead_lost";
/** Де ціну мали назвати: розібрано й це не втрачений лід. */
/** Клієнтові було незручно говорити, просив передзвонити (рубрика v4, 09.10.2026): запиту й ціни не було кому чути. */
export const isCallLater = (r: ReportRowIn): boolean => isAnalysed(r) && r.conversationType === "call_later";
export const isPriceable = (r: ReportRowIn): boolean => isAnalysed(r) && !isLost(r) && !isCallLater(r);
export const noPrice = (r: ReportRowIn): boolean => isPriceable(r) && r.priceDiscussed === false;
export const noPriceNoComment = (r: ReportRowIn): boolean => noPrice(r) && !r.priceNote;
export const hasAgreement = (r: ReportRowIn): boolean => isAnalysed(r) && r.promiseState != null && CALL_PROMISE.has(r.promiseState);
/** Банер (п.6.3): лише «не передзвонив», і лише поки тімлід не написав «Опрацьовано». */
export const inBanner = (r: ReportRowIn): boolean => r.inReport && r.promiseState === "broken" && !r.missedNote;

function line(rows: readonly ReportRowIn[], managerId: number | null, managerName: string, teamName: string | null): ManagerLine {
  const mine = rows.filter((r) => r.inReport);
  const analysed = mine.filter(isAnalysed);
  const priceable = mine.filter(isPriceable);
  const priceVoiced = priceable.filter((r) => r.priceDiscussed === true).length;
  const lost = mine.filter(isLost);
  return {
    managerId, managerName, teamName,
    accepted: mine.length,
    analysed: analysed.length,
    priceVoiced,
    pricePct: priceable.length ? Math.round((priceVoiced / priceable.length) * 1000) / 10 : null,
    noPriceNoComment: mine.filter(noPriceNoComment).length,
    agreements: mine.filter(hasAgreement).length,
    done: mine.filter((r) => hasAgreement(r) && (r.promiseState === "kept_talk" || r.promiseState === "kept_attempt_only" || r.promiseState === "kept_offline")).length,
    late: mine.filter((r) => hasAgreement(r) && r.promiseState === "late").length,
    missed: mine.filter((r) => hasAgreement(r) && r.promiseState === "broken").length,
    lost: lost.length,
    lostReactionMedianMin: median(lost.map((r) => r.reactionMin).filter((m): m is number => typeof m === "number")),
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

export type PoolFilter = "all" | "noPrice" | "noComment" | "missed" | "typeCheck" | "lost";
/** Пул заявок менеджера (п.6.2) і його швидкі фільтри — ті самі предикати, що й клітинки таблиці. */
export function poolRows<T extends ReportRowIn>(rows: readonly T[], managerId: number | null | "all", f: PoolFilter): T[] {
  return rows.filter((r) => r.inReport && (managerId === "all" || r.managerId === managerId)
    && (f === "all" || (f === "noPrice" && noPrice(r)) || (f === "noComment" && noPriceNoComment(r))
      || (f === "missed" && hasAgreement(r) && r.promiseState === "broken") || (f === "typeCheck" && r.typeCheck) || (f === "lost" && isLost(r))));
}

/**
 * ✅ ЧЕК-ЛИСТ ПЕРШОГО ДОТИКУ (екран D, рішення Романа 08.10.2026 «роби D з 3 пунктів»). Три пункти, кожен — `y` виконано,
 * `n` ні, `o` не рахується (і не йде в знаменник балу):
 *   запит    — модель витягла запит клієнта (що й куди везти); `n`, якщо не витягла; `o` — втрачений лід (клієнт уже
 *              відмовився, розпитувати нема про що — рішення Романа 08.10.2026, як і для ціни);
 *   ціна     — ціну назвали; `n` — не назвали; `o` — втрачений лід (називати нікому, правило 05.10);
 *   обіцянка — передзвонив (з розмовою чи лише спробами), «поза телефонією», клієнт сам подзвонив → `y`; запізнився чи
 *              дзвінка немає → `n`; обіцянки передзвонити не було або термін ще не настав → `o`;
 *   заперечення — (ТЗ 08.10.2026, критерій 4) було й опрацьоване → `y`; було й не опрацьоване → `n`; не було або рубрика
 *              заперечень ще не пройшла → `o` (не рахується — «не знаємо» не читається як «ні»).
 * Пункти «заперечення» й «наступний крок» свідомо НЕ тут: модель не каже, чи відпрацьовано заперечення і чий крок.
 * Нерозібрана розмова чек-листа не має (`null`) — «ще не знаємо» не читається як «ні».
 */
export type CheckMark = "y" | "n" | "o";
export interface Checklist { request: CheckMark; price: CheckMark; promise: CheckMark; objection: CheckMark }

const PROMISE_YES: ReadonlySet<PromiseState> = new Set(["kept_talk", "kept_attempt_only", "kept_offline", "client_called"]);
const PROMISE_NO: ReadonlySet<PromiseState> = new Set(["late", "broken"]);

export function checklist(r: ReportRowIn): Checklist | null {
  if (!isAnalysed(r)) return null;
  const ps = r.promiseState;
  return {
    request: isLost(r) || isCallLater(r) ? "o" : r.hasRequest ? "y" : "n",
    price: isLost(r) || isCallLater(r) ? "o" : r.priceDiscussed === true ? "y" : "n",
    promise: ps != null && PROMISE_YES.has(ps) ? "y" : ps != null && PROMISE_NO.has(ps) ? "n" : "o",
    objection: !r.objection?.present ? "o" : r.objection.handled === "handled" ? "y" : r.objection.handled === "not_handled" ? "n" : "o",
  };
}

/** Бал = виконані ÷ ті, що рахуються. `null` — розмову не розібрано. */
export function checklistScore(c: Checklist | null): { yes: number; total: number } | null {
  if (!c) return null;
  const m = [c.request, c.price, c.promise, c.objection];
  return { yes: m.filter((x) => x === "y").length, total: m.filter((x) => x !== "o").length };
}

/**
 * Черга розбору тімліда: розмова у звіті, розібрана, і з неї є що сказати менеджеру — ціни не було, обіцянку
 * прострочено чи не виконано, або лід втрачено. Виходить з черги, щойно тімлід поставив «Розібрано» або вже написав
 * «Опрацьовано» (той самий розбір, лише для невиконаної обіцянки).
 */
export type ReviewReason = "noCall" | "late" | "noPrice" | "lost";
export function reviewReason(r: ReportRowIn): ReviewReason | null {
  if (!isAnalysed(r)) return null;
  if (r.promiseState === "broken") return "noCall";
  if (isLost(r)) return "lost";
  if (noPrice(r)) return "noPrice";
  if (r.promiseState === "late") return "late";
  return null;
}
export const isReviewed = (r: ReportRowIn): boolean => r.reviewNote != null || r.missedNote != null;
export const needsReview = (r: ReportRowIn): boolean => reviewReason(r) != null && !isReviewed(r);

export interface ReviewQueue { total: number; reviewed: number; left: number; byReason: Record<ReviewReason, number> }
/** Лічильники смуги «Черга розбору»: `total` — усі, що потребують розбору; `left` — ще не розібрані. */
export function reviewQueue(rows: readonly ReportRowIn[]): ReviewQueue {
  const due = rows.filter((r) => reviewReason(r) != null);
  const left = due.filter((r) => !isReviewed(r));
  const byReason: Record<ReviewReason, number> = { noCall: 0, late: 0, noPrice: 0, lost: 0 };
  for (const r of left) byReason[reviewReason(r)!]++;
  return { total: due.length, reviewed: due.length - left.length, left: left.length, byReason };
}
