/**
 * 🔎 РОЗБІР МОНТУВАННЯ — спільне джерело для гейтів `#280`/`#281` і `#11c`.
 *
 * 🔴 ЧОМУ ОКРЕМИЙ МОДУЛЬ, А НЕ ЕКСПОРТИ З ТЕСТА. Спершу ці функції жили в
 * `matrixCoverage.test.ts`. Щойно `#11c` теж знадобився розбір `index.ts`, імпорт із
 * тестового файла ПРОГНАВ БИ його гейти вдруге, всередині чужого файла: назви тестів
 * задвоїлись би, а маніфест звіряє склад набору поіменно. Спільний предикат мусить
 * лежати там, де в нього немає побічного ефекту.
 *
 * ⚠️ Це ТЕКСТОВИЙ розбір, і він свідомо сліпий до частини форм — перелік сліпих плям
 * і чим вони закриті див. у доккоментарі `matrixCoverage.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { MOUNTS } from "./routeInventory.js";

export const ROUTES_DIR = path.resolve(import.meta.dirname, "..", "routes");
export const INDEX_FILE = path.resolve(import.meta.dirname, "..", "index.js");

/** Прибрати коментарі, щоб закоментований роут не рахувався за оголошений. */
export const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

export const readIndex = (): string => readFileSync(INDEX_FILE, "utf8");

/**
 * Роути, оголошені ПРЯМО на `app` у `index.ts` — вони не належать жодному модулю з
 * `MOUNTS`, тож інша половина перелічувача їх не бачить за побудовою.
 *
 * 🔴 Віддає ТРИ числа, а не один список, і це навмисно. `nonLiteral` — скільки викликів
 * `app.<дієслово>(` розбір НЕ зміг прочитати (масив, регулярка, змінна). Без нього
 * «нуль сиріт» неможливо відрізнити від «нуль прочитаних», а це різні стани.
 */
export interface AppScan { api: string[]; nonApiLiteral: string[]; nonLiteral: number }
export function appDeclared(src: string): AppScan {
  const clean = strip(src);
  const total = [...clean.matchAll(/\bapp\.(get|post|put|delete|patch)\(/g)].length;
  const api: string[] = [], nonApiLiteral: string[] = [];
  for (const d of clean.matchAll(/\bapp\.(get|post|put|delete|patch)\(\s*"([^"]+)"/g)) {
    const key = `${d[1].toUpperCase()} ${d[2]}`;
    (d[2].startsWith("/api") ? api : nonApiLiteral).push(key);
  }
  return { api: [...new Set(api)], nonApiLiteral, nonLiteral: total - api.length - nonApiLiteral.length };
}

/** Шляхи роутів, оголошених на `app` (без дієслова) — для перевірок формату шляху. */
export function appPaths(src: string): string[] {
  return [...new Set(appDeclared(src).api.map((k) => k.split(" ")[1]))];
}

/** Усі роути, які index.ts справді монтує: модулі з MOUNTS + оголошені на самому app. */
export function declaredRoutes(): string[] {
  const out: string[] = [];
  for (const m of MOUNTS) {
    const file = path.join(ROUTES_DIR, m.module.replace("../routes/", ""));
    let src: string;
    try { src = strip(readFileSync(file, "utf8")); } catch { continue; }
    for (const d of src.matchAll(/\w+Router\.(get|post|put|delete|patch)\("([^"]+)"/g)) {
      const suffix = d[2] === "/" ? "" : d[2];
      out.push(`${d[1].toUpperCase()} ${m.mount}${suffix}`);
    }
  }
  try { out.push(...appDeclared(readIndex()).api); } catch { /* доводить гейт #280 */ }
  return [...new Set(out)];
}

/** Пари «префікс → експорт», змонтовані в index.ts через app.use. */
export function mountedInIndex(src: string): string[] {
  return [...strip(src).matchAll(/app\.use\("(\/api\/[^"]+)",\s*(\w+)\)/g)]
    .map((m) => `${m[1]}|${m[2]}`).sort();
}

/** Ключі зліпка. Query-рядок відрізаємо: він частина ПРОБИ, а не адреси роута. */
export function matrixKeys(rows: readonly { method: string; path: string }[]): Set<string> {
  return new Set(rows.map((r) => `${r.method} ${r.path.split("?")[0]}`));
}

/**
 * 🔴 ПОРІВНЯННЯ — ОДНА ФУНКЦІЯ НА ГЕЙТ І ЙОГО ДЗЕРКАЛО, І ЦЕ НЕ ОХАЙНІСТЬ.
 * Перша редакція дзеркала `#280b` рахувала різницю ВЛАСНОЮ копією `routes.filter(...)`.
 * Саботаж 02.09.2026 осліпив предикат у `#280` — і **обидва лишились зеленими**:
 * дзеркало доводило лише те, що два вирази, написані поруч, дають однакове. Клас `#214c`.
 * Тепер ліворуч у обох стоїть ОДИН виклик, тож осліплення червонить саме дзеркало.
 */
export function uncovered(routes: readonly string[], covered: ReadonlySet<string>): string[] {
  return routes.filter((r) => !covered.has(r)).sort();
}

/** Те саме для `#281`/`#281b`: що є в `a`, чого немає в `b`. */
export function drift(a: readonly string[], b: readonly string[]): string[] {
  const B = new Set(b);
  return a.filter((x) => !B.has(x)).sort();
}
