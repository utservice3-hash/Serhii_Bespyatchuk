import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sameWindows, deltaVsAvg, workFlags, NO_WORK_DAYS } from "./repeatScreenRules.js";

/**
 * 👥 «ПОСТІЙНІ КЛІЄНТИ» ПІСЛЯ TOP WEEKLY 12.10 (задача 5609, ТЗ Юлі 12.10.2026, регламент ред. 2): картки, що фільтрують
 * таблицю, «плюс / мінус до середнього», «Без роботи», нові колонки, закріплена шапка, без планування.
 */
const FE = (rel: string): string => fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url));
const FE_SRC = (rel: string) => readFileSync(FE(rel), "utf8");
const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url).href.replace("/dist/", "/src/")), "utf8");

async function transpile(rel: string): Promise<string> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE_SRC(rel), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return `data:text/javascript,${encodeURIComponent(js)}`;
}

test("#1710 ВІКНА ПОРІВНЯННЯ: той самий відрізок місяця в трьох попередніх; 31-ше — до кінця коротшого місяця; закритий місяць — повний", () => {
  const w = sameWindows("2026-10", "2026-10-14");
  assert.equal(w.partial, true);
  assert.deepEqual(w.prev, [{ from: "2026-09-01", to: "2026-09-14" }, { from: "2026-08-01", to: "2026-08-14" }, { from: "2026-07-01", to: "2026-07-14" }],
    "🔴 «до середнього» порівнює не ті самі дні попередніх місяців");
  assert.deepEqual(w.before, { from: "2026-07-01", to: "2026-09-30" }, "🔴 «замовляли раніше» — не три попередні повні місяці");
  // 31 березня: лютий має 28 днів — вікно до кінця лютого, а не в березень.
  assert.deepEqual(sameWindows("2027-03", "2027-03-31").prev[0], { from: "2027-02-01", to: "2027-02-28" }, "🔴 31-ше перескочило в наступний місяць");
  // Закритий місяць екрана — повний проти трьох повних.
  const past = sameWindows("2026-09", "2026-10-14");
  assert.equal(past.partial, false);
  assert.deepEqual(past.prev[0], { from: "2026-08-01", to: "2026-08-31" }, "🔴 минулий місяць порівнюється частиною");
  assert.deepEqual(deltaVsAvg(30_000, [10_000, 20_000, 0]), { avg: 10_000, delta: 20_000 }, "🔴 місяць без замовлень випав із середнього — середнє завищене");
  assert.deepEqual(deltaVsAvg(0, [9_000, 9_000, 9_000]), { avg: 9_000, delta: -9_000 });
});

test("#1710b БЕЗ РОБОТИ / БЕЗ ЗАДАЧІ / ПРОСТРОЧЕНА: межа 30 днів по обидва боки, крок із датою від сьогодні рятує, минулий — ні", () => {
  const today = "2026-10-14";
  const base = { lastTalk: null, lastManual: null, stepOpen: false, stepDue: null, taskOpen: false, taskDue: null, today };
  assert.equal(NO_WORK_DAYS, 30);
  assert.deepEqual(workFlags(base), { noWork: true, noTask: true, overdue: false }, "🔴 клієнт без жодного контакту не «без роботи»");
  assert.equal(workFlags({ ...base, lastTalk: "2026-09-14" }).noWork, false, "🔴 розмова рівно 30 днів тому вже рахується як «без роботи»");
  assert.equal(workFlags({ ...base, lastTalk: "2026-09-13" }).noWork, true, "🔴 розмова 31 день тому ще рятує від «без роботи»");
  assert.equal(workFlags({ ...base, lastManual: "2026-10-10T09:00:00Z" }).noWork, false, "🔴 переписка у Viber/Telegram не рахується контактом");
  assert.deepEqual(workFlags({ ...base, stepOpen: true, stepDue: "2026-10-14" }), { noWork: false, noTask: false, overdue: false },
    "🔴 наступний крок на сьогодні не рятує від «без роботи»");
  assert.deepEqual(workFlags({ ...base, stepOpen: true, stepDue: "2026-10-13" }), { noWork: true, noTask: false, overdue: true },
    "🔴 прострочений крок рятує від «без роботи» або не рахується простроченим");
  assert.deepEqual(workFlags({ ...base, stepOpen: true, stepDue: null }), { noWork: true, noTask: false, overdue: false }, "🔴 крок без дати вважається кроком із датою");
  assert.deepEqual(workFlags({ ...base, taskOpen: true, taskDue: "2026-10-20" }), { noWork: false, noTask: false, overdue: false }, "🔴 задача в Задачнику не рахується задачею");
  assert.equal(workFlags({ ...base, taskOpen: true, taskDue: "2026-10-01" }).overdue, true);
});

