import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";
import { tabsForPath } from "../auth/routeTab.js";

/**
 * #677…#678b — РОУТИ ГРОШЕЙ З ПЕРЕДАЧ: одне джерело числа і списку, доступ як у `/leadgen-stats`,
 * відмова менеджеру — першим оператором.
 *
 * Читаємо ДЖЕРЕЛО роуту, а не HTTP: для проби потрібні живий сервер, ролі й дані — три
 * умови, кожна з яких дала б `skip`, і гейт мовчки не виконувався б. А стереже він рішення
 * власника, тож мусить триматись у звичайному `npm test`.
 */

const DASH = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "dashboard.ts"), "utf8");

/** Тіло обробника: від оголошення до закривної `});` у нульовій колонці. */
function handlerBody(src: string, route: string): string {
  const i = src.indexOf(`dashboardRouter.get("${route}"`);
  assert.ok(i > 0, `🔴 обробника ${route} у dashboard.ts немає — гейту нема що перевіряти`);
  const end = src.indexOf("\n});", i);
  assert.ok(end > i, `🔴 кінець обробника ${route} не знайдено`);
  return src.slice(i, end);
}



/**
 * #677 — ЧИСЛО В РЯДКУ І СПИСОК БЕРУТЬ ГРОШІ З ОДНІЄЇ ФУНКЦІЇ ЯДРА.
 *
 * `/leadgen-stats` → `handoffMoney` і `/leadgen-handoff-deals` → `totals` мусять збігатися за
 * той самий період і скоуп; екран порівнює їх і кричить «список не збігся». Гарантія —
 * не арифметика в роуті, а ОДИН виклик `leadgenHandoffMoney(` в обох (межа слова: сусід
 * `leadgenHandoffMoneyV2(` не зарахується), і жодного власного підсумку в роуті.
 * 🧨 САБОТАЖ: у `/leadgen-handoff-deals` рахувати `totals` через `aggregateHandoffMoney(hm.deals)` → червоніє.
 */
