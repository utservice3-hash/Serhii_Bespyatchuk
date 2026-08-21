/**
 * 🧮 ПРАВИЛА ЦИКЛУ ЗАТВЕРДЖЕННЯ ПЛАНУ ПО КЛІЄНТУ — БЕЗ імпортів.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ ФАЙЛ. Гейт власника звучить так: «Σ у "постійні принесуть"
 * == Σ ЗАТВЕРДЖЕНИХ (не поданих і не чернеток)». Перевірити це можна двома
 * способами: прогнати роут по HTTP (важко, потрібне все оточення) або взяти ту
 * саму арифметику й ті самі SQL, що виконує роут. Другий спосіб чесний РІВНО
 * доти, доки тест і роут беруть ОДИН текст, а не схожий, — урок #21c, де
 * саботаж спершу прогнали на власноруч переписаному SQL і доказ вийшов ні про що.
 *
 * Файл не імпортує нічого (зокрема `db/pool.js` → `config.js`, який кидає без
 * DATABASE_URL ще на імпорті), тож його можна брати і в тестах без БД.
 */

export type PlanStatus = "draft" | "pending" | "approved" | "none";

export interface PlanRow { plan: number; planStatus: string }

/**
 * 🔑 КЛЮЧ, НА ЯКИЙ МОЖНА СТАВИТИ ПЛАН.
 *
 * 🔴 Дженерик-ключ — це НЕ клієнт, а плейсхолдер Kommo, під яким лежать сотні
 * різних замовників («названиенеуказано» тримає 612 замовлень). План на нього
 * поставити неможливо за змістом: незрозуміло, кому саме його виконувати.
 * Заміряно на проді 21.08.2026: за липень такий план ОДИН — 40 000 ₴, статус
 * `pending`. Тобто дірка не теоретична, нею вже скористались.
 *
 * ⚠️ Список дженериків живе в `core/metrics.GENERIC_CLIENT_KEYS` і сюди
 * ПЕРЕДАЄТЬСЯ, а не імпортується: цей файл навмисно без імпортів (`metrics.ts`
 * тягне `db/pool.js` → `config.js`, який кидає без `DATABASE_URL` ще на імпорті,
 * тож гейт не встиг би навіть початись). Функція від операндів — той самий
 * прийом, що `createdKlassCase(ops)` і `stuckSignals`.
 */
export function isPlannableClientKey(key: string, genericKeys: readonly string[]): boolean {
  const k = String(key ?? "").trim();
  return k !== "" && !genericKeys.includes(k);
}

export const NOT_PLANNABLE_MSG =
  "На цей ключ план поставити не можна: це технічна заглушка Kommo («назва не вказана»), "
  + "під якою лежать різні замовники. Спершу вкажіть компанію в CRM або обʼєднайте клієнта.";

/**
 * 🧩 РОСТЕР ЕКРАНА = АКТИВНІ ∪ ТІ, ХТО МАЄ ПЛАН НА ЦЕЙ МІСЯЦЬ.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМА ЧИСТА ФУНКЦІЯ, А НЕ ДВА РЯДКИ В РОУТІ. Баг, який вона
 * лікує, був саме «непомітний доданок»: список рядків будувався від СЬОГОДНІШНЬОЇ
 * активності клієнта, а плани читались `WHERE month = M AND client_key = ANY(список)`.
 * Тобто за минулий місяць з екрана мовчки випадали плани всіх, хто відтоді
 * заснув. Заміряно на проді 21.08.2026 за липень: у БД **92 плани / 954 171 ₴**,
 * на екрані — **27 / 367 901 ₴**; випало **65 планів / 586 270 ₴**, з них 61 у
 * сплячих. Жодне окреме число при цьому не виглядало дивним.
 *
 * 🔴 ДЕДУП ЗА ПОБУДОВОЮ, А НЕ ЗА ДОБРОЮ ВОЛЕЮ. Другий список фільтрується по
 * `activeKeys`, тож клієнт фізично не може потрапити в результат двічі — це
 * сильніше за «ми ж не додамо його вдруге» і саме це перевіряє `#108`.
 *
 * Порядок: спершу активні (у порядку, в якому прийшли), далі план-онлі. Активні
 * — це те, заради чого екран існує; плани мертвих клієнтів не мають витісняти
 * живих із першого екрана.
 */
