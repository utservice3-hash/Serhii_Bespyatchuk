import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsDb, needsApi, API_BASE } from "../testMode.js";

/**
 * #99 / #99b — МУЛЬТИВИБІР КОМАНД У «ОБСЯЗІ» (21.08.2026).
 *
 * 🔴 ЧОГО ТУТ БОЯТИСЬ. Мультивибір — це не «показати більше рядків», а СКЛЕЮВАННЯ
 * кількох відповідей в одну. Дві помилки роблять це тихо: (1) менеджер, що
 * потрапив у два ростери, дає рядок двічі й підсумок росте; (2) `glance` беруть
 * із ПЕРШОЇ відповіді замість суми — і кільце показує одну команду, поки таблиця
 * показує пʼять. Обидві не мають жодного видимого симптому, крім неправильного
 * числа, тож ловити їх треба інваріантом, а не оком.
 *
 * 📐 Заміряно на проді 20.08.2026 (серпень): 5 команд дають 33 рядки й
 * 1 492 822 ₴ факту — рівно стільки ж, скільки «весь відділ». Перетинів між
 * ростерами 0, менеджерів поза командами 0.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const FE = path.join(ROOT, "frontend", "src", "pages", "dashboard");
const stripComments = (x: string) =>
  x.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("#99 ЧЛЕНСТВО СКАЛЯРНЕ: менеджер не може дати два рядки (жива БД)", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  /**
   * 🔴 Це перевірка ДАНИХ, а не коду: групування на екрані розкладає рядки по
   * `teamId`, і якщо в БД зʼявиться друге джерело членства, Σ груп перестане
   * дорівнювати Σ рядків. Тут ми доводимо, що джерело одне.
   */
  const dup = await pool.query<{ n: string }>(
    `SELECT COUNT(*) n FROM (
       SELECT m.id FROM managers m GROUP BY m.id HAVING COUNT(DISTINCT m.team_id) > 1) x`);
  assert.equal(Number(dup.rows[0].n), 0,
    "🔴 менеджер належить двом командам — мультивибір почне двоїти і рядок, і підсумок");

  // Дзеркало: перевіряти БУЛО на чому — команди з людьми справді існують.
  const teams = await pool.query<{ n: string }>(
    `SELECT COUNT(DISTINCT m.team_id) n FROM managers m WHERE m.is_active AND m.team_id IS NOT NULL`);
  assert.ok(Number(teams.rows[0].n) >= 2,
    "🔴 у базі менше двох команд з активними людьми — мультивибір перевіряти нема на чому");
});