interface Cards {
  CARD_MATCH: Record<string, (r: unknown) => boolean>;
  cardStats: (rows: readonly unknown[]) => { all: number; ordered: number; notOrdered: number; noWork: number; noWorkOnly: number; noTaskOnly: number; overdue: number; more: { n: number; sum: number }; less: { n: number; sum: number }; delta: number };
  toggleCard: (cur: string, k: string) => string;
  signedUah: (v: number) => string;
}
const r = (o: { t?: boolean; b?: boolean; d?: number; nw?: boolean; nt?: boolean; ov?: boolean }) => ({
  orderedThisMonth: !!o.t, orderedBefore: !!o.b, delta: o.d ?? 0, work: { noWork: !!o.nw, noTask: !!o.nt, overdue: !!o.ov } });

test("#1710c КАРТКИ: число в картці == рядкам після кліку; «± до середнього» = Σ більше − Σ менше; без роботи разом із без задачі", async () => {
  const c = await import(await transpile("pages/dashboard/clientsCards.ts")) as Cards;
  const rows = [r({ t: true, b: true, d: 5000 }), r({ b: true, d: -9000, nw: true, nt: true }), r({ b: true, d: -1000, ov: true }),
    r({ t: true, d: 2000, nt: true }), r({ d: 0, nw: true }), r({})];
  const st = c.cardStats(rows);
  for (const [k, n] of [["all", st.all], ["ordered", st.ordered], ["notOrdered", st.notOrdered], ["noWork", st.noWork], ["overdue", st.overdue],
    ["more", st.more.n], ["less", st.less.n]] as const) {
    assert.equal(rows.filter(c.CARD_MATCH[k]).length, n, `🔴 картка «${k}»: число ≠ рядкам після кліку`);
  }
  assert.deepEqual([st.ordered, st.notOrdered], [2, 2], "🔴 «не замовили» — не ті, хто замовляв раніше, а цього місяця ні");
  assert.deepEqual([st.noWork, st.noWorkOnly, st.noTaskOnly], [3, 2, 2], "🔴 «Без роботи» не об'єднано з «Без задачі»");
  assert.equal(st.delta, st.more.sum + st.less.sum, "🔴 «± до середнього» ≠ Σ «купили більше» − Σ «купили менше»");
  assert.deepEqual([st.more.sum, st.less.sum, st.delta], [7000, -10_000, -3000]);
  assert.equal(c.toggleCard("noWork", "noWork"), "all", "🔴 повторний клік по картці не знімає фільтр");
  assert.equal(c.toggleCard("noWork", "ordered"), "ordered");
  assert.match(c.signedUah(-3000), /^−3\s000 ₴$/u, "🔴 мінус у картці зник");
  assert.match(c.signedUah(1500), /^\+1\s500 ₴$/u, "🔴 плюс у картці зник");
  assert.equal(c.signedUah(0), "0 ₴");
});

