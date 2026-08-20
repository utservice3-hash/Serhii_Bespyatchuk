import { config } from "../config.js";

/**
 * 🔗 ПОСИЛАННЯ НА КАРТКУ УГОДИ В KOMMO — ОДНЕ МІСЦЕ, ДЕ ЖИВЕ ЙОГО ФОРМА.
 *
 * Піддомен береться з `KOMMO_BASE_URL` (той самий, яким ходить API-клієнт:
 * `kommo/client.ts` додає до нього `/api/v4/...`), а не зашивається рядком.
 * 🔴 Причина не косметична: у фронті вже лежить зашитий
 * `const KOMMO_BASE = "https://uts.kommo.com/leads/detail/"`
 * (`DataQualitySection.tsx`) — тобто значення продубльоване там, де треба було
 * фіксувати СПОСІБ його дізнатись. Переїде акаунт — зламається саме та копія, про
 * яку ніхто не згадає. Нові вжитки беруть URL із сервера й нічого не знають про
 * піддомен.
 *
 * Форма шляху перевірена по вже наявних вжитках: `syncReceivables` і три роути
 * дашборду будують рівно `<base>/leads/detail/<kommo_id>`.
 */
export const kommoLeadUrl = (kommoId: number): string =>
  `${config.kommo.baseUrl.replace(/\/$/, "")}/leads/detail/${kommoId}`;
