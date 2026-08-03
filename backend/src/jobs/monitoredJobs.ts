/**
 * Реєстр джоб під наглядом — ЧИСТІ ДАНІ, без жодного імпорту.
 *
 * ⚠️ Живе окремо від `jobRuns.ts` навмисно: той тягне `db/pool.js` → `config.js`,
 * який кидає на відсутньому DATABASE_URL ще НА ІМПОРТІ. Через це тест реєстру
 * не міг запуститись без БД, хоча перевіряє звичайний масив. Це вже третій випадок
 * тієї самої пастки — тому дані відокремлені від з'єднання.
 */
/**
 * ДЖОБИ ПІД НАГЛЯДОМ — лише ті, чия зупинка реально псує цифри або процеси.
 * `everyMin` = штатна частота з `index.ts`; тривога піднімається на 2× (той самий
 * поріг, що й для вотермарків: один пропущений тік — не подія, два — вже так).
 * Додав джобу в cron і хочеш, щоб її мовчання було видно → додай рядок сюди.
 */
export const MONITORED_JOBS: { name: string; everyMin: number; why: string }[] = [
  { name: "syncKommo", everyMin: 30, why: "основний синк угод — без нього дашборд замерзає" },
  { name: "syncStageEvents", everyMin: 30, why: "живить core/money.ts: гроші анкеряться на подіях стадій" },
  { name: "syncReceivables", everyMin: 15, why: "дебіторка з Google Sheet" },
  { name: "syncDealActivity", everyMin: 180, why: "живить «застряглі угоди»" },
  { name: "recomputeStatistics", everyMin: 60, why: "розділ «Статистики (відділи)»" },
  { name: "syncAdBudget", everyMin: 60, why: "рекламний бюджет → CPL/ROMI" },
  { name: "syncRingostatCalls", everyMin: 60, why: "дзвінки → «остання розмова»" },
  { name: "recomputeClientKeys", everyMin: 60, why: "канонічний client_key: мовчання = аліаси застосовані наполовину, клієнт знову розколотий" },
  { name: "freshnessWatch", everyMin: 60, why: "сторож вотермарків: якщо мовчить він, мовчить і решта нагляду" },
];
