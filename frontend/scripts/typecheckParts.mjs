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
 * `node scripts/typecheckParts.mjs` — перевірка; код виходу 0 лише без жодної діагностики. Кожна частина біжить зі стелею
 * хіпа `PART_HEAP_MB` (`UTS_TSC_PART_HEAP_MB`); частину, убиту памʼяттю, драйвер ділить навпіл і повторює (до `MAX_SPLITS`).
 * Частин: `UTS_TSC_PARTS` (дефолт 4) для конфігів, де коренів більше за `SPLIT_FROM`; решта — однією частиною.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_PARTS = 4;
/**
 * Стеля хіпа V8 на частину. 📐 Заміряно 11.11 на ноутбуці: повний `tsc -b` падає з хіпом 600 МБ (потребує 600–700),
 * 4 частини проходять із 450, 8 — із 400. Без стелі V8 прибирає ліниво і «роздуває» RSS до 570–907 МБ на тих самих
 * даних — тобто стеля перетворює шум на межу. 600 — запас ~33% над потребою 4 частин.
 */
export const PART_HEAP_MB = 600;
/** Скільки разів частину, убиту памʼяттю, можна поділити навпіл, перш ніж здатись. */
export const MAX_SPLITS = 3;
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

/** Діапазон [from, to) відсортованих коренів конфігу — так частину можна поділити навпіл без перерахунку. */
export function checkRange(ts, configPath, from, to) {
  const parsed = parse(ts, configPath);
  const all = [...parsed.fileNames].sort();
  const mine = all.slice(from, to);
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
  return { config: path.basename(configPath), from, to, files: mine.length, checked, roots: roots.length, programFiles: program.getSourceFiles().length, diagnostics: text };
}

/** Межі частин: неперервні шматки, як у `splitParts`. */
export function partRanges(count, n) {
  const parts = Math.max(1, Math.min(n, count));
  const size = Math.ceil(count / parts);
  const out = [];
  for (let i = 0; i < count; i += size) out.push([i, Math.min(count, i + size)]);
  return out;
}

/** Одна частина з N — для фікстур і ручного запуску. */
export function checkPart(ts, configPath, part, parts) {
  const all = parse(ts, configPath).fileNames.length;
  const r = partRanges(all, parts)[part] ?? [all, all];
  return { ...checkRange(ts, configPath, r[0], r[1]), part, parts };
}

/** Частину вбито памʼяттю (V8 — код 134 / SIGABRT; ядро — SIGKILL)? Тоді її ділять, а не здаються. */
export const diedOfMemory = (status, signal) => status === 134 || signal === "SIGKILL" || signal === "SIGABRT";

/**
 * Вирок головного процесу за звітами частин — чиста функція, щоб її можна було перевірити фікстурою.
 * Частини мусять РІВНО розбити [0, коренів): без дір і без перекриттів, і кожна — перевірити всі свої файли.
 */
export function judgeParts(expected, reports) {
  const problems = [];
  const diagnostics = [...new Set(reports.flatMap((r) => r.diagnostics ?? []))];
  for (const [config, { roots }] of Object.entries(expected)) {
    if (roots === 0) { problems.push(`${config}: коренів 0 — перевіряти нічого, це провал, а не «помилок 0»`); continue; }
    const mine = reports.filter((r) => r.config === config).sort((a, b) => a.from - b.from);
    let at = 0;
    for (const r of mine) {
      if (r.from > at) problems.push(`${config}: файли ${at}…${r.from - 1} не перевірила жодна частина (убита памʼяттю?)`);
      if (r.from < at) problems.push(`${config}: частини перекриваються на ${r.from}…${at - 1}`);
      if (r.checked !== r.files) problems.push(`${config}: частина ${r.from}…${r.to - 1} перевірила ${r.checked} із ${r.files} своїх файлів`);
      at = Math.max(at, r.to);
    }
    if (at < roots) problems.push(`${config}: файли ${at}…${roots - 1} не перевірила жодна частина (убита памʼяттю?)`);
    const sum = mine.reduce((s, r) => s + (r.checked ?? 0), 0);
    if (sum !== roots) problems.push(`${config}: перевірено ${sum} файлів, а коренів ${roots} — частини покрили не все`);
  }
  return { ok: problems.length === 0 && diagnostics.length === 0, problems, diagnostics };
}

