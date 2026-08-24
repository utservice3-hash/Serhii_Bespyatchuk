import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BROKEN_ENV_MARK } from "../testRunGate.js";

/**
 * 🧪 ТИМЧАСОВА БАЗА ДЛЯ ТЕСТУ «СХЕМА З НУЛЯ» — набір піднімає її САМ.
 *
 * 🔴 НАВІЩО. Тест #8 вимагав ручного `TEST_SCRATCH_DB_URL`, якого ніхто ніколи не
 * ставив, — тож він пропускався ЗАВЖДИ. Через це в `schema.sql` невідомо скільки
 * жив `GRANT` на таблицю, що створюється НИЖЧЕ: на живій базі проходило, на порожній
 * міграція падала. Знайшли випадково, вручну піднявши кластер.
 *
 * Урок ширший за один тест: **скіп, який ніколи не виконувався, — не страховка, а
 * ілюзія**. Він виглядає як перевірка, займає рядок у наборі й не перевіряє нічого.
 * Тому провізію переносимо в код: `npm test` у дев-оточенні реально накочує схему на
 * порожню базу щоразу, без жодних ручних змінних.
 *
 * ⚠️ МЕЖА ЧЕСНОСТІ. Автопідйом можливий лише там, де є бінарі PostgreSQL. На
 * ПРОД-сервері їх немає взагалі (БД — Neon), тож там тест чесно пропуститься з
 * причиною, яка називає ПРИЧИНУ, а не «щось не так». Створювати службову базу на
 * бойовому Neon заради тесту — свідомо НЕ робимо: це запис у бойовий проєкт і трата
 * compute-квоти, тобто рівно те, від чого ми щойно городили read-only роль.
 *
 * 🔒 НІКОЛИ не використовує `DATABASE_URL`. База створюється лише у власному
 * тимчасовому кластері, який ми ж і зносимо.
 */

/**
 * 🧹 Б1 — ПРИБИРАННЯ ЗА СОБОЮ НА АВАРІЙНОМУ ВИХОДІ (24.08.2026).
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ, А НЕ ПРИПУЩЕНИЙ. `dispose()` стоїть у `finally`/`after()` в
 * усіх 13 файлах, і штатний прогін ЧЕСНО прибирає (перевірено: один файл → Δ0
 * каталогів). Але обробників виходу не було ЖОДНОГО, а підмітання сиріт — і поготів.
 * Відтворено дією: `SIGTERM` раннеру лишає рівно один каталог на **67 МБ**, причому
 * postmaster гине разом із процесом — тобто лишається каталог БЕЗ ГОСПОДАРЯ, який не
 * прибере вже ніхто. За добу накопичилось **463 каталоги від 89 різних PID ≈ 30 ГБ**,
 * диск дійшов до 100%, і БД-тести почали відсіюватись.
 *
 * ⚠️ ЧЕСНА МЕЖА, ЯКУ ТРЕБА СКАЗАТИ ВГОЛОС: `SIGKILL` і падіння ядра не
 * перехоплюються В ПРИНЦИПІ. Обробники закривають лише те, що можна закрити;
 * решту закриває ПІДМІТАННЯ на наступному старті. Удавати повне покриття — це
 * рівно та «сигналізація, про несправність якої не сигналізують».
 */

/** Живі `dispose` цього процесу — щоб обробник виходу закрив УСІ, а не останній. */
const LIVE = new Set<() => void>();
let armed = false;

/**
 * 🔴 `exit` — СИНХРОННИЙ, і саме тому `dispose` мусить лишатись синхронним
 * (`spawnSync`/`rmSync`). Асинхронне прибирання тут не виконалось би взагалі: подія
 * `exit` не чекає проміс. Це не стиль, це умова працездатності.
 */
