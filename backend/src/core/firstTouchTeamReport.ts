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
  /** 🌱 Розмова менеджера на адаптації (задача 7239 п.3) — не в балі команди. */
  adaptation?: boolean | null;
  uniqueid: string;
  calledAt: string;
  managerId: number | null;
  managerName: string | null;
  teamName: string | null;
  inReport: boolean;
  state: string;
  priceDiscussed: boolean | null;
  promiseState: PromiseState | null;
  /** ✍️ Обіцянки менеджера в розмові: усі й з них «написати / інша дія» (задача 7240). */
  managerPromises?: number;
  managerWritePromises?: number;
  typeCheck: boolean;
  priceNote: { text: string } | null;
  missedNote: { text: string; at?: string } | null;
  conversationType?: string | null;
  reactionMin?: number | null;
  /** Екран D (08.10.2026): чи витягла модель запит клієнта, і чи розібрав розмову тімлід. */
  hasRequest?: boolean;
  reviewNote?: { text: string; at?: string } | null;
  /** Заперечення з окремої рубрики (ТЗ 08.10.2026); `null`/відсутнє — ще не розібрано цією рубрикою. */
  objection?: { present: boolean; handled: string } | null;
  /** Сира відповідь моделі «чим закінчилось після ціни» (рубрика заперечень v2, з 13.10.2026). */
  decision?: { value: string; quote: string; quoteFound: boolean | null } | null;
  /** 💬 «Коментар менеджера» до розмови з черги (задача 7183, 28.10.2026); `null` — не писав. */
  explainNote?: { text: string; at?: string } | null;
  /** ✍️ Коментар (`explain` чи `price`) написав САМ менеджер цієї розмови — акаунт, привʼязаний до її менеджера (задача 7351). */
  managerCommented?: boolean;
  /** Угода розмови заходила в «Виставлення рахунку» або далі (за фактом входу; `firstTouchOutcome.dealsReachedInvoice`). */
  reachedInvoice?: boolean;
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
  /** ✍️ Задача 7240: обіцянок менеджера всього; з них «написати / інша дія»; частка, % (`null` — обіцянок немає). */
  promises: number;
  writePromises: number;
  writePct: number | null;
  /** Розмов, де обіцяв написати, термін минув, а сліду в CRM немає. */
  noTrace: number;
}

/** ✍️ Обіцяв написати — сліду в CRM немає (задача 7240): та сама умова для клітинки, фільтра пулу й прапорця рядка. */
export const isNoTrace = (r: ReportRowIn): boolean => isAnalysed(r) && r.promiseState === "no_trace";

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

/** Частка обіцянок «написати / не перевіряється» від усіх обіцянок менеджера в розібраних розмовах. */
export function writeShare(analysed: readonly ReportRowIn[]): { promises: number; writePromises: number; writePct: number | null } {
  const promises = analysed.reduce((n, r) => n + (r.managerPromises ?? 0), 0);
  const writePromises = analysed.reduce((n, r) => n + (r.managerWritePromises ?? 0), 0);
  return { promises, writePromises, writePct: promises ? Math.round((writePromises / promises) * 1000) / 10 : null };
}

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
    ...writeShare(analysed),
    noTrace: mine.filter(isNoTrace).length,
  };
}

export interface TeamReport {
  managers: ManagerLine[];
  total: ManagerLine;
  /** 🌱 Задача 7239 п.3: менеджери в перші 4 тижні від прийому — окремо; у `managers` і «Разом» їхні розмови не входять. */
  adaptation: ManagerLine[];
  banner: { total: number; byManager: { managerId: number | null; managerName: string; count: number }[] };
}

