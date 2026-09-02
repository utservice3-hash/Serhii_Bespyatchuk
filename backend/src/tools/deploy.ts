/**
 * 🚀 ВИКОНАВЕЦЬ ВИКАТУ. Реєстр кроків і причини — у `deployPlan.ts`.
 *
 * 🔴 СКРИПТ НЕ ДЕПЛОЇТЬ САМ. Це інструмент, який запускають ПІСЛЯ СТОПу й дозволу
 * власника: жодних тригерів, жодного «деплой на push». СТОП лишається людським рішенням.
 *
 * 🔴 РЕЖИМ — ЛИШЕ ЯВНО. Мовчазного дефолту немає навмисно: коли викат коштуватиме дві
 * хвилини замість сорока, зʼявиться спокуса викочувати не подумавши. Легкий режим
 * друкує, чого саме він НЕ робить (`LIGHT_OMITS`), а не мається на увазі.
 *
 * ⚙️ КОЖЕН КРОК FAIL-CLOSED: невдача — СТОП, не попередження. Крок, що вміє «попередити
 * і поїхати далі», за два тижні починають ігнорувати — і це рівно той клас, яким ми
 * весь час лікуємось («успіх за 0 мс», «порожній результат = pass»).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import {
  REQUIRED_STEPS, planSteps, verifyArtifact, LIGHT_OMITS, abortState, migrationsInDiff, isProdCheckout, PROD_CHECKOUT_REFUSAL, resolveTrees, SAME_TREE_REFUSAL, STAND_RECIPE, PROD_BRANCH, OLD_PROD_BRANCH, pushRefusal,
  MARK_REPORT, MARK_STOP,
  type Mode, type Phase, type Step, type Artifact,
} from "./deployPlan.js";
import { cli as lockCli, CANON_LOCK_DIR, heldByMe, readClaim } from "./checkoutLock.js";
import { parseTap, judgeDelta } from "./testDelta.js";
import { diffGates, acceptRetired } from "../testManifest.js";
import { FAIL_MARK, failureNames, EXPECTED_PASS_MARK, expectedPassNames } from "../testRunGate.js";
import { acceptExpectedReds } from "../expectedReds.js";
import { testsAtRef, parseManifestTests } from "./gateCount.js";
import { rmSync, symlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

export const ARTIFACT_PATH = "/tmp/uts-deploy-check.json";
const HEALTH = "https://dashboard.uts.ua/api/health";
/** Базовий URL для приймання — той самий хост, що й health. */
const API_BASE = HEALTH.replace(/\/api\/health$/, "");
/**
 * ⏱ Скільки чекати від РЕСТАРТУ до приймання. Заміряно 23.08.2026: 5 хв → /overview
 * 3.0-4.2 с, 12 хв → 2.35 с. Раніше — червоне без регресу.
 *
 * 🔴 ПІДНЯТО ДО 16 ХВ 28.08.2026, І ЦЕ НЕ ЗАПАС «ПРО ВСЯК ВИПАДОК». Замір, що дав 12,
 * міряв ОДИНИЧНИЙ `/overview`; `#36` міряє ×4, і на ньому межа лежить вище:
 * **червоно на 707 с, зелено на 960 с**. Тобто ланцюг запускав приймання РІВНО в тому
 * вікні, де гейт червоніє не з нашої вини, — і кожен такий викат коштував би проходу
 * на діагноз неіснуючого регресу. Той самий клас, що `#137e`: перевірка, яка червоніє
 * не з нашої вини, за два тижні починає ігноруватись.
 *
 * ⚠️ Число тримати РІВНИМ заміру, а не «трохи більше»: зайві хвилини — це чекаут під
 * замком, тобто черга для двох інших чатів.
 */
const WARM_MS = 16 * 60 * 1000;

const sh = (cmd: string, args: string[], cwd?: string): string =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/** Результат кроку. `skipped` НЕ є успіхом: він друкується окремо з причиною. */
export interface StepResult { id: string; ok: boolean; skipped?: string; detail: string }

interface Health { version: { shortSha: string }; buildStale?: boolean }
async function health(): Promise<Health> {
  const r = await fetch(HEALTH);
  if (!r.ok) throw new Error(
    `health віддав ${r.status}. Прод або лежить, або підіймається після рестарту.\n`
    + "   Подивись лог прода й app_boot; якщо це ПІСЛЯ kill — дай ~15 с і повтори крок.");
  return (await r.json()) as Health;
}
async function prodSha(): Promise<string> {
  return (await health()).version.shortSha;
}

/** Чи є в PATH те, без чого крок зі збіркою зробить `rm` і зупиниться на півдорозі. */
/**
 * 🔴 ШЛЯХ ДО NODE — НАЗВАНИЙ, А НЕ «те, що в PATH». Прод виконує саме цей бінарник
 * (заміряно: /proc/<pid>/exe). Покладатись на PATH означає, що збірка залежить від
 * того, хто й з якої оболонки її запустив — і на цьому вже згорів один прохід
 * (`npm: command not found` ПІСЛЯ `rm -rf dist`).
 * ⚠️ Артефакт від мажора НЕ залежить: заміряно на одному sha — node24 і node26 дають
 * той самий бандл і той самий бекенд (md5 збігається). Фіксуємо заради РАНТАЙМУ
 * й повторюваності, а не тому, що збірка різна.
 */
export const NODE_BIN = process.env.UTS_NODE_BIN ?? "/usr/local/node26/bin";

/**
 * 📦 Каталог копій виїжджаючого — ПОЗА докрутом (докрут роздається вебом).
 * Тримаємо два покоління: одного мало (відкат відкату), трьох не треба.
 */
export const BACKUP_DIR = process.env.UTS_BACKUP_DIR ?? "/home/evraziat/uts.ua/deploy-backups";
export const BACKUP_KEEP = 2;

/**
 * Перевірка інструментів. `namedBin` — каталог, у якому node/npm мусять лежати
 * ПОІМЕННО, або `null`, якщо досить будь-яких у `PATH`.
 *
 * 🔴 РІЗНИЦЯ МІЖ ФАЗАМИ — НЕ ПРИДИРКА, І `3655602` НА ЦЬОМУ ЗГОРІВ. Я вимагав
 * прод-специфічного `/usr/local/node26/bin` в ОБОХ фазах — а `check` за задумом
 * біжить у контейнері чи стенді, де node лежить деінде. Тобто той викат зробив
 * `deploy:check` невиконуваним поза продом: рівно та хвороба, яку ми перед тим два
 * дні лікували («інструмент, який неможливо виконати, не захищає нікого»).
 * Знайшов HR, читаючи диф.
 *
 * Кому що потрібно:
 *   `check` — БУДЬ-ЯКІ node/npm/git: фаза лише збирає й ганяє тести, а артефакт від
 *             мажора не залежить (заміряно на одному sha: node24 і node26 дають
 *             однаковий бандл і однаковий бекенд, md5 збігається);
 *   `run`   — САМЕ прод-бінарник: після `kill` процес підіймає конвеєр саме ним, і
 *             якщо його немає, сайт не повернеться. Перевірка стоїть ПЕРЕД першим
 *             `rm -rf dist`, бо 26.08.2026 ланцюг зробив `rm` і аж тоді впав на
 *             `npm: command not found`.
 */
/**
 * 🔴 ЛАНЦЮГ НЕ СТАВИТЬ ЗАЛЕЖНОСТЕЙ І НЕ ПОВИНЕН — але мусить сказати це вголос.
 *
 * 📐 Привід: 27.08.2026 два чати заміряли `node_modules` у стенді й дістали різні
 * відповіді. Розгадка виявилась не в помилці жодного: стендів на хості ДВА, і другий
 * (`stand-osnovnyi`) створили за сім хвилин до заміру — між `git clone` і `npm ci`
 * є вікно в кілька хвилин, коли залежностей справді немає. Стан реальний і
 * відтворюваний, тож перший, хто прийде на свіжий стенд, вирішить, що той зламаний.
 *
 * Ланцюг не робить `npm ci` НІДЕ (перевірено: нуль викликів) — навпаки, крок `test`
 * СИМЛІНКУЄ `node_modules` стенда в базовий worktree, тобто на них спирається.
 * Тихий `npm ci` тут був би гірший за відмову: три хвилини мовчання й мовчазна зміна
 * дерева, у якому саме міряють приріст падінь.
 */
