import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🚦 «З КИМ ГОВОРИТИ»: ПРАВКИ ІЗ ЗУСТРІЧІ ПО ДАШБОРДУ 25.11.2026 (стратегічна задача 11216).
 *
 * Правила відбору списку — чистий модуль фронту `clientLeadView.ts`; гейти його ТРАНСПІЛЮЮТЬ І ВИКОНУЮТЬ (прийом
 * `#9225`), а проводку екрана звіряють за джерелом: модуль нічого не вартий, якщо екран його не кличе.
 */
const FE = (p: string) => fileURLToPath(new URL(`../../../frontend/src/pages/dashboard/${p}`, import.meta.url));
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

type Row = { id: string; lead: { color: "green" | "yellow" | "red"; problem?: unknown; works: { yes: boolean } } };
interface View {
  leadGroupOf: (r: Row) => string;
  pickRows: (rows: readonly Row[], pick: string | null) => Row[];
  applyLeadFilter: (rows: readonly Row[], f: Record<string, unknown>) => Row[];
  leadFilterActive: (f: Record<string, unknown>) => boolean;
  workSplit: (rows: readonly Row[]) => { yes: number; no: number; all: number };
  DEFAULT_LEAD_FILTER: Record<string, unknown>;
}
async function loadView(): Promise<View> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE("clientLeadView.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`) as View;
}
const row = (id: string, color: Row["lead"]["color"], works: boolean, extra: Record<string, unknown> = {}): Row =>
  ({ id, lead: { color, works: { yes: works }, ...(extra.lead as object ?? {}) }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "lead")) }) as Row;
const ids = (rows: readonly Row[]) => rows.map((r) => r.id).join(",");

// Фікстура: по обидва боки кожної межі — колір × «працюють», плюс проблемний (переважає свій червоний колір).
const FIXTURE: Row[] = [
  row("g1", "green", true), row("g2", "green", false),
  row("y1", "yellow", true), row("y2", "yellow", false), row("y3", "yellow", false),
  row("r1", "red", true), row("r2", "red", false),
  row("p1", "red", false, { lead: { problem: { reason: "conflict" } } }),
];

/**
 * #11227 🪞 — ОБРАНИЙ КОЛІР = УСІ КЛІЄНТИ ЦЬОГО КОЛЬОРУ В ОХОПЛЕННІ, А «ПРАЦЮЮТЬ / РОБОТИ НЕМАЄ» ДІЛИТЬ ЇХ БЕЗ ЗАЛИШКУ
 * (зустріч 25.11.2026: «нажав красні — випали всі красні всіх менеджерів», «з 274 червоних хто в роботі»).
 * Проблемний — своя група, і в «червоні» не потрапляє, хоч колір у нього червоний. Без вибору — рядки як є.
 * 🧨 Червоніє, якщо вибір кольору загубить чи домішає рядок, проблемний потрапить у колір, або частини «працюють» і
 * «роботи немає» не складуться в набір.
 */
test("#11227 🪞 КОЛІР КЛІКАБЕЛЬНИЙ: вибір дає рівно цю групу, проблемні окремо; «працюють» + «роботи немає» = увесь набір", async () => {
  const v = await loadView();
  assert.equal(ids(v.pickRows(FIXTURE, "red")), "r1,r2", "🔴 «червоні» — не рівно червоні без проблемного");
  assert.equal(ids(v.pickRows(FIXTURE, "yellow")), "y1,y2,y3", "🔴 «жовті» — не рівно жовті");
  assert.equal(ids(v.pickRows(FIXTURE, "green")), "g1,g2", "🔴 «зелені» — не рівно зелені");
  assert.equal(ids(v.pickRows(FIXTURE, "problem")), "p1", "🔴 проблемний не окремою групою");
  assert.equal(ids(v.pickRows(FIXTURE, null)), ids(FIXTURE), "🔴 без вибору кольору рядки змінились");
  // Кожен рядок рівно в одній групі: Σ груп = набір.
  const groups = ["green", "yellow", "red", "problem"].map((g) => v.pickRows(FIXTURE, g).length);
  assert.equal(groups.reduce((a, b) => a + b, 0), FIXTURE.length, "🔴 Σ груп ≠ набір — рядок загублено або пораховано двічі");
  assert.equal(v.leadGroupOf(FIXTURE[7]), "problem", "🔴 позначка «Проблемний» не переважає колір");

  const red = v.pickRows(FIXTURE, "red");
  assert.equal(ids(v.applyLeadFilter(red, { ...v.DEFAULT_LEAD_FILTER, work: "yes" })), "r1", "🔴 «працюють» показує не тих, з ким працюють");
  assert.equal(ids(v.applyLeadFilter(red, { ...v.DEFAULT_LEAD_FILTER, work: "no" })), "r2", "🔴 «роботи немає» показує не тих");
  assert.equal(ids(v.applyLeadFilter(red, v.DEFAULT_LEAD_FILTER)), "r1,r2", "🔴 типовий фільтр щось відсікає");
  for (const g of ["green", "yellow", "red", "problem"]) {
    const rows = v.pickRows(FIXTURE, g), ws = v.workSplit(rows);
    assert.equal(ws.yes + ws.no, rows.length, `🔴 ${g}: «працюють» + «роботи немає» ≠ група`);
    assert.equal(ws.all, rows.length);
    assert.equal(v.applyLeadFilter(rows, { ...v.DEFAULT_LEAD_FILTER, work: "yes" }).length, ws.yes, `🔴 ${g}: число на кнопці «працюють» ≠ рядкам списку`);
    assert.equal(v.applyLeadFilter(rows, { ...v.DEFAULT_LEAD_FILTER, work: "no" }).length, ws.no, `🔴 ${g}: число на кнопці «роботи немає» ≠ рядкам списку`);
  }
  assert.deepEqual(v.workSplit(v.pickRows(FIXTURE, "yellow")), { yes: 1, no: 2, all: 3 });
  assert.equal(v.leadFilterActive(v.DEFAULT_LEAD_FILTER), false, "🔴 типовий фільтр вважається увімкненим");
  assert.equal(v.leadFilterActive({ ...v.DEFAULT_LEAD_FILTER, work: "no" }), true, "🔴 увімкнений фільтр не видно");
});

