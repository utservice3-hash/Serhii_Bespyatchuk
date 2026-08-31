#!/usr/bin/env node
/**
 * ОДНОРАЗОВИЙ інструмент переїзду CLAUDE.md → .claude/rules/* + .claude/skills/deploy (коміт A).
 *
 * Гейт Г1 (звірка вцілілості, БІЖИТЬ ПЕРЕД БУДЬ-ЯКИМ ЗАПИСОМ):
 *   1. файл розбирається на одиниці (розділи ##, підрозділи ###/####, буліти) БЕЗ втрат:
 *      конкатенація одиниць у вихідному порядку мусить дорівнювати файлу байт-у-байт;
 *   2. кожна одиниця має РІВНО ОДНУ адресу з мапи; одиниця без адреси або адреса без
 *      одиниці — зупинка з назвою (це і є «розділ, який нікуди не переїхав, — втрата»);
 *   3. Σ байтів(корінь після + всі нові файли) == байти джерела + явно названі НОВІ байти
 *      (frontmatter, мітки ПРОЦЕДУРА, 1 структурна правка рівня заголовка секретів).
 * Якщо хоч один пункт не сходиться — на диск не пишеться НІЧОГО.
 *
 * Зміст одиниць НЕ редагується (байт-у-байт). Єдина структурна правка, названа явно:
 * заголовок «### 🔒 ЩО НІКОЛИ НЕ ПЕРЕДАЄТЬСЯ В ЧАТ» → «## …» (у корені він більше не
 * вкладений у розділ «Відновлення доступу», який їде у скіл deploy).
 */
import fs from "node:fs";
import path from "node:path";

const SRC = "CLAUDE.md";
const REPORT = "tools/claudemd-split-report.txt";
const TOK = 0.331; // заміряно: 96.6к токенів /context ÷ ~292к БАЙТ попередника ≈ 0.33
// ⚠️ Усі числа звіту — БАЙТИ UTF-8 (як wc -c та awk length у обмірі), НЕ String.length:
// кирилиця в UTF-16 рахується 1, в UTF-8 — 2, і перша редакція звіту на цьому збрехала б.
const B = (s) => Buffer.byteLength(s, "utf8");

// ---------------- адреси ----------------
const DEST_FILES = {
  ROOT: SRC,
  MONEY: ".claude/rules/money-core.md",
  SCREENS: ".claude/rules/report-screens.md",
  CLIENTS: ".claude/rules/clients.md",
  RECV: ".claude/rules/receivables.md",
  CHAN: ".claude/rules/channels-leadgen.md",
  JOBS: ".claude/rules/jobs-sync.md",
  TEST: ".claude/rules/testing.md",
  ACCESS: ".claude/rules/access-roles.md",
  FRONT: ".claude/rules/frontend.md",
  TASKS: ".claude/rules/tasks-kpi.md",
  STUCK: ".claude/rules/stuck-deals.md",
  STATS: ".claude/rules/statistics.md",
  DB: ".claude/rules/db-sql.md",
  DEPLOY: ".claude/skills/deploy/SKILL.md",
};

const fm = (globs) => "---\npaths:\n" + globs.map((g) => `  - "${g}"`).join("\n") + "\n---\n\n";

