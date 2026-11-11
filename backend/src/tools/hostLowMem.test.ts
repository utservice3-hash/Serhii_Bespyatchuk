import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { planSteps, npmTestArgs, heavyForeign, TEST_RUNNER } from "./deployPlan.js";

/**
 * 🧠 ВИКАТ НА ПОТУЖНОСТЯХ, ЯКІ Є (11.11.2026, Роман: «ні ліміт ми не підіймаємо … оптимізуй»).
 *
 * 📐 Замір, на якому стоїть цей файл (docs/TESTS_AUDIT_2026-11-11.md): із 52 аварій прода під замком за 45 днів 48 — у
 * перші 300 с фази `check`. Там двічі біг `npm test` БЕЗ `--test-concurrency`: на хостингу `availableParallelism()` = 48,
 * тобто до 47 тест-процесів (у середньому 73 МБ, 15 файлів ≥ 150 МБ). Ядро вбиває найбільший процес акаунта — прод.
 * На `tscFront` найбільший — сам `tsc -b` (~850–930 МБ), тому там гинула збірка.
 * Ліки: стеля паралельності на хостингу (`scripts/testRun.mjs`), типи фронту частинами по черзі
 * (`frontend/scripts/typecheckParts.mjs`), без обгорток `npm`/`npx`, і крок `quietHost`.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
type Runner = {
  HOST_TEST_CONCURRENCY: number;
  pickConcurrency: (o: { lve: boolean; requested: number | null; override?: string }) => number | null;
  requestedConcurrency: (argv: string[]) => number | null;
  buildArgs: (argv: string[], n: number | null) => string[];
};
const runner = async (): Promise<Runner> => import(pathToFileURL(path.join(ROOT, "backend", TEST_RUNNER)).href) as Promise<Runner>;
type Parts = {
  splitParts: (f: string[], n: number) => string[][];
  ambientFiles: (f: string[], read: (p: string) => string) => string[];
  configsOf: (t: typeof ts, root: string) => string[];
  partsFor: (roots: number, wanted: number) => number;
  checkPart: (t: typeof ts, cfg: string, part: number, parts: number) => { config: string; files: number; checked: number; diagnostics: string[] };
  judgeParts: (expected: Record<string, { roots: number; parts: number }>, reports: { config: string; part: number; files: number; checked: number; diagnostics: string[] }[]) => { ok: boolean; problems: string[]; diagnostics: string[] };
  SPLIT_FROM: number;
};
const parts = async (): Promise<Parts> => import(pathToFileURL(path.join(ROOT, "frontend", "scripts", "typecheckParts.mjs")).href) as Promise<Parts>;

/**
 * #3880 🪞 СТЕЛЯ ПАРАЛЕЛЬНОСТІ — НА ХОСТИНГУ, І ЛИШЕ ТАМ. Хостинг: не більше `HOST_TEST_CONCURRENCY`, навіть якщо
 * просили 8 (`test:prod`) чи нічого (`npm test` → дефолт node = 47); менше — лишається менше. Ноутбук: рівно те, що
 * попросили, або дефолт node (`null`). Явне `UTS_TEST_CONCURRENCY` — над усім; сміття в ньому — помилка, а не дефолт.
 * 🧨 Червоніє, якщо на хостингу повернути «скільки попросили» (47 процесів знову поруч із продом) або якщо стеля
 * почне діяти й на ноутбуці (там вона лише сповільнює: 14 → 4 = 134 → 166 с).
 */
