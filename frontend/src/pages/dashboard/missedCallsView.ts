import { addDays, navBy, periodOf, type PeriodState } from "./periodRules";

/**
 * 📵 ЧИСТІ ПРАВИЛА ВКЛАДКИ «ПРОПУЩЕНІ ДЗВІНКИ» — без React, щоб гейти бекенду їх ВИКОНУВАЛИ
 * (транспіляція на льоту, прийом `#138`), а не читали регуляркою.
 */

/**
 * 🔴 ДЕФОЛТ — «ВЧОРА», І ПЕРІОД СВІЙ, А НЕ СПІЛЬНИЙ `dateRange` (ТЗ §1.4 A, звірка 16.09.2026).
 * Доти вкладка брала `dateRange` із `localStorage`, а змінити його з видимих екранів неможливо
 * з 23.07.2026 (Огляд і Команди приховані). Тобто кожен бачив період, збережений при першому
 * заході, — і жодного способу його зсунути. Той самий дефект уже лікували на «Рекламі».
 * «Вчора», бо тімлід розбирає пропущені за минулий повний день; сьогоднішній ще не закінчився.
 */
export function missedDefaultPeriod(today: string): PeriodState {
  const y = addDays(today, -1);
  return { mode: "day", anchor: y, focusDay: y, rangeFrom: addDays(today, -7), rangeTo: y };
}

/**
 * День списку дзвінків (блок C) після зміни періоду. Той, що вже обрано, лишається, якщо входить у
 * новий період; інакше — кінець періоду, але НЕ майбутній день (рецензія 17.09.2026: «Поточний
 * тиждень» відкривав список на неділю й казав «пропущених немає»). Період цілком у майбутньому —
 * його початок.
 */
export function clampListDay(day: string | null, from: string, to: string, today: string): string {
  if (day && day >= from && day <= to) return day;
  if (to <= today) return to;
  return today >= from ? today : from;
}

/**
 * 📈 КУДИ ПЕРЕЇХАВ ГРАФІК «ДИНАМІКА» (Роман 25.11.2026: «із вкладки пропущених забрати графіки, перенести все у
 * Статистики, щоб не дублювалась інформація»). Ті самі чотири показники тепер — розділ «📵 Пропущені дзвінки» на
 * «Статистиках» (ядро те саме, `core/missedCalls.missedSeries`); на вкладці лишився лише цей вхід.
 */
export const MISSED_STATS_HREF = "/statistics?cat=missed";

export interface TeamLike { teamId: number | null }
export interface PersonLike { managerId: number | null; teamId: number | null }

/**
 * Розкладка людей під рядки команд. «Без відповідального» (managerId `null`) сюди НЕ йде —
 * у нього свій рядок. Людина, чия команда раптом не прийшла рядком, не зникає: вона
 * лишається в `orphans` і малюється окремо — втратити рядок мовчки гірше, ніж показати криво.
 */
export function groupByTeam<T extends TeamLike, P extends PersonLike>(teams: T[], people: P[]):
{ groups: { team: T; people: P[] }[]; orphans: P[] } {
  const humans = people.filter((p) => p.managerId !== null);
  const groups = teams.map((team) => ({ team, people: humans.filter((p) => p.teamId === team.teamId) }));
  const placed = new Set(groups.flatMap((g) => g.people));
  return { groups, orphans: humans.filter((p) => !placed.has(p)) };
}

/** Що стоїть у колонці «Клієнт» списку дзвінків. */
export type ClientCell = "unknown" | "open" | "known";

/**
 * 🔒 КАРТКА — ЛИШЕ ТОМУ, КОМУ ЇЇ ВІДДАСТЬ СЕРВЕР. Роут картки стоїть за вкладкою «Клієнти»
 * (`routeTab`: `client-card → loyalty`) і скоупом усередині. Кнопка без права давала б 403 у
 * відповідь на клік — тому без права пишемо «є в CRM», а не малюємо двері в стіну.
 */
export function clientCell(clientKey: string | null, canOpenClient: boolean): ClientCell {
  if (!clientKey || !clientKey.trim()) return "unknown";
  return canOpenClient ? "open" : "known";
}


/* ═══════════ 👥 ФІЛЬТР «КОМАНДА / МЕНЕДЖЕР» НА ВЕСЬ ЕКРАН (ТЗ Юлі 12.10.2026, розділ 3) ═══════════ */

/** Вибір фільтра: `teams` — id команд і `"none"` («Без відповідального»); порожньо — весь доступний відділ. */
export interface MissedFilter { teams: string[]; managerId: number | null }
export const MISSED_FILTER_KEY = "missedFilter";
export const EMPTY_MISSED_FILTER: MissedFilter = { teams: [], managerId: null };

