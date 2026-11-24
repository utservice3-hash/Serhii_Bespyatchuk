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
  // 20.11.2026: навігатор той самий, що у Звіті (`PeriodStepper`, прохання Романа «шапку … таку саму як і у звіті»).
  assert.match(sec, /<PeriodStepper\b/, "🔴 на вкладці немає вибору періоду — його знову нема звідки змінити");
  assert.match(sec, /const \{ from, to \} = periodOf\(nav\)/, "🔴 запити йдуть не з періоду навігатора");
  const dash = stripComments(readFileSync(FE("pages/Dashboard.tsx"), "utf8"));
  // Гонка: пізня відповідь за СТАРИЙ період не перезаписує новий — у всіх чотирьох запитах вкладки.
  // Від предмета, а не від числа: кожен запит вкладки має свій захист від гонки.
  // 5148: + «Відповідь на заявку» (`fetchLeadResponse`) — теж запит вкладки за періодом, теж зі своїм захистом.
  // 20.11.2026: + «Пропущені угоди» (`fetchMissedDeals`) — друга вкладка екрана, той самий період, свій захист.
  const fetches = (sec.match(/\bfetch(MissedCalls|MissedList|NoDeal|NoDealList|MissedSeries|LeadResponse|MissedDeals)\(/g) ?? []).length;
  assert.ok(fetches >= 5, `🔴 знайдено лише ${String(fetches)} запитів вкладки — розбір зламався`);
  assert.equal((sec.match(/return \(\) => \{ alive = false; \};/g) ?? []).length, fetches,
    "🔴 запит вкладки без захисту від гонки: відповідь за старий період перезапише новий");
  // Прибирання без перевірки нічого не захищає: кожен запит має перевірку і в успіху, і в помилці.
  assert.equal((sec.match(/if \(alive\) set/g) ?? []).length, fetches * 2,
    "🔴 у запиті вкладки прибрано перевірку `if (alive)` — пізня відповідь перезапише новий період");
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
  // 20.11.2026: рядок команди — розгортний рядок таблиці «По командах» (шеврон + назва), а не підзаголовок «Команда: …».
  assert.match(sec, /<span className="mc-tchev" aria-hidden="true">▸<\/span>\{g\.team\.name\}/, "🔴 рядок команди не малюється");
  assert.match(sec, /clientCell\(r\.clientKey, canOpenClient\)/, "🔴 колонка «Клієнт» живе повз правило доступу");
  assert.match(sec, /<ClientCardPanel clientKey=\{r\.clientKey\} \/>/, "🔴 картка клієнта не відкривається зі списку");
  assert.match(sec, /d\.ownerlessInScope\s*\?/, "🔴 плитка «Без відповідального» знову малює нуль у зрізі команди");
  assert.match(sec, /державні свята не враховуються/, "🔴 примітки про свята на екрані немає — лише в підказці (ТЗ §1.2)");
  const dash = stripComments(readFileSync(FE("pages/Dashboard.tsx"), "utf8"));
  assert.match(dash, /<MissedCallsSection canOpenClient=\{!!screens\?\.includes\("loyalty"\)\}[^>]*\/>/,
    "🔴 право на картку не за вкладкою «Клієнти», на якій стоїть роут картки");
});

/**
 * #10147 — ДИНАМІКА НА ФРОНТІ Й ПОРЯДОК БЛОКІВ ПІСЛЯ РЕДИЗАЙНУ (Роман 20.11.2026: прототип «окей виглядає супер»,
 * «давай викочувати»). Змінює твердження `#474` (знято через `RETIRED_GATES`): «угоди немає» більше НЕ нагорі — екран
 * відповідає на питання «кому дзвонити зараз», тож порядок: смуга чисел → «Кому передзвонити» → «По командах» →
 * «Детальніше» (динаміка, години, «дзвінок без угоди», автозадачі — згорнуто). Частки точки — з її лічильників; підсумок вікна
 * — зі СУМ, не середнім відсотків; медіана не усереднюється. Діапазони й вікно — ті самі функції, що на Статистиках.
 * Червоніє, якщо: список опуститься під таблицю команд; «Детальніше» підніметься вище списку; динаміку чи «угоди немає»
 * винести з «Детальніше» або намалювати двічі; завести власну копію діапазонів.
 */