function needDeps(dir: string, what: string): void {
  if (existsSync(`${dir}/node_modules`)) return;
  throw new Error(
    `у ${what} немає node_modules — ланцюг залежностей НЕ ставить і не буде.\n`
    + `   Свіжий клон живе так кілька хвилин, поки не проженеш:\n`
    + `     (cd ${dir} && npm ci)\n`
    + "   Це не поломка стенда — це його ненаповнений стан.");
}

export function toolsPresent(id: string, namedBin: string | null): StepResult {
  const missing = ["npm", "node", "git"].filter((t) => {
    try { sh(t, ["--version"]); return false; } catch { return true; }
  });
  if (missing.length) return { id, ok: false,
    detail: `🔴 у PATH немає: ${missing.join(", ")} — далі йти НЕ МОЖНА: наступний крок починається з \`rm -rf dist\`.\n`
      + "   Найчастіша причина: relay — НЕ логін-шелл, і npm у його PATH немає взагалі.\n"
      + "   Лікується одним із двох, і перше надійніше:\n"
      + "     export PATH=/usr/local/node26/bin:$PATH   (на початку КОЖНОГО relay-ланцюга)\n"
      + "     bash -lc \"…\"                              (логін-шелл підтягне профіль)" };
  /**
   * 🔴 ВІДМОВА МУСИТЬ НАЗИВАТИ ВЛАСНИЙ ВИХІД. Гачок `UTS_NODE_BIN` існував і до цього,
   * але текст його не згадував — HR знайшов його, лише пішовши читати диф. Відмова,
   * що не називає, як її зняти, коштує наступному годину.
   */
  if (namedBin && !(existsSync(`${namedBin}/node`) && existsSync(`${namedBin}/npm`))) return { id, ok: false,
    detail: `🔴 у ${namedBin} немає node/npm — далі йти НЕ МОЖНА: після \`kill\` процес підіймає конвеєр саме цим бінарником.\n`
      + `   Інший шлях задається змінною UTS_NODE_BIN (напр. UTS_NODE_BIN=/usr/local/node24/bin).` };
  return { id, ok: true, detail: namedBin ? `npm, node, git на місці (${namedBin})` : "npm, node, git на місці (PATH)" };
}

/**
 * 🔑 ОБРОБНИКИ — ДЖЕРЕЛО ПРАВДИ ПРО ТЕ, ЩО СКРИПТ УМІЄ ВИКОНАТИ.
 *
 * Гейт `#226` звіряє саме КЛЮЧІ цієї мапи з реєстром, а не текст файлу: перевірка
 * «у скрипті є рядок markDeploy» зеленіла б і тоді, коли рядок є, а виклику немає.
 * Той самий урок, що з чанками — формулюємо через наслідок, не через механізм.
 */