/** Розбір збереженого фільтра; сміття — порожній фільтр, а не виняток. */
export function parseMissedFilter(raw: string | null): MissedFilter {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<MissedFilter> | null;
    const teams = Array.isArray(v?.teams) ? v.teams.filter((x): x is string => typeof x === "string" && (/^\d+$/.test(x) || x === "none")) : [];
    const managerId = typeof v?.managerId === "number" && Number.isInteger(v.managerId) && v.managerId > 0 ? v.managerId : null;
    return { teams: [...new Set(teams)], managerId };
  } catch { return EMPTY_MISSED_FILTER; }
}

/** Параметри запиту з фільтра — ОДНА функція для всіх блоків екрана, щоб жоден не пішов без фільтра. */
export function missedFilterParams(f: MissedFilter): { teams?: string; managerId?: number } {
  return { ...(f.teams.length ? { teams: f.teams.join(",") } : {}), ...(f.managerId != null ? { managerId: f.managerId } : {}) };
}

/** Менеджери для списку «Менеджер» — лише з обраних команд (порожній вибір — усі). */
export function managersForTeams<M extends { managerId: number | null; teamId: number | null; name: string }>(all: readonly M[], teams: readonly string[]): M[] {
  const ids = new Set(teams.filter((t) => t !== "none").map(Number));
  return all.filter((m) => m.managerId != null && (ids.size === 0 || (m.teamId != null && ids.has(m.teamId))))
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
}

/** «у нормі / нижче норми» — словами (ТЗ, розділ 7: «не лише кольором»). */
export function normLabel(pct: number | null, norm: number | null): string {
  if (norm == null) return "ціль не задана";
  if (pct == null) return `ціль ${String(norm)}%`;
  return pct >= norm ? `ціль ${String(norm)}% · у нормі` : `ціль ${String(norm)}% · нижче норми`;
}

/* ═══════════════ РЕДИЗАЙН ЕКРАНА 20.11.2026 (план `plans/missed-calls/redesign/redesign-plan.md`) ═══════════════ */

/**
 * 📱 РОЗБИВКА «НА ЛІНІЮ / НА МОБІЛЬНІ» (рішення Романа 20.11.2026). Дві частини ОДНІЄЇ множини: Σ частин = «Пропущено»
 * за побудовою. «На лінію» збігається з фільтром Юлі в Ringostat. Відсоток — для ширини смужки.
 */
export function mobileSplit(missed: number, missedMobile: number): { line: number; mobile: number; linePct: number } {
  const mobile = Math.max(0, Math.min(missed, missedMobile));
  const line = missed - mobile;
  return { line, mobile, linePct: missed > 0 ? Math.round((line / missed) * 100) : 0 };
}

/** % передзвону за 24 год від пропущених; `null` — пропущених немає, рахувати нема з чого (не «0 %»). */
export function callbackPct(r: { missed: number; callbackSelf: number; callbackColleague: number }): number | null {
  return r.missed > 0 ? Math.round(((r.callbackSelf + r.callbackColleague) / r.missed) * 100) : null;
}

/**
 * Попередній ТАКИЙ САМИЙ період — для колонки «Зміна»: вчора для дня, минулий тиждень для тижня, минулий місяць для
 * місяця, відрізок тієї ж довжини одразу перед діапазоном. Той самий крок, що в стрілки «‹» (`navBy`), тож «зміна»
 * завжди порівнює з тим, що людина побачить, натиснувши «‹». `null` — діапазон зіпсований.
 */
export function prevPeriodOf(s: PeriodState): { from: string; to: string } | null {
  const patch = navBy(s, -1);
  return patch ? periodOf({ ...s, ...patch }) : null;
}

/** Слово для підпису колонки «Зміна»: «до попереднього дня / тижня / місяця / періоду». */
export function prevPeriodWord(mode: PeriodState["mode"]): string {
  return mode === "day" ? "дня" : mode === "week" ? "тижня" : mode === "month" ? "місяця" : "періоду";
}

/** Зміна % передзвону в п.п.; `null`, коли хоча б з одного боку відсотка немає (порожній період ≠ нуль). */
export function changePp(cur: number | null, prev: number | null): number | null {
  return cur == null || prev == null ? null : cur - prev;
}

