import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🎧 «ПЕРШИЙ ДОТИК» У ЗВІТІ КВП (задача 5314, 13.10.2026): цифри Звіту КВП == цифри екрана «Перший дотик · AI» за той
 * самий період — бо рахує їх той самий код (`aiCallsView.ts`), а не друга копія. Правила вигляду — фронтові, тож
 * виконуються транспільованим модулем, як у `#834`.
 */
const FE = (rel: string): string => fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url));
const FE_SRC = (rel: string) => readFileSync(FE(rel), "utf8");

async function transpile(rel: string, deps: Record<string, string> = {}): Promise<string> {
  const ts = (await import("typescript")).default;
  let js = ts.transpileModule(FE_SRC(rel), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [spec, url] of Object.entries(deps)) js = js.split(`from "${spec}"`).join(`from "${url}"`);
  return `data:text/javascript,${encodeURIComponent(js)}`;
}
type Line = { managerId: number | null; name: string; calls: number; price: number | null; promise: number | null; objections: number; objectionsHandled: number; success: number };
type Tiles = { noCall: { n: number; of: number }; price: { yes: number; of: number; pct: number | null }; objection: { handled: number; of: number; pct: number | null }; lost: number; success: { n: number; of: number } };
interface View {
  firstTouchSummary: (rows: readonly unknown[], teamId?: number | null) => { rows: unknown[]; tiles: Tiles; lines: Line[]; total: Line | null };
  summaryTeams: (rows: readonly unknown[]) => { id: number | null; name: string }[];
  tileStats: (rows: readonly unknown[]) => Tiles;
  managerChecklist: (rows: readonly unknown[]) => Line[];
  applyListFilter: (rows: readonly unknown[], f: unknown) => unknown[];
  tabRows: (rows: readonly unknown[], tab: string) => unknown[];
  DEFAULT_LIST_FILTER: unknown;
  aiCallsHref: (p: { from: string; to: string; tile?: string | null; teamId?: number | null; managerId?: number | null }) => string;
  parseAiLink: (search: string) => { nav: { mode: string; anchor: string; rangeFrom: string; rangeTo: string } | null; tile: string | null; teamId: number | null; managerId: number | null; any: boolean };
  withoutAiLinkParams: (href: string) => string;
}
async function view(): Promise<View> {
  const period = await transpile("pages/dashboard/periodRules.ts");
  return await import(await transpile("pages/dashboard/aiCallsView.ts", { "./periodRules": period })) as View;
}

// Розмова звіту: команда, менеджер, ціна (y/n), обіцянка (y/n/o), чи поїхало; `extra` — винятки фікстури.
const row = (teamId: number | null, managerId: number, price: "y" | "n", promise: "y" | "n" | "o", success = false, extra: Record<string, unknown> = {}) => ({
  pipelineGroup: "full", teamId, teamName: teamId == null ? null : `Команда ${String(teamId)}`, managerId, managerName: `М${String(managerId)}`,
  nonTarget: false, inReport: true, conversationType: "cargo_request",
  checklist: { request: "y", price, promise, objection: "o" },
  checkScore: { yes: 1 + (price === "y" ? 1 : 0) + (promise === "y" ? 1 : 0), total: 2 + (promise === "o" ? 0 : 1) },
  promiseState: promise === "n" ? "broken" : promise === "y" ? "kept_talk" : null,
  dealOutcome: success ? { state: "success" } : null,
  flags: { analysed: true, priceable: true, agreement: promise !== "o", lost: false },
  reactionMin: null, ...extra,
});
const FIXTURE = [
  row(1, 11, "y", "y", true), row(1, 11, "n", "n"), row(1, 12, "y", "o"),
  row(2, 21, "n", "o"), row(2, 21, "y", "y", true),
  row(null, 31, "y", "n"),
  // Не в цифрах екрана: нецільова (схована за замовчуванням) і виключена (не «Звіт»).
  row(1, 11, "n", "n", false, { nonTarget: true }),
  row(2, 21, "n", "n", false, { inReport: false, conversationType: "carrier" }),
];

