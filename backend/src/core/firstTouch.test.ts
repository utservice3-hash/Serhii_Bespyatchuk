import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsBackendEnv } from "../testMode.js";
import { firstTouchCell, firstTouchPct, sumFirstTouch, firstTouchOutsideRoster, glanceFirstTouch, firstTouchCountsFromCalls } from "./firstTouchRules.js";
import { checklist } from "./firstTouchTeamReport.js";

/**
 * 🎯 #3340–#3343 — «ЦІНУ НАЗВАНО (1-Й ДОТИК)» У ЗВІТІ == ПЛИТКА «ЦІНА ОЗВУЧЕНА» НА ЕКРАНІ AI (задача 7237,
 * Роман 02.11.2026). Джерело Звіту — розмови `aiCallsList` і правило `checklist()`, а не лист uts-bot.
 * Гейти `#475`/`#476`/`#478`/`#478b` про лист бота (ключ імені, SQL по `first_touch_analysis`) знято
 * свідомо: їх твердження більше не про продукт.
 */

type Row = {
  managerId: number | null; teamId: number | null; inReport: boolean; nonTarget: boolean;
  state: string; conversationType: string | null; priceDiscussed: boolean | null; hasRequest: boolean;
  promiseState: null; objection: null; pipelineGroup: "full" | "qualification" | "other"; adaptation?: boolean | null;
};
const call = (managerId: number | null, teamId: number | null, o: Partial<Row> = {}): Row => ({
  managerId, teamId, inReport: true, nonTarget: false, state: "done", conversationType: "cargo_request",
  priceDiscussed: true, hasRequest: true, promiseState: null, objection: null, pipelineGroup: "full", ...o,
});
/** Фікстура по ОБИДВА боки кожної межі відбору: кожен рядок, що «не рахується», має сусіда, що рахується. */
const FIXTURE: Row[] = [
  call(1, 7), call(1, 7, { priceDiscussed: false }), call(1, 7, { priceDiscussed: false }),
  call(1, 7, { conversationType: "lead_lost" }),                       // втрачений лід — поза знаменником
  call(1, 7, { conversationType: "call_later", priceDiscussed: false }), // «передзвоніть» — поза знаменником
  call(1, 7, { state: "queued", priceDiscussed: null }),                // не розібрано
  call(1, 7, { nonTarget: true }),                                      // нецільовий («Дубль») — сховано на екрані
  call(1, 7, { inReport: false }),                                      // «Виключені» — не вкладка «Звіт»
  call(2, 8, { priceDiscussed: true }), call(2, 8, { nonTarget: true, priceDiscussed: false }), // «Перевізник»
  call(2, 8, { priceDiscussed: false }),                                // цільовий, ціни не було
  call(null, null, { priceDiscussed: true }),                           // без менеджера
  call(2, 8, { adaptation: true, priceDiscussed: false }),              // новачок на адаптації — не в балі команди (задача 7239)
];

test("#3340 ЦІНУ НАЗВАНО · ПРАВИЛА: розмови → лічильники; поза знаменником — втрачений, «передзвоніть», нерозібрані; стани", () => {
  const r = firstTouchCountsFromCalls(FIXTURE as never);
  assert.deepEqual(r.byManager.get(1), { analyzed: 3, voiced: 1, noRecord: 1 },
    "🔴 у знаменник потрапив втрачений лід / «передзвоніть», нецільовий чи виключений — або нерозібрану розмову загублено");
  assert.deepEqual(r.byManager.get(2), { analyzed: 2, voiced: 1, noRecord: 0 }, "🔴 нецільовий («Перевізник») не сховано, або цільову розмову сховано разом з ним");
  assert.deepEqual(r.unmapped, { analyzed: 1, voiced: 1, noRecord: 0 }, "🔴 розмова без менеджера зникла замість стати окремим числом");
  assert.deepEqual(r.rows.find((x) => x.managerId === 2)?.teamId, 8, "🔴 рядок не несе команди — «поза ростером» у зрізі команди не порахувати");

  assert.equal(firstTouchCell(undefined, false).state, "not_covered", "🔴 період без розбору показано як «0 з 0»");
  assert.deepEqual(firstTouchCell(undefined, true), { state: "measured", analyzed: 0, voiced: 0, noRecord: 0 },
    "🔴 період із розбором без розмов — це «оцінок немає», а не «не вимірюється»");
  assert.equal(firstTouchCell({ analyzed: 2, voiced: 1, noRecord: 0 }, false).state, "measured", "🔴 наявні оцінки сховано");
  assert.equal(firstTouchPct(0, 0), null, "🔴 нуль оцінених — це «нема з чого рахувати», а не 0%");
  assert.equal(firstTouchPct(1, 3), 33.3);
  assert.deepEqual(sumFirstTouch([{ analyzed: 1, voiced: 1, noRecord: 2 }, { analyzed: 40, voiced: 10, noRecord: 0 }]), { analyzed: 41, voiced: 11, noRecord: 2 });

  const roster = new Set([1]);
  assert.deepEqual(firstTouchOutsideRoster(r.rows, roster, {}), { analyzed: 2, voiced: 1, noRecord: 0 }, "🔴 у зрізі компанії розмови людей поза ростером зникли");
  assert.deepEqual(firstTouchOutsideRoster(r.rows, roster, { teamId: 7 }), { analyzed: 0, voiced: 0, noRecord: 0 }, "🔴 «поза ростером» узяло чужу команду");
  assert.deepEqual(firstTouchOutsideRoster(r.rows, roster, { managerId: 1 }), { analyzed: 0, voiced: 0, noRecord: 0 });
  const nc = firstTouchCell(undefined, false);
  assert.equal(glanceFirstTouch([nc, nc], { analyzed: 0, voiced: 0, noRecord: 0 }).state, "not_covered");
  assert.equal(glanceFirstTouch([nc], { analyzed: 3, voiced: 1, noRecord: 0 }).state, "measured", "🔴 оцінки поза ростером є, а підсумок каже «не вимірюється»");
});

