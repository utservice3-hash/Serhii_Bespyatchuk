/**
 * 🔁 ЧИСТІ ПРАВИЛА РЕАКТИВАЦІЇ — БЕЗ імпортів.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ ФАЙЛ. Пороги й формула цінності — це бізнес-рішення власника,
 * і перевіряти їх треба БЕЗ бази. Але `core/reactivation.ts` тягне `db/pool.js` →
 * `config.js`, який кидає без `DATABASE_URL` ще НА ІМПОРТІ, тобто раніше, ніж
 * спрацює skip. Перша версія гейтів #23 саме на цьому й упала: тест про чисту
 * арифметику вимагав живої БД. Той самий урок, що з `clientKeySql.ts`.
 */

/** Пороги — рішення власника 03.08.2026. Тут, бо на них стоїть гейт #23. */
export const SLEEPING_DAYS = 60;
export const LOST_DAYS = 180;

export type ClientState = "active" | "sleeping" | "lost";

/**
 * 🧭 СЕГМЕНТ ЗА ЧАСТОТОЮ ЗАМОВЛЕНЬ (рішення власника 04.08.2026).
 * Рахується з МЕДІАННОГО інтервалу між оплатами по канонічному ключу.
 *
 * 🔴 МІНІМУМ 3 ОПЛАТИ — і це не обережність, а замір. При порозі «2+» медіана
 * рахується по ОДНОМУ інтервалу: дві оплати з різницею 3 дні робили клієнта
 * «ВІП» назавжди. На проді таких 488 із 1 135, і ВІП роздувався з 232 до 393.
 * Тому <3 оплат — це `unknown` («недостатньо історії»), а не вгаданий сегмент.
 */
export type ClientSegment = "vip" | "regular" | "episodic" | "unknown";
export const SEGMENT_MIN_PAYMENTS = 3;
export const VIP_MAX_GAP_DAYS = 10;
export const REGULAR_MAX_GAP_DAYS = 28;

export function segmentOf(medianGapDays: number | null, payments: number): ClientSegment {
  if (payments < SEGMENT_MIN_PAYMENTS || medianGapDays == null) return "unknown";
  if (medianGapDays <= VIP_MAX_GAP_DAYS) return "vip";
  if (medianGapDays <= REGULAR_MAX_GAP_DAYS) return "regular";
  return "episodic";
}

/**
 * 🔴 ПОРІГ «ПОРА В РЕАКТИВАЦІЮ» ЗАЛЕЖИТЬ ВІД СЕГМЕНТА (рішення власника).
 * Сенс: ВІП, що замовляв щотижня і мовчить два тижні, — головний кандидат;
 * епізодичного чіпати через два тижні безглуздо, у нього такий ритм.
 *
 * `unknown` іде за епізодичним (60) — свідомий дефолт власника: клієнт без
 * історії не має зависати взагалі без правила, а 60 днів це той поріг, за яким
 * екран жив досі. Робити для нього окремий поріг означало б вигадати четверте
 * правило під сегмент, якого ми навмисне не визначили.
 */
export const SEGMENT_SLEEPING_DAYS: Record<ClientSegment, number> = {
  vip: 14, regular: 30, episodic: 60, unknown: 60,
};

/**
 * 🗄 МЕЖА «АРХІВУ» — втрачені понад рік (рішення власника + замір 04.08.2026).
 * З 628 втрачених: 180-269 дн. — 142, 270-364 — 102, 365-547 — 100, 548+ — 284.
 * Тобто рік ділить список майже навпіл (244 свіжих / 384 архівних) і відрізає
 * саме той хвіст, де давність рахується роками. Архів не ховає клієнта — він
 * прибирає його з головної сцени, щоб свіжі не тонули.
 */
export const ARCHIVE_DAYS = 365;

/**
 * Чиста функція: стан із кількості днів без замовлення.
 * `segment` не обовʼязковий — без нього поводиться як раніше (60/180), тож старі
 * виклики й гейт #23 лишаються чинними без правок.
 */
export function stateOf(daysSinceLastOrder: number, segment?: ClientSegment): ClientState {
  if (daysSinceLastOrder >= LOST_DAYS) return "lost";
  const sleep = segment ? SEGMENT_SLEEPING_DAYS[segment] : SLEEPING_DAYS;
  if (daysSinceLastOrder >= sleep) return "sleeping";
  return "active";
}

/**
 * ЦІННІСТЬ = виручка за життя × свіжість. Свіжість спадає гіперболічно від
 * місяців простою: 12 міс. без замовлення важать удесятеро менше за свіжого.
 *
 * 🔴 Формула НАЗВАНА і живе в ядрі, а не в сортуванні на фронті: інакше два
 * екрани відсортують «за цінністю» по-різному, і жоден не буде неправильним.
 */
export function valueScore(lifetimeRevenue: number, daysSinceLastOrder: number): number {
  const months = Math.max(0, daysSinceLastOrder) / 30;
  return lifetimeRevenue / (1 + months);
}

/** Причини закриття реактиваційної задачі. Перелік закритий — «інше» вимагає тексту. */
export const CLOSE_REASONS = [
  { key: "price", label: "Ціна" },
  { key: "competitor", label: "Конкурент" },
  { key: "own_transport", label: "Власний транспорт" },
  { key: "seasonality", label: "Сезонність" },
  { key: "closed_down", label: "Закрились" },
  { key: "other", label: "Інше" },
] as const;
export const CLOSE_REASON_KEYS: string[] = CLOSE_REASONS.map((r) => r.key);