test("#10147 ПОРЯДОК І ДИНАМІКА: числа → кому передзвонити → команди → «Детальніше» (динаміка й «угоди немає» всередині); частки зі сум; логіка Статистик без копії", async () => {
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
  const main = sec.slice(sec.indexOf("export function MissedCallsSection("), sec.indexOf("\nfunction nextLabel("));
  const at = (needle: string) => main.indexOf(needle);
  const iHero = at('className="mc-hero"'), iList = at("<MissedListBlock "), iTeams = at("<TeamsBlock "), iMore = at("<DetailsBlock ");
  assert.ok(main.length > 0 && iHero > 0 && iList > 0 && iTeams > 0 && iMore > 0, "🔴 на вкладці бракує блоку");
  assert.ok(iHero < iList && iList < iTeams && iTeams < iMore,
    "🔴 порядок екрана зламано: мусить бути числа → «Кому передзвонити» → «По командах» → «Детальніше»");
  const details = sec.slice(sec.indexOf("function DetailsBlock("), sec.indexOf("\nfunction MissedDynamicsBlock("));
  assert.ok(details.length > 0, "🔴 блоку «Детальніше» немає");
  assert.match(details, /<MissedDynamicsBlock\b/, "🔴 динаміка винесена з «Детальніше»");
  assert.match(details, /<NoDealBlock /, "🔴 «Дзвінок був, а угоди немає» винесено з «Детальніше»");
  assert.equal((sec.match(/<NoDealBlock /g) ?? []).length, 1, "🔴 блок «угоди немає» намальовано двічі");
  assert.equal((sec.match(/<MissedDynamicsBlock\b/g) ?? []).length, 1, "🔴 динаміку намальовано двічі");
  assert.match(sec, /import \{ RANGES, MIN_WIN, rangeWindow, shortDate, COLORS \} from "\.\/StatisticsChartsSection"/,
    "🔴 діапазони й вікно графіка не зі Статистик — друга копія логіки розійдеться з першою");
  assert.doesNotMatch(sec, /const RANGES|function rangeWindow/, "🔴 у вкладці завелась власна копія діапазонів");
  assert.match(sec, /fetchMissedSeries\(\{ granularity: gran(, \.\.\.fp)? \}\)/, "🔴 графік не тягне ряди з роуту динаміки");
});

interface SplitMod { mobileSplit: (missed: number, missedMobile: number) => { line: number; mobile: number; linePct: number } }

/**
 * #10145b — 📱 РОЗБИВКА НА ЕКРАНІ: під «Пропущено» — «N на лінію, M на мобільні» з поля ядра `missedMobile`, і поля рядка
 * списку, які віддає роут, — рівно ті, що в типі `MissedListRow` (позначка «мобільний», «чекає», години очікування).
 * Червоніє, якщо: розбивку рахувати не з `missedMobile`; лінія + мобільні ≠ пропущено; прибрати підпис; додати / забути
 * поле рядка з одного боку.
 */
test("#10145b 📱 РОЗБИВКА НА ЕКРАНІ: «на лінію + на мобільні» з missedMobile, сума = пропущено; поля рядка списку роуту == тип", async () => {
  const periodUrl = await transpile("pages/dashboard/periodRules.ts");
  const V = await load<SplitMod>("pages/dashboard/missedCallsView.ts", { "./periodRules": periodUrl });
  assert.deepEqual(V.mobileSplit(90, 42), { line: 48, mobile: 42, linePct: 53 }, "🔴 звірка Юлі 90 = 48 на лінію + 42 на мобільні не сходиться");
  assert.deepEqual(V.mobileSplit(0, 0), { line: 0, mobile: 0, linePct: 0 }, "🔴 без пропущених смуга ділить на нуль");
  const odd = V.mobileSplit(5, 7);
  assert.equal(odd.line + odd.mobile, 5, "🔴 лінія + мобільні ≠ пропущено — смуга бреше");

  const sec = stripComments(readFileSync(FE("pages/dashboard/sections/MissedCallsSection.tsx"), "utf8"));
  assert.match(sec, /const split = mobileSplit\(s\.missed, s\.missedMobile\)/, "🔴 розбивка рахується не з поля ядра");
  assert.match(sec, /\{num\(split\.line\)\}<\/b> на лінію, <b>\{num\(split\.mobile\)\}<\/b> на мобільні/, "🔴 під «Пропущено» немає підпису розбивки");

  const api = readFileSync(FE("api.ts"), "utf8");
  assert.match(api, /\bmissedMobile: number;/, "🔴 у типі MissedSummary немає `missedMobile`");
  const route = readFileSync(fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)), "utf8");
  const body = route.slice(route.indexOf('dashboardRouter.get("/missed-calls/list"'));
  assert.ok(body.length < route.length, "🔴 роуту /missed-calls/list немає");
  const rowMap = /rows: rows\.map\(\(r\) => \(\{([\s\S]*?)\}\)\)/.exec(body);
  assert.ok(rowMap, "🔴 не знайдено явного переліку полів рядка в роуті");
  const routeKeys = [...rowMap[1].matchAll(/\b([a-zA-Z]+):/g)].map((x) => x[1]).sort();
  const typeBody = /export interface MissedListRow \{([\s\S]*?)\n\}/.exec(api);
  assert.ok(typeBody, "🔴 типу MissedListRow немає в api.ts");
  const typeKeys = [...typeBody[1].replace(/\/\*\*[\s\S]*?\*\//g, " ").matchAll(/\b([a-zA-Z]+):/g)].map((x) => x[1]).sort();
  for (const k of ["mobile", "waiting", "waitH"]) assert.ok(routeKeys.includes(k), `🔴 роут списку не віддає \`${k}\``);
  assert.deepEqual(routeKeys, typeKeys, "🔴 поля рядка списку в роуті розійшлись із типом фронта");
});

