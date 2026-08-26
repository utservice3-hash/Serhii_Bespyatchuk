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
function toolsPresent(id: string): StepResult {
  const missing = ["npm", "node", "git"].filter((t) => {
    try { sh(t, ["--version"]); return false; } catch { return true; }
  });
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
      try { sh("git", ["merge-base", "--is-ancestor", live, "HEAD"], c.repo); return true; }
      catch { return false; }
    })();
    return { id: "base", ok, detail: ok ? `прод ${live} — предок HEAD` : `🔴 прод ${live} НЕ предок HEAD: потрібен ребейз, інакше викат тихо відкотить чужий прохід` };
  },
  lightAdmission: (c) => {
    const outside = sh("git", ["diff", "--name-only", `${c.prod}..HEAD`], c.repo)
      .split("\n").filter((f) => f && !f.startsWith("frontend/"));
    return { id: "lightAdmission", ok: outside.length === 0,
      detail: outside.length ? `🔴 поза frontend/: ${outside.join(", ")} — режим ПОВНИЙ` : "діф лише у frontend/" };
  },
  buildBack: (c) => run("buildBack", () => { sh("rm", ["-rf", "dist"], c.be); sh("npm", ["run", "build"], c.be); }, "чиста збірка бекенда"),
  tscFront: (c) => run("tscFront", () => sh("npx", ["tsc", "-b"], c.fe), "tsc -b фронту (НЕ --noEmit: він там нічого не перевіряє)"),
  test: (c) => run("test", () => sh("npm", ["test"], c.be), "npm test"),
  recount: (c) => run("recount", () => sh("git", ["rev-parse", c.prod], c.repo), `перерахунок проти ${c.prod}`),
  artifact: (c) => {
    const art: Artifact = { branchSha: sh("git", ["rev-parse", "--short", "HEAD"], c.repo), prodSha: c.prod, mode: c.mode, at: c.now };
    writeFileSync(ARTIFACT_PATH, JSON.stringify(art, null, 2));
    return { id: "artifact", ok: true, detail: `гілка ${art.branchSha} · прод ${art.prodSha}` };
  },
  // ── RUN ───────────────────────────────────────────────────────────────────
  /** Замок бере САМ скрипт: памʼятка не механізм, а ручний дотик має лишатись дорожчим. */
  lockTake: (c) => {
    const who = process.env.UTS_ACTOR ?? "deploy:run";
    const r = lockCli(["--take", `--who=${who}`, `--reason=викат ${c.target}`], c.repo);
    return { id: "lockTake", ok: r.code === 0, detail: r.out.join(" · ") };
  },
  lockRelease: (c) => {
    const who = process.env.UTS_ACTOR ?? "deploy:run";
    const r = lockCli(["--release", `--who=${who}`, `--reason=викат ${c.target} завершено`], c.repo);
    return { id: "lockRelease", ok: r.code === 0, detail: r.out.join(" · ") };
  },
  buildFresh: async (c) => {
    const h = await health();
    const disk = c.be ? `${c.be}/dist/version.json` : "";
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
  ff: (c) => run("ff", () => { sh("git", ["fetch", "origin", c.branch], c.repo); sh("git", ["merge", "--ff-only", c.target], c.repo); }, "перемотка"),
  buildBackProd: (c) => run("buildBackProd", () => { sh("rm", ["-rf", "dist"], c.be); sh("npm", ["run", "build"], c.be); }, "збірка бекенда"),
  buildFront: (c) => run("buildFront", () => sh("npm", ["run", "build"], c.fe), "збірка фронта"),
  distNotEmpty: (c) => {
    const n = sh("bash", ["-lc", `ls ${c.fe}/dist/assets 2>/dev/null | wc -l`]);
    return { id: "distNotEmpty", ok: Number(n) > 0, detail: Number(n) > 0 ? `${n} асетів` : "🔴 dist/assets порожній — СТОП, інакше index.html лишиться старим при новому бекенді" };
  },
  copy: (c) => run("copy", () => sh("bash", ["-lc", `cd ${c.repo} && cp -r frontend/dist/assets/. assets/ && cp frontend/dist/favicon.svg frontend/dist/icons.svg . && cp frontend/dist/index.html index.html`]), "асети → статика → index.html останнім"),
  cssGuard: (c) => {
    const out = sh("bash", ["-lc", `cd ${c.repo} && for f in assets/index-*.js assets/index-*.css; do if grep -q "$(basename "$f")" index.html; then echo "ЛИШАЮ $(basename "$f")"; else echo "ВИДАЛЯЮ $(basename "$f")"; rm -f "$f"; fi; done`]);
    return { id: "cssGuard", ok: true, detail: out.replace(/\n/g, " · ") };
  },
  contentType: (c) => run("contentType", () => sh("bash", ["-lc", `cd ${c.repo} && for a in $(grep -o "assets/index-[A-Za-z0-9_-]*\\.\\(js\\|css\\)" index.html); do t=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "https://dashboard.uts.ua/$a?cb=$(date +%s)"); case "$t" in 200*javascript*|200*css*) ;; *) echo "🔴 $a → $t"; exit 1;; esac; done`]), "усі асети віддають свій тип"),
  migrate: (c) => {
    // 🔴 ДИВИМОСЬ У ДІФ, а не в прапорець: інакше звіт стверджує факт, якого ніхто не перевіряв.
    c.changed = sh("git", ["diff", "--name-only", `${c.prod}..HEAD`], c.repo).split("\n").filter(Boolean);
    const migs = migrationsInDiff(c.changed);
    if (migs.length === 0) return { id: "migrate", ok: true, detail: "",
      skipped: `файлів схеми у діфі ${c.prod}..HEAD немає (переглянуто ${c.changed.length}) — крок НЕ виконувався (це не «міграції пройшли»)` };
    return run("migrate", () => sh("bash", ["-lc", `cd ${c.be} && set -a && . ./.env && set +a && npm run migrate`]), `міграції застосовано (${migs.join(", ")}) — 🔴 звірити результат ОКРЕМИМ запитом: «Migration applied» друкується й тоді, коли частина роботи відкотилась`);
  },
  markDeploy: (c) => run("markDeploy", () => sh("bash", ["-lc", `cd ${c.be} && set -a && . ./.env && set +a && node dist/tools/markDeploy.js --note="викат ${c.target}"`]), "намір заявлено ПЕРЕД kill"),
  kill: () => run("kill", () => sh("bash", ["-lc", `PID=$(ps -eo pid,args | awk '$2=="node" && $3=="dist/index.js" {print $1}' | head -1); [ -n "$PID" ] || { echo "процес не знайдено"; exit 1; }; kill -TERM "$PID"; echo "TERM → $PID"`]), "pid і kill однією командою"),
  healthVersion: async (c) => {
    for (let i = 0; i < 10; i++) {
      try { if ((await prodSha()) === c.target) return { id: "healthVersion", ok: true, detail: `health.version == ${c.target}` }; } catch { /* сервер підіймається */ }
      await new Promise((r) => setTimeout(r, 6000));
    }
    return { id: "healthVersion", ok: false, detail: `🔴 health не показав ${c.target} — РЕСТАРТУ НЕ БУЛО, скільки б кнопка не звітувала` };
  },
  bootKind: (c) => run("bootKind", () => sh("bash", ["-lc", `cd ${c.be} && set -a && . ./.env && set +a && node -e '
    const { pool } = await import("./dist/db/pool.js");
    const r = await pool.query("SELECT kind, short_sha FROM app_boot ORDER BY booted_at DESC LIMIT 1");
    const row = r.rows[0]; await pool.end();
    if (row.kind !== "deploy") { console.error("🔴 останній старт класифіковано як " + row.kind); process.exit(1); }
    console.log("app_boot: " + row.kind + " " + row.short_sha);'`]), "старт класифіковано як deploy"),
  pushBranch: (c) => run("pushBranch", () => sh("bash", ["-lc", `cd ${c.repo} && git push origin HEAD:${c.branch} && git fetch origin -q && git rev-list --left-right --count origin/${c.branch}...HEAD`]), "sha у прод-гілці, ahead/behind заміряно ПІСЛЯ fetch"),
  report: () => ({ id: "report", ok: true, detail: "звіт нижче" }),
};

