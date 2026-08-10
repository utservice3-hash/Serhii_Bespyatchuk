/**
 * ПРАВИЛО «ЗАСТРЯГЛОЇ УГОДИ» — ОДНЕ, у вигляді функції від операндів.
 *
 * 🔴 ЧОМУ ЦЕ ЗʼЯВИЛОСЬ. Критерій жив у ТРЬОХ місцях:
 *   1. `metrics.stuckDeals`        — легасі-роут `/stuck-deals` (534 угоди);
 *   2. `metrics.stuckDealsGrouped` — екран Звіту й AI-інструмент (147 угод);
 *   3. `jobs/syncDealActivity`     — ПРИХОВАНА копія предикату, що вирішує, яким
 *      угодам узагалі писати `last_call_at`.
 * Третя найнебезпечніша: вона не ламає екран, а тихо не записує дані — і про це
 * дізнаєшся не з червоного тесту, а через місяць із порожньої колонки.
 *
 * 🔴 РОЗБІЖНІСТЬ 1↔2 — СВІДОМА, І ТЕПЕР ВОНА ПАРАМЕТР, А НЕ КОПІЯ. У grouped є
 * фільтр типу команди (рішення власника 24.07: РНК — усі застряглі; не-РНК —
 * лише лідоген-угоди), у легасі його немає. Заміряно на базовій лінії
 * 5fd2bd8: grouped 147 ⊂ legacy 534, спільних рівно 147. Саме цю вкладеність
 * і стереже гейт — вона доводить, що форми не розʼїхались.
 *
 * ⚠️ Тут НЕМАЄ жодного імпорту — навмисно. `db/pool.js` → `config.js` кидає на
 * відсутньому `DATABASE_URL` ще НА ІМПОРТІ, і тест правила не встиг би навіть
 * початись. За сесію ця пастка спрацювала чотири рази (`monitoredJobs`,
 * `syncGuardRule`, `klassParity`, `backupRotateRule`), тож дані й рішення
 * відокремлені від зʼєднання завжди.
 */

/** «Авто працює» та сусідні операційні стадії — грошовий поріг, не «ранній». */
export const AVTO_STATUSES = [69716300, 98470988, 10937178];

/** Годинник застрягання: остання РЕАЛЬНА людська активність, інакше — створення. */
export const ACTIVITY_CLOCK = "COALESCE(d.last_activity_at, d.created_at_kommo)";

/**
 * 📞 РОЗМОВА ПОЧИНАЄТЬСЯ З 10 СЕКУНД (рішення власника 10.08.2026).
 *
 * Дзвінок на 0 секунд — це недодзвон або скидання; він не є контактом із клієнтом,
 * але СКИДАВ годинник застрягання, тобто ховав угоду зі списку. Заміряно на проді:
 * з 31 567 дзвінків у нотатках активних FC-угод **10 238 тривали 0 c**, і саме вони
 * ховали **83 угоди**; поріг 10 c додає ще 14 (разом 97).
 *
 * ⚠️ `null` (Kommo не віддав тривалість) ЗАРАХОВУЄМО. Замір показав покриття 100%,
 * тож практичного ефекту немає — але правило має відрізняти «розмови не було» від
 * «ми не знаємо», інакше прогалина в даних читалась би як недодзвон.
 */
export const CALL_MIN_SEC = 10;

export function callCountsAsActivity(durationSec: number | null | undefined): boolean {
  return durationSec == null || durationSec >= CALL_MIN_SEC;
}

/**
 * 🕰 «СТАНОМ НА» — НАЙСТАРІШИЙ ІЗ СИНКІВ, ЩО ЖИВЛЯТЬ ЦЕЙ ЕКРАН.
 *
 * 🔴 ЧОМУ НЕ `now()`. Під час аварії №2 (09-10.08.2026) синк стояв 15 год 13 хв, а
 * лічильник «днів без руху» ріс, бо рахувався від годинника, а не від даних. Тобто
 * екран упевнено повідомляв про застій, якого могло не бути — просто ми про рух не
 * знали. Симуляція на проді: за тієї аварії список роздувся б на **17 угод**.
 *
 * `MIN`, а не `MAX`: дані свіжі рівно настільки, наскільки свіжий НАЙВІДСТАЛІШИЙ із
 * потрібних джерел. `syncKommo` дає саму угоду й стадію, `syncDealActivity` — анкер
 * активності; відстав будь-хто — застаріло все.
 *
 * 🔒 `COALESCE(..., now())` і `LEAST(..., now())` — обидва обовʼязкові. Без першого
 * джоба, що ЖОДНОГО разу не відпрацювала, дала б `NULL`, а `NULL` у порівнянні
 * зробив би предикат `NULL` і список ПОРОЖНІМ — тобто «все добре» з тієї ж причини,
 * з якої «успіх за 0 мс» означав «нічого не виконалось». Без другого час у
 * майбутньому (перекошений годинник на сервері БД) дав би відʼємний вік.
 */
export const ASOF_JOBS = ["syncKommo", "syncDealActivity"];
export const ASOF_SQL =
  `LEAST(COALESCE((SELECT MIN(last_success_at) FROM job_runs`
  + ` WHERE name = ANY(ARRAY['${ASOF_JOBS.join("','")}'])), now()), now())`;