/**
 * #11227b — ЕКРАН КЛИЧЕ ПРАВИЛО: колір натискається в лічильнику і в таблицях рівня; з обраним кольором список будується
 * з УСЬОГО охоплення (компанія / команда / менеджер), а не лише з клієнтів менеджера; у рядку видно менеджера; перехід між
 * рівнями — через `go` (адреса), не повз нього.
 * 🧨 Червоніє, якщо список з кольором знову братиметься лише з менеджера, або колір перестане бути кнопкою.
 */
test("#11227b ЕКРАН: колір — кнопка в лічильнику й таблицях рівня; список кольору — з усього охоплення; фільтр «робота» над списком", () => {
  const lead = codeOnly(readFileSync(FE("sections/ClientLeadSection.tsx"), "utf8"));
  assert.match(lead, /from "\.\.\/clientLeadView";/, "🔴 екран не бере правило відбору з clientLeadView");
  assert.match(lead, /const baseRows = pick != null \? pickRows\(scopeRows, pick\) : mgrRows \?\? \[\];/,
    "🔴 з обраним кольором список не з усього охоплення (scopeRows) — «всі червоні всіх менеджерів» не вийде");
  assert.match(lead, /const listRows = applyLeadFilter\(baseRows, filter\);/, "🔴 список не проходить фільтр");
  assert.match(lead, /const showClients = isManager \|\| mgrEff != null \|\| pick != null;/, "🔴 з обраним кольором на рівні компанії чи команди списку немає");
  assert.match(lead, /<Counters rows=\{scopeRows\} month=\{month\} pick=\{pick\} onPick=\{togglePick\} \/>/, "🔴 лічильник не вміє обирати колір");
  for (const c of ["green", "yellow", "red"]) {
    assert.match(lead, new RegExp(`<ColorPick color="${c}" n=\\{s\\.${c}\\} pick=\\{pick\\} onPick=\\{onPick\\} />`), `🔴 у лічильнику ${c} — не кнопка`);
    assert.match(lead, new RegExp(`\\{num\\(g\\.id, "${c}", s\\.${c}, `), `🔴 у таблиці рівня ${c} — не кнопка`);
  }
  assert.equal((lead.match(/onPickColor=\{\(id, color\) => \{ setPick\(color\); go\(\{ team: /g) ?? []).length, 2,
    "🔴 клік по кольору в таблиці команд і менеджерів не веде в список цього кольору через go");
  assert.match(lead, /\.filter\(\(k\) => \(pick != null \? k === pick : /, "🔴 з обраним кольором показуються й інші групи");
  assert.match(lead, /\.map\(\(k\) => group\(k, listRows\.filter\(/, "🔴 групи будуються не з відфільтрованого списку");
  assert.match(lead, /const ws = workSplit\(baseRows\);/, "🔴 числа «працюють / роботи немає» не з набору, який у списку");
  assert.match(lead, /\{!mgrRows && <div style=\{grey\}>\{c\.managerName\}/, "🔴 у рядку зведеного списку не видно менеджера");
  assert.doesNotMatch(lead, /onChange=\{\(e\) => set(Team|Mgr)\(/, "🔴 вибір команди / менеджера міняє рівень повз go — без запису в адресу");
});

/**
 * #11218 🪞 — ПЕРІОДИЧНІСТЬ ЗАМОВЛЕНЬ ЗА 6 МІСЯЦІВ У РЯДКУ (зустріч 25.11.2026). Число замовлень і гроші «з рахунку»
 * розкладаються по вікну місяців одним проходом по тих самих кошиках ядра: два кошики одного місяця складаються, кошик
 * поза вікном і клієнт поза списком не рахуються, порожній місяць — нуль (дірка в ритмі), а Σ стовпчиків = числу угод у вікні.
 * 🧨 Червоніє, якщо місяць зʼїде на сусідній, кошик поза вікном потрапить у графік, або кількість і гроші розійдуться.
 */
test("#11218 🪞 ПЕРІОДИЧНІСТЬ ЗА 6 МІС: замовлення й гроші з одних кошиків; поза вікном і поза списком — ні; дірка — нуль", async () => {
  const { foldOrderHistory } = await import("./clientOrderHistory.js");
  const months = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
  const rows = [
    { clientKey: "a", bucket: "2026-06-01", revenue: 1000, deals: 2 },   // перший місяць вікна — межа зліва, у вікні
    { clientKey: "a", bucket: "2026-05-01", revenue: 9999, deals: 9 },   // місяць перед вікном — поза вікном
    { clientKey: "a", bucket: "2026-09-01", revenue: 500, deals: 1 },
    { clientKey: "a", bucket: "2026-09-01", revenue: 300, deals: 2 },    // другий кошик того самого місяця — складається
    { clientKey: "a", bucket: "2026-11-01", revenue: -200, deals: 1 },   // останній місяць вікна; сторно — як є
    { clientKey: "a", bucket: "2026-12-01", revenue: 7777, deals: 7 },   // місяць після вікна — поза вікном
    { clientKey: "b", bucket: "2026-10-01", revenue: 40, deals: 4 },
    { clientKey: "чужий", bucket: "2026-10-01", revenue: 1, deals: 1 },  // не в списку екрана
  ];
  const h = foldOrderHistory(rows, months, (k) => k !== "чужий");
  assert.deepEqual(h.deals.get("a"), [2, 0, 0, 3, 0, 1], "🔴 замовлення клієнта по місяцях не ті: зсув, кошик поза вікном або не складено");
  assert.deepEqual(h.money.get("a"), [1000, 0, 0, 800, 0, -200], "🔴 гроші по місяцях не з тих самих кошиків, що замовлення");
  assert.deepEqual(h.deals.get("b"), [0, 0, 0, 0, 4, 0]);
  assert.equal(h.deals.has("чужий"), false, "🔴 клієнт поза списком екрана потрапив в історію");
  assert.equal(h.money.has("чужий"), false);
  // Σ стовпчиків = Σ угод кошиків У ВІКНІ для клієнтів списку — нічого не загублено й не додано.
  const inWin = rows.filter((r) => r.clientKey !== "чужий" && months.includes(r.bucket.slice(0, 7)));
  const sum = (m: Map<string, number[]>) => [...m.values()].flat().reduce((a, b) => a + b, 0);
  assert.equal(sum(h.deals), inWin.reduce((a, r) => a + r.deals, 0), "🔴 Σ стовпчиків ≠ числу угод у вікні");
  assert.equal(sum(h.money), inWin.reduce((a, r) => a + r.revenue, 0), "🔴 Σ грошей ≠ сумі кошиків у вікні");
  assert.deepEqual([...foldOrderHistory([], months, () => true).deals.keys()], [], "🔴 з порожнього входу зʼявилась історія");

  // Проводка: рядок несе обидва масиви з одного виклику ядра «з рахунку», а екран малює графік із них.
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const dash = codeOnly(readFileSync(`${ROOT}backend/src/routes/dashboard.ts`, "utf8"));
  assert.match(dash, /const \{ money: histInvByKey, deals: histInvDealsByKey \} = clientOrderHistory\.foldOrderHistory\(histInv, histMonths, \(k\) => keySet\.has\(k\)\);/,
    "🔴 гроші й кількість у рядку — не з одного розкладання кошиків «з рахунку»");
  assert.match(dash, /historyInvDeals: histInvDealsByKey\.get\(c\.client_key\) \?\? histMonths\.map\(\(\) => 0\),/, "🔴 рядок не несе кількість замовлень по місяцях");
  const lead = codeOnly(readFileSync(FE("sections/ClientLeadSection.tsx"), "utf8"));
  assert.match(lead, /\{c\.historyInvDeals && <OrderSpark counts=\{c\.historyInvDeals\} money=\{c\.historyInv\} months=\{data\.historyMonths\} \/>\}/,
    "🔴 у рядку «З ким говорити» немає графіка періодичності або він не з місяців сервера");
});
