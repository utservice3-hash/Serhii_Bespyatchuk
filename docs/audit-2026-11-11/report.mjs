// Розкладає ознаки з classify.mjs на сорти аудиту. Правила — тут, явно, щоб їх можна було оскаржити.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
const [, , IN, OUT_CSV, OUT_SUM, REPO] = process.argv;
const rows = JSON.parse(readFileSync(IN, "utf8"));

// ── СОРТ 1: «не чіпати» — інваріанти, що вже ловили аварії, і сам апарат набору ──
const KEEP_FILES = [
  [/^manifest(Numbers)?\.test\.ts$|^runGateNames\.test\.ts$|^testRunGate\.test\.ts$|^expectedReds\.test\.ts$/, "апарат набору: маніфест, номери, гейт прогону (#223, «виконалось N із M»)"],
  [/^testReadOnly\.test\.ts$|readOnlyGuard/, "read-only проти прода (#13/#14/#232) — врятував від справжнього DELETE"],
  [/^tools\//, "ланцюг викату / саботаж / gateCount / testDelta / замок — інструменти, що стережуть процес"],
  [/^auth\/(accessMatrix|matrixCoverage|gates|sqlLex|scopeInvariants)\.test\.ts$/, "матриця доступу і межі роутів (#11, #17, #17c, #18, #228) — сканер, а не регулярка"],
  [/^db\/(migrate|scratchLifecycle|roleDeclarations|schemaOrder)\w*\.test\.ts$/, "схема з нуля і ролі (#8, #15) — «міграція пройшла ≠ застосувалась»"],
  [/^health\.test\.ts$|^versionStale\.test\.ts$|^clientStale\.test\.ts$|^bundle(ApiBase|BuildSha)\.test\.ts$/, "версія коду в health (#1) і артефакт бандла — «прод крутить те, що викотили»"],
];
const KEEP_NUM = /^#(1|8|8b|11|13|14|15|17|17c|18|223|228|232|234|250|260|352)[a-zа-я]*$/i;
// ── головні екрани для сорту 2 ──
const MAIN_SCREEN = /overview|огляд|report|звіт|kvp|квп|money|грош|виручк|receivab|дебітор|manager|менеджер|план|plan|weekPlan|forecast|прогноз/i;

const tok = (s) => [...new Set((s.match(/[\w.@-]+(?:\/[\w.@-]+)*\.(?:tsx|ts|sql)\b/g) || []).map((t) => t.replace(/^(\.\.\/|\.\/)+/, "").replace(/^(backend\/)?src\//, "")))];
// поведінкове покриття: які модулі хоч один тест ВИКОНУЄ (імпорт+виклик або динамічний import)
const covered = new Set();
for (const r of rows) for (const m of (r.behaviourMods || "").split(" ").filter(Boolean)) covered.add(m.replace(/^(\.\.\/)+/, ""));
const coveredBase = new Set([...covered].map((m) => path.basename(m)));

const out = [];
for (const r of rows) {
  const f = r.file; let sort = "", sub = "", why = "", instead = "";
  const keepF = KEEP_FILES.find(([re]) => re.test(f));
  const targets = tok(r.targets);
  const front = targets.filter((t) => t.startsWith("frontend") || t.endsWith(".tsx") || /(^|\/)(pages|components|hooks)\//.test(t));
  const back = targets.filter((t) => t.endsWith(".ts") && !front.includes(t));
  const sql = targets.filter((t) => t.endsWith(".sql"));
  const textAsserts = r.nMatch + r.nIncl + r.nRegexTest;
  const srcText = r.readsSource && /front|back|sql|\?/.test(r.srcKinds) && textAsserts > 0;
  if (keepF || KEEP_NUM.test(r.num)) {
    sort = "1-не-чіпати"; sub = keepF ? "файл" : "номер"; why = keepF ? keepF[1] : `номер ${r.num} — інваріант із розділу «МЕХАНІЗМИ»`;
    instead = "лишити як є";
  } else if (r.live || r.db) {
    sort = "2-живі-дані";
    const main = MAIN_SCREEN.test(r.name) || MAIN_SCREEN.test(f);
    sub = r.live ? (main ? "API·головний-екран" : "API·кандидат") : (main ? "БД·головний-екран" : "БД·кандидат");
    why = r.live ? "ходить у живе API (test:prod/test:matrix)" : "читає бойову БД (на стенді роль read-only)";
    if (/мс|ms\b|швидк|час відпов|latency|×4|x4/i.test(r.name)) { sub += "·ЧАС"; why += "; гейт на абсолютний час — правило 14 (міряє Neon, а не зміну)"; }
    instead = main ? "лишити: головний екран, «частини = ціле»/«місток = вкладці» на живих даних" : "кандидат: перевести механізм на scratch-фікстуру (рецепт #220), живе — лише рівністю; або зняти, якщо є гейт головного екрана на те саме";
  } else if (srcText && !r.behaviour) {
    sort = "3-рядок-у-файлі"; why = `читає джерело (${r.srcKinds || "?"}) і перевіряє текст (${textAsserts} тверджень), поведінки в тесті немає`;
    if (front.length && !back.length) {
      const tsx = front.some((t) => t.endsWith(".tsx"));
      sub = tsx ? "3d-фронт-tsx" : "3d-фронт-ts";
      instead = tsx ? "єдиний захист (рендера в наборі немає): винести правило з .tsx у чистий .ts і тестувати виконанням через transpile (патерн bankIdent/testkit/frontMods.ts); до того — лишити"
        : "переписати на виконання: transpile модуля фронту й виклик функції (патерн frontMods.ts) — тоді текстовий гейт зняти";
    } else if (sql.length && !back.length && !front.length) {
      sub = "3e-схема-sql"; instead = "твердження про схему перевіряти на scratch-БД (#8 уже будує схему з нуля): запит до information_schema/pg_constraint замість regex по schema.sql";
    } else {
      const cov = back.filter((t) => covered.has(t.replace(/\.ts$/, "")) || coveredBase.has(path.basename(t, ".ts")));
      if (back.length && cov.length === back.length) { sub = "3b-є-поведінка-модуля"; instead = `кандидат на зняття: модуль(і) ${cov.slice(0, 2).join(", ")} виконуються іншими тестами — звірити, що САМЕ це твердження там покрите, і зняти через RETIRED_GATES`; }
      else if (back.length) { sub = "3c-єдиний-захист"; instead = `переписати на поведінку: модуль ${back.filter((t) => !cov.includes(t)).slice(0, 2).join(", ")} жоден тест не виконує`; }
      else { sub = "3?-ціль-не-розпізнана"; instead = "розібрати руками"; }
    }
  } else if (srcText && r.behaviour) {
    sort = "3-рядок-у-файлі"; sub = "3a-змішаний"; why = `поведінка є, але поруч ${textAsserts} текстових тверджень по джерелу (${r.srcKinds})`;
    instead = "лишити тест; текстові твердження зняти там, де поведінкова частина вже ловить те саме (саботаж обох)";
  } else if (r.scratch || r.dbw) {
    sort = "0-поведінка"; sub = "scratch-БД"; why = "власна фікстура на одноразовому кластері (на хостингу скіп — бінарів PG немає)"; instead = "лишити";
  } else if (r.behaviour) {
    sort = "0-поведінка"; sub = "юніт"; why = "викликає робочий код і перевіряє результат"; instead = "лишити";
  } else if (r.readsSource) {
    sort = "0-поведінка"; sub = "артефакт/фікстура"; why = `читає файл (${r.srcKinds || "?"}) без текстових тверджень по джерелу`; instead = "лишити";
  } else { sort = "0-поведінка"; sub = "інше"; why = "без джерела й без виклику імпортованого коду (контейнер підтестів, чиста логіка в тесті)"; instead = "переглянути: контейнер підтестів або перевірка самого тесту"; }
  out.push({ ...r, sort, sub, why, instead, tTargets: targets.slice(0, 4).join(" ") });
}
const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
const head = ["file", "line", "depth", "number", "name", "sort", "subsort", "why", "instead", "targets", "text_asserts", "behaviour_calls", "live", "db", "scratch"];
const csv = [head.join(",")].concat(out.map((r) => [r.file, r.line, r.depth, r.num, r.name, r.sort, r.sub, r.why, r.instead, r.tTargets, r.nMatch + r.nIncl + r.nRegexTest, r.behaviourCalls, r.live ? 1 : 0, r.db ? 1 : 0, r.scratch ? 1 : 0].map(esc).join(","))).join("\n");
writeFileSync(OUT_CSV, csv + "\n");
const cnt = (k) => { const m = {}; for (const r of out) m[r[k]] = (m[r[k]] || 0) + 1; return m; };
const bySortSub = {}; for (const r of out) bySortSub[r.sort + " / " + r.sub] = (bySortSub[r.sort + " / " + r.sub] || 0) + 1;
// файли, де ВСІ тести — сорт 3 без поведінки (зняття звільняє процес цілком)
const perFile = {}; for (const r of out) { (perFile[r.file] ??= []).push(r); }
const pure3Files = Object.entries(perFile).filter(([, rs]) => rs.every((r) => r.sort === "3-рядок-у-файлі" && r.sub !== "3a-змішаний" || r.depth > 0 && r.sort !== "1-не-чіпати")).map(([f, rs]) => ({ f, n: rs.length, subs: [...new Set(rs.map((r) => r.sub))].join("+") }));
writeFileSync(OUT_SUM, JSON.stringify({ total: out.length, top: out.filter((r) => r.depth === 0).length, bySort: cnt("sort"), bySortSub, pure3Files, coveredModules: covered.size }, null, 1));
console.log(JSON.stringify({ bySort: cnt("sort"), bySortSub }, null, 1), "\nфайлів, де все — сорт 3 без поведінки:", pure3Files.length);
