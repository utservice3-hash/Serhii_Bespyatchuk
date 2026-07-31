import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/**
 * ТЕСТ #8 — СХЕМА З НУЛЯ.
 *
 * Міграція має проходити на ПОРОЖНІЙ базі, а не лише «доїжджати» на наявній. Ми вже
 * ловили цей клас: сид `key_card` стояв ПЕРЕД `INSERT` рахунків, тож на живій БД усе
 * працювало, а на чистій лишались NULL — помилка, яку видно тільки з нуля.
 *
 * Потрібна окрема порожня БД: `TEST_SCRATCH_DB_URL=postgres://…/scratch`.
 * Без неї тест ПРОПУСКАЄТЬСЯ з причиною — мовчки «проходити» він не має права,
 * бо тоді ми думали б, що схема перевірена, а вона ні.
 *
 * 🔴 Ганяти ЛИШЕ проти чистої тимчасової бази. Проти прод-URL — ніколи: міграція там
 * і так їде окремим кроком деплою, а тест не має права нічого писати в бойову базу.
 */
const SCRATCH = process.env.TEST_SCRATCH_DB_URL;

test("#8 міграція проходить на ПОРОЖНІЙ базі повністю", 
  // 🔴 31.07.2026: цей skip тримався так довго, що схема з нуля НІКОЛИ не прогонялась —
  // і в ній накопичився GRANT на таблицю, яка створюється нижче. Тому в причині — готовий
  // рецепт стенда, щоб «пропущено» не означало «нема як перевірити».
  SCRATCH ? {} : { skip: "потрібен TEST_SCRATCH_DB_URL (ПОРОЖНЯ база; проти прода — ніколи). "
    + "Стенд: su postgres -c 'initdb -D /tmp/pgro/data -U sbx --auth=trust && "
    + "pg_ctl -D /tmp/pgro/data -o \"-p 5599 -k /tmp/pgro\" start' (бінарі /usr/lib/postgresql/16/bin)" },
  () => {
    assert.ok(!/neon\.tech|prod/i.test(SCRATCH!) || process.env.TEST_SCRATCH_FORCE === "1",
      "TEST_SCRATCH_DB_URL схожий на бойову базу — відмовляюсь писати в неї");
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: SCRATCH },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(out, /Migration applied/, `міграція не дійшла до кінця:\n${out}`);
  });