export const handlers: Record<string, (ctx: Ctx) => Promise<StepResult> | StepResult> = {
  // ── CHECK ─────────────────────────────────────────────────────────────────
  /**
   * 🛠 СЕРЕДОВИЩЕ — ПЕРЕД ПЕРШИМ `rm`, А НЕ ПІСЛЯ. Обробник один на обидві фази:
   * розходження між ними було б рівно тією дірою, яку крок закриває.
   */
  // check біжить у контейнері/стенді — там node лежить де завгодно, і це нормально.
  toolsCheck: () => toolsPresent("toolsCheck", null),
  // run убиває процес прода — прод-бінарник мусить БУТИ, інакше сайт не повернеться.
  toolsRun: () => toolsPresent("toolsRun", NODE_BIN),
  base: async (c) => {
    const live = await prodSha();
    c.prod = live;
    const ok = (() => {
      try { sh("git", ["merge-base", "--is-ancestor", live, "HEAD"], c.buildRepo); return true; }
      catch { return false; }
    })();
    return { id: "base", ok, detail: ok ? `прод ${live} — предок HEAD` : `🔴 прод ${live} НЕ предок HEAD: потрібен ребейз, інакше викат тихо відкотить чужий прохід` };
  },
  lightAdmission: (c) => {
    const outside = sh("git", ["diff", "--name-only", `${c.prod}..HEAD`], c.buildRepo)
      .split("\n").filter((f) => f && !f.startsWith("frontend/"));
    return { id: "lightAdmission", ok: outside.length === 0,
      detail: outside.length ? `🔴 поза frontend/: ${outside.join(", ")} — режим ПОВНИЙ` : "діф лише у frontend/" };
  },
  /**
   * 🧾 ЧУЖІ КОМІТИ — НАЗВАТИ ПОІМЕННО, А НЕ ПОРАХУВАТИ.
   *
   * Дві множини, обидві від `origin/main`, тож жодних здогадів про авторство:
   *   мої    = `origin/main..HEAD` — те, чого у спільній гілці ще немає;
   *   чужі   = `<прод>..origin/main` — те, що у спільній гілці вже є, а на проді ще ні.
   * Друге і є «поїде разом із твоїм»: чужий пул-реквест, злитий у `main`.
   *
   * ⏱ Крок стоїть у фазі CHECK, і це не послаблення: набір `прод..HEAD` ПРИШПИЛЕНИЙ
   * HEAD-ом, а HEAD — артефактом (`version.json == HEAD`, крок `baseAgain`). Тобто
   * між check і run цей список змінитись не може, не завалив би артефакт.
   *
   * 🪞 Порожньо — кажемо СЛОВАМИ. Мовчазний порожній список читається як «перевірка
   * не працює», і за тиждень на нього перестають дивитись.
   */
  foreignCommits: (c) => {
    /**
     * 🔴 ДЕТАЛЬ ОБЧИСЛЮЄТЬСЯ, А НЕ ОГОЛОШУЄТЬСЯ — і саме тут я вже раз спіткнувся.
     * Перша редакція загортала крок у `run(id, fn, detail)`, а той приймає
     * `fn: () => void` і ПОВЕРНЕНЕ ЗНАЧЕННЯ ВІДКИДАЄ, друкуючи статичний підпис.
     * Крок чесно рахував обидва списки — і викидав їх. У звіті стояло зелене
     * «чужі коміти названо поіменно», а названо не було НІЧОГО.
     * Спіймало приймання, не гейт: гейт читав ТІЛО кроку, а не те, що доходить у звіт.
     */
    try {
      sh("git", ["fetch", "origin", "-q"], c.buildRepo);
      const list = (range: string): string[] =>
        sh("git", ["log", "--oneline", range], c.buildRepo).split("\n").filter(Boolean);
      const mine = list(`origin/${c.branch}..HEAD`);
      const foreign = list(`${c.prod}..origin/${c.branch}`);
      if (foreign.length === 0) {
        return { id: "foreignCommits", ok: true,
          detail: `твоїх ${mine.length}, чужих НЕМАЄ — у ${c.branch} після ${c.prod} нічого не зʼявилось` };
      }
      /**
       * 🔴 НЕ обрізаємо й НЕ фільтруємо злиття. «І ще 7» — рівно та форма, у якій
       * чужу зміну не помічають; `--no-merges` — та сама втрата, лише непомітніша:
       * злиття приводить чужу гілку цілком, і саме воно робить число не тим,
       * що людина очікує побачити.
       */
      return { id: "foreignCommits", ok: true,
        detail: `твоїх ${mine.length}, а ПОЇДЕ ЩЕ ${foreign.length} чужих — їх немає у твоєму списку «чисел, названих наперед»:\n`
          + foreign.map((l) => `   ${l}`).join("\n") };
    } catch (e) {
      return { id: "foreignCommits", ok: false,
        detail: `🔴 не вдалось порахувати чужі коміти: ${String((e as Error).message).slice(0, 200)}\n`
          + `   Найчастіша причина: у стенді немає гілки origin/${c.branch} — прожени git fetch origin.` };
    }
  },
  buildBack: (c) => run("buildBack", () => { needDeps(c.be, "backend"); sh("rm", ["-rf", "dist"], c.be); sh("npm", ["run", "build"], c.be); }, "чиста збірка бекенда"),
  tscFront: (c) => run("tscFront", () => sh("npx", ["tsc", "-b"], c.fe), "tsc -b фронту (НЕ --noEmit: він там нічого не перевіряє)"),
  /**
   * 🔴 БАНДЛ ФРОНТУ. `tscFront` поруч — це ТИПИ (`tsc -b`), він нічого не емітить;
   * `vite build` типів не перевіряє. Два різні кроки, і жоден не заміняє іншого.
   * Крок стоїть у фазі CHECK, тобто у стенді: у докруті йому не місце — саме заради
   * цього збірку й виносили.
   */
  buildFront: (c) => run("buildFront", () => { needDeps(c.fe, "frontend"); sh("npm", ["run", "build"], c.fe); }, "бандл фронту (vite) — у СТЕНДІ"),
  /**
   * 🔴 КРИТЕРІЙ — ПРИРІСТ, А НЕ КОД 0. Розгорнуто в `testDelta.ts`; тут — механіка
   * двох прогонів. Ціна заміряна: +78 с (worktree+збірка 12.4 с, прогін бази 65.8 с).
   */
  test: (c) => {
    let base = "";
    try {
      // 🔗 База — worktree на sha з health.version У МОМЕНТ ДІЇ (`c.prod`), не з памʼяті.
      base = mkdtempSync(`${tmpdir()}/deploy-base-`);
      rmSync(base, { recursive: true, force: true });
      // ⚠️ Worktree ВСЕРЕДИНІ СТЕНДА — навмисно. Заперечення проти worktree стосувалось
      // СПІЛЬНОГО `.git` прод-репозиторію, де він конкурує з тим, хто в чекауті;
      // у власному клоні спільного немає нічого.
      sh("git", ["worktree", "add", "-f", base, c.prod, "-q"], c.buildRepo);

      // 🔴 СИМЛІНК node_modules — ЛИШЕ ПОКИ ЛОК-ФАЙЛИ ЗБІГАЮТЬСЯ. Розійшлись —
      // кажемо це ВГОЛОС і зупиняємось: тихий `npm ci` на 3 хв мовчки змінив би
      // те, що ми міряємо, а тиха збірка чужими залежностями зробила б порівняння
      // безглуздим при бездоганному вигляді.
      const lockBase = sh("git", ["show", `${c.prod}:backend/package-lock.json`], c.buildRepo);
      const lockTree = readFileSync(`${c.be}/package-lock.json`, "utf8");
      if (lockBase.trim() !== lockTree.trim()) {
        return { id: "test", ok: false, detail:
          `🔴 package-lock.json бази (${c.prod}) і дерева РІЗНІ — порівнювати прогони не можна: `
          + "залежності відрізняються, і різниця падінь скаже не про твій діф. "
          + "Постав залежності бази явно (npm ci у worktree) і повтори." };
      }
      symlinkSync(`${c.be}/node_modules`, `${base}/backend/node_modules`);

      const beBase = `${base}/backend`;
      sh("rm", ["-rf", "dist"], beBase);
      sh("npm", ["run", "build"], beBase);

      // ⚠️ `npm test` віддає ненульовий код за будь-якого падіння — це НОРМА тут,
      // тож вивід ЛОВИМО, а не даємо йому обірвати крок.
      const runTests = (cwd: string): string => {
        try { return sh("npm", ["test"], cwd); }
        catch (e) { return String((e as { stdout?: string }).stdout ?? ""); }
      };
      const baseTap = parseTap(runTests(beBase));
      const treeTap = parseTap(runTests(c.be));
      if (baseTap.length === 0 || treeTap.length === 0) {
        return { id: "test", ok: false, detail:
          `🔴 порожній TAP (база ${baseTap.length}, дерево ${treeTap.length}) — прогін не відбувся. `
          + "Порожній результат = провал, а не «падінь немає».\n"
          + "   Прожени `npm test` руками в тому ж каталозі й подивись на ПЕРШІ рядки виводу: "
          + "зазвичай це збірка, що не відбулась, або відсутній dist." };
      }
      /**
       * 🔴 МАНІФЕСТ ЧИТАЄМО З ДЖЕРЕЛА В ЦЮ МИТЬ, А НЕ З ІМПОРТУ.
       *
       * 📐 Спіймано першим прогоном після ребейзу (27.08.2026): крок доповів
       * «ЗНИКЛИ ГЕЙТИ (11)» — #240-#248 Основного, які насправді лежали в дереві.
       * `deploy.ts` імпортує маніфест на ЗАВАНТАЖЕННІ МОДУЛЯ, а `buildBack` уже потім
       * робить `rm -rf dist && npm run build`. Тобто порівнювався прод із маніфестом
       * зі СТАРОГО dist: у ньому (база f6891b0) тих гейтів було 0, у проді — 11.
       *
       * 🔑 Найгірше тут не хибна тривога, а те, ЩО САМЕ вона стереже: детектор
       * зниклих гейтів, який сам залежить від свіжості збірки, робить недовірливим
       * саме той сигнал, заради якого існує. Рідня «несвіжого dist», але всередині
       * інструмента приймання.
       */
      const manifestNow = parseManifestTests(
        readFileSync(`${c.be}/src/testManifest.ts`, "utf8"), "дерево (джерело, не dist)");
      /**
       * 🗑 ЗНИКНЕННЯ, ОГОЛОШЕНЕ В РЕЄСТРІ, — ЗАКОННЕ; РЕШТА ЗУПИНЯЄ ЛАНЦЮГ.
       *
       * 🔴 Дві множини, а не одна, і плутати їх не можна: `unaccounted` — це «гейт
       * зник, і ніхто цього не оголошував», а `problems` — це «сам реєстр бреше»
       * (запис без причини або запис про ЖИВИЙ гейт). Друге гірше: реєстр-ковдра
       * пропустив би наступне СПРАВЖНЄ зникнення під тим самим записом.
       * `alive` беремо з ДЖЕРЕЛА дерева в цю мить — з того самого тексту, що й
       * `manifestNow`, інакше «живий» звірялося б зі старим `dist` (та сама пастка,
       * що вже дала хибне «ЗНИКЛИ ГЕЙТИ (11)» 27.08.2026).
       */
      const lostRaw = diffGates(testsAtRef(c.prod), manifestNow).onlyBefore;
      const retire = acceptRetired(lostRaw, manifestNow);
      if (retire.problems.length) {
        return { id: "test", ok: false, detail:
          ["🔴 РЕЄСТР ЗНЯТИХ ГЕЙТІВ САМ НЕСПРАВНИЙ — це зупинка ДО будь-яких висновків про приріст:",
            ...retire.problems.map((x) => `   ${x}`)].join("\n") };
      }
      // Прийняті поіменно зняття не рахуються ні як «зник гейт» (③), ні як
      // «перестав виконуватись» (②) — інакше свідоме зняття спиняло б ланцюг двічі.
      const d = judgeDelta(baseTap, treeTap, retire.unaccounted, retire.accepted);
      if (retire.accepted.length) {
        d.lines.push(`🗑 ЗНЯТО СВІДОМО, прийнято реєстром ПОІМЕННО (${retire.accepted.length}):`,
          ...retire.accepted.map((n) => `   ﹣ ${n}`));
      }
      /**
       * 🔴 ПРИРІСТ НУЛЬ ≠ ПОВНЕ ПОКРИТТЯ, І ЦЬОГО НЕ БУЛО ВИДНО ЗІ ЗВІТУ.
       *
       * 📐 Заміряно 27.08.2026 на ОДНІЙ базі: у стенді «падінь 2, виконано 446», у
       * контейнері «падінь 104, виконано 595». Різниця не в коді — у стенді немає
       * `.env`, тож ~149 БД-гейтів чесно скіпаються. Критерій приросту в обох
       * оточеннях виконано (він порівнює однакові), і саме тому «8 із 8» читалось
       * як повне покриття, будучи покриттям НА 149 ПЕРЕВІРОК МЕНШИМ.
       *
       * Рішення власника: розрив НАЗВАТИ, а не закрити. Число тут — не привід
       * підкладати бойовий `.env` у стенд (це другий екземпляр доступів на диску);
       * це підпис під тим, чого прогін не бачив.
       */
      const ran = treeTap.filter((t) => !t.skipped).length;
      const skipped = treeTap.length - ran;
      const noEnv = !existsSync(`${c.be}/.env`);
      d.lines.push(
        `📐 ПОКРИТТЯ: виконано ${ran} із ${treeTap.length}, скіпнуто ${skipped}`
        + (noEnv
          ? " — у стенді немає backend/.env, тож БД-гейти не виконувались.\n"
            + "   «Приріст 0» тут означає «не гірше за базу В ЦЬОМУ Ж оточенні», а НЕ «перевірено все»."
          : "."));
      return { id: "test", ok: d.ok, detail: d.lines.join("\n") };
    } catch (e) {
      return { id: "test", ok: false, detail: `🔴 приріст не порахований: ${String((e as Error).message).slice(0, 300)}` };
    } finally {
      if (base) { try { sh("git", ["worktree", "remove", "--force", base], c.buildRepo); } catch { /* прибирання не сміє маскувати причину */ } }
    }
  },
  recount: (c) => run("recount", () => sh("git", ["rev-parse", c.prod], c.buildRepo), `перерахунок проти ${c.prod}`),
  artifact: (c) => {
    const art: Artifact = { branchSha: sh("git", ["rev-parse", "--short", "HEAD"], c.buildRepo), prodSha: c.prod, mode: c.mode, at: c.now };
    writeFileSync(ARTIFACT_PATH, JSON.stringify(art, null, 2));
    return { id: "artifact", ok: true, detail: `гілка ${art.branchSha} · прод ${art.prodSha}` };
  },
  // ── RUN ───────────────────────────────────────────────────────────────────
  /** Замок бере САМ скрипт: памʼятка не механізм, а ручний дотик має лишатись дорожчим. */
  lockTake: (c) => {
    const who = process.env.UTS_ACTOR ?? "deploy:run";
    const r = lockCli(["--take", `--who=${who}`, `--reason=викат ${c.target}`], CANON_LOCK_DIR);
    return { id: "lockTake", ok: r.code === 0, detail: r.out.join(" · ") };
  },
  /**
   * 🧪 ПРИЙМАННЯ — ЧАСТИНА ЛАНЦЮГА, А НЕ ЛЮДСЬКА ДИСЦИПЛІНА.
   *
   * 🔴 Привід переозначує чужий інцидент. 26.08.2026 HR ганяв `test:prod`, а журнал
   * казав «звільнено о 21:08», і два дні ми вважали це питанням дисципліни й писали
   * про це в промтах. Насправді **інструмент відпускав замок сам**, у кінці фази run:
   * `lockRelease` стояв ПІСЛЯ `pushBranch` і ПЕРЕД будь-яким прийманням, якого в
   * скрипті не було взагалі. Тобто дисципліну вимагали там, де її щоразу скасовував код.
   *
   * Тепер приймання — крок, а `lockRelease` стоїть ОДРАЗУ за ним. Провалилось
   * приймання — крок падає, ланцюг обривається, і замок лишається взятим САМ,
   * без жодної згадки про уважність.
   *
   * ⏱ Прогрів обовʼязковий і рахується від МОМЕНТУ РЕСТАРТУ, а не від початку кроку:
   * заміряно 23.08.2026 — процес віком 5 хв віддає /overview за 3.0-4.2 с, 12 хв — за
   * 2.35 с, і лише тоді `#36` зеленіє. Приймання, запущене раніше, червонить без
   * жодного регресу — а червоне, що не з нашої вини, за два тижні починають гортати.
   */
  accept: async (c) => {
    const since = c.restartedAt ?? Date.now();
    while (Date.now() - since < WARM_MS) {
      try { await fetch(HEALTH); } catch { /* прогрів, а не перевірка */ }
      await new Promise((r) => setTimeout(r, 20_000));
    }
    const log = "/tmp/deploy-accept.log";
    // `|| true`: ненульовий код тут — НОРМА (падіння тесту), а вирок вимовляє гейт прогону.
    /**
     * 🏷 ПЕРЕЛІК ІМЕН БЕРЕТЬСЯ З НАШОГО МАРКЕРА, А НЕ З СИМВОЛА РЕПОРТЕРА (#270).
     * До 01.09.2026 імена падінь виловлювали грепом по `✖` — символу, який малює
     * `spec`. Вирок від цього не залежав (його дає рядок «ВИКОНАЛОСЬ» + код кроку),
     * а от перелік мовчки порожнів би при зміні репортера чи версії node — і
     * порожній список читався б як «нічого не впало». Того ж дня це коштувало
     * іншому чату одинадцяти «зелених» саботажів.
     */
    const out = sh("bash", ["-lc",
      `cd ${c.prodBe} && set -a && . ./.env && set +a && `
      + `API_BASE=${API_BASE} npm run test:prod > ${log} 2>&1 || true; `
      + `grep "ВИКОНАЛОСЬ" ${log} | tail -1; grep "^${FAIL_MARK}" ${log} || true; `
      + `grep "^${EXPECTED_PASS_MARK}" ${log} || true`]);
    const named = failureNames(out);
    const passedFromRegistry = expectedPassNames(out);
    const m = out.match(/ВИКОНАЛОСЬ\s+(\d+)\s+із\s+(\d+).*?падінь\s+(\d+)/);
    /**
     * 🔴 Немає підсумкового рядка — це ПРОВАЛ, а не «нічого не знайшлось». Прогін,
     * що не дійшов до власного гейта, не є прийманням (той самий клас, що «успіх за 0 мс»).
     */
    if (!m) return { id: "accept", ok: false,
      detail: `🔴 гейт прогону не надрукував підсумку — приймання не дійшло до кінця. Лог: ${log}` };
    const [, doneN, needN, fails] = m;
    // Недобір і падіння — РІЗНІ вироки: перший каже «ми не дивились», другий «зламано».
    if (doneN !== needN) return { id: "accept", ok: false,
      detail: `🔴 НЕДОБІР: виконалось ${doneN} із ${needN} обовʼязкових — це СТОП, а не рядок статистики. Лог: ${log}` };
    if (fails !== "0") {
      /**
       * 🔴 ЧИСЛО Й ПЕРЕЛІК МУСЯТЬ ЗІЙТИСЬ. Розбіжність означає, що імена читаються не
       * звідти — саме той стан, коли список порожній, а падіння є. Тоді кажемо про це
       * прямо, а не мовчки друкуємо коротший перелік.
       *
       * 🔴 І ЦЕ ПЕРЕВІРЯЄТЬСЯ ДО РЕЄСТРУ, А НЕ ПІСЛЯ. Порожній перелік при `падінь > 0`
       * означав би «жодного імені не покрито» — і реєстр видав би зелене на прогоні,
       * про який ми не знаємо нічого. Той самий «порожній результат = провал».
       */
      if (named.length !== Number(fails)) {
        return { id: "accept", ok: false,
          detail: `🔴 падінь ${fails}, а перелік дав ${named.length} імен — розбір бачить не те, що рахує гейт. `
            + `Вирок за реєстром НЕ виноситься: судити нема за чим. Лог: ${log}` };
      }
      /**
       * ⚖️ МАШИННИЙ ВИРОК: зелено ⇔ кожне падіння названо в `EXPECTED_REDS` І реєстр
       * без дефектів. Доти «очікувані червоні» жили в чаті, тобто для ланцюга не
       * існували: він чесно червонів, замок лишався взятим, і людину доводилось
       * будити заради висновку, який уже був відомий.
       */
      const v = acceptExpectedReds(named, passedFromRegistry);
      if (v.ok) {
        return { id: "accept", ok: true,
          detail: `${doneN} із ${needN}, падінь ${fails} — УСІ очікувані поіменно\n${v.lines.join("\n")}` };
      }
      return { id: "accept", ok: false,
        detail: `🔴 падінь ${fails} при ${doneN} із ${needN}. Лог: ${log}\n${v.lines.join("\n")}` };
    }
    return { id: "accept", ok: true, detail: `${doneN} із ${needN}, падінь 0` };
  },
  lockRelease: (c) => {
    const who = process.env.UTS_ACTOR ?? "deploy:run";
    const r = lockCli(["--release", `--who=${who}`, `--reason=викат ${c.target} завершено`], CANON_LOCK_DIR);
    return { id: "lockRelease", ok: r.code === 0, detail: r.out.join(" · ") };
  },
  buildFresh: async (c) => {
    const h = await health();
    const disk = c.prodBe ? `${c.prodBe}/dist/version.json` : "";
    const onDisk: { sha?: string } | null = disk && existsSync(disk) ? JSON.parse(readFileSync(disk, "utf8")) : null;
    const stale = h.buildStale === true;
    const same = !!onDisk?.sha && onDisk.sha.startsWith(h.version.shortSha);
    const ok = !stale && !!onDisk && same;
    return { id: "buildFresh", ok,
      detail: ok ? `buildStale=false · version.json ${h.version.shortSha}`
        : !onDisk ? "🔴 dist/version.json НЕМАЄ — на диску немає збірки взагалі; сайт живий лише з памʼяті процесу"
        : stale ? `🔴 buildStale=true — на диску ${onDisk.sha?.slice(0, 7)}, у памʼяті ${h.version.shortSha}: зібрано й не рестартнуто`
        : `🔴 version.json ${onDisk.sha?.slice(0, 7)} ≠ health ${h.version.shortSha}` };
  },
  artifactFresh: async (c) => {
    const a: Artifact | null = existsSync(ARTIFACT_PATH) ? JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) : null;
    const live = await prodSha();
    c.prod = live;   // диф для `migrate` рахується проти ТОГО, що крутить прод ЗАРАЗ — до ff
    /**
     * 🔴 ЗВІРЯЄМО З ЦІЛЛЮ, А НЕ З HEAD ЧЕКАУТУ. До `ff` прод-чекаут стоїть на СТАРОМУ
     * sha, тож порівняння з його HEAD не збіглося б НІКОЛИ — і `deploy:run` вимагав би
     * ручної перемотки перед собою, якої немає в жодній інструкції. Ціль передається
     * явно (`--target=`), бо «те, що зараз у чекауті» не є наміром викату.
     */
    const v = verifyArtifact(a, c.target, live);
    return { id: "artifactFresh", ok: v.ok, detail: v.ok ? "артефакт свіжий за обома sha" : `🔴 ${v.reason}` };
  },
  /**
   * 🔴 ТЯГНЕМО ВСІ РЕФИ, А НЕ ЛИШЕ ПРОД-ГІЛКУ — інакше цілі просто немає в докруті.
   *
   * 📐 Спіймано першим живим запуском фази run (27.08.2026): крок робив
   * `git fetch origin <прод-гілка>`, а мерджив `c.target` — sha, що живе на ГІЛЦІ
   * РОЗРОБКИ. Докрут такого обʼєкта не має, і `merge --ff-only` падає з
   * «not something we can merge». Заміряно тоді ж: у докруті
   * `origin/claude/git-log-review-872eh2` стояв на ace4d2a, тобто на два коміти позаду.
   *
   * Крок міг спрацювати лише тоді, коли ціль уже випадково досяжна — тобто фаза run
   * ніколи не доходила до кінця. Повний `fetch` дешевий і нічого не змінює в дереві.
   */
  ff: (c) => run("ff", () => { sh("git", ["fetch", "origin"], c.docRoot); sh("git", ["merge", "--ff-only", c.target], c.docRoot); }, "перемотка докрута"),

  /**
   * 🔴 ДРУГА ПЕРЕВІРКА БАЗИ — ПІД ЗАМКОМ, БЕЗПОСЕРЕДНЬО ПЕРЕД ДОСТАВКОЮ.
   *
   * Раніше між заміром бази й доставкою минала ХВИЛИНА: перевірка, ff, збірка й копія
   * ішли одним ланцюгом. Після винесення збірка й приймання тривають ~21 хв — і вікно,
   * у яке прод може зрушити, розширюється в 21 раз.
   *
   * 📐 Заміряно по 58 викатах за 6 діб: наступний викат стається протягом 1 хв у 0%
   * випадків, протягом 21 хв — у 25%. Тобто приблизно кожна четверта доставка після
   * винесення принесла б артефакт на застарілій базі — і тихо знесла б чужі коміти,
   * бо дерево при цьому консистентне, просто старіше.
   * ⚠️ 25% — НИЖНЯ оцінка: рахувалась з історії СТАРОГО режиму, де фаза збірки була
   * під замком і двоє не могли сидіти в ній одночасно. Після винесення можуть.
   *
   * 🔴 ТРИ ТВЕРДЖЕННЯ, І ТРЕТЄ НЕ ЗАЙВЕ. Перші два — про HEAD дерева; але доставляємо
   * ми dist, а не HEAD. Між ними є зазор: HEAD правильний, а артефакт — від іншого
   * коміту (перезбирали, ребейзились після збірки). Тому третім звіряємо version.json
   * зібраного артефакта з HEAD стенда. Перевірка дерева не є перевіркою артефакту.
   */
  baseAgain: async (c) => {
    const live = await prodSha();
    sh("git", ["fetch", "origin", "-q"], c.buildRepo);
    const ancestor = (() => {
      try { sh("git", ["merge-base", "--is-ancestor", live, "HEAD"], c.buildRepo); return true; } catch { return false; }
    })();
    if (!ancestor) {
      const lost = sh("git", ["log", "--oneline", "HEAD.." + live], c.buildRepo);
      return { id: "baseAgain", ok: false, detail:
        "🔴 прод зрушив на " + live + ", поки ми збирали — ДОСТАВКИ НЕ БУДЕ.\n"
        + "Зникло б " + lost.split("\n").filter(Boolean).length + " комітів:\n" + lost + "\n"
        + "Віддай замок, ребейзни стенд і прожени крок 0 заново (≈2.8 хв).\n"
        + "🔴 НЕ «швидко домержити під замком»: це поверне збірку в чекаут, тобто рівно туди, звідки виносили." };
    }
    const head = sh("git", ["rev-parse", "HEAD"], c.buildRepo);
    const vPath = c.be + "/dist/version.json";
    if (!existsSync(vPath)) {
      return { id: "baseAgain", ok: false, detail:
        "🔴 у стенді немає " + vPath + " — доставляти нічого, збірки не було.\n"
        + "   Прожени фазу check у стенді: npm run deploy:check -- --mode=full" };
    }
    const built = String((JSON.parse(readFileSync(vPath, "utf8")) as { sha?: string }).sha ?? "");
    if (built !== head) {
      return { id: "baseAgain", ok: false, detail:
        "🔴 артефакт зібрано з " + built.slice(0, 7) + ", а HEAD стенда — " + head.slice(0, 7) + ".\n"
        + "Дерево правильне, а dist — від іншого коміту. Перезбери стенд і повтори." };
    }
    return { id: "baseAgain", ok: true,
      detail: "прод " + live + " — предок HEAD · артефакт зібрано саме з " + head.slice(0, 7) };
  },

  /**
   * 🔴 ДОСТАВКА, А НЕ ЗБІРКА. Фаза run більше нічого не компілює: усе зібрано в стенді
   * й перевірено кроком baseAgain. Саме це і звільняє чекаут — у ньому лишаються
   * копія, guard і рестарт (~1.5 хв замість ~21).
   */
  /**
   * 📦 ТАРБОЛ ТОГО, ЩО ВИЇЖДЖАЄ. Останній крок, що ще бачить старий стан.
   *
   * 🔴 Ім'я містить sha З VERSION.JSON, а не git HEAD. Крок іде ПІСЛЯ `ff`, тож HEAD
   * докрута вже НОВИЙ — назва за ним описувала б те, чого в тарболі немає, тобто
   * брехала б рівно про те, заради чого тарбол існує.
   *
   * 🔴 Каталог — ПОЗА докрутом. Заміряно 27.08.2026: тарбол у докруті по HTTP НЕ
   * віддається (обидві проби дали SPA-фолбек `<!doctype html>`, а не gzip). Але
   * тримається це на правилі перезапису в НЕВІДСТЕЖУВАНОМУ `.htaccess`, а не на межі
   * каталогу; винести коштує нуль, тож виносимо.
   */
  backupOutgoing: (c) => run("backupOutgoing", () => {
    sh("mkdir", ["-p", BACKUP_DIR]);
    let inner = "unknown";
    try { inner = String(JSON.parse(readFileSync(`${c.prodBe}/dist/version.json`, "utf8")).sha ?? "").slice(0, 7) || "unknown"; }
    catch { /* немає dist або version.json — тарболити все одно, але чесно назвати */ }
    const name = `pre-${inner}-${c.now.replace(/[:.]/g, "-")}.tgz`;
    // Тарболимо ЛИШЕ те, що наступні кроки знищать: dist (rm -rf), assets і index.html (copy/cssGuard).
    const parts = ["backend/dist", "assets", "index.html"].filter((p) => existsSync(`${c.docRoot}/${p}`));
    if (parts.length === 0) throw new Error("нема чого зберігати: ні dist, ні assets, ні index.html — це САМО ПО СОБІ дивно, спинись");
    sh("tar", ["czf", `${BACKUP_DIR}/${name}`, "-C", c.docRoot, ...parts]);
    const size = statSync(`${BACKUP_DIR}/${name}`).size;
    if (size < 1024) throw new Error(`тарбол ${size} Б — порожній результат це ПРОВАЛ, а не успіх`);
    /**
     * Ретенція — у ЦЬОМУ ж кроці, а не окремою джобою: інакше каталог росте тихо,
     * і про це дізнаються з «no space left on device» під час викату.
     */
    const keep = readdirSync(BACKUP_DIR).filter((f) => /^pre-.*\.tgz$/.test(f)).sort().reverse();
    const drop = keep.slice(BACKUP_KEEP);
    for (const f of drop) sh("rm", ["-f", `${BACKUP_DIR}/${f}`]);
    return `${name} · ${(size / 1048576).toFixed(1)} МБ · тримаємо ${Math.min(keep.length, BACKUP_KEEP)}`
      + (drop.length ? ` · прибрано ${drop.length}` : "");
  }, "копія виїжджаючого — відкат без перезбору"),
  deliver: (c) => run("deliver", () => {
    sh("rm", ["-rf", c.prodBe + "/dist"]);
    sh("cp", ["-r", c.be + "/dist", c.prodBe + "/dist"]);
  }, "dist стенда → backend докрута"),
  distNotEmpty: (c) => {
    const n = sh("bash", ["-lc", `ls ${c.fe}/dist/assets 2>/dev/null | wc -l`]);
    return { id: "distNotEmpty", ok: Number(n) > 0, detail: Number(n) > 0 ? `${n} асетів` : "🔴 dist/assets порожній — СТОП, інакше index.html лишиться старим при новому бекенді" };
  },
  copy: (c) => run("copy", () => sh("bash", ["-lc", `cd ${c.docRoot} && cp -r ${c.fe}/dist/assets/. assets/ && cp ${c.fe}/dist/favicon.svg ${c.fe}/dist/icons.svg . && cp ${c.fe}/dist/index.html index.html`]), "асети → статика → index.html останнім"),
  cssGuard: (c) => {
    const out = sh("bash", ["-lc", `cd ${c.docRoot} && for f in assets/index-*.js assets/index-*.css; do if grep -q "$(basename "$f")" index.html; then echo "ЛИШАЮ $(basename "$f")"; else echo "ВИДАЛЯЮ $(basename "$f")"; rm -f "$f"; fi; done`]);
    return { id: "cssGuard", ok: true, detail: out.replace(/\n/g, " · ") };
  },
  contentType: (c) => run("contentType", () => sh("bash", ["-lc", `cd ${c.docRoot} && for a in $(grep -o "assets/index-[A-Za-z0-9_-]*\\.\\(js\\|css\\)" index.html); do t=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "https://dashboard.uts.ua/$a?cb=$(date +%s)"); case "$t" in 200*javascript*|200*css*) ;; *) echo "🔴 $a → $t"; exit 1;; esac; done`]), "усі асети віддають свій тип"),
  migrate: (c) => {
    // 🔴 ДИВИМОСЬ У ДІФ, а не в прапорець: інакше звіт стверджує факт, якого ніхто не перевіряв.
    c.changed = sh("git", ["diff", "--name-only", `${c.prod}..HEAD`], c.buildRepo).split("\n").filter(Boolean);
    const migs = migrationsInDiff(c.changed);
    if (migs.length === 0) return { id: "migrate", ok: true, detail: "",
      skipped: `файлів схеми у діфі ${c.prod}..HEAD немає (переглянуто ${c.changed.length}) — крок НЕ виконувався (це не «міграції пройшли»)` };
    return run("migrate", () => sh("bash", ["-lc", `cd ${c.prodBe} && set -a && . ./.env && set +a && npm run migrate`]), `міграції застосовано (${migs.join(", ")}) — 🔴 звірити результат ОКРЕМИМ запитом: «Migration applied» друкується й тоді, коли частина роботи відкотилась`);
  },
  markDeploy: (c) => run("markDeploy", () => sh("bash", ["-lc", `cd ${c.prodBe} && set -a && . ./.env && set +a && node dist/tools/markDeploy.js --note="викат ${c.target}"`]), "намір заявлено ПЕРЕД kill"),
  kill: (c) => runStamp(c, "kill", () => sh("bash", ["-lc", `PID=$(ps -eo pid,args | awk '$2=="node" && $3=="dist/index.js" {print $1}' | head -1); [ -n "$PID" ] || { echo "процес не знайдено"; exit 1; }; kill -TERM "$PID"; echo "TERM → $PID"`]), "pid і kill однією командою"),
  healthVersion: async (c) => {
    for (let i = 0; i < 10; i++) {
      try { if ((await prodSha()) === c.target) return { id: "healthVersion", ok: true, detail: `health.version == ${c.target}` }; } catch { /* сервер підіймається */ }
      await new Promise((r) => setTimeout(r, 6000));
    }
    return { id: "healthVersion", ok: false, detail:
      `🔴 health не показав ${c.target} за 60 с — РЕСТАРТУ НЕ БУЛО, скільки б кнопка не звітувала.\n`
      + "   Прод зараз крутить СТАРИЙ код при НОВОМУ dist на диску (buildStale=true) — сайт живий.\n"
      + "   Далі: подивись лог прода; повтори kill через relay (див. INFRASTRUCTURE §7 крок 5);\n"
      + "   якщо процес не підіймається — відкат розпакуванням тарбола з /home/evraziat/uts.ua/deploy-backups.\n"
      + "   🔒 Замок НЕ віддавай: недороблений викат і є те, заради чого він узятий." };
  },
  bootKind: (c) => run("bootKind", () => sh("bash", ["-lc", `cd ${c.prodBe} && set -a && . ./.env && set +a && node -e '
    const { pool } = await import("./dist/db/pool.js");
    const r = await pool.query("SELECT kind, short_sha FROM app_boot ORDER BY booted_at DESC LIMIT 1");
    const row = r.rows[0]; await pool.end();
    if (row.kind !== "deploy") {
      console.error("🔴 останній старт класифіковано як " + row.kind + ", а не deploy.");
      console.error("   Причина майже завжди одна: markDeploy не відпрацював ПЕРЕД kill,");
      console.error("   тож classifyBoot побачив той самий sha і вирішив, що процес упав сам.");
      console.error("   Наслідок: банер «застосунок перезапустився без викату» користувачам");
      console.error("   і зіпсована статистика аварій. Полагодь порядок кроків і повтори викат;");
      console.error("   намір живе 15 хв, тож повторний markDeploy без kill нічого не дасть.");
      process.exit(1);
    }
    console.log("app_boot: " + row.kind + " " + row.short_sha);'`]), "старт класифіковано як deploy"),
  /**
   * 🔒 ПУШ У СТАРУ ГІЛКУ ВІДМОВЛЯЄ — З ПЕРШОЇ ХВИЛИНИ ПІСЛЯ ПЕРЕЇЗДУ.
   * Стара гілка лишається тиждень СТРАХОВКОЮ, тобто її треба читати, а не писати.
   * Тримати це домовленістю між трьома чатами означає три способи забути; тому —
   * відмова в інструменті. Правильніший був би git-хук, але хуків у нас немає.
   */
  pushBranch: (c) => {
    const refusal = pushRefusal(c.branch);
    if (refusal) return { id: "pushBranch", ok: false, detail: refusal };
    return run("pushBranch", () => sh("bash", ["-lc", `cd ${c.docRoot} && git push origin HEAD:${c.branch} && git fetch origin -q && git rev-list --left-right --count origin/${c.branch}...HEAD`]), "sha у прод-гілці, ahead/behind заміряно ПІСЛЯ fetch");
  },
  report: () => ({ id: "report", ok: true, detail: "звіт нижче" }),
};