export interface StuckRuleOpts {
  /** Плейсхолдери параметрів у порядку, як їх поклав виклик. */
  pipelines: string;
  avtoStatuses: string;
  minDays: string;
  /** 🕰 Від чого відраховується вік. Дефолт — `now()`; екран передає `ASOF_SQL`. */
  asOf?: string;
  /**
   * ⏱ ГОДИННИК ЗАСТРЯГАННЯ. Дефолт — `ACTIVITY_CLOCK`. Екран передає його ж,
   * але з підмішаною розмовою з Ringostat (див. `ringostatTalkCte`): розмова, яку
   * Kommo не записала нотаткою, — це теж рух, і ховати її означало б слати
   * менеджера до клієнта, з яким він щойно говорив.
   */
  clock?: string;
}

/**
 * ЯДРО ПРЕДИКАТА — спільне для всіх трьох поверхонь.
 * `funnel_stage <> 'paid'` + FC-пайплайни + вікно створення 180 днів.
 */
export function stuckBaseConds(o: StuckRuleOpts): string[] {
  const asOf = o.asOf ?? "now()";
  const clock = o.clock ?? ACTIVITY_CLOCK;
  const avto = `d.status_id = ANY(${o.avtoStatuses})`;
  return [
    `d.pipeline_id = ANY(${o.pipelines})`,
    "psm.funnel_stage <> 'paid'",
    // Грошові стадії (Авто працює / рахунок після розвантаження) — `minDays`;
    // рання «Взято в роботу» — `minDays × 3`: вона природно «крутиться».
    `${asOf} - ${clock} >= (CASE WHEN (${avto} OR psm.funnel_stage = 'invoiced')`
      + ` THEN ${o.minDays} ELSE ${o.minDays} * 3 END || ' days')::interval`,
    `d.created_at_kommo >= ${asOf} - interval '180 days'`,
    // Ранню стадію рахуємо, лише якщо угоду ВЖЕ вели — інакше в списку опиниться
    // все щойно створене, і він перестане означати «застрягло».
    `(${avto} OR psm.funnel_stage = 'invoiced' OR d.last_activity_at IS NOT NULL)`,
  ];
}

/**
 * 🎧 РОЗМОВА З RINGOSTAT — ДРУГЕ ДЖЕРЕЛО КОНТАКТУ, І ВОНО БУВАЄ НЕОДНОЗНАЧНИМ.
 *
 * Kommo вішає телефонію на КОНТАКТ, і частина розмов до угоди не доїжджає взагалі.
 * Заміряно: у **647 із 2 304** активних FC-угод розмова в Ringostat свіжіша за
 * `deals.last_call_at` — саме звідси «99 днів» у колонці там, де людина говорила
 * 56 днів тому.
 *
 * 🔴 АЛЕ ПРИВʼЯЗКА НЕ ЗАВЖДИ ОДНОЗНАЧНА. Ringostat знає КЛІЄНТА (номер → `client_key`),
 * а не угоду. Якщо у клієнта одна відкрита угода — розмова її й стосується. Якщо
 * кілька — ми НЕ знаємо, про яку з них говорили, і зарахувати розмову всім означало б
 * погасити зі списку угоди, якими ніхто не займався.
 *
 * Тому рішення власника: гасить лише випадок «рівно одна відкрита угода»; решта
 * лишається в списку з позначкою «є розмова, угода не одна». Заміряно: гасить **38**,
 * позначку отримують **16**.
 *
 * CTE віддає два стовпці на клієнта: коли була остання РОЗМОВА і скільки в нього
 * відкритих FC-угод. Рахується один раз на весь запит, а не LATERAL-ом на рядок.
 */
export function ringostatTalkCte(o: { pipelines: string }): string {
  return `talk AS (
      SELECT c.client_key, MAX(c.calldate) AS talk_at
        FROM ringostat_calls c
       WHERE c.billsec > 0 AND c.client_key IS NOT NULL
       GROUP BY c.client_key
    ), open_cnt AS (
      SELECT d.client_key, count(*) AS n
        FROM deals d
        JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.client_key IS NOT NULL AND d.pipeline_id = ANY(${o.pipelines})
         AND psm.funnel_stage <> 'paid'
       GROUP BY d.client_key
    )`;
}

/** Розмова, яку МОЖНА зарахувати цій угоді (однозначна привʼязка). */
export const TALK_ATTRIBUTED = "(CASE WHEN oc.n = 1 THEN tk.talk_at END)";
/** Годинник із підмішаною однозначною розмовою. `GREATEST` ігнорує NULL. */
export const CLOCK_WITH_TALK = `GREATEST(${ACTIVITY_CLOCK}, ${TALK_ATTRIBUTED})`;
/** Остання розмова: Kommo-нотатка або Ringostat — що свіжіше (для колонки на екрані). */
export const LAST_TALK = `GREATEST(d.last_call_at, ${TALK_ATTRIBUTED})`;

/**
 * ПРЕДИКАТ «ЯКИМ УГОДАМ ПИСАТИ `last_call_at`» — та сама межа, що й у списку.
 *
 * 🔴 Це була третя, прихована копія (`syncDealActivity.ts`). Вона мусить збігатися
 * з тим, ДЕ показується колонка «остання розмова»: розійдуться — і колонка буде
 * порожня саме там, де потрібна, без жодного червоного тесту. Аліаси задає
 * викликач, бо в джобі таблиця зветься інакше.
 */
export function callTargetConds(o: { deal: string; psm: string; pipelines: string }): string[] {
  return [
    `${o.psm}.pipeline_id = ${o.deal}.pipeline_id`,
    `${o.psm}.status_id = ${o.deal}.status_id`,
    `${o.deal}.pipeline_id = ANY(${o.pipelines})`,
    `${o.psm}.funnel_stage <> 'paid'`,
  ];
}
