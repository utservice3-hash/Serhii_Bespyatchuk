import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsDb } from "../testMode.js";

/**
 * 🔀 #211f–#211i — Е4: ФАКТ КВП НЕ ЗАЛЕЖИТЬ ВІД ТИПУ КОМАНДИ.
 *
 * 📐 ЧОМУ ЦЕ ЗАВЕДЕНО (заміряно на проді 26.08.2026, не оцінено):
 * проєкція `/kvp-report` віддавала лише `ad`/`leadgen`, тож **44% створеного**
 * (1010 угод серпня, у РПК — 74.4%) не було на екрані ніде. Ядро рахувало всі
 * чотири кошики завжди; губила їх проєкція.
 *
 * 🔴 ПІДПИС ТРЕТЬОГО КАНАЛУ ОПИСУЄ ПРЕДИКАТ, А НЕ СЕНС — і це рішення власника,
 * підперте заміром: жоден позитивний підпис не переживає перевірки на ВСЬОМУ каналі
 * («створено вручну» — 13%; «постійні» — 71% у РПК і 19% у РНК). Ділити канал за
 * `client_source` теж не можна: всередині РПК ця межа дає 92% проти 95% повторних,
 * тобто не розрізняє нічого. Тому канал ОДИН, а розрізняє НОВИЗНА поруч.
 *
 * ⚠️ МЕЖА ПРОХОДУ, названа вголос: тип команди лишається в рушії РЕКОМЕНДАЦІЇ
 * (`/lead-recommendation`) — там він за задумом власника. Прибрано лише те, що
 * підміняло ФАКТ. `#211h` стереже обидві половини, інакше наступний «причесав би»
 * і рекомендацію теж.
 */

