import { pool } from "../db/pool.js";
import { kommoGet } from "../kommo/client.js";
import { kommoDealSource } from "../minusRegistry/kommoSource.js";
import { runMinusRegistrySync } from "../minusRegistry/sync.js";
import { createRunGuard } from "./runGuard.js";

/**
 * 📒 Звірка реєстру мінусових угод із Kommo — раз на 10 хв (ТЗ пакета §9; замість `setInterval` пакета).
 * Відкриті запити («На погодженні», «Повернуто», «Погоджено»), не звірені 5 хв: оновлює знімок (зʼявляється перевізник,
 * суми), а в «Погоджено» знімає погодження, якщо мінус у CRM зріс. Kommo — лише читання, через спільний тротл.
 * Охоронець не дає накластись; під наглядом `monitoredJobs.ts`, everyMin == крону в index.ts.
 */
const guard = createRunGuard("minusRegistrySync");
export function minusRegistrySync() {
  return guard(() => runMinusRegistrySync(pool, kommoDealSource(kommoGet)));
}
