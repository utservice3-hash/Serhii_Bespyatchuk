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
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  REQUIRED_STEPS, planSteps, verifyArtifact, LIGHT_OMITS, abortState, migrationsInDiff, isProdCheckout, PROD_CHECKOUT_REFUSAL,
  type Mode, type Phase, type Step, type Artifact,
} from "./deployPlan.js";
import { cli as lockCli } from "./checkoutLock.js";
import { parseTap, judgeDelta } from "./testDelta.js";
import { MANIFEST_TESTS, diffGates } from "../testManifest.js";
import { testsAtRef } from "./gateCount.js";
import { rmSync, symlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

export const ARTIFACT_PATH = "/tmp/uts-deploy-check.json";
const HEALTH = "https://dashboard.uts.ua/api/health";

const sh = (cmd: string, args: string[], cwd?: string): string =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/** Результат кроку. `skipped` НЕ є успіхом: він друкується окремо з причиною. */
export interface StepResult { id: string; ok: boolean; skipped?: string; detail: string }

interface Health { version: { shortSha: string }; buildStale?: boolean }
async function health(): Promise<Health> {
  const r = await fetch(HEALTH);
  if (!r.ok) throw new Error(`health віддав ${r.status}`);
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

function toolsPresent(id: string): StepResult {
  const missing = ["npm", "node", "git"].filter((t) => {
    try { sh(t, ["--version"]); return false; } catch { return true; }
  });
  const named = existsSync(`${NODE_BIN}/node`) && existsSync(`${NODE_BIN}/npm`);
  if (!named) return { id, ok: false,
    detail: `🔴 у ${NODE_BIN} немає node/npm — далі йти НЕ МОЖНА: наступний крок починається з \`rm -rf dist\`` };
  return { id, ok: missing.length === 0,
    detail: missing.length
      ? `🔴 у PATH немає: ${missing.join(", ")} — далі йти НЕ МОЖНА: наступний крок починається з \`rm -rf dist\``
      : "npm, node, git на місці" };
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
  toolsCheck: () => toolsPresent("toolsCheck"),
  toolsRun: () => toolsPresent("toolsRun"),
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
  buildBack: (c) => run("buildBack", () => { sh("rm", ["-rf", "dist"], c.be); sh("npm", ["run", "build"], c.be); }, "чиста збірка бекенда"),
  tscFront: (c) => run("tscFront", () => sh("npx", ["tsc", "-b"], c.fe), "tsc -b фронту (НЕ --noEmit: він там нічого не перевіряє)"),
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
          + "Порожній результат = провал, а не «падінь немає»." };
      }
      const lost = diffGates(testsAtRef(c.prod), MANIFEST_TESTS).onlyBefore;
      const d = judgeDelta(baseTap, treeTap, lost);
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
    const r = lockCli(["--take", `--who=${who}`, `--reason=викат ${c.target}`], c.docRoot);
    return { id: "lockTake", ok: r.code === 0, detail: r.out.join(" · ") };
  },
  lockRelease: (c) => {
    const who = process.env.UTS_ACTOR ?? "deploy:run";
    const r = lockCli(["--release", `--who=${who}`, `--reason=викат ${c.target} завершено`], c.docRoot);
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
  ff: (c) => run("ff", () => { sh("git", ["fetch", "origin", c.branch], c.docRoot); sh("git", ["merge", "--ff-only", c.target], c.docRoot); }, "перемотка докрута"),

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
      return { id: "baseAgain", ok: false, detail: "🔴 у стенді немає " + vPath + " — доставляти нічого, збірки не було" };
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
  kill: () => run("kill", () => sh("bash", ["-lc", `PID=$(ps -eo pid,args | awk '$2=="node" && $3=="dist/index.js" {print $1}' | head -1); [ -n "$PID" ] || { echo "процес не знайдено"; exit 1; }; kill -TERM "$PID"; echo "TERM → $PID"`]), "pid і kill однією командою"),
  healthVersion: async (c) => {
    for (let i = 0; i < 10; i++) {
      try { if ((await prodSha()) === c.target) return { id: "healthVersion", ok: true, detail: `health.version == ${c.target}` }; } catch { /* сервер підіймається */ }
      await new Promise((r) => setTimeout(r, 6000));
    }
    return { id: "healthVersion", ok: false, detail: `🔴 health не показав ${c.target} — РЕСТАРТУ НЕ БУЛО, скільки б кнопка не звітувала` };
  },
  bootKind: (c) => run("bootKind", () => sh("bash", ["-lc", `cd ${c.prodBe} && set -a && . ./.env && set +a && node -e '
    const { pool } = await import("./dist/db/pool.js");
    const r = await pool.query("SELECT kind, short_sha FROM app_boot ORDER BY booted_at DESC LIMIT 1");
    const row = r.rows[0]; await pool.end();
    if (row.kind !== "deploy") { console.error("🔴 останній старт класифіковано як " + row.kind); process.exit(1); }
    console.log("app_boot: " + row.kind + " " + row.short_sha);'`]), "старт класифіковано як deploy"),
  pushBranch: (c) => run("pushBranch", () => sh("bash", ["-lc", `cd ${c.docRoot} && git push origin HEAD:${c.branch} && git fetch origin -q && git rev-list --left-right --count origin/${c.branch}...HEAD`]), "sha у прод-гілці, ahead/behind заміряно ПІСЛЯ fetch"),
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
  /** Файли дифу проти прода — джерело для migrate. */
  changed: string[];
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
  const buildRepo = process.env.UTS_BUILD_REPO ?? process.env.UTS_REPO ?? process.cwd().replace(/\/backend$/, "");
  const docRoot = process.env.UTS_DOC_ROOT ?? "/home/evraziat/uts.ua/dashboard";
  if (phase === "check" && isProdCheckout({
    rootIndexHtml: existsSync(`${buildRepo}/index.html`), rootAssets: existsSync(`${buildRepo}/assets`), path: buildRepo, docRoot,
  })) { console.error(PROD_CHECKOUT_REFUSAL); return 3; }
  /**
   * 🔴 ЗБИРАТИ Й ДОСТАВЛЯТИ В ОДНОМУ ДЕРЕВІ — ЦЕ РІВНО ТЕ, ВІД ЧОГО МИ ЙШЛИ.
   * Якщо шляхи збіглись, чекаут знову буде зайнятий усі ~21 хв, а гейт «жоден крок
   * збірки не торкається докрута» стане беззмістовним: торкатись буде нічого.
   */
  if (phase === "run" && buildRepo === docRoot) {
    console.error("🔴 UTS_BUILD_REPO і UTS_DOC_ROOT — це ОДИН каталог.\n"
      + "   Фаза run доставляє те, що зібрав СТЕНД; збирати й доставляти в одному дереві\n"
      + "   означає повернути чекаут у стан «зайнятий 21 хвилину». Признач стенд явно.");
    return 3;
  }
  const targetArg = argv.find((a) => a.startsWith("--target="))?.slice(9);
  if (phase === "run" && !targetArg) {
    console.error("🔴 `deploy:run` потребує --target=<sha> — те, що ЗАРАЗ у чекауті, не є наміром викату.\n"
      + "   Візьми sha з артефакта `deploy:check` (поле branchSha).");
    return 2;
  }
  const ctx: Ctx = {
    buildRepo, docRoot,
    be: `${buildRepo}/backend`, fe: `${buildRepo}/frontend`, prodBe: `${docRoot}/backend`,
    branch: process.env.UTS_PROD_BRANCH ?? "claude/friendly-galileo-8pijhl",
    target: targetArg ?? sh("git", ["rev-parse", "--short", "HEAD"], buildRepo),
    mode, prod: "", now: new Date().toISOString(), changed: [],
  };
  const done: StepResult[] = [];
  for (const step of plan) {
    const h = handlers[step.id];
    if (!h) { console.error(`🔴 КРОК БЕЗ ОБРОБНИКА: ${step.id} — зупиняюсь`); return 1; }
    const r = await h(ctx);
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
      console.error(`\n🔴 СТОП на кроці «${step.id}» — ${step.why}`);
      const ab = abortState(step.id, done.filter((d) => d.ok && !d.skipped).map((d) => d.id),
        { prodSha: ctx.prod || "(невідомо)", targetSha: ctx.target, branch: ctx.branch });
      console.error(`\n📍 СТАН ПРОДА: ${ab.state}`);
      for (const l of ab.lines) console.error(`   ${l}`);
      return ab.exitCode;
    }
  }
  const skipped = done.filter((d) => d.skipped);
  console.log(`\n📋 ЗВІТ · фаза ${phase} · режим ${mode} · виконано ${done.length - skipped.length} із ${plan.length}`);
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
  if (phase === "run") {
    console.log("\n🔴 ПРИЙМАННЯ НЕ ЗРОБЛЕНО — це не входить у скрипт:");
    console.log("   ﹣ прогрів ~13 хв (перший запит після рестарту холодний)");
    console.log("   ﹣ npm run test:prod з API_BASE");
    if (done.some((d) => d.id === "migrate" && !d.skipped))
      console.log("   ﹣ 🔴 БУЛА МІГРАЦІЯ: звірити результат ОКРЕМИМ запитом, а не за виводом «Migration applied»");
  }
  console.log(JSON.stringify({ phase, mode, acceptanceDone: false,
    steps: done.map((d) => ({ id: d.id, ok: d.ok, skipped: d.skipped ?? null })) }));
  return 0;
}

if (process.argv[1]?.endsWith("deploy.js")) main(process.argv.slice(2)).then((c) => process.exit(c));
