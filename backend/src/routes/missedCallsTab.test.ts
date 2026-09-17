import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 📵 #462–#464 — ФРОНТ ВКЛАДКИ «ПРОПУЩЕНІ ДЗВІНКИ»: хвости звірки ТЗ-1 (16.09.2026).
 *
 * ✅ Правила ВИКОНУЮТЬСЯ: `.ts` фронту транспілюється на льоту (прийом `#138`, як у `#406`),
 * а не переказується в тесті. Регулярками по TSX перевіряється лише ПРОВОДКА — що екран
 * справді кличе ці правила, а не живе повз них (урок `#139`).
 */

const FE = (rel: string): string => fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url));
const stripComments = (src: string): string =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");


/* Типи модулів фронту описано тут: `typeof import("…/frontend/…")` тягне файли фронту в збірку бекенду. */
interface PeriodStateT { mode: string; anchor: string; focusDay: string; rangeFrom: string; rangeTo: string }
interface KnownT { status: string; closeReason: string | null }
interface NotifyMod {
  SIGNAL_TITLE_PREFIX: string;
  AUTO_CLOSE_PREFIX: string;
  SIGNAL_CLOCK_SKEW_MS: number;
  isSignalAlert: (t: { id: number; title: string; status: string; assigneeId?: number | null; closeReason?: string | null; createdAt?: string | null },
    known: ReadonlyMap<number, KnownT> | null, me: number | null | undefined, mountedAtMs: number) => boolean;
  signalAlertText: (titles: string[]) => string | null;
}
interface ViewDayMod { clampListDay: (day: string | null, from: string, to: string, today: string) => string }
interface ViewMod {
  missedDefaultPeriod: (today: string) => PeriodStateT;
  groupByTeam: <T extends { teamId: number | null }, P extends { managerId: number | null; teamId: number | null }>(teams: T[], people: P[]) => { groups: { team: T; people: P[] }[]; orphans: P[] };
  clientCell: (clientKey: string | null, canOpen: boolean) => string;
}
interface PeriodMod { periodOf: (s: PeriodStateT) => { from: string; to: string } }

