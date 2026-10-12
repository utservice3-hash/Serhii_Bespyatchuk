/**
 * Схема зверху живе у ФРОНТІ (`frontend/src/cargo/client/cargo/topView.ts`) — і її тести пакета мусять ганяти саме
 * її, а не копію. Транспілюємо джерело фронту на льоту; імпорти спільного коду (`../../shared/*`) ведемо в зібрані
 * бекенд-копії — що вони байт у байт ті самі, що у фронті, стереже #1616.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FRONT = path.join(import.meta.dirname, "..", "..", "..", "..", "frontend", "src", "cargo", "client", "cargo", "topView.ts");
const ts = (await import("typescript")).default;
const src = readFileSync(FRONT, "utf8").replace(/from '\.\.\/\.\.\/shared\/(cargo\w+)'/g,
  (_m, f: string) => `from '${pathToFileURL(path.join(import.meta.dirname, "..", `${f}.js`)).href}'`);
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const drawTopView: (...a: any[]) => any = mod.drawTopView;
