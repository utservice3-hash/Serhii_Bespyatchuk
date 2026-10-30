/**
 * 🧾 «ТЕСТ ЗАКАЗ 1С» — налаштування модуля (26.10.2026). Заміна віджета Genesis «Заказ 1С»: вікно рахунку малює
 * віджет у картці угоди Kommo, а цей модуль — сервер: 1С (`POST /createInvoice`, `invoicePdf`) і запис PDF у Kommo.
 *
 * Усе читається з env ЛІНИВО і без `config.js` — той кидає без `DATABASE_URL` ще на імпорті, а гейти ганяють чисті
 * функції модуля без бази (той самий прийом, що `constructor/onec.ts`).
 *
 * Перемикач `ZAKAZ1C_MODE`:
 *   off  (типово) — маршрути відповідають 503, у 1С і Kommo не йде нічого;
 *   test — рахунок дозволено ЛИШЕ на тестового контрагента 1С (`ZAKAZ1C_TEST_EDRPOU`, типово 00100110) і лише
 *          тестувальникам із `ZAKAZ1C_TESTERS` (порожньо — будь-кому). Рахунок усе одно СПРАВЖНІЙ документ у робочій базі 1С;
 *   live — будь-який контрагент, будь-хто з доступом до угоди в Kommo. Вмикає лише власник.
 */

export type Zakaz1cMode = "off" | "test" | "live";

/** Акаунт Kommo UTS (`utsercice`). Токен з іншого акаунта не приймаємо, навіть із правильним підписом. */
export const UTS_KOMMO_ACCOUNT_ID = 10847791;

/** Тестовий контрагент 1С — той самий, на якому Андрій створював рахунки для CRM (000006943). */
export const DEFAULT_TEST_EDRPOU = "00100110";

export const ONEC_SERVICE_BASE = "http://193.200.173.188:8010/rest-bk/hs/service";

const str = (v: string | undefined) => (v ?? "").trim();

export function zakaz1cMode(env: NodeJS.ProcessEnv = process.env): Zakaz1cMode {
  const m = str(env.ZAKAZ1C_MODE).toLowerCase();
  return m === "test" || m === "live" ? m : "off";
}

/**
 * Запис оплат у поля й етап, які зараз веде Genesis («Оплачено 1с», «Оплачено из 1с», етап «Оплата отримана»):
 *   `off` (типово) — лише рахуємо й пишемо в журнал «що записали б»;
 *   `own` — пишемо ЛИШЕ в угоди, які веде віджет («одна угода — одна система», Роман 28.10.2026): там Genesis не пише,
 *           бо рахунків віджета немає в його регістрі. Угоди Genesis не чіпаємо;
 *   `live` — пишемо в усі угоди з оплатами; лише коли Genesis вимкнено.
 * `own` вмикаємо, коли 1С підтвердить, що оплати угоди (`paydata`) знаходяться за `idAMO`.
 */
export type Zakaz1cFieldsMode = "off" | "own" | "live";
export function zakaz1cFieldsMode(env: NodeJS.ProcessEnv = process.env): Zakaz1cFieldsMode {
  const m = str(env.ZAKAZ1C_FIELDS_MODE).toLowerCase();
  return m === "live" || m === "own" ? m : "off";
}

/** Kommo user id тестувальників (через кому). У режимі test — єдині, кому відкрито створення рахунку. */
export function zakaz1cTesters(env: NodeJS.ProcessEnv = process.env): Set<number> {
  return new Set(str(env.ZAKAZ1C_TESTERS).split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0));
}

export interface Zakaz1cKommoAuthEnv {
  /** Секретний ключ приватної інтеграції «ТЕСТ ЗАКАЗ 1С»: ним Kommo підписує токен `$authorizedAjax` (HS256). */
  secret: string;
  /** client_uuid (ID) тієї ж інтеграції: токен іншої інтеграції того самого акаунта не приймаємо. */
  clientUuid: string;
  accountId: number;
}

export function zakaz1cKommoAuthEnv(env: NodeJS.ProcessEnv = process.env): Zakaz1cKommoAuthEnv {
  return {
    secret: str(env.ZAKAZ1C_KOMMO_SECRET),
    clientUuid: str(env.ZAKAZ1C_KOMMO_CLIENT_UUID),
    accountId: Number(str(env.ZAKAZ1C_KOMMO_ACCOUNT_ID)) || UTS_KOMMO_ACCOUNT_ID,
  };
}

export const zakaz1cTestEdrpou = (env: NodeJS.ProcessEnv = process.env) => str(env.ZAKAZ1C_TEST_EDRPOU) || DEFAULT_TEST_EDRPOU;
export const onecServiceBase = (env: NodeJS.ProcessEnv = process.env) => (str(env.ONEC_SERVICE_BASE) || ONEC_SERVICE_BASE).replace(/\/+$/, "");

/**
 * Довгостроковий токен ТІЄЇ Ж інтеграції (з правом «Доступ до файлів»): лише для запису PDF у файли угоди й примітки.
 * Основний `KOMMO_API_TOKEN` дашборда модуль не чіпає — у нього інший набір прав і свій ліміт запитів.
 */
export const zakaz1cKommoToken = (env: NodeJS.ProcessEnv = process.env) => str(env.ZAKAZ1C_KOMMO_TOKEN);
export const zakaz1cKommoBase = (env: NodeJS.ProcessEnv = process.env) =>
  (str(env.ZAKAZ1C_KOMMO_BASE_URL) || str(env.KOMMO_BASE_URL) || "https://utsercice.kommo.com").replace(/\/+$/, "");
