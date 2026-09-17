import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 🎯 #477 — фронт «першого дотику» у Звіті. Модулі фронту ВИКОНУЮТЬСЯ (транспіляція, прийом `#138`). */
const FE = (rel: string): string => fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url));
async function load<T>(rel: string): Promise<T> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE(rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`) as T;
}
type Cell = { state: "measured" | "not_covered"; analyzed: number; voiced: number; noRecord: number };
interface ColsMod {
  REPORT_COLS: { key: string; foot: string; help?: string }[];
  DEFAULT_OPT_ON: Record<string, boolean>;
  footValue: (key: string, rows: unknown[]) => { value: number | null; extra?: { num: number; den: number } };
  firstTouchLabel: (c: Cell | undefined) => { main: string; sub: string | null; muted: boolean };
  firstTouchStale: (last: string | null, today: string, periodTo: string) => boolean;
}
interface ScopeMod { mergeReportPlans: (parts: unknown[]) => { glance: { firstTouch: { analyzed: number; voiced: number; noRecord: number; state: string; outside: { analyzed: number; voiced: number; noRecord: number } } } } }

test("#477 ПЕРШИЙ ДОТИК · ФРОНТ: підсумок — частка з сум; три стани; «бот мовчить»; злиття команд", async () => {
  const C = await load<ColsMod>("pages/dashboard/reportTableCols.ts");
  const col = C.REPORT_COLS.find((x) => x.key === "firstTouch");
  assert.ok(col, "🔴 колонки «першого дотику» немає в реєстрі таблиці");
  assert.equal(col.foot, "ratio:firstTouch", "🔴 підсумок колонки не частка — відсотки складатимуться");
  assert.equal(C.DEFAULT_OPT_ON.firstTouch, true, "🔴 колонка вимкнена за замовчуванням — рядка в табличному Звіті ніхто не побачить");

  const m = (c: Cell) => ({ firstTouch: c });
  const f = C.footValue("firstTouch", [m({ state: "measured", analyzed: 1, voiced: 1, noRecord: 0 }), m({ state: "measured", analyzed: 40, voiced: 10, noRecord: 3 }),
    m({ state: "not_covered", analyzed: 0, voiced: 0, noRecord: 0 })]);
  assert.equal(f.value, 26.8, `🔴 підсумок ${String(f.value)}% — не Σ названих ÷ Σ оцінених (11/41); середнє відсотків дало б 62.5%`);
  assert.deepEqual(f.extra, { num: 11, den: 41 });
  assert.equal(C.footValue("firstTouch", [m({ state: "not_covered", analyzed: 0, voiced: 0, noRecord: 0 })]).value, null, "🔴 «нема з чого рахувати» показано числом");

  assert.deepEqual(C.firstTouchLabel({ state: "not_covered", analyzed: 0, voiced: 0, noRecord: 0 }), { main: "не вимірюється", sub: null, muted: true });
  assert.deepEqual(C.firstTouchLabel({ state: "measured", analyzed: 0, voiced: 0, noRecord: 0 }), { main: "—", sub: "оцінок немає", muted: true },
    "🔴 «оцінок немає» злилось із «не вимірюється» або з нулем");
  assert.deepEqual(C.firstTouchLabel({ state: "measured", analyzed: 0, voiced: 0, noRecord: 2 }), { main: "—", sub: "без запису 2", muted: true });
  assert.deepEqual(C.firstTouchLabel({ state: "measured", analyzed: 4, voiced: 1, noRecord: 1 }), { main: "25%", sub: "1 з 4 · без запису 1", muted: false },
    "🔴 «без запису» увійшло у знаменник або зникло з підпису");

  assert.equal(C.firstTouchStale("2026-09-14", "2026-09-17", "2026-09-30"), false, "🔴 три дні (вихідні) — ще не «бот мовчить»");
  assert.equal(C.firstTouchStale("2026-09-13", "2026-09-17", "2026-09-30"), true, "🔴 чотири дні без оцінок не позначено");
  assert.equal(C.firstTouchStale(null, "2026-09-17", "2026-09-30"), true, "🔴 порожня таблиця читається як свіжа");
  assert.equal(C.firstTouchStale("2026-09-11", "2026-09-17", "2026-07-31"), false,
    "🔴 липень, що закінчився до останньої оцінки, позначено «число неповне»");
  assert.equal(C.firstTouchStale("2026-09-11", "2026-09-17", "2026-09-13"), false, "🔴 період закінчився через 2 дні після останньої оцінки — він повний");
  assert.equal(C.firstTouchStale("2026-09-11", "2026-09-17", "2026-09-15"), true);

  const S = await load<ScopeMod>("pages/dashboard/reportScope.ts");
  const plan = (a: number, v: number, n: number, state: string, outA: number) => ({
    glance: { firstTouch: { analyzed: a, voiced: v, noRecord: n, state, outside: { analyzed: outA, voiced: 0, noRecord: 0 } }, statusCounts: { g: 0, a: 0, r: 0 } },
    managers: [], dismissed: [],
  });
  assert.deepEqual(S.mergeReportPlans([plan(0, 0, 0, "not_covered", 0), plan(5, 2, 1, "measured", 4)]).glance.firstTouch,
    { analyzed: 5, voiced: 2, noRecord: 1, state: "measured", outside: { analyzed: 4, voiced: 0, noRecord: 0 } },
    "🔴 при 2+ командах лишились числа ПЕРШОЇ, стан узято з непокритої або «поза ростером» не злито");
  assert.equal(S.mergeReportPlans([plan(0, 0, 0, "not_covered", 0), plan(0, 0, 0, "not_covered", 0)]).glance.firstTouch.state, "not_covered");

  const rp = readFileSync(FE("pages/dashboard/sections/ReportPlanSection.tsx"), "utf8");
  assert.match(rp, /<FirstTouchKpi c=\{m\.firstTouch\} \/>/, "🔴 картка менеджера без рядка «ціну названо»");
  assert.match(rp, /g\.firstTouch\?\.state === "measured" && firstTouchStale\(data\.firstTouchMeta\?\.lastAnalyzedAt \?\? null, today, data\.scope\.to\)/,
    "🔴 «бот мовчить» не від кінця періоду або малюється команді, яку бот не слухає");
  assert.match(rp, /const ftGlance = firstTouchLabel\(g\.firstTouch\)/, "🔴 підсумок команди підмінює стан, а не бере його з бекенду");
  const tb = readFileSync(FE("pages/dashboard/sections/ReportTableSection.tsx"), "utf8");
  assert.match(tb, /case "firstTouch": \{\s*const l = firstTouchLabel\(m\.firstTouch\)/, "🔴 клітинка таблиці живе повз спільне правило станів");
  assert.match(tb, /col\.key === "firstTouch" && rows\.length > 0 && rows\.every\(\(m\) => m\.firstTouch\?\.state !== "measured"\)/,
    "🔴 підсумок групи, яку бот не слухає, знову «—» замість «не вимірюється»");
});
