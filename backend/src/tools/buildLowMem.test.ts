import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * 🧱 ЗБІРКА БЕКЕНДА ПО ФАЙЛУ (11.11.2026, Роман «роби»). Хостинг (ліміт памʼяті акаунта LVE, прод і PHP тримають
 * ~1,1 ГБ) пʼять разів поспіль убивав `tsc -p` (~1 ГБ) на стенді — викати всіх сесій стояли. Тепер `npm run build`:
 * переклад по файлу (`scripts/transpileBuild.mjs`, ~360 МБ) → ресурси → `version.json` → перевірка типів ОСТАННЬОЮ
 * (`scripts/typecheck.mjs`: на хостингу — робочий код без тестів, деінде — повний `tsc` із тестами).
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Фікстури — по одній на кожну відмінність, що могла б розвести переклад по файлу й `tsc`. */
const FIXTURES: Record<string, string> = {
  "imports.ts": `import { a } from "./plain.js";\nimport type { T } from "./types.js";\nexport const x: T = { n: a?.length ?? 0 };\nexport class C { #p = 1; static s = 2; get p() { return this.#p; } }\n`,
  "plain.ts": `const a = [1, 2, 3];\nconsole.log(a.map((v) => v * 2));\n`,
  "types.ts": `export interface T { n: number }\nexport type U = T | null;\n`,
  "enums.ts": `export enum E { A = "a", B = "b" }\nexport const pick = (e: E) => (e === E.A ? 1 : 2);\n`,
  "asyncgen.ts": `export async function* g() { for await (const v of [Promise.resolve(1)]) yield v satisfies number; }\nexport const big = 10n ** 3n;\n`,
};

/**
 * #3819 🪞 — ПЕРЕКЛАД ПО ФАЙЛУ == `tsc` БАЙТ-У-БАЙТ на фікстурах із тими самими параметрами, що `tsconfig.json`
 * (NodeNext, `"type": "module"`): імпорти й `import type`, файл БЕЗ import/export, enum, приватні поля, async-генератор,
 * BigInt. Звірено й на всьому коді 11.11: 1037 із 1037 файлів.
 * 🧨 Червоніє, якщо параметри перекладу розійдуться з `tsconfig.json` — напр., без `moduleDetection: force` файл без
 * import/export отримує "use strict" замість `export {}`, і на проді опиняється інший JavaScript, ніж перевіряли.
 */
