import { Pool } from "pg";
import { config } from "../config.js";

/**
 * 🔴 Обмеження пулу (2 ГБ shared-акаунт adm.tools, crash-loop 15.07.2026): дефолт pg =
 * 10 конекшенів/процес. Під час crash-loop кожен убитий (SIGKILL) процес НЕ кликав
 * `pool.end()` → відкриті конекшени до Neon накопичувались і компаундили тиск на
 * памʼять/квоту. Тримаємо мінімум конекшенів і швидко відпускаємо idle. Ліміт конекту
 * 10с — щоб буут не завис на Neon, а впав швидко й чисто (Supervisor підніме).
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 6,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