const FRONTMATTER = {
  MONEY: fm([
    "backend/src/core/money*", "backend/src/core/moneyBuckets*", "backend/src/core/plans.ts",
    "backend/src/core/metrics.ts", "backend/src/core/reportCuts.ts", "backend/src/core/week*",
    "backend/src/core/forecast*", "backend/src/core/dates.ts", "backend/src/routes/dashboard.ts",
  ]),
  SCREENS: fm([
    "backend/src/routes/dashboard.ts", "backend/src/routes/teams.ts", "backend/src/core/dayItems*",
    "frontend/src/pages/Dashboard.tsx", "frontend/src/pages/dashboard/sections/Report*",
    "frontend/src/pages/dashboard/sections/Overview*", "frontend/src/pages/dashboard/sections/Manager*",
    "frontend/src/pages/dashboard/sections/Kvp*", "frontend/src/pages/dashboard/sections/Teams*",
  ]),
  CLIENTS: fm([
    "backend/src/core/clientSegments.ts", "backend/src/core/clientArchive.ts",
    "backend/src/core/reactivation*", "backend/src/core/loyaltyOverride.ts",
    "backend/src/core/orphanClients.ts", "backend/src/routes/clientPlanRules.ts",
    "backend/src/jobs/clientKeySql.ts", "frontend/src/pages/dashboard/sections/Client*",
    "frontend/src/pages/dashboard/sections/Reactivation*", "frontend/src/pages/dashboard/sections/Loyalty*",
    "frontend/src/pages/dashboard/sections/Merge*", "frontend/src/pages/dashboard/sections/Orphan*",
    "frontend/src/pages/dashboard/sections/Archive*", "frontend/src/pages/dashboard/sections/RepeatPlanGrid.tsx",
  ]),
  RECV: fm([
    "backend/src/core/receivables*", "backend/src/jobs/syncReceivables.ts", "backend/src/jobs/receivable*",
    "frontend/src/pages/dashboard/sections/Receivables*", "frontend/src/pages/dashboard/receivablesView.ts",
    "frontend/src/pages/dashboard/sections/Writeoff*",
  ]),
  CHAN: fm([
    "backend/src/core/channelPartition*", "backend/src/core/klassFilter.ts",
    "backend/src/jobs/syncTransfers.ts", "backend/src/jobs/syncFirstTouch.ts",
    "backend/src/jobs/syncRingostatCalls.ts", "backend/src/jobs/backfillLeadgenTouch.ts",
    "backend/src/jobs/backfillWebTags.ts", "frontend/src/pages/dashboard/sections/Leadgen*",
    "frontend/src/pages/dashboard/sections/PlansSection.tsx",
  ]),
  JOBS: fm([
    "backend/src/jobs/**", "backend/src/kommo/**", "backend/src/index.ts",
    "backend/src/core/reconcile.ts", "backend/src/db/copyStreamPatch.ts",
  ]),
  TEST: fm([
    "backend/src/**/*.test.ts", "backend/src/testManifest.ts", "backend/src/testMode.ts",
    "backend/src/testReadOnly.ts", "backend/src/testRunGate.ts", "backend/src/db/scratchDb.ts",
    "backend/src/tools/sabotage.ts", "backend/src/tools/testDelta.ts", "backend/src/tools/gateCount.ts",
  ]),
  ACCESS: fm([
    "backend/src/auth/**", "backend/src/routes/auth.ts", "backend/src/routes/settings.ts",
    "backend/src/routes/bank.ts", "backend/src/db/roleDeclarations.ts", "backend/src/bankSources/**",
    "frontend/src/pages/dashboard/sections/SettingsSection.tsx",
    "frontend/src/pages/dashboard/sections/BankSection.tsx",
  ]),
  FRONT: fm(["frontend/**"]),
  TASKS: fm([
    "backend/src/routes/tasks.ts", "backend/src/jobs/evaluateKpiTasks.ts", "backend/src/core/kpiTargets.ts",
    "frontend/src/pages/dashboard/sections/TasksSection.tsx", "frontend/src/pages/dashboard/taskForm.ts",
  ]),
  STUCK: fm([
    "backend/src/core/stuck*", "backend/src/jobs/syncDealActivity.ts",
    "frontend/src/pages/dashboard/sections/StuckDealsCard.tsx",
  ]),
  STATS: fm([
    "backend/src/statistics/**", "backend/src/routes/statistics.ts", "backend/src/routes/statisticsSeries.ts",
    "frontend/src/pages/dashboard/sections/Statistics*",
  ]),
  DB: fm(["backend/src/**"]),
  DEPLOY:
    "---\nname: deploy\ndescription: Викат на прод UTS Dashboard, рестарт і відновлення доступу після перестворення контейнера. Викликати перед будь-яким деплоєм/рестартом або коли relay чи git-checkout виглядають зламаними. Канон процедури — docs/INFRASTRUCTURE.md §7.\n---\n\n",
};

