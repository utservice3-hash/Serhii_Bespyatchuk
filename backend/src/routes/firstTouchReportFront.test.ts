import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 🎯 #469 — фронт «першого дотику» у Звіті. Модулі фронту ВИКОНУЮТЬСЯ (транспіляція, прийом `#138`). */
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
  firstTouchStale: (last: string | null, today: string) => boolean;
}
interface ScopeMod { mergeReportPlans: (parts: unknown[]) => { glance: { firstTouch: { analyzed: number; voiced: number; noRecord: number } } } }

test("#469 ПЕРШИЙ ДОТИК · ФРОНТ: підсумок — частка з сум; три стани; «бот мовчить»; злиття команд", async () => {
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

  assert.equal(C.firstTouchStale("2026-09-14", "2026-09-17"), false, "🔴 три дні (вихідні) — ще не «бот мовчить»");
  assert.equal(C.firstTouchStale("2026-09-13", "2026-09-17"), true, "🔴 чотири дні без оцінок не позначено");
  assert.equal(C.firstTouchStale(null, "2026-09-17"), true, "🔴 порожня таблиця читається як свіжа");

  const S = await load<ScopeMod>("pages/dashboard/reportScope.ts");
  const plan = (a: number, v: number, n: number) => ({
    glance: { firstTouch: { analyzed: a, voiced: v, noRecord: n }, statusCounts: { g: 0, a: 0, r: 0 } }, managers: [], dismissed: [],
  });
  assert.deepEqual(S.mergeReportPlans([plan(3, 1, 0), plan(5, 2, 1)]).glance.firstTouch, { analyzed: 8, voiced: 3, noRecord: 1 },
    "🔴 при 2+ командах лишились числа ПЕРШОЇ — вкладений обʼєкт не злито");

  const rp = readFileSync(FE("pages/dashboard/sections/ReportPlanSection.tsx"), "utf8");
  assert.match(rp, /<FirstTouchKpi c=\{m\.firstTouch\} \/>/, "🔴 картка менеджера без рядка «ціну названо»");
  assert.match(rp, /firstTouchStale\(data\.firstTouchMeta\?\.lastAnalyzedAt \?\? null, today\)/, "🔴 підсумок команди не каже, що бот мовчить");
  const tb = readFileSync(FE("pages/dashboard/sections/ReportTableSection.tsx"), "utf8");
  assert.match(tb, /case "firstTouch": \{\s*const l = firstTouchLabel\(m\.firstTouch\)/, "🔴 клітинка таблиці живе повз спільне правило станів");
});