function armExitHandlers(): void {
  if (armed) return;
  armed = true;
  const flush = () => { for (const d of [...LIVE]) { try { d(); } catch { /* прибирання не має права кидати */ } } };
  process.once("exit", flush);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      flush();
      // Знімаємо себе й повторюємо сигнал: інакше ми проковтнули б його й змінили
      // код виходу процесу — тобто зламали б те, за чим runner розрізняє «вбито».
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
  process.once("uncaughtException", (e) => { flush(); throw e; });
}

/**
 * Зносить каталоги `uts-scratch-<pid>-*`, чий PID більше не живий.
 *
 * 🔴 ЛИШЕ МЕРТВІ. Паралельні прогони — норма (`node --test` запускає файл на процес),
 * і знести чужий живий кластер означало б зламати сусідній тест так, що він
 * поскаржиться на БД, а не на нас. Перевірка живості — `kill(pid, 0)`.
 */
export function sweepOrphans(root = tmpdir()): { removed: number; kept: number } {
  let removed = 0, kept = 0;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return { removed: 0, kept: 0 }; }
  for (const name of entries) {
    const m = /^uts-scratch-(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) {
      // EPERM = процес є, але чужий → ЖИВИЙ. Лише ESRCH означає «немає».
      alive = (e as NodeJS.ErrnoException).code === "EPERM";
    }
    if (alive) { kept++; continue; }
    try { rmSync(path.join(root, name), { recursive: true, force: true }); removed++; } catch { kept++; }
  }
  return { removed, kept };
}

/**
 * 🔍 Б3 — СТОРОЖ ДИСКА. Кластер важить ~67 МБ; менше запасу — не починаємо.
 *
 * 🔴 НАВІЩО ОКРЕМА ПЕРЕВІРКА, ЯКЩО `initdb` І ТАК УПАДЕ. Бо падає він так, що
 * причину доводиться шукати: у виводі зʼявляється `Command failed: su postgres -s
 * /bin/bash -c …/initdb -D …` і аж наприкінці — `could not write`. Сьогодні це
 * коштувало двох перезамірів: числа зняли з забитого диска й повірили їм. Сторож
 * називає ЧИСЛО вільного місця ДО спроби, тож діагноз читається з першого рядка.
 */
const NEED_MB = 200;      // 67 МБ кластер + запас на WAL і паралельні прогони

