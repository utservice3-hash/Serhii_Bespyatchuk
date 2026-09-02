import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 🪝 #261–#261d — ХУКИ ПРОЄКТУ Є, ПІДХОПЛЮЮТЬСЯ З РЕПОЗИТОРІЮ Й КАЖУТЬ ПРАВДУ.
 *
 * 🔴 ЧОМУ ЦЕ ВЗАГАЛІ ПОТРІБНО СТЕРЕГТИ. Хук — єдиний механізм у проєкті, який працює
 * ПОЗА нашим кодом: його виконує харнес, а не ми. Отже жоден наявний гейт про нього
 * нічого не знає, і зникнення файла хука чи одруківка в дорозі до нього не червоніє
 * НІДЕ. Мовчазна відмова хука не відрізняється від «саботажів не було».
 *
 * 🔴 ГЕЙТИ СТОЯТЬ НА ВИВОДІ. `#261` читає ТЕКСТ `.claude/settings.json`, `#261b` —
 * рядок відмови, який побачить людина, `#261c` — імʼя файла, який інструмент СПРАВДІ
 * створює. Твердження через проксі (є слово у джерелі) падало б від рефакторингу
 * й мовчало б від дефекту.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HOOKS_DIR = `${ROOT}.claude/hooks`;
const hook1 = () => import(`${HOOKS_DIR}/no-commit-with-sabotage.mjs`);
const hook2 = () => import(`${HOOKS_DIR}/save-handoff.mjs`);
const hook3 = () => import(`${HOOKS_DIR}/no-abs-symlink.mjs`);

test("#261 обидва хуки оголошені в .claude/settings.json і показують на наявні файли — у ОБИДВА боки", () => {
  const p = `${ROOT}.claude/settings.json`;
  assert.ok(existsSync(p), "🔴 .claude/settings.json немає — жоден хук не підхопиться, і про це ніхто не дізнається");
  const raw = readFileSync(p, "utf8");
  const cfg = JSON.parse(raw);

  for (const ev of ["PreToolUse", "PreCompact"])
    assert.ok(Array.isArray(cfg.hooks?.[ev]) && cfg.hooks[ev].length > 0,
      `🔴 у settings.json немає жодного хука на подію ${ev}`);

  // Шляхи беремо з ТЕКСТУ команд — саме він виконується, а не наші уявлення про нього.
  const cmds: string[] = Object.values(cfg.hooks as Record<string, any[]>)
    .flat().flatMap((m: any) => (m.hooks ?? []).map((h: any) => String(h.command ?? "")));
  const named = [...new Set(cmds.flatMap((c) => c.match(/[A-Za-z0-9._-]+\.mjs/g) ?? []))].sort();

  // Порожній скоуп = ПРОВАЛ: без цього рівність множин зійшлася б на «нуль == нуль».
  assert.ok(named.length >= 2, `🔴 у командах хуків названо лише ${named.length} скриптів — перевіряти було нічого`);

  for (const c of cmds)
    assert.ok(c.includes("$CLAUDE_PROJECT_DIR"),
      `🔴 команда хука «${c}» не йде через $CLAUDE_PROJECT_DIR — шлях залежав би від cwd, а контейнер ефемерний`);

  const onDisk = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".mjs")).sort();
  const missing = onDisk.filter((f) => !named.includes(f));
  const dangling = named.filter((f) => !onDisk.includes(f));
  assert.deepEqual(dangling, [], `🔴 settings.json кличе скрипти, яких немає: ${dangling.join(", ")}`);
  assert.deepEqual(missing, [], `🔴 скрипти є, а в settings.json не оголошені: ${missing.join(", ")} — лежать мертвим вантажем`);
});