export function rosterWithPlans<T>(
  active: readonly T[],
  all: readonly T[],
  keyOf: (row: T) => string,
  hasPlan: (key: string) => boolean
): { rows: T[]; planOnlyKeys: Set<string> } {
  const activeKeys = new Set(active.map(keyOf));
  const planOnly = all.filter((r) => !activeKeys.has(keyOf(r)) && hasPlan(keyOf(r)));
  return { rows: [...active, ...planOnly], planOnlyKeys: new Set(planOnly.map(keyOf)) };
}

/**
 * 🕳 ПЛАНИ, ЯКІ НЕ ЛЯГЛИ НА ЖОДЕН РЯДОК ЕКРАНА.
 *
 * 🔴 БЕЗ ЦЬОГО ФІКС ЗАЛИШИВ БИ ВЛАСНУ ДІРКУ. Ростер вище добирає лише тих, кого
 * основний запит взагалі бачить; план на дженерик-ключі (40 000 ₴ за липень) не
 * має клієнтського рядка НІДЕ й зник би так само тихо, як зникали сплячі —
 * просто з іншої причини. «Порожнеча читається як норма» — саме той клас.
 *
 * Тому не фільтруємо, а НАЗИВАЄМО: окремий рядок «не привʼязано» з сумою.
 * Правило власника 21.08.2026 — показувати його лише `isAdminScope` (КВП/ОД/
 * адмін): менеджерові нічого робити з ключем, який не його клієнт.
 */
export function splitUnattached<P>(
  plans: readonly P[],
  keyOf: (p: P) => string,
  rosterKeys: ReadonlySet<string>
): P[] {
  return plans.filter((p) => !rosterKeys.has(keyOf(p)));
}
export interface PlanTotals {
  planTotal: number;
  planApproved: number;
  byStatus: Record<string, number>;
}

/**
 * Дві суми, не одна. `planTotal` — скільки менеджер УЖЕ ВПИСАВ (щоб він бачив
 * свою роботу); `planApproved` — скільки з цього ПОГОДЖЕНО. У «постійні
 * принесуть» іде друга: незатверджений план для системи не існує. Одна цифра
 * замість двох ховала б саме ту різницю, заради якої цикл і заводили.
 */
export function planTotals(rows: PlanRow[]): PlanTotals {
  const byStatus: Record<string, number> = { draft: 0, pending: 0, approved: 0, none: 0 };
  let planTotal = 0, planApproved = 0;
  for (const r of rows) {
    planTotal += r.plan;
    if (r.planStatus === "approved") planApproved += r.plan;
    byStatus[r.planStatus] = (byStatus[r.planStatus] ?? 0) + 1;
  }
  return { planTotal, planApproved, byStatus };
}

/** Менеджер подає ПАКЕТОМ: усі його чернетки за місяць → «подано». */
export const SUBMIT_SQL = `
  UPDATE repeat_client_plans SET status='pending', submitted_at = now(), updated_at = now(), updated_by = $3
   WHERE month = $1 AND manager_id = $2 AND status = 'draft'`;

/** Тімлід затверджує ВСІ подані у своїй зоні. `scopeCond` дописується викликачем. */
export const approveAllSql = (scopeCond: string): string => `
  UPDATE repeat_client_plans rp SET status='approved', approved_by = $2, approved_at = now(), updated_at = now()
    FROM managers m
   WHERE m.id = rp.manager_id AND rp.month = $1 AND rp.status = 'pending' ${scopeCond}`;

/** Повернення на доопрацювання — назад у чернетку, з обовʼязковим коментарем. */
export const RETURN_SQL = `
  UPDATE repeat_client_plans SET status='draft', returned_at = now(), review_note = $3,
         approved_by = NULL, approved_at = NULL, submitted_at = NULL, updated_at = now(), updated_by = $4
   WHERE client_key = $1 AND month = $2 AND status <> 'draft'`;
