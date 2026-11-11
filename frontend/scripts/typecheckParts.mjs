/**
 * 🧩 ТИПИ ФРОНТУ ЧАСТИНАМИ — ПОСЛІДОВНО, КОЖНА В ОКРЕМОМУ ПРОЦЕСІ (11.11.2026, Роман: «оптимізуй»).
 *
 * Заміняє `tsc -b` у кроці `tscFront` ланцюга викату. `tsc -b` тримає ВСЮ програму фронту в одному процесі
 * (~850–930 МБ RSS на стенді), і на хостингу (ліміт памʼяті акаунта, де вже живуть прод і PHP) його вбивали
 * «через раз» — 11.11 пʼять разів. Тут корені кожного конфігу діляться на частини; частина — окремий процес, який
 * будує програму лише з СВОЇХ коренів (+ їхні імпорти) і віддає діагностику лише для СВОЇХ файлів. Процеси йдуть
 * ПОСЛІДОВНО, тож пік памʼяті — найбільша частина, а не сума.
 *
 * 🔴 ЩО МУСИТЬ ЛИШИТИСЬ ПРАВДОЮ (і що стережуть гейти `#3883…#3885`):
 *  · конфіги — з `references` кореневого `tsconfig.json`, а не зі списку тут (новий конфіг не випаде мовчки);
 *  · файли з ГЛОБАЛЬНИМИ оголошеннями (`.d.ts`, `declare global`, `declare module`) — у коренях КОЖНОЇ частини:
 *    інакше частина, що їх не імпортує, дала б хибні помилки (або сховала б справжні);
 *  · сума перевірених файлів по частинах == кількість коренів конфігу — «перевірив нуль» неможливе;
 *  · частина, убита сигналом (памʼять), — ПРОВАЛ із назвою частини, а не «помилок 0».
 *
 * `node scripts/typecheckParts.mjs` — перевірка; код виходу 0 лише без жодної діагностики.
 * Частин: `UTS_TSC_PARTS` (дефолт 4) для конфігів, де коренів більше за `SPLIT_FROM`; решта — однією частиною.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_PARTS = 4;
/** Конфіги з меншою кількістю коренів не ділимо: процес коштує ~50 МБ і секунду, а виграшу там немає. */
export const SPLIT_FROM = 50;
export const PART_MARK = "TCPART ";

