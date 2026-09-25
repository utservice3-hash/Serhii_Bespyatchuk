import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";
import { tabsForPath } from "../auth/routeTab.js";

/**
 * #750…#752 — ПЛАНИ ЛІДГЕНІВ: ізоляція від продажних планів, межі роутів, ростер у `/leadgen-stats`.
 * Читається ДЖЕРЕЛО (не HTTP): гейти мусять триматись у звичайному `npm test`, без сервера й БД.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ").replace(/^\s*--.*$/gm, " ");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|sql)$/.test(e) && !/\.test\.ts$/.test(e)) acc.push(p);
  }
  return acc;
}

/** Файли коду, що згадують таблицю лідоген-планів; і чи ядро планів торкається продажних таблиць. */
export function planIsolationBreaks(files: Record<string, string>): string[] {
  const allowed = new Set(["core/leadgenPlans.ts", "db/schema.sql"]);
  const out: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const code = rel.endsWith(".sql") ? text : codeOf(text);
    if (/\bleadgen_plans\b/.test(code) && !allowed.has(rel)) out.push(`${rel}: читає/пише leadgen_plans — лідоген-план тече в чужий екран`);
  }
  const core = codeOf(files["core/leadgenPlans.ts"] ?? "");
  if (!core) out.push("core/leadgenPlans.ts: файла немає — перевіряти нічого");
  if (/\b(FROM|JOIN|INTO|UPDATE)\s+(plans|plan_formation)\b/i.test(core)) out.push("core/leadgenPlans.ts: торкається продажних plans/plan_formation");
  return out;
}

/**
 * #750 — ЛІДОГЕН-ПЛАН НЕ ПОТРАПЛЯЄ В ПРОДАЖНІ ЧИТАЧІ (рішення 6). Таблицю `leadgen_plans` знає ЛИШЕ
 * `core/leadgenPlans.ts` (і схема); ядро лідоген-планів не пише й не читає `plans`/`plan_formation`.
 * Тож plans-grid, `/report-plan`, `/kvp-report`, `/manager-report`, формування продажів і прогноз, які
 * читають лише `plans`/`plan_formation`, лідоген-метрики не побачать за побудовою. Простір — УСІ файли
 * `backend/src` (правило 12: від предмета, а не від слова).
 * 🧨 САБОТАЖ: у `routes/plans.ts` додати читання `leadgen_plans` → червоніє.
 */
test("#750 ІЗОЛЯЦІЯ: leadgen_plans знає лише ядро лідоген-планів, і воно не торкається plans/plan_formation", () => {
  const files: Record<string, string> = {};
  for (const f of walk(SRC)) files[path.relative(SRC, f).split(path.sep).join("/")] = readFileSync(f, "utf8");
  assert.ok(Object.keys(files).length > 200, `🔴 обхід знайшов ${Object.keys(files).length} файлів — шукали не там`);
  assert.ok(files["routes/plans.ts"] && files["routes/dashboard.ts"] && files["core/plans.ts"], "🔴 продажні читачі планів не в просторі перевірки");
  assert.match(files["db/schema.sql"], /CREATE TABLE IF NOT EXISTS leadgen_plans\b/, "🔴 таблиці немає — ізолювати нічого");
  assert.deepEqual(planIsolationBreaks(files), []);
  // CHECK продажного `plans` лідоген-метрик не приймає — тобто навіть ручний запис туди впаде.
  const plansDdl = /CREATE TABLE IF NOT EXISTS plans \(([\s\S]*?)\);/.exec(files["db/schema.sql"])?.[1] ?? "";
  assert.ok(plansDdl.includes("'payment_amount'"), "🔴 DDL plans не знайдено");
  assert.doesNotMatch(plansDdl, /'(leads|opr|quotes)'/, "🔴 CHECK plans розширено лідоген-метриками");
});

test("#750b 🪞 ДЗЕРКАЛО: підкладений продажний читач і запис ядра в plans — ловляться; коментар — ні", () => {
  const core = "pool.query(`SELECT 1 FROM leadgen_plans`)";
  assert.deepEqual(planIsolationBreaks({ "core/leadgenPlans.ts": core }), []);
  assert.notDeepEqual(planIsolationBreaks({ "core/leadgenPlans.ts": core, "routes/plans.ts": "q(`SELECT * FROM leadgen_plans`)" }), []);
  assert.notDeepEqual(planIsolationBreaks({ "core/leadgenPlans.ts": core + "\nq(`INSERT INTO plans (x) VALUES (1)`)" }), []);
  assert.notDeepEqual(planIsolationBreaks({ "core/leadgenPlans.ts": core + "\nq(`UPDATE plan_formation SET x=1`)" }), []);
  assert.deepEqual(planIsolationBreaks({ "core/leadgenPlans.ts": core, "routes/plans.ts": "// колись: leadgen_plans" }), []);
  assert.deepEqual(planIsolationBreaks({ "core/leadgenPlans.ts": core, "core/x.ts": "q(`FROM leadgen_plans_archive`)" }), [],
    "🔴 межа слова: сусідня таблиця зарахувалась би");
});

