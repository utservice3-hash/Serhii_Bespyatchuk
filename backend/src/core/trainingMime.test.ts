import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mimeFromName, effectiveMime } from "./trainingMime.js";

/**
 * 📄 ТИП ФАЙЛА НАВЧАННЯ (23.09.2026) — гейти `#713`, `#713b`.
 * Привід заміряний, а не уявний: 84 зі 143 перенесених документів лежать із порожнім `mime`,
 * і екран показував їх сірим рядком замість документа.
 */

/**
 * #713 — ВИВЕДЕННЯ ТИПУ ПО ОБИДВА БОКИ МЕЖІ. Фікстура з одного значення доводила б лише те,
 * що функція щось повертає (правило 11), тому тут і те, що МАЄ впізнатись, і те, що НЕ має.
 * 🧨 Червоніє, якщо прибрати виведення, почати вигадувати тип невідомому або дати
 * виведеному перемогти над збереженим.
 */
test("#713 ТИП ФАЙЛА: відоме розширення → тип, невідоме → null, збережений виграє в виведеного", () => {
  // ✅ бік «впізнаємо» — рівно ті формати, що реально лежать у теці навчання
  assert.equal(mimeFromName("WELCOME TO UTS готовий, л+к (1).pdf"), "application/pdf");
  assert.equal(mimeFromName("ЗВІТ.PDF"), "application/pdf", "🔴 регістр розширення не має значення");
  assert.equal(mimeFromName("інструкція.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(mimeFromName("ролик.mp4"), "video/mp4");
  assert.equal(mimeFromName("фото.jpeg"), "image/jpeg");

  // ❌ бік «не впізнаємо» — невідоме лишається невідомим, а не стає octet-stream
  assert.equal(mimeFromName("запуск.exe"), null, "🔴 невідоме розширення отримало тип");
  assert.equal(mimeFromName("іконка.svg"), null, "🔴 svg віддається inline і виконав би скрипт — типу не даємо");
  assert.equal(mimeFromName("безрозширення"), null);
  assert.equal(mimeFromName("крапка.в.кінці."), null);
  assert.equal(mimeFromName(null), null);
  assert.equal(mimeFromName("звіт.pdf.zip"), null, "🔴 береться ОСТАННЄ розширення, інакше zip прикинеться pdf");

  // 🔴 Збережений заголовок — твердження клієнта, розширення — здогад. Здогад не перекриває твердження.
  assert.equal(effectiveMime("text/csv", "a.pdf", "a.pdf"), "text/csv", "🔴 виведений тип перекрив збережений");
  assert.equal(effectiveMime(null, "x_att_y.pdf", "назва без розширення"), "application/pdf");
  assert.equal(effectiveMime("   ", null, "інструкція.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "🔴 порожній рядок мав читатись як «немає»");
  assert.equal(effectiveMime(null, "дані.bin", "дані.bin"), null);
});

/**
 * #713b — ЖОДЕН РОУТ НАВЧАННЯ НЕ ВІДДАЄ СИРИЙ `mime`. Правило має жити в одній копії: щойно
 * якийсь читач візьме колонку напряму, 84 документи знову стануть невидимими САМЕ в ньому —
 * тихо, бо решта екранів працюватиме. Межа змістова (правило 9): предмет — віддача типу, а не
 * рядок на певній позиції.
 * 🧨 Червоніє, якщо повернути `mime: m.mime` / `res.type(m.mime)` або прибрати виведення при
 * завантаженні файла, якому браузер типу не назвав.
 */
test("#713b РОУТИ НАВЧАННЯ: тип файла — лише через ядро, у жодному місці не сирою колонкою", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/routes/training.ts", import.meta.url)), "utf8");

  assert.ok(!/\bmime:\s*m\.mime\b/.test(src), "🔴 відповідь віддає сиру колонку `mime` повз ядро");
  assert.ok(!/res\.type\(m\.mime\)/.test(src), "🔴 стрім файла ставить сирий тип повз ядро");

  // Усі три читачі — список бібліотеки, стрім файла, крок курсу — беруть тип з ядра.
  assert.ok(src.includes('import { effectiveMime, mimeFromName } from "../core/trainingMime.js";'), "🔴 ядро типів більше не імпортується");
  // 🔴 Кожен читач названо ПОІМЕННО, а не порахований числом: число почервоніло б від появи
  // четвертого читача без жодного дефекту (правило 14 — гейт, що падає не з нашої вини, починають гортати).
  assert.match(src, /mime: effectiveMime\(m\.mime, m\.stored_name, m\.title\)/, "🔴 список бібліотеки (/tree) віддає тип повз ядро");
  assert.match(src, /const type = effectiveMime\(m\.mime, m\.stored_name, m\.title\);\s*\n\s*if \(type\) res\.type\(type\);/, "🔴 стрім файла ставить тип повз ядро");
  assert.match(src, /mime: effectiveMime\(m\.mime, m\.stored_name, m\.title\),/, "🔴 крок курсу (/material/:id) віддає тип повз ядро");

  /* Завантаження: браузер типу не назвав → виводимо з імені, а не зберігаємо порожнечу далі.
     🔴 Твердження ПРО ПРЕДМЕТ, а не про рядок: перша редакція звіряла точний вираз присвоєння і
     почервоніла від власного рефакторингу (виклик переїхав усередину `checkUpload`) — класичний
     проксі, що падає від перестановки й мовчить від дефекту (правило 10). */
  assert.match(src, /checkUpload\(b\.mime \? String\(b\.mime\) : mimeFromName\(display\)/,
    "🔴 тип нового файла більше не виводиться з імені — дефект відтвориться на нових даних");
  assert.match(src, /\bmime = verdict\.mime\b/,
    "🔴 у БД лягає не той тип, який визнало ядро");

  // 🔴 `/tree` не виведе тип, якщо перестане брати імʼя файла з БД. Межа ЗМІСТОВА — тіло саме
  // цього роута, від його оголошення до його ж відповіді, а не «N символів поруч»: межа за
  // довжиною рухається від чужого коментаря і червоніє на робочому коді (правило 9).
  const treeFrom = src.indexOf('trainingRouter.get("/tree"');
  const treeTo = src.indexOf("res.json({ folders", treeFrom);
  assert.ok(treeFrom >= 0 && treeTo > treeFrom, "🔴 роут /tree не знайдено — гейт не має що перевіряти (порожньо ≠ зелено)");
  assert.match(src.slice(treeFrom, treeTo), /\bm\.stored_name\b/, "🔴 список бібліотеки більше не читає stored_name — виводити тип нема з чого");
});