function freeMb(dir: string): number | null {
  const r = spawnSync("df", ["-Pm", dir], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;   // немає `df` — не вигадуємо число
  const line = r.stdout.trim().split("\n").pop() ?? "";
  const n = Number(line.split(/\s+/)[3]);
  return Number.isFinite(n) ? n : null;
}

/**
 * ⚙️ `need` — параметр, а не лише константа, СВІДОМО: без нього гейт `#202` не мав би
 * як викликати справжній сторож (диск у деві не буває порожнім на вимогу) і
 * перевіряв би власну фікстуру замість продукту. Спіймано саботажем: перша редакція
 * гейта складала повідомлення сама й лишалась зеленою, коли сторож ламали.
 */
export function diskGuard(root = tmpdir(), need = NEED_MB): Unavailable | null {
  const mb = freeMb(root);
  if (mb == null || mb >= need) return null;
  return {
    kind: "provision-failed",
    unavailable: `на ${root} вільно ${mb} МБ, а кластеру треба щонайменше ${need} МБ. `
      + "Це НЕ «оточення таке» — це зламане оточення: частина гейтів не виконається. "
      + "Прибери сміття (`rm -rf /tmp/uts-scratch-*` для мертвих PID) і повтори.",
  };
}

/**
 * 🔴 Б2 — ГОЛОВНЕ В ЦІЙ ЗАДАЧІ: «НЕМАЄ БІНАРІВ» І «ОТОЧЕННЯ ЗЛАМАЛОСЬ» — РІЗНІ РЕЧІ.
 *
 * Досі `unavailable` був просто рядком, і `testRunGate.allowedSkips()` звіряв ЛИШЕ
 * ІМʼЯ тесту — причину не читав ніхто. Наслідок заміряний: на прод-сервері скіп
 * «тут немає PostgreSQL» (очікувана НОРМА) і скіп «кластер не піднявся, бо диск
 * помер» падали в ОДНУ дозволену клітинку, і прогін друкував «ЗАРАХОВАНО».
 * Тобто набір міг відзвітувати про успіх, не виконавши 41 перевірку, і формально
 * не збрехати. Це рівно клас «0 падінь ≠ перевірено».
 *
 *   • `no-binaries`      — оточення таке за побудовою (прод: БД зовнішня, Neon).
 *                          Пропуск ЗАКОННИЙ і лишається в `ALLOWED_PROD_SKIPS`.
 *   • `provision-failed` — оточення ЗЛАМАЛОСЬ (диск, права, кластер не встав).
 *                          Пропуск НЕ законний НІДЕ: прогін мусить впасти з причиною.
 *
 * ⚠️ Вид визначає ПРИРОДА перешкоди, а не її текст. Розбирати рядок регуляркою
 * означало б завести другу копію правила — те саме, від чого ми лікували лідген.
 */
export type UnavailableKind = "no-binaries" | "provision-failed";

export interface Unavailable { unavailable: string; kind: UnavailableKind }

/**
 * Причина для `{ skip: ... }`. Для `provision-failed` ДОДАЄ МАРКЕР, за яким вартовий
 * знімає з цього скіпу дозвіл — незалежно від того, чи тест є в `ALLOWED_PROD_SKIPS`.
 *
 * 🔴 Чому маркер, а не окреме поле: `node --test` віддає репортеру РІВНО одну річ —
 * рядок причини (`ev.data.skip`). Іншого каналу від тесту до вартового не існує, тож
 * вид мусить їхати всередині рядка. Але їде він КОНСТАНТОЮ з одного модуля, а не
 * впізнається регуляркою по вільному тексту.
 */
export const skipReason = (u: Unavailable): string =>
  u.kind === "provision-failed" ? `${BROKEN_ENV_MARK} ${u.unavailable}` : u.unavailable;

export interface Scratch {
  /** Рядок підключення до свіжої ПОРОЖНЬОЇ бази. */
  url: string;
  /** Як саме її дістали — іде в лог, щоб «пройшло» не плуталось із «пропущено». */
  strategy: string;
  /** Зупинити кластер і прибрати каталог. Ідемпотентно. */
  dispose: () => void;
}

/** Каталоги, де дистрибутиви тримають `initdb`/`pg_ctl`. */
function pgBinDir(): string | null {
  if (process.env.PG_BIN && existsSync(path.join(process.env.PG_BIN, "initdb"))) return process.env.PG_BIN;
  const roots = ["/usr/lib/postgresql", "/usr/pgsql", "/opt/homebrew/opt", "/usr/local/opt"];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // Найсвіжіша мажорна версія першою: 16 має перемагати 14.
    const kids = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const kid of kids) {
      const bin = path.join(root, kid, "bin");
      if (existsSync(path.join(bin, "initdb"))) return bin;
    }
  }
  for (const bin of ["/usr/local/pgsql/bin", "/usr/bin", "/usr/local/bin"]) {
    if (existsSync(path.join(bin, "initdb"))) return bin;
  }
  return null;
}

/**
 * PostgreSQL відмовляється працювати з-під root. Якщо ми root — виконуємо команди
 * через `su` від службового користувача. Інакше запускаємо як є.
 */
function runner(): { wrap: (cmd: string) => [string, string[]]; owner: string | null } | null {
  const amRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!amRoot) return { wrap: (cmd) => ["/bin/bash", ["-lc", cmd]], owner: null };
  for (const user of ["postgres", "pgsql"]) {
    const probe = spawnSync("id", ["-u", user], { encoding: "utf8" });
    if (probe.status === 0) {
      return { wrap: (cmd) => ["su", [user, "-s", "/bin/bash", "-c", cmd]], owner: user };
    }
  }
  return null;
}