const DASH = read("routes/dashboard.ts");
function handler(method: "get" | "post", route: string): string {
  const i = DASH.indexOf(`dashboardRouter.${method}("${route}"`);
  assert.ok(i > 0, `🔴 обробника ${method.toUpperCase()} ${route} немає`);
  return DASH.slice(i, DASH.indexOf("\n});", i));
}
const firstStatement = (body: string) =>
  codeOf(body.slice(body.indexOf("=> {") + 4)).split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/**
 * #751 — ДОСТУП ЯК У ФОРМУВАННІ ПРОДАЖІВ: перегляд — як `/leadgen-stats`; подання — усі, крім hr і
 * менеджера; затвердження й повернення — лише адмін-рівень (deny включає team_lead). Кожен шлях —
 * вкладка `leadgen` ЯВНО (дефісного сусіда `pre()` не накриває).
 * 🧨 САБОТАЖ: прибрати `team_lead` з deny рядка `/leadgen-plans/approve` → червоніє.
 */
test("#751 МАТРИЦЯ Й ВКЛАДКА: плани лідгенів — рядки як у формуванні продажів, вкладка leadgen", () => {
  const row = (m: string, p: string) => {
    const rs = ACCESS_MATRIX.filter((r) => r.method === m && r.path === p);
    assert.equal(rs.length, 1, `🔴 рядок матриці ${m} ${p}: ${rs.length}`);
    return rs[0];
  };
  const base = row("GET", "/api/dashboard/leadgen-stats");
  const g = row("GET", "/api/dashboard/leadgen-plans");
  assert.deepEqual([...g.allow].sort(), [...base.allow].sort());
  assert.deepEqual([...g.deny].sort(), [...base.deny].sort());
  assert.deepEqual([...row("POST", "/api/dashboard/leadgen-plans/submit").deny].sort(), ["hr", "manager"]);
  for (const p of ["approve", "return"]) {
    const r = row("POST", `/api/dashboard/leadgen-plans/${p}`);
    assert.equal(r.cls, "deny-only");
    assert.deepEqual([...r.deny].sort(), ["hr", "manager", "team_lead"], `🔴 ${p}: тімлід не має права затверджувати/повертати`);
    // Дзеркало продажів: ті самі заборонені, що в /plans/formation/<p>.
    assert.deepEqual([...r.deny].sort(), [...row("POST", `/api/plans/formation/${p}`).deny].sort());
  }
  for (const p of ["", "/submit", "/approve", "/return"]) {
    assert.deepEqual(tabsForPath(`/api/dashboard/leadgen-plans${p}`), ["leadgen"], `🔴 leadgen-plans${p} без вкладкової межі`);
  }
  assert.equal(tabsForPath("/api/dashboard/leadgen-plansX"), null, "🔴 `pre()` накрив чужого сусіда — перевірка беззуба");
});

/**
 * #751b — ПЕРШИЙ ОПЕРАТОР: GET і submit — відмова менеджеру (403 раніше за 400); approve/return стоять за
 * `requireRole("admin")` (той самий засув, що в продажах), а submit — ще й `mayEverSubmitLeadgenPlan` ДО розбору тіла.
 * 🧨 САБОТАЖ: у `/leadgen-plans/approve` прибрати `requireRole("admin"), ` → червоніє.
 */
test("#751b ПЕРШИЙ ОПЕРАТОР і засув адміна на затвердженні/поверненні", () => {
  for (const [m, r] of [["get", "/leadgen-plans"], ["post", "/leadgen-plans/submit"]] as const) {
    assert.match(firstStatement(handler(m, r)), /^if \(req\.auth!\.role === "manager"\) return res\.status\(403\)/, `🔴 ${r}: перший оператор не відмова менеджеру`);
  }
  const sub = codeOf(handler("post", "/leadgen-plans/submit"));
  assert.ok(sub.indexOf("mayEverSubmitLeadgenPlan(") > 0 && sub.indexOf("mayEverSubmitLeadgenPlan(") < sub.indexOf("parseLeadgenSubmit("),
    "🔴 роль без права подання доходить до розбору тіла");
  assert.ok(sub.indexOf("leadgenSubmitRefusal(") < sub.indexOf("submitLeadgenPlan("), "🔴 запис раніше за перевірку межі");
  for (const r of ["/leadgen-plans/approve", "/leadgen-plans/return"]) {
    assert.match(handler("post", r), new RegExp(`dashboardRouter\\.post\\("${r.replace(/\//g, "\\/")}", requireRole\\("admin"\\), async`),
      `🔴 ${r} без засуву requireRole("admin")`);
  }
});

/**
 * #752 — `/leadgen-stats` БУДУЄ РОСТЕР ЧИСТОЮ `leadgenRosterView` зі скоупом `teamId` (тим самим, що ріже
 * гроші) і віддає `others`; свого фільтра рядків у роуті немає. 🧨 САБОТАЖ: повернути
 * `const rows = teamId == null ? stats.rows : …` → червоніє.
 */
test("#752 /leadgen-stats: ростер — з leadgenRosterView, «Інші» у відповіді, план — лише рядкам команди", () => {
  const b = codeOf(handler("get", "/leadgen-stats"));
  assert.match(b, /\bconst view = leadgenRosterView\(stats\.rows, members, teamId, zeroLeadgenRow\);/);
  assert.match(b, /\bconst rows = view\.rows;/);
  assert.match(b, /\bconst totals = view\.totals;/);
  assert.match(b, /others: view\.others/);
  assert.doesNotMatch(b, /stats\.rows\.filter\(/, "🔴 роут знову сам фільтрує рядки — друге правило ростера");
  assert.match(b, /approvedLeadgenPlans\(rows\.map\(/, "🔴 план тягнеться не для рядків команди");
});