test("#1710d ЕКРАН ЗА МАКЕТОМ: картки фільтрують тим самим правилом; пласка таблиця з колонками макета й ТЗ; плану немає; «Без роботи» блоком зверху; шапка, «Робота» й «Клієнт» закріплені", () => {
  const src = FE_SRC("pages/dashboard/sections/ClientPlansSection.tsx");
  assert.match(src, /const cs = cardStats\(baseRows\);\s*const rows = baseRows\.filter\(CARD_MATCH\[card\]\);/,
    "🔴 картки рахуються не з тих рядків, що фільтрує клік");
  for (const k of ["ordered", "notOrdered", "noWork", "overdue"]) assert.match(src, new RegExp(`setCard\\(toggleCard\\(card, "${k}"\\)\\)`), `🔴 картка «${k}» не фільтрує таблицю`);
  assert.match(src, /setCard\(toggleCard\(card, k\)\)/, "🔴 «купили більше / менше» не фільтрують таблицю");
  // Прибране за ТЗ п.4 і п.6 (регламент ред. 2: планів немає) і ієрархія «команда → менеджер» (макет — плаский список).
  for (const gone of [/План \(міс\)/, /Затвердити подані/, /approveClientPlans|submitClientPlans|saveClientPlan|returnClientPlan/, /weeksOpen/,
    /Іде у план менеджера/, /t\.prevMonth/, /function GroupRow|openTeams|levelTotals/])
    assert.doesNotMatch(src, gone, `🔴 на екрані лишилось старе: ${String(gone)}`);
  // Колонки макета + три колонки ТЗ п.5, у порядку макета; періодичність — поруч з «Останнє замовлення».
  const cols = [...src.slice(src.indexOf("const COLS:"), src.indexOf("const COL_COUNT")).matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, ["Робота", "Клієнт", "Менеджер", "Сегмент і стан", "Останнє замовлення", "Періодичність", "Остання розмова (Ringostat)",
    "Історія · середнє/міс", "Факт з рахунку", "Всього грошей", "Замовляв цього міс.", "Маржа 6 міс", "Що не так", "Задача"], "🔴 колонки не як у макеті й ТЗ");
  assert.match(src, /\{COLS\.map\(\(col, i\) => \(\s*<th key=\{col\.key\}/, "🔴 шапка таблиці не з того самого переліку колонок");
  const rs = src.indexOf("<tr style={{ background: risk");
  const row = src.slice(rs, src.indexOf("</tr>", rs));
  assert.ok(rs > 0, "🔴 гейт втратив предмет: рядка клієнта не знайдено");
  assert.equal((row.match(/<td[ >]/g) ?? []).length, cols.length, "🔴 у рядку клієнта не стільки клітинок, скільки колонок у шапці");
  assert.match(src, /const COL_COUNT = COLS\.length;/, "🔴 colSpan плеєра й картки не дорівнює кількості колонок");
  assert.doesNotMatch(src, /colSpan=\{\d+\}/, "🔴 colSpan числом — розійдеться з кількістю колонок");
  // Закріплення (п.6): шапка зверху, «Робота» й «Клієнт» зліва — і в шапці, і в рядку.
  assert.match(src, /const STICKY_TH: React\.CSSProperties = \{ position: "sticky", top: 0/, "🔴 шапка таблиці не закріплена");
  assert.match(src, /overflow: "auto", maxHeight: "calc\(100vh - 140px\)"/, "🔴 прокрутка не всередині таблиці — sticky-шапка не триматиметься");
  assert.match(row, /STICKY_COL\(0, W_WORK\)[\s\S]*STICKY_COL\(W_WORK, W_NAME\)[\s\S]*\{c\.clientName\}/, "🔴 назва клієнта не закріплена зліва");
  // «Без роботи» — окремим блоком зверху, з червоною смугою (макет).
  assert.ok(src.indexOf("{noWorkRows.map(renderRow)}") > 0 && src.indexOf("{noWorkRows.map(renderRow)}") < src.indexOf("{workRows.map(renderRow)}"),
    "🔴 «Без роботи» не окремим блоком над «В роботі»");
  assert.match(src, /boxShadow: c\.work\.noWork \? "inset 4px 0 0 #dc2626"/, "🔴 немає червоної смуги «Без роботи»");
  // Панель фільтрів макета і швидкі фільтри; тімліду — одразу своя команда.
  for (const t of ["Пошук: клієнт, інша назва, менеджер, коментар", "Усі команди", "Усі сегменти", "Будь-який стан", "Будь-яка оплата", "Скинути", "Вивантажити CSV",
    "Без роботи", "Без задачі", "ВІП 14+ без задачі", "Задача прострочена", "ВІП спить 14+", "Сплячі", "Без розмови 30+ днів", "Стоп: дебіторка", "Без замовлень 30+ днів"])
    assert.ok(src.includes(t), `🔴 немає «${t}» з макета`);
  assert.match(src, /const \[fTeam, setFTeam\] = useState<number \| "">\(\(\) => \(auth\.role === "team_lead" && auth\.teamId != null \? auth\.teamId : ""\)\);/,
    "🔴 тімлід відкриває екран з усіма командами замість своєї");
});

test("#1710e СЕРВЕР: вікна, середнє й позначки — з правил ядра; гроші — «з рахунку» в тому самому скоупі", () => {
  const dash = SRC("routes/dashboard.ts");
  const start = dash.indexOf('dashboardRouter.get("/client-plans"');
  const body = dash.slice(start, dash.indexOf("\ndashboardRouter.", start + 10));
  assert.match(body, /const win = repeatScreenRules\.sameWindows\(monthStr, kyivToday\(\)\);/, "🔴 вікна порівняння рахуються не правилом ядра");
  assert.match(body, /win\.prev\.map\(\(w\) => money\.fromInvoiceByClientKey\(winScope\(w\)\)\)/, "🔴 середнє — не «з рахунку» або не по трьох вікнах");
  assert.match(body, /money\.fromInvoiceByClientKey\(winScope\(win\.before\)\)/, "🔴 «замовляли раніше» не з тих самих грошей");
  assert.match(body, /managerId: managerId \?\? undefined, teamId: teamId \?\? undefined \}\);/, "🔴 вікна поза скоупом перегляду — менеджер побачив би чужі гроші");
  assert.match(body, /repeatScreenRules\.deltaVsAvg\(fact, prevByKey\.map/, "🔴 різниця з середнім рахується не правилом ядра");
  assert.match(body, /work: repeatScreenRules\.workFlags\(\{/, "🔴 «Без роботи» рахується не правилом ядра");
  assert.match(body, /orderedThisMonth: \(ordersThisMonth\.get\(c\.client_key\) \?\? 0\) > 0,/, "🔴 «замовляв цього місяця» — не за угодами з рахунку");
  // Історія за 6 міс і «середнє/міс» (макет: «гроші з рахунку по місяцях») — той самий вид грошей і скоуп, що й факт.
  assert.match(body, /const histInv = await money\.fromInvoiceByClientBucket\(histScope, "month"\);/, "🔴 історія в рядку — не «з рахунку»");
  assert.match(body, /avg3: \(\(\) => \{ const a = histInvByKey\.get\(c\.client_key\); return a \? Math\.round\(\(a\[2\] \+ a\[3\] \+ a\[4\]\) \/ 3\) : 0; \}\)\(\),/,
    "🔴 «середнє/міс» — не за три повні місяці перед місяцем екрана");
});