test("#3819 🪞 ЗБІРКА ПО ФАЙЛУ == tsc байт-у-байт: імпорти, файл без import/export, enum, приватні поля, async-генератор", async () => {
  const { TRANSPILE_OPTIONS } = await import(pathToFileURL(path.join(ROOT, "backend/scripts/transpileBuild.mjs")).href) as { TRANSPILE_OPTIONS: ts.CompilerOptions };
  const dir = mkdtempSync(path.join(tmpdir(), "uts-build-"));
  try {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    for (const [f, src] of Object.entries(FIXTURES)) writeFileSync(path.join(dir, f), src);
    const cfg = ts.parseJsonConfigFileContent(JSON.parse(read("backend/tsconfig.json")), ts.sys, path.join(ROOT, "backend"));
    const options: ts.CompilerOptions = { ...cfg.options, rootDir: dir, outDir: path.join(dir, "out"), noEmit: false };
    const program = ts.createProgram(Object.keys(FIXTURES).map((f) => path.join(dir, f)), options);
    const emitted = new Map<string, string>();
    program.emit(undefined, (name, text) => { emitted.set(path.basename(name), text); });
    assert.equal(emitted.size, Object.keys(FIXTURES).length, "фікстура: tsc вивів не всі файли");
    for (const [f, src] of Object.entries(FIXTURES)) {
      const mine = ts.transpileModule(src, { compilerOptions: TRANSPILE_OPTIONS, fileName: path.join(dir, f) }).outputText;
      assert.equal(mine, emitted.get(f.replace(/\.ts$/, ".js")), `🔴 ${f}: переклад по файлу дав інший JavaScript, ніж tsc`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * #3820 — ПРОВОДКА ЗБІРКИ: `build` починається з перекладу по файлу і закінчується перевіркою типів (тож навіть убита
 * хостингом перевірка лишає `dist` і інструменти стенда живими); перевірка на хостингу — робочий код без тестів, деінде —
 * повний `tsc --noEmit`; конфіг без тестів справді їх виключає й нічого не пише; ланцюг викату й далі кличе саме
 * `npm run build` після `rm -rf dist`.
 * 🧨 Червоніє, якщо повернути `tsc -p` першим кроком (стенд знову гине від памʼяті), поставити перевірку типів перед
 * перекладом, або якщо на ноутбуці перевірка перестане бачити тести.
 */
test("#3820 ПРОВОДКА ЗБІРКИ: переклад першим, перевірка типів останньою; хостинг — без тестів, ноутбук — повна", () => {
  const build = (JSON.parse(read("backend/package.json")) as { scripts: Record<string, string> }).scripts.build;
  assert.ok(build.startsWith("node scripts/transpileBuild.mjs && "), "🔴 збірка знову починається не з перекладу по файлу");
  assert.ok(build.endsWith("&& node scripts/writeVersion.mjs && node scripts/typecheck.mjs"), "🔴 перевірка типів не останньою — убита хостингом, вона лишить стенд без dist");
  assert.doesNotMatch(build, /\btsc -p tsconfig\.json\b/, "🔴 у збірці знову повний tsc одним процесом");
  const tc = read("backend/scripts/typecheck.mjs");
  assert.match(tc, /const light = forced \? forced === "prod" : existsSync\("\/proc\/lve"\);/, "🔴 перевірка не розрізняє хостинг і ноутбук");
  assert.match(tc, /light \? \["-p", "tsconfig\.typecheck\.json"\] : \["-p", "tsconfig\.json", "--noEmit"\]/, "🔴 на ноутбуці перевірка не повна або на хостингу не легка");
  assert.match(tc, /process\.exit\(r\.status \?\? 1\)/, "🔴 помилка типів не валить збірку");
  const light = JSON.parse(read("backend/tsconfig.typecheck.json")) as { extends: string; compilerOptions: { noEmit: boolean }; exclude: string[] };
  assert.equal(light.extends, "./tsconfig.json");
  assert.equal(light.compilerOptions.noEmit, true, "🔴 легка перевірка пише файли — перезапише dist перекладу");
  assert.deepEqual(light.exclude, ["src/**/*.test.ts"], "🔴 легка перевірка не виключає тести (або виключає більше)");
  const deploy = read("backend/src/tools/deploy.ts");
  assert.match(deploy, /buildBack: \(c\) => run\("buildBack", \(\) => \{ needDeps\(c\.be, "backend"\); sh\("rm", \["-rf", "dist"\], c\.be\); sh\("npm", \["run", "build"\], c\.be\); \}/,
    "🔴 крок buildBack більше не кличе npm run build після rm -rf dist");
});

/**
 * #3821 — ФРОНТ НА СТЕНДІ: ТИПИ ОДИН РАЗ, БАНДЛ — БЕЗ ПОВТОРНОГО `tsc`. `tscFront` робить `npx tsc -b` (типи),
 * `buildFront` — лише `npx vite build` (бандл), і `tscFront` іде раніше у фазі check. 11.11.2026 `buildFront` кликав
 * `npm run build` (= `tsc -b && vite build`), тобто другий `tsc -b` (~900 МБ), і хостинг його вбивав.
 * 🧨 Червоніє, якщо `buildFront` знову кличе `npm run build` (повторний tsc), якщо `tscFront` перестане перевіряти типи
 * або стане ПІСЛЯ бандла.
 */
test("#3821 ФРОНТ НА СТЕНДІ: типи один раз (tscFront), бандл — vite build без повторного tsc", async () => {
  const deploy = read("backend/src/tools/deploy.ts");
  assert.match(deploy, /tscFront: \(c\) => run\("tscFront", \(\) => sh\("npx", \["tsc", "-b"\], c\.fe\)/, "🔴 tscFront більше не перевіряє типи фронту");
  assert.match(deploy, /buildFront: \(c\) => run\("buildFront", \(\) => \{ needDeps\(c\.fe, "frontend"\); sh\("npx", \["vite", "build"\], c\.fe\); \}/,
    "🔴 buildFront знову кличе npm run build — другий tsc -b, і хостинг уб'є крок за памʼяттю");
  const { planSteps } = await import("./deployPlan.js");
  const check = planSteps("check", "full").map((x) => x.id);
  assert.ok(check.indexOf("tscFront") >= 0 && check.indexOf("tscFront") < check.indexOf("buildFront"), "🔴 типи фронту перевіряються не перед бандлом");
});

/**
 * #3822 🪞 — БАЗУ ЛАНЦЮГ ЗБИРАЄ СКРИПТАМИ СТЕНДА, ПО ФАЙЛУ. Крок `test` порівнює набір нової версії з базою (поточним
 * продом); база збиралась власним `npm run build` (до 11.11 — `tsc -p`, ~1 ГБ), і хостинг убивав саме цей крок, хоча
 * нова версія вже збиралась легко. Тепер: `node <стенд>/scripts/transpileBuild.mjs <база>` + `copyAssets.mjs <база>` +
 * базовий `writeVersion`. Скрипт перекладу з коренем аргументом справді збирає ЧУЖИЙ каталог (фікстура).
 * 🧨 Червоніє, якщо базу знову збиратимуть `npm run build`, або скрипт перестане приймати корінь (тоді він перезбере
 * стенд замість бази — і порівняння піде «нове з новим»).
 */
test("#3822 🪞 БАЗА В КРОЦІ test — скриптами стенда по файлу; скрипт збирає саме переданий корінь", async () => {
  const deploy = read("backend/src/tools/deploy.ts");
  const at = deploy.indexOf("const beBase = `${base}/backend`;");
  assert.ok(at > 0, "🔴 збірку бази в кроці test не знайдено");
  const body = deploy.slice(at, deploy.indexOf("const runTests", at));
  assert.doesNotMatch(body.replace(/\/\/.*$/gm, ""), /sh\("npm", \["run", "build"\], beBase\)/, "🔴 базу знову збирає її власний npm run build (повний tsc)");
  assert.match(body, /sh\("node", \[`\$\{c\.be\}\/scripts\/transpileBuild\.mjs`, beBase\], c\.be\);/, "🔴 базу перекладає не скрипт стенда");
  assert.match(body, /sh\("node", \[`\$\{c\.be\}\/scripts\/copyAssets\.mjs`, beBase\], c\.be\);/, "🔴 у базі немає SQL і ресурсів");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(path.join(tmpdir(), "uts-base-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(dir, "src", "core"), { recursive: true });
    writeFileSync(path.join(dir, "src", "core", "a.ts"), "export const a: number = 1;\n");
    const r = spawnSync(process.execPath, [path.join(ROOT, "backend/scripts/transpileBuild.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, `🔴 скрипт перекладу впав на чужому корені: ${r.stderr}`);
    assert.equal(readFileSync(path.join(dir, "dist", "core", "a.js"), "utf8"), "export const a = 1;\n", "🔴 скрипт зібрав не переданий корінь");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