export interface Ctx {
  repo: string; be: string; fe: string; branch: string; target: string;
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

  const repo = process.env.UTS_REPO ?? process.cwd().replace(/\/backend$/, "");
  if (phase === "check" && isProdCheckout({
    rootIndexHtml: existsSync(`${repo}/index.html`), rootAssets: existsSync(`${repo}/assets`), path: repo,
  })) { console.error(PROD_CHECKOUT_REFUSAL); return 3; }
  const targetArg = argv.find((a) => a.startsWith("--target="))?.slice(9);
  if (phase === "run" && !targetArg) {
    console.error("🔴 `deploy:run` потребує --target=<sha> — те, що ЗАРАЗ у чекауті, не є наміром викату.\n"
      + "   Візьми sha з артефакта `deploy:check` (поле branchSha).");
    return 2;
  }
  const ctx: Ctx = {
    repo, be: `${repo}/backend`, fe: `${repo}/frontend`,
    branch: process.env.UTS_PROD_BRANCH ?? "claude/friendly-galileo-8pijhl",
    target: targetArg ?? sh("git", ["rev-parse", "--short", "HEAD"], repo),
    mode, prod: "", now: new Date().toISOString(), changed: [],
  };
  const done: StepResult[] = [];
  for (const step of plan) {
    const h = handlers[step.id];
    if (!h) { console.error(`🔴 КРОК БЕЗ ОБРОБНИКА: ${step.id} — зупиняюсь`); return 1; }
    const r = await h(ctx);
    done.push(r);
    const mark = r.skipped ? "﹣" : r.ok ? "✔" : "✖";
    console.log(`${mark} ${step.id.padEnd(16)} ${r.skipped ?? r.detail}`);
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