async function transpile(rel: string, deps: Record<string, string> = {}): Promise<string> {
  const ts = (await import("typescript")).default;
  let js = ts.transpileModule(readFileSync(FE(rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [spec, url] of Object.entries(deps)) js = js.split(`from "${spec}"`).join(`from "${url}"`);
  return `data:text/javascript,${encodeURIComponent(js)}`;
}
const load = async <T>(rel: string, deps: Record<string, string> = {}): Promise<T> =>
  await import(await transpile(rel, deps)) as T;

/**
 * #462 — НОВА ЗАДАЧА-СИГНАЛ ДЗВОНИТЬ, І ЛИШЕ ТОМУ, КОМУ ВОНА ПРИЗНАЧЕНА.
 * Доти сповіщення спрацьовувало тільки на зміну статусу вже відомої задачі, тож сигнал
 * «пропущений без передзвону» приходив мовчки — для порога 5 хв це не сигнал.
 */
test("#462 СИГНАЛ: нова й перевідкрита задача «📵» дзвонить виконавцю; стара, чужа й закрита — ні", async () => {
  const N = await load<NotifyMod>("pages/dashboard/signalTaskNotify.ts");
  const { SIGNAL_TITLE_PREFIX: BACK, autoCloseReason } = await import("../core/missedCallSignal.js");
  assert.equal(N.SIGNAL_TITLE_PREFIX, BACK, "🔴 префікс фронту розійшовся з бекендом — сповіщення замовкне тихо");
  assert.ok(autoCloseReason("16.09 10:12").startsWith(N.AUTO_CLOSE_PREFIX), "🔴 причина автозакриття бекенду не починається з префікса фронту — перевідкриття джобою мовчатиме");

  const MOUNT = Date.parse("2026-09-17T10:00:00Z");
  const t = (id: number, over: Partial<{ title: string; status: string; assigneeId: number | null; closeReason: string | null; createdAt: string }> = {}) =>
    ({ id, title: `${BACK}: +380671234567`, status: "not_started", assigneeId: 7, closeReason: null, createdAt: "2026-09-17T09:00:00Z", ...over });
  const AUTO = autoCloseReason("17.09 10:12");
  const known = new Map<number, KnownT>([[1, { status: "not_started", closeReason: null }], [2, { status: "done", closeReason: AUTO }],
    [3, { status: "in_progress", closeReason: null }], [4, { status: "done", closeReason: null }]]);
  assert.equal(N.isSignalAlert(t(9), known, 7, MOUNT), true, "🔴 нова задача-сигнал прийшла мовчки");
  assert.equal(N.isSignalAlert(t(2), known, 7, MOUNT), true, "🔴 перевідкрита джобою (клієнт знову не додзвонився) — мовчки");
  assert.equal(N.isSignalAlert(t(2, { closeReason: AUTO }), known, 7, MOUNT), false,
    "🔴 менеджер сам повернув автозакриту задачу в роботу — і отримав тост «пропущений», хоча нового дзвінка не було");
  assert.equal(N.isSignalAlert(t(4), known, 7, MOUNT), false, "🔴 закриту й повернуту менеджером задачу видано за новий пропущений");
  assert.equal(N.isSignalAlert(t(1), known, 7, MOUNT), false, "🔴 уже відома задача дзвонить на кожному опитуванні");
  assert.equal(N.isSignalAlert(t(3), known, 7, MOUNT), false);
  assert.equal(N.isSignalAlert(t(9), known, 8, MOUNT), false, "🔴 дзвонить чужому менеджеру");
  assert.equal(N.isSignalAlert(t(9), known, null, MOUNT), false, "🔴 дзвонить акаунту без менеджера (адмін, HR)");
  assert.equal(N.isSignalAlert(t(9, { status: "done" }), known, 7, MOUNT), false, "🔴 дзвонить задача, яка вже закрилась сама");
  assert.equal(N.isSignalAlert(t(9, { title: "Звичайна задача" }), known, 7, MOUNT), false, "🔴 дзвонить будь-яка нова задача");
  // Першого опитування ще не було (вкладка у фоні): свіжі задачі дзвонять, старі — ні.
  assert.equal(N.isSignalAlert(t(9, { createdAt: "2026-09-17T11:17:00Z" }), null, 7, MOUNT), true,
    "🔴 задача, створена поки вкладка була у фоні, мовчки пішла в базову лінію");
  assert.equal(N.isSignalAlert(t(9, { createdAt: "2026-09-17T09:00:00Z" }), null, 7, MOUNT), false,
    "🔴 кожне відкриття сторінки дзвонить усіма старими задачами");
  assert.equal(N.isSignalAlert(t(9, { createdAt: new Date(MOUNT - N.SIGNAL_CLOCK_SKEW_MS).toISOString() }), null, 7, MOUNT), true,
    "🔴 розбіжність годинників браузера й сервера ковтає свіжу задачу");

  assert.equal(N.signalAlertText([]), null);
  assert.ok(N.signalAlertText([`${BACK}: +380671234567`])?.includes("+380671234567"), "🔴 тост не каже, кому передзвонити");
  assert.ok(N.signalAlertText([`${BACK}: +1`, `${BACK}: +2`, `${BACK}: +3`])?.includes("3 пропущених"), "🔴 пачка задач — не одним тостом");

  // Проводка: опитування кличе правило, а базова лінія — перше опитування, не порожній стан.
  const dash = stripComments(readFileSync(FE("pages/Dashboard.tsx"), "utf8"));
  assert.match(dash, /isSignalAlert\(t, known, auth\?\.managerId, mountedAt\.current\)/, "🔴 опитування задач не кличе правило сигналу або без моменту відкриття");
  assert.match(dash, /signalKnown\.current = new Map\(fresh\.map\(\(t\) => \[t\.id, knownOf\(t\)\]\)\)/, "🔴 базова лінія не оновлюється або не памʼятає причину закриття");
  assert.match(dash, /usePolling\(\(\) => \{\s*fetchTasks\(\)\s*\.then\(\(fresh\) => \{\s*notifySignalTasks\(fresh\);/,
    "🔴 фонове опитування задач не кличе сповіщення — правило є, а сигнал мовчить");
});

/**
 * #463 — ПЕРІОД ВКЛАДКИ СВІЙ, ДЕФОЛТ «ВЧОРА» (ТЗ §1.4 A).
 * Доти вкладка брала спільний `dateRange` із `localStorage`, який з видимих екранів не
 * змінюється: кожен бачив період свого першого заходу, назавжди.
 */
test("#463 ПЕРІОД: дефолт «вчора» за Києвом, навігатор на вкладці, спільний dateRange не їде", async () => {
  const periodUrl = await transpile("pages/dashboard/periodRules.ts");
  const V = await load<ViewMod>(
    "pages/dashboard/missedCallsView.ts", { "./periodRules": periodUrl });
  const P = await import(periodUrl) as PeriodMod;

  const d = V.missedDefaultPeriod("2026-09-17");
  assert.deepEqual(P.periodOf(d), { from: "2026-09-16", to: "2026-09-16" }, "🔴 дефолт вкладки — не «вчора»");
  assert.equal(d.mode, "day");
  assert.deepEqual(P.periodOf(V.missedDefaultPeriod("2026-01-01")), { from: "2025-12-31", to: "2025-12-31" },
    "🔴 «вчора» від 1 січня не переходить у попередній рік");
  assert.deepEqual(P.periodOf(V.missedDefaultPeriod("2026-03-01")), { from: "2026-02-28", to: "2026-02-28" });

  const sec = stripComments(readFileSync(FE("pages/dashboard/sections/MissedCallsSection.tsx"), "utf8"));
  assert.match(sec, /useState<PeriodState>\(\(\) => missedDefaultPeriod\(today\)\)/, "🔴 вкладка не бере дефолт «вчора»");
  assert.match(sec, /<PeriodNav\b/, "🔴 на вкладці немає вибору періоду — його знову нема звідки змінити");
  assert.match(sec, /const \{ from, to \} = periodOf\(nav\)/, "🔴 запити йдуть не з періоду навігатора");
  const dash = stripComments(readFileSync(FE("pages/Dashboard.tsx"), "utf8"));
  // Гонка: пізня відповідь за СТАРИЙ період не перезаписує новий — у всіх чотирьох запитах вкладки.
  // Від предмета, а не від числа: кожен запит вкладки має свій захист від гонки.
  const fetches = (sec.match(/\bfetch(MissedCalls|MissedList|NoDeal|NoDealList|MissedSeries)\(/g) ?? []).length;
  assert.ok(fetches >= 5, `🔴 знайдено лише ${String(fetches)} запитів вкладки — розбір зламався`);
  assert.equal((sec.match(/return \(\) => \{ alive = false; \};/g) ?? []).length, fetches,
    "🔴 запит вкладки без захисту від гонки: відповідь за старий період перезапише новий");
  // День списку — не майбутній і не скидається на кожному запиті.
  const VD = await load<ViewDayMod>("pages/dashboard/missedCallsView.ts", { "./periodRules": periodUrl });
  assert.equal(VD.clampListDay("2026-09-16", "2026-09-14", "2026-09-20", "2026-09-17"), "2026-09-16", "🔴 обраний день, що входить у новий період, скинуто");
  assert.equal(VD.clampListDay(null, "2026-09-14", "2026-09-20", "2026-09-17"), "2026-09-17", "🔴 поточний тиждень відкрив список на неділю в майбутньому");
  assert.equal(VD.clampListDay("2026-08-03", "2026-07-01", "2026-07-31", "2026-09-17"), "2026-07-31");
  assert.equal(VD.clampListDay(null, "2026-10-01", "2026-10-31", "2026-09-17"), "2026-10-01");
  assert.match(sec, /<MissedListBlock from=\{d\.period\.from\} to=\{d\.period\.to\} day=\{listDay\} setDay=\{setListDay\}/,
    "🔴 день списку знову живе в блоці, що перемонтовується на кожному запиті");
  const tag = dash.match(/<MissedCallsSection[^>]*\/>/)?.[0] ?? "";
  assert.ok(tag, "🔴 вкладку не рендерить ніхто");
  assert.ok(!/dateRange/.test(tag), "🔴 спільний dateRange знову їде у вкладку — період застигне в localStorage");
});

/**
 * #464 — РЯДКИ КОМАНД НЕ ГУБЛЯТЬ ЛЮДЕЙ; КАРТКА КЛІЄНТА — ЛИШЕ ТИМ, КОМУ ЇЇ ВІДДАСТЬ СЕРВЕР;
 * «БЕЗ ВІДПОВІДАЛЬНОГО» У ЗРІЗІ КОМАНДИ НЕ МАЛЮЄТЬСЯ НУЛЕМ.
 */
test("#464 КОМАНДИ Й КЛІЄНТ: розкладка без втрат, картка за правом, чесний «без відповідального»", async () => {
  const periodUrl = await transpile("pages/dashboard/periodRules.ts");
  const V = await load<ViewMod>(
    "pages/dashboard/missedCallsView.ts", { "./periodRules": periodUrl });
  const teams = [{ teamId: 1 }, { teamId: null }];
  const people = [
    { managerId: 1, teamId: 1 }, { managerId: 2, teamId: 1 }, { managerId: 3, teamId: null },
    { managerId: null, teamId: null },           // «без відповідального» — свій рядок, не в команді
    { managerId: 4, teamId: 9 },                 // команда не приїхала рядком — не губимо
  ];
  const { groups, orphans } = V.groupByTeam(teams, people);
  assert.deepEqual(groups.map((g) => g.people.map((p) => p.managerId)), [[1, 2], [3]]);
  assert.deepEqual(orphans.map((p) => p.managerId), [4], "🔴 людина без рядка своєї команди зникла мовчки");
  const placed = groups.reduce((n, g) => n + g.people.length, 0) + orphans.length;
  assert.equal(placed, people.filter((p) => p.managerId !== null).length, "🔴 розкладка загубила або подвоїла людей");

  assert.equal(V.clientCell(null, true), "unknown");
  assert.equal(V.clientCell("   ", true), "unknown", "🔴 порожній ключ-сентинел читається як відомий клієнт");
  assert.equal(V.clientCell("тов рога", true), "open");
  assert.equal(V.clientCell("тов рога", false), "known", "🔴 кнопка картки без права — клік дасть 403");

  const sec = stripComments(readFileSync(FE("pages/dashboard/sections/MissedCallsSection.tsx"), "utf8"));
  assert.match(sec, /groupByTeam\(teams, d\.managers\)/, "🔴 таблиця не розкладає людей по командах");
  assert.match(sec, /Команда: \{g\.team\.name\}/, "🔴 рядок команди не малюється");
  assert.match(sec, /clientCell\(r\.clientKey, canOpenClient\)/, "🔴 колонка «Клієнт» живе повз правило доступу");
  assert.match(sec, /<ClientCardPanel clientKey=\{r\.clientKey\} \/>/, "🔴 картка клієнта не відкривається зі списку");
  assert.match(sec, /d\.ownerlessInScope\s*\?/, "🔴 плитка «Без відповідального» знову малює нуль у зрізі команди");
  assert.match(sec, /державні свята не враховуються/, "🔴 примітки про свята на екрані немає — лише в підказці (ТЗ §1.2)");
  const dash = stripComments(readFileSync(FE("pages/Dashboard.tsx"), "utf8"));
  assert.match(dash, /<MissedCallsSection canOpenClient=\{!!screens\?\.includes\("loyalty"\)\} \/>/,
    "🔴 право на картку не за вкладкою «Клієнти», на якій стоїть роут картки");
});

/**
 * #474 — ДИНАМІКА НА ФРОНТІ Й ПОРЯДОК БЛОКІВ (прохання власника 17.09.2026).
 * Частки точки — з її лічильників; підсумок вікна — зі СУМ, не середнім відсотків; медіана не
 * усереднюється. «Дзвінок був, а угоди немає» — одразу під підсумком, а не під довгим списком.
 * Діапазони й вікно — ті самі функції, що на Статистиках, а не копія.
 */
test("#474 ДИНАМІКА: частки зі сум, медіана не усереднюється; «угоди немає» нагорі; логіка Статистик без копії", async () => {
  const periodUrl = await transpile("pages/dashboard/periodRules.ts");
  const V = await load<{ SERIES_METRICS: { key: string; value: (p: object) => number | null; total: (ps: object[]) => number | null }[] }>(
    "pages/dashboard/missedCallsView.ts", { "./periodRules": periodUrl });
  const m = (k: string) => V.SERIES_METRICS.find((x) => x.key === k)!;
  const pts = [{ missed: 2, callback: 0, clientSelf: 0, medianMin: null }, { missed: 100, callback: 80, clientSelf: 10, medianMin: 12 }];
  assert.equal(m("noCallbackPct").value(pts[0]), 100);
  assert.equal(m("noCallbackPct").total(pts), 21.6, "🔴 «не передзвонили» за вікно — не Σ не передзвонених ÷ Σ пропущених (22/102); середнє відсотків дало б 60%");
  assert.equal(m("noCallbackPct").value({ missed: 0, callback: 0, clientSelf: 0, medianMin: null }), null, "🔴 день без пропущених показано як 0%, а не «немає даних»");
  assert.equal(m("medianMin").total(pts), null, "🔴 медіану за вікно усереднено з медіан точок");
  assert.equal(m("missed").total(pts), 102);
  assert.equal(m("clientSelfPct").total(pts), 9.8);

  const sec = stripComments(readFileSync(FE("pages/dashboard/sections/MissedCallsSection.tsx"), "utf8"));
  const iNoDeal = sec.indexOf("<NoDealBlock "), iDyn = sec.indexOf("<MissedDynamicsBlock"), iMgr = sec.indexOf("По менеджерах"), iList = sec.indexOf("<MissedListBlock ");
  assert.ok(iNoDeal > 0 && iDyn > 0 && iMgr > 0 && iList > 0, "🔴 на вкладці бракує блоку");
  assert.ok(iNoDeal < iMgr && iNoDeal < iList, "🔴 «Дзвінок був, а угоди немає» знову під таблицею чи списком — його не видно без прокрутки");
  assert.ok(iDyn < iMgr, "🔴 динаміка опинилась під довгими таблицями");
  assert.equal((sec.match(/<NoDealBlock /g) ?? []).length, 1, "🔴 блок «угоди немає» намальовано двічі");
  assert.match(sec, /import \{ RANGES, MIN_WIN, rangeWindow, shortDate, COLORS \} from "\.\/StatisticsChartsSection"/,
    "🔴 діапазони й вікно графіка не зі Статистик — друга копія логіки розійдеться з першою");
  assert.doesNotMatch(sec, /const RANGES|function rangeWindow/, "🔴 у вкладці завелась власна копія діапазонів");
  assert.match(sec, /fetchMissedSeries\(\{ granularity: gran \}\)/, "🔴 графік не тягне ряди з роуту динаміки");
});
