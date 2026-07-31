import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * ВЕРСІЯ ЗІБРАНОГО КОДУ — щоб «прод працює» і «прод працює НА ТОМУ, ЩО ми викотили»
 * стали двома різними твердженнями.
 *
 * Навіщо. Був випадок: рестарт убив не той процес (`pgrep -f "dist/index.js"` збігся з
 * власною оболонкою релея), прод **11 годин** крутив старий код — і `/api/health`
 * увесь цей час чесно віддавав 200. Health відповідав на питання «чи живий процес»,
 * а не «чи це наш процес». Тепер відповідає на обидва.
 *
 * Sha пишеться під час `npm run build` у `dist/version.json` (див. package.json), а не
 * читається з git у рантаймі: у продакшені не має бути subprocess-виклику заради
 * health-чека, та й `.git` поруч із `dist` може не лежати.
 */
export interface BuildVersion {
  sha: string;
  shortSha: string;
  builtAt: string | null;
  branch: string | null;
}

const UNKNOWN: BuildVersion = { sha: "unknown", shortSha: "unknown", builtAt: null, branch: null };

let cached: BuildVersion | null = null;

export function buildVersion(): BuildVersion {
  if (cached) return cached;
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "version.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<BuildVersion>;
    const sha = String(raw.sha ?? "unknown");
    cached = {
      sha,
      shortSha: sha.slice(0, 7),
      builtAt: raw.builtAt ?? null,
      branch: raw.branch ?? null,
    };
  } catch {
    // Немає version.json (dev через tsx, або збірка без git) — кажемо «unknown»
    // ЧЕСНО. Підставляти сюди щось правдоподібне не можна: тест приймання після
    // деплою звіряє саме це поле, і фальшива версія зробила б його безкорисним.
    cached = UNKNOWN;
  }
  return cached;
}
