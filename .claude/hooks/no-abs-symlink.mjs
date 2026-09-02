#!/usr/bin/env node
/**
 * 🔒 PreToolUse — СИМЛІНК З АБСОЛЮТНИМ ШЛЯХОМ НЕ ПОТРАПЛЯЄ В ІНДЕКС.
 *
 * 🔴 ПІДСТАВА ЗАМІРЯНА, НЕ ВИГАДАНА. У коміт `77e0d72` поїхав `backend/node_modules` —
 * blob режиму 120000 із ціллю `/home/user/Serhii_Bespyatchuk/backend/node_modules`, тобто
 * абсолютний шлях КОНТЕЙНЕРА, у якому працював чат. На прод-сервері (`/home/evraziat/…`)
 * і в будь-якому іншому клоні такого шляху немає — збірка з такого дерева ламається.
 * Спіймало це не правило й не гейт, а те, що координатор попросив розділити коміт.
 *
 * 🔴 ЧОМУ .gitignore ЦЬОГО НЕ ЛОВИВ: там стояло `node_modules/` із косою, а коса матчить
 * лише КАТАЛОГ. Правило було правдою для каталогів і мовчки перестало нею бути, щойно
 * зʼявився симлінк. Косу прибрано (коміт `3dd500f`) — але то лікування ОДНОГО імені.
 * Цей хук — предикат на весь КЛАС: будь-яке імʼя, будь-який каталог.
 *
 * 🔴 ПРЕДИКАТ ШИРШИЙ ЗА ПЕРВІСНЕ ФОРМУЛЮВАННЯ, І ЦЕ НАВМИСНО. Замовлено було
 * «абсолютний шлях НАЗОВНІ репозиторію». Заміряно, що така редакція пропустила б рівно
 * той випадок, заради якого хук пишеться: корінь того чекауту — `/home/user/Serhii_Bespyatchuk`,
 * тобто ціль лежала б ВСЕРЕДИНІ репозиторію, і відмови не було б. Абсолютний шлях
 * непереносний СAM ПО СОБІ, хоч усередину, хоч назовні, — тож блокуємо будь-який, а
 * «всередині/назовні» лишається в тексті відмови як довідка.
 *
 * 🔴 ЩО НЕ БЛОКУЄМО: відносні симлінки. Вони переносні за побудовою й у репозиторіях
 * трапляються законно. Односторонній предикат зеленів би й тоді, коли зламаний повністю.
 *
 * 🔴 ЧОМУ КОРІНЬ БЕРЕТЬСЯ З `cwd` ВИКЛИКУ, А НЕ З `$CLAUDE_PROJECT_DIR`: коміти
 * робляться у ВЛАСНИХ worktree (`/tmp/w-…`), а `CLAUDE_PROJECT_DIR` показує на основний
 * чекаут. Хук, що дивиться не в те дерево, — це мовчазний дозвіл.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const git = (cwd, args) => {
  try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }   // не репозиторій / немає git — не наша справа блокувати
};

/**
 * Чи є команда `git add` або `git commit`. Між `git` і підкомандою дозволені лише
 * прапорці та їхні значення у формі `ключ=значення` — та сама форма, що в
 * `no-commit-with-sabotage.mjs` (там її додали після того, як `git -c ключ=значення commit`
 * пройшов повз хук, `#261b`).
 */
export function isAddOrCommit(command) {
  return /(^|[;&|]\s*)git(\s+(-[^\s]+|[A-Za-z0-9._-]+=[^\s]*))*\s+(add|commit)\b/.test(String(command ?? ""));
}

/** Симлінк веде «назовні», якщо шлях від кореня репозиторію починається з `..`. */
export function outsideRepo(root, target) {
  const rel = relative(root, isAbsolute(target) ? target : join(root, target));
  return rel === ".." || rel.startsWith(`..${"/"}`);
}

/**
 * Симлінки, які потраплять у коміт: вже в ІНДЕКСІ (режим 120000) плюс ті, що лежать у
 * дереві незаігнорованими — саме їх забере `git add -A`.
 * @returns {{path:string, target:string, staged:boolean}[]}
 */
export function collectLinks(root) {
  const out = new Map();
  for (const line of (git(root, ["ls-files", "-s"]) ?? "").split("\n")) {
    const m = /^120000 ([0-9a-f]{40}) \d+\t(.+)$/.exec(line);
    if (!m) continue;
    out.set(m[2], { path: m[2], target: (git(root, ["cat-file", "-p", m[1]]) ?? "").trim(), staged: true });
  }
  for (const line of (git(root, ["status", "--porcelain"]) ?? "").split("\n")) {
    const p = line.slice(3).trim().replace(/^"|"$/g, "");
    if (!p || out.has(p)) continue;
    try {
      if (!lstatSync(join(root, p)).isSymbolicLink()) continue;
      out.set(p, { path: p, target: readlinkSync(join(root, p)), staged: false });
    } catch { /* зник між викликами — не наша справа */ }
  }
  return [...out.values()];
}

/**
 * ЄДИНЕ РІШЕННЯ — і вирок, і текст із того самого `bad`.
 * Урок S1 (31.08.2026): відфільтрований список для твердження й повний для тексту
 * означає відмову, яка звинувачує невинний файл.
 * @returns {{block:boolean, reason:string}}
 */
export function decideLinks(command, links, root = "/") {
  if (!isAddOrCommit(command)) return { block: false, reason: "" };
  const bad = links.filter((l) => isAbsolute(l.target));
  if (bad.length === 0) return { block: false, reason: "" };
  const list = bad.map((l) =>
    `   • ${l.path} → ${l.target}   [${l.staged ? "уже в індексі" : "у дереві, забере git add"}]`
    + `${outsideRepo(root, l.target) ? "  (назовні репозиторію)" : "  (всередині цього дерева, але шлях однаково машинний)"}`
  ).join("\n");
  return { block: true, reason:
`🔴 ЗАБЛОКОВАНО: ${bad.length} симлінк(ів) з АБСОЛЮТНОЮ ціллю поїхали б у коміт.

${list}

Абсолютний шлях указує на це конкретне середовище. У прод-чекауті (/home/evraziat/…)
і в будь-якому іншому клоні його немає — там симлінк веде в нікуди, і збірка падає.
Саме так у 77e0d72 поїхав backend/node_modules; .gitignore не спинив, бо «node_modules/»
із косою матчить лише каталог, а симлінк — не каталог.

ЩО ЗРОБИТИ:
   git rm --cached <шлях>            ← прибрати з індексу, файл у дереві лишиться
   і додати шлях у .gitignore (БЕЗ косої в кінці) або в .git/info/exclude

Симлінк потрібен у коміті свідомо? Зроби його ВІДНОСНИМ — такий переносний, і хук
його не чіпає.` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { /* не наша справа розбирати чужий шум */ }
  if (input.tool_name !== "Bash") process.exit(0);
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = (git(cwd, ["rev-parse", "--show-toplevel"]) ?? "").trim();
  if (!root) process.exit(0);           // не репозиторій — блокувати нема чого
  const v = decideLinks(input.tool_input?.command, collectLinks(root), root);
  if (!v.block) process.exit(0);
  console.error(v.reason);
  process.exit(2);                      // 2 = блокувати виклик і показати stderr Клоду
}