interface FilterMod {
  parseMissedFilter: (raw: string | null) => { teams: string[]; managerId: number | null };
  missedFilterParams: (f: { teams: string[]; managerId: number | null }) => { teams?: string; managerId?: number };
  managersForTeams: <M extends { managerId: number | null; teamId: number | null; name: string }>(all: readonly M[], teams: readonly string[]) => M[];
  normLabel: (pct: number | null, norm: number | null) => string;
}

/** #1774 — фільтр «Команда / Менеджер» і підпис цілі (ТЗ Юлі 12.10.2026, розділи 3 і 7): правила ВИКОНУЮТЬСЯ. */
test("#1774 ФІЛЬТР І ЦІЛЬ · ФРОНТ: збережене сміття не ламає екран; менеджери — з обраних команд; ціль словами", async () => {
  const periodUrl = await transpile("pages/dashboard/periodRules.ts");
  const V = await load<FilterMod>("pages/dashboard/missedCallsView.ts", { "./periodRules": periodUrl });
  // Сміття в браузері — порожній фільтр, а не виняток, що кладе вкладку.
  for (const raw of [null, "", "{", "[]", '{"teams":"5"}', '{"teams":[5,"x"],"managerId":-2}']) {
    assert.deepEqual(V.parseMissedFilter(raw), { teams: [], managerId: null }, `🔴 «${String(raw)}» дало не порожній фільтр`);
  }
  assert.deepEqual(V.parseMissedFilter('{"teams":["5","none","5"],"managerId":7}'), { teams: ["5", "none"], managerId: 7 });
  assert.deepEqual(V.missedFilterParams({ teams: [], managerId: null }), {}, "🔴 порожній фільтр шле параметри — сервер звузить до «нікого»");
  assert.deepEqual(V.missedFilterParams({ teams: ["5", "none"], managerId: 7 }), { teams: "5,none", managerId: 7 });

  const all = [
    { managerId: 1, teamId: 5, name: "Яцик" }, { managerId: 2, teamId: 6, name: "Андрусенко" },
    { managerId: null, teamId: null, name: "Без відповідального" }, { managerId: 3, teamId: null, name: "Поза" },
  ];
  assert.deepEqual(V.managersForTeams(all, []).map((m) => m.name), ["Андрусенко", "Поза", "Яцик"], "🔴 «нічийні» потрапили в список людей");
  assert.deepEqual(V.managersForTeams(all, ["5"]).map((m) => m.name), ["Яцик"], "🔴 у списку менеджерів люди з необраних команд");
  assert.deepEqual(V.managersForTeams(all, ["none"]).map((m) => m.name), ["Андрусенко", "Поза", "Яцик"]);

  assert.equal(V.normLabel(90, null), "ціль не задана", "🔴 без цілі — щось інше, ніж «ціль не задана»");
  assert.equal(V.normLabel(80, 80), "ціль 80% · у нормі");
  assert.equal(V.normLabel(79, 80), "ціль 80% · нижче норми");
  assert.equal(V.normLabel(null, 80), "ціль 80%", "🔴 без даних показано вердикт");
});

interface FixMod {
  durText: (min: number | null) => string;
  noTaskReason: (t: { loaded: boolean; truncated: boolean; byId: { has: (u: string) => boolean }; byPhone: { get: (p: string) => { at: string } | undefined }; res: Record<string, unknown> },
    r: { uniqueid: string; phone: string | null; waiting: boolean; waitH: number }) => string | null;
}

