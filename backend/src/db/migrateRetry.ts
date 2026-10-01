/**
 * 🔁 ПОВТОР МІГРАЦІЇ ПРИ ВЗАЄМНОМУ БЛОКУВАННІ (01.10.2026, рішення Романа: «зроби обидва»).
 *
 * 📐 ЗАМІРЯНО. Викат 749d894 01.10.2026 двічі поспіль упав на кроці `migrate` з `deadlock detected` (40P01):
 * схема бере блокування на `managers`, а потім чекає ексклюзивного на `deals`/`tasks`, тоді як живі запити
 * дашборда читають ці таблиці у зворотному порядку. Третій ручний запуск пройшов. У робочі години це
 * повторюватиметься в будь-кого, тож повтор — у самій міграції, а не в памʼяті того, хто викочує.
 *
 * 🔴 ЧОМУ ПОВТОР БЕЗПЕЧНИЙ. `schema.sql` іде ОДНИМ запитом простого протоколу, тобто однією неявною
 * транзакцією: невдала спроба відкочується ЦІЛКОМ, і наступна починає з того самого стану. Це не віра,
 * а твердження гейта `#776b` на живому кластері. Повторюємо лише коди, що означають «конкуренцію», а не
 * «помилку в схемі»: синтаксис чи відсутня таблиця з повтором не лікуються й мусять падати одразу (`#776`).
 *
 * Без `config`/`pool` — щоб гейт ганяв саме цю функцію, а не копію.
 */

/** Коди Postgres, які означають конкуренцію за блокування, а не дефект схеми. */
export const RETRYABLE_MIGRATION_CODES: readonly string[] = [
  "40P01", // deadlock_detected — сьогоднішній випадок
  "40001", // serialization_failure
  "55P03", // lock_not_available
];

export const MIGRATION_ATTEMPTS = 5;

/** Пауза перед спробою `attempt` (з 2-ї): 3, 6, 12, 24 с — живий запит дашборда за цей час доходить. */
export const retryDelayMs = (attempt: number): number => 3000 * 2 ** (attempt - 2);

export function isRetryableMigrationError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_MIGRATION_CODES.includes(code);
}

/**
 * Виконати `fn` до `attempts` разів, повторюючи ЛИШЕ на конкуренції за блокування. Будь-яка інша помилка —
 * одразу назовні; вичерпані спроби — назовні ОСТАННЯ помилка, а не загальне «не вийшло».
 */
export async function withMigrationRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? MIGRATION_ATTEMPTS;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line) => console.error(line));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableMigrationError(err) || attempt >= attempts) throw err;
      const wait = retryDelayMs(attempt + 1);
      log(`⏳ міграція: ${(err as { code: string }).code} на спробі ${attempt}/${attempts} — транзакція відкотилась цілком, `
        + `повтор через ${wait / 1000} с`);
      await sleep(wait);
    }
  }
}