test("#1690 ЗВІТ КВП == ЕКРАН AI: картки — ті самі числа, що екран при відкритті; рядок команди == екран із цією командою; Σ команд == відділ", async () => {
  const v = await view();
  const s = v.firstTouchSummary(FIXTURE);
  // Ліва сторона — блок КВП; права — рівно те, що рахує екран «Перший дотик · AI» при відкритті.
  const screen = v.tabRows(v.applyListFilter(FIXTURE, v.DEFAULT_LIST_FILTER), "report");
  assert.deepEqual(s.tiles, v.tileStats(screen), "🔴 картки Звіту КВП розійшлися з плитками екрана AI");
  assert.equal(s.rows.length, 6, "🔴 у цифри потрапила нецільова чи виключена розмова — екран AI їх не рахує");
  assert.deepEqual([s.tiles.price.yes, s.tiles.price.of, s.tiles.price.pct], [4, 6, 67]);
  assert.deepEqual(s.tiles.noCall, { n: 2, of: 4 });
  assert.deepEqual(s.tiles.success, { n: 2, of: 6 });
  assert.equal(s.total?.calls, 6); assert.equal(s.total?.price, 67, "🔴 рядок «Разом» рахує ціну не тією формулою, що картка");
  for (const t of v.summaryTeams(s.rows)) {
    const ts = v.firstTouchSummary(FIXTURE, t.id);
    const screenTeam = v.tabRows(v.applyListFilter(FIXTURE, { ...(v.DEFAULT_LIST_FILTER as object), teamId: t.id }), "report");
    if (t.id != null) assert.deepEqual(ts.tiles, v.tileStats(screenTeam), `🔴 рядок команди «${t.name}» ≠ екран AI з цією командою`);
    assert.deepEqual(ts.lines.map((l) => l.managerId).sort(), [...new Set(screenTeam.map((r) => (r as { managerId: number }).managerId))].sort());
  }
  const teams = v.summaryTeams(s.rows);
  assert.deepEqual(teams.map((t) => t.name), ["Команда 1", "Команда 2", "Без команди"], "🔴 розмови без команди зникли з таблиці");
  // Σ розмов по командах == відділ: «без команди» — окремий рядок, а не дірка (на «усі» фільтрі teamId=null — це всі, тож рахуємо руками).
  const byTeam = teams.map((t) => s.rows.filter((r) => (r as { teamId: number | null }).teamId === t.id).length);
  assert.equal(byTeam.reduce((a, b) => a + b, 0), s.total?.calls, "🔴 Σ розмов команд ≠ відділ");
});

test("#1690b ПЕРЕХІД ЗІ ЗВІТУ КВП: посилання несе період, плитку, команду й менеджера; місяць лишається місяцем; сміття ігнорується", async () => {
  const v = await view();
  const month = v.parseAiLink(new URL(v.aiCallsHref({ from: "2026-10-01", to: "2026-10-31", tile: "noCall", teamId: 7 }), "https://x").search);
  assert.deepEqual([month.nav?.mode, month.nav?.anchor, month.tile, month.teamId, month.managerId, month.any], ["month", "2026-10-01", "noCall", 7, null, true],
    "🔴 екран AI відкрився не з тим періодом чи фільтром, що в Звіті КВП");
  const range = v.parseAiLink(new URL(v.aiCallsHref({ from: "2026-10-06", to: "2026-10-12", managerId: 31 }), "https://x").search);
  assert.deepEqual([range.nav?.mode, range.nav?.rangeFrom, range.nav?.rangeTo, range.tile, range.managerId], ["range", "2026-10-06", "2026-10-12", null, 31],
    "🔴 тиждень Звіту КВП відкрився місяцем — цифри розійдуться");
  const junk = v.parseAiLink("?from=2026-13-99&to=x&tile=drop&team=-1");
  assert.deepEqual([junk.nav, junk.tile, junk.teamId], [null, null, null], "🔴 сміття з адреси прочитано як фільтр");
  assert.equal(v.parseAiLink("").any, false);
  assert.equal(v.withoutAiLinkParams("https://d.uts.ua/ai-calls?from=2026-10-01&to=2026-10-31&tile=noCall&call=abc.1"), "/ai-calls?call=abc.1",
    "🔴 після відкриття фільтр лишився в адресі (або злетіла картка дзвінка)");
});

