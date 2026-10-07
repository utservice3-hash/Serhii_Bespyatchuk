/**
 * 🔑 КЛЮЧ БАНКУ ЗА НАЗВОЮ ЗМІННОЇ (Роман 07.10.2026: «додавати будь-яку карту без програміста, токен — у .env»).
 *
 * Дві речі, і обидві — про те, ЩО сервер погодиться назвати «токеном банку»:
 *  1. **Лише свої назви.** `bank_accounts.env_key_name` пише людина в «Налаштуваннях виписки». Раніше будь-яка назва
 *     йшла в `process.env[...]`, і запис `KOMMO_API_TOKEN` чи `JWT_SECRET` змусив би сервер САМОМУ відправити цей
 *     секрет у monobank / Приват як заголовок `X-Token`. Тепер ключем банку може бути лише `MONO_TOKEN_…` або
 *     `PRIVAT_TOKEN_…` (з Приватом — і його `…_ID`). Решта — «ключа немає», без винятків.
 *  2. **Без рестарту.** `.env` читається процесом один раз на старті, тож новий токен був невидимий до перезапуску —
 *     а перезапуск робить людина з доступом до сервера. Тепер файл перечитується, коли змінилась його дата, але з нього
 *     беруться ЛИШЕ банківські назви. Значення з файлу головніше за `process.env`: заміна токена в файлі діє одразу.
 *
 * Значення ключа нікуди не повертається, крім адаптера банку: роут знає лише «є / немає».
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

/** Назва змінної ключа для банку: префікс свого банку + ВЕЛИКІ латинські, цифри, `_`. */
export const TOKEN_NAME: Record<"mono" | "privat", RegExp> = {
  mono: /^MONO_TOKEN_[A-Z0-9_]{1,40}$/,
  privat: /^PRIVAT_TOKEN_[A-Z0-9_]{1,40}$/,
};

/** Чи може ця назва бути ключем банку взагалі (будь-якого з двох). */
export function isBankTokenName(name: unknown): name is string {
  return typeof name === "string" && (TOKEN_NAME.mono.test(name) || TOKEN_NAME.privat.test(name));
}

const DEFAULT_ENV = path.join(import.meta.dirname, "..", "..", ".env");
let cache: { file: string; mtimeMs: number; vals: Record<string, string> } | null = null;

function fileVals(file: string): Record<string, string> {
  let mtimeMs: number;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return {}; }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.vals;
  let all: Record<string, string> = {};
  try { all = parse(readFileSync(file)); } catch { all = {}; }
  // З файлу лишаємо ЛИШЕ банківські назви — решта секретів у памʼять цього модуля не потрапляє.
  const vals: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (isBankTokenName(k) && v) vals[k] = v;
  cache = { file, mtimeMs, vals };
  return vals;
}

/** Ключ банку за назвою змінної: свіжий `.env` → `process.env`. Не банківська назва → undefined, завжди. */
export function tokenFor(name: string | null | undefined, envFile: string = DEFAULT_ENV): string | undefined {
  if (!isBankTokenName(name)) return undefined;
  return fileVals(envFile)[name] || process.env[name] || undefined;
}
