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
  REQUIRED_STEPS, planSteps, verifyArtifact, LIGHT_OMITS,
  type Mode, type Phase, type Step, type Artifact,
} from "./deployPlan.js";

export const ARTIFACT_PATH = "/tmp/uts-deploy-check.json";
const HEALTH = "https://dashboard.uts.ua/api/health";

const sh = (cmd: string, args: string[], cwd?: string): string =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/** Результат кроку. `skipped` НЕ є успіхом: він друкується окремо з причиною. */
export interface StepResult { id: string; ok: boolean; skipped?: string; detail: string }

async function prodSha(): Promise<string> {
  const r = await fetch(HEALTH);
  if (!r.ok) throw new Error(`health віддав ${r.status}`);
  return ((await r.json()) as { version: { shortSha: string } }).version.shortSha;
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
  artifactFresh: async (c) => {
    const a: Artifact | null = existsSync(ARTIFACT_PATH) ? JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) : null;
    const v = verifyArtifact(a, sh("git", ["rev-parse", "--short", "HEAD"], c.repo), await prodSha());
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
    if (!c.hasMigrations) return { id: "migrate", ok: true, skipped: "міграцій у діфі немає — крок НЕ виконувався (це не «міграції пройшли»)", detail: "" };
    return run("migrate", () => sh("bash", ["-lc", `cd ${c.be} && set -a && . ./.env && set +a && npm run migrate`]), "міграції застосовано — ОБОВʼЯЗКОВО звірити результат ОКРЕМИМ запитом");
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
  mode: Mode; prod: string; now: string; hasMigrations: boolean;
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
  const ctx: Ctx = {
    repo, be: `${repo}/backend`, fe: `${repo}/frontend`,
    branch: process.env.UTS_PROD_BRANCH ?? "claude/friendly-galileo-8pijhl",
    target: sh("git", ["rev-parse", "--short", "HEAD"], repo),
    mode, prod: "", now: new Date().toISOString(),
    hasMigrations: false,
  };
  const done: StepResult[] = [];
  for (const step of plan) {
    const h = handlers[step.id];
    if (!h) { console.error(`🔴 КРОК БЕЗ ОБРОБНИКА: ${step.id} — зупиняюсь`); return 1; }
    const r = await h(ctx);
    done.push(r);
    const mark = r.skipped ? "﹣" : r.ok ? "✔" : "✖";
    console.log(`${mark} ${step.id.padEnd(16)} ${r.skipped ?? r.detail}`);
    if (!r.ok) { console.error(`\n🔴 СТОП на кроці «${step.id}» — ${step.why}`); return 1; }
  }
  const skipped = done.filter((d) => d.skipped);
  console.log(`\n📋 ЗВІТ · фаза ${phase} · режим ${mode} · виконано ${done.length - skipped.length} із ${plan.length}`);
  if (skipped.length) {
    console.log("﹣ НЕ ВИКОНУВАЛИСЬ (це НЕ «пройшло»):");
    for (const s of skipped) console.log(`   ${s.id}: ${s.skipped}`);
  }
  console.log(JSON.stringify({ phase, mode, steps: done.map((d) => ({ id: d.id, ok: d.ok, skipped: d.skipped ?? null })) }));
  return 0;
}

if (process.argv[1]?.endsWith("deploy.js")) main(process.argv.slice(2)).then((c) => process.exit(c));
