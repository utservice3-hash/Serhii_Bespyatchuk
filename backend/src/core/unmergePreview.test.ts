import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUnmergePreview, limitWarning, INHERITED_LIMIT_NOTE, REBUILD_MINUTES,
  type UnmergeInput, type LimitBefore,
} from "./unmergePreview.js";

/**
 * Гейти превʼю розʼєднання. Чотири РІЗНІ твердження:
 *   #265 — превʼю обіцяє те саме, що станеться (сума й склад сходяться);
 *   #266 — нотатки НЕ переносяться (рішення власника видиме у структурі);
 *   #267 — ліміти псевдонімів беруться з їхніх ВЛАСНИХ рядків, не з нуля;
 *   #268 — ліміт канонічного НІКОЛИ не мовчить, і «невідомо» несе причину.
 *
 * 🪤 Про саботаж: жоден із них не порівнює функцію саму із собою, тож ламати
 * треба ВХІД або саму властивість, а не спільне джерело обох сторін. Синфазний
 * саботаж тут неможливий за побудовою.
 */

const базовий = (): UnmergeInput => ({
  canonicalKey: "смартекс",
  sides: [
    { clientKey: "смартекс", name: "СМАР ТЕКС", amount: 1_000_000, invoices: 40, ownLimitDays: 0, ownLimitAmount: null, hiddenNotes: 0 },
    { clientKey: "курєрукраїни", name: "КУРЄР", amount: 900_000, invoices: 10, ownLimitDays: 0, ownLimitAmount: null, hiddenNotes: 1 },
    { clientKey: "тексгруп", name: "ТЕКС ГРУП", amount: 560_000, invoices: 8, ownLimitDays: 10, ownLimitAmount: 50_000, hiddenNotes: 2 },
  ],
  canonicalLimitNow: { days: 0, amount: null, note: "зведено при обʼєднанні" },
  limitBefore: { kind: "unknown", why: "історії лімітів у базі немає" },
  ownerlessNotes: [{ text: "Закрити 4 старі рахунки до пт.", dueDate: "2026-09-01", createdAt: "2026-08-31" }],
});

test("#265 ПРЕВʼЮ ОБІЦЯЄ ТЕ САМЕ, ЩО СТАНЕТЬСЯ", () => {
  const p = buildUnmergePreview(базовий());

  assert.equal(p.parties, 3, "🔴 сторін у превʼю не стільки, скільки учасників — людина побачить не той розпад");
  assert.equal(p.splitsInto.length, 3, "🔴 склад розпаду неповний");
  assert.equal(p.amount, 2_460_000,
    `🔴 сума в превʼю ${p.amount} ≠ сумі сторін. Людина ухвалює рішення за числом, `
    + "яке не збігається з тим, що станеться");
  assert.equal(p.invoices, 58, "🔴 рахунки в превʼю не сходяться зі сторонами");
  assert.deepEqual(p.splitsInto.map((s) => s.clientKey), ["смартекс", "курєрукраїни", "тексгруп"],
    "🔴 канонічний мусить стояти першим — інакше читач не бачить, хто був групою");
  assert.equal(p.notesBecomingVisible, 3, "🔴 не названо, скільки нотаток знову стануть видимими");
  assert.equal(p.rebuildMinutes, REBUILD_MINUTES,
    "🔴 превʼю не каже, що дебіторка перебудується не миттєво — людина вирішить, що дія не спрацювала");
});

test("#266 НОТАТКИ НЕ ПЕРЕНОСЯТЬСЯ — і це видно у СТРУКТУРІ, а не в наміреннях", () => {
  const p = buildUnmergePreview(базовий());

  // 🔴 Рішення власника: нотатки з псевдонімів НЕ переносимо на канонічний, бо
  // перенесені назад не розʼїхались би. Тут це не «ми так робимо», а
  // ВІДСУТНІСТЬ поля «куди перенести» — вигадати перенос нема куди.
  const j = JSON.stringify(p);
  assert.doesNotMatch(j, /moveTo|reassign|transferTo|перенест/i,
    "🔴 у превʼю зʼявилось поняття переносу нотаток — рішення власника прямо забороняє це");

  // Нотатка без власника лишається названою поіменно, а не зникає.
  assert.equal(p.ownerlessNotes.length, 1,
    "🔴 нотатку, поставлену на групу ПІСЛЯ злиття, не названо — саме вона лишається без власника");
  assert.equal(p.ownerlessNotes[0].dueDate, "2026-09-01",
    "🔴 у нотатки загубився дедлайн — людина не побачить, що саме висить");
  assert.match(p.ownerlessNotes[0].text, /Закрити/, "🔴 текст нотатки не показано");
});

