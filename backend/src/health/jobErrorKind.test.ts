import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyJobError, adviceForError, actionWithAdvice } from "./jobErrorKind.js";

/**
 * 🛑 #314/#314b — ПОРАДА ПІД ТРИВОГОЮ НЕ СТВЕРДЖУЄ ЧУЖОЇ ПРИЧИНИ.
 *
 * 📐 Привід заміряний 02.09.2026 на живому проді: `sync_state.consecutive_failures = 1`,
 * `job_runs.syncKommo.last_error = "timeout exceeded when trying to connect"` (стек
 * `pg-pool` → `provisionUsers` → `syncManagers`), а тривога радила «при 403/429 від
 * Kommo — знизити темп». До Kommo запит не дійшов узагалі.
 *
 * 🔴 ЧОМУ ГЕЙТ ДВОБІЧНИЙ. Односторонній («на таймауті пулу зʼявляється порада про
 * пул») зеленів би й тоді, коли ми навісили б УСІ поради на будь-яку помилку —
 * тобто на стані, де підпис знову нічого не розрізняє. Друга половина вимагає, щоб
 * порада НЕ зʼявлялась на чужому виді.
 *
 * ⚠️ Зразки помилок узяті з `job_runs` живого прода, а не придумані: саме на
 * вигаданій фікстурі такий гейт і буває беззубим.
 */

/** Живі рядки помилок, зняті з `job_runs` 02.09.2026. */
const REAL = {
  pool: "Error: timeout exceeded when trying to connect at /home/evraziat/uts.ua/dashboard/backend/node_modules/pg-pool/index.js:45:11",
  deadlock: "deadlock detected",
  terminated: "terminated",
  sheet502: "First-touch sheet fetch failed: 502",
  sheet400: "Leadgen registry sheet fetch failed: 400",
  data: 'date/time field value out of range: "2026-09-31"',
  kommo429: "Kommo API error 429: Too Many Requests",
  kommo403: "Request failed with status code 403",
} as const;

test("#314 вид помилки визначається з тексту, і кожен дістає СВОЮ пораду", () => {
  assert.equal(classifyJobError(REAL.pool), "pool");
  assert.equal(classifyJobError(REAL.deadlock), "cancelled");
  assert.equal(classifyJobError(REAL.terminated), "cancelled");
  assert.equal(classifyJobError(REAL.sheet502), "sheet");
  assert.equal(classifyJobError(REAL.sheet400), "sheet");
  assert.equal(classifyJobError(REAL.data), "data");
  assert.equal(classifyJobError(REAL.kommo429), "kommo_http");
  assert.equal(classifyJobError(REAL.kommo403), "kommo_http");
  assert.equal(classifyJobError(null), "none");
  assert.equal(classifyJobError("   "), "none");

  // Порада таки НАЗИВАЄ свій механізм, інакше вона не порада, а ввічливість.
  assert.match(adviceForError("pool"), /пул|зʼєднанн/i,
    "🔴 порада для таймауту пулу не згадує пул — читач знову піде крутити темп CRM");
  assert.match(adviceForError("kommo_http"), /403|429|темп/,
    "🔴 порада для відмови Kommo втратила згадку про темп — саме там вона доречна");
  assert.match(adviceForError("cancelled"), /deadlock|конкуренц/i);
  assert.match(adviceForError("sheet"), /аркуш|Sheets/i);
  assert.match(adviceForError("data"), /типи|обмеженн/i);

  // Помилки немає — приписки немає взагалі, база лишається як була.
  assert.equal(actionWithAdvice("Перевірити X.", null), "Перевірити X.",
    "🔴 без помилки додається порада — тривога почала стверджувати причину з нічого");
});

test("#314b 🪞 ДЗЕРКАЛО: чужа порада НЕ зʼявляється, а невпізнане не вигадує причини", () => {
  // 🔴 САМЕ ЦЕЙ ВИПАДОК І БУВ ДЕФЕКТОМ 02.09.2026.
  const onPool = actionWithAdvice("Подивитись лог процесу.", REAL.pool);
  assert.ok(!/403|429/.test(onPool),
    "🔴 на таймауті пулу знову радять темп Kommo — це та сама порада про чужу причину");
  assert.match(onPool, /НЕ від Kommo/,
    "🔴 порада не каже прямо, що Kommo ні до чого — а читач іде саме туди");

  // Дзеркало в інший бік: на справжній відмові Kommo порада про пул недоречна.
  const onKommo = actionWithAdvice("Подивитись лог процесу.", REAL.kommo429);
  assert.ok(!/пул/i.test(onKommo),
    "🔴 на відмові Kommo радять дивитись пул — підпис знову не розрізняє видів");
  assert.match(onKommo, /403|429/);

  // Аркуш містить КОД 502 у тексті — і не має читатись як відмова Kommo.
  assert.equal(classifyJobError(REAL.sheet502), "sheet",
    "🔴 «sheet fetch failed: 502» визнано відмовою Kommo — код у тексті ще не означає CRM");
  assert.ok(!/403|429|темп/.test(actionWithAdvice("Б.", REAL.sheet502)));

  // Невпізнаний вид мусить казати «не розпізнано», а не називати навмання.
  const unknown = actionWithAdvice("Б.", "щось геть нове й небачене");
  assert.equal(classifyJobError("щось геть нове й небачене"), "unknown");
  assert.match(unknown, /не розпізнано/,
    "🔴 невпізнана помилка дістала конкретну причину — це і є хвороба, яку лікуємо");
  assert.ok(!/403|429|пул|deadlock|Sheets/i.test(unknown),
    "🔴 невпізнаній помилці приписано механізм — вигадана причина гірша за чесне «не знаю»");

  // Усі ТРИ тривоги checkSync ходять через хелпер, а не тримають літерал.
  // (`alerts.ts` не імпортується: тягне db/pool → config, який кидає без DATABASE_URL.)
  const root = path.join(import.meta.dirname, "..", "..");
  let src = "";
  for (const r of [root, path.join(root, "..")]) {
    try { src = readFileSync(path.join(r, "src/health/alerts.ts"), "utf8"); break; } catch { /* далі */ }
  }
  assert.ok(src.length > 100, "🔴 джерело alerts.ts не прочиталось — гейт міряв би порожнечу");
  const calls = (src.match(/actionWithAdvice\(/g) ?? []).length;
  assert.equal(calls, 3,
    `🔴 через хелпер ходить ${calls} тривоги з трьох — клас полікували частково, а саме цього ми й уникали`);
  assert.ok(!/при 403\/429 від Kommo — знизити темп/.test(src),
    "🔴 безумовний літерал про 403/429 повернувся в alerts.ts");
});
