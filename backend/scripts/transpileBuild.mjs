/**
 * 🧱 ЗБІРКА БЕКЕНДА ПО ФАЙЛУ — БЕЗ ЗАВАНТАЖЕННЯ ВСІЄЇ ПРОГРАМИ (11.11.2026).
 *
 * `tsc -p` тримає в памʼяті весь проєкт (1363 файли, ~1 ГБ), і на хостингу (ліміт памʼяті акаунта LVE, де прод і PHP
 * уже займають ~1,1 ГБ) збірку стенда вбивали: 11.11 — пʼять разів поспіль. Переклад по одному файлу
 * (`ts.transpileModule`) бере ~360 МБ і дає ТІ САМІ байти, що `tsc` (звірено: 1037 із 1037). Типи тут НЕ перевіряються —
 * це окремий крок `typecheck` (робочий код без тестів, ~730 МБ); тести перевіряє повний `tsc` у кожній сесії перед пушем.
 *
 *   node scripts/transpileBuild.mjs            — src → dist
 */
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Ті самі параметри виводу, що в tsconfig.json (ES2022, ESM). `moduleDetection: force` — файл без import/export теж
// модуль (як у `tsc` з NodeNext і "type": "module"), інакше він отримує "use strict" замість `export {}`.
// Експортовано для гейта `#3819`, який звіряє цей переклад із `tsc` на фікстурах.
export const TRANSPILE_OPTIONS = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true, strict: true,
  moduleDetection: ts.ModuleDetectionKind.Force,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function main() {
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src"), out = path.join(root, "dist");
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) files.push(p);
  }
};
walk(src);
const options = TRANSPILE_OPTIONS;
let failed = 0;
for (const f of files) {
  const r = ts.transpileModule(fs.readFileSync(f, "utf8"), { compilerOptions: options, fileName: f, reportDiagnostics: true });
  for (const d of r.diagnostics ?? []) { failed++; console.error(`${path.relative(root, f)}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`); }
  const dest = path.join(out, path.relative(src, f).replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, r.outputText);
}
if (failed) { console.error(`🔴 синтаксичних помилок: ${failed}`); process.exit(1); }
console.log(`transpile: ${files.length} файлів → dist · памʼять ${Math.round(process.memoryUsage().rss / 1048576)} МБ`);
}