test("#3880 🪞 СТЕЛЯ ПАРАЛЕЛЬНОСТІ: хостинг ≤ стелі за будь-якого запиту; ноутбук — як попросили; перевизначення — над усім", async () => {
  const { HOST_TEST_CONCURRENCY: CAP, pickConcurrency: pick, requestedConcurrency: req } = await runner();
  assert.ok(CAP >= 1 && CAP <= 8, `🔴 стеля ${CAP} — поза межами, які пережили заміри (1…8)`);
  assert.equal(pick({ lve: true, requested: null }), CAP, "🔴 на хостингу без прапорця — дефолт node (47 процесів), а не стеля");
  assert.equal(pick({ lve: true, requested: 8 }), CAP, "🔴 на хостингу test:prod лишився на 8 — стеля не діє");
  assert.equal(pick({ lve: true, requested: 1 }), 1, "🔴 стеля ПІДНЯЛА менший запит — вона мусить лише обмежувати");
  assert.equal(pick({ lve: false, requested: null }), null, "🔴 на ноутбуці стеля діє — прогін сповільнився без причини");
  assert.equal(pick({ lve: false, requested: 8 }), 8);
  assert.equal(pick({ lve: true, requested: 8, override: "2" }), 2, "🔴 UTS_TEST_CONCURRENCY не перевизначає");
  assert.equal(pick({ lve: false, requested: null, override: "6" }), 6);
  assert.equal(pick({ lve: true, requested: null, override: "" }), CAP, "🔴 порожнє перевизначення зламало вибір");
  assert.throws(() => pick({ lve: true, requested: null, override: "багато" }), /цілим/, "🔴 сміття в UTS_TEST_CONCURRENCY мовчки стало дефолтом");
  assert.equal(req(["--test-concurrency=8", "--test"]), 8);
  assert.equal(req(["--test-concurrency", "3", "--test"]), 3);
  assert.equal(req(["--test", "dist/**/*.test.js"]), null);
});

/**
 * #3880b 🪞 ОБГОРТКА СПРАВДІ ЗАПУСКАЄ NODE З ВИБРАНОЮ ПАРАЛЕЛЬНІСТЮ І ВІДДАЄ ЙОГО КОД. Не текст скрипта, а виконання:
 * `testRun.mjs --test-concurrency=3 -p process.execArgv` друкує рівно одну `--test-concurrency=3` (стеля 4 її не чіпає),
 * чужі прапорці (`--import`) доходять як є, а код виходу набору (7) — код обгортки. Чиста частина: `buildArgs` прибирає
 * обидві форми прапорця.
 * 🧨 Червоніє, якщо обгортка проковтне код виходу (крок `test` прочитав би падіння як зелене), загубить аргументи
 * (`--import ./dist/testReadOnly.js` — read-only-запобіжник), або продублює прапорець.
 */
test("#3880b 🪞 ОБГОРТКА: запускає node з вибраною паралельністю, чужі аргументи — як є, код виходу — набору", async () => {
  const { buildArgs } = await runner();
  assert.deepEqual(buildArgs(["--test-concurrency=8", "--import", "./x.js", "--test", "g"], 4), ["--test-concurrency=4", "--import", "./x.js", "--test", "g"]);
  assert.deepEqual(buildArgs(["--test-concurrency", "8", "--test"], null), ["--test"], "🔴 друга форма прапорця не прибрана");
  assert.deepEqual(buildArgs(["--test"], null), ["--test"]);
  const script = path.join(ROOT, "backend", TEST_RUNNER);
  const env = { ...process.env, UTS_TEST_CONCURRENCY: "" };
  const shown = spawnSync(process.execPath, [script, "--test-concurrency=3", "--no-warnings", "-p", "process.execArgv.join(' ')"], { encoding: "utf8", env });
  assert.equal(shown.status, 0, `🔴 обгортка не запустила node: ${shown.stderr}`);
  const flags = shown.stdout.trim().split(" ").filter((a) => a.startsWith("--test-concurrency"));
  assert.deepEqual(flags, ["--test-concurrency=3"], `🔴 node отримав не ту паралельність: ${shown.stdout.trim()}`);
  assert.match(shown.stdout, /--no-warnings/, "🔴 чужий прапорець загубився по дорозі");
  const code = spawnSync(process.execPath, [script, "-e", "process.exit(7)"], { encoding: "utf8", env });
  assert.equal(code.status, 7, "🔴 обгортка проковтнула код виходу — падіння набору читалось би як зелене");
});

