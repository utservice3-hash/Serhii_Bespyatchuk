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
  talkMatches: (r: Row, t: "all" | "none" | number) => boolean;
  sortLead: (rows: readonly Row[], by: "money" | "talk" | "order") => Row[];
  TALK_AGE_DAYS: readonly number[];
  noPhone: (r: Row) => boolean;
  profileOpen: (r: Row) => boolean;
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
/**
 * #11227c — РЯДОК СПИСКУ НЕ РОЗПИРАЄ ТАБЛИЦЮ ЗА КРАЙ ЕКРАНА (знайдено на проді 26.11.2026 одразу після викату 11216).
 * Список кольору по всій компанії (11227) зводить в одну таблицю клієнтів усіх менеджерів, і серед них є назва
 * одним «словом» на сотні символів (пошти й номери без пробілів): колонка «Клієнт» ставала 612 пікселів, таблиця 1692
 * при екрані 1217, і «Остання розмова» та «Задача» їхали за край. Друге: чип «працюють · оплата у Виписці 24.11»
 * не переносився і тримав свою колонку на 252.
 * Гейт читає джерело (вимірювати пікселі тут нічим): назва мусить мати перенос будь-де, чип роботи — дозвіл на перенос.
 */
test("#11227c ШИРИНА СПИСКУ: назва клієнта переноситься будь-де, чип роботи не тримає колонку — рядок не розпирає таблицю", () => {
  const src = codeOnly(readFileSync(FE("sections/ClientLeadSection.tsx"), "utf8"));
  assert.match(src, /<div style=\{\{ fontWeight: 700, overflowWrap: "anywhere" \}\}>\{c\.clientName\}<\/div>/,
    "🔴 назва клієнта без переносу будь-де: одна довга назва без пробілів розпирає таблицю за край екрана");
  assert.match(src, /const WRAP_CHIP = \{ whiteSpace: "normal"/, "🔴 немає стилю чипа, якому можна переноситись");
  const work = src.match(/\{L\.problem\s*\?[\s\S]*?<\/td>/)?.[0] ?? "";
  assert.ok(work.includes("✅ працюють"), "🔴 перевіряти нічого: клітинку «Робота з клієнтом» не знайдено");
  const chips = [...work.matchAll(/<span style=\{([^>]*?)\} title=/g)].map((m) => m[1]);
  assert.equal(chips.length, 2, `🔴 у клітинці «Робота з клієнтом» очікував два чипи («працюють» і «роботи немає»), знайшов ${chips.length}`);
  for (const c of chips) assert.ok(c.includes("...WRAP_CHIP"), `🔴 чип роботи не переноситься і тримає колонку широкою: ${c}`);
});

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

/**
 * #11228 🪞 — РИТМ КЛІЄНТА В РЯДКУ: «не замовляв N дн.» поруч зі «зазвичай раз на ~X дн.», і хто пропустив свій ритм —
 * видно й відбирається (зустріч 25.11.2026). Правило те саме, що колір (`pastOwnRhythm`): 31-й день при інтервалі 30 —
 * пропустив на 1 день, 30-й — ще ні; ВІП з інтервалом 0 — лише після мінімуму 14 днів; без історії інтервал невідомий
 * і сигналу немає; сезонний не в сезоні ритму не пропускає. Хто «пропустив ритм» — той ніколи не зелений.
 * 🧨 Червоніє, якщо межа зʼїде на день, невідомий ритм дасть сигнал, або ознака розійдеться з кольором.
 */
test("#11228 🪞 РИТМ У РЯДКУ: межа інтервалу по обидва боки, мінімум 14 днів, невідомий ритм без сигналу; пропустив ритм — не зелений; фільтр", async () => {
  const { rhythmOf, colorOf } = await import("./clientLeadRules.js");
  assert.deepEqual(rhythmOf(31, 30, false), { usualDays: 30, over: true, overDays: 1 }, "🔴 31-й день при інтервалі 30 — не «пропустив на 1 день»");
  assert.deepEqual(rhythmOf(30, 30, false), { usualDays: 30, over: false, overDays: null }, "🔴 рівно на інтервалі — уже «пропустив»");
  assert.deepEqual(rhythmOf(15, 0, false), { usualDays: 0, over: true, overDays: 15 }, "🔴 ВІП з інтервалом 0: 15-й день не «пропустив»");
  assert.deepEqual(rhythmOf(14, 0, false), { usualDays: 0, over: false, overDays: null }, "🔴 мінімум 14 днів не діє — ВІП «пропускає ритм» одразу");
  assert.deepEqual(rhythmOf(200, null, false), { usualDays: null, over: false, overDays: null }, "🔴 невідомий ритм дає сигнал");
  assert.deepEqual(rhythmOf(200, undefined, false), { usualDays: null, over: false, overDays: null });
  assert.deepEqual(rhythmOf(null, 30, false), { usualDays: 30, over: false, overDays: null }, "🔴 клієнт без замовлень «пропустив ритм»");
  assert.deepEqual(rhythmOf(90, 30, true), { usualDays: 30, over: false, overDays: null }, "🔴 сезонний не в сезоні «пропустив ритм»");
  // 🪞 Узгодженість із кольором на сітці: пропустив ритм → не зелений, для кожного сегмента.
  for (const seg of ["vip", "regular", "episodic", "unknown"] as const) {
    for (const median of [0, 7, 14, 21, 30, 45, 90]) {
      for (let d = 0; d <= 200; d += 1) {
        if (rhythmOf(d, median, false).over) assert.notEqual(colorOf(seg, d, median), "green", `🔴 ${seg}, інтервал ${String(median)}, ${String(d)} дн.: «пропустив ритм», а клієнт зелений`);
      }
    }
  }

  const v = await loadView();
  const rows: Row[] = [
    row("over", "yellow", false, { lead: { rhythm: { over: true } } }),
    row("ok", "green", true, { lead: { rhythm: { over: false } } }),
    row("old", "red", false),   // рядок без ознаки (старий сервер) — невідоме не сигнал
  ];
  assert.equal(ids(v.applyLeadFilter(rows, { ...v.DEFAULT_LEAD_FILTER, overRhythm: true })), "over", "🔴 фільтр «пропустили ритм» показує не тих");
  assert.equal(ids(v.applyLeadFilter(rows, v.DEFAULT_LEAD_FILTER)), "over,ok,old", "🔴 вимкнений фільтр ритму щось відсікає");
  assert.equal(v.leadFilterActive({ ...v.DEFAULT_LEAD_FILTER, overRhythm: true }), true);

  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const dash = codeOnly(readFileSync(`${ROOT}backend/src/routes/dashboard.ts`, "utf8"));
  assert.match(dash, /rhythm: clientLeadRules\.rhythmOf\(orderDays, factsFor\(seg, c\.client_key\)\.medianGapDays, off\),/, "🔴 рядок не несе ритм або рахує його не з тієї медіани, що колір");
  const lead = codeOnly(readFileSync(FE("sections/ClientLeadSection.tsx"), "utf8"));
  assert.match(lead, /\{L\.rhythm && <RhythmLine r=\{L\.rhythm\} \/>\}/, "🔴 у клітинці «Замовлення» немає звичайного інтервалу клієнта");
  assert.match(lead, /baseRows\.filter\(overRhythm\)\.length/, "🔴 число на кнопці «пропустили ритм» — не з правила відбору");
});

/**
 * #11224 🪞 — ДАВНІСТЬ ОСТАННЬОЇ РОЗМОВИ: ФІЛЬТР І ПОРЯДОК (зустріч 25.11.2026: «дата останньої розмови + фільтр»).
 * «Понад N днів» — строго більше N, і туди ж ті, з ким не говорили ніколи; «не було» — лише вони. Порядок «розмова» і
 * «замовлення» ставить найдавніших і тих, у кого дати немає, першими; порядок за грошима лишається, як був.
 * 🧨 Червоніє, якщо межа зʼїде на день, клієнт без розмов випаде з «понад N», або сортування сховає їх у кінець.
 */
test("#11224 🪞 ОСТАННЯ РОЗМОВА: «понад N днів» по обидва боки межі, без розмов — у кожному «понад» і в «не було»; порядок — найдавніші й без дати першими", async () => {
  const v = await loadView();
  const rows: Row[] = [
    row("t0", "green", true, { lastTalk: "2026-11-26", lastTalkDays: 0, lifetimeRevenue: 10 }),
    row("t30", "yellow", true, { lastTalk: "2026-10-27", lastTalkDays: 30, lifetimeRevenue: 500 }),
    row("t31", "yellow", false, { lastTalk: "2026-10-26", lastTalkDays: 31, lifetimeRevenue: 40 }),
    row("t61", "red", false, { lastTalk: "2026-09-26", lastTalkDays: 61, lifetimeRevenue: 900 }),
    row("never", "red", false, { lastTalk: null, lastTalkDays: null, lifetimeRevenue: 70 }),
  ];
  assert.deepEqual([...v.TALK_AGE_DAYS], [14, 30, 60], "🔴 пороги давності розмови змінились — це зміна екрана, не технічна правка");
  const f = (talk: unknown) => ids(v.applyLeadFilter(rows, { ...v.DEFAULT_LEAD_FILTER, talk }));
  assert.equal(f("all"), "t0,t30,t31,t61,never", "🔴 вимкнений фільтр розмови щось відсікає");
  assert.equal(f(30), "t31,t61,never", "🔴 «понад 30 днів»: 30-й день уже в списку, 31-й ні, або зник клієнт без розмов");
  assert.equal(f(14), "t30,t31,t61,never");
  assert.equal(f(60), "t61,never", "🔴 «понад 60 днів» — не ті");
  assert.equal(f("none"), "never", "🔴 «розмов не було» показує тих, з ким говорили");
  assert.equal(v.talkMatches(rows[1], 30), false, "🔴 рівно 30 днів — уже «понад 30»");
  assert.equal(v.talkMatches(rows[2], 30), true, "🔴 31 день — ще не «понад 30»");
  assert.equal(v.leadFilterActive({ ...v.DEFAULT_LEAD_FILTER, talk: 30 }), true, "🔴 фільтр розмови не рахується активним — «скинути» не зʼявиться");
  // Умови фільтра — «і»: розмова × робота.
  assert.equal(ids(v.applyLeadFilter(rows, { ...v.DEFAULT_LEAD_FILTER, talk: 14, work: "yes" })), "t30", "🔴 фільтри розмови й роботи не перетинаються");

  // ↕️ Порядок. Вхідний масив не чіпається.
  const before = ids(rows);
  assert.equal(ids(v.sortLead(rows, "talk")), "never,t61,t31,t30,t0", "🔴 порядок «розмова»: найдавніші й без розмов не зверху");
  assert.equal(ids(v.sortLead(rows, "money")), "t61,t30,never,t31,t0", "🔴 порядок за грошима змінився");
  assert.equal(ids(rows), before, "🔴 сортування змінило вхідний масив");
  const ord: Row[] = [
    row("o5", "green", true, { lead: { orderDays: 5 }, lifetimeRevenue: 1 }),
    row("o90", "red", false, { lead: { orderDays: 90 }, lifetimeRevenue: 2 }),
    row("oNull", "red", false, { lead: { orderDays: null }, lifetimeRevenue: 3 }),
    row("o90b", "red", false, { lead: { orderDays: 90 }, lifetimeRevenue: 50 }),
    row("hand", "yellow", false, { lead: { orderDays: 5, handOver: true }, lifetimeRevenue: 0 }),
  ];
  assert.equal(ids(v.sortLead(ord, "order")), "oNull,o90b,o90,hand,o5", "🔴 порядок «замовлення»: хто довше без замовлення — не зверху, або рівні не за грошима");
  assert.equal(ids(v.sortLead(ord, "money")), "hand,o90b,oNull,o90,o5", "🔴 «передати іншому» більше не перші в порядку за грошима");

  // Проводка: сервер віддає дату й давність, екран показує їх і кличе правило відбору, а не свій поріг.
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const dash = codeOnly(readFileSync(`${ROOT}backend/src/routes/dashboard.ts`, "utf8"));
  const plans = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'), dash.indexOf('dashboardRouter.post("/client-plans/submit"'));
  assert.match(plans, /\blastTalkDays\b/, "🔴 рядок клієнта не несе давність останньої розмови");
  const lead = codeOnly(readFileSync(FE("sections/ClientLeadSection.tsx"), "utf8"));
  assert.match(lead, /const sorted = sortLead\(rows, sortBy\);/, "🔴 список сортується не правилом із модуля");
  assert.match(lead, /TALK_AGE_DAYS\.map\(\(d\) => fchip\(filter\.talk === d, `понад \$\{d\} дн\. · \$\{baseRows\.filter\(\(r\) => talkMatches\(r, d\)\)\.length\}`/, "🔴 кнопки «понад N днів» — не з порогів модуля або число на них не з правила відбору");
  assert.match(lead, /baseRows\.filter\(\(r\) => talkMatches\(r, "none"\)\)\.length/, "🔴 число «розмов не було» — не з правила відбору");
  assert.match(lead, /\{c\.lastTalkDays === 0 \? "сьогодні" : `\$\{c\.lastTalkDays\} дн\. тому`\}/, "🔴 у рядку немає давності останньої розмови");
  assert.match(lead, /<select value=\{sortBy\} onChange=\{\(e\) => setSortBy\(e\.target\.value as LeadSort\)\}/, "🔴 перемикача порядку списку немає");
});

/**
 * #11226 🪞 — КЛІЄНТИ БЕЗ НОМЕРА: ОЗНАКА В РЯДКУ Й ОКРЕМИЙ СПИСОК (зустріч 25.11.2026: «без номера — в окремий список,
 * тімлід проводить аудит»). Ознаку дає сервер (`phoneState`: нуль номерів у контактах Kommo → `"none"`); екран лише
 * показує її й відбирає. Рядок без ознаки — НЕ «без номера»: невідоме не видаємо за прогалину в CRM.
 * 🧨 Червоніє, якщо в «без номера» потрапить клієнт із номером чи з невідомим станом, або клієнт без номера зникне зі списку.
 */
test("#11226 🪞 БЕЗ НОМЕРА: у списку рівно ті, у кого сервер сказав «номера немає»; невідомий стан — ні; фільтр перетинається з рештою", async () => {
  const v = await loadView();
  const rows: Row[] = [
    row("has", "green", true, { phone: "has" }),
    row("none1", "red", false, { phone: "none" }),
    row("none2", "yellow", true, { phone: "none" }),
    row("unknown", "red", false),
  ];
  assert.equal(ids(rows.filter(v.noPhone)), "none1,none2", "🔴 «без номера» — не рівно ті, кому сервер сказав none");
  assert.equal(v.noPhone(rows[3]), false, "🔴 рядок без ознаки номера пораховано як «номера немає»");
  assert.equal(ids(v.applyLeadFilter(rows, { ...v.DEFAULT_LEAD_FILTER, noPhone: true })), "none1,none2", "🔴 фільтр «без номера» показує не тих");
  assert.equal(ids(v.applyLeadFilter(rows, v.DEFAULT_LEAD_FILTER)), "has,none1,none2,unknown", "🔴 вимкнений фільтр номера щось відсікає");
  assert.equal(ids(v.applyLeadFilter(rows, { ...v.DEFAULT_LEAD_FILTER, noPhone: true, work: "no" })), "none1", "🔴 «без номера» не перетинається з «роботи немає»");
  assert.equal(v.leadFilterActive({ ...v.DEFAULT_LEAD_FILTER, noPhone: true }), true, "🔴 фільтр номера не рахується активним — «скинути» не зʼявиться");
  assert.equal(v.leadFilterActive(v.DEFAULT_LEAD_FILTER), false, "🔴 порожній фільтр рахується активним");

  // Сервер: стан номера — з того самого правила, що в картці; екран: ознака в рядку й число на кнопці з правила відбору.
  const { phoneState } = await import("./clientNextStep.js");
  assert.equal(phoneState(0), "none"); assert.equal(phoneState(1), "has");
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const dash = codeOnly(readFileSync(`${ROOT}backend/src/routes/dashboard.ts`, "utf8"));
  const plans = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'), dash.indexOf('dashboardRouter.post("/client-plans/submit"'));
  assert.match(plans, /phone: phoneState\(phonesByKey\.get\(c\.client_key\) \?\? 0\),/, "🔴 рядок клієнта не несе стан номера");
  const lead = codeOnly(readFileSync(FE("sections/ClientLeadSection.tsx"), "utf8"));
  assert.match(lead, /\{noPhone\(c\) && \(/, "🔴 у рядку не видно, що в клієнта немає номера");
  assert.match(lead, /📵 нема номера/, "🔴 підпис «нема номера» зник із рядка");
  assert.match(lead, /fchip\(filter\.noPhone, `📵 без номера \$\{baseRows\.filter\(noPhone\)\.length\}`/, "🔴 кнопки «без номера» немає або число на ній не з правила відбору");
});

/**
 * #11221 🪞 — АНКЕТА КЛІЄНТА: ПʼЯТЬ ПИТАНЬ ІЗ ЗУСТРІЧІ 25.11.2026, ОДНА НА КЛІЄНТА. Питання живуть у ядрі
 * (`core/clientProfile.ts`), картка малює те, що дав сервер; відповідь — лише рядок, обрізаний по межі; «заповнено» —
 * коли відповіді є на всі пʼять. Зберігає той, хто бачить клієнта: 403 — ПЕРШИМ оператором, до перевірки тіла.
 * 🧨 Червоніє, якщо питань стане не пʼять, порожня відповідь порахується заповненою, анкета 4 з 5 зникне зі списку
 * «не заповнена», або перевірка тіла стане перед межею доступу.
 */
test("#11221 🪞 АНКЕТА КЛІЄНТА: рівно пʼять питань; відповідь — лише непорожній рядок; «не заповнена» — поки відповідей менше пʼяти; 403 раніше за 400", async () => {
  const cp = await import("./clientProfile.js");
  assert.deepEqual(cp.PROFILE_FIELDS.map((f) => f.key), ["business", "volume", "share", "international", "airSea"], "🔴 питань анкети не пʼять або вони не ті, що на зустрічі 25.11.2026");
  assert.equal(cp.PROFILE_TOTAL, 5);
  const clean = cp.cleanProfile({ business: "  меблі  ", volume: 12, share: "   ", international: "x".repeat(cp.PROFILE_ANSWER_MAX + 50), extra: "зайве" });
  assert.deepEqual(Object.keys(clean), ["business", "volume", "share", "international", "airSea"], "🔴 в анкету пройшло чуже поле або зникло своє");
  assert.equal(clean.business, "меблі", "🔴 пробіли по краях не зрізано");
  assert.equal(clean.volume, "", "🔴 не-рядок став відповіддю");
  assert.equal(clean.share, "", "🔴 самі пробіли стали відповіддю");
  assert.equal(clean.international.length, cp.PROFILE_ANSWER_MAX, "🔴 відповідь довша за межу");
  assert.equal(clean.airSea, "");
  assert.equal(cp.filledCount(clean), 2, "🔴 порожня відповідь порахована заповненою або заповнена — ні");
  assert.equal(cp.filledCount(null), 0); assert.equal(cp.filledCount(cp.cleanProfile(null)), 0); assert.equal(cp.filledCount(cp.cleanProfile("рядок")), 0);
  assert.equal(cp.filledCount({ business: "а", volume: "б", share: "в", international: "г", airSea: "д" }), 5);

  const v = await loadView();
  const rows: Row[] = [
    row("p0", "red", false, { profile: { filled: 0, total: 5 } }),
    row("p4", "yellow", true, { profile: { filled: 4, total: 5 } }),
    row("p5", "green", true, { profile: { filled: 5, total: 5 } }),
    row("unknown", "red", false),
  ];
  assert.equal(ids(rows.filter(v.profileOpen)), "p0,p4", "🔴 «анкета не заповнена»: 4 з 5 вже не в списку, 5 з 5 ще в ньому, або невідомий стан видано за борг");
  assert.equal(ids(v.applyLeadFilter(rows, { ...v.DEFAULT_LEAD_FILTER, profileOpen: true })), "p0,p4", "🔴 фільтр анкети показує не тих");
  assert.equal(ids(v.applyLeadFilter(rows, v.DEFAULT_LEAD_FILTER)), "p0,p4,p5,unknown", "🔴 вимкнений фільтр анкети щось відсікає");
  assert.equal(v.leadFilterActive({ ...v.DEFAULT_LEAD_FILTER, profileOpen: true }), true);

  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const dash = codeOnly(readFileSync(`${ROOT}backend/src/routes/dashboard.ts`, "utf8"));
  const route = dash.slice(dash.indexOf('dashboardRouter.post("/client-profile"'));
  const body = route.slice(0, route.indexOf("\n});"));
  assert.ok(body.length > 200, "🔴 перевіряти нічого: роуту анкети немає");
  const gate = body.indexOf("if (!clientKey || !(await canSeeClient(auth, clientKey))) return res.status(403)");
  assert.ok(gate > 0, "🔴 анкету зберігає не той, хто бачить клієнта");
  assert.ok(gate < body.indexOf("cleanProfile(") && gate < body.indexOf("status(400)"), "🔴 перевірка тіла стоїть перед межею доступу — 400 замість 403");
  assert.match(body, /if \(clientProfile\.filledCount\(answers\) === 0\) return res\.status\(400\)/, "🔴 порожня анкета зберігається як заповнена");
  assert.match(dash, /profile: \{ filled: profileByKey\.get\(c\.client_key\)\?\.filled \?\? 0, total: clientProfile\.PROFILE_TOTAL \},/, "🔴 рядок клієнта не несе стан анкети");
  assert.match(dash, /profile: \{ fields: clientProfile\.PROFILE_FIELDS\.map\(/, "🔴 картка не віддає питання анкети з ядра");
  const sections = "sections/";
  assert.match(codeOnly(readFileSync(FE(`${sections}ClientCardPanel.tsx`), "utf8")), /<ClientProfileBlock card=\{card\}/, "🔴 у картці клієнта немає анкети");
  const block = codeOnly(readFileSync(FE(`${sections}ClientProfileBlock.tsx`), "utf8"));
  assert.match(block, /\{p\.fields\.map\(\(f\) => \(/, "🔴 анкета малює не ті питання, що дав сервер");
  assert.match(block, /saveClientProfile\(card\.clientKey, draft\)/, "🔴 анкета не зберігається цілою");
  assert.doesNotMatch(block, /Чим займається|міжнародн|авіа/i, "🔴 питання анкети продубльовано на фронті — зʼїдуть із ядром");
  const lead = codeOnly(readFileSync(FE(`${sections}ClientLeadSection.tsx`), "utf8"));
  assert.match(lead, /fchip\(filter\.profileOpen, `📋 анкета не заповнена \$\{baseRows\.filter\(profileOpen\)\.length\}`/, "🔴 кнопки «анкета не заповнена» немає або число на ній не з правила відбору");
  assert.match(lead, /📋 анкета \{c\.profile\.filled\}\/\{c\.profile\.total\}/, "🔴 у рядку не видно, скільки питань анкети мають відповідь");
});

/**
 * #11222 🪞 — ДОВГІ ПОЯСНЕННЯ СТОЯТЬ ПІД «?», А НЕ НА ЕКРАНІ (зустріч 25.11.2026: «купа тексту… знак питання, наводиш —
 * і все»). Дзеркало важливіше за заборону: текст НЕ ЗНИК — правило кольору, підпис якорів картки, наслідки архіву,
 * «Проблемного» й «В нічийні» і далі доступні, лише за наведенням / кліком / фокусом.
 * 🧨 Червоніє, якщо пояснення повернеться постійним текстом, або зникне зовсім (заборона без дзеркала це пропустила б).
 */
test("#11222 🪞 ПОЯСНЕННЯ ПІД «?»: довгий текст на «З ким говорити» і в картці — лише всередині підказки, і жоден не зник", () => {
  const HELP = /<HelpTip\b[^>]*>([\s\S]*?)<\/HelpTip>/g;
  const split = (file: string) => {
    const src = codeOnly(readFileSync(FE(`sections/${file}`), "utf8"));
    const inside = [...src.matchAll(HELP)].map((m) => m[1]).join("\n");
    return { inside, outside: src.replace(HELP, "") };
  };
  const MOVED: [string, string[]][] = [
    ["ClientLeadSection.tsx", ["Колір</b> — лише від замовлення", "колір від цього не змінюється"]],
    ["ClientCardPanel.tsx", ["{card.anchorNote}", "Угоди та гроші не змінюються", "Примітка обовʼязкова", "щойно зʼявиться оплата пізніша за дату архівації", "Скидання поверне клієнта"]],
    ["ClientProblemBlock.tsx", ["Знімається сама, якщо клієнт знову замовить", "Стане звичайним сам, якщо знову замовить"]],
    ["ClientReleaseBlock.tsx", ["клієнт піде лідгенам"]],
  ];
  for (const [file, phrases] of MOVED) {
    const { inside, outside } = split(file);
    assert.ok(inside.length > 0, `🔴 ${file}: перевіряти нічого — жодної підказки «?»`);
    for (const ph of phrases) {
      assert.ok(inside.includes(ph), `🔴 ${file}: пояснення «${ph}» зникло зовсім — його мало бути видно під «?»`);
      assert.ok(!outside.includes(ph), `🔴 ${file}: пояснення «${ph}» знову стоїть постійним текстом`);
    }
  }
  // Підказка справді схована, доки її не відкрили, і відкривається мишею, кліком і з клавіатури.
  const tip = codeOnly(readFileSync(FE("sections/HelpTip.tsx"), "utf8"));
  assert.match(tip, /\{open && \(\s*<span role="tooltip"/, "🔴 текст підказки показано завжди, а не за відкриттям");
  assert.match(tip, /onMouseEnter=\{\(\) => setOpen\(true\)\}/, "🔴 підказка не відкривається наведенням");
  assert.match(tip, /onFocus=\{\(\) => setOpen\(true\)\}/, "🔴 підказка не відкривається з клавіатури");
  assert.match(tip, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); setOpen\(true\); \}\}/, "🔴 клік перемикає підказку: дотик дає фокус (відкрито) і одразу клік (закрито) — на телефоні пояснення не видно");
  assert.match(tip, /aria-label=\{label\} aria-expanded=\{open\}/, "🔴 кнопка «?» без назви для читача екрана");
});
