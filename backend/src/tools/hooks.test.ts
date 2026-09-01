import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