/**
 * #3881 ПРОВОДКА: УСІ РЕЖИМИ НАБОРУ — ЧЕРЕЗ ОБГОРТКУ, read-only НА МІСЦІ. `test`, `test:prod`, `test:ai`, `test:matrix`
 * починаються (після змінних оточення) з `node scripts/testRun.mjs`; прод-режими й далі несуть
 * `--import ./dist/testReadOnly.js`. Розбір — по токенах команди, а не регуляркою по тексту.
 * 🧨 Червоніє, якщо будь-який режим повернеться до голого `node --test…` (на хостингу — знову без стелі) або якщо
 * прод-режим загубить read-only preload.
 */
test("#3881 ПРОВОДКА: усі режими набору — через обгортку; прод-режими — з read-only preload", () => {
  const scripts = (JSON.parse(read("backend/package.json")) as { scripts: Record<string, string> }).scripts;
  for (const mode of ["test", "test:prod", "test:ai", "test:matrix"]) {
    const tokens = scripts[mode].split(/\s+/).filter((t) => !/^[A-Z_]+=/.test(t));
    assert.deepEqual(tokens.slice(0, 2), ["node", TEST_RUNNER], `🔴 \`${mode}\` біжить повз обгортку — на хостингу без стелі паралельності`);
    assert.ok(tokens.includes("--test"), `🔴 \`${mode}\` більше не прогін набору`);
    if (mode !== "test") assert.ok(scripts[mode].includes("--import ./dist/testReadOnly.js"), `🔴 \`${mode}\` загубив read-only preload`);
  }
});

/**
 * #3882 🪞 КРОК `test`: ОБИДВА ПРОГОНИ — ОБГОРТКОЮ СТЕНДА З АРГУМЕНТАМИ ЙОГО `test`. `npmTestArgs` дістає зі скрипта
 * рівно аргументи для node (глоб без лапок, вартовий на місці) і ВІДМОВЛЯЄ на скрипті без обгортки. Крок `test` не
 * кличе `npm` і кличе обгортку `${c.be}/…` в обох каталогах.
 * 🧨 Червоніє, якщо база знову бігтиме своїм `npm test` (старий код → без стелі на першому ж викаті), або якщо розбір
 * мовчки прийме скрипт без обгортки.
 */