test("#261b відмова коміту називає КОЖЕН активний саботаж і як його зняти — і мовчить, коли дерево чисте", async () => {
  const { decideCommit, isCommit, SABOTAGE_SUFFIX } = await hook1();
  const markers = [`backend/src/core/money.ts${SABOTAGE_SUFFIX}`, `backend/src/routes/tasks.ts${SABOTAGE_SUFFIX}`];

  const blocked = decideCommit("git commit -m 'щось'", markers);
  assert.equal(blocked.block, true, "🔴 коміт при живому саботажі мусить блокуватись");
  // 🔴 УРОК S1 (31.08.2026): твердження і текст ідуть з ОДНОГО набору. Гейт #260 у першій
  // редакції звіряв відфільтрований список, а називав повний — і звинуватив невинний файл.
  for (const m of markers)
    assert.ok(blocked.reason.includes(m.replace(SABOTAGE_SUFFIX, "")),
      `🔴 відмова не назвала ${m} — людина не дізнається, ЩО саме відновлювати`);
  assert.ok(blocked.reason.includes("--restore"), "🔴 відмова не каже, ЯК відновити — заборона без виходу коштує як сама аварія");
  assert.ok(!blocked.reason.includes("core/dayItems.ts"),
    "🔴 у відмові зʼявився файл, якого немає в наборі — рівно те звинувачення невинного, що спіймав S1");

  // Дзеркало по ОБИДВА боки межі, інакше доведено було б лише «функція щось повертає».
  assert.equal(decideCommit("git commit -m x", []).block, false, "🔴 чисте дерево коміт не блокує");
  assert.equal(decideCommit("git status", markers).block, false, "🔴 не-коміт блокувати не можна");
  assert.equal(isCommit("git -c core.pager=cat commit -m x"), true, "🔴 форма `git -c … commit` пройшла б повз хук");
  assert.equal(isCommit("echo 'git commit' > f"), false, "🔴 згадка в тексті — не коміт");
});

