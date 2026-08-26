import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * БАНДЛ МУСИТЬ НЕСТИ БОЙОВУ БАЗУ API — інакше сайт мальований, а всі запити мертві.
 *
 * 🔴 Міна, заміряна 26.08.2026. `frontend/.env.production` (42 байти) **не в git** —
 * відстежується лише `.env.example`. Зібравши фронт будь-де без цього файлу, vite
 * підставляє фолбек із `frontend/src/api.ts` і бандл починає стукати в localhost.
 * Доведено дією, не читанням: той самий sha, той самий сервер, ті самі `node_modules`,
 * без `.env.production` — JS вийшов з ІНШИМ хешем і базою `http://localhost:4000/api`;
 * із ним — байт-у-байт як прод. Різниця — 6 байтів у мініфікованому рядку.
 *
 * 🔴 Чому цього не ловить ніщо інше. CSS у ЖОДНОМУ з двох випадків не змінюється, тож
 * CSS-guard (наш найнадійніший сторож) каже «все гаразд». `#42 buildStale` порівнює sha,
 * а sha той самий. `#225` рахує чанки — теж той самий. Сторінка відкривається, версія
 * правильна, health 200. Помітив би лише той, хто клікне.
 *
 * ⚠️ Шукаємо ЛІТЕРАЛ, а не імʼя змінної: бандл мініфікований, `VITE_API_URL` у ньому
 * не існує як ідентифікатор — vite підставляє значення на етапі збірки.
 */

/** Бойова база — саме те значення, що лежить у `frontend/.env.production`. */
const PROD_API = "https://dashboard.uts.ua/api";

/**
 * Фолбек із `frontend/src/api.ts` — рівно те, що потрапляє в бандл замість бойової бази,
 * коли `.env.production` не доїхав.
 *
 * ⚠️ Саме цей ПОВНИЙ літерал, а НЕ підрядок «localhost». Заміряно на бойовому бандлі:
 * `localhost` трапляється **двічі** — обидва рази з чужих бібліотек (react-router підставляє
 * `http://localhost` як запасний origin, axios — так само). Гейт на голий «localhost»
 * червонів би на ПРАВИЛЬНОМУ бандлі, тобто був би не сторожем, а шумом.
 */
const DEV_FALLBACK = "http://localhost:4000/api";

interface Bundle { file: string; src: string }

/**
 * Спершу ДОКРУТ (те, що Apache реально віддає людям), потім `frontend/dist` (стенд або
 * свіжий клон, де копії ще не робили). Порядок не косметичний: перевіряти треба той файл,
 * який отримує браузер, а не той, який ми щойно зібрали.
 */
function bundles(): Bundle[] {
  const roots = [
    fileURLToPath(new URL("../../assets", import.meta.url)),
    fileURLToPath(new URL("../../frontend/dist/assets", import.meta.url)),
  ];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    const js = readdirSync(dir).filter((f) => /^index-.*\.js$/.test(f));
    if (js.length) return js.map((f) => ({ file: path.join(dir, f), src: readFileSync(path.join(dir, f), "utf8") }));
  }
  return [];
}

/**
 * 🔴 У `ALLOWED_PROD_SKIPS` НЕ вноситься СВІДОМО. У `test:prod` докрут існує завжди, тож
 * порожня видача там означає не «нема чим перевіряти», а справжній дефект — і мусить
 * рахуватись падінням, а не дозволеним пропуском.
 */
const NO_BUNDLE = "немає зібраного бандла: ні assets/ докрута, ні frontend/dist/assets — " +
  "у test:prod це ПАДІННЯ (там докрут є завжди), у npm test на свіжому клоні це норма";

test("#225c бандл, що віддається людям, містить БОЙОВУ базу API", (t) => {
  const bs = bundles();
  if (!bs.length) return t.skip(NO_BUNDLE);
  for (const b of bs) {
    assert.ok(
      b.src.includes(PROD_API),
      `${path.basename(b.file)}: немає літерала «${PROD_API}». Фронт зібрано БЕЗ ` +
      `frontend/.env.production — сторінка намалюється, а КОЖЕН запит піде в нікуди. ` +
      `CSS при цьому збігається байт-у-байт, тож CSS-guard цього не побачить.`,
    );
  }
});