test("#3882 🪞 КРОК test: база й дерево — обгорткою стенда з аргументами його скрипта; без обгортки — відмова", () => {
  const scripts = (JSON.parse(read("backend/package.json")) as { scripts: Record<string, string> }).scripts;
  const args = npmTestArgs(scripts.test);
  assert.ok(args.includes("--test") && args.includes("dist/**/*.test.js"), `🔴 розбір загубив прогін або глоб: ${args.join(" ")}`);
  assert.ok(args.includes("--test-reporter=./dist/testRunGate.js"), "🔴 вартовий прогону не дійшов до аргументів");
  assert.ok(!args.some((a) => /["']/.test(a)), "🔴 у аргументах лишились лапки — node шукав би файл із лапками в імені");
  assert.throws(() => npmTestArgs('node --test-reporter=tap --test "dist/**/*.test.js"'), /testRun\.mjs/, "🔴 скрипт без обгортки прийнято");
  assert.throws(() => npmTestArgs("node scripts/testRun.mjs --version"), /--test/, "🔴 скрипт без --test прийнято за прогін");
  const deploy = read("backend/src/tools/deploy.ts");
  const at = deploy.indexOf("  test: async (c) => {");
  const body = deploy.slice(at, deploy.indexOf("\n  recount:", at)).replace(/\/\/.*$/gm, "");
  assert.ok(at > 0, "🔴 крок test не знайдено");
  assert.doesNotMatch(body, /sh\("npm",\s*\["test"\]/, "🔴 крок test знову кличе npm test — база бігтиме без стелі");
  assert.match(body, /sh\("node", \[`\$\{c\.be\}\/\$\{TEST_RUNNER\}`, \.\.\.testArgs\], cwd\)/, "🔴 прогін іде не обгорткою стенда");
  assert.match(body, /runTests\(beBase\)/); assert.match(body, /runTests\(c\.be\)/);
});

/**
 * #3883 🪞 ВИРОК ЧАСТИН: «перевірив нуль» І «частину вбито» — ПРОВАЛ, а не «помилок 0». Зелене — лише коли кожна частина
 * відзвітувала, перевірила всі свої файли, сума == кореням і діагностики немає. Діагностика, що прийшла з двох частин
 * (глобальна), — одна.
 * 🧨 Червоніє, якщо вирок пропустить відсутню частину (убита памʼяттю → «0 помилок»), неповне покриття або нуль коренів.
 */
test("#3883 🪞 ВИРОК ЧАСТИН: убита частина, неповне покриття й нуль коренів — провал; чисте — зелене", async () => {
  const { judgeParts: j, splitParts, partsFor, SPLIT_FROM } = await parts();
  const rep = (part: number, files: number, checked = files, diagnostics: string[] = []) => ({ config: "a.json", part, files, checked, diagnostics });
  assert.deepEqual(j({ "a.json": { roots: 5, parts: 2 } }, [rep(0, 3), rep(1, 2)]), { ok: true, problems: [], diagnostics: [] });
  const dead = j({ "a.json": { roots: 5, parts: 2 } }, [rep(0, 3)]);
  assert.equal(dead.ok, false, "🔴 частину вбито — а вирок зелений"); assert.match(dead.problems.join(), /частина 2\/2 не відзвітувала/);
  assert.equal(j({ "a.json": { roots: 5, parts: 2 } }, [rep(0, 3, 2), rep(1, 2)]).ok, false, "🔴 файл без перевірки пройшов");
  assert.equal(j({ "a.json": { roots: 6, parts: 2 } }, [rep(0, 3), rep(1, 2)]).ok, false, "🔴 сума ≠ кореням пройшла");
  assert.equal(j({ "a.json": { roots: 0, parts: 1 } }, [rep(0, 0)]).ok, false, "🔴 нуль коренів = «перевірено»");
  const dup = j({ "a.json": { roots: 2, parts: 2 } }, [rep(0, 1, 1, ["E1"]), rep(1, 1, 1, ["E1"])]);
  assert.deepEqual([dup.ok, dup.diagnostics], [false, ["E1"]], "🔴 глобальна діагностика задвоїлась або загубилась");
  const sp = splitParts(["c", "a", "d", "b", "e"], 2);
  assert.deepEqual(sp, [["a", "b", "c"], ["d", "e"]], "🔴 частини не неперервні або не покривають усе");
  assert.deepEqual(splitParts(["a"], 4), [["a"]]);
  assert.equal(partsFor(SPLIT_FROM, 4), 1); assert.equal(partsFor(SPLIT_FROM + 1, 4), 4);
});

/**
 * #3884 🪞 ДРАЙВЕР ТИПІВ НА ФІКСТУРІ: помилку в ДРУГІЙ частині знайдено, а глобальне оголошення з файла, який ніхто не
 * імпортує, бачить КОЖНА частина (інакше — хибна помилка «Cannot find name»). Справжня програма TypeScript, без моків.
 * 🧨 Червоніє, якщо прибрати глобальні файли з коренів частин (хибна помилка в частині, що їх не імпортує), або якщо
 * частина звітуватиме чужі файли (помилка задвоїться) чи не свої (помилка зникне).
 */
test("#3884 🪞 ДРАЙВЕР ТИПІВ: помилку в частині знайдено; глобальне з неімпортованого файла бачить кожна частина", async () => {
  const { checkPart, judgeParts } = await parts();
  const dir = mkdtempSync(path.join(tmpdir(), "uts-tcparts-"));
  try {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2020", lib: ["ES2020"], module: "esnext", moduleResolution: "bundler", strict: true, noEmit: true, noUnusedLocals: true, types: [] }, include: ["src"] }));
    const files: Record<string, string> = {
      "a.ts": "export const a: number = __utsGlobal + 1;\n",
      "b.ts": "import { a } from './a';\nexport const b = a * 2;\n",
      "c.ts": "export const c: string = 'ok';\n",
      "d.ts": "export const d: number = 'не число';\n",           // ← справжня помилка, друга частина
      "e.ts": "export const e = __utsGlobal.toFixed(1);\n",
      "z_globals.ts": "declare global { var __utsGlobal: number }\nexport {};\n",
    };
    for (const [f, src] of Object.entries(files)) writeFileSync(path.join(dir, "src", f), src);
    const cfg = path.join(dir, "tsconfig.json");
    const reports = [0, 1, 2].map((i) => ({ ...checkPart(ts, cfg, i, 3), part: i }));
    const v = judgeParts({ "tsconfig.json": { roots: 6, parts: 3 } }, reports);
    assert.equal(reports.reduce((s, r) => s + r.checked, 0), 6, "🔴 частини перевірили не всі файли");
    assert.equal(v.diagnostics.length, 1, `🔴 очікувалась рівно одна помилка (d.ts), а є:\n${v.diagnostics.join("\n")}`);
    assert.match(v.diagnostics[0], /d\.ts/, "🔴 знайдено не ту помилку");
    assert.doesNotMatch(v.diagnostics.join("\n"), /__utsGlobal/, "🔴 частина не бачить глобального оголошення — хибна помилка");
    assert.equal(v.ok, false, "🔴 помилка типу — а вирок зелений");
    writeFileSync(path.join(dir, "src", "d.ts"), "export const d: number = 1;\n");
    const clean = judgeParts({ "tsconfig.json": { roots: 6, parts: 3 } }, [0, 1, 2].map((i) => ({ ...checkPart(ts, cfg, i, 3), part: i })));
    assert.deepEqual([clean.ok, clean.diagnostics], [true, []], `🔴 чиста фікстура не зелена: ${clean.diagnostics.join("\n")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * #3885 КОНФІГИ — З `references` КОРЕНЕВОГО `tsconfig.json`, а не зі списку в драйвері (правило 12). На справжньому фронті
 * це рівно `tsconfig.app.json` і `tsconfig.node.json` (без другого `vite.config.ts` випав би з перевірки мовчки), і в
 * кожному є що перевіряти; великий ділиться на частини.
 * 🧨 Червоніє, якщо драйвер почне брати конфіги з власного переліку й новий конфіг фронту не потрапить у перевірку,
 * або якщо `tsconfig.node.json` випаде.
 */
test("#3885 КОНФІГИ ТИПІВ — з references кореневого tsconfig фронту: app і node, обидва непорожні", async () => {
  const { configsOf, partsFor } = await parts();
  const cfgs = configsOf(ts, path.join(ROOT, "frontend", "tsconfig.json")).map((c) => path.basename(c)).sort();
  const refs = ((JSON.parse(read("frontend/tsconfig.json")) as { references: { path: string }[] }).references).map((r) => path.basename(r.path)).sort();
  assert.deepEqual(cfgs, refs, "🔴 драйвер перевіряє не ті конфіги, що названі в references");
  assert.ok(cfgs.includes("tsconfig.node.json"), "🔴 tsconfig.node.json випав — vite.config.ts без перевірки типів");
  for (const c of cfgs) {
    const p = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, "frontend", c), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    assert.ok(p && p.fileNames.length > 0, `🔴 у ${c} нуль коренів — перевіряти нічого`);
    if (c === "tsconfig.app.json") assert.ok(partsFor(p.fileNames.length, 4) > 1, "🔴 основний конфіг не ділиться — знову одна програма на весь фронт");
  }
});

/**
 * #3886 🪞 ТИША НА ХОСТИНГУ: чужі тести / tsc / vite — важкі; прод, сам ланцюг, waiter-и й семплери — ні. Крок
 * `quietHost` стоїть у check ПІСЛЯ замка і ПЕРЕД першою збіркою.
 * 🧨 Червоніє, якщо розпізнавач пропустить чужий прогін набору (збірка знову поруч із ним) або почне вважати важким
 * прод чи `pgrep` із тими самими словами (ланцюг чекав би вічно), або якщо крок переїде після `buildBack`.
 */
test("#3886 🪞 ТИША НА ХОСТИНГУ: чужі тести/tsc/vite — важкі; прод, ланцюг, waiter, grep — ні; крок перед збіркою", () => {
  const heavy = [
    "101 node --test-concurrency=4 --test-reporter=tap --test dist/**/*.test.js",
    "102 /usr/local/node26/bin/node --import ./dist/testReadOnly.js /home/u/fwt/backend/dist/core/a.test.js",
    "103 npm run test:matrix",
    "104 node node_modules/typescript/bin/tsc -b",
    "105 node node_modules/vite/bin/vite.js build",
    "106 node scripts/typecheckParts.mjs --part /x/tsconfig.app.json 0 4",
    "107 node /home/u/fwt/backend/scripts/transpileBuild.mjs /tmp/base/backend",
    "108 sh -c tsc -b && vite build",
  ];
  const calm = [
    "201 node dist/index.js",
    "202 node dist/tools/deploy.js check --mode=full --target=abc1234",
    "203 pgrep -fc node --tes[t]|test:matri[x]|/\\.bin/ts[c]",
    "204 /bin/bash ./wait-abc1234.sh",
    "205 /usr/bin/python3 /tmp/audit-memsample2.py 10800 /tmp/audit-mem-2.csv",
    "206 grep node --test",
    "207 npm start",
    "208 lsphp",
  ];
  const found = heavyForeign([...heavy, ...calm], new Set());
  assert.deepEqual(found.map((x) => Number(x.split(" ")[0])), heavy.map((x) => Number(x.split(" ")[0])),
    `🔴 розпізнавач помилився: знайшов ${found.map((x) => x.split(" ")[0]).join(",")}`);
  assert.deepEqual(heavyForeign([heavy[0]], new Set([101])), [], "🔴 власний процес ланцюга вважається чужим");
  const check = planSteps("check", "full").map((s) => s.id);
  assert.ok(check.includes("quietHost"), "🔴 кроку quietHost немає у check");
  assert.ok(check.indexOf("lockTake") < check.indexOf("quietHost") && check.indexOf("quietHost") < check.indexOf("buildBack"),
    "🔴 quietHost не між замком і першою збіркою");
  assert.ok(planSteps("check", "light").some((s) => s.id === "quietHost"), "🔴 легкий режим збирає без перевірки тиші");
});

/**
 * #3887 ФРОНТ НА СТЕНДІ: ТИПИ ОДИН РАЗ (частинами), БАНДЛ — БЕЗ ПОВТОРНОГО `tsc`, ОБИДВА БЕЗ `npx`. Заміняє `#3821`
 * (змінилось твердження: типи — не `npx tsc -b` одним процесом, а драйвер частинами). `tscFront` кличе драйвер,
 * `buildFront` — `vite.js build` напряму, `tscFront` — раніше за `buildFront`.
 * 🧨 Червоніє, якщо `tscFront` повернеться до одного `tsc -b`, `buildFront` знову кликатиме `npm run build` (другий
 * `tsc`), будь-який із них — `npx` (ще ~70 МБ), або типи стануть після бандла.
 */
test("#3887 ФРОНТ НА СТЕНДІ: типи частинами один раз (tscFront), бандл — vite напряму; без npx", () => {
  const deploy = read("backend/src/tools/deploy.ts");
  const body = (id: string) => { const at = deploy.indexOf(`\n  ${id}: (c) => run("${id}"`); assert.ok(at > 0, `🔴 крок ${id} не знайдено`); return deploy.slice(at, deploy.indexOf("\n", at + 1)); };
  const tsc = body("tscFront"), vite = body("buildFront");
  assert.match(tsc, /sh\("node", \["scripts\/typecheckParts\.mjs"\], c\.fe\)/, "🔴 tscFront не кличе драйвер частинами");
  assert.doesNotMatch(tsc, /\bnpx\b|"tsc", "-b"/, "🔴 tscFront знову одним tsc -b або через npx");
  assert.match(vite, /sh\("node", \["node_modules\/vite\/bin\/vite\.js", "build"\], c\.fe\)/, "🔴 buildFront не кличе vite напряму");
  assert.doesNotMatch(vite, /\bnpx\b|"run", "build"/, "🔴 buildFront знову через npx або npm run build (другий tsc)");
  const check = planSteps("check", "full").map((x) => x.id);
  assert.ok(check.indexOf("tscFront") >= 0 && check.indexOf("tscFront") < check.indexOf("buildFront"), "🔴 типи фронту перевіряються не перед бандлом");
});