/**
 * 🚚 ЗВІДКИ «ПЕРЕВІЗНИКИ» НА ОБОХ ВКЛАДКАХ (Роман 23.11.2026: «пропущені угоди наче звʼязані з аналізом на перевізника,
 * чи можна це десь прописати»). Один текст на «Дзвінки» і «Угоди», бо довідник один (`carrier_phones`, словник §11/§11a).
 * AI «Перевізники за розмовою» (§17) у довідник не пише — він закриває угоду в Kommo «Перевізник», а довідник
 * перебудовується щогодини з історії CRM. Довідник — знімок без історії, тому номер, визнаний перевізником пізніше,
 * зникає з пропущених і за минулі дні. З 24.11.2026 угода замовника не рятує ні номер з історією «Перевізник»,
 * ні номер з машин Ларді (задача 10991).
 */
export const CARRIER_DIRECTORY_HINT =
  "Перевізники — номери, які в CRM закривали як «Перевізник» (зокрема AI «Перевізники за розмовою» після розмови на мобільний) "
  + "або які є на Ларді (виставляють машини чи знаходяться пошуком Ларді за номером), навіть якщо на номері є угода замовника. "
  + "Список оновлюється щогодини (номери, знайдені пошуком Ларді, — за кілька хвилин) і не памʼятає, "
  + "коли номер став перевізником: якщо після передзвону номер визнали перевізником, його дзвінки й угоди зникають із пропущених "
  + "і за минулі дні, тож число за минулий період може трохи зменшитись.";

/**
 * ⏱ ТРИВАЛІСТЬ СЛОВАМИ: до години — хвилини, далі — години й хвилини, від доби — дні й години.
 * Баг 20.11.2026 (прохід по екрану на проді): «1334 хв» і «через 790 хв» читались як шум — ніхто не ділить на 60 в голові.
 * Число те саме, змінюється лише запис; `null` — «—» (рахувати не було з чого), а не «0 хв».
 */
export function durText(min: number | null): string {
  if (min == null || !Number.isFinite(min)) return "—";
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${String(m)} хв`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${String(h)} год ${String(r)} хв` : `${String(h)} год`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${String(d)} д ${String(rh)} год` : `${String(d)} д`;
}

export interface CopyRow { name: string; missed: number; pct: number | null; medianMin: number | null; waiting: number; change: number | null }
/**
 * Текст «Скопіювати для звіту» — з ТИХ САМИХ рядків, що на екрані таблиці «По командах» (замість окремого блоку «Звіт
 * тижня», питання 2 плану): тиждень = перемикач «Тиждень», «зміна» = до попереднього такого самого періоду.
 */
export function teamsCopyText(title: string, rows: readonly CopyRow[]): string {
  const p = (v: number | null) => (v == null ? "—" : `${String(v)}%`);
  const ch = (v: number | null) => (v == null ? "" : ` (${v > 0 ? "+" : ""}${String(v)} п.п.)`);
  return [`📵 Пропущені дзвінки, ${title}`, ...rows.map((r) =>
    `${r.name}: пропущено ${String(r.missed)}, передзвонили за 24 год ${p(r.pct)}${ch(r.change)}`
    + `${r.medianMin != null ? `, час до передзвону ${durText(r.medianMin)}` : ""}, чекають ${String(r.waiting)}`)].join("\n");
}

/**
 * 🕳 ЧОМУ В РЯДКУ, ЩО ЧЕКАЄ, НЕМАЄ КНОПКИ «ЗАДАЧА» (баг 20.11.2026: клітинка була порожня, без пояснення).
 * Причини — рівно ті умови, якими сервер відбирає рядки під задачу (`noCallbackSql`), по черзі:
 * ще не минула доба · номер невідомий · задача вже стоїть на інший дзвінок того самого номера · номер — перевізник за
 * історією CRM (єдина умова, що лишається, коли попередні не спрацювали). `null` — пояснювати нема чого.
 */
export interface TaskLookup {
  loaded: boolean;
  /** Список під задачі обрізано стелею — тоді «немає в списку» нічого не доводить, і причину не вигадуємо. */
  truncated: boolean;
  byId: { has: (uniqueid: string) => boolean };
  byPhone: { get: (phone: string) => { at: string } | undefined };
  res: Record<string, unknown>;
}
export function noTaskReason(t: TaskLookup, r: { uniqueid: string; phone: string | null; waiting: boolean; waitH: number }): string | null {
  if (!r.waiting || !t.loaded || t.byId.has(r.uniqueid) || t.res[r.uniqueid]) return null;
  if (r.waitH < 24) return "задача — коли мине доба";
  if (r.phone == null) return "номер невідомий";
  const other = t.byPhone.get(r.phone);
  if (other) {
    const at = new Date(other.at).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `задача — на дзвінок ${at}`;
  }
  return t.truncated ? null : "перевізник за історією CRM";
}
