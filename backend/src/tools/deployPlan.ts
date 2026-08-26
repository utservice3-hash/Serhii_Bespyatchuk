/**
 * 🚀 РЕЄСТР КРОКІВ ВИКАТУ — щоб ритуал тримався не памʼяттю, а механізмом.
 *
 * 🔴 ЗАМИСЕЛ: скрипт ЗАПИСУЄ ритуал, а не спрощує його. Жоден крок не прибрано; якщо
 * після скрипта якась перевірка стала «необовʼязковою» — ми не автоматизували деплой,
 * а розібрали запобіжник.
 *
 * 📐 ПРИВІД, ЗАМІРЯНИЙ НА СОБІ (25.08.2026). Один виконавець, одна доба, ЧОТИРИ викати
 * — і шість кроків зроблено по-різному:
 *   · поіменний перерахунок через worktree — двічі зроблено, двічі «по памʼяті»,
 *     і це при базі, що змінювалась ВІСІМ разів за добу;
 *   · `npx tsc -b` фронту — **жодного разу з чотирьох** (обійшлось лише тим, що фронт
 *     не чіпали; пастка «tsc --noEmit там не перевіряє нічого» була ВІДОМА й записана);
 *   · перевірка `dist/assets` перед копією — лише раз, і то після падіння;
 *   · звірка `app_boot = deploy` — лише раз із чотирьох.
 * Це не недбалість. Це те, що тринадцять кроків не тримаються головою.
 *
 * 🔒 ДВІ ФАЗИ, І ЦЕ НЕ ДВА РИТУАЛИ. `check` біжить у контейнері, `run` — на проді,
 * бо на прод-сервері НЕМАЄ бінарів PostgreSQL: `npm test` там фізично слабший
 * (scratch-гейти `#220`-`#220c`, `#8`, `#21`… чесно скіпаються). Винести крок `test`
 * на прод означало б тихо ослабити його. Склеює фази запобіжник `verifyArtifact`.
 */

export type Phase = "check" | "run";
export interface Step {
  id: string;
  phase: Phase;
  title: string;
  /** Чому крок існує — щоб той, хто збереться його прибрати, спершу прочитав ціну. */
  why: string;
  /** Крок виконується лише в повному режимі. */
  fullOnly?: boolean;
  /** Крок виконується лише в легкому (умова допуску косметичного викату). */
  lightOnly?: boolean;
}

/**
 * ⚠️ ПОРЯДОК ТУТ — ЧАСТИНА БЕЗПЕКИ, а не оформлення. `markDeploy` ПІСЛЯ `kill`
 * виглядає нешкідливо й ламає доказ: намір нікому забирати, він провисить і згорить,
 * а старт класифікується як `crash` — банер «АВАРІЯ» кричить користувачам на кожному
 * викаті. Стереже `#226b`.
 */