// ---------------- мапа адрес ----------------
// [підрядок першого рядка одиниці, адреса]. Кожен ключ мусить спрацювати РІВНО раз.
const SECTIONS = [
  ["ПЕРШІ 60 СЕКУНД", "ROOT"],
  ["«УСПІХ ЗА 0 МС»", "JOBS"],
  ["ПРАВИЛА РОБОТИ (додано", "ROOT"],
  ["ПРОМТ — ЦЕ ЗАВДАННЯ", "ROOT"],
  ["МЕХАНІЗМИ — що вже", "ROOT"],
  ["УМОВНІ — що має стати", "ROOT"],
  ["ПРАВИЛА, КУПЛЕНІ 26-28.08", "ROOT"],
  ["Деплой і інфраструктура", "SPLIT_DEPLOY"],
  ["Структура фронту", "FRONT"],
  ["Ключові бізнес-правила", "SPLIT_BIZ"],
  ["## Kommo", "JOBS"],
  ["ВІДКАТ КОДУ ≠ ВІДКАТ НАСЛІДКІВ", "DEPLOY"],
  ["GOLDEN-MASTER", "TEST"],
  ["ОДНАКОВА ПОМИЛКА З ОБОХ БОКІВ", "TEST"],
  ["ТЕСТ, ЩО ПІДНІМАЄ ВЛАСНИЙ КЛАСТЕР", "TEST"],
  ["ТЕКСТ У СПИСКУ НЕ ПЕРЕВІРЯЄ", "TEST"],
  ["ДЕШЕВИЙ ФРАГМЕНТ ОТРУЮЄ", "MONEY"],
  ["«ФИНАНСОВЫЙ ОТДЕЛ»", "CLIENTS"],
  ["«БЕЗ КОМПАНІЇ» ЗАЛЕЖИТЬ", "CLIENTS"],
  ["ОД — КЛІЄНТИ ЙДУТЬ У ПУЛ", "CLIENTS"],
  ["ЗАПИСИ ДЗВІНКІВ — ПРЯМИЙ ЛІНК", "CLIENTS"],
  ["ДУБЛІ КОРИСТУВАЧІВ У KOMMO", "SCREENS"],
  ["«РЕАЛІЗАЦІЯ % ПЕРЕВЕЗЕНЬ»", "MONEY"],
  ["НЕВІДОМЕ МАЄ ЧИТАТИСЬ", "FRONT"],
  ["«ЗІБРАВ І НЕ ПЕРЕЗАПУСТИВ»", "DEPLOY"],
  ["`ON CONFLICT` — СПЕКУЛЯТИВНА", "DB"],
  ["ВІДНОВЛЕННЯ ДОСТУПУ ПІСЛЯ", "SPLIT_ACCESSREC"],
  ["SQL НЕ ТИПІЗУЄТЬСЯ", "DB"],
  ["ЗНАМЕННИК `/lead-recommendation`", "CHAN"],
  ["ДОКРУТ: НУЛЬ ПОКОЛІНЬ АСЕТІВ", "FRONT"],
  ["СПІЛЬНИЙ ТРАНСПІЛЯТОР", "TEST"],
  ["УХВАЛЕНО, АЛЕ НЕ ВИКОНАНО", "ROOT"],
  ["РОЗКРИТТЯ ПОЯСНЮЄ ЧИСЛО", "SCREENS"],
  ["НАЯВНІСТЬ АРТЕФАКТУ", "JOBS"],
  ["ПРИБИРАЄШ ІНВАРІАНТУ", "ROOT"],
  ["DEFINITION OF DONE", "ROOT"],
  ["ЗЕЛЕНА ДЖОБА ≠ ДАНІ", "JOBS"],
  ["ПРИВʼЯЗАНА ДО НАЯВНОСТІ СТАНУ", "TEST"],
  ["Тести — ОДИН набір", "TEST"],
  ["Рішення власника по доступах", "ACCESS"],
  ["«ВИКОНАЛОСЬ 450 ІЗ 466»", "TEST"],
  ["ТРИ ВИДИ ГЕЙТА", "TEST"],
  ["ПІСЛЯ БУДЬ-ЯКОЇ ПРАВКИ — ПОВНИЙ НАБІР", "TEST"],
  ["Джоби (backend/src/jobs)", "JOBS"],
  ["Реактивація — критерії", "CLIENTS"],
  ["Розділи дашборду", "ROOT"],
  ["Статистики (відділи)", "STATS"],
  ["Звіт (`report`)", "SCREENS"],
  ["Задачник KPI", "TASKS"],
  ["Застряглі угоди", "STUCK"],
  ["Звіт КВП", "SCREENS"],
  ["## Налаштування", "ACCESS"],
  ["## Брендинг", "FRONT"],
  ["Оптимізація витрат", "ROOT"],
];