const src = (rel: string): string => {
  for (const p of [
    fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../backend/src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail(`не знайдено джерело ${rel} — гейт не має права мовчки пропускатись`);
};
const fe = (rel: string): string => {
  for (const p of [
    fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../../frontend/src/${rel}`, import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail(`не знайдено джерело фронта ${rel}`);
};
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/**
 * #211f — ЧОТИРИ КАНАЛИ Є ПАРТИЦІЄЮ СТВОРЕНОГО, І ТРЕТІЙ ДОЇЖДЖАЄ НА ЕКРАН.
 *
 * Дві половини, і друга важливіша: ядро рахувало `otherCount` і до цього проходу —
 * ламалась саме ПРОЄКЦІЯ. Тому мало перевірити інваріант у ядрі: треба ще й довести,
 * що число доїхало у відповідь роуту НЕНУЛЬОВИМ.
 *
 * 🪞 Контроль непорожності: якби створених не було зовсім, рівність `Σ == created`
 * трималась би на нулях і не доводила нічого.
 *
 * 🧨 САБОТАЖ (виконано): прибрати `other` з проєкції `createdSplit` у `dashboard.ts`
 * → червоніє друга половина; занулити `otherCount` у `createdSplitByManager` →
 * червоніє перша.
 */
test("#211f чотири канали == створено по кожному менеджеру, і третій доїжджає в роут (жива БД)", needsDb(), async () => {
  const metrics = await import("./metrics.js");
  const { pool } = await import("../db/pool.js");
  const FROM = "2026-08-01", TO = "2026-08-26";

  const rows = await metrics.createdSplitByManager({ from: FROM, to: TO });
  assert.ok(rows.length > 0, "🔴 жодного менеджера — гейту нема що перевіряти");
  const totCreated = rows.reduce((a, r) => a + r.created, 0);
  const totOther = rows.reduce((a, r) => a + r.otherCount, 0);
  assert.ok(totCreated > 0, "🔴 за період нуль створених — партиція трималась би на нулях");

  for (const r of rows) {
    const sum = r.adCount + r.leadgenCount + r.otherCount + r.noChannelCount;
    assert.equal(sum, r.created,
      `🔴 ${r.name}: Σ каналів ${sum} ≠ створено ${r.created} — партиція джерела розʼїхалась `
      + `(ad ${r.adCount} · leadgen ${r.leadgenCount} · other ${r.otherCount} · noChannel ${r.noChannelCount})`);
    const kl = r.newCount + r.repeatCount + r.undefCount;
    assert.equal(kl, r.created, `🔴 ${r.name}: Σ новизни ${kl} ≠ створено ${r.created}`);
  }
  assert.ok(totOther > 0,
    `🔴 третій канал порожній (${totOther}) — або дані змінились, або предикат зламано. `
    + "Заміряно 26.08.2026: 1010 угод серпня, 44% створеного");

  // ── друга половина: число доїхало у ВІДПОВІДЬ, а не лишилось у ядрі ──
  //
  // 🔴 `refreshRoles()` ОБОВʼЯЗКОВИЙ, і це не формальність: роль-кеш fail-closed, тож
  // без нього `roleHasTab` відмовляє й роут віддає порожнє тіло. Гейт тоді падає з
  // «немає команд» — тобто на власній помилці, а виглядає як дефект коду. Кеш
  // модульний: один виклик не лікує іншу збірку (той самий урок, що в golden-master).
  const rbac = await import("../auth/rbac.js");
  await rbac.refreshRoles();
  const { dashboardRouter } = await import("../routes/dashboard.js");
  const layer = (dashboardRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => void }[] } }[] })
    .stack.find((l) => l.route?.path === "/kvp-report" && l.route.methods.get);
  assert.ok(layer?.route, "🔴 роут /kvp-report не знайдено — гейт втратив предмет");
  const handle = layer!.route!.stack[layer!.route!.stack.length - 1].handle;
  const body = await new Promise<Record<string, unknown>>((done, fail) => {
    handle({ auth: { role: "admin", roleKey: "admin", managerId: null, teamId: null, userId: 0 },
      query: { from: FROM, to: TO, preset: "month", date: TO }, params: {} },
      { json(b: Record<string, unknown>) { done(b); }, status() { return this; },
        send() { done({}); }, setHeader() {} },
      (e?: unknown) => fail(e ?? new Error("роут пішов у next() без відповіді")));
  });

  const teams = body.teams as { managers: { name: string; createdSplit?: Record<string, number> }[] }[];
  assert.ok(Array.isArray(teams) && teams.length > 0, "🔴 у відповіді немає команд");
  const mgrs = teams.flatMap((t) => t.managers ?? []);
  assert.ok(mgrs.length > 0, "🔴 у відповіді немає менеджерів");
  const withSplit = mgrs.filter((m) => m.createdSplit);
  assert.ok(withSplit.length > 0, "🔴 у жодного менеджера немає `createdSplit`");
  for (const m of withSplit) {
    const cs = m.createdSplit!;
    assert.ok("other" in cs && "noChannel" in cs,
      `🔴 ${m.name}: у відповіді немає полів \`other\`/\`noChannel\` — третій канал знову губиться в ПРОЄКЦІЇ, `
      + "хоч ядро його рахує");
    assert.equal(cs.ad + cs.leadgen + cs.other + cs.noChannel, cs.created,
      `🔴 ${m.name}: Σ каналів у ВІДПОВІДІ ≠ created`);
  }
  const otherInBody = withSplit.reduce((a, m) => a + (m.createdSplit!.other ?? 0), 0);
  assert.ok(otherInBody > 0,
    `🔴 у відповіді третій канал = 0 при ${totOther} у ядрі — проєкція його зʼїдає`);
  await pool.query("SELECT 1");
});

/**
 * #211g — ФАКТ МАЛЮЄТЬСЯ ОДНАКОВО ВСІМ, І СТРУКТУРА НЕ ЗАЛЕЖИТЬ ВІД ТИПУ КОМАНДИ.
 *
 * Читається ДЖЕРЕЛО фронта, бо перевіряється саме відсутність умови: жодне число
 * тут не змінюється — змінюється те, кому воно видиме. HTTP цього не бачить.
 *
 * 🧨 САБОТАЖ (виконано): обгорнути `<MgrFactLine>` в `team.kind === "rnk" && …` →
 * червоніє; повернути `cols = 4 + (team.kind === "rnk" ? 1 : 0)` → червоніє.
 */
test("#211g рядок менеджера показує канали ВСІМ, і colSpan не залежить від типу команди", () => {
  const s = stripComments(fe("pages/dashboard/sections/KvpReportSection.tsx"));

  assert.match(s, /<MgrFactLine\s+cs=\{m\.createdSplit\}\s*\/>/,
    "🔴 рядок менеджера більше не малює факт за каналами — 44% створеного знову невидимі");
  // Умови по типу команди навколо факту бути не може: саме вона й ховала колонку «Конв».
  const factCtx = s.slice(Math.max(0, s.indexOf("<MgrFactLine") - 400), s.indexOf("<MgrFactLine") + 120);
  assert.doesNotMatch(factCtx, /team\.kind\s*===/,
    "🔴 біля факту зʼявилась умова по типу команди — ФАКТ від нього залежати не має "
    + "(рішення власника: залежить лише РЕКОМЕНДАЦІЯ)");

  assert.match(s, /const cols = 4;/,
    "🔴 `cols` знову рахується від типу команди — це colSpan таблиці, що має РІВНО 4 `<th>`");
  assert.doesNotMatch(s, /const cols = 4 \+ \(team\.kind/,
    "🔴 повернувся `4 + (team.kind === \"rnk\" ? 1 : 0)` — colSpan=5 у 4-колонковій таблиці");
});

/**
 * #211h — МЕРТВИЙ `isRnk` ПРИБРАНО, АЛЕ РУШІЙ РЕКОМЕНДАЦІЇ ТИП КОМАНДИ ЗБЕРІГ.
 *
 * 🔴 ДРУГА ПОЛОВИНА ВАЖЛИВІША ЗА ПЕРШУ. Односторонній гейт «`isRnk` ніде немає» був
 * би шкідливий: наступний, хто «причесує», прибрав би тип команди і з
 * `/lead-recommendation`, де він СТОЇТЬ ЗА ЗАДУМОМ власника (рекомендація для РПК —
 * лідгени + постійні, для РНК — пріоритет реклама). Дзеркало не дає це зробити.
 *
 * 📐 Мертвим він був наскрізь: роут віддавав `isRnk`, тип `api.ts` його оголошував,
 * `ManagerDetailDrill` брав пропсом — і НЕ діструктурував, тобто не читав. Разом із
 * ним пішов `RNK_MGR_TEAMS` — захардкожений дубль `metrics.RNK_TEAM_IDS`.
 *
 * 🧨 САБОТАЖ (виконано): повернути `isRnk` у відповідь роуту → червоніє перша
 * половина; прибрати `kvpTeamKind`/`RNK_TEAM_IDS` із `/lead-recommendation` →
 * червоніє дзеркало.
 */
test("#211h мертвий isRnk прибрано, тип команди в рекомендації збережено", () => {
  const route = stripComments(src("routes/dashboard.ts"));
  const api = stripComments(fe("api.ts"));
  const view = stripComments(fe("pages/dashboard/sections/KvpReportSection.tsx"));

  assert.doesNotMatch(api, /\bisRnk\b/,
    "🔴 `isRnk` повернувся в тип API — поле, якого не читає жоден компонент");
  assert.doesNotMatch(view, /\bisRnk\b/,
    "🔴 `isRnk` повернувся у фронт — це мертвий проп, він лише вдає, що щось означає");
  assert.doesNotMatch(route, /res\.json\(\{[^}]*\bisRnk\b/,
    "🔴 роут `/kvp-report/manager-report` знову віддає `isRnk`");
  assert.doesNotMatch(route, /RNK_MGR_TEAMS/,
    "🔴 повернувся `RNK_MGR_TEAMS` — захардкожений дубль `metrics.RNK_TEAM_IDS`");

  // 🪞 Дзеркало: у рекомендації тип команди МУСИТЬ лишитись.
  assert.match(route, /const isRnk = r\.team_id != null && metrics\.RNK_TEAM_IDS\.includes\(r\.team_id\)/,
    "🔴 з рушія рекомендації прибрали тип команди — а він там ЗА ЗАДУМОМ власника "
    + "(РПК: лідгени + постійні; РНК: пріоритет реклама). Прибирати треба було лише те, що підміняє ФАКТ");
  assert.match(route, /kvpTeamKind/,
    "🔴 зник `kvpTeamKind` — теги команд у звіті КВП тримаються на ньому");
});

/**
 * #211i — ПІДПИС І НОВИЗНА НЕ РОЗʼЇЖДЖАЮТЬСЯ: ВОНИ В ОДНОМУ ВИРАЗІ.
 *
 * 🔴 УМОВА ВЛАСНИКА, А НЕ ОФОРМЛЕННЯ. Сама назва «не реклама і не лідген» нічого не
 * пояснює — вона лише чесна; пояснює її сусіднє число «735, із них 523 постійні».
 * Якби підпис поїхав без новизни, екран став би гіршим, ніж був. Тому гейт вимагає,
 * щоб ОБИДВІ половини жили в ОДНОМУ компоненті: рознесені по різних місцях, вони
 * рано чи пізно розійдуться, і ніхто цього не побачить.
 *
 * ⚠️ Перевіряється ще й те, що новизна береться з `createdSplit` (канон ядра
 * `priorClientSql`), а не рахується на фронті: своє означення «є рання угода» дає
 * для РПК 92% замість 71% — інше число під тією самою назвою.
 *
 * 🧨 САБОТАЖ (виконано): прибрати чипи `нові`/`постійні` з `MgrFactLine` → червоніє;
 * прибрати `NO_CH_LABEL` з того ж компонента → червоніє.
 */
test("#211i підпис третього каналу і новизна живуть в ОДНОМУ виразі", () => {
  const s = fe("pages/dashboard/sections/KvpReportSection.tsx");
  const m = /function MgrFactLine[\s\S]*?\n\}/.exec(s);
  assert.ok(m, "🔴 не знайдено `MgrFactLine` — компонент факту зник або перейменований");
  const body = stripComments(m![0]);

  assert.match(body, /NO_CH_LABEL/,
    "🔴 у компоненті факту немає підпису третього каналу");
  assert.match(body, /chip\("нові", cs\.new/,
    "🔴 з компонента факту зникла НОВИЗНА («нові») — підпис лишився без того, що його пояснює");
  assert.match(body, /chip\("постійні", cs\.repeat/,
    "🔴 з компонента факту зникли «постійні» — саме це число робить підпис зрозумілим");
  assert.match(body, /cs\.ad|cs\.leadgen/,
    "🔴 з компонента факту зникли решта каналів — третій без них не читається як третій");

  assert.equal(stripComments(s).split("NO_CH_LABEL").length - 1 >= 2, true,
    "🔴 підпис не використовується — константа є, а на екрані її немає");
  assert.match(stripComments(s), /const NO_CH_LABEL = "не реклама і не лідген";/,
    "🔴 підпис третього каналу змінено. Це рішення власника 26.08.2026, підперте заміром: "
    + "будь-який позитивний підпис («своя база», «створено вручну») не переживає перевірки "
    + "на всьому каналі — 13% і 71%/19% відповідно");
});

/**
 * #211j — ПІДПИС ПРО ДРЕЙФ СТОЇТЬ БІЛЯ БЛОКУ КАНАЛІВ І НЕ Є ТУЛТИПОМ.
 *
 * 🔴 ЧОМУ ГЕЙТ, А НЕ «ми ж написали». Заміряно 26.08.2026: `reclassifyAdChannel`
 * переставляє канал ЗАДНІМ ЧИСЛОМ щосинку — той самий місяць, відкритий двічі, дає
 * різні числа (110 → 112 за ~40 хв; 81 угода серпня зі зрушеним `updated_at_kommo`
 * за годину). Ми щойно ці числа ПОКАЗАЛИ, тож питання довіри створили самі.
 *
 * Три умови власника, і кожна перевіряється окремо:
 *   ① підпис існує ДОСЛІВНО — переписати його «щоб коротше» не можна, це рішення;
 *   ② він у `CalmManagers` — тобто в тому самому блоці, де малюються канали, а не
 *     внизу сторінки: число і пояснення мусять бути видимі ОДНОЧАСНО;
 *   ③ він НЕ тултип-онлі — людина, яка вже засумнівалась у числі, підказку при
 *     наведенні шукати не буде.
 *
 * 🧨 САБОТАЖ (виконано): прибрати рядок із `CalmManagers` → червоніє ②;
 * лишити текст лише всередині `InfoHint text={DRIFT_NOTE}` → червоніє ③;
 * змінити формулювання → червоніє ①.
 */
test("#211j підпис про дрейф каналів — біля блоку, текстом, а не тултипом", () => {
  const raw = fe("pages/dashboard/sections/KvpReportSection.tsx");
  const s = stripComments(raw);

  // ① дослівність
  assert.match(s, /const DRIFT_NOTE = "Канали уточнюються: атрибуція перераховується щопівгодини, тому числа за минулі періоди можуть змінитись на одиниці\.";/,
    "🔴 текст підпису змінено. Це рішення власника 26.08.2026 разом із формулюванням: "
    + "він мусить читатись як ФАКТ («останній дотик» переоцінюється за побудовою), а не як вибачення за баг");

  // ② прив'язка до блоку каналів: підпис усередині того самого компонента, що малює канали
  const m = /function CalmManagers[\s\S]*?\n\}/.exec(s);
  assert.ok(m, "🔴 не знайдено `CalmManagers` — компонент блоку каналів зник або перейменований");
  assert.match(m![0], /\{DRIFT_NOTE\}/,
    "🔴 підпис відірвано від блоку каналів. Він мусить бути там само, де числа: пояснення, "
    + "якого не видно поруч зі зміненим числом, не пояснює нічого");
  assert.match(m![0], /<MgrFactLine/,
    "🔴 у `CalmManagers` більше немає рядка каналів — гейт прив'язує підпис не до того блоку");

  // ③ не тултип-онлі: текст рендериться, а не лише передається в підказку
  const usages = [...s.matchAll(/\{DRIFT_NOTE\}/g)].length;
  assert.ok(usages > 0, "🔴 `DRIFT_NOTE` оголошено й не використано — підпис є лише в коді");
  assert.doesNotMatch(s, /InfoHint\s+text=\{DRIFT_NOTE\}/,
    "🔴 підпис перетворили на тултип. Людина, яка вже помітила розбіжність і засумнівалась, "
    + "підказку при наведенні не шукатиме — вона піде питати, чи екран бреше");
});
