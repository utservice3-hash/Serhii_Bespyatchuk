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

// ─── 🎧 Плеєр записів на екрані «Клієнти» (задача 13.10.2026; закріплений — Роман 15.10.2026) ──────────────────────
/**
 * #1760 — ПЛЕЄР ЗАКРІПЛЕНИЙ. Роман 15.10: «плеєр дзвінків трішки погано працює — зроби його меншим та фіксованим в одному
 * місці». Плеєр-рядок на всю ширину широкої таблиці обрізався зліва й тягнув смугу за екран. Тепер: одна панель
 * `RecordingDock` (`position: fixed`), підключена в `Dashboard.tsx`; рядок клієнта й картка лише кличуть `openRecording`.
 * Червоніє, якщо плеєр повернеться рядком таблиці чи в картку, з'явиться друга панель, ▶ одного з місць гратиме своїм
 * плеєром, або перемикач швидкості перескочить значення.
 */
test("#1760 ПЛЕЄР ЗАПИСІВ ЗАКРІПЛЕНИЙ: одна панель унизу екрана, рядок і картка відкривають її; ±10 с і перемотка в межах запису; швидкість 1 → 1,5 → 2 → 1", async () => {
  const r = await import(await transpile("pages/dashboard/sections/recordingPlayerRules.ts")) as {
    seekBy: (pos: number, d: number, dur: number) => number; seekAt: (x: number, w: number, dur: number) => number;
    PLAYER_RATES: readonly number[]; nextRate: (x: number) => number };
  assert.equal(r.seekBy(4, -10, 180), 0, "🔴 −10 с на 4-й секунді пішло в мінус");
  assert.equal(r.seekBy(175, 10, 180), 180, "🔴 +10 с вийшло за кінець запису");
  assert.equal(r.seekBy(60, 10, 180), 70); assert.equal(r.seekBy(60, -10, 180), 50);
  assert.equal(r.seekBy(3, 10, 0), 13, "🔴 поки тривалість невідома, +10 с не працює");
  assert.equal(r.seekAt(300, 600, 180), 90, "🔴 клік посередині смуги — не середина запису");
  assert.equal(r.seekAt(-20, 600, 180), 0); assert.equal(r.seekAt(900, 600, 180), 180, "🔴 перетягування за край смуги виходить за запис");
  assert.equal(r.seekAt(300, 0, 180), 0);
  assert.deepEqual([...r.PLAYER_RATES], [1, 1.5, 2]);
  assert.deepEqual([1, 1.5, 2].map(r.nextRate), [1.5, 2, 1], "🔴 кнопка швидкості перескакує значення або не повертається на 1×");
  const player = FE_SRC("pages/dashboard/sections/RecordingPlayer.tsx");
  assert.match(player, /go\(seekBy\(pos, -10, dur\)\)[\s\S]*−10 с/, "🔴 немає кнопки −10 с");
  assert.match(player, /go\(seekBy\(pos, 10, dur\)\)[\s\S]*\+10 с/, "🔴 немає кнопки +10 с");
  assert.match(player, /onClick=\{\(\) => setRate\(nextRate\(rate\)\)\}/, "🔴 швидкість не перемикається однією кнопкою");
  assert.match(player, /const PLAY_EVENT = "ft-audio-play";/, "🔴 два плеєри можуть грати одночасно (подія не та, що в «Першому дотику»)");
  // Панель: одна, закріплена, у Dashboard.tsx — і ніде більше.
  const dock = FE_SRC("pages/dashboard/sections/RecordingDock.tsx");
  assert.match(dock, /style=\{\{ position: "fixed", right: 16, bottom: 16,/, "🔴 панель плеєра не закріплена — їде разом із таблицею");
  assert.match(dock, /<RecordingPlayer key=\{t\.src\} src=\{t\.src\} \/>/, "🔴 панель не грає записаного в неї запису");
  assert.match(FE_SRC("pages/Dashboard.tsx"), /<\/Layout>\s*\{\/\*[^*]*\*\/\}\s*<RecordingDock \/>/, "🔴 панель не підключена в контейнері — ▶ не відкриє нічого");
  const list = FE_SRC("pages/dashboard/sections/ClientPlansSection.tsx");
  const card = FE_SRC("pages/dashboard/sections/ClientCardPanel.tsx");
  for (const [name, src] of [["рядок клієнта", list], ["картка", card]] as const) {
    assert.doesNotMatch(src, /<audio\b/, `🔴 ${name}: повернувся вузький вбудований плеєр`);
    assert.doesNotMatch(src, /<RecordingPlayer\b|<RecordingDock\b/, `🔴 ${name}: плеєр знову вбудований на місці, а не в закріпленій панелі`);
    assert.match(src, /openRecording\(\{\s*src: c\.(lastTalkRecording|recording), label:/, `🔴 ${name}: ▶ не відкриває закріплену панель`);
  }
  assert.doesNotMatch(list, /\{rec && \(\s*<tr>/, "🔴 плеєр повернувся рядком таблиці");
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
  // 14.10.2026: «Не погодився» стало «Відмовив» (`#938b`) — тут твердження те саме: «думає» окремо, рівно своє.
  assert.equal(screen.filter(v.TILE_MATCH.declined).length, 1, "дзеркало: «відмовив» — окремо від «думає»");
  const ai = FE_SRC("pages/dashboard/sections/AiCallsSection.tsx");
  assert.match(ai, /\["agreed", "Погодився після ціни"\], \["thinking", "Думає"\], \["declined", "Відмовив"\]/, "🔴 на екрані немає швидкого фільтра «Думає»");
  assert.match(ai, /думає \$\{String\(l\.thinking\)\}/, "🔴 у блоці менеджерів не видно «думає»");
  assert.deepEqual(["agreed", "thinking"].map((k) => v.parseAiLink(`?from=2026-10-01&to=2026-10-31&tile=${k}`).tile), ["agreed", "thinking"],
    "🔴 клік із картки КВП відкриє екран без фільтра згоди");
});

// ─── 🏆 Звіт КВП — ядро (задача 5605, ТЗ Юлі 12.10.2026, макет «Звіт КВП - ядро») ────────────────────────────────
/**
 * #1765 — «ЗАКРИЄМО?» І Σ ТАБЛИЦІ КОМАНД. Статус по тижню — по обидва боки кожного порога ТЗ (розділ 3): «закрито» —
 * факт ≥ план; «реально» — треба ≤ 50% очікуваного; «під ризиком» — 50–85%; «не закриється» — понад 85% або очікуваного
 * не вистачає (тоді «бракує Х»). Плану немає — статусу немає. Σ відділу = Σ показаних рядків, команда = Σ менеджерів
 * (на фікстурі, де так і є в даних), порожні рядки не показуються. Червоніє, якщо зсунути поріг, назвати «закритим» тиждень
 * без плану, рахувати «з очікуваннями» без факту або відділ — не з рядків.
 */
test("#1765 «ЗАКРИЄМО?»: пороги 50% / 85% по обидва боки, «бракує» і «без плану»; Σ відділу = Σ команд, команда = Σ менеджерів", async () => {
  const r = await import(await transpile("pages/dashboard/kvpCoreRules.ts")) as {
    weekCloseStatus: (p: number, f: number, e: number) => { kind: string; share: number | null; short: number };
    closeNote: (s: unknown, fmt: (v: number) => string) => string | null;
    coreRows: (t: unknown[], idx: number | null, nameOf: (t: { name: string | null }) => string) => { rows: { name: string; week: { plan: number; fact: number; withExp: number }; month: { plan: number; fact: number; withExp: number }; managers: { week: { plan: number; fact: number; withExp: number }; month: { plan: number; fact: number; withExp: number } }[] }[]; dept: { week: { plan: number; fact: number; withExp: number }; month: { plan: number; fact: number; withExp: number } } };
  };
  const k = (p: number, f: number, e: number) => r.weekCloseStatus(p, f, e).kind;
  assert.equal(k(100, 100, 0), "closed"); assert.equal(k(100, 120, 0), "closed");
  assert.equal(k(100, 50, 100), "real", "🔴 треба рівно 50% очікуваного — це ще «реально»");
  assert.equal(k(100, 49, 100), "risk", "🔴 51% очікуваного — уже «під ризиком»");
  assert.equal(k(100, 15, 100), "risk", "🔴 рівно 85% — ще «під ризиком»");
  assert.equal(k(100, 14, 100), "no", "🔴 86% — уже «не закриється»");
  const short = r.weekCloseStatus(100, 30, 40);
  assert.deepEqual([short.kind, short.short], ["no", 30], "🔴 очікуваного не вистачає — «не закриється» з «бракує»");
  assert.equal(r.closeNote(short, (v) => String(v)), "бракує 30 навіть з оплатами");
  assert.equal(r.closeNote(r.weekCloseStatus(100, 50, 100), (v) => String(v)), "має прийти 50% очікуваного");
  assert.equal(k(100, 0, 0), "no", "🔴 нічого не прийшло й нічого не чекаємо — не закриється");
  assert.equal(k(0, 50, 50), "none", "🔴 тиждень без плану назвали закритим");

  const wk = (plan: number, fact: number, expected: number, idx = 3) => ({ idx, plan, fact, expected, isCurrent: idx === 3 });
  const teams = [
    { teamId: 1, name: "РПК А", kind: "rpk", plan: 300, revenue: 120, expectedThisMonth: 50, weeks: [wk(80, 40, 30), wk(70, 70, 0, 2)],
      managers: [
        { managerId: 11, name: "М1", plan: 200, revenue: 100, expectedThisMonth: 40, weeks: [wk(50, 30, 20)] },
        { managerId: 12, name: "М2", plan: 100, revenue: 20, expectedThisMonth: 10, weeks: [wk(30, 10, 10)] },
        { managerId: 13, name: "Порожній", plan: 0, revenue: 0, expectedThisMonth: 0, weeks: [wk(0, 0, 0)] },
      ] },
    { teamId: null, name: null, kind: "rpk", plan: 0, revenue: 5, expectedThisMonth: 0, weeks: [wk(0, 0, 0)], managers: [] },
    { teamId: 9, name: "Порожня", kind: "rnk", plan: 0, revenue: 0, expectedThisMonth: 0, weeks: [wk(0, 0, 0)], managers: [] },
  ];
  const { rows, dept } = r.coreRows(teams, null, (t) => t.name ?? "Без команди");
  assert.deepEqual(rows.map((x) => x.name), ["РПК А", "Без команди"], "🔴 порожній рядок показано або рядок без команди загубився");
  assert.deepEqual(rows[0]!.week, { plan: 80, fact: 40, withExp: 70 }, "🔴 тиждень узято не поточний або «з очікуваннями» ≠ факт + очікування");
  assert.deepEqual(rows[0]!.month, { plan: 300, fact: 120, withExp: 170 });
  assert.equal(rows[0]!.managers.length, 2, "🔴 менеджер без жодного числа показаний");
  const sum = (a: { plan: number; fact: number; withExp: number }[]) => a.reduce((s, x) => ({ plan: s.plan + x.plan, fact: s.fact + x.fact, withExp: s.withExp + x.withExp }), { plan: 0, fact: 0, withExp: 0 });
  assert.deepEqual(sum(rows[0]!.managers.map((m) => m.week)), rows[0]!.week, "🔴 команда ≠ Σ менеджерів за тиждень");
  assert.deepEqual(sum(rows[0]!.managers.map((m) => m.month)), rows[0]!.month, "🔴 команда ≠ Σ менеджерів за місяць");
  assert.deepEqual(dept.week, sum(rows.map((x) => x.week)), "🔴 Σ відділу ≠ Σ команд (тиждень)");
  assert.deepEqual(dept.month, sum(rows.map((x) => x.month)), "🔴 Σ відділу ≠ Σ команд (місяць)");
  assert.deepEqual(r.coreRows(teams, 2, (t) => t.name ?? "-").rows[0]!.week, { plan: 70, fact: 70, withExp: 70 }, "🔴 вибраний тиждень не береться");
});

/**
 * #1765b — ЕКРАН ЯДРА: ПОРЯДОК І ВІДСУТНІСТЬ ДУБЛІВ. Зверху — 4 картки грошей (Отримані · Стратегічний план · Прогноз ·
 * Робочі дні) з поясненням під кожною, далі таблиця команд, далі «Перший дотик»; решта — у згорнутому «Детальному звіті».
 * Чотири картки не повторюються в детальному (правило «жоден показник не має двох джерел на одному екрані»).
 */
test("#1765b ЗВІТ КВП — ЯДРО: гроші → команди → перший дотик; решта згорнута; 4 картки без дубля", () => {
  const src = FE_SRC("pages/dashboard/sections/KvpReportSection.tsx");
  const iMoney = src.indexOf("💰 Гроші за "), iTeams = src.indexOf("<KvpTeamsWeekMonth rep={rep} />"),
    iFt = src.indexOf("{canSeeFirstTouch && <KvpFirstTouchBlock"), iDet = src.indexOf("{showDetails && (<>");
  assert.ok(iMoney > 0 && iMoney < iTeams && iTeams < iFt && iFt < iDet, "🔴 порядок ядра не «гроші → команди → перший дотик → детальний»");
  for (const lbl of ["Отримані кошти", "Стратегічний план 🔒", "Прогноз місяця", "Робочі дні"]) {
    const n = src.split(`label="${lbl}"`).length - 1;
    assert.equal(n, 1, `🔴 картка «${lbl}» на екрані ${String(n)} разів — дві копії одного числа`);
    assert.ok(src.indexOf(`label="${lbl}"`) < iTeams, `🔴 картка «${lbl}» не в ядрі`);
  }
  assert.match(src, /useState\(\(\) => \{ try \{ return localStorage\.getItem\("kvpDetails"\) === "1"; \} catch \{ return false; \} \}\)/, "🔴 «Детальний звіт» не згорнутий за замовчуванням");
  const tbl = FE_SRC("pages/dashboard/sections/KvpTeamsWeekMonth.tsx");
  assert.match(tbl, /coreRows\(rep\.teams as unknown as TeamLike\[\], blk\?\.idx \?\? null,/, "🔴 таблиця рахує рядки не спільною функцією");
  assert.match(tbl, /<td style=\{\{ fontWeight: 700 \}\}>Σ Відділ<\/td>\s*<Cells r=\{dept\} bold \/>/, "🔴 рядок «Σ Відділ» не з тих самих рядків");
  assert.match(tbl, /weekCloseStatus\(w\.plan, w\.fact, w\.withExp - w\.fact\)/, "🔴 статус «Закриємо?» не тим правилом");
  assert.match(tbl, /\{CLOSE_LABEL\[s\.kind\]\}/, "🔴 статус показано лише кольором, без слова");
});

/**
 * #1765c — «ПЕРШИЙ ДОТИК» У ЯДРІ: КАРТКА ФІЛЬТРУЄ ТАБЛИЦЮ. Клік по картці — фільтр (менеджери з такими розмовами й
 * скільки їх), повторний — знімає; фільтр команди, «Скинути», сортування кожної колонки, «—» завжди внизу.
 * Червоніє, якщо картка знову веде геть замість фільтра, «—» стане нулем у сортуванні або фільтр рахуватиме не ті розмови.
 */
test("#1765c ПЕРШИЙ ДОТИК У ЯДРІ: картка = фільтр таблиці, команда, «Скинути», сортування («—» внизу)", async () => {
  const r = await import(await transpile("pages/dashboard/kvpCoreRules.ts")) as {
    sortFtLines: <T>(l: T[], k: string | null, d: "asc" | "desc") => T[];
    tileCountsByManager: (rows: { managerId: number | null; x: boolean }[], m: ((r: { x: boolean }) => boolean) | null) => Map<number | null, number> | null;
  };
  const L = (id: number, price: number | null) => ({ id, calls: 1, score: null, price, promise: null, objection: null, decided: 0, agreed: 0, success: 0 });
  const lines = [L(1, 40), L(2, null), L(3, 80), L(4, 10)];
  assert.deepEqual(r.sortFtLines(lines, "price", "desc").map((x) => x.id), [3, 1, 4, 2], "🔴 сортування за спаданням або «—» не внизу");
  assert.deepEqual(r.sortFtLines(lines, "price", "asc").map((x) => x.id), [4, 1, 3, 2], "🔴 «—» піднялось нагору при зростанні — читалось би як 0");
  assert.deepEqual(r.sortFtLines(lines, null, "desc").map((x) => x.id), [1, 2, 3, 4], "🔴 без сортування порядок змінився");
  const rows = [{ managerId: 1, x: true }, { managerId: 1, x: true }, { managerId: 2, x: false }, { managerId: null, x: true }];
  const m = r.tileCountsByManager(rows, (q) => q.x)!;
  assert.deepEqual([m.get(1), m.get(2), m.get(null)], [2, undefined, 1], "🔴 фільтр картки рахує не ті розмови");
  assert.equal(r.tileCountsByManager(rows, null), null, "🔴 без картки таблиця фільтрується");
  const src = FE_SRC("pages/dashboard/sections/KvpFirstTouchBlock.tsx");
  assert.match(src, /onClick=\{\(\) => setTile\(on \? null : k\)\}/, "🔴 клік по картці не фільтрує таблицю (або не знімає фільтр)");
  assert.match(src, /const hits = tileCountsByManager\(all\.rows, tile \? TILE_MATCH\[tile\] : null\);/, "🔴 фільтр картки не з того самого TILE_MATCH, що екран AI");
  assert.match(src, /<option value="all">Усі команди<\/option>/, "🔴 немає фільтра «Команда»");
  assert.match(src, /onClick=\{reset\}[^>]*>Скинути<\/button>/, "🔴 немає «Скинути»");
  for (const key of ["calls", "score", "price", "promise", "objection", "agreed", "success"]) {
    assert.match(src, new RegExp(`\\{th\\("${key}", `), `🔴 колонка «${key}» не сортується`);
  }
});
