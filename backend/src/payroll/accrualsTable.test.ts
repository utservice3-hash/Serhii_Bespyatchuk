import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 💰 «Нарахування»: власна маржа, маржа команди й відсоток окремо (Тетяна прочитала 339 422 ₴ маржі команди в рядку тімліда як
 * його маржу; макет 27.11.2026, «роби» Романа). Тімлід отримує % від маржі команди, його власні угоди — лише ліміт авансу.
 * Гейти `#11331`, `#11333`, `#11334`.
 */
const FE = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "payroll", "finance");

async function loadGroups() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(path.join(FE, "accrualGroups.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`) as { accrualGroups: (l: object[]) => Array<{ key: string; kind: string; lead: { userId: string } | null; rows: Array<{ userId: string }> }> };
}

/**
 * #11334 — РУШІЙ (стан без `leadOwn`, як у пакеті): у тімліда `margin` = маржа команди (з неї 3 %), `ownMargin` = його власні угоди, і вони різні числа.
 * 🧨 Червоніє, якщо віддати власну маржу замість командної або прибрати `ownMargin`.
 */
test("#11334 ТІМЛІД: маржа команди — база відсотка команди, власна маржа — окремим полем", async () => {
  const { createPayroll } = await import("./engine/zarplata-engine.mjs");
  const base = { dept: "sales", startDate: "2024-01-01", birthday: null, official: [], leave: null, clientRates: [], adjustments: [] };
  const state = {
    now: "2026-11-25T18:00", liveMonth: "2026-11", closedMonth: "2026-10", settings: { birthday: { v2From: null } },
    employees: [
      { ...base, id: "L", name: "Тімлід", role: "lead", title: "Тім-лід", team: "t1", leadsTeam: "t1", terms: [{ from: "2000-01", rate: 25000 }] },
      { ...base, id: "A", name: "А", role: "manager", title: "Менеджер", team: "t1", terms: [{ from: "2000-01", level: "profi" }] },
      { ...base, id: "B", name: "Б", role: "manager", title: "Менеджер", team: "t1", terms: [{ from: "2000-01", level: "profi" }] },
    ],
    departments: { sales: { name: "Продажі", sales: true } }, teams: { t1: { name: "Т1" } }, plans: {}, kpi: {}, records: {}, advances: {}, clearances: {},
    deals: { A: { "2026-11": [{ id: "a", date: "2026-11-03", client: "К", margin: 200000, pay: "paid" }] }, B: { "2026-11": [{ id: "b", date: "2026-11-04", client: "Л", margin: 139422, pay: "paid" }] } },
    ownDeals: { L: { "2026-11": [{ id: "o", date: "2026-11-05", client: "М", margin: 41600, pay: "paid" }] } },
    responsibles: { ba: { id: "", name: "БА" }, acc: { id: "", name: "Бух" }, hr: { id: "", name: "HR" }, od: { id: "", name: "ОД" }, finance: [] },
  };
  const c = createPayroll(state as never).calc("L", "2026-11") as { margin: number; ownMargin: number; now: { pct: number; pctAmount: number } };
  assert.equal(c.margin, 339422, "🔴 база тімліда — сума маржі менеджерів команди");
  assert.equal(c.ownMargin, 41600, "🔴 власні угоди тімліда мають їхати окремим полем");
  assert.equal(c.now.pctAmount, 339422 * c.now.pct / 100, "🔴 відсоток — від маржі команди, власна в нього не входить");
});

/**
 * #11331 — ГРУПИ: кожен рядок рівно в одній групі; тімлід першим у своїй команді; люди без команди — «Поза командами» внизу.
 * Фікстура по обидва боки: команда з тімлідом, команда без тімліда, ставка без команди. 🧨 Червоніє, якщо загубити людей без
 * команди, задвоїти тімліда (team ≠ leadsTeam) або поставити його не першим.
 */
test("#11331 ГРУПИ «НАРАХУВАНЬ»: кожен рівно раз, тімлід першим, без команди — внизу", async () => {
  const { accrualGroups } = await loadGroups();
  const list = [
    { userId: "m2", name: "Яків", role: "manager", team: "t1", teamName: "Т1" },
    { userId: "L", name: "Тімлід", role: "lead", team: "x", leadsTeam: "t1", leadsTeamName: "Т1" },
    { userId: "m1", name: "Андрій", role: "manager", team: "t1", teamName: "Т1" },
    { userId: "m3", name: "Борис", role: "manager", team: "t2", teamName: "Т2" },
    { userId: "s", name: "Бухгалтер", role: "staff", team: null },
  ];
  const g = accrualGroups(list);
  const ids = g.flatMap((x) => x.rows.map((r) => r.userId)).sort();
  assert.deepEqual(ids, ["L", "m1", "m2", "m3", "s"], "🔴 кожен працівник — рівно в одній групі");
  const t1 = g.find((x) => x.key === "t1");
  assert.ok(t1 && t1.lead?.userId === "L", "🔴 тімлід веде свою команду за leadsTeam");
  assert.deepEqual(t1!.rows.map((r) => r.userId), ["L", "m1", "m2"], "🔴 тімлід першим, далі менеджери за імʼям");
  assert.equal(g.at(-1)!.kind, "other", "🔴 люди без команди — окремою групою внизу");
  assert.equal(g.find((x) => x.key === "t2")!.lead, null, "🔴 команда без тімліда — без тімліда");
});

/**
 * #11333 — ЕКРАН: у рядку тімліда «Власна» = `ownMargin` і під нею «% = сума» власних угод (Тетяна 27.11: тімлід отримує % від
 * свого результату за шкалою рівня), «Команди» = `margin`, мітки «маржа команди» і «+ власна маржа»; сума відсотка — команда + власні.
 * 🧨 Червоніє, якщо поміняти колонки місцями, повернути «у % не йде» або показати суму без власних.
 */
test("#11333 ЕКРАН «НАРАХУВАНЬ»: тімлід — власна маржа з % і сумою, маржа команди з міткою; сума % = команда + власні; групи", () => {
  const s = readFileSync(path.join(FE, "AccrualsTab.tsx"), "utf8");
  assert.match(s, /lead \? <span>\{money\(c\.ownMargin \?\? 0\)\}<div className="zp-hint">\{Number\(c\.now\.ownPct \?\? 0\) > 0 \? `\$\{pct\(c\.now\.ownPct\)\} = \$\{money\(c\.now\.ownAmount\)\}`/, "🔴 «Власна» тімліда — ownMargin з % і сумою");
  assert.doesNotMatch(s, /у % не йде/, "🔴 власні угоди тімліда тепер ідуть у %");
  assert.match(s, /<td className="r">\{lead \? <b>\{money\(c\.margin\)\}<\/b>/, "🔴 «Команди» тімліда — margin (база відсотка команди)");
  assert.match(s, /lead \? <><span className="zf-acc__chip zf-acc__chip--team">маржа команди<\/span>/, "🔴 мітка бази тімліда — «маржа команди»");
  assert.match(s, /<b>\{money\(Number\(c\.now\.pctAmount\) \+ Number\(c\.now\.ownAmount \?\? 0\)\)\}<\/b>/, "🔴 сума відсотка — команда + власні");
  assert.match(s, /\{accrualGroups\(list\)\.map\(/, "🔴 рядки згруповані за командами");
  assert.match(readFileSync(path.join(import.meta.dirname, "..", "..", "src", "payroll", "service.ts"), "utf8"), /leadsTeam: lt, leadsTeamName:/, "🔴 рядок несе команду, яку веде тімлід");
});
