/**
 * Клієнтські модулі пакета живуть у ФРОНТІ (`frontend/src/bankIdent/client/bankIdent/*`), і тести пакета мусять ганяти
 * саме їх, а не копію. Транспілюємо джерело фронту в тимчасову теку (.mjs), відносні імпорти лишаємо між собою, а
 * спільний код (`../../shared/*`) ведемо в зібрані бекенд-копії — що вони байт у байт ті самі, що у фронті, стереже гейт.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FRONT = path.join(import.meta.dirname, "..", "..", "..", "..", "frontend", "src", "bankIdent", "client", "bankIdent");
const MODS = ["types", "format", "identLineMount", "identFilterMount", "outCommentsMount"];
const ts = (await import("typescript")).default;
const dir = mkdtempSync(path.join(tmpdir(), "bank-ident-front-"));
for (const m of MODS) {
  const src = readFileSync(path.join(FRONT, `${m}.ts`), "utf8")
    .replace(/from '\.\.\/\.\.\/shared\/(\w+)'/g, (_x, f: string) => `from '${pathToFileURL(path.join(import.meta.dirname, "..", `${f}.js`)).href}'`)
    .replace(/from '\.\/(\w+)'/g, (_x, f: string) => `from './${f}.mjs'`);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  writeFileSync(path.join(dir, `${m}.mjs`), js);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = async (m: string): Promise<any> => import(pathToFileURL(path.join(dir, `${m}.mjs`)).href);
export const identLineMount = await load("identLineMount");
export const identFilterMount = await load("identFilterMount");
export const outCommentsMount = await load("outCommentsMount");
export const format = await load("format");
