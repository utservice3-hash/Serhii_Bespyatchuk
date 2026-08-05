import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #42 — «ЗІБРАНО, АЛЕ НЕ ПЕРЕЗАПУЩЕНО» ВИДНО В HEALTH.
 *
 * 🔴 ПРИВІД, І ВІН НЕ ТОЙ, ЩО ЗДАВАВСЯ. 05.08.2026 банер показав «рантайм 7e1c0b9,
 * копія d91c342» — 49 хвилин прод крутив попередню збірку. Перша гіпотеза була
 * «панель підняла процес зі старої збірки», і вона НЕ підтвердилась: ланцюг
 * запуску (`lve_suwrapper → bash → npm start → node dist/index.js` у живому
 * checkout) артефакт не пришпилює, systemd/PM2/cron немає — панель ЗАВЖДИ підніме
 * той `dist`, що на диску. Справжня причина простіша: я зібрав нову версію на
 * сервері й не рестартував, бо коміт чіпав лише фонову джобу.
 *
 * 🪞 ЧОМУ ЦЕ ГІРШЕ ЗА ПАДІННЯ. Стан «зібрано, не перезапущено» ззовні виглядає
 * ідеально: health 200, версія «якась» є, сайт працює. Він не лікується сам і не
 * має жодного симптому — рівно як 11-годинний випадок зі старим PID, заради якого
 * і заводили ТЕСТ #1. Різниця лише в тому, що тоді розбіжність було видно ззовні,
 * а тут — ні, бо ми звіряли версію health із git HEAD ПІСЛЯ рестарту, а не між
 * рестартами.
 */

// version.json лежить ПОРУЧ зі зібраним тестом (обидва в `dist/`), а не рівнем вище.
const VERSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "version.json");

test("#42 HEALTH ПОРІВНЮЄ ЗАВАНТАЖЕНУ ЗБІРКУ З ТІЄЮ, ЩО НА ДИСКУ", async () => {
  const v = await import("./version.js");
  if (!fs.existsSync(VERSION_FILE)) {
    // Не «пропускаємо тихо»: кажемо, чого бракує. Без version.json перевіряти нічого.
    assert.fail("🔴 немає dist/version.json — зберіть проєкт (npm run build) перед прогоном");
  }
  const original = fs.readFileSync(VERSION_FILE, "utf8");
  try {
    // ── 1 · У НОРМІ розбіжності немає
    assert.equal(v.buildIsStale(), false,
      "🔴 щойно зібраний проєкт вважається застарілим — порівняння зламане, "
      + "і тоді прапорець кричав би завжди (а на «завжди червоне» перестають дивитись)");
    assert.equal(v.onDiskVersion().sha, v.buildVersion().sha,
      "🔴 версія з диска не збіглася із завантаженою одразу після збірки");

    // ── 2 · 🔴 САБОТАЖ: підміняємо файл на диску, НЕ перезапускаючи процес — це і є
    // відтворення інциденту. Кеш у `buildVersion()` лишається старим (так і має
    // бути: процес читає його раз), а `onDiskVersion()` мусить побачити нове.
    const fake = JSON.parse(original);
    fake.sha = "0000000deadbeef0000000deadbeef0000000000";
    fs.writeFileSync(VERSION_FILE, JSON.stringify(fake));
    assert.equal(v.onDiskVersion().shortSha, "0000000",
      "🔴 читання з диска закешоване — саме через кеш ми б і не побачили підміну");
    assert.equal(v.buildIsStale(), true,
      "🔴 прапорець МОВЧИТЬ, коли на диску інша збірка — це рівно той стан, "
      + "у якому прод 49 хвилин крутив попередній код при здоровому health");
    // Завантажена версія при цьому НЕ мусить змінитись — інакше ми б порівнювали
    // диск сам із собою, і перевірка була б циклічною.
    assert.notEqual(v.buildVersion().sha, fake.sha,
      "🔴 buildVersion() перечитався з диска — тоді порівняння завжди рівне, "
      + "тобто перевірка порівнює B із B");

    // ── 3 · 🪞 ДЗЕРКАЛО: повертаємо файл — прапорець гасне. Без цього пункт 2
    // зеленів би й тоді, якби `buildIsStale()` повертав `true` ЗАВЖДИ.
    fs.writeFileSync(VERSION_FILE, original);
    assert.equal(v.buildIsStale(), false,
      "🔴 після повернення файлу прапорець не згас — він не порівнює, а просто кричить");
  } finally {
    fs.writeFileSync(VERSION_FILE, original);
  }
});

test("#42b НЕВІДОМА ВЕРСІЯ НЕ ВВАЖАЄТЬСЯ РОЗБІЖНІСТЮ", async () => {
  // Дев через `tsx` version.json не має. Кричати там означало б привчити ігнорувати
  // прапорець — а він потрібен рівно для одного, дуже рідкісного стану.
  const v = await import("./version.js");
  const original = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, "utf8") : null;
  try {
    if (original) fs.rmSync(VERSION_FILE);
    assert.equal(v.buildIsStale(), false,
      "🔴 без version.json прапорець кричить — у деві він був би вічно червоним");
  } finally {
    if (original) fs.writeFileSync(VERSION_FILE, original);
  }
});
