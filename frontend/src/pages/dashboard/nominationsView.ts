/**
 * 🏆 НОМІНАЦІЇ ТИЖНЯ — ЛОГІКА ЕКРАНА БЕЗ РЕНДЕРУ (22.09.2026). Жодного імпорту під час виконання:
 * гейти (#650, #651) транспілюють цей файл і ВИКОНУЮТЬ його, а не читають очима. Типи — лише `import type`.
 *
 * Модель екрана (затверджено Романом 22.09): система ПРОПОНУЄ переможця з CRM, тімлід «Погоджуюсь» або
 * вводить «Свої дані» (хто, число, звідки воно). Рядок, де переможець — сам тімлід, вирішує керівництво.
 */
import type { NominationCell, NominationTeam, NominationWeek, NominationKey } from "../../api";

export type Unit = "uah" | "count" | "pct";

/** `?week=YYYY-MM-DD` із посилання Даші. Недійсна дата — `null` (сервер тоді покаже минулий тиждень). */
export function parseWeekParam(search: string): string | null {
  const m = /(?:^|[?&])week=(\d{4})-(\d{2})-(\d{2})(?:&|$)/.exec(search);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const iso = d.toISOString().slice(0, 10);
  return iso === `${m[1]}-${m[2]}-${m[3]}` ? iso : null;
}

/**
 * Число, яке людина ввела руками: «11 200», «11 200 ₴», «312%», «12,5». Порожнє, не-число, нуль і
 * відʼємне — `null` (сервер однаково прийняв би лише > 0). Досі «11 200» давало NaN → 400.
 */