export interface Ctx {
  /**
   * 🔴 ДВІ РОЛІ, ЯКІ РАНІШЕ БУЛИ ОДНИМ `repo` — І САМЕ ЇХНЄ ЗЛИТТЯ ТРИМАЛО ЧЕКАУТ
   * ЗАЙНЯТИМ ~21 ХВИЛИНУ. Збірка й приймання не потребують прод-дерева нічим, окрім
   * того, що вони в ньому лежали.
   *   `buildRepo` — стенд: джерела, збірка, тести. Докрута не торкається НІКОЛИ.
   *   `docRoot`   — прод-чекаут: доставка, CSS-guard, ff, рестарт, пуш у прод-гілку.
   */
  buildRepo: string; docRoot: string;
  /** `backend`/`frontend` СТЕНДА — там збирають. */
  be: string; fe: string;
  /**
   * `backend` ДОКРУТА. Окреме поле, бо там лежить `.env`: міграція, `markDeploy` і
   * читання `app_boot` можливі ЛИШЕ там. Плутати його з `be` не можна — саме на цьому
   * різниця між «зібрали» і «застосували».
   */
  prodBe: string;
  branch: string; target: string;
  mode: Mode; prod: string; now: string;
  /**
   * Мить успішного `kill`. Прогрів рахується ВІД НЕЇ, а не від початку кроку
   * приймання: інакше кожен крок між ними мовчки з'їдав би частину прогріву.
   */
  restartedAt?: number;
  /** Файли дифу проти прода — джерело для migrate. */
  changed: string[];
}