test("#267 ЛІМІТИ ПСЕВДОНІМІВ — З ЇХНІХ ВЛАСНИХ РЯДКІВ, А НЕ З НУЛЯ", () => {
  const p = buildUnmergePreview(базовий());

  const текс = p.aliasLimitsRestored.find((x) => x.clientKey === "тексгруп");
  assert.ok(текс, "🔴 псевдонім із живим лімітом не потрапив у перелік відновлюваних");
  assert.equal(текс.days, 10,
    `🔴 відновлюваний ліміт ${текс.days} замість 10 — узято не з власного рядка псевдоніма. `
    + "Саме ці рядки злиття не видаляло, і вони єдине джерело");
  assert.equal(текс.amount, 50_000, "🔴 сума ліміту псевдоніма загублена");

  // Дзеркало: сторона БЕЗ власного ліміту не вигадує собі нуль.
  assert.ok(!p.aliasLimitsRestored.some((x) => x.clientKey === "курєрукраїни" && x.days === null),
    "🔴 сторону без ліміту подано як таку, що має ліміт null — це вигаданий запис");
  // І канонічний сюди не потрапляє — його ліміт окремий сюжет.
  assert.ok(!p.aliasLimitsRestored.some((x) => x.clientKey === "смартекс"),
    "🔴 канонічний потрапив у «відновлювані» — його ліміт саме той, що втрачено");
});

test("#268 ЛІМІТ КАНОНІЧНОГО НІКОЛИ НЕ МОВЧИТЬ — три стани, кожен називає себе", () => {
  // ① невідомо — мусить нести ПРИЧИНУ, а не порожнечу
  const p1 = buildUnmergePreview(базовий());
  assert.ok(p1.canonicalLimit.warning.length > 0,
    "🔴 попередження порожнє. Порожній рядок пройде повз читача — рівно так і зникає "
    + "єдина річ, яку розʼєднання втрачає назавжди");
  assert.match(p1.canonicalLimit.warning, /нема з чого|історії лімітів/,
    "🔴 стан «невідомо» не називає причини");

  // ② аркуш знає число — його ПОКАЗУЮТЬ, але не підставляють
  const sheet: LimitBefore = { kind: "sheet", days: 15 };
  const p2 = buildUnmergePreview({ ...базовий(), limitBefore: sheet });
  assert.match(p2.canonicalLimit.warning, /15 дн\./,
    "🔴 число з Лист20 не показано — людину лишили ні з чим там, де число є");
  assert.match(p2.canonicalLimit.warning, /ПЕРЕВІРТЕ/,
    "🔴 число з аркуша подано без вимоги перевірити — читач візьме його за факт бази");
  assert.match(p2.canonicalLimit.warning, /[Аа]втоматично.*не підставля/,
    "🔴 не сказано, що підстановки не буде — аркуш поза базою, і мовчазне взяття звідти "
    + "означало б вигадати запис");
  assert.equal(p2.canonicalLimit.now.days, 0,
    "🔴 поточне значення підмінено значенням з аркуша — це і є заборонена підстановка");

  // ③ знімок є (злиття після #262) — показуємо збережене
  const rec: LimitBefore = { kind: "recorded", days: 14, amount: null, setAt: "2026-08-25T05:38:00Z" };
  const p3 = buildUnmergePreview({ ...базовий(), limitBefore: rec });
  assert.match(p3.canonicalLimit.warning, /реєстрі: 14 дн\./,
    "🔴 збережений знімок не показано — тоді запис у реєстр був марним");

  // Жоден зі станів не дає порожнього рядка — перевіряємо ВСІ три, а не один.
  for (const b of [p1.canonicalLimit.before, sheet, rec])
    assert.ok(limitWarning(b, 0).trim().length > 10, `🔴 стан «${b.kind}» дав порожнє попередження`);

  assert.ok(INHERITED_LIMIT_NOTE.includes("перевірити"),
    "🔴 примітка про успадкований ліміт не просить перевірити — рішення власника ①");
});

test("#269 ПРЕВʼЮ ЗА ТИМ САМИМ ПРАВОМ, ЩО Й ДІЯ — не за власним правилом", async () => {
  const fs = await import("node:fs/promises");
  const url = await import("node:url");
  const src = await fs.readFile(
    url.fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)), "utf8");

  // 🔴 Межа зрізу СЕМАНТИЧНА — рівно тіло превʼю, від його оголошення до наступного роута.
  const from = src.indexOf('dashboardRouter.get("/receivables/unmerge-preview"');
  assert.ok(from > 0, "🔴 роут превʼю не знайдено — гейт втратив предмет");
  const to = src.indexOf("dashboardRouter.", from + 40);
  assert.ok(to > from, "🔴 не знайдено кінець роута — зріз розповзся");
  const block = src.slice(from, to);

  // Превʼю показує склад групи, суми й ТЕКСТИ нотаток. Якщо його межа відрізнятиметься
  // від межі самої дії, читання стане ширшим за запис — і саме в цей бік помиляються.
  assert.match(block, /revokeAllowed\(/,
    "🔴 превʼю гейтиться власним правилом, а не тим самим `revokeAllowed`, що й дія. "
    + "Реєстр спільний, а дверей двоє — одне правило на обидва боки ми вже ламали");
  assert.match(block, /mergeSourceOf\(/,
    "🔴 джерело злиття не розбирається — тоді право не залежить від того, ДЕ зливали");
  assert.match(block, /mergePairScope\(/,
    "🔴 скоуп пари не рахується — тімлід побачив би чужі команди");

  // Дзеркало: превʼю НЕ вигадує собі полегшеної перевірки «аби лише читання».
  assert.doesNotMatch(block.slice(0, block.indexOf("revokeAllowed")), /return res\.json/,
    "🔴 у превʼю є вихід із даними ДО перевірки права — гейт стоїть не першим");
});
