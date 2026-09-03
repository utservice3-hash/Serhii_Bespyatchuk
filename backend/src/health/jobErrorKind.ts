/**
 * 🏷 ВИД ПОМИЛКИ → ЩО РОБИТИ. Порада виводиться з ТЕКСТУ помилки, а не прибита.
 *
 * 📐 ПРИВІД, ЗАМІРЯНИЙ 02.09.2026. Тривога «Синхронізація падає поспіль (1)»
 * радила: «при 403/429 від Kommo — знизити темп». Справжня помилка того падіння:
 * `timeout exceeded when trying to connect` у `pg-pool` — тобто запит **не дійшов
 * до Kommo взагалі**, він не зміг узяти зʼєднання з пулу Postgres. Порада називала
 * причину, якої не знала, і відправляла читача крутити темп CRM замість дивитись
 * на одночасність джоб. Це той самий клас, що «стан, який стверджує причину».
 *
 * 🔴 ЧОМУ ОКРЕМИЙ МОДУЛЬ, А НЕ ФУНКЦІЯ В `alerts.ts`. `alerts.ts` тягне
 * `db/pool.js` → `config.js`, який кидає без `DATABASE_URL` ще НА ІМПОРТІ, тож
 * гейт над ним може перевіряти лише ТЕКСТ джерела регуляркою. Тут імпортів немає
 * зовсім — отже гейт перевіряє ПОВЕДІНКУ: подає рядок помилки й читає пораду.
 *
 * ⚠️ МЕЖА, НАЗВАНА ВГОЛОС: невпізнаний вид дає `unknown`, і його порада НЕ називає
 * причини. Саме на цьому й горіла попередня редакція — вигадана причина гірша за
 * чесне «вид не розпізнано», бо її починають лікувати.
 */

export type JobErrorKind =
  | "none"       // помилки немає
  | "pool"       // не вдалось узяти зʼєднання з пулу Postgres
  | "kommo_http" // Kommo відмовив кодом (403/429/5xx)
  | "cancelled"  // запит перервано: deadlock, termination, statement timeout
  | "sheet"      // зовнішня таблиця (Google Sheets) не віддала дані
  | "data"       // дані не проходять типи/обмеження БД
  | "unknown";   // текст є, вид не розпізнано

/**
 * Зразки взяті з ЖИВОГО `job_runs` 02.09.2026, а не вигадані:
 *   pool      «timeout exceeded when trying to connect» (syncKommo)
 *   cancelled «deadlock detected» (syncCalls) · «terminated» (syncContactActivity)
 *   sheet     «First-touch sheet fetch failed: 502» · «Leadgen registry … 400»
 *   data      «date/time field value out of range: "2026-09-31"» (syncAdBudget)
 */
export function classifyJobError(err: string | null | undefined): JobErrorKind {
  if (!err || !err.trim()) return "none";
  const s = err.toLowerCase();

  // 🔴 ПУЛ ПЕРЕВІРЯЄТЬСЯ ПЕРШИМ. Його текст містить слово «connect», яке легко
  // сплутати з мережевою помилкою до CRM; ознака саме пулу — `pg-pool` у стеку
  // або дослівне «timeout exceeded when trying to connect».
  if (s.includes("timeout exceeded when trying to connect") || s.includes("pg-pool")) return "pool";

  // Аркуш перевіряється РАНІШЕ за http-код: «sheet fetch failed: 502» містить
  // код, але це не Kommo, і порада про темп CRM тут була б такою самою брехнею.
  if (s.includes("sheet")) return "sheet";

  if (/\b(403|429)\b/.test(s) || (s.includes("kommo") && /\b5\d\d\b/.test(s))) return "kommo_http";
  if (s.includes("deadlock") || s.includes("terminated") || s.includes("canceling statement")) return "cancelled";
  if (s.includes("out of range") || s.includes("invalid input syntax") || s.includes("violates")) return "data";

  return "unknown";
}

/**
 * Порада на кожен вид. Жодна з них не називає причини, якої вид не стверджує —
 * і саме це стереже дзеркальна половина гейта.
 */
export function adviceForError(kind: JobErrorKind): string {
  switch (kind) {
    case "none":
      return "";
    case "pool":
      return "Помилка НЕ від Kommo: запит не дійшов далі за взяття зʼєднання з пулу Postgres "
        + "(пул на процес, max 15, таймаут 10 с). Дивитись одночасність джоб і довгі запити, а не темп CRM.";
    case "kommo_http":
      return "Kommo відмовляє кодом (403/429) — знизити темп і перевірити, чи не забанений токен.";
    case "cancelled":
      return "Запит перервано конкуренцією за ті самі рядки (deadlock / termination) — "
        + "шукати, хто пише в ту саму таблицю одночасно.";
    case "sheet":
      return "Зовнішня таблиця (Google Sheets) не віддала дані — перевірити доступ до аркуша і код відповіді.";
    case "data":
      return "Дані не проходять типи чи обмеження БД — дивитись значення, назване в самій помилці.";
    case "unknown":
      return "Вид помилки не розпізнано — подивитись лог процесу; причину не вгадувати.";
  }
}

/**
 * Готовий текст поля `action` тривоги: власна дія перевірки + порада за видом.
 * Якщо помилки немає, лишається сама перевірка — приписки «causeless» не буде.
 */
export function actionWithAdvice(base: string, err: string | null | undefined): string {
  const advice = adviceForError(classifyJobError(err));
  return advice ? `${base} ${advice}` : base;
}
