/**
 * 🔒 ВОРОТА РЕЖИМУ ПРОГОНУ — щоб «0 падінь» не означало «нічого не виконалось».
 *
 * 🔴 НАВІЩО. Приймання після деплою надрукувало «100 тестів, 0 падінь», а насправді
 * **72 тести тихо пропустились**: оточення подали не з того файла, `DATABASE_URL` не
 * потрапив у процес, і всі прод-перевірки відсіялись зі `SKIP`. Вивід був так само
 * зелений, як справжній.
 *
 * Це ТРЕТІЙ випадок хибно-зеленого за спринт, і форма щоразу одна: **«нічого не
 * сталось» читається як «усе гаразд»**. Два попередні вже закриті — у ДАНИХ
 * («порожній результат = провал») і в СКЛАДІ НАБОРУ (маніфест). Лишався РЕЖИМ
 * ПРОГОНУ: набір може бути цілим, дані на місці, а виконатись — третина.
 *
 * ЩО РОБЛЯТЬ ВОРОТА (лише в `TEST_SCOPE=prod`, локально `npm test` скіпи законні):
 *   1. Скіп, якого НЕМАЄ в іменному списку дозволених, — це ПАДІННЯ.
 *   2. У підсумку друкується не лише «fail 0», а СКІЛЬКИ ВИКОНАЛОСЬ проти скількох
 *      очікувалось у цьому режимі.
 *   3. Дозволені скіпи названі ПОІМЕННО — не «усі, що починаються з #8», бо маска
 *      прикрила б і майбутній скіп, якого ми не бачили.
 *
 * ⚙️ Чому кастомний репортер, а не окремий тест. Тест не бачить скіпів СУСІДІВ:
 * `node --test` віддає їх лише як події прогону. Перевірка мусить стояти там, де
 * видно весь прогін цілком, — тобто в репортері.
 */

/** Скіпи, дозволені в прод-режимі. Кожен — з причиною, як у решті реєстрів. */
export const ALLOWED_PROD_SKIPS: { name: string; why: string }[] = [
  { name: "AI-оракул: усі кейси стабільні між прогонами і збігаються з ядром",
    why: "платний гейт — вмикається окремо (npm run test:ai), бо звертається до моделі" },
  { name: "#8 міграція проходить на ПОРОЖНІЙ базі повністю",
    why: "на прод-сервері немає бінарів PostgreSQL (initdb/pg_ctl) — БД зовнішня (Neon). "
       + "Службову базу в бойовому проєкті заради тесту свідомо не створюємо; тест живе в `npm test`" },
  { name: "#8b ДЗЕРКАЛО: зламану схему тест ЛОВИТЬ, а не пропускає",
    why: "те саме — дзеркало до #8, без бінарів PG підняти нічого" },
  { name: "#11 МАТРИЦЯ ДОСТУПУ: жодна клітинка не змінилась",
    why: "повний зліпок (1025 пар, ~7-8 хв) — окремий режим `npm run test:matrix`. "
       + "У ньому цей скіп уже НЕ дозволений (див. allowedSkips)" },
];

/** Дозволені скіпи для конкретного режиму. У матричному #11 мусить ВИКОНАТИСЬ. */
export function allowedSkips(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const names = ALLOWED_PROD_SKIPS
    .filter((s) => !(env.TEST_MATRIX === "1" && s.name.startsWith("#11 ")))
    .filter((s) => !(env.TEST_AI === "1" && s.name.startsWith("AI-оракул")))
    .map((s) => s.name);
  return new Set(names);
}

export interface RunTally { ran: number; failed: number; skipped: string[] }
export interface Verdict { ok: boolean; ran: number; required: number; declared: number; unexpected: string[]; report: string }

export function modeName(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEST_MATRIX === "1" ? "test:matrix" : env.TEST_AI === "1" ? "test:ai" : "test:prod";
}

/**
 * Чистий вирок по прогону — щоб його можна було перевірити ТЕСТОМ, а не лише
 * саботажем усього приймання. Нічого не мутує і не читає глобального стану.
 *
 * 🔴 `declared` МУСИТЬ ПРИЙТИ ЗЗОВНІ (з маніфесту). Спершу я рахував
 * `expected = ran + дозволені скіпи` — і ворота бадьоро надрукували «виконалось
 * 18 із 18», коли не виконалось НІЧОГО: всі файли впали на імпорті. Це рівно та
 * циклічна перевірка «A = B», де B — те, чим щойно означили A. Маніфест каже,
 * скільки тестів МАЄ існувати, і не залежить від того, скільки сьогодні відпрацювало.
 */
export function evaluateRun(t: RunTally, declared: number, env: NodeJS.ProcessEnv = process.env): Verdict {
  const allowed = allowedSkips(env);
  const unexpected = t.skipped.filter((n) => !allowed.has(n));
  const okSkips = t.skipped.length - unexpected.length;
  const required = declared - okSkips;              // стільки МАЄ виконатись у цьому режимі
  const ok = unexpected.length === 0 && t.ran >= required;
  const mode = modeName(env);

  let report = "\n"
    + `🔒 РЕЖИМ ${mode}: ВИКОНАЛОСЬ ${t.ran} із ${required} обовʼязкових `
    + `(оголошено в маніфесті ${declared}, дозволених скіпів ${okSkips}, `
    + `несподіваних ${unexpected.length}, падінь ${t.failed})\n`;
  if (!ok) {
    report += "🔴 ПРОГІН НЕ ЗАРАХОВАНО: виконалось менше, ніж вимагає режим.\n"
      + "   «0 падінь» тут НЕ означає «перевірено» — саме так приймання одного разу\n"
      + "   надрукувало зелене при 72 тихо пропущених.\n"
      + (unexpected.length
        ? "   Несподівані скіпи:\n" + unexpected.map((n) => `   ﹣ ${n}\n`).join("")
        : `   Скіпів немає, але не дорахувались ${required - t.ran} тестів — значить\n`
          + "   частина файлів не завантажилась (падіння на імпорті) або глоб їх не знайшов.\n")
      + "   Найчастіша причина: оточення не потрапило в процес. Воно лежить у\n"
      + "   backend/.env (НЕ ../.env):\n"
      + `   cd backend && set -a && . ./.env && set +a && API_BASE=… npm run ${mode}\n`;
  }
  return { ok, ran: t.ran, required, declared, unexpected, report };
}

interface TestEvent { type: string; data: { name?: string; skip?: boolean | string } }

export default async function* runGate(source: AsyncIterable<TestEvent>) {
  const tally: RunTally = { ran: 0, failed: 0, skipped: [] };
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    // `skip` приходить або true, або текстом причини — обидва означають «не виконався».
    if (ev.data.skip === true || typeof ev.data.skip === "string") tally.skipped.push(ev.data.name ?? "");
    else { tally.ran++; if (ev.type === "test:fail") tally.failed++; }
  }
  if (process.env.TEST_SCOPE !== "prod") return;    // локальний `npm test`: скіпи законні

  const { MANIFEST_TESTS, MANIFEST_SECURITY_TABLES } = await import("./testManifest.js");
  const v = evaluateRun(tally, MANIFEST_TESTS.length + MANIFEST_SECURITY_TABLES.length);
  if (!v.ok) process.exitCode = 1;
  yield v.report;
}