test("#677 ДЖЕРЕЛО: /leadgen-stats і /leadgen-handoff-deals беруть гроші з ОДНІЄЇ функції ядра", () => {
  for (const route of ["/leadgen-stats", "/leadgen-handoff-deals"]) {
    const body = handlerBody(DASH, route);
    assert.match(body, /\bleadgenHandoffMoney\(from, to, /, `🔴 ${route} не кличе спільну функцію ядра`);
    assert.doesNotMatch(body, /\b(aggregateHandoffMoney|handoffView|classifyHandoffs|pickHandoffs)\(/,
      `🔴 ${route} рахує підсумок САМ — список і число рядка розійдуться`);
  }
  assert.match(handlerBody(DASH, "/leadgen-stats"), /totals: handoffMoneyWire\(hm\.totals\)/);
  assert.match(handlerBody(DASH, "/leadgen-handoff-deals"), /totals: handoffMoneyWire\(hm\.totals\)/,
    "🔴 totals списку не з результату ядра");
  // 🪞 Дзеркало: детектор власного підсумку спрацьовує на підкинутому.
  assert.match("totals: aggregateHandoffMoney(hm.deals)", /\b(aggregateHandoffMoney|handoffView)\(/);
  assert.doesNotMatch("x = leadgenHandoffMoneyV2(from, to, s)", /\bleadgenHandoffMoney\(from, to, /,
    "🔴 межа слова не працює — перейменований двійник зарахувався б");
});

/**
 * #678 — ДОСТУП НОВИХ РОУТІВ РІВНО ЯК У `/leadgen-stats` (рішення власника 22.09.2026).
 *
 * Обидва боки: дозволені ролі ті самі, заборонені ті самі; вкладка — `leadgen`, прописана
 * ЯВНО (дефісного сусіда `pre()` не накриває, і роут без рядка лишився б без межі).
 * 🧨 САБОТАЖ: додати `"manager"` в allow рядка `/leadgen-trend` → червоніє.
 */
test("#678 ДОСТУП: нові роути — рядки матриці й вкладка як у /leadgen-stats", () => {
  const row = (p: string) => {
    const rs = ACCESS_MATRIX.filter((r) => r.method === "GET" && r.path === p);
    assert.equal(rs.length, 1, `🔴 рядок матриці для ${p}: ${rs.length} замість 1`);
    return rs[0];
  };
  const base = row("/api/dashboard/leadgen-stats");
  assert.ok(base.allow.includes("team_lead") && base.deny.includes("manager"), "еталон не той — порівнювати нема з чим");
  for (const p of ["/api/dashboard/leadgen-trend", "/api/dashboard/leadgen-handoff-deals"]) {
    const r = row(p);
    assert.deepEqual([...r.allow].sort(), [...base.allow].sort(), `🔴 ${p}: дозволені ролі не як у /leadgen-stats`);
    assert.deepEqual([...r.deny].sort(), [...base.deny].sort(), `🔴 ${p}: заборонені ролі не як у /leadgen-stats`);
    assert.equal(r.cls, "GET");
    assert.deepEqual(tabsForPath(p), ["leadgen"], `🔴 ${p} без вкладкової межі — дефісний сусід не накритий`);
  }
  // 🪞 Дзеркало: роут, якого не прописали, межі НЕ має — тобто перевірка вище не порожня.
  assert.equal(tabsForPath("/api/dashboard/leadgen-__nemaye"), null, "🔴 `pre()` накрив дефісного сусіда — перевірка беззуба");
});

/**
 * #1252 — ПЕРШИЙ ОПЕРАТОР ЧОТИРЬОХ GET-РОУТІВ ЕКРАНА: хто дивиться — і відмова НЕ-лідгену — ДО будь-якого 400.
 * Рішення власника 02.10.2026: лідген (роль «менеджер», учасник команди) бачить свою картку й підсумок
 * команди; менеджер продажу — 403 з поясненням. Тому вже не «менеджер — 403», а `leadgenViewerAuth` →
 * `leadgenViewer` → відмова `deny`, і ЛИШЕ потім розбір параметрів (інакше не-лідген дізнавався б форму
 * роуту з 400). Плюс: статистика й тренд для лідгена віддаються ЛИШЕ через білий список `ownLeadgen*Body`.
 * 🧨 САБОТАЖ: у `/leadgen-trend` перенести `const to = dateParam(…)` вище відмови → червоніє;
 * у `/leadgen-stats` віддати `res.json(body)` без `ownLeadgenStatsBody` → червоніє.
 */
const VIEWER_FIRST = [
  /^const auth = await leadgenViewerAuth\(req\.auth!\);$/,
  /^const viewer = leadgenViewer\(auth\);$/,
  /^if \(viewer\.kind === "deny"\) return res\.status\(403\)\.json\(\{ error: viewer\.error \}\);$/,
];
function firstStatements(body: string, n: number): string[] {
  const inner = body.slice(body.indexOf("=> {") + 4).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return inner.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).slice(0, n);
}
test("#1252 ПЕРШІ ОПЕРАТОРИ: хто дивиться → відмова не-лідгену раніше за 400; лідгену — лише білий список", () => {
  for (const route of ["/leadgen-stats", "/leadgen-trend", "/leadgen-handoff-deals", "/leadgen-plans"]) {
    const first = firstStatements(handlerBody(DASH, route), 3);
    VIEWER_FIRST.forEach((re, i) => assert.match(first[i] ?? "", re, `🔴 ${route}: оператор ${i + 1} — «${first[i]}»`));
  }
  assert.match(handlerBody(DASH, "/leadgen-stats"), /res\.json\(viewer\.kind === "own" \? ownLeadgenStatsBody\(body, viewer\.selfId\) : body\)/,
    "🔴 /leadgen-stats віддає лідгену повну відповідь — рядки, гроші й передачі колег");
  assert.match(handlerBody(DASH, "/leadgen-trend"), /res\.json\(viewer\.kind === "own" \? ownLeadgenTrendBody\(trend, viewer\.selfId\) : trend\)/,
    "🔴 /leadgen-trend віддає лідгену рядки колег");
  assert.doesNotMatch(codeOf(handlerBody(DASH, "/leadgen-stats")), /\bres\.json\(body\)/, "🔴 у /leadgen-stats є обхід білого списку");
  // 🪞 Дзеркало: детектор бачить неправильний порядок, а не зеленіє на все.
  const bad = 'dashboardRouter.get("/x", async (req, res) => {\n  const to = dateParam(req.query.to);\n'
    + '  const auth = await leadgenViewerAuth(req.auth!);\n  const viewer = leadgenViewer(auth);\n});';
  assert.doesNotMatch(firstStatements(bad, 1)[0], VIEWER_FIRST[0], "🔴 детектор першого оператора не бачить порядку");
});

/** Код без коментарів — щоб згадка виклику в коментарі не рахувалась ні «за», ні «проти». */
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * Порушення межі скоупу в тілі обробника: що саме йде в ядро третім аргументом.
 * Дозволено рівно два джерела — `scope` із `const scope = leadgenAuthScope(auth);` і
 * `clamp.scope` із `const clamp = handoffDealsScope(`. Будь-який літерал (`{ teamId: null, … }`),
 * інша змінна чи власний кламп `auth.role === "team_lead"` в обробнику — порушення.
 */
function scopeViolations(body: string): string[] {
  const code = codeOf(body);
  const calls = [...code.matchAll(/\b(leadgenHandoffMoney|leadgenTrend)\(([^()]*)\)/g)];
  const out: string[] = [];
  if (!calls.length) out.push("жодного виклику ядра з грошима/трендом");
  for (const c of calls) {
    // Скоуп — ТРЕТІЙ аргумент; після нього дозволено лише одиницю розбивки `grain` (задача 4668, гроші по тижнях).
    if (!/^\s*[\w.]+\s*,\s*[\w.]+\s*,\s*(scope|clamp\.scope)\s*(,\s*grain\s*)?$/.test(c[2])) out.push(`${c[1]}(${c[2].trim()})`);
  }
  if (calls.some((c) => /,\s*scope\s*(,\s*grain\s*)?$/.test(c[2])) && !/\bconst scope = leadgenAuthScope\(auth\);/.test(code)) {
    out.push("`scope` не з leadgenAuthScope(auth)");
  }
  if (calls.some((c) => /,\s*clamp\.scope\s*$/.test(c[2])) && !/\bconst clamp = handoffDealsScope\(/.test(code)) {
    out.push("`clamp` не з handoffDealsScope(");
  }
  if (/auth\.role === "team_lead"/.test(code)) out.push("власний кламп тімліда в обробнику");
  return out;
}

/**
 * #681b — У ЯДРО ЙДЕ СКОУП З ПОМІЧНИКА, А НЕ ЛІТЕРАЛ (ревʼю F1, правило 7).
 *
 * Привід заміряний ревʼюером: `{ teamId: null, managerId: null }` у `/leadgen-stats` і
 * `{ teamId: null, managerId }` у `/leadgen-handoff-deals` — тімлід отримує гроші й угоди
 * ВСІХ команд, а набір (1331 тест) лишався зеленим: `#677` дивився лише на ІМʼЯ функції.
 * Тут — на АРГУМЕНТ: у всіх трьох обробниках скоуп мусить бути результатом `leadgenAuthScope`
 * (або `clamp.scope` з `handoffDealsScope`, що будується на ньому), а рядки `/leadgen-stats`
 * ріжуться тим самим `scope.teamId`. Чистий бік (що помічник звужує правильно) — `#681`.
 * 🧨 САБОТАЖ: у `/leadgen-stats` передати `{ teamId: null, managerId: null }` → червоніє;
 * у `/leadgen-handoff-deals` — `{ teamId: null, managerId }` замість `clamp.scope` → червоніє.
 */
test("#681b ДЖЕРЕЛО: у ядро йде скоуп із leadgenAuthScope/clamp.scope, а не літерал — в усіх трьох роутах", () => {
  for (const route of ["/leadgen-stats", "/leadgen-trend", "/leadgen-handoff-deals"]) {
    assert.deepEqual(scopeViolations(handlerBody(DASH, route)), [], `🔴 ${route}: скоуп у ядро не з помічника`);
  }
  assert.match(codeOf(handlerBody(DASH, "/leadgen-stats")), /\bconst teamId = scope\.teamId;/,
    "🔴 /leadgen-stats ріже рядки не тим скоупом, що гроші");
  // 🪞 Дзеркало: детектор ловить саме ті поломки, які відтворив ревʼюер, і не зеленіє на все.
  const planted = (arg: string, pre = "  const scope = leadgenAuthScope(auth);\n") =>
    `dashboardRouter.get("/x", async (req, res) => {\n${pre}  const hm = await leadgenHandoffMoney(from, to, ${arg});\n`;
  assert.notDeepEqual(scopeViolations(planted("{ teamId: null, managerId: null }")), [],
    "🔴 детектор не бачить літерала, що віддає тімліду весь відділ");
  assert.notDeepEqual(scopeViolations(planted("{ teamId: null, managerId }")), []);
  assert.notDeepEqual(scopeViolations(planted("scope", "  const scope = { teamId: null, managerId: null };\n")), [],
    "🔴 детектор не бачить `scope`, складеного не помічником");
  assert.notDeepEqual(scopeViolations(planted("scope") + '  const teamId = auth.role === "team_lead" ? 1 : null;\n'), [],
    "🔴 детектор не бачить власного клампу тімліда");
  assert.deepEqual(scopeViolations(planted("scope")), [], "🔴 детектор червоніє і на правильному виклику — беззубий навпаки");
  // Четвертий аргумент `grain` (задача 4668) не відкриває шпарини: літерал перед ним ловиться, помічник — чистий.
  assert.deepEqual(scopeViolations(planted("scope, grain")), [], "🔴 детектор червоніє на правильному виклику з `grain`");
  assert.notDeepEqual(scopeViolations(planted("{ teamId: null, managerId: null }, grain")), [],
    "🔴 детектор не бачить літерала, захованого перед `grain`");
  assert.notDeepEqual(scopeViolations(planted("scope, { teamId: null }")), [], "🔴 після скоупу пропущено щось, крім `grain`");
  assert.deepEqual(scopeViolations("  // було: leadgenHandoffMoney(from, to, { teamId: null })\n" + planted("scope")), [],
    "🔴 згадка в коментарі читається як виклик");
});