/** Рядок на менеджера (той, хто говорив) + «Разом». Менеджер без привʼязки — окремим рядком «Менеджер невідомий». */
function byManagerGroups(rows: readonly ReportRowIn[]): ReportRowIn[][] {
  const groups = new Map<string, ReportRowIn[]>();
  for (const r of rows) {
    const k = r.managerId == null ? "none" : String(r.managerId);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  return [...groups.values()];
}
const managerLines = (rows: readonly ReportRowIn[]): ManagerLine[] => byManagerGroups(rows)
  .map((g) => line(g, g[0].managerId, g[0].managerName ?? "Менеджер невідомий", g[0].teamName))
  .filter((l) => l.accepted > 0)
  .sort((a, b) => a.managerName.localeCompare(b.managerName, "uk"));

/** Не в балі команди — розмова менеджера на адаптації (задача 7239 п.3, `core/firstTouchAdaptation.ts`). */
export const countsForTeam = (r: { adaptation?: boolean | null }): boolean => r.adaptation !== true;

export function teamReport(rows: readonly ReportRowIn[]): TeamReport {
  const team = rows.filter(countsForTeam);
  // Банер «дзвінка в телефонії немає» — операційний, а не бал: у ньому всі, і новачки теж.
  const bannerRows = rows.filter(inBanner);
  const byManager = byManagerGroups(rows).map((g) => ({ managerId: g[0].managerId, managerName: g[0].managerName ?? "Менеджер невідомий", count: g.filter(inBanner).length }))
    .filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
  return { managers: managerLines(team), total: line(team, null, "Разом", null), adaptation: managerLines(rows.filter((r) => !countsForTeam(r))),
    banner: { total: bannerRows.length, byManager } };
}

export type PoolFilter = "all" | "noPrice" | "noComment" | "missed" | "typeCheck" | "lost" | "noTrace";
/** Пул заявок менеджера (п.6.2) і його швидкі фільтри — ті самі предикати, що й клітинки таблиці. */
export function poolRows<T extends ReportRowIn>(rows: readonly T[], managerId: number | null | "all", f: PoolFilter): T[] {
  return rows.filter((r) => r.inReport && (managerId === "all" || r.managerId === managerId)
    && (f === "all" || (f === "noPrice" && noPrice(r)) || (f === "noComment" && noPriceNoComment(r))
      || (f === "missed" && hasAgreement(r) && r.promiseState === "broken") || (f === "typeCheck" && r.typeCheck) || (f === "lost" && isLost(r)) || (f === "noTrace" && isNoTrace(r))));
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

const PROMISE_YES: ReadonlySet<PromiseState> = new Set(["kept_talk", "kept_attempt_only", "kept_offline", "client_called", "kept_trace"]);
const PROMISE_NO: ReadonlySet<PromiseState> = new Set(["late", "broken", "no_trace"]);

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

/**
 * 🤝 ЗГОДА ПІСЛЯ ЦІНИ (рішення Романа 13.10.2026): ОКРЕМА інформація лише для розмов, де ціну назвали (пункт «ціна» = `y`),
 * і в бал НЕ входить — це рішення клієнта, а не дія менеджера; бал карав би за дорогий рейс.
 *   `agreed` / `thinking` / `declined` — відповідь моделі; `unclear` — ціну назвали, а модель каже «ціни не було»
 *   (основний розбір і рубрика заперечень розійшлись: чесне «не визначено», не вгадуємо котрий правий);
 *   `null` — ціни не було, розмову не розібрано, або рубрика v2 її не розбирала (дзвінки до 13.10).
 */
export type ClientDecisionView = { value: "agreed" | "thinking" | "declined" | "unclear"; quote: string; quoteFound: boolean | null };
export function clientDecision(r: ReportRowIn): ClientDecisionView | null {
  if (checklist(r)?.price !== "y" || !r.decision) return null;
  const v = r.decision.value;
  if (v === "agreed" || v === "thinking" || v === "declined") return { value: v, quote: r.decision.quote, quoteFound: r.decision.quoteFound };
  return { value: "unclear", quote: "", quoteFound: null };
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
/**
 * ✍️ ЗАКРИВАЄ ЛИШЕ КОМЕНТАР МЕНЕДЖЕРА (задача 7351, регламент Юлії від 30.10; рішення Романа 03.11.2026: «тільки з
 * сьогодні»). Менеджер пише, що було далі, і лише тоді тімлід закриває; помилка AI — «Зворотний звʼязок», а не закриття.
 * Коментар рахується, лише якщо його написав САМ менеджер розмови (`managerCommented`): заміряно 03.11 — у 185 із 270
 * «погоджених коментарів» коментар писав той самий тімлід, що й закривав.
 * Сервер і кнопки забороняють «Розібрано» без такого коментаря з викату 03.11; підрахунок «чим закрито» — з 04.11 (Київ):
 * усе, закрите ДО цього (зокрема 03.11 до викату: 5 розмов без коментаря менеджера, замір 15:50), лишається закритим як було.
 */
export const REVIEW_MANAGER_COMMENT_FROM = "2026-11-04";
const kyivDay = (iso: string): string => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
/** Позначку поставлено до правила 7351 — діє старе правило 7183 (тімлід міг закрити сам). Без дати — стара фікстура. */
const beforeCommentRule = (n: { at?: string }): boolean => !n.at || kyivDay(n.at) < REVIEW_MANAGER_COMMENT_FROM;

/** Чим закрито розмову з черги — підпис для екрана; `null` — не закрито (або в черзі нічого не було). */
export type ReviewClosure = "approved" | "direct" | "invoice";
/**
 * Виходить з черги (задача 7183, рішення Романа 28.10.2026): тімлід поставив «Розібрано» / «Опрацьовано», АБО угода
 * дійшла до «Виставлення рахунку» чи далі. Друге — лише про чергу: плитки й статистика рахують розмову як і раніше,
 * успіх і далі — від «Авто працює». З `REVIEW_MANAGER_COMMENT_FROM` позначка тімліда закриває лише разом із коментарем
 * менеджера розмови (задача 7351); без нього розмова лишається в черзі.
 */
export function reviewClosure(r: ReportRowIn): ReviewClosure | null {
  const marks = [r.reviewNote, r.missedNote].filter((n): n is { text: string; at?: string } => n != null);
  if (marks.some(beforeCommentRule)) return r.explainNote != null || r.priceNote != null ? "approved" : "direct";
  if (marks.length && r.managerCommented === true) return "approved";
  return r.reachedInvoice === true ? "invoice" : null;
}
export const isReviewed = (r: ReportRowIn): boolean => reviewClosure(r) != null;
export const needsReview = (r: ReportRowIn): boolean => reviewReason(r) != null && !isReviewed(r);
/** Чи можна поставити «Розібрано» зараз: менеджер розмови сам написав коментар (задача 7351). Сервер і кнопка — одним правилом. */
export const canCloseReview = (r: Pick<ReportRowIn, "managerCommented">): boolean => r.managerCommented === true;
/** Відповідь сервера, коли коментаря менеджера ще немає. */
export const REVIEW_NEEDS_COMMENT_UA = "Закрити можна після коментаря менеджера: менеджер пише, що було далі. Якщо помилився AI — натисніть «Зворотний звʼязок».";

export interface ReviewQueue { total: number; reviewed: number; left: number; byReason: Record<ReviewReason, number> }
/** Лічильники смуги «Черга розбору»: `total` — усі, що потребують розбору; `left` — ще не розібрані. */
export function reviewQueue(rows: readonly ReportRowIn[]): ReviewQueue {
  const due = rows.filter((r) => reviewReason(r) != null);
  const left = due.filter((r) => !isReviewed(r));
  const byReason: Record<ReviewReason, number> = { noCall: 0, late: 0, noPrice: 0, lost: 0 };
  for (const r of left) byReason[reviewReason(r)!]++;
  return { total: due.length, reviewed: due.length - left.length, left: left.length, byReason };
}