test("#99b ЗЛИТТЯ СУМУЄ glance ВСІХ ЧАСТИН, а не бере з першої", () => {
  const src = readFileSync(path.join(FE, "reportScope.ts"), "utf8");
  const code = stripComments(src);
  assert.ok(/export function mergeReportPlans/.test(code), "🔴 функції злиття немає");

  /**
   * 🔴 «Взяти з першої» виглядає майже так само, як «сумувати», і саме тому
   * перевіряємо ФОРМУ виразу: кожне адитивне поле мусить пройти по ВСІХ частинах.
   */
  /**
   * 🔴 ПЕРЕВІРЯЄМО САМ ЦИКЛ ПО АДИТИВНИХ ПОЛЯХ, а не наявність `parts.reduce`
   * будь-де у файлі. Перша редакція цього гейта шукала підрядок — і лишилась
   * ЗЕЛЕНОЮ, коли я підмінив суму на `base.glance[k]`: `parts.reduce` нижче все
   * одно стояв (у `statusCounts`). Друга редакція теж не спрацювала: вікно в 160
   * символів дотягувалось до того самого `statusCounts`. Тому патерн тримається
   * ОДНОГО РЯДКА (`[^\n]*`) — саме того оператора, який і мусить сумувати.
   * Саботаж показав обидві дірки; без нього гейт стеріг би слово, а не поведінку.
   */
  assert.ok(/for \(const k of ADDITIVE\)[^\n]*parts\.reduce\(/.test(code),
    "🔴 адитивні поля `glance` не сумуються по ВСІХ частинах — кільце покаже одну команду, поки таблиця показує кілька");
  for (const k of ["fact", "plan", "factNoPlan", "statusCounts"])
    assert.ok(new RegExp(`\\b${k}\\b`).test(code), `🔴 поле \`${k}\` не згадане у злитті — воно мовчки візьметься з першої команди`);
  assert.ok(/statusCounts[\s\S]{0,220}reduce[\s\S]{0,120}statusCounts\.a/.test(code),
    "🔴 чипи станів не сумуються по всіх командах — Σ чипів перестане дорівнювати кількості людей (#54-клас)");

  /**
   * 🔴 ЧАСТКА НЕ СУМУЄТЬСЯ. `avgCheck` — це гроші ÷ угоди, а знаменника в `glance`
   * немає. Просумувати або усереднити його означало б надрукувати вигадане число.
   */
  assert.ok(/glance\.avgCheck = null/.test(code),
    "🔴 `avgCheck` при злитті не занулено — на екрані зʼявиться «середнє середніх», якого ніхто не рахував");
  // Перевіряємо САМ ЛІТЕРАЛ списку, а не «десь поруч у файлі»: нижче в тому самому
  // модулі стоїть рядок `glance.avgCheck = null`, і широкий патерн ловив би його.
  const additive = code.match(/const ADDITIVE = \[([\s\S]*?)\]/)?.[1] ?? "";
  assert.ok(additive.length > 0, "🔴 перелік адитивних полів зник — сумується казна-що");
  assert.equal(/avgCheck/.test(additive), false,
    "🔴 `avgCheck` потрапив у список адитивних полів — частку не можна складати");

  // Дедуп рядків: подвоєння не має доїхати до екрана навіть як «тимчасово».
  assert.ok(/seen\.has\(m\.managerId\)/.test(code),
    "🔴 рядки не дедуплікуються по managerId — той самий менеджер зʼявиться двічі");
});

test("#99b2 ЕКРАН: групи рахуються з ТИХ САМИХ рядків, і чужий рядок не зникає", () => {
  const code = stripComments(readFileSync(path.join(FE, "sections", "ReportTableSection.tsx"), "utf8"));
  assert.ok(/const groups = useMemo/.test(code), "🔴 групування зникло");
  assert.ok(/for \(const r of rows\)/.test(code),
    "🔴 групи будуються не з `rows` — тобто не з того самого набору, що плоский список і підсумок");
  /**
   * 🔴 Рядок, чия команда не в переліку обраних, мусить лишитись видимим окремою
   * групою. Інакше Σ груп < Σ рядків, і різницю видно лише склавши стовпчик очима.
   */
  assert.ok(/Поза обраними командами/.test(code),
    "🔴 немає групи для рядка поза обраними командами — він зникне мовчки");
  assert.ok(/grouped = teamIds\.length >= 2/.test(code),
    "🔴 групування вмикається не мультивибором — при одній команді екран перестане бути теперішнім");
  // Загальний підсумок — по ВСІХ видимих рядках (рішення власника: Σ видимих рядків).
  assert.ok(/<FootCell key=\{c\.key\} col=\{c\} rows=\{rows\}/.test(code),
    "🔴 загальний підсумок рахується не по всіх видимих рядках");
  assert.ok(/rows=\{g\.rows\}/.test(code), "🔴 підсумок групи рахується не по рядках цієї групи");
});

/**
 * #100 / #100b / #101 — ТРИ КОНВЕРСІЇ ЗАМІСТЬ ОДНІЄЇ (21.08.2026).
 *
 * 📐 Заміряно на проді (серпень): реклама 611/67 (11.0%) + лідоген 302/75 (24.8%)
 * = 913/142, а combined — рівно 913/142 (15.6%). Тобто одна колонка «Р+Л» ховала
 * різницю в 2.3 раза між каналами.
 */

test("#100 РОЗБИТТЯ ЗА ДЖЕРЕЛОМ АДИТИВНЕ: ad + leadgen == combined (жива БД)", needsDb(), async () => {
  const m = await import("../core/metrics.js");
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const scope = { from: `${ym}-01`, to: `${ym}-31` };

  const [all, ad, lg] = await Promise.all([
    m.conversionByManager(scope), m.conversionByManager(scope, "ad"), m.conversionByManager(scope, "leadgen"),
  ]);
  assert.ok(all.length > 0, "🔴 combined порожній — перевіряти нема на чому (це ПРОВАЛ, а не «немає даних»)");

  const idx = (rows: typeof all) => new Map(rows.map((r) => [r.managerId, r]));
  const A = idx(ad), L = idx(lg);
  const bad: string[] = [];
  for (const c of all) {
    const a = A.get(c.managerId), l = L.get(c.managerId);
    const t = (a?.taken ?? 0) + (l?.taken ?? 0), w = (a?.won ?? 0) + (l?.won ?? 0);
    if (t !== c.taken || w !== c.won)
      bad.push(`мгр ${c.managerId}: ${t}/${w} проти combined ${c.taken}/${c.won}`);
  }
  assert.deepEqual(bad, [],
    "🔴 канальні counts не сходяться в combined — тобто на екрані три числа, з яких два\n"
    + "суперечать третьому:\n  " + bad.join("\n  "));

  // Дзеркало: обидва канали справді мають дані. Інакше рівність трималась би на
  // тому, що один із доданків завжди нуль, і гейт не перевіряв би нічого.
  assert.ok(ad.some((r) => r.taken > 0), "🔴 у рекламі нуль узятих — доданок вироджений");
  assert.ok(lg.some((r) => r.taken > 0), "🔴 у лідогену нуль узятих — доданок вироджений");
});

test("#100b ВІДСОТКИ НЕ СКЛАДАЮТЬСЯ: підсумок кожної колонки — Σwon ÷ Σtaken", () => {
  const cols = stripComments(readFileSync(path.join(FE, "reportTableCols.ts"), "utf8"));
  const foot = cols.split("ratio:convAd")[2] ?? cols.split("ratio:convAd")[1] ?? "";
  assert.ok(/rows\.reduce\(\(s, m\) => s \+ pick\(m\)\.won, 0\)/.test(cols),
    "🔴 чисельник підсумку канальної конверсії — не Σ виграних");
  assert.ok(/rows\.reduce\(\(s, m\) => s \+ pick\(m\)\.taken, 0\)/.test(cols),
    "🔴 знаменник підсумку канальної конверсії — не Σ узятих");
  assert.ok(foot.length >= 0);
  /**
   * 🔴 СЕРЕДНЄ ПО РЯДКАХ — саме та помилка, від якої це стереже: воно дало б
   * менеджеру з трьома лідами таку саму вагу, як менеджеру з трьомастами.
   */
  assert.equal(/pick\(m\)\.fact[\s\S]{0,80}\/ rows\.length/.test(cols), false,
    "🔴 підсумок канальної конверсії рахується середнім по рядках");

  // Обидві колонки опційні (чипами) і мають пояснення.
  for (const k of ["convAd", "convLg"]) {
    const def = cols.split(`key: "${k}"`)[1]?.split("},")[0] ?? "";
    assert.ok(def.length > 0, `🔴 колонки ${k} немає в реєстрі`);
    assert.ok(/core: false/.test(def), `🔴 ${k} увімкнена за замовчуванням — вона мусить бути чипом`);
    assert.ok(/help:/.test(def), `🔴 ${k} без підказки «що це і звідки»`);
  }
  // Попередження про неадитивність мусить стояти НА ЕКРАНІ, а не лише тут.
  assert.ok(/НЕ складаються/.test(cols),
    "🔴 у підказці немає попередження, що відсотки трьох колонок не складаються");
  /**
   * 🔴 КОЛОНКА МУСИТЬ НАЗИВАТИ СВІЙ ЗНАМЕННИК. У словнику метрик уже є
   * `conversion_leadgen` з ІНШИМ знаменником (реєстр передач), і за той самий
   * серпень вона дає 3.8% проти наших 24.8%. Без підпису два правильні числа
   * читаються як поломка — той самий клас, що два «очікуємо».
   */
  assert.ok(/conversion_leadgen/.test(cols) && /3\.8%/.test(cols),
    "🔴 підказка не попереджає, що це НЕ `conversion_leadgen` зі словника (159/6 = 3.8% за серпень)");
});

test("#101 COMBINED НЕ ЗМІНИВСЯ: та сама функція без каналу", () => {
  const met = stripComments(readFileSync(path.join(ROOT, "backend", "src", "core", "metrics.ts"), "utf8"));
  const body = met.split("export async function conversionByManager")[1]?.split("\nexport ")[0] ?? "";
  assert.ok(body.length > 0, "🔴 conversionByManager зник");
  /**
   * 🔴 ОДНА ФУНКЦІЯ, А НЕ ТРИ. Канал — це ОДНА умова на весь запит, тож `taken` і
   * `won` рахуються по тій самій множині рядків. Написані окремо, канальні
   * варіанти розійшлися б із combined, і помітити це можна було б лише руками.
   */
  assert.ok(/if \(channel\) \{[\s\S]{0,160}d\.lead_channel = \$/.test(body),
    "🔴 канал більше не одна умова того самого запиту");
  assert.ok(/else conds\.push\("d\.lead_channel IN \('ad','leadgen'\)"\)/.test(body),
    "🔴 без каналу функція більше не бере обидва — combined змінить ЗНАЧЕННЯ");
  /**
   * 🔴 НОВИХ канальних функцій заводити не можна — це був би другий вираз того
   * самого числа. Але `conversionLeadgenByManager` у ядрі ІСНУВАВ І РАНІШЕ, і це
   * ІНША метрика: її знаменник — реєстр передач лідогену (`lead_transfer_events`
   * за `transfer_date`), а не когорта створення угод за `lead_channel`.
   *
   * 📐 Заміряно на проді за серпень 2026, той самий місяць:
   *   наша колонка «Конв. лідоген» : 302 взято / 75 виграно = 24.8%
   *   глосарійна conversion_leadgen: 159 взято /  6 виграно =  3.8%
   * Розрив у знаменнику ×1.9, у чисельнику ×12.5. Тобто це РІЗНІ метрики під
   * однією назвою — рівно те, від чого береже правило «підписуй, якою метрикою
   * рахуєш». Тому: стару функцію не чіпаємо, нових не заводимо, а таблиця не має
   * права читати обидві — інакше на одному екрані стоятимуть 24.8% і 3.8%.
   */
  assert.equal(/conversionAdByManager/.test(met), false,
    "🔴 зʼявилась окрема функція конверсії реклами — це другий вираз того самого числа");
  const cols2 = readFileSync(path.join(FE, "reportTableCols.ts"), "utf8");
  assert.equal(/conversionLeadgenByManager/.test(cols2), false,
    "🔴 таблиця читає ГЛОСАРІЙНУ конверсію лідогену поруч зі своєю — два різні знаменники "
    + "під однією назвою на одному екрані (24.8% проти 3.8% за той самий серпень)");

  // Роут кличе ту саму функцію тричі, а не пише свій SQL.
  const route = stripComments(readFileSync(path.join(ROOT, "backend", "src", "routes", "dashboard.ts"), "utf8"));
  assert.ok(/metrics\.conversionByManager\(scope, "ad"\)/.test(route)
    && /metrics\.conversionByManager\(scope, "leadgen"\)/.test(route),
    "🔴 роут рахує канальні конверсії не ядром");
  assert.ok(/metrics\.conversionByManager\(scope\)/.test(route),
    "🔴 combined більше не рахується тим самим викликом без каналу");
});

/**
 * #105 — ДВІ «КОНВЕРСІЇ ЛІДОГЕН» РОЗВЕДЕНІ НАЗВАМИ (рішення власника 21.08.2026).
 *
 * 🔴 ОБИДВІ ПРАВИЛЬНІ, І САМЕ ТОМУ НЕБЕЗПЕЧНІ. У Звіті знаменник — когорта
 * СТВОРЕНИХ угод за `lead_channel`; у «Планах» — РЕЄСТР ПЕРЕДАНИХ заявок
 * (`lead_transfer_events` за `transfer_date`). За серпень 2026 це 24.8% і 3.8% —
 * розрив у 6.5 раза. Поки обидві звались просто «конверсія лідогену», два
 * правильні числа на сусідніх екранах читались як поломка одного з них.
 *
 * Рішення власника: метрики ЛИШАЄМО обидві, розводимо НАЗВИ. Гейт стереже саме
 * підписи — бо числа тут ніхто й не збирався міняти.
 */
test("#105 КОЖНА ПОВЕРХНЯ НАЗИВАЄ СВІЙ ЗНАМЕННИК У ПІДПИСІ", () => {
  const cols = readFileSync(path.join(FE, "reportTableCols.ts"), "utf8");
  const plans = readFileSync(path.join(FE, "sections", "PlansSection.tsx"), "utf8");

  // ── Звіт: обидві канальні колонки підписані «за каналом» ──
  for (const [k, want] of [["convAd", "Конв. реклама (за каналом)"], ["convLg", "Конв. лідоген (за каналом)"]]) {
    const def = cols.split(`key: "${k}"`)[1]?.split("},")[0] ?? "";
    assert.ok(def.includes(`title: "${want}"`),
      `🔴 колонка ${k} більше не називає свою основу — очікувався заголовок «${want}»`);
  }
  /**
   * 🔴 ОБИДВІ, А НЕ ЛИШЕ ЛІДОГЕН. Якби «за каналом» стояло тільки в лідогену,
   * сусідня «Конв. реклама» читалась би як глосарійна `conversion_ads` (знаменник
   * «Прийнято реклами») — та сама пастка, лише переставлена на інший канал.
   */
  assert.equal(/title: "Конв\. реклама"/.test(cols), false,
    "🔴 «Конв. реклама» лишилась без підпису основи, поки лідоген його має — асиметрія відтворює ту саму плутанину");

  // ── «Плани»: підпис залежить від каналу рядка й називає ДЖЕРЕЛО знаменника ──
  assert.ok(/Конверсія \(за передачами\)/.test(plans),
    "🔴 у «Планах» конверсія лідогену не названа «за передачами» — її сплутають зі звітною");
  assert.ok(/Конверсія \(за прийнятою рекламою\)/.test(plans),
    "🔴 у «Планах» конверсія реклами не названа своєю основою");
  assert.equal(/cell\("Конверсія",/.test(plans), false,
    "🔴 у «Планах» повернувся підпис просто «Конверсія» — саме він і зробив дві метрики нерозрізненними");
  // Підпис під числом теж мусить називати, ЩО саме в знаменнику.
  assert.ok(/переданих заявок/.test(plans) && /прийнятих реклами/.test(plans),
    "🔴 підпис під числом («N/M заявок») не каже, ЯКИХ саме заявок — знаменник знову безіменний");

  /**
   * 🔴 І ЗВІТ МУСИТЬ ПРЯМО ПОПЕРЕДЖАТИ ПРО ДРУГУ МЕТРИКУ, з обома числами.
   * Назви розведені, але людина, що бачить 24.8% тут і 3.8% там, має дізнатись
   * ЧОМУ з підказки, а не з розслідування.
   */
  assert.ok(/conversion_leadgen/.test(cols) && /3\.8%/.test(cols) && /24\.8%/.test(cols),
    "🔴 підказка Звіту більше не називає другу метрику й обидва числа");
});

/**
 * #106 — КОЖЕН ШЛЯХ, ЯКИЙ ЧИТАЄ РЕЄСТР КОЛОНОК, ІСНУЄ У ВІДПОВІДІ API.
 *
 * 🔴 ЧОМУ ЦЕЙ ГЕЙТ ЗʼЯВИВСЯ. Прохід 2 виїхав на прод із полями `conversionAd` /
 * `conversionLeadgen`, покладеними ВСЕРЕДИНУ `kpi`, тоді як тип фронта й
 * `val: (m) => m.conversionAd.fact` читають їх на ВЕРХНЬОМУ рівні. Тобто
 * увімкнення чипа дало б `undefined.fact` — падіння таблиці, а не хибне число.
 *
 * 🔴 І ЖОДЕН НАЯВНИЙ ГЕЙТ ЦЬОГО НЕ БАЧИВ, бо всі вони читають ДЖЕРЕЛО:
 * `#81b` звіряє реєстр із версткою, `#104` — властивості описів, `#100` — числа
 * в ядрі. Між «поле є в типі» і «поле є у відповіді» перевірки не було взагалі:
 * TypeScript тут безсилий — бекенд і фронт компілюються окремо, і фронтовий тип
 * не є контрактом для роута.
 *
 * Тому гейт бере ЖИВУ відповідь і кожен шлях `m.<щось>`, який реєстр насправді
 * розіменовує, перевіряє на РЕАЛЬНОМУ обʼєкті менеджера.
 */
test("#106 ШЛЯХИ РЕЄСТРУ КОЛОНОК ІСНУЮТЬ У ЖИВІЙ ВІДПОВІДІ", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${ym}-01&to=${ym}-31`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const body = await r.json() as { managers: Record<string, unknown>[] };
  const m = body.managers?.[0];
  assert.ok(m, "🔴 у відповіді нема жодного менеджера — перевіряти нема на чому");

  const cols = stripComments(readFileSync(path.join(FE, "reportTableCols.ts"), "utf8"));
  /** Шляхи виду `m.a.b`, які реєстр РОЗІМЕНОВУЄ у `val`. */
  const paths = new Set<string>();
  for (const mm of cols.matchAll(/\bm\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) paths.add(mm[1]);
  assert.ok(paths.size >= 10, `🔴 з реєстру видобуто лише ${paths.size} шляхів — розбір зламався`);

  const missing: string[] = [];
  for (const pth of paths) {
    let cur: unknown = m;
    for (const seg of pth.split(".")) {
      if (cur == null || typeof cur !== "object" || !(seg in (cur as object))) { missing.push(`m.${pth}`); cur = null; break; }
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  assert.deepEqual(missing, [],
    "🔴 РЕЄСТР ЧИТАЄ ТЕ, ЧОГО У ВІДПОВІДІ НЕМАЄ. Увімкнення такої колонки — не хибне\n"
    + "число, а падіння таблиці на `undefined`:\n  " + missing.join("\n  "));
});

/**
 * #102 / #102b / #103 / #104 — ГРОШІ ЗА НОВИЗНОЮ КЛІЄНТА (21.08.2026).
 *
 * 📐 Заміряно на проді 20.08.2026 (серпень): «Отримано» 1 492 822 ₴ = нові
 * 334 584 (133 уг.) + постійні 1 158 238 (368 уг.), Δ0 по 8 менеджерах і по
 * відділу. «Очікує (дата)» 902 222 ₴ = 119 912 + 782 310, теж Δ0.
 */

test("#102 РОЗКЛАД == ЧИСЛУ: нові + постійні + невизн == «Отримано» (жива БД)", needsDb(), async () => {
  const money = await import("../core/money.js");
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const scope = { from: `${ym}-01`, to: `${ym}-31` };

  const [core, split] = await Promise.all([money.receivedByMgr(scope), money.receivedByMgrKlass(scope)]);
  assert.ok(core.length > 0, "🔴 каса порожня — перевіряти нема на чому (це ПРОВАЛ, а не «немає даних»)");
  const agg = new Map<number, number>();
  for (const r of split) agg.set(r.managerId, (agg.get(r.managerId) ?? 0) + r.revenue);

  const bad: string[] = [];
  for (const c of core) {
    const s = agg.get(c.managerId) ?? 0;
    if (Math.abs(s - c.revenue) > 1) bad.push(`мгр ${c.managerId}: розклад ${Math.round(s)} проти каси ${Math.round(c.revenue)}`);
  }
  assert.deepEqual(bad, [],
    "🔴 РОЗКЛАД СПЕРЕЧАЄТЬСЯ З ЧИСЛОМ, яке пояснює — те саме, що ми лікували у F1:\n  " + bad.join("\n  "));

  // Дзеркало: обидва класи справді присутні. Інакше рівність трималась би на тому,
  // що один доданок завжди нуль, і гейт не перевіряв би поділу взагалі.
  assert.ok(split.some((r) => r.klass === "new" && r.revenue !== 0), "🔴 жодних грошей від нових — доданок вироджений");
  assert.ok(split.some((r) => r.klass === "repeat" && r.revenue !== 0), "🔴 жодних грошей від постійних — доданок вироджений");
});

test("#102b БУДИЛЬНИК: гроші поза «нові/постійні» мусять бути ПОМІЧЕНІ (жива БД)", needsDb(), async () => {
  const money = await import("../core/money.js");
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const split = await money.receivedByMgrKlass({ from: `${ym}-01`, to: `${ym}-31` });
  const undef = split.filter((r) => r.klass === "undef");
  const sum = undef.reduce((s, r) => s + r.revenue, 0), deals = undef.reduce((s, r) => s + r.deals, 0);
  /**
   * 🔴 НА ЕКРАНІ ДВІ КОЛОНКИ, А КЛАСІВ ТРИ. Поки третій порожній, «всього == нові +
   * постійні» — правда. Щойно він оживе, різниця почне мовчки зникати між
   * колонками, і жоден інший гейт цього не побачить: кожне окреме число
   * лишатиметься правильним. Тому будильник, а не мовчазне згортання в «постійні».
   * 📐 Заміряно 20.08.2026: 0 ₴ / 0 угод із 1 492 822 ₴ серпня.
   */
  assert.equal(sum, 0,
    `🔴 ${Math.round(sum)} ₴ у ${deals} угодах не належать ні «новим», ні «постійним» — на екрані `
    + "їх НЕМАЄ в жодній із двох колонок. Треба або показати третю колонку, або назвати причину.");
});

test("#103 ОЧІКУВАННЯ: нові + постійні == «Очікує (дата)», і ділиться саме воно (жива БД)", needsDb(), async () => {
  const m = await import("../core/metrics.js");
  const [ctl, split] = await Promise.all([
    m.expectedPaymentsByPlanned({}), m.expectedThisMonthByMgrKlass({}),
  ]);
  const sum = split.reduce((s, r) => s + r.sum, 0);
  assert.ok(ctl.thisMonth.sum > 0, "🔴 зона очікувань цього місяця порожня — перевіряти нема на чому");
  assert.ok(Math.abs(sum - ctl.thisMonth.sum) <= 1,
    `🔴 розклад очікувань ${Math.round(sum)} ≠ ${Math.round(ctl.thisMonth.sum)} — колонка й її склад розійшлись`);
  assert.equal(split.filter((r) => r.klass === "undef").reduce((s, r) => s + r.sum, 0), 0,
    "🔴 в очікуваннях зʼявились гроші поза «нові/постійні» — див. #102b");

  /**
   * 🔴 ДІЛИТЬСЯ САМЕ `thisMonth` (рішення власника). `awaitNoDate` — інша множина
   * (зона БЕЗ планової дати), і розкласти її тим самим підписом означало б
   * поставити правильний підпис до не тієї величини — той самий клас, що два
   * «очікуємо» на одному екрані.
   */
  const src = stripComments(readFileSync(path.join(ROOT, "backend", "src", "core", "metrics.ts"), "utf8"));
  const body = src.split("export async function expectedThisMonthByMgrKlass")[1]?.split("\nexport ")[0] ?? "";
  assert.ok(/planned_payment_at IS NOT NULL/.test(body) && /to_char\(\(now\(\)/.test(body),
    "🔴 розклад очікувань більше не прибитий до планової дати ПОТОЧНОГО місяця");
});

test("#104 НОВІ КОЛОНКИ: опційні, сортовні, з підказкою — і не ламають підсумків", () => {
  const cols = readFileSync(path.join(FE, "reportTableCols.ts"), "utf8");
  const NEW_COLS = ["convAd", "convLg", "factNew", "factRepeat", "expectNew", "expectRepeat"];
  for (const k of NEW_COLS) {
    const def = cols.split(`key: "${k}"`)[1]?.split("},")[0] ?? "";
    assert.ok(def.length > 0, `🔴 колонки ${k} немає в реєстрі`);
    assert.ok(/core: false/.test(def), `🔴 ${k} увімкнена за замовчуванням — вона мусить бути чипом`);
    assert.ok(/help: "/.test(def), `🔴 ${k} без підказки «що це і звідки»`);
    assert.ok(/val: \(m\)/.test(def), `🔴 ${k} без val() — сортувати нема чого`);
  }
  /**
   * 🔴 ЧАСТКИ НЕ ПОТРАПЛЯЮТЬ В АДИТИВНИЙ ПІДСУМОК. Грошові розрізи — `add`
   * (їх складати можна й треба); конверсії — ratio, бо це частки.
   */
  for (const k of ["factNew", "factRepeat", "expectNew", "expectRepeat"]) {
    const def = cols.split(`key: "${k}"`)[1]?.split("},")[0] ?? "";
    assert.ok(/foot: "add"/.test(def), `🔴 ${k} не сумується в підсумку — гроші адитивні`);
  }
  for (const k of ["convAd", "convLg"]) {
    const def = cols.split(`key: "${k}"`)[1]?.split("},")[0] ?? "";
    assert.ok(/foot: "ratio:conv(Ad|Lg)"/.test(def), `🔴 ${k} потрапила в адитивний підсумок — частку складати не можна`);
  }
  // Кожна нова колонка мусить мати РЕНДЕР, інакше чип є, а клітинка порожня (#81b-клас).
  const tsx = readFileSync(path.join(FE, "sections", "ReportTableSection.tsx"), "utf8");
  for (const k of NEW_COLS)
    assert.ok(new RegExp(`case "${k}":`).test(tsx), `🔴 у ${k} немає рендера — чип є, клітинка порожня`);
  // Липка перша колонка не зрушена.
  assert.ok(/className=\{c\.key === "name" \? "sticky-mgr" : undefined\}/.test(tsx),
    "🔴 липка перша колонка зникла");
});