const BIZ = [
  ["### ГРОШОВІ МЕТРИКИ", "MONEY"],
  ["ДВІ МЕТРИКИ, ① — ОСНОВНА", "MONEY"],
  ["КАРТКА МЕНЕДЖЕРА ПЕРЕВЕДЕНА", "MONEY"],
  ["КОРЗИНИ ГРОШЕЙ", "MONEY"],
  ["ДИНАМІЧНИЙ ПЛАН ТИЖНЯ", "MONEY"],
  ["ДВА КАЛЕНДАРІ РОБОЧИХ ДНІВ", "MONEY"],
  ["ЗВІЛЬНЕНІ З ГРІШМИ", "MONEY"],
  ["АКТИВНІСТЬ МЕНЕДЖЕРА МАЄ", "MONEY"],
  ["ЗЕЛЕНІ ГЕЙТИ ТРИЧІ ПОСПІЛЬ", "TEST"],
  ["ІСТОРІЇ ПРОГОНІВ ДЖОБ НЕМАЄ", "JOBS"],
  ["ЗАДАЧНИК — ЗОВНІШНЯ", "TASKS"],
  ["ЖОДЕН ПОКАЗНИК НЕ МАЄ ДВОХ ДЖЕРЕЛ", "SCREENS"],
  ["СТАНИ МЕНЕДЖЕРІВ — ТРИ", "SCREENS"],
  ["ГРОШІ ЗВІЛЬНЕНИХ — У СУМІ", "SCREENS"],
  ["РУЧНА ЦІЛЬ ПЕРЕКРИВАЄ", "SCREENS"],
  ["ДІЯ, ДОСТУПНА В ІНТЕРФЕЙСІ", "ACCESS"],
  ["ПЛАН КОМАНДИ = Σ", "MONEY"],
  ["ПЕРЕБУДОВА РЯДКА МЕНЕДЖЕРА", "SCREENS"],
  ["подвійну ознаку активності", "SCREENS"],
  ["ВКЛАДЕНИЙ ПЕРІОД", "MONEY"],
  ["ДВА «ОЧІКУЄМО»", "SCREENS"],
  ["ЗАКРИВАЮТЬСЯ ПОЗА FC-ВОРОНКАМИ", "MONEY"],
  ["МІНУС НА «ПЕРЕВЕЗЕННЯ ЗАВЕРШЕНО»", "MONEY"],
  ["ДОБІР — ОКРЕМА КОЛОНКА", "MONEY"],
  ["### Звірка ядра", "JOBS"],
  ["### AUTO-HEAL", "JOBS"],
  ["### Воронка «Повний цикл»", "MONEY"],
  ["### Угода = відправлене авто", "MONEY"],
  ["### Два якорі дати", "MONEY"],
  ["### Мертві поля", "MONEY"],
  ["### Решта правил", "SPLIT_RESHTA"],
];

