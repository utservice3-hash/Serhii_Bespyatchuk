/**
 * РЕЖИМИ ОДНОГО НАБОРУ ТЕСТІВ. Точка входу одна — `npm test` (`node --test dist/`).
 * Різні перевірки вимагають різного оточення, і це вирішується РЕЖИМОМ, а не другим
 * паралельним механізмом: дві культури тестів через місяць розходяться, і в підсумку
 * ніхто не знає, що саме зелене.
 *
 *   npm test        — усе, що можна без зовнішніх залежностей + БД, якщо є DATABASE_URL
 *   npm run test:prod — додає перевірки проти ЖИВОГО API (приймання після деплою)
 *   npm run test:ai   — додає гейти, що звертаються до моделі (коштують грошей)
 *
 * Тест, якому оточення не вистачає, ПРОПУСКАЄТЬСЯ з видимою причиною, а не падає і не
 * робить вигляд, що пройшов. `node --test` показує skip окремо від pass — саме тому
 * тут `{ skip: "..." }`, а не мовчазний `return`.
 */

export const HAS_DB = Boolean(process.env.DATABASE_URL);
/** `prod` вмикає перевірки проти живого HTTP-API. */
export const SCOPE = process.env.TEST_SCOPE ?? "local";
export const IS_PROD_SCOPE = SCOPE === "prod";
/** Гейти з викликами моделі — платні, тому лише за явним прапорцем. */
export const AI_ENABLED = process.env.TEST_AI === "1";
export const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3000";

type Opts = { skip?: string };

/** Потрібна БД. */
export const needsDb = (): Opts =>
  HAS_DB ? {} : { skip: "потрібен DATABASE_URL (npm test без БД пропускає)" };

/** Потрібне живе API: `TEST_SCOPE=prod` + доступний API_BASE. */
export const needsApi = (): Opts =>
  IS_PROD_SCOPE
    ? (HAS_DB ? {} : { skip: "потрібен DATABASE_URL" })
    : { skip: "лише в режимі TEST_SCOPE=prod (npm run test:prod)" };

/**
 * Повний зліпок доступу (#11): 177 роутів × ролі ≈ 1024 проби, ~7-8 хв.
 * ⏱ Тому окремий режим: `npm test` і `npm run test:prod` його ПРОПУСКАЮТЬ,
 * `npm run test:matrix` — вмикає. Це не «зазвичай ганяємо шматок», а названий поділ:
 * швидкий набір на кожен деплой, повна матриця — перед злиттям у прод-гілку.
 */
export const MATRIX_ENABLED = process.env.TEST_MATRIX === "1";
export const needsMatrix = (): Opts =>
  MATRIX_ENABLED
    ? (IS_PROD_SCOPE && HAS_DB ? {} : { skip: "потрібні TEST_SCOPE=prod + DATABASE_URL" })
    : { skip: "повний зліпок доступу — окремий режим (npm run test:matrix)" };

/**
 * Живе API, але БЕЗ матричного режиму — для гейтів, що міряють ЧАС.
 *
 * 🔴 ЧОМУ ЦЕ НЕ ПОСЛАБЛЕННЯ. `#11` заливає сервер 1024 пробами; будь-який замір
 * часу, зроблений одночасно з цим, міряє ЗАЛИВКУ, а не ендпоінт. Заміряно того
 * самого дня на тому самому коді: чисто 2 432-3 355 мс, у `test:prod` 4 438 мс
 * (полагоджено «найкращим із трьох»), у `test:matrix` — 11 058 мс. Проти
 * останнього «найкращий із трьох» безсилий: повільні ВСІ три.
 *
 * Тому поділ дзеркальний до `#11`: матриця обовʼязкова в `test:matrix` і
 * пропускається в `test:prod`; часовий гейт — навпаки. Кожен режим має рівно ті
 * гейти, які в ньому здатні щось виміряти. Поріг не змінюється в жодному з них.
 *
 * ⚠️ Це НЕ «вимкнути незручний тест»: у `test:prod` він обовʼязковий, і саме
 * `test:prod` ганяється на КОЖЕН деплой.
 */
export const needsApiQuiet = (): Opts =>
  MATRIX_ENABLED
    ? { skip: "гейт ЧАСУ не можна міряти під заливкою #11 (1024 проби) — режим test:prod" }
    : needsApi();

/** Потрібні платні виклики моделі. */
export const needsAi = (): Opts =>
  AI_ENABLED
    ? (process.env.ANTHROPIC_API_KEY ? {} : { skip: "немає ANTHROPIC_API_KEY" })
    : { skip: "платний гейт — вмикається TEST_AI=1 (npm run test:ai)" };