test("#261c мітка, яку хук шукає, — та сама, яку інструмент СПРАВДІ створює", async () => {
  const { SABOTAGE_SUFFIX } = await hook1();
  const { applySabotage } = await import("./sabotage.js");
  const dir = mkdtempSync(join(tmpdir(), "sab-"));
  try {
    const f = join(dir, "ціль.ts");
    writeFileSync(f, "const a = ПЕРШЕ;\n");
    const r = applySabotage(f, "ПЕРШЕ", "ДРУГЕ", 1);
    assert.equal(r.ok, true, "🔴 саботаж не застосувався — доводити нічого");
    // Порівнюємо з ФАКТОМ на диску, а не зі згадкою суфікса в джерелі інструмента:
    // твердження через проксі падає від рефакторингу й мовчить від дефекту.
    assert.ok(existsSync(`${f}${SABOTAGE_SUFFIX}`),
      `🔴 інструмент створив копію під ІНШИМ імʼям, ніж шукає хук (${SABOTAGE_SUFFIX}) — хук пропускав би саботаж мовчки`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#261d передача перед стисненням несе стан, живий саботаж і репліки ДОСЛІВНО", async () => {
  const { buildHandoff, userTurns } = await hook2();
  const g = { branch: "main", head: "abc1234", subject: "тема", ahead: "2", dirty: "", log: "abc1234 тема" };
  const слово = "сер.чек ділиться на УГОДИ, а не на авто";

  const withSab = buildHandoff("2026-09-01T00:00:00Z", "auto", [слово], g, ["backend/src/core/money.ts.sabotage-backup"]);
  assert.ok(withSab.includes(слово), "🔴 вказівку власника переказано, а не збережено дослівно — саме так рішення й губились");
  assert.ok(withSab.includes("main") && withSab.includes("abc1234"), "🔴 у передачі немає стану гілки — читач не знає, де він");
  assert.ok(/ЖИВИЙ САБОТАЖ/.test(withSab) && withSab.includes("core/money.ts"),
    "🔴 живий саботаж не названо — після компакту його не помітить ніхто");

  const clean = buildHandoff("2026-09-01T00:00:00Z", "manual", [слово], g, []);
  assert.ok(!/ЖИВИЙ САБОТАЖ/.test(clean) && clean.includes("саботажів у дереві немає"),
    "🔴 на чистому дереві передача мусить це стверджувати, а не мовчати: мовчання читається як «не перевіряли»");

  assert.deepEqual(userTurns('{"type":"user","message":{"content":"жива репліка"}}\nсміття\n{"type":"assistant"}'),
    ["жива репліка"], "🔴 розбір транскрипту бере не те або кидає на сміттєвому рядку");
  assert.deepEqual(userTurns('{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}'),
    [], "🔴 у передачу потрапили tool_result — вони витіснили б справжні вказівки");

  // 🔴 НАЙСВІЖІША РЕПЛІКА ЦІЛА, СТАРА ОБРІЗАНА — приклад по ОБИДВА боки межі.
  // Перша редакція різала всі однаково й на живому транскрипті зрізала критерій
  // приймання поточного завдання: файл читався охайно і був непридатний.
  const стара = "С".repeat(3000), свіжа = "Ж".repeat(3000);
  const two = buildHandoff("2026-09-01T00:00:00Z", "auto", [стара, свіжа], g, []);
  assert.ok(two.includes(свіжа),
    "🔴 останню вказівку обрізано — саме в ній критерій приймання, і читач продовжити не зміг би");
  assert.ok(!two.includes(стара) && two.includes("[…обрізано…]"),
    "🔴 старі репліки не обрізаються — передача розпухне й витіснить те, заради чого пишеться");
});

/**
 * 🪝 #261e–#261f — СИМЛІНК З АБСОЛЮТНОЮ ЦІЛЛЮ НЕ ЙДЕ В КОМІТ.
 *
 * 🔴 ПРИВІД ЗАМІРЯНИЙ: у `77e0d72` поїхав `backend/node_modules` — blob режиму 120000 на
 * `/home/user/…`, шлях контейнера. У прод-чекауті його немає, тобто дерево з таким
 * записом не збирається. `.gitignore` не спинив: `node_modules/` із косою матчить лише
 * КАТАЛОГ, а симлінк — не каталог (доведено обома боками в порожньому репозиторії).
 *
 * 🔴 ДВА ГЕЙТИ, А НЕ ОДИН, І ПОДІЛ НЕ КОСМЕТИЧНИЙ. `#261e` перевіряє РІШЕННЯ (чиста
 * функція, без файлової системи). `#261f` перевіряє ЗБІР — що хук справді бачить симлінк
 * у справжньому git-дереві. Без другого перше доводило б лише, що функція вміє судити
 * про масив, який їй хтось подав; саме там і живе відмова «нічого не знайшов».
 */
test("#261e відмова називає КОЖЕН абсолютний симлінк і як його зняти — а на відносному мовчить", async () => {
  const { decideLinks, isAddOrCommit, outsideRepo } = await hook3();
  const links = [
    { path: "backend/node_modules", target: "/home/user/Serhii_Bespyatchuk/backend/node_modules", staged: true },
    { path: "frontend/assets", target: "/opt/assets", staged: false },
  ];

  const blocked = decideLinks("git commit -m 'щось'", links, "/tmp/w");
  assert.equal(blocked.block, true, "🔴 коміт з абсолютним симлінком мусить блокуватись");
  for (const l of links)
    assert.ok(blocked.reason.includes(l.path) && blocked.reason.includes(l.target),
      `🔴 відмова не назвала ${l.path} → людина не дізнається, ЩО саме прибирати`);
  assert.ok(blocked.reason.includes("git rm --cached"),
    "🔴 відмова не каже, ЯК прибрати — заборона без виходу коштує як сама аварія");
  assert.ok(!blocked.reason.includes("docs/HANDOFF.md"),
    "🔴 у відмові зʼявився файл, якого немає в наборі — те саме звинувачення невинного, що спіймав S1");

  // 🔴 ДЗЕРКАЛО ПО ОБИДВА БОКИ МЕЖІ. Односторонній предикат зеленів би й тоді, коли
  // блокує ВСЕ: відносний симлінк переносний, і забороняти його не можна.
  assert.equal(decideLinks("git add -A", [{ path: "a", target: "../b", staged: false }], "/tmp/w").block, false,
    "🔴 відносний симлінк заблоковано — правило накрило те, що переносне за побудовою");
  assert.equal(decideLinks("git status", links, "/tmp/w").block, false, "🔴 не-add/commit блокувати не можна");
  assert.equal(decideLinks("git commit -m x", [], "/tmp/w").block, false, "🔴 чисте дерево коміт не блокує");
  assert.equal(isAddOrCommit("git -c core.pager=cat add ."), true, "🔴 форма `git -c … add` пройшла б повз хук");
  assert.equal(isAddOrCommit("echo 'git add' > f"), false, "🔴 згадка в тексті — не команда");

  // Обидва боки межі «назовні / всередині»: без другого це доводило б лише, що функція щось віддає.
  assert.equal(outsideRepo("/tmp/w", "/home/user/x"), true, "🔴 ціль поза деревом не розпізнано");
  assert.equal(outsideRepo("/tmp/w", "/tmp/w/backend/x"), false, "🔴 ціль усередині дерева названо зовнішньою");
});

test("#261f 🪞 ЗБІР ПРАЦЮЄ НА СПРАВЖНЬОМУ РЕПОЗИТОРІЇ — і розрізняє абсолютний та відносний", async () => {
  const { collectLinks, decideLinks } = await hook3();
  const dir = mkdtempSync(join(tmpdir(), "lnk-"));
  try {
    const sh = (...a: string[]) =>
      execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    sh("init", "-q", "."); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
    writeFileSync(join(dir, "real.txt"), "x");
    // 🔴 ЦІЛЬ АБСОЛЮТНА, АЛЕ ВСЕРЕДИНІ ТИМЧАСОВОГО ДЕРЕВА — і це не спрощення, а урок.
    // Перша редакція вказувала на `/etc/hosts`; у контейнері зелено, а на прод-сервері
    // `EACCES: symlink '/etc/hosts'` — там заборонено створювати симлінки НАЗОВНІ
    // домашнього каталогу (заміряно 02.09.2026: у /tmp і /home/evraziat — можна, на /etc —
    // ні). Гейт червонів через оточення, а не через предмет; спіймав це крок `test` у
    // deploy:check, тобто до прода.
    // Побічно фікстура стала ТОЧНІШОЮ: абсолютний шлях, що лежить ПІД коренем дерева, —
    // рівно той випадок, який пропускала вужча редакція предиката («абсолютний і назовні»).
    symlinkSync(join(dir, "real.txt"), join(dir, "abs-link")); // абсолютний — має блокувати
    symlinkSync("real.txt", join(dir, "rel-link"));            // відносний — має пройти
    sh("add", "-A");

    const links = collectLinks(dir);
    // 🔴 ПОРОЖНІЙ ЗБІР = ПРОВАЛ. Без цього «нуль порушень» не відрізнити від «нуль знайдених».
    assert.equal(links.length, 2,
      `🔴 збір знайшов ${links.length} симлінк(ів) замість 2 — розбір ls-files зламався, і хук мовчав би завжди`);
    const abs = links.find((l: { path: string }) => l.path === "abs-link");
    assert.equal(abs?.target, join(dir, "real.txt"), "🔴 ціль абсолютного симлінка прочитано неправильно");
    assert.equal(isAbsolute(abs?.target ?? ""), true, "🔴 фікстура перестала бути абсолютною — гейт перевіряв би не те");
    assert.equal(abs?.staged, true, "🔴 симлінк в індексі не позначено як staged");
    assert.equal(links.find((l: { path: string }) => l.path === "rel-link")?.target, "real.txt",
      "🔴 ціль відносного симлінка прочитано неправильно");

    assert.equal(decideLinks("git commit -m x", links, dir).block, true,
      "🔴 на справжньому дереві з абсолютним симлінком хук мусить блокувати");
    assert.equal(decideLinks("git commit -m x", links.filter((l: { path: string }) => l.path === "rel-link"), dir).block, false,
      "🔴 дерево лише з відносним симлінком блокувати не можна");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
