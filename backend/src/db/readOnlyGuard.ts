/**
 * 🔒 ГЕЙТ READ-ONLY ДЛЯ ТЕСТОВОГО ХАРНЕСУ — на рівні СТВОРЕННЯ ПУЛУ.
 *
 * 🔴 НАВІЩО САМЕ ТУТ. Запобіжник жив у preload-модулі (`testReadOnly.ts`), який
 * підключається через `--import` у `npm run test:prod`. Але команду можна написати й
 * інакше — `TEST_SCOPE=prod npm test` (саме так вона стояла в доках): preload не
 * виконується, і набір іде в бойову базу з ПОВНИМИ правами. Скарга від `#13` лунала
 * тільки ПІСЛЯ того, як решта тестів уже відпрацювала.
 *
 * `pool.ts` — єдине місце, крізь яке проходить БУДЬ-ЯКИЙ шлях до БД: роут, джоба,
 * юніт-виклик обробника, разовий скрипт. Гейт тут неможливо обійти вибором команди.
 *
 * ⚠️ ІНЕРТНИЙ У ПРОДІ. Спрацьовує ЛИШЕ коли виставлено `TEST_SCOPE=prod`, тобто в
 * тестовому оточенні. Бойовий процес цієї змінної не має і не отримає — для нього
 * функція є no-op з першого ж рядка. Сервер не має ні падати, ні вимагати роль.
 */

/** Роль, під якою єдино дозволено ходити до бойової БД із тестів. */
export const TEST_DB_ROLE = "test_readonly";

/**
 * 🔴 ДРУГИЙ РУБІЖ: ПРОД-ХОСТ ПІД `node --test` — ЛИШЕ ПІД НАЗВАНОЮ READ-ONLY РОЛЛЮ.
 *
 * Привід — моє ж застереження, і воно було про везіння, а не про механізм: у
 * контейнері `DATABASE_URL` дивиться на БОЙОВУ Neon-базу, `testMode.HAS_DB` вмикає
 * БД-тести самою наявністю змінної, а `assertTestHarnessReadOnly` вище інертний без
 * `TEST_SCOPE=prod`. Сьогодні нас рятує те, що в рядку стоїть роль `kk_ro`
 * (SELECT-only) — тобто **рядок підключення, а не запобіжник**. Інший контейнер із
 * write-роллю не був би прикритий нічим.
 *
 * ⚠️ МЕЖА ПРОВЕДЕНА ПО ХОСТУ, А НЕ ПО «Є DATABASE_URL» — і це не стилістика.
 * Одноразовий кластер (`db/scratchDb.ts`, гейти `#8`, `#231f`) підключається так:
 *   `postgresql://scratch@/utsscratch?host=/tmp/…`  — unix-сокет, ХОСТА НЕМАЄ ВЗАГАЛІ.
 * Ознака «є DATABASE_URL» накрила б і його, тобто зламала б чужі гейти заради свого.
 *
 * ⚠️ ЧОМУ `NODE_TEST_CONTEXT`, А НЕ ВЛАСНА ЗМІННА. Її ставить САМ рантайм `node --test`
 * у дочірньому процесі (заміряно: `child-v8`; поза `--test` її немає). Власну змінну
 * можна забути виставити — саме так і сталося з `TEST_SCOPE=prod npm test`, який
 * обходив preload. Маркер, який ставить не людина, забути неможливо.
 */
export const READONLY_DB_ROLES: readonly string[] = [
  TEST_DB_ROLE,   // харнес `npm run test:prod`
  "kk_ro",        // рядок контейнера асистента: SELECT-only, перевірено читанням
  "ai_readonly",  // AI-оракул
];

/** Чи дивиться рядок підключення на БОЙОВУ базу. Unix-сокет → false за побудовою. */
export function isProdDbHost(url: string | undefined): boolean {
  if (!url) return false;
  try { return /\.neon\.tech$/i.test(new URL(url).hostname); } catch { return false; }
}

/** Роль із рядка підключення (username). Порожньо — коли її там немає. */
export function urlRole(url: string | undefined): string {
  if (!url) return "";
  try { return decodeURIComponent(new URL(url).username); } catch { return ""; }
}

export class ReadOnlyGuardError extends Error {}

/**
 * Кидає, якщо набір збирається відкрити пул до бойової БД повз read-only роль.
 * `env` параметром — щоб це можна було перевірити тестом, не ламаючи процес.
 */
export function assertTestHarnessReadOnly(env: NodeJS.ProcessEnv = process.env): void {
  /**
   * 🔒 РУБІЖ ДРУГИЙ — ДО перевірки `TEST_SCOPE`, бо він саме про той випадок, коли
   * `TEST_SCOPE` НЕ виставлено. Бойовий процес сюди не потрапляє: `NODE_TEST_CONTEXT`
   * ставить лише `node --test`, а сервер під ним не біжить.
   */
  if (env.NODE_TEST_CONTEXT && isProdDbHost(env.DATABASE_URL)) {
    const role = urlRole(env.DATABASE_URL);
    const viaPgOptions = new RegExp(`(^|\\s)-c\\s+role=${TEST_DB_ROLE}(\\s|$)`).test(env.PGOPTIONS ?? "");
    if (!viaPgOptions && !READONLY_DB_ROLES.includes(role)) {
      throw new ReadOnlyGuardError(
        `🔴 НАБІР ІДЕ В БОЙОВУ БАЗУ ПІД РОЛЛЮ ${JSON.stringify(role || "(немає в рядку)")}, `
        + `якої немає серед названих read-only (${READONLY_DB_ROLES.join(", ")}).\n`
        + `   Безпека не сміє триматись на тому, що в рядку підключення випадково опинилась `
        + `нешкідлива роль. Або постав read-only роль, або прибери DATABASE_URL — `
        + `тоді БД-тести чесно скіпнуться з причиною.`);
    }
  }

  // Не тестове оточення → нічого не робимо. Це перший рядок навмисно: жодної
  // додаткової умови, від якої міг би залежати старт прода.
  if (env.TEST_SCOPE !== "prod") return;

  const how = "Прогін проти бойової БД дозволений ЛИШЕ через `npm run test:prod` "
    + "(він додає `--import ./dist/testReadOnly.js`).";

  // `options=` у самому рядку підключення має пріоритет над PGOPTIONS і мовчки
  // скасував би роль. Перевіряємо тут, а не лише в preload: preload могли й не запустити.
  if (env.DATABASE_URL && /[?&]options=/i.test(env.DATABASE_URL)) {
    throw new ReadOnlyGuardError(
      `🔴 DATABASE_URL містить власний options= — він перекриє PGOPTIONS, і набір пішов би `
      + `в прод із правом на запис. Прибери options= з рядка підключення.`);
  }

  const pgo = env.PGOPTIONS ?? "";
  if (!new RegExp(`(^|\\s)-c\\s+role=${TEST_DB_ROLE}(\\s|$)`).test(pgo)) {
    throw new ReadOnlyGuardError(
      `🔴 ТЕСТОВИЙ РЕЖИМ (TEST_SCOPE=prod), але з'єднання НЕ під роллю ${TEST_DB_ROLE}: `
      + `PGOPTIONS=${JSON.stringify(pgo)}. Відмовляюсь відкривати пул із правом на запис.\n`
      + `   ${how}\n`
      + `   Падаємо ДО першого запиту — саме тому, що «поскаржитись після» вже пізно: `
      + `один юніт-тест так виконав справжній DELETE проти прода.`);
  }
}