/** Неперервні шматки відсортованого списку: сусідні файли імпортують одне одного, тож програми частин менші. */
export function splitParts(files, n) {
  const sorted = [...files].sort();
  const parts = Math.max(1, Math.min(n, sorted.length));
  const size = Math.ceil(sorted.length / parts);
  const out = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

/** Файли, що оголошують глобальне: потрібні в КОЖНІЙ частині, бо їх ніхто не імпортує. */
export function ambientFiles(files, read) {
  return files.filter((f) => f.endsWith(".d.ts") || /\bdeclare\s+(global\b|module\s+["'])/.test(read(f)));
}

/** Конфіги перевірки — з `references` кореневого `tsconfig.json`; без посилань — він сам. */
export function configsOf(ts, rootConfig) {
  const r = ts.readConfigFile(rootConfig, ts.sys.readFile);
  if (r.error) throw new Error(ts.flattenDiagnosticMessageText(r.error.messageText, "\n"));
  const refs = r.config.references ?? [];
  const dir = path.dirname(rootConfig);
  return refs.length ? refs.map((x) => path.resolve(dir, x.path)) : [rootConfig];
}

function parse(ts, configPath) {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (!parsed) throw new Error(`не прочитано ${configPath}`);
  return parsed;
}

/** Скільки частин для конфігу з такою кількістю коренів. */
export function partsFor(rootCount, wanted) { return rootCount > SPLIT_FROM ? wanted : 1; }

/**
 * Одна частина: програма з власних коренів + глобальних файлів; діагностика — лише для власних файлів
 * (плюс налаштування й глобальна — їх дедуплікує головний процес).
 */
export function checkPart(ts, configPath, part, parts) {
  const parsed = parse(ts, configPath);
  const all = parsed.fileNames;
  const mine = splitParts(all, parts)[part] ?? [];
  const roots = [...new Set([...mine, ...ambientFiles(all, (f) => readFileSync(f, "utf8"))])];
  const program = ts.createProgram({ rootNames: roots, options: parsed.options, projectReferences: parsed.projectReferences });
  const diags = [...parsed.errors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  let checked = 0;
  for (const f of mine) {
    const sf = program.getSourceFile(f);
    if (!sf) continue;
    checked++;
    diags.push(...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf));
  }
  const fmtHost = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => path.dirname(configPath), getNewLine: () => "\n" };
  const text = diags.map((d) => ts.formatDiagnostics([d], fmtHost).trim());
  return { config: path.basename(configPath), part, parts, files: mine.length, checked, roots: roots.length, programFiles: program.getSourceFiles().length, diagnostics: text };
}

/** Вирок головного процесу за звітами частин — чиста функція, щоб її можна було перевірити фікстурою. */
export function judgeParts(expected, reports) {
  const problems = [];
  const diagnostics = [...new Set(reports.flatMap((r) => r.diagnostics ?? []))];
  for (const [config, { roots, parts }] of Object.entries(expected)) {
    const mine = reports.filter((r) => r.config === config);
    for (let i = 0; i < parts; i++) {
      const r = mine.find((x) => x.part === i);
      if (!r) { problems.push(`${config}: частина ${i + 1}/${parts} не відзвітувала (процес убито? — це памʼять, а не типи)`); continue; }
      if (r.checked !== r.files) problems.push(`${config}: частина ${i + 1}/${parts} перевірила ${r.checked} із ${r.files} своїх файлів`);
    }
    const sum = mine.reduce((s, r) => s + (r.checked ?? 0), 0);
    if (sum !== roots) problems.push(`${config}: перевірено ${sum} файлів, а коренів ${roots} — частини покрили не все`);
    if (roots === 0) problems.push(`${config}: коренів 0 — перевіряти нічого, це провал, а не «помилок 0»`);
  }
  return { ok: problems.length === 0 && diagnostics.length === 0, problems, diagnostics };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const ts = (await import("typescript")).default;
  const self = fileURLToPath(import.meta.url);
  const [mode, cfg, partS, partsS] = process.argv.slice(2);
  if (mode === "--part") {
    const r = checkPart(ts, cfg, Number(partS), Number(partsS));
    process.stdout.write(PART_MARK + JSON.stringify(r) + "\n");
    process.exit(0);
  }
  const root = path.resolve(path.dirname(self), "..", "tsconfig.json");
  const wanted = Number(process.env.UTS_TSC_PARTS ?? DEFAULT_PARTS);
  if (!Number.isInteger(wanted) || wanted < 1) { console.error(`typecheckParts: UTS_TSC_PARTS має бути цілим ≥ 1`); process.exit(1); }
  const expected = {}; const reports = []; const deaths = [];
  for (const cfg of configsOf(ts, root)) {
    const roots = parse(ts, cfg).fileNames.length;
    const parts = partsFor(roots, wanted);
    expected[path.basename(cfg)] = { roots, parts };
    for (let i = 0; i < parts; i++) {
      const t0 = Date.now();
      const p = spawnSync(process.execPath, [self, "--part", cfg, String(i), String(parts)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      const line = (p.stdout ?? "").split("\n").find((l) => l.startsWith(PART_MARK));
      if (p.signal || p.status !== 0 || !line) {
        deaths.push(`${path.basename(cfg)} частина ${i + 1}/${parts}: ${p.signal ? `убито сигналом ${p.signal} (памʼять?)` : `код ${p.status}`} ${String(p.stderr ?? "").slice(0, 300)}`);
        continue;
      }
      const r = JSON.parse(line.slice(PART_MARK.length));
      reports.push(r);
      console.log(`typecheckParts: ${r.config} ${i + 1}/${parts} — ${r.checked} файлів, у програмі ${r.programFiles}, ${((Date.now() - t0) / 1000).toFixed(1)} с, діагностик ${r.diagnostics.length}`);
    }
  }
  const v = judgeParts(expected, reports);
  for (const d of v.diagnostics) console.error(d);
  for (const d of [...deaths, ...v.problems]) console.error(`🔴 ${d}`);
  const total = Object.values(expected).reduce((s, e) => s + e.roots, 0);
  console.log(`typecheckParts: ${v.ok && !deaths.length ? "✔" : "✖"} коренів ${total}, діагностик ${v.diagnostics.length}, проблем ${deaths.length + v.problems.length}`);
  process.exit(v.ok && !deaths.length ? 0 : 1);
}