export function parseAmount(s: string): number | null {
  const t = s.replace(/[\s  ]/g, "").replace(/₴|грн\.?|%/gi, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Зворотний відлік до фіксації: текст і рівень (жовтий — менше доби, червоний — менше 3 год). */
export function countdown(freezeInstant: string, nowMs: number): { text: string; level: "calm" | "warn" | "danger" | "past" } {
  const ms = Date.parse(freezeInstant) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return { text: "час вийшов", level: "past" };
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  const text = d > 0 ? `${d} д ${h} год` : h > 0 ? `${h} год ${m} хв` : `${m} хв`;
  return { text, level: ms < 3 * 3_600_000 ? "danger" : ms < 24 * 3_600_000 ? "warn" : "calm" };
}

/** Рядок «про» когось із `ids` (тімліда): переможець за CRM — він. Такий рядок вирішує керівництво. */
export const isAbout = (c: NominationCell, ids: readonly (number | null)[]): boolean =>
  c.crm.state === "ok" && c.crm.winners.some((w) => ids.includes(w));

export interface CellGroups { pending: NominationCell[]; done: NominationCell[]; about: NominationCell[]; empty: NominationCell[] }

/**
 * Групи карток (#650). `about` — рядки про тімліда (для самого тімліда — «про вас»); `empty` — ніхто не
 * набрав і рішення немає; `done` — погоджено або введено свої дані; `pending` — решта, те, що чекає.
 */
export function groupCells(cells: readonly NominationCell[], aboutIds: readonly (number | null)[], noCrmKeys: readonly string[] = []): CellGroups {
  const g: CellGroups = { pending: [], done: [], about: [], empty: [] };
  for (const c of cells) {
    if (isAbout(c, aboutIds)) g.about.push(c);
    else if (c.final.status === "confirmed" || c.final.status === "overridden") g.done.push(c);
    // Номінація, якої в CRM немає (лідогенератори): порожньо = «чекає ваших даних», а не «ніхто не набрав».
    else if (c.final.status === "empty" && !noCrmKeys.includes(c.nomination)) g.empty.push(c);
    else g.pending.push(c);
  }
  return g;
}

/**
 * Готовність команди для Даші (#650): з рядків, де є що вирішувати (є переможець або вже є рішення),
 * скільки вирішено; що ще чекає тімліда і що — керівництва (рядки про тімліда).
 */
export function teamProgress(t: NominationTeam): { done: number; total: number; waitLead: NominationKey[]; waitBoss: NominationKey[]; lastAt: string | null } {
  const leadIds = t.leads.map((l) => l.managerId);
  let done = 0, total = 0;
  const waitLead: NominationKey[] = [], waitBoss: NominationKey[] = [];
  let lastAt: string | null = null;
  for (const c of t.cells) {
    if (c.review && (!lastAt || c.review.at > lastAt)) lastAt = c.review.at;
    if (c.final.status === "empty") continue;
    total++;
    if (c.final.status === "confirmed" || c.final.status === "overridden") { done++; continue; }
    (isAbout(c, leadIds) ? waitBoss : waitLead).push(c.nomination);
  }
  return { done, total, waitLead, waitBoss, lastAt };
}

/** Підсумок зафіксованого тижня: чесно, скільки пішло пропозицією системи без рішення. */
export function frozenSummary(teams: readonly NominationTeam[]): { confirmed: number; own: number; noDecision: number } {
  let confirmed = 0, own = 0, noDecision = 0;
  for (const t of teams) for (const c of t.cells) {
    if (c.final.status === "confirmed") confirmed++;
    else if (c.final.status === "overridden") own++;
    else if (c.final.status === "unconfirmed") noDecision++;
  }
  return { confirmed, own, noDecision };
}

/**
 * Підказка у «Свої дані» (#651): число розходиться з CRM обраних людей, і в кого за CRM більше, ніж
 * введено. НЕ блокує збереження — лише пояснює (рішення 22.09: система пропонує, тімлід вирішує).
 */
export function ownDataHint(ranking: readonly { managerId: number; value: number | null }[], chosen: readonly number[], entered: number | null):
  { crmOfChosen: number | null; differs: boolean; higher: { managerId: number; value: number }[] } {
  const vals = ranking.filter((r) => chosen.includes(r.managerId)).map((r) => r.value ?? 0);
  const crmOfChosen = vals.length ? Math.max(...vals) : null;
  const differs = entered != null && crmOfChosen != null && Math.abs(entered - crmOfChosen) > 0.005;
  const higher = entered == null ? [] : ranking
    .filter((r): r is { managerId: number; value: number } => r.value != null && r.value > entered + 0.005 && !chosen.includes(r.managerId));
  return { crmOfChosen, differs, higher };
}

/** З чого складається число: вид розкриття Звіту (`/report-plan/day-items`). Для % маржі — угода-доказ, для міжнародних — поки ні. */
export const DRILL_KIND: Record<NominationKey, "received" | "dispatched" | null> = {
  maxDeal: "received", revenue: "received", cars: "dispatched", marginPct: null, intl: null,
  lgMaxDeal: null, lgCars: null, lgQuotes: null, lgIntl: null,
};

/** Відсоток конверсії до сотих (4/24 = 16,67%) — як на слайді, без «17,00%». */
export const convPct = (won: number, taken: number): string =>
  taken > 0 ? `${(Math.round((won / taken) * 10000) / 100).toFixed(2).replace(".", ",")}%` : "—";

export function fmtValue(unit: Unit, v: number | null): string {
  if (v == null) return "—";
  if (unit === "pct") return `${Math.round(v)}%`;
  if (unit === "uah") return `${Math.round(v).toLocaleString("uk-UA").replace(/ | /g, " ")} ₴`;
  return String(v);
}

const DM = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
/**
 * Текст, який Даша копіює в чат «Керівники» (#650): посилання на тиждень, дедлайн і ЛИШЕ ті команди,
 * де ще щось чекає тімліда. Повністю готові команди в перелік не потрапляють.
 */
export function leadsMessage(week: NominationWeek, origin: string): string {
  const due = week.freezeDueAt.slice(0, 10);
  const waiting = week.teams.map((t) => ({ t, p: teamProgress(t) })).filter((x) => x.p.waitLead.length > 0)
    .map((x) => `${x.t.teamName} (${x.p.done} з ${x.p.total})`);
  // Лідогенерація: номінації, яких система не рахує й де даних ще немає (їх вносить тімлід лідогену).
  const noCrm = new Set((week.leadgenDefs ?? []).filter((d) => d.noCrm).map((d) => d.key));
  const lgMissing = (week.leadgen?.cells ?? []).filter((c) => noCrm.has(c.nomination) && c.final.status !== "overridden")
    .map((c) => (week.leadgenDefs.find((d) => d.key === c.nomination)?.label ?? c.nomination).replace(/^Найбільш(ий|а) (кількість )?/, "").toLowerCase());
  return [
    `Система вже запропонувала переможців тижня ${DM(week.weekFrom)}–${DM(week.weekTo)} з CRM — рахувати руками не треба.`,
    `Відкрийте свою команду, перевірте й натисніть «Погоджуюсь» або «Свої дані» до вт ${DM(due)}, 08:00:`,
    `${origin}/nominations?week=${week.weekFrom}`,
    waiting.length ? `Ще чекаємо: ${waiting.join(", ")}.` : "Усі команди вже перевірили — дякуємо!",
    ...(lgMissing.length ? [`Лідогенерація: ще не внесено — ${lgMissing.join(", ")}.`] : []),
  ].join("\n");
}