/** Фронт екрана AI — ВИКОНУЄТЬСЯ (транспіляція), щоб праворуч стояло те, що малює плитку, а не копія в тесті. */
const FE = (rel: string): string => fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url));
async function transpile(rel: string, deps: Record<string, string> = {}): Promise<string> {
  const ts = (await import("typescript")).default;
  let js = ts.transpileModule(readFileSync(FE(rel), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [spec, url] of Object.entries(deps)) js = js.split(`from "${spec}"`).join(`from "${url}"`);
  return `data:text/javascript,${encodeURIComponent(js)}`;
}
interface ViewMod {
  DEFAULT_LIST_FILTER: object;
  applyListFilter: <T>(rows: readonly T[], f: object) => T[];
  tabRows: <T>(rows: readonly T[], tab: "report" | "excluded") => T[];
  tileStats: (rows: readonly unknown[]) => { price: { yes: number; of: number } };
  firstTouchSummary: (rows: readonly unknown[]) => { tiles: { price: { yes: number; of: number } } };
}
async function loadView(): Promise<ViewMod> {
  const period = await transpile("pages/dashboard/periodRules.ts");
  return await import(await transpile("pages/dashboard/aiCallsView.ts", { "./periodRules": period })) as ViewMod;
}
/** Рядок так, як його віддає `/ai-calls` (поля, які читають фільтр і плитка). Що роут справді так їх складає — `#3343`. */
const asScreenRow = (r: Row) => ({ ...r, checklist: checklist(r as never),
  transportKind: null, dealOutcome: null, flags: { analysed: false, priceable: false, agreement: false, lost: false } });
// 06.11.2026 (задача 7239 п.3): плитка — зі СПІЛЬНОЇ функції екрана (`firstTouchSummary`: той самий фільтр, вкладка «Звіт»,
// без новачків на адаптації), а не з копії формули тут. Копія, написана в тесті, розійшлась із екраном на першій же зміні
// (прод 06.11: «Звіт 272 з 459 ≠ плитка 316 з 630» — у копії не було фільтра новачків). Твердження те саме: Звіт == плитка.
const screenPrice = (view: ViewMod, rows: readonly Row[]) =>
  (({ yes, of }) => ({ yes, of }))(view.firstTouchSummary(rows.map(asScreenRow)).tiles.price);

test("#3341 ЦІНУ НАЗВАНО · ЗВІТ == ПЛИТКА ЕКРАНА AI на фікстурі по обидва боки кожної межі", async () => {
  const view = await loadView();
  const r = firstTouchCountsFromCalls(FIXTURE as never);
  const report = sumFirstTouch([...r.byManager.values(), r.unmapped]);
  const tile = screenPrice(view, FIXTURE);
  assert.ok(tile.of > 0, "🔴 фікстура нічого не дала плитці — порівнювати нема чого");
  assert.deepEqual({ yes: report.voiced, of: report.analyzed }, tile,
    `🔴 Звіт ${String(report.voiced)} з ${String(report.analyzed)} ≠ плитка ${String(tile.yes)} з ${String(tile.of)} — відбір розійшовся з екраном AI`);
});

/** #3342 — ЖИВІ ДАНІ: ті самі розмови останніх 30 днів, ОДИН виклик `aiCallsList` на обидві сторони рівності. */
test("#3342 ЦІНУ НАЗВАНО · ЖИВА БД: Σ Звіту == плитка «Ціна озвучена» за той самий період, одним викликом", needsBackendEnv(), async (t) => {
  const { pool } = await import("../db/pool.js");
  const { emptyPeriodSkip } = await import("../testMode.js");
  const { kyivToday } = await import("./dates.js");
  const { aiCallsList } = await import("./callAiScreen.js");
  const { adDealSql, REJECT_NONTARGET } = await import("./metrics.js");
  const { getSettings } = await import("../routes/settings.js");
  const to = kyivToday();
  const d = new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 30);
  const from = d.toISOString().slice(0, 10);
  const { adSources } = await getSettings();
  const list = await aiCallsList(pool, { predicate: adDealSql, adSources }, from, to, new Date(), {});
  const view = await loadView();
  // `nonTarget` — так, як його складає роут `/ai-calls` (вираз звіряє #3343), і цей самий масив — у Звіт.
  const calls = list.rows.map((x) => ({ ...x, nonTarget: x.rejectReason != null && REJECT_NONTARGET.includes(x.rejectReason) }));
  const tile = screenPrice(view, calls as unknown as Row[]);
  const skip = emptyPeriodSkip("розібраних розмов першого дотику, де ціну мали назвати", tile.of, `${from}…${to}`);
  if (skip) return t.skip(skip);
  assert.equal(list.truncated, false, "🔴 список обрізано лімітом — обидва числа неповні");
  const r = firstTouchCountsFromCalls(calls);
  const report = sumFirstTouch([...r.byManager.values(), r.unmapped]);
  assert.deepEqual({ yes: report.voiced, of: report.analyzed }, tile,
    `🔴 Звіт ${String(report.voiced)} з ${String(report.analyzed)} ≠ плитка ${String(tile.yes)} з ${String(tile.of)} (${from}…${to})`);
});

