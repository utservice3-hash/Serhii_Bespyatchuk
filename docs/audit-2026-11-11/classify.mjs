// Аудит тестів 11.11.2026: AST-розбір кожного test()/it()/t.test() у backend/src/**/*.test.ts.
// Читає лише джерела. Пише JSON з ознаками; сорти розкладає report.mjs.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const ROOT = process.argv[2];               // .../backend
const OUT = process.argv[3];
const require = createRequire(path.join(ROOT, "package.json"));
const ts = require("typescript");
const SRC = path.join(ROOT, "src");

const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith(".test.ts")) files.push(p); } })(SRC);
files.sort();

const LIVE_RE = /\b(needsApi|needsApiQuiet|needsMatrix|needsAi|IS_PROD_SCOPE|API_BASE|MATRIX_ENABLED)\b/;
const DB_RE = /\b(needsDb|needsBackendEnv|HAS_DB)\b/;
const DBW_RE = /\bneedsDbWritable\b/;
const SCRATCH_RE = /\b(provisionScratch|scratchDb|withScratch|SCRATCH)\w*/;
const ASSERT_TEXT_RE = /assert\.(match|doesNotMatch)\s*\(|\.includes\s*\(|\.test\s*\(\s*\w|indexOf\s*\(/g;

const rows = [];
for (const file of files) {
  const rel = path.relative(SRC, file);
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // ── імпорти: що з них «поведінка» (виклик робочого коду) ──
  const importedFns = new Set(); const importedFrom = new Map();
  const typeOnly = new Set();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const mod = st.moduleSpecifier.text;
      const isLocal = mod.startsWith(".");
      if (st.importClause.isTypeOnly) continue;
      const add = (n) => { if (isLocal) { importedFns.add(n); importedFrom.set(n, mod); } };
      if (st.importClause.name) add(st.importClause.name.text);
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) { if (!el.isTypeOnly) add(el.name.text); }
      if (nb && ts.isNamespaceImport(nb)) add(nb.name.text);
    }
  }
  // ── «змінні-джерела»: верхньорівневі const, ініціалізовані читанням файла, і хелпери, що читають файл ──
  const srcVars = new Map();   // name -> {targets:[], kind}
  const readerFns = new Set();
  const readerLits = new Map();
  const lits = (node) => { const o = []; const v = (n) => { if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) o.push(n.text); else if (ts.isTemplateExpression(n)) { o.push(n.head.text); for (const sp of n.templateSpans) o.push(sp.literal.text); } else if (ts.isIdentifier(n) && readerLits.has(n.text)) o.push(readerLits.get(n.text)); ts.forEachChild(n, v); }; v(node); return o.filter(Boolean).join("/"); };
  const litTargets = (node) => {
    // кожен виклик читання → рядок-ціль із літералів (+ літерали хелпера/константи)
    const out = [];
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf);
        if (/^(readFileSync|readFile|readdirSync)$/.test(callee) || readerFns.has(callee)) { out.push(((readerLits.get(callee) || "") + "/" + lits(n)).replace(/\/+/g, "/")); return; }
      }
      ts.forEachChild(n, visit);
    };
    visit(node); return out;
  };
  const readsFile = (node) => /\b(readFileSync|readFile|readdirSync)\s*\(/.test(node.getText(sf));
  const collect = (stmts) => {
    for (const st of stmts) {
      if (ts.isFunctionDeclaration(st) && st.name && st.body && readsFile(st.body)) { readerFns.add(st.name.text); readerLits.set(st.name.text, lits(st.body)); }
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
        if (!d.initializer || !ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && readsFile(init)) { readerFns.add(d.name.text); readerLits.set(d.name.text, lits(init)); continue; }
        if (!readsFile(init) && /path\.join|new URL|resolve\(|fileURLToPath|["'`]/.test(init.getText(sf)) && init.getText(sf).length < 300) readerLits.set(d.name.text, lits(init));
        const it = init.getText(sf);
        const usesReader = [...readerFns].some((f) => new RegExp(`\\b${f}\\s*\\(`).test(it));
        if (readsFile(init) || usesReader) srcVars.set(d.name.text, { targets: litTargets(init) });
      }
    }
  };
  collect(sf.statements);
  // локальні функції: тіло кожної; «поведінкова» = транспілює/імпортує/кличе імпортований код/БД/HTTP
  const localFns = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) localFns.set(st.name.text, st.body.getText(sf));
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations)
      if (d.initializer && ts.isIdentifier(d.name) && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) localFns.set(d.name.text, d.initializer.getText(sf));
  }
  const behavFns = new Set();
  const isBehavBody = (b) => /transpileModule|await import\(|\bimport\(pathToFileURL|\.query\(|\bfetch\(/.test(b) || [...importedFns].some((f) => !/^(assert|test|describe|it)$/.test(f) && new RegExp(`\\b${f}\\s*(\\(|\\.)`).test(b));
  for (let pass = 0; pass < 3; pass++) for (const [n, b] of localFns) if (!behavFns.has(n) && (isBehavBody(b) || [...behavFns].some((g) => new RegExp(`\\b${g}\\s*\\(`).test(b)))) behavFns.add(n);
  // читач, що транспілює й виконує, — не «рядок у файлі»
  for (const n of [...readerFns]) if (/transpileModule|import\(/.test(localFns.get(n) || "")) readerFns.delete(n);
  // ── обхід тестів ──
  const testCalls = [];
  const visit = (n, depth, parentName) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression; let kind = null;
      if (ts.isIdentifier(c) && (c.text === "test" || c.text === "it")) kind = "test";
      else if (ts.isPropertyAccessExpression(c) && c.name.text === "test" && ts.isIdentifier(c.expression) && /^(t|tt|st|sub|ctx|context|test)$/.test(c.expression.text)) kind = "sub";
      else if (ts.isIdentifier(c) && c.text === "describe") kind = "describe";
      else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && (c.expression.text === "test" || c.expression.text === "it") && ["skip", "only", "todo"].includes(c.name.text)) kind = "test";
      if (kind && n.arguments.length) {
        const a0 = n.arguments[0];
        let name = ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0) ? a0.text : a0.getText(sf);
        const body = n.arguments[n.arguments.length - 1];
        const opts = n.arguments.length > 2 ? n.arguments.slice(1, -1).map((x) => x.getText(sf)).join(" ") : "";
        if (kind !== "describe") testCalls.push({ kind, depth, name, opts, body, node: n, parentName });
        ts.forEachChild(n, (ch) => visit(ch, depth + (kind === "describe" ? 0 : 1), kind === "describe" ? parentName : name));
        return;
      }
    }
    ts.forEachChild(n, (ch) => visit(ch, depth, parentName));
  };
  visit(sf, 0, null);
  // локальні змінні-джерела всередині describe/тестів теж
  const fileHasScratch = SCRATCH_RE.test(text);
  for (const tc of testCalls) {
    const bodyText = tc.body.getText(sf);
    const all = tc.opts + " " + bodyText;
    // дочірні тести не рахуємо в ознаки батька: виріжемо їх тексти
    let own = bodyText;
    for (const o of testCalls) if (o !== tc && o.node.pos >= tc.body.pos && o.node.end <= tc.body.end) own = own.replace(o.node.getText(sf), "");
    const ownAll = tc.opts + " " + own;
    const usedSrcVars = [...srcVars.keys()].filter((v) => new RegExp(`\\b${v}\\b`).test(own));
    const directRead = /\b(readFileSync|readFile)\s*\(/.test(own) || [...readerFns].some((f) => new RegExp(`\\b${f}\\s*\\(`).test(own));
    const targets = new Set();
    for (const v of usedSrcVars) for (const t of srcVars.get(v).targets) targets.add(t);
    if (directRead) for (const t of litTargets(tc.body)) targets.add(t);
    const tlist = [...targets];
    const readsSource = (usedSrcVars.length > 0 || directRead);
    const kindOf = (t) => /frontend|\.tsx\b/.test(t) ? "front" : /\.sql\b/.test(t) ? "sql" : /\.md\b/.test(t) ? "doc" : /(assets|index\.html|bundle|\.json\b|version)/.test(t) && !/\.ts\b/.test(t) ? "artifact" : /\.ts\b|\/src\b|src\//.test(t) ? "back" : /\.m?js\b|dist/.test(t) ? "artifact" : "?";
    const srcKinds = new Set(tlist.map(kindOf));
    const nMatch = (own.match(/assert\.(match|doesNotMatch)\s*\(/g) || []).length;
    const nIncl = (own.match(/\.includes\s*\(/g) || []).length;
    const nRegexTest = (own.match(/\/[^/\n]{2,}\/[gimsuy]*\.test\s*\(/g) || []).length;
    // поведінка: виклик імпортованих робочих функцій або динамічний import робочого модуля
    const calledImports = [...importedFns].filter((f) => new RegExp(`\\b${f}\\s*(\\(|\\.|\\[)`).test(own) && !/^(assert|test|describe|it)$/.test(f));
    const dynImport = (own.match(/await import\(\s*["'`](\.[^"'`]+)["'`]/g) || []).map((s) => s.replace(/.*\(\s*["'`]/, "").replace(/["'`]$/, ""));
    const behaviourCalls = calledImports.filter((f) => !/testMode|testkit\/|scratchDb|testRunGate|testManifest|sabotage/.test(importedFrom.get(f) || ""));
    const localBehav = [...behavFns].filter((g) => new RegExp(`\\b${g}\\s*\\(`).test(own));
    const behaviour = localBehav.length > 0 || behaviourCalls.length > 0 || dynImport.some((m) => !/testMode|scratchDb/.test(m)) || /\bpool\.query|client\.query|\.query\(|fetch\(|request\(|spawnSync\(|execFileSync\(|execSync\(/.test(own);
    const live = LIVE_RE.test(ownAll) || (/\bfetch\(/.test(own) && /API_BASE|BASE/.test(own));
    const db = DB_RE.test(ownAll) && !LIVE_RE.test(ownAll);
    const dbw = DBW_RE.test(ownAll);
    const scratch = SCRATCH_RE.test(own) || (fileHasScratch && /\bdb\b|\bq\(|scratch|sql`|\.query\(/.test(own) && !LIVE_RE.test(ownAll) && dbw);
    const num = (tc.name.match(/#[0-9]+[a-zа-я0-9.·]*/i) || [""])[0];
    rows.push({
      file: rel, line: sf.getLineAndCharacterOfPosition(tc.node.getStart(sf)).line + 1, depth: tc.depth, kind: tc.kind,
      num, name: tc.name.replace(/\s+/g, " ").slice(0, 160), parent: tc.parentName ? tc.parentName.slice(0, 60) : "",
      readsSource, srcKinds: [...srcKinds].join("+"), targets: tlist.slice(0, 6).join(" | "),
      nMatch, nIncl, nRegexTest, behaviour, behaviourCalls: behaviourCalls.slice(0, 8).join(" "), dynImport: dynImport.slice(0, 4).join(" "),
      live, db, dbw, scratch, len: own.length,
      behaviourMods: [...new Set([...behaviourCalls.map((f) => importedFrom.get(f)), ...dynImport].filter(Boolean).map((m) => path.relative(SRC, path.resolve(path.dirname(file), m)).replace(/\.js$/, "")))].join(" "),
      fileImports: [...new Set([...importedFrom.values()].map((m) => path.relative(SRC, path.resolve(path.dirname(file), m)).replace(/\.js$/, "")))].join(" "),
    });
  }
}
writeFileSync(OUT, JSON.stringify(rows));
console.log("файлів", files.length, "тестів", rows.length, "верхньорівневих", rows.filter((r) => r.depth === 0).length);