/**
 * #10149 — БАГИ ПРОХОДУ ПО ЕКРАНУ НА ПРОДІ (Роман 20.11.2026: «перейдися по всій сторінці і знайди всі баги»).
 * ① Підказки ⓘ: на проді 38 з 39 закривала липка шапка або обрізав край згортного блоку / таблиці — тепер усі через `Hint`
 *    (портал у `document.body`, `position: fixed`). Червоніє, якщо на екрані знову з'явиться `InfoHint` або `Hint` перестане
 *    виносити спливашку з блоку.
 * ② Тривалість: «1334 хв» → «22 год 14 хв»; червоніє, якщо медіану чи «через N» знову писати сирими хвилинами.
 * ③ Порожня клітинка «Задача» в рядку, що чекає: кожна причина названа (доба, номер, задача на інший дзвінок, перевізник);
 *    поки задачі не завантажились чи список обрізано — нічого не вигадуємо.
 * ④ Список за період: запит несе `to`, задачі — за ті самі дати, роут передає `to` в ядро.
 */
test("#10149 ПРОХІД ПО ЕКРАНУ: підказки не обрізаються, тривалість годинами, причина без задачі названа, список за весь період", async () => {
  const periodUrl = await transpile("pages/dashboard/periodRules.ts");
  const V = await load<FixMod>("pages/dashboard/missedCallsView.ts", { "./periodRules": periodUrl });
  const cases: [number | null, string][] = [[null, "—"], [5, "5 хв"], [59, "59 хв"], [60, "1 год"], [241, "4 год 1 хв"], [1334, "22 год 14 хв"], [1440, "1 д"], [3000, "2 д 2 год"]];
  for (const [m, want] of cases) assert.equal(V.durText(m), want, `🔴 ${String(m)} хв записано як «${V.durText(m)}», а не «${want}»`);

  const t = (o: Partial<Parameters<FixMod["noTaskReason"]>[0]> = {}) => ({
    loaded: true, truncated: false, byId: new Set<string>(), byPhone: new Map<string, { at: string }>(), res: {}, ...o });
  const r = (o: Partial<Parameters<FixMod["noTaskReason"]>[1]> = {}) => ({ uniqueid: "u1", phone: "380501112233", waiting: true, waitH: 30, ...o });
  assert.equal(V.noTaskReason(t(), r({ waiting: false })), null, "🔴 рядок, з яким уже поговорили, отримав пояснення про задачу");
  assert.equal(V.noTaskReason(t({ loaded: false }), r()), null, "🔴 поки задачі вантажаться, причину вигадано");
  assert.equal(V.noTaskReason(t({ byId: new Set(["u1"]) }), r()), null, "🔴 рядок із задачею отримав пояснення замість кнопки");
  assert.equal(V.noTaskReason(t(), r({ waitH: 23 })), "задача — коли мине доба");
  assert.equal(V.noTaskReason(t(), r({ phone: null })), "номер невідомий");
  assert.match(V.noTaskReason(t({ byPhone: new Map([["380501112233", { at: "2026-11-19T06:33:00Z" }]]) }), r()) ?? "", /^задача — на дзвінок 19\.11, 08:33$/,
    "🔴 повторний дзвінок номера не каже, на який дзвінок стоїть задача");
  assert.equal(V.noTaskReason(t(), r()), "перевізник за історією CRM");
  assert.equal(V.noTaskReason(t({ truncated: true }), r()), null, "🔴 список під задачі обрізано, а причину «перевізник» вигадано");

  const sec = stripComments(readFileSync(FE("pages/dashboard/sections/MissedCallsSection.tsx"), "utf8"));
  assert.doesNotMatch(sec, /\bInfoHint\b/, "🔴 на екрані знову InfoHint — його спливашку закриває шапка й обрізає край блоку");
  assert.ok((sec.match(/<Hint /g) ?? []).length >= 20, "🔴 підказок `Hint` на екрані підозріло мало — розбір зламався");
  const fold = readFileSync(FE("pages/dashboard/sections/MissedFold.tsx"), "utf8");
  assert.match(fold, /createPortal\([\s\S]*?className="info-hint-pop mc-hint-pop"[\s\S]*?document\.body\)/, "🔴 спливашка `Hint` не виноситься в document.body");
  const css = readFileSync(FE("index.css"), "utf8");
  assert.match(css, /\.info-hint-pop\.mc-hint-pop \{ position: fixed;/, "🔴 спливашка `Hint` не фіксована — її знову обріже край блоку");
  // «Відповідь на заявку» (ResponseTimeBlock) пише свої медіани хвилинами свідомо — там вони короткі; тут лише екран пропущених.
  assert.doesNotMatch(sec, /`\$\{String\((?:s|r|g\.team)\.medianMin\)\} хв`|через \$\{String\(min\)\} хв|fmt=\{\(n\) => `\$\{String\(n\)\} хв`\}/, "🔴 тривалість знову сирими хвилинами");
  assert.ok((sec.match(/durText\(/g) ?? []).length >= 5, "🔴 тривалість на екрані пишеться не через durText");

  assert.match(sec, /const q = qTo !== qFrom \? \{ day: qFrom, to: qTo \} : \{ day: qFrom \};/, "🔴 список не бере кінець періоду");
  assert.match(sec, /const t = useMissedTasks\(qFrom, qTo, fp\);/, "🔴 задачі списку — не за ті самі дати, що й рядки");
  const route = readFileSync(fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)), "utf8");
  assert.match(route, /await missedCalls\.missedList\(day, scope, onlyNoCallback, to\)/, "🔴 роут списку не передає `to` в ядро");
});