/** `run`, що на успіху штампує мить рестарту — від неї рахується прогрів. */
function runStamp(c: Ctx, id: string, fn: () => void, detail: string): StepResult {
  const r = run(id, fn, detail);
  if (r.ok) c.restartedAt = Date.now();
  return r;
}

function run(id: string, fn: () => void, detail: string): StepResult {
  try { fn(); return { id, ok: true, detail }; }
  catch (e) { return { id, ok: false, detail: `🔴 ${detail}: ${String((e as Error).message).slice(0, 300)}` }; }
}

/** Перелік кроків, які виконавець СПРАВДІ виконає — це і звіряє `#226`/`#226b`. */
export function executablePlan(phase: Phase, mode: Mode): string[] {
  return planSteps(phase, mode).filter((s) => s.id in handlers).map((s) => s.id);
}

/** Кроки з реєстру, для яких обробника НЕМАЄ — тобто мовчки не виконаються. */
export function missingHandlers(): Step[] {
  return REQUIRED_STEPS.filter((s) => !(s.id in handlers));
}

export async function main(argv: string[]): Promise<number> {
  const phase = (argv.find((a) => a === "check" || a === "run") ?? "") as Phase | "";
  const mode = argv.find((a) => a.startsWith("--mode="))?.slice(7) as Mode | undefined;
  const dry = argv.includes("--dry-run");
  if (!phase) { console.error("🔴 вкажи фазу: check | run"); return 2; }
  if (mode !== "full" && mode !== "light") {
    console.error("🔴 РЕЖИМ ЛИШЕ ЯВНО: --mode=full | --mode=light.\n"
      + "   Мовчазного дефолту немає навмисно: дешевий викат розбещує.");
    return 2;
  }
  const plan = planSteps(phase, mode);
  if (mode === "light") {
    console.log("⚠️ ЛЕГКИЙ РЕЖИМ НЕ РОБИТЬ:");
    for (const o of LIGHT_OMITS) console.log(`   ﹣ ${o}`);
  }
  if (dry) { console.log(plan.map((s, i) => `${i + 1}. ${s.id} — ${s.title}`).join("\n")); return 0; }

  /**
   * 🔴 ДВА ДЕРЕВА, І ЇХ НЕ МОЖНА ПЛУТАТИ.
   *   UTS_BUILD_REPO — стенд (клон). Тут збирають і ганяють тести.
   *   UTS_DOC_ROOT   — прод-чекаут = докрут. Сюди доставляють, звідси рестартують.
   * Дефолти лишають СТАРУ поведінку (обидва = поточний каталог), щоб перехід був
   * оборотним; але фаза run на злитих шляхах ВІДМОВЛЯЄ — див. нижче.
   */
  const { buildRepo, docRoot } = resolveTrees(process.env, process.cwd());
  if (phase === "check" && isProdCheckout({
    rootIndexHtml: existsSync(`${buildRepo}/index.html`), rootAssets: existsSync(`${buildRepo}/assets`), path: buildRepo, docRoot,
  })) { console.error(PROD_CHECKOUT_REFUSAL); return 3; }
  const targetArg = argv.find((a) => a.startsWith("--target="))?.slice(9);
  if (phase === "run" && !targetArg) {
    console.error("🔴 `deploy:run` потребує --target=<sha> — те, що ЗАРАЗ у чекауті, не є наміром викату.\n"
      + "   Візьми sha з артефакта `deploy:check` (поле branchSha).");
    return 2;
  }
  /**
   * ⚠️ ПОРЯДОК: помилка АРГУМЕНТА — раніше за помилку КОНФІГУРАЦІЇ.
   * 🔴 Спіймано прийманням 27.08.2026: відмова «одне дерево» (код 3) стояла ВИЩЕ і
   * перехоплювала випадок «run без --target» (код 2). У прод-чекауті
   * `buildRepo === docRoot` виконується завжди, тож гейт #226h там діставав 3 замість 2
   * і червонів — не тому, що зламалась його перевірка, а тому, що до неї не доходило.
   * Обидві відмови до-руйнівні, тож переставити їх безпечно; повідомлення точніше.
   */
  /**
   * 🔴 ЗБИРАТИ Й ДОСТАВЛЯТИ В ОДНОМУ ДЕРЕВІ — ЦЕ РІВНО ТЕ, ВІД ЧОГО МИ ЙШЛИ.
   * Якщо шляхи збіглись, чекаут знову буде зайнятий усі ~21 хв, а гейт «жоден крок
   * збірки не торкається докрута» стане беззмістовним: торкатись буде нічого.
   */
  if (phase === "run" && buildRepo === docRoot) {
    console.error(SAME_TREE_REFUSAL({ buildRepo, docRoot }));
    return 3;
  }
  const ctx: Ctx = {
    buildRepo, docRoot,
    be: `${buildRepo}/backend`, fe: `${buildRepo}/frontend`, prodBe: `${docRoot}/backend`,
    branch: process.env.UTS_PROD_BRANCH ?? PROD_BRANCH,
    target: targetArg ?? sh("git", ["rev-parse", "--short", "HEAD"], buildRepo),
    mode, prod: "", now: new Date().toISOString(), changed: [],
  };
  const done: StepResult[] = [];
  /**
   * 🔴 ДОТИК ДО ЗАМКА ПЕРЕД КОЖНИМ КРОКОМ — обидві половини рішення про TTL одним
   * рухом (рішення власника 02.09.2026):
   *   ① TTL міряє БЕЗДІЯЛЬНІСТЬ: поки ланцюг робить кроки, замок не старіє. Доти
   *      нормальне коло (`run` ~18 хв, з них 16 хв прогріву) впритул підходило до
   *      порогу 20 хв — і замок, що активно працював, називався покинутим;
   *   ② FAIL-CLOSED: якщо замок уже не наш, крок НЕ виконується. Робота під чужим
   *      замком і є те, що робить крадіжку невидимою — 02.09.2026 саме так у
   *      спільному дереві опинився чужий ланцюг.
   * Дотик стоїть ПІСЛЯ `lockTake` (до нього замка ще немає) і не пише в журнал.
   */
  /**
   * 🔴 СТАН ВИЗНАЧАЄТЬСЯ З ДИСКА, А НЕ З ВЛАСНОГО КРОКУ. `false` тут означало «дотик
   * вмикає лише наш `lockTake`» — і фаза `run`, де того кроку більше немає, лишалась
   * БЕЗ дотиків. Заміряно на живому викаті 9781c12: 11 хв бездіяльності на замку, що
   * працював, при TTL 20 хв. Тепер ланцюг питає замок, чий він, а не памʼятає це.
   */
  let lockOurs = heldByMe(readClaim(CANON_LOCK_DIR), process.env.UTS_ACTOR ?? "deploy");
  for (const step of plan) {
    const h = handlers[step.id];
    if (!h) { console.error(`🔴 КРОК БЕЗ ОБРОБНИКА: ${step.id} — зупиняюсь`); return 1; }
    if (lockOurs) {
      const t = lockCli(["--touch", `--who=${process.env.UTS_ACTOR ?? "deploy"}`], CANON_LOCK_DIR);
      if (t.code !== 0) {
        console.error(`✖ ${"lockTouch".padEnd(16)} перед кроком «${step.id}»`);
        for (const l of t.out) console.error(`  ${l}`);
        // 🔴 МАРКЕР — З МНОЖИНИ, А НЕ ЛІТЕРАЛОМ (`#26h`). Втрата замка це ТЕРМІНАЛЬНИЙ
        // стан: ланцюг далі не піде. Літерал зробив би його видимим людині й невидимим
        // тому, хто чекає закінчення полінгом, — 02.09.2026 такий стан коштував 40 хв
        // полінгу повз померлий процес при замку, що весь той час тримався.
        console.error(`\n${MARK_STOP}: замок перестав бути нашим — далі не йдемо.`);
        return 7;
      }
    }
    const r = await h(ctx);
    if (step.id === "lockTake" && r.ok) lockOurs = true;
    done.push(r);
    const mark = r.skipped ? "﹣" : r.ok ? "✔" : "✖";
    /**
     * 🔴 ЗВІТ ВОЛОДІЄ СВОЇМ ФОРМАТУВАННЯМ, А НЕ СКЛЕЮЄ ЧУЖЕ. Раніше багаторядкова
     * деталь приїжджала вже склеєною, і кожен крок сам вирішував, скільки в неї
     * відступів, — а рядки з ІМЕНАМИ (нові падіння, зниклі гейти) губились рівно
     * тоді, коли вони найпотрібніші: «① НОВІ ПАДІННЯ (1)» без жодного імені.
     * Це та сама поломка, проти якої весь критерій і будувався.
     */
    const body = (r.skipped ?? r.detail).split("\n");
    console.log(`${mark} ${step.id.padEnd(16)} ${body[0]}`);
    for (const line of body.slice(1)) console.log(`  ${line.trimStart()}`);
    if (!r.ok) {
      /**
       * 🔴 НЕ ЛИШЕ ПРИЧИНА, А Й СТАН ПРОДА — СЛОВАМИ. Скрипт, що впав на кроці 9 із
       * 15, інакше лишає прод у стані, якого ніхто не назве вголос; а не сказане
       * вголос читається як благополуччя.
       */
      console.error(`\n${MARK_STOP} на кроці «${step.id}» — ${step.why}`);
      const ab = abortState(step.id, done.filter((d) => d.ok && !d.skipped).map((d) => d.id),
        { prodSha: ctx.prod || "(невідомо)", targetSha: ctx.target, branch: ctx.branch });
      console.error(`\n📍 СТАН ПРОДА: ${ab.state}`);
      for (const l of ab.lines) console.error(`   ${l}`);
      return ab.exitCode;
    }
  }
  const skipped = done.filter((d) => d.skipped);
  console.log(`\n${MARK_REPORT} · фаза ${phase} · режим ${mode} · виконано ${done.length - skipped.length} із ${plan.length}`);
  if (skipped.length) {
    console.log("﹣ НЕ ВИКОНУВАЛИСЬ (це НЕ «пройшло»):");
    for (const s of skipped) console.log(`   ${s.id}: ${s.skipped}`);
  }
  /**
   * 🔴 «СКРИПТ ВІДПРАЦЮВАВ» ≠ «ПРИЙНЯТО». Скрипт закінчується на `report`; прогрів і
   * `test:prod` лишаються ЛЮДСЬКОЮ дією. Не сказати цього вголос означає віддати
   * зелений вивід, який прочитають як приймання — той самий клас, що «0 падінь»,
   * коли третина тестів не виконалась.
   */
  const accepted = done.some((x) => x.id === "accept" && x.ok && !x.skipped);
  if (phase === "run" && !accepted) {
    console.log("\n🔴 ПРИЙМАННЯ НЕ ЗРОБЛЕНО — і замок НЕ звільнено (це навмисно):");
    console.log("   ﹣ прогрів ~13 хв (перший запит після рестарту холодний)");
    console.log("   ﹣ npm run test:prod з API_BASE");
    console.log("   ﹣ і аж потім: npm run lock -- --release --who=<ти> --reason=\"…\"");
    if (done.some((d) => d.id === "migrate" && !d.skipped))
      console.log("   ﹣ 🔴 БУЛА МІГРАЦІЯ: звірити результат ОКРЕМИМ запитом, а не за виводом «Migration applied»");
  }
  console.log(JSON.stringify({ phase, mode, acceptanceDone: accepted,
    steps: done.map((d) => ({ id: d.id, ok: d.ok, skipped: d.skipped ?? null })) }));
  return 0;
}

if (process.argv[1]?.endsWith("deploy.js")) main(process.argv.slice(2)).then((c) => process.exit(c));