test("#3343 ЦІНУ НАЗВАНО · ПРОВОДКА: Звіт бере розмови екрана AI, не лист бота; роут складає рядок так, як міряє #3341", () => {
  const SRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
  const core = SRC("core/firstTouch.ts"), rules = SRC("core/firstTouchRules.ts"), dash = SRC("routes/dashboard.ts");
  for (const [name, src] of [["core/firstTouch.ts", core], ["core/firstTouchRules.ts", rules]] as const) {
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /\bfirst_touch_analysis\b/, `🔴 ${name} знову читає лист бота`);
  }
  assert.match(core, /aiCallsList\(pool, \{ predicate: adDealSql, adSources \}, since, to, new Date\(\), \{\}\)/, "🔴 Звіт бере розмови не тим викликом, що екран AI, або зі звуженим скоупом");
  assert.match(core, /const since = from > FIRST_TOUCH_RULE\.startDate \? from : FIRST_TOUCH_RULE\.startDate;/,
    "🔴 Звіт тягне розмови до старту розбору — вони стають «не розібраними», а квартал упирається в таймаут 20 с");
  assert.match(rules, /const mark = checklist\(r\)\?\.price;/, "🔴 ціну Звіт рахує не правилом чек-листа екрана");
  // 06.11.2026 (задача 7239 п.3): до умови додано `!countsForTeam(r)` — новачки на адаптації у Звіті не рахуються; твердження те саме.
  assert.match(rules, /if \(!r\.inReport \|\| r\.nonTarget \|\| !countsForTeam\(r\)\) continue;/, "🔴 Звіт бере не вкладку «Звіт» або не ховає нецільових");
  assert.match(core, /nonTarget: r\.rejectReason != null && REJECT_NONTARGET\.includes\(r\.rejectReason\)/, "🔴 нецільові у Звіті визначаються не так, як на екрані");
  const plan = dash.slice(dash.indexOf('dashboardRouter.get("/report-plan"'), dash.indexOf('dashboardRouter.get("/report-plan/', dash.indexOf('dashboardRouter.get("/report-plan"') + 1));
  assert.ok(plan.length > 1000, "🔴 обробник /report-plan не знайдено — гейт нічого не читає");
  assert.doesNotMatch(plan, /\bfirst_touch_analysis\b/, "🔴 /report-plan читає лист бота повз ядро");
  assert.match(plan, /getSettings\(\)\.then\(\(s\) => firstTouchReport\(from, to, s\.adSources\)\)/, "🔴 Звіт рахує не з тими рекламними джерелами, що екран AI");
  assert.match(plan, /firstTouch: firstTouchCell\(ft\.byManager\.get\(m\.id\), ft\.covered\)/, "🔴 рядок менеджера без «першого дотику»");
  assert.match(plan, /firstTouch: glanceFirstTouch\(managers\.map\(\(m\) => m\.firstTouch\),\s*firstTouchOutsideRoster\(ft\.rows, new Set\(managers\.map\(\(m\) => m\.managerId\)\), \{ managerId, teamId \}\)\)/,
    "🔴 рядок команди не з тих самих клітинок або без «поза ростером»");
  assert.match(plan, /firstTouchMeta: \{ unmapped: ft\.unmapped, lastAnalyzedAt: ft\.lastAnalyzedAt, covered: ft\.covered \}/, "🔴 екран не знає, коли AI мовчить");
  // Рядок /ai-calls — саме ті поля, які #3341 і #3342 складають у `asScreenRow`.
  assert.match(dash, /checklist: checklist\(r\), checkScore:/, "🔴 /ai-calls віддає чек-лист не з `checklist()`");
  assert.match(dash, /nonTarget: r\.rejectReason != null && metrics\.REJECT_NONTARGET\.includes\(r\.rejectReason\)/, "🔴 нецільові на екрані визначаються не так, як у Звіті");
});
