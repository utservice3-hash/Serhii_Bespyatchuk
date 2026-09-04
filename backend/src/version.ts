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

/**
 * 🔴 ЩО НА ДИСКУ ЗАРАЗ — читається ПРИ КОЖНОМУ ВИКЛИКУ, без кешу.
 *
 * Привід (05.08.2026): банер показав «рантайм 7e1c0b9, копія d91c342» — і це був
 * НЕ рестарт зі старої збірки. Ланцюг запуску (lve_suwrapper → bash → npm start →
 * node dist/index.js у живому checkout) артефакт НЕ пришпилює: панель завжди
 * підніме той dist, що лежить на диску; systemd/PM2/cron немає. Сталося простіше:
 * я зібрав нову версію на проді й НЕ рестартував — процес лишився з тим
 * version.json, який прочитав на старті. 49 хвилин прод крутив попередню збірку
 * при повністю здоровому health.
 *
 * Тому health порівнює ДВА числа: що завантажив процес і що лежить у dist.
 * Розбіжність = «зібрано, але не перезапущено» — стан, який ззовні виглядає
 * нормальним і сам себе не виправляє.
 *
 * ⚠️ Кеш тут НЕ можна: сенс саме в тому, щоб побачити зміну файлу під живим
 * процесом. Ціна — одне читання невеликого файла на health-запит.
 */
export function onDiskVersion(): BuildVersion {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "version.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<BuildVersion>;
    const sha = String(raw.sha ?? "unknown");
    return { sha, shortSha: sha.slice(0, 7), builtAt: raw.builtAt ?? null, branch: raw.branch ?? null };
  } catch {
    return UNKNOWN;
  }
}

/** `true`, якщо на диску ІНША збірка, ніж крутить процес: зібрали й не перезапустили. */
export function buildIsStale(): boolean {
  const disk = onDiskVersion();
  if (disk.sha === "unknown") return false;   // немає з чим порівнювати — не кричимо
  return disk.sha !== buildVersion().sha;
}

/**
 * 🖥 СТАРА ЗБІРКА У ВКЛАДЦІ КОРИСТУВАЧА — третій різновид «не той код», і досі
 * єдиний, якого ніхто не бачив.
 *
 * 📐 Куплено 04.09.2026, ціна — пів дня трьох людей. Кнопку «Подати план»
 * полагодили 02.09 і викотили; бандл на проді зібрано 04.09 об 11:47. О 14:51
 * користувачка написала «кнопка сіра, ніхто не може» — і була права щодо того,
 * що бачила: її вкладка крутила збірку, у якій заборона ще стояла. Півдня
 * шукали баг, якого в коді вже два дні не було.
 *
 * 🔴 ЧОМУ ЦЕ НЕ ТЕ САМЕ, ЩО `buildIsStale`, ХОЧ НАЗВИ СХОЖІ. `buildIsStale`
 * порівнює процес із диском СЕРВЕРА — «зібрали й не перезапустили». Тут
 * порівнюється браузерна вкладка з сервером. Різниця не косметична: серверний
 * стан хтось помітить і полагодить рестартом, а вкладку не перезапустить
 * ніхто — вона може жити тижнями, і людина весь цей час бачитиме старий продукт,
 * не маючи ЖОДНОЇ ознаки, що вона не в тій версії.
 *
 * 🔴 ЧОМУ ПРАВИЛО ЖИВЕ ТУТ, А НЕ У ФРОНТІ, ДЕ ОБИДВА ЧИСЛА ПІД РУКОЮ.
 * Заміряно: у `frontend/src` НЕМАЄ ЖОДНОГО тесту (`*.test.ts*` → нуль файлів),
 * і тестового прогону для фронту в проєкті не існує. Правило, покладене туди,
 * було б неперевірюваним за побудовою — тобто гейт існував би лише на словах.
 * Тому фронт присилає свою sha параметром, а рішення ухвалює ця функція, яку
 * видно юніт-тесту й можна саботувати ВХОДОМ, а не HTTP-запитом (правило 14).
 *
 * 🔴 `null` — ЦЕ НЕ «НІ», ЦЕ «НЕ ЗНАЮ», І ПЛУТАТИ ЇХ НЕ МОЖНА. Порожній скоуп,
 * виражений через `false`, — та сама діра, що вже коштувала нам гейта: читач
 * прочитав би «версія збігається» там, де ми просто не маємо з чим порівнювати
 * (dev-збірка без git, старий бандл без вшитої sha, підроблений параметр).
 * Тому три стани, а не два, і третій має власне значення.
 */
export type ClientStale = boolean | null;

/** Повна git-sha: рівно 40 hex. Коротка, порожня, «unknown» — це НЕ sha. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * `true` — вкладка на старій збірці · `false` — на поточній · `null` — невідомо.
 *
 * ⚠️ Порівнюємо ЛИШЕ повні sha. Спокуса прийняти коротку (`8c11d08`) хибна:
 * тоді будь-який обрізок ставав би «валідною» версією, і помилка вшивання
 * читалась би як збіг. Невідоме має лишатись невідомим.
 */
export function clientStale(loaded: string | null | undefined, server: string): ClientStale {
  const a = String(loaded ?? "").trim();
  const b = String(server ?? "").trim();
  if (!FULL_SHA.test(a) || !FULL_SHA.test(b)) return null;
  return a.toLowerCase() !== b.toLowerCase();
}