const RESHTA = [
  ["**Угоди (KPI", "MONEY"],
  ["**Воронка продажів**", "MONEY"],
  ["**Конверсія — це ТРИ", "CHAN"],
  ["**Канали команд**", "CHAN"],
  ["**Реатрибуція каналів", "CHAN"],
  ["**Ліди з реклами", "CHAN"],
  ["КОНТАКТ = РОЗМОВА", "CHAN"],
  ["РЕКЛАМНИЙ ДОТИК", "CHAN"],
  ["UTM У ДЗВІНКАХ", "CHAN"],
  ["adSources", "CHAN"],
  ["Мінусові угоди", "MONEY"],
  ["**Нові клієнти**", "CLIENTS"],
  ["ХТО Є ПОСТІЙНИМ", "CLIENTS"],
  ["«АРХІВ» ≠ «ДАВНО", "CLIENTS"],
  ["КВАЛІФІКАЦІЯ ≠ СЕГМЕНТ", "CLIENTS"],
  ["ВВАЖАТИ ПОСТІЙНИМ ПОПРИ", "CLIENTS"],
  ["ЖОРСТКИЙ ПОДІЛ ЕКРАНІВ", "CLIENTS"],
  ["ТЕЛЕФОННІ ДЖЕНЕРИКИ", "CLIENTS"],
  ["ГОРИЗОНТ ДАНИХ", "CLIENTS"],
  ["План по постійних клієнтах", "CLIENTS"],
  ["ЕКРАН КЛІЄНТІВ — подача", "CLIENTS"],
  ["Дебіторка — деталізація", "RECV"],
  ["Готівкові клієнти в дебіторці", "RECV"],
  ["Передані заявки → Успішно", "CHAN"],
  ["**Лідогенерація**", "CHAN"],
  ["is_active` КЕРУЄ СПИСКАМИ", "MONEY"],
  ["«САМОСТІЙНІ» РОЗФОРМОВАНО", "JOBS"],
  ["Σ(команди) ≠ Σ(компанія)", "SCREENS"],
  ["Командний розріз історії", "SCREENS"],
  ["Дебіторка ↔ Реактивація", "CLIENTS"],
  ["funnel_stage` values", "MONEY"],
  ["Дати ЗАВЖДИ по-київськи", "ROOT"],
  ["Звірка успіху (ЗАВЕРШЕНИЙ", "MONEY"],
  ["СЛОВНИК МЕТРИК", "MONEY"],
];

const DEPLOY_BULLETS = [
  ["Гілки:", "ROOT"],
  ["Довгі збірки", "DEPLOY"],
  ["Важкі backfill", "JOBS"],
  ["ПЕРЕД будь-яким важким бекфілом", "JOBS"],
  ["ВАЖКИЙ `UPDATE` ПО `deals`", "JOBS"],
];

const ACCESSREC = [
  ["ПРАВИЛО: ПЕРЕД ДІЄЮ, ЩО ЩОСЬ ВІДНОВЛЮЄ", "DEPLOY"],
  ["ЩО НІКОЛИ НЕ ПЕРЕДАЄТЬСЯ В ЧАТ", "ROOT"],
  ["ПРАВИЛЬНИЙ СПОСІБ РАХУВАТИ", "DEPLOY"],
];

// Мітка ПРОЦЕДУРА (прохання власника 31.08.2026): позначити, не переносити.
const PROC_LABEL =
  "> 🏷 ПРОЦЕДУРА — покроковий ритуал; наступним проходом піде в скіл (~40 резидентних токенів опису). Мітка 31.08.2026, цим проходом не переносився.";
const PROC_TARGETS = ["ПРАВИЛА РОБОТИ (додано", "DEFINITION OF DONE", "УХВАЛЕНО, АЛЕ НЕ ВИКОНАНО"];

// ---------------- розбір ----------------
const text = fs.readFileSync(SRC, "utf8");
const lines = text.split("\n");
const content = (a, b) => lines.slice(a, b).join("\n") + (b < lines.length ? "\n" : "");

const errors = [];
const usage = new Map(); // key -> count
const pick = (maps, line, ctx) => {
  const hits = [];
  for (const m of maps) for (const [k, d] of m) if (line.includes(k)) hits.push([k, d]);
  if (hits.length !== 1) {
    errors.push(`${ctx}: ${hits.length} збігів для «${line.slice(0, 70)}»${hits.length ? " → " + hits.map(h => h[0]).join(" | ") : ""}`);
    return null;
  }
  usage.set(hits[0][0], (usage.get(hits[0][0]) || 0) + 1);
  return hits[0][1];
};