test("#1690d ПРОВОДКА: екран AI і блок КВП беруть ТОЙ САМИЙ фільтр і ту саму функцію; «погодився» — з tileStats і managerChecklist; фінансист без вкладки AI блоку не бачить", () => {
  const ai = FE_SRC("pages/dashboard/sections/AiCallsSection.tsx");
  assert.match(ai, /useState<ListFilter>\(\(\) => \(\{ \.\.\.DEFAULT_LIST_FILTER, teamId: link\.teamId, managerId: link\.managerId \}\)\)/, "🔴 екран AI відкривається не з DEFAULT_LIST_FILTER — склад розмов розійдеться зі Звітом КВП");
  assert.match(ai, /const rows = tabRows\(scopedAll, "report"\);/);
  assert.match(ai, /const ts = tileStats\(rows\);/, "🔴 плитки екрана AI рахуються не tileStats");
  assert.match(ai, /parseAiLink\(window\.location\.search\)/, "🔴 екран AI не читає перехід зі Звіту КВП");
  const kvp = FE_SRC("pages/dashboard/sections/KvpFirstTouchBlock.tsx");
  assert.match(kvp, /firstTouchSummary\(d\.rows\)/, "🔴 блок КВП рахує не спільною функцією");
  assert.doesNotMatch(kvp, /\btileStats\(|\bmanagerChecklist\(/, "🔴 у блоці КВП своя копія розрахунку");
  // 14.10.2026 (задача 5316 повернута): розбір згоди на проді з 13.10 — картка й колонка рахуються ТІЄЮ САМОЮ статистикою, що екран.
  assert.match(kvp, /card\(ts\.decision\.of \? "agreed" : null, "Клієнт погодився", pctStr\(ts\.decision\.pct\)/, "🔴 «Клієнт погодився» не з tileStats().decision — розійдеться з екраном");
  assert.match(kvp, /думає \$\{String\(ts\.decision\.thinking\)\}/, "🔴 картка КВП не показує «думає»");
  assert.match(kvp, /\{l\.decided \? `\$\{pctStr\(Math\.round\(\(l\.agreed \/ l\.decided\) \* 100\)\)\}/, "🔴 колонка «Погодився» не з лічильників managerChecklist");
  assert.doesNotMatch(kvp, /title="Пункт «клієнт погодився» з'явиться після окремої задачі">—</, "🔴 у таблиці КВП досі вічний прочерк замість згоди");
  assert.match(FE_SRC("pages/Dashboard.tsx"), /<KvpReportSection canSeeFirstTouch=\{!!screens\?\.includes\("ai-calls"\)\} \/>/, "🔴 блок бачить роль без вкладки «Перший дотик · AI» (фінансист отримав би 403)");
  assert.match(FE_SRC("pages/dashboard/sections/KvpReportSection.tsx"), /\{canSeeFirstTouch && <KvpFirstTouchBlock from=\{rep\.scope\.from\} to=\{rep\.scope\.to\} \/>\}/, "🔴 блок не стоїть у Звіті КВП або бере інший період");
});

// ─── 🎧 Плеєр записів на екрані «Клієнти» (задача 13.10.2026) ────────────────────────────────────────────────
test("#1691b ПЛЕЄР ЗАПИСІВ: ±10 с не виходить за межі запису, смуга перемотує точно; у рядку й картці — один плеєр на всю ширину, вузьких <audio> немає", async () => {
  const r = await import(await transpile("pages/dashboard/sections/recordingPlayerRules.ts")) as {
    seekBy: (pos: number, d: number, dur: number) => number; seekAt: (x: number, w: number, dur: number) => number; PLAYER_RATES: readonly number[] };
  assert.equal(r.seekBy(4, -10, 180), 0, "🔴 −10 с на 4-й секунді пішло в мінус");
  assert.equal(r.seekBy(175, 10, 180), 180, "🔴 +10 с вийшло за кінець запису");
  assert.equal(r.seekBy(60, 10, 180), 70); assert.equal(r.seekBy(60, -10, 180), 50);
  assert.equal(r.seekBy(3, 10, 0), 13, "🔴 поки тривалість невідома, +10 с не працює");
  assert.equal(r.seekAt(300, 600, 180), 90, "🔴 клік посередині смуги — не середина запису");
  assert.equal(r.seekAt(-20, 600, 180), 0); assert.equal(r.seekAt(900, 600, 180), 180, "🔴 перетягування за край смуги виходить за запис");
  assert.equal(r.seekAt(300, 0, 180), 0);
  assert.deepEqual([...r.PLAYER_RATES], [1, 1.5, 2]);
  const player = FE_SRC("pages/dashboard/sections/RecordingPlayer.tsx");
  assert.match(player, /go\(seekBy\(pos, -10, dur\)\)[\s\S]*−10 с/, "🔴 немає кнопки −10 с");
  assert.match(player, /go\(seekBy\(pos, 10, dur\)\)[\s\S]*\+10 с/, "🔴 немає кнопки +10 с");
  assert.match(player, /PLAYER_RATES\.map/, "🔴 немає швидкості 1× / 1,5× / 2×");
  assert.match(player, /const PLAY_EVENT = "ft-audio-play";/, "🔴 два плеєри можуть грати одночасно (подія не та, що в «Першому дотику»)");
  const list = FE_SRC("pages/dashboard/sections/ClientPlansSection.tsx");
  const card = FE_SRC("pages/dashboard/sections/ClientCardPanel.tsx");
  for (const [name, src] of [["рядок / обґрунтування", list], ["картка", card]] as const) {
    assert.doesNotMatch(src, /<audio\b/, `🔴 ${name}: повернувся вузький вбудований плеєр`);
    assert.match(src, /<RecordingPlayer\b/, `🔴 ${name}: немає спільного плеєра`);
  }
  assert.match(list, /\{rec && \(\s*<tr>\s*<td colSpan=\{colCount\}/, "🔴 плеєр у рядку клієнта не на всю ширину таблиці");
});

/**
 * #939 — ЗГОДА ПІСЛЯ ЦІНИ У ЗВІТІ КВП І «ДУМАЄ» (задача 5316, повернута 14.10.2026: «картка „Клієнт погодився“ досі з
 * прочерком… треба ті самі цифри, що й на екрані „Перший дотик“»; «додай „думає“ — скільки клієнтів після ціни взяли паузу»).
 * Картка = `tileStats().decision` (частка «погодився» серед розмов із відомим рішенням), колонка = лічильники `managerChecklist`;
 * Σ команд == відділ і по згоді; фільтр «Думає» = рівно «думає»; «не визначено» — ні в знаменнику, ні в «думає».
 * 🧨 Червоніє, якщо «не визначено» потрапить у знаменник, «думає» змішається з «відмовив» чи картка КВП порахує інакше, ніж екран.
 */
test("#939 ЗГОДА У ЗВІТІ КВП == ЕКРАН; «ДУМАЄ» ОКРЕМО: частка серед відомих рішень, «не визначено» — поза знаменником, Σ команд == відділ", async () => {
  const v = await view() as View & { TILE_MATCH: Record<string, (r: unknown) => boolean> };
  const dec = (value: string) => ({ clientDecision: { value, quote: "х", quoteFound: true } });
  const F = [
    row(1, 11, "y", "o", false, dec("agreed")), row(1, 11, "y", "o", false, dec("thinking")), row(1, 12, "y", "o", false, dec("declined")),
    row(2, 21, "y", "o", false, dec("agreed")), row(2, 21, "y", "o", false, dec("unclear")), row(2, 21, "n", "o"),
  ];
  const s = v.firstTouchSummary(F);
  const d = (s.tiles as unknown as { decision: { agreed: number; thinking: number; declined: number; of: number; pct: number | null } }).decision;
  assert.deepEqual(d, { agreed: 2, thinking: 1, declined: 1, of: 4, pct: 50 }, "🔴 згода в картці КВП порахована не так (чи «не визначено» в знаменнику)");
  const screen = v.tabRows(v.applyListFilter(F, v.DEFAULT_LIST_FILTER), "report");
  assert.deepEqual(d, (v.tileStats(screen) as unknown as { decision: unknown }).decision, "🔴 картка КВП ≠ екран AI");
  const tot = s.total as unknown as { decided: number; agreed: number; thinking: number };
  assert.deepEqual([tot.decided, tot.agreed, tot.thinking], [4, 2, 1], "🔴 рядок «Разом» рахує згоду не тими лічильниками, що картка");
  const teamSum = v.summaryTeams(s.rows).map((t) => v.firstTouchSummary(F, t.id).total as unknown as { decided: number; agreed: number })
    .reduce((a, x) => ({ decided: a.decided + x.decided, agreed: a.agreed + x.agreed }), { decided: 0, agreed: 0 });
  assert.deepEqual(teamSum, { decided: 4, agreed: 2 }, "🔴 Σ команд ≠ відділ по згоді");
  assert.equal(screen.filter(v.TILE_MATCH.thinking).length, 1, "🔴 фільтр «Думає» бере не рівно «думає»");
  assert.equal(screen.filter(v.TILE_MATCH.notAgreed).length, 2, "дзеркало: «не погодився» = думає + відмовив");
  const ai = FE_SRC("pages/dashboard/sections/AiCallsSection.tsx");
  assert.match(ai, /\["agreed", "Погодився після ціни"\], \["thinking", "Думає"\], \["notAgreed", "Не погодився"\]/, "🔴 на екрані немає швидкого фільтра «Думає»");
  assert.match(ai, /думає \$\{String\(l\.thinking\)\}/, "🔴 у блоці менеджерів не видно «думає»");
  assert.deepEqual(["agreed", "thinking"].map((k) => v.parseAiLink(`?from=2026-10-01&to=2026-10-31&tile=${k}`).tile), ["agreed", "thinking"],
    "🔴 клік із картки КВП відкриє екран без фільтра згоди");
});