/**
 * #10991d — ЗВІДКИ «ПЕРЕВІЗНИКИ» ПРОПИСАНО ОДНИМ ТЕКСТОМ НА ОБОХ ВКЛАДКАХ (Роман 23.11.2026: «пропущені угоди наче звʼязані
 * з аналізом на перевізника, чи можна це десь прописати» → «роби»), і текст каже правило 24.11.2026 (задача 10991): номер,
 * який закривали «Перевізник», і номер з машин Ларді — перевізник навіть з угодою замовника, без винятків. Заміняє `#10150`
 * (`RETIRED_GATES`): та вимагала старого речення «номер з угодою замовника перевізником не є». Довідник один
 * (`carrier_phones`), тож і пояснення одне: AI «Перевізники за розмовою» впливає непрямо (закриває угоду «Перевізник» →
 * щогодинна перебудова), а довідник без історії — пропущене може зникнути заднім числом. Червоніє, якщо (а) з тексту
 * зникне будь-яке з трьох джерел, межа винятку чи «за минулі дні»; (б) одна з вкладок перестане брати спільний текст і
 * заведе власну копію; (в) словник втратить абзац.
 */
test("#10991d ПЕРЕВІЗНИКИ: один текст підказки на «Дзвінках» і «Угодах» — Ларді й історія «Перевізник» без винятку для угоди замовника, AI за розмовою, зникнення заднім числом", async () => {
  const periodUrl = await transpile("pages/dashboard/periodRules.ts");
  const V = await load<{ CARRIER_DIRECTORY_HINT: string }>("pages/dashboard/missedCallsView.ts", { "./periodRules": periodUrl });
  const h = V.CARRIER_DIRECTORY_HINT;
  for (const [re, what] of [
    [/закривали як «Перевізник»/, "історія CRM"], [/AI «Перевізники за розмовою»/, "AI за розмовою"], [/Ларді/, "Lardi"],
    [/навіть якщо на номері є угода замовника/, "історія «Перевізник» без винятку (24.11)"],
    [/за минулі дні/, "зникнення заднім числом"],
  ] as const) assert.match(h, re, `🔴 у підказці про перевізників немає: ${what}`);
  assert.doesNotMatch(h, /перевізником не є/, "🔴 підказка знову обіцяє виняток «номер з угодою замовника перевізником не є» — рішення 24.11: без винятку");

  const sec = stripComments(readFileSync(FE("pages/dashboard/sections/MissedCallsSection.tsx"), "utf8"));
  assert.match(sec, /перевізники: \$\{num\(s\.carriers\)\}`\} <Hint text=\{`\$\{CARRIER_DIRECTORY_HINT\} /, "🔴 вкладка «Дзвінки» не бере спільний текст про перевізників");
  assert.match(sec, /угоди перевізників \{num\(s\.carriers\)\} <Hint text=\{CARRIER_DIRECTORY_HINT\} \/>/, "🔴 вкладка «Угоди» не бере спільний текст про перевізників");
  assert.doesNotMatch(sec, /Перевізники — номери/, "🔴 на екрані знову власна копія пояснення про перевізників — вона розійдеться зі спільною");

  const gl = readFileSync(fileURLToPath(new URL("../../../docs/METRICS_GLOSSARY.md", import.meta.url)), "utf8");
  assert.match(gl, /ЗВʼЯЗОК З AI «ПЕРЕВІЗНИКИ ЗА РОЗМОВОЮ» \(§17\)[\s\S]{0,1200}за минулі дні теж[\s\S]{0,600}#10991d/, "🔴 словник не пояснює звʼязок пропущених з AI за розмовою");
  assert.match(gl, /ІСТОРІЯ «ПЕРЕВІЗНИК» — БЕЗ ВИНЯТКУ \(з 24\.11\.2026, задача 10991[\s\S]{0,900}Для номерів з Lardi винятку теж немає/, "🔴 словник не каже правила 24.11: історія «Перевізник» і Lardi без винятку");
});