/**
 * Що робити з частиною після виходу процесу — чиста функція (#3888). Звіт є і код 0 → прийнято. Убито памʼяттю, ділити
 * ще можна → дві половини, що РІВНО покривають частину. Інакше — смерть із причиною (не «помилок 0»).
 */
export function afterPart(q, status, signal, reported) {
  if (reported && status === 0) return { ok: true };
  if (diedOfMemory(status, signal) && q.splits < MAX_SPLITS && q.to - q.from > 1) {
    const mid = q.from + Math.ceil((q.to - q.from) / 2);
    return { split: [{ from: q.from, to: mid, splits: q.splits + 1 }, { from: mid, to: q.to, splits: q.splits + 1 }] };
  }
  return { dead: `${signal ? `убито сигналом ${signal}` : `код ${status}`}${diedOfMemory(status, signal) ? " — памʼять, ділити вже нікуди" : reported ? "" : " — частина не відзвітувала"}` };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const ts = (await import("typescript")).default;
  const self = fileURLToPath(import.meta.url);
  const [mode, cfg, fromS, toS] = process.argv.slice(2);
  if (mode === "--range") {
    const r = checkRange(ts, cfg, Number(fromS), Number(toS));
    process.stdout.write(PART_MARK + JSON.stringify(r) + "\n");
    process.exit(0);
  }
  const root = path.resolve(path.dirname(self), "..", "tsconfig.json");
  const wanted = Number(process.env.UTS_TSC_PARTS ?? DEFAULT_PARTS);
  const heap = Number(process.env.UTS_TSC_PART_HEAP_MB ?? PART_HEAP_MB);
  if (!Number.isInteger(wanted) || wanted < 1 || !Number.isInteger(heap) || heap < 64) {
    console.error("typecheckParts: UTS_TSC_PARTS і UTS_TSC_PART_HEAP_MB мають бути цілими (≥1 і ≥64)"); process.exit(1);
  }
  const expected = {}; const reports = []; const deaths = [];
  for (const cfg of configsOf(ts, root)) {
    const roots = parse(ts, cfg).fileNames.length;
    expected[path.basename(cfg)] = { roots };
    // Черга діапазонів: убитий памʼяттю ділиться навпіл (до MAX_SPLITS разів), а не валить крок «через раз».
    const queue = partRanges(roots, partsFor(roots, wanted)).map(([from, to]) => ({ from, to, splits: 0 }));
    while (queue.length) {
      const q = queue.shift();
      const t0 = Date.now();
      const p = spawnSync(process.execPath, [`--max-old-space-size=${heap}`, self, "--range", cfg, String(q.from), String(q.to)],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      const line = (p.stdout ?? "").split("\n").find((l) => l.startsWith(PART_MARK));
      const label = `${path.basename(cfg)} файли ${q.from}…${q.to - 1}`;
      const next = afterPart(q, p.status, p.signal, Boolean(line));
      if (next.ok) {
        const r = JSON.parse(line.slice(PART_MARK.length));
        reports.push(r);
        console.log(`typecheckParts: ${label} — ${r.checked} файлів, у програмі ${r.programFiles}, ${((Date.now() - t0) / 1000).toFixed(1)} с, діагностик ${r.diagnostics.length}`);
      } else if (next.split) {
        console.log(`typecheckParts: ${label} — убито памʼяттю (${p.signal ?? `код ${p.status}`}), ділю навпіл і повторюю`);
        queue.unshift(...next.split);
      } else deaths.push(`${label}: ${next.dead} ${String(p.stderr ?? "").slice(-300)}`);
    }
  }
  const v = judgeParts(expected, reports);
  for (const d of v.diagnostics) console.error(d);
  for (const d of [...deaths, ...v.problems]) console.error(`🔴 ${d}`);
  const total = Object.values(expected).reduce((s, e) => s + e.roots, 0);
  const ok = v.ok && !deaths.length;
  console.log(`typecheckParts: ${ok ? "✔" : "✖"} коренів ${total}, діагностик ${v.diagnostics.length}, проблем ${deaths.length + v.problems.length} (стеля хіпа частини ${heap} МБ)`);
  process.exit(ok ? 0 : 1);
}