export const REQUIRED_STEPS: readonly Step[] = [
  // ── ФАЗА CHECK (контейнер) ────────────────────────────────────────────────
  { id: "base", phase: "check", title: "база проти health.version",
    why: "проти ЖИВОГО прода, а не проти памʼяті чи HEAD~1: інакше викат тихо відкотить чужий прохід" },
  { id: "lightAdmission", phase: "check", lightOnly: true, title: "умова допуску легкого режиму",
    why: "діф не має виходити за frontend/; одне порушення — режим ПОВНИЙ, і це перевіряється, а не декларується" },
  { id: "buildBack", phase: "check", title: "rm -rf dist && npm run build (бекенд)",
    why: "інкрементальний tsc після revert/rename несе сміття — привиди падінь і фальшиве зелене на саботажі" },
  { id: "tscFront", phase: "check", title: "npx tsc -b (фронт)",
    why: "`tsc --noEmit` на фронті не бере В РОБОТУ ЖОДНОГО файлу і завжди дає 0; за 4 викати цей крок не зробили жодного разу" },
  { id: "test", phase: "check", title: "npm test — нових падінь нуль",
    why: "єдине місце, де виконуються scratch-гейти: на прод-сервері немає бінарів PostgreSQL" },
  { id: "recount", phase: "check", title: "поіменний перерахунок проти worktree на sha з health",
    why: "«+N pass» приховує обмін статусами; і база змінюється — памʼять про вчорашнє число бреше" },
  { id: "artifact", phase: "check", title: "записати артефакт (sha гілки + sha прода)",
    why: "склейка двох фаз: run без нього не стартує" },
  // ── ФАЗА RUN (прод) ───────────────────────────────────────────────────────
  { id: "artifactFresh", phase: "run", title: "артефакт свіжий за ОБОМА sha",
    why: "перевірка тригодинної давності могла звірятись із продом, що відтоді зрушив вісім разів" },
  { id: "ff", phase: "run", title: "git fetch + merge --ff-only",
    why: "лише перемотка: мердж або ребейз на проді ховає, що саме там крутиться" },
  { id: "buildBackProd", phase: "run", title: "rm -rf dist && npm run build (бекенд)",
    why: "version.json пишеться на білді; без нього health покаже старий sha" },
  { id: "buildFront", phase: "run", title: "npm run build (фронт)",
    why: "vite пише лише у frontend/dist; без збірки докрут лишиться старим" },
  { id: "distNotEmpty", phase: "run", title: "frontend/dist/assets НЕ порожній",
    why: "інакше cp тихо не скопіює нічого, index.html лишиться старим при новому бекенді — розходження бандла й сервера" },
  { id: "copy", phase: "run", title: "копія у докрут (асети → статика → index.html останнім)",
    why: "index.html кладеться ОСТАННІМ, щоб він ніколи не показував на відсутній асет" },
  { id: "cssGuard", phase: "run", title: "CSS-guard за ІМЕНАМИ з нового index.html",
    why: "НЕ «old != new»: vite хешує за вмістом, css часто той самий — 05.08.2026 прод 4 хвилини стояв без стилів саме тут" },
  { id: "contentType", phase: "run", title: "content-type асетів, не код відповіді",
    why: "зниклий асет уміє віддати 200 з HTML — код відповіді про це мовчить" },
  { id: "migrate", phase: "run", title: "npm run migrate, якщо є міграції",
    why: "npm start міграцій НЕ запускає; «Migration applied» друкується й тоді, коли частина роботи відкотилась" },
  { id: "markDeploy", phase: "run", title: "markDeploy ПЕРЕД kill",
    why: "після kill намір забирати нікому; без нього старт класифікується як crash і банер кричить користувачам" },
  { id: "kill", phase: "run", title: "pid і kill -TERM ОДНІЄЮ командою",
    why: "між двома викликами pid протухає; pgrep -f матчить власний командний рядок і «знаходить» себе" },
  { id: "healthVersion", phase: "run", title: "health.version == задеплоєний sha",
    why: "ЄДИНИЙ достовірний доказ рестарту: кнопки й pid брешуть, health із самим ok:true колись 11 годин підтверджував старий код" },
  { id: "bootKind", phase: "run", title: "app_boot класифіковано як deploy, не crash",
    why: "фальшивий crash — це і хибний банер, і зіпсована статистика аварій" },
  { id: "pushBranch", phase: "run", title: "пуш sha у прод-гілку (fetch ПЕРЕД заміром)",
    why: "поки гілка відстає, «повернути як було» повертає не те, що працювало; ahead/behind без fetch бреше" },
  { id: "report", phase: "run", title: "машиночитний звіт, включно з НЕвиконаними кроками",
    why: "«міграцій немає» ≠ «міграції пройшли»: крок, що завжди зелений, за тиждень вважають перевіреним" },
];

export type Mode = "full" | "light";

/** Кроки фази в порядку виконання для заданого режиму. */
export function planSteps(phase: Phase, mode: Mode): Step[] {
  return REQUIRED_STEPS.filter((s) => s.phase === phase)
    .filter((s) => (mode === "light" ? !s.fullOnly : !s.lightOnly));
}

/** Чого легкий режим НЕ робить — друкується вголос, а не мається на увазі. */
export const LIGHT_OMITS: readonly string[] = [
  "прогрів ~13 хв після рестарту",
  "повний test:prod (гейти, що читають ДЖЕРЕЛО фронта, і так у npm test)",
];

export interface Artifact { branchSha: string; prodSha: string; mode: Mode; at: string }