test("#225d ДЗЕРКАЛО: dev-фолбек у бандл не потрапив", (t) => {
  const bs = bundles();
  if (!bs.length) return t.skip(NO_BUNDLE);
  for (const b of bs) {
    assert.equal(
      b.src.split(DEV_FALLBACK).length - 1, 0,
      `${path.basename(b.file)}: у бандлі є «${DEV_FALLBACK}». Дзеркало існує саме тому, ` +
      `що #225c пройде і тоді, коли в бандлі опиняться ОБИДВА літерали, — а виграє той, ` +
      `який vite підставив у axios.create().`,
    );
  }
});

/**
 * 🔒 #225e–#225f — ЗАПОБІЖНИК, А НЕ СІТКА. `#225c`/`#225d` вище ловлять уже зібраний
 * отруєний бандл; ці двоє не дають його зібрати. Різні речі, і жоден не заміняє іншого:
 * бандл може приїхати чужим інструментом, що нашого конфігу не читав.
 */

/** Транспілює `frontend/buildEnvGuard.ts` і віддає чисту функцію — без збірки й без vite. */
async function loadGuard(): Promise<(mode: string, env: Record<string, string | undefined>) => void> {
  const ts = await import("typescript");
  const src = readFileSync(fileURLToPath(new URL("../../frontend/buildEnvGuard.ts", import.meta.url)), "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`);
  return mod.requireApiBase as (mode: string, env: Record<string, string | undefined>) => void;
}

test("#225e прод-збірка без VITE_API_URL валиться, dev — ні", async () => {
  const requireApiBase = await loadGuard();

  // 1 · ПРОД без значення — мусить кинути, і причина мусить НАЗВАТИ файл і те, що його немає в git.
  let err: Error | null = null;
  try { requireApiBase("production", {}); } catch (e) { err = e as Error; }
  assert.ok(err, "🔴 прод-збірка без VITE_API_URL пройшла — запобіжника немає");
  assert.match(err!.message, /\.env\.production/, "причина не називає файл, який треба покласти");
  assert.match(err!.message, /НЕМАЄ В GIT/, "причина не каже головного: файла немає в git, тож у клоні його не буде");

  // 2 · Порожнє й пробільне значення — той самий випадок, що відсутнє.
  for (const bad of ["", "   "])
    assert.throws(() => requireApiBase("production", { VITE_API_URL: bad }), `порожнє значення «${bad}» пропущено`);

  // 3 · ДЗЕРКАЛО: зі значенням прод збирається.
  assert.doesNotThrow(() => requireApiBase("production", { VITE_API_URL: "https://dashboard.uts.ua/api" }));

  // 4 · ДЗЕРКАЛО, важливіше за попереднє: dev БЕЗ значення НЕ падає.
  //    Заміряно: у dev-режимі `.env.production` не читається взагалі, тож перевірка,
  //    не привʼязана до режиму, вбила б `npm run dev` усім.
  assert.doesNotThrow(() => requireApiBase("development", {}), "🔴 dev зламано: збірка розробника вимагає прод-конфіг");
  assert.doesNotThrow(() => requireApiBase("test", {}));
});

test("#225f vite.config справді кличе запобіжник, а не просто імпортує", () => {
  const cfg = readFileSync(fileURLToPath(new URL("../../frontend/vite.config.ts", import.meta.url)), "utf8");
  // Межа слова обовʼязкова: `requireApiBase_OFF(...)` — типова підміна, і підрядок її пропустив би.
  assert.match(cfg, /\brequireApiBase\b(?!\w)\s*\(/, "🔴 vite.config.ts не викликає requireApiBase — запобіжник мертвий");
  assert.match(cfg, /\bloadEnv\b(?!\w)\s*\(/, "🔴 конфіг не читає env через loadEnv — перевіряти буде нічого");
  // Режим мусить приходити з vite, а не бути зашитим: інакше запобіжник або завжди мовчить, або вбиває dev.
  assert.match(cfg, /\{\s*mode\s*\}/, "🔴 конфіг не бере mode від vite — перевірка втратить звʼязок із режимом збірки");
});