/**
 * Піднімає одноразовий кластер і повертає URL порожньої бази.
 * `null` = автопровізія неможлива в цьому оточенні (викличник має ПРОПУСТИТИ тест
 * із видимою причиною, а не вдавати успіх).
 */
export function provisionScratch(): Scratch | Unavailable {
  // Явний override лишається: він потрібен, коли базу дає CI.
  const explicit = process.env.TEST_SCRATCH_DB_URL;
  if (explicit) {
    if (/neon\.tech|prod/i.test(explicit) && process.env.TEST_SCRATCH_FORCE !== "1") {
      return { kind: "provision-failed",
        unavailable: "TEST_SCRATCH_DB_URL схожий на бойову базу — відмовляюсь у неї писати" };
    }
    return { url: explicit, strategy: "TEST_SCRATCH_DB_URL (зовнішня база)", dispose: () => {} };
  }

  const bin = pgBinDir();
  if (!bin) {
    return { kind: "no-binaries",
      unavailable: "у цьому оточенні немає бінарів PostgreSQL (initdb/pg_ctl) — "
      + "підняти тимчасовий кластер нема з чого. На прод-сервері це НОРМА: БД зовнішня (Neon), "
      + "і створювати там службову базу заради тесту ми свідомо не будемо. "
      + "Гнати цей тест треба в дев-оточенні (`npm test`), де бінарі є." };
  }
  const run = runner();
  if (!run) {
    return { kind: "provision-failed",
      unavailable: "процес працює від root, а службового користувача postgres немає — "
      + "PostgreSQL з-під root не стартує. Запусти набір від звичайного користувача." };
  }

  sweepOrphans();          // Б1: чужі сироти мертвих PID — до того, як міряти місце.
  const lowDisk = diskGuard();
  if (lowDisk) return lowDisk;

  const dir = path.join(tmpdir(), `uts-scratch-${process.pid}-${Date.now().toString(36)}`);
  const data = path.join(dir, "data");
  let started = false;
  let gone = false;
  const dispose = () => {
    if (gone) return;      // ідемпотентно: `finally` + обробник сигналу кличуть двічі
    gone = true;
    if (started) {
      spawnSync(...run.wrap(`${bin}/pg_ctl -D ${data} -m immediate stop`), { encoding: "utf8" });
      started = false;
    }
    rmSync(dir, { recursive: true, force: true });
    LIVE.delete(dispose);
  };
  LIVE.add(dispose);
  armExitHandlers();

  try {
    mkdirSync(dir, { recursive: true });
    if (run.owner) execFileSync("chown", ["-R", run.owner, dir]);

    // trust-авторизація безпечна: кластер слухає ЛИШЕ unix-сокет усередині свого ж
    // тимчасового каталогу, TCP вимкнено (`listen_addresses=''`). Ззовні не видно.
    execFileSync(...run.wrap(`${bin}/initdb -D ${data} -U scratch --auth=trust`),
      { encoding: "utf8", stdio: "pipe" });
    execFileSync(...run.wrap(
      `${bin}/pg_ctl -D ${data} -o "-k ${dir} -c listen_addresses=''" -w -l ${dir}/log start`),
      { encoding: "utf8", stdio: "pipe" });
    started = true;
    execFileSync(...run.wrap(`${bin}/createdb -h ${dir} -U scratch utsscratch`),
      { encoding: "utf8", stdio: "pipe" });

    // Через unix-сокет: жодних портів, отже й жодних гонок за порт між прогонами.
    const url = `postgresql://scratch@/utsscratch?host=${encodeURIComponent(dir)}`;
    return { url, strategy: `власний кластер (${bin})`, dispose };
  } catch (err) {
    dispose();
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "provision-failed",
      unavailable: `не вдалося підняти тимчасовий кластер: ${msg.slice(0, 300)}` };
  }
}