/**
 * 🔴 СВІЖІСТЬ АРТЕФАКТА — ЗА ОБОМА sha, І ЦЕ НЕ ПРИДИРКА. «Той самий sha гілки»
 * недостатньо: перевірка, знята три години тому, могла звіряти базу проти прода,
 * який відтоді зрушив ВІСІМ разів (заміряно 25.08.2026 — саме стільки й було).
 * Записане число старіє разом із тим, що воно описувало.
 */
export function verifyArtifact(
  a: Artifact | null, liveBranchSha: string, liveProdSha: string,
): { ok: true } | { ok: false; reason: string } {
  if (!a) return { ok: false, reason: "артефакта немає — спершу `npm run deploy:check`" };
  if (a.branchSha !== liveBranchSha)
    return { ok: false, reason: `протух БІК ГІЛКИ: перевіряли ${a.branchSha}, зараз ${liveBranchSha} — перевір заново` };
  if (a.prodSha !== liveProdSha)
    return { ok: false, reason: `протух БІК ПРОДА: перевіряли проти ${a.prodSha}, зараз ${liveProdSha} — базу треба звірити заново` };
  return { ok: true };
}

/**
 * 🔴 ОБІРВАНИЙ ПРОГІН МУСИТЬ НАЗВАТИ СТАН ПРОДА СЛОВАМИ.
 *
 * Ручний ритуал має властивість, якої скрипт легко позбувається: людина бачить, де
 * саме зупинилась. Скрипт, що впав на кроці 9 із 15, лишає прод у стані, якого ніхто
 * не назве вголос — а **не сказане вголос читається як благополуччя** (той самий клас,
 * що «успіх за 0 мс» і «папка бекапу є, копії немає»).
 *
 * Стан ВИВОДИТЬСЯ з переліку виконаних кроків, а не вгадується: `copy` вже пройшов —
 * докрут несе новий бандл; `healthVersion` пройшов — сервер уже новий; `pushBranch` ні
 * — гілка ще не знає про те, що крутиться.
 */
export type AbortState = "prod-untouched" | "docroot-ahead" | "server-ahead";

export interface AbortReport { state: AbortState; exitCode: number; lines: string[] }

export function abortState(
  failedStep: string, doneOk: readonly string[],
  ctx: { prodSha: string; targetSha: string; branch: string; intentMinutes?: number },
): AbortReport {
  const did = (id: string) => doneOk.includes(id);
  const intent = did("markDeploy")
    ? [`Намір markDeploy виставлено — спливе через ~${ctx.intentMinutes ?? 15} хв і сам себе скасує.`]
    : [];

  if (did("healthVersion")) {
    return { state: "server-ahead", exitCode: 13, lines: [
      `Зупинено на «${failedStep}». СЕРВЕР УЖЕ КРУТИТЬ НОВИЙ КОД (${ctx.targetSha}), докрут теж новий.`,
      `Розходження лише в тому, що ГІЛКА ${ctx.branch} про це не знає — а поки вона відстає,`,
      "«повернути як було» повернуло б НЕ те, що працює.",
      ...intent,
      `Щоб завершити: git push origin HEAD:${ctx.branch} && git fetch origin -q && git rev-list --left-right --count origin/${ctx.branch}...HEAD`,
      "Відкочувати НЕ треба: прод справний, бракує лише запису.",
    ] };
  }
  if (did("copy")) {
    return { state: "docroot-ahead", exitCode: 12, lines: [
      `Зупинено на «${failedStep}». Прод крутить СТАРИЙ код (${ctx.prodSha}), але докрут уже несе НОВИЙ бандл.`,
      "Сторінка й сервер розійшлись: банер «АВАРІЯ» спрацює, і спрацює ПРАВИЛЬНО.",
      ...intent,
      "Щоб завершити: npm run deploy:run -- --mode=<той самий> (кроки ідемпотентні, пройде з місця обриву).",
      "Щоб відкотити: git merge --ff-only <старий sha> у прод-чекауті, перезібрати фронт і повторити копію з CSS-guard.",
    ] };
  }
  return { state: "prod-untouched", exitCode: 11, lines: [
    `Зупинено на «${failedStep}». ПРОД НЕ ЗМІНЕНО: ні докрут, ні сервер не чіпали.`,
    ...intent,
    "Нічого відкочувати не треба. Полагодь причину й запусти deploy:run заново.",
  ] };
}