const units = []; // {dest, label, start, end}
const push = (dest, label, a, b) => units.push({ dest, label: label.slice(0, 76), start: a, end: b });

// межі ## розділів
const h2 = [];
lines.forEach((l, i) => { if (l.startsWith("## ")) h2.push(i); });
push("ROOT", "(преамбула)", 0, h2[0]);

const subSplit = (a, b, re) => { // повертає [межі] підблоків від a до b за регекспом стартового рядка
  const marks = [];
  for (let i = a; i < b; i++) if (re.test(lines[i])) marks.push(i);
  return marks;
};

for (let s = 0; s < h2.length; s++) {
  const a = h2[s], b = s + 1 < h2.length ? h2[s + 1] : lines.length;
  const head = lines[a];
  const dest = pick([SECTIONS], head, "розділ ##");
  if (!dest) continue;

  if (dest === "SPLIT_BIZ") {
    const marks = subSplit(a + 1, b, /^### |^#### /);
    push("ROOT", head + " (заголовок лишається в корені)", a, marks[0]); // ## рядок + порожні
    for (let m = 0; m < marks.length; m++) {
      const ma = marks[m], mb = m + 1 < marks.length ? marks[m + 1] : b;
      const sd = pick([BIZ], lines[ma], "підрозділ бізнес-правил");
      if (!sd) continue;
      if (sd === "SPLIT_RESHTA") {
        const bl = subSplit(ma + 1, mb, /^- \*\*/);
        push("MONEY", lines[ma] + " (шапка)", ma, bl[0]);
        for (let k = 0; k < bl.length; k++) {
          const ka = bl[k], kb = k + 1 < bl.length ? bl[k + 1] : mb;
          const bd = pick([RESHTA], lines[ka], "буліт Решти правил");
          if (bd) push(bd, lines[ka], ka, kb);
        }
      } else push(sd, lines[ma], ma, mb);
    }
  } else if (dest === "SPLIT_DEPLOY") {
    const bl = subSplit(a + 1, b, /^- /);
    push("ROOT", head + " (вступ + вказівник на INFRASTRUCTURE.md)", a, bl[0]);
    for (let k = 0; k < bl.length; k++) {
      const ka = bl[k], kb = k + 1 < bl.length ? bl[k + 1] : b;
      const bd = pick([DEPLOY_BULLETS], lines[ka], "буліт Деплою");
      if (bd) push(bd, lines[ka], ka, kb);
    }
  } else if (dest === "SPLIT_ACCESSREC") {
    const marks = subSplit(a + 1, b, /^### /);
    push("DEPLOY", head + " (вступ)", a, marks[0]);
    for (let m = 0; m < marks.length; m++) {
      const ma = marks[m], mb = m + 1 < marks.length ? marks[m + 1] : b;
      const sd = pick([ACCESSREC], lines[ma], "підрозділ Відновлення доступу");
      if (sd) push(sd, lines[ma], ma, mb);
    }
  } else push(dest, head, a, b);
}

// кожен ключ мапи мусив спрацювати рівно раз
for (const m of [SECTIONS, BIZ, RESHTA, DEPLOY_BULLETS, ACCESSREC])
  for (const [k] of m) {
    const n = usage.get(k) || 0;
    if (n !== 1) errors.push(`ключ мапи «${k}»: спрацював ${n} раз(и) — очікувався рівно 1`);
  }

// партиція без дірок і перекриттів + байт-у-байт
units.sort((u, v) => u.start - v.start);
let cursor = 0, rebuilt = "";
for (const u of units) {
  if (u.start !== cursor) errors.push(`дірка/перекриття перед рядком ${u.start + 1} («${u.label}»)`);
  u.content = content(u.start, u.end);
  u.bytes = B(u.content);
  cursor = u.end;
  rebuilt += u.content;
}
if (cursor !== lines.length) errors.push(`хвіст файлу після рядка ${cursor} нікуди не віднесено`);
if (rebuilt !== text) errors.push(`конкатенація одиниць ≠ джерелу (${rebuilt.length} проти ${text.length} байт)`);

if (errors.length) {
  console.error("Г1 ЧЕРВОНИЙ — на диск не записано нічого:");
  for (const e of errors) console.error("  ✖ " + e);
  process.exit(1);
}

// ---------------- збирання виходів ----------------
// структурна правка (єдина, названа): секрети ### → ## у корені
let structDelta = 0;
for (const u of units)
  if (u.dest === "ROOT" && u.content.startsWith("### 🔒 ЩО НІКОЛИ НЕ ПЕРЕДАЄТЬСЯ")) {
    u.content = u.content.replace(/^### /, "## ");
    structDelta += B(u.content) - u.bytes;
  }
// мітки ПРОЦЕДУРА
let labelBytes = 0;
for (const u of units)
  if (u.dest === "ROOT" && PROC_TARGETS.some((t) => u.label.includes(t))) {
    const nl = u.content.indexOf("\n");
    u.content = u.content.slice(0, nl + 1) + PROC_LABEL + "\n" + u.content.slice(nl + 1);
    labelBytes += B(PROC_LABEL) + 1;
  }

const byDest = new Map();
for (const u of units) {
  if (!byDest.has(u.dest)) byDest.set(u.dest, []);
  byDest.get(u.dest).push(u);
}

let fmBytes = 0;
const outFiles = new Map(); // path -> content
for (const [dest, us] of byDest) {
  const body = us.map((u) => u.content).join("");
  if (dest === "ROOT") outFiles.set(SRC, body);
  else {
    const front = FRONTMATTER[dest];
    fmBytes += B(front);
    outFiles.set(DEST_FILES[dest], front + body);
  }
}

// фінальна рівність: Σ записаного == джерело + названі нові байти
const written = [...outFiles.values()].reduce((s, c) => s + B(c), 0);
const expected = B(text) + fmBytes + labelBytes + structDelta;
if (written !== expected) {
  console.error(`Г1 ЧЕРВОНИЙ: Σ записаного ${written} ≠ джерело ${B(text)} + frontmatter ${fmBytes} + мітки ${labelBytes} + структурна ${structDelta} = ${expected}`);
  process.exit(1);
}

// ---------------- запис + звіт ----------------
for (const [p, c] of outFiles) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}

const linesOut = [];
linesOut.push("Г1 — ЗВІРКА ВЦІЛІЛОСТІ ПЕРЕЇЗДУ CLAUDE.md (" + new Date().toISOString().slice(0, 10) + ")");
linesOut.push(`джерело: ${B(text)} байт UTF-8, ${lines.length} рядків, ${units.length} одиниць`);
linesOut.push("");
linesOut.push("ПІДСУМКИ ЗА АДРЕСАМИ (байти UTF-8 змісту, без frontmatter; ≈токени ×" + TOK + "):");
const totals = [...byDest.entries()].map(([d, us]) => [d, us.reduce((s, u) => s + u.bytes, 0), us.length]);
totals.sort((x, y) => y[1] - x[1]);
for (const [d, b, n] of totals)
  linesOut.push(`  ${String(b).padStart(7)}  ≈${String(Math.round((b * TOK) / 100) / 10).padStart(6)}к ток  ${String(n).padStart(3)} од.  ${DEST_FILES[d]}`);
linesOut.push("");
linesOut.push(`РІВНЯННЯ: Σ записаного ${written} == джерело ${text.length} + frontmatter ${fmBytes} + мітки ПРОЦЕДУРА ${labelBytes} + правка рівня заголовка секретів ${structDelta} ✓`);
linesOut.push("");
linesOut.push("ПОІМЕННИЙ ПЕРЕЛІК (адреса ← байти ← перший рядок одиниці):");
for (const u of units) linesOut.push(`  ${u.dest.padEnd(8)} ${String(u.bytes).padStart(7)}  ${u.label}`);
fs.writeFileSync(REPORT, linesOut.join("\n") + "\n");

console.log("Г1 ЗЕЛЕНИЙ. Записано файлів: " + outFiles.size + " + звіт " + REPORT);
for (const [d, b] of totals) console.log(`  ${String(b).padStart(7)} б  ≈${Math.round((b * TOK) / 1000)}к ток  ${DEST_FILES[d]}`);
