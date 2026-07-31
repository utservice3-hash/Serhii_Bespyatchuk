import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
export function provisionScratch(): Scratch | { unavailable: string } {
  // Явний override лишається: він потрібен, коли базу дає CI.
  const explicit = process.env.TEST_SCRATCH_DB_URL;
  if (explicit) {
    if (/neon\.tech|prod/i.test(explicit) && process.env.TEST_SCRATCH_FORCE !== "1") {
      return { unavailable: "TEST_SCRATCH_DB_URL схожий на бойову базу — відмовляюсь у неї писати" };
    }
    return { url: explicit, strategy: "TEST_SCRATCH_DB_URL (зовнішня база)", dispose: () => {} };
  }

  const bin = pgBinDir();
  if (!bin) {
    return { unavailable: "у цьому оточенні немає бінарів PostgreSQL (initdb/pg_ctl) — "
      + "підняти тимчасовий кластер нема з чого. На прод-сервері це НОРМА: БД зовнішня (Neon), "
      + "і створювати там службову базу заради тесту ми свідомо не будемо. "
      + "Гнати цей тест треба в дев-оточенні (`npm test`), де бінарі є." };
  }
  const run = runner();
  if (!run) {
    return { unavailable: "процес працює від root, а службового користувача postgres немає — "
      + "PostgreSQL з-під root не стартує. Запусти набір від звичайного користувача." };
  }

  const dir = path.join(tmpdir(), `uts-scratch-${process.pid}-${Date.now().toString(36)}`);
  const data = path.join(dir, "data");
  let started = false;
  const dispose = () => {
    if (started) {
      spawnSync(...run.wrap(`${bin}/pg_ctl -D ${data} -m immediate stop`), { encoding: "utf8" });
      started = false;
    }
    rmSync(dir, { recursive: true, force: true });
  };

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
    return { unavailable: `не вдалося підняти тимчасовий кластер: ${msg.slice(0, 300)}` };
  }
}
