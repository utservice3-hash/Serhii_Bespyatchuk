import { test } from "node:test";
import assert from "node:assert/strict";
import { orderedMaterials, materialStates, coursePercent, type FolderRow, type MaterialRow } from "./trainingProgress.js";

/**
 * 🎓 #416–#419 — ПОРЯДОК, ЗАМКИ Й ВІДСОТОК НАВЧАННЯ (крок 2 ТЗ, 15.09.2026).
 *
 * 🔴 ЧОМУ ГЕЙТИ ЧИСТІ. Правило не потребує ані БД, ані мережі — отже воно мусить
 * перевірятись у звичайному `npm test`, а не лише в прийманні. Гейт, що скіпається в
 * кожному доступному оточенні, є наміром, а не гейтом.
 *
 * 🧩 ФІКСТУРА — ДВОРІВНЕВА НАВМИСНО. На проді заміряно 16 папок, із них 4 ВКЛАДЕНІ, тож
 * плоска фікстура доводила б лише те, чого в даних немає. Модуль тут: дві власні картки
 * + вкладена група з двома.
 */

/** Модуль 10 (коренева), усередині — вкладена група 11. Друга коренева 20 — сусідній модуль. */
const FOLDERS: FolderRow[] = [
  { id: 10, parentId: null, position: 0 },
  { id: 11, parentId: 10, position: 0 },
  { id: 20, parentId: null, position: 1 },
];

const MATS: MaterialRow[] = [
  { id: 101, folderId: 10, position: 0, required: true },
  { id: 102, folderId: 10, position: 1, required: true },
  { id: 111, folderId: 11, position: 0, required: true },
  { id: 112, folderId: 11, position: 1, required: false }, // необовʼязковий — поза 100%
  { id: 201, folderId: 20, position: 0, required: true },  // чужий модуль, сюди не потрапляє
];

const ids = (xs: readonly { id: number }[]) => xs.map((x) => x.id);

test("#416 ПОРЯДОК МОДУЛЯ: свої картки, потім вкладені групи — і чужий модуль не затесався", () => {
  assert.deepEqual(ids(orderedMaterials(10, FOLDERS, MATS)), [101, 102, 111, 112],
    "🔴 порядок обходу модуля змінився: очікується власні картки кореневої папки, далі вкладені групи");

  // 🪞 ДЗЕРКАЛО: сусідній модуль віддає СВОЄ. Без цієї половини гейт зеленів би й на
  // функції, яка завжди повертає матеріали модуля 10.
  assert.deepEqual(ids(orderedMaterials(20, FOLDERS, MATS)), [201],
    "🔴 сусідній модуль віддав не свій склад — межа модуля протікає");
});

test("#417 РІВНИЙ position НЕ РОБИТЬ ПОРЯДОК ВИПАДКОВИМ — тай-брейк по id", () => {
  /* 🔴 Це не гіпотетика: у базі НЕМАЄ `UNIQUE (folder_id, position)`, а `PATCH /material/:id`
     дозволяє виставити довільний номер без перетасовки сусідів. Два матеріали з однаковим
     `position` — законний стан, і саме на ньому замок міг би «то стояти, то ні». */
  const tie: MaterialRow[] = [
    { id: 302, folderId: 10, position: 5, required: true },
    { id: 301, folderId: 10, position: 5, required: true },
  ];
  assert.deepEqual(ids(orderedMaterials(10, [FOLDERS[0]], tie)), [301, 302],
    "🔴 при однаковому position порядок перестав бути визначеним — замок почне плавати між запитами");

  // І порядок НЕ залежить від того, як рядки прийшли з БД: та сама відповідь на зворотному вході.
  assert.deepEqual(ids(orderedMaterials(10, [FOLDERS[0]], [...tie].reverse())), [301, 302],
    "🔴 порядок залежить від порядку рядків у відповіді БД — це і є плаваючий замок");
});

test("#418 ЗАМОК: перший незроблений обовʼязковий закриває все за собою, і каже — ХТО саме", () => {
  const ord = orderedMaterials(10, FOLDERS, MATS);

  const clean = materialStates(ord, new Map());
  assert.deepEqual(clean.map((s) => s.state), ["available", "locked", "locked", "locked"],
    "🔴 порядок відкриття зламався: доступним має бути рівно перший");
  assert.deepEqual(clean[1].blockedBy, { materialId: 101 },
    "🔴 замок не називає, ХТО його тримає — людина побачить «закрито» без причини");

  // 🪞 ДЗЕРКАЛО: після done першого відкривається другий — інакше гейт зеленів би й на
  // правилі «закрито завжди», яке зламало б курс повністю.
  const after = materialStates(ord, new Map([[101, "done" as const]]));
  assert.deepEqual(after.map((s) => s.state), ["done", "available", "locked", "locked"]);

  // Закриті ВІДДАЮТЬСЯ у списку, а не зникають: склад незмінний при будь-якому прогресі.
  assert.equal(clean.length, ord.length, "🔴 закриті матеріали зникли зі списку замість бути показаними");

  /* ⚠️ НЕОБОВʼЯЗКОВИЙ НЕ ТРИМАЄ ЗАМОК. 112 не входить у 100%, тож і блокувати нікого не
     може — інакше курс було б неможливо закінчити, не зробивши те, що ми самі назвали
     необовʼязковим. Тут це видно так: після done трьох обовʼязкових замків не лишилось. */
  const all3 = materialStates(ord, new Map([[101, "done"], [102, "done"], [111, "done"]] as const));
  assert.equal(all3.filter((s) => s.state === "locked").length, 0,
    "🔴 необовʼязковий матеріал тримає замок — курс став непрохідним");
});

test("#419 ВІДСОТОК: знаменник — лише обовʼязкові, порожній курс це 0, а не 100", () => {
  const ord = orderedMaterials(10, FOLDERS, MATS);
  assert.equal(coursePercent(ord, new Map()), 0);
  assert.equal(coursePercent(ord, new Map([[101, "done" as const]])), 33,
    "🔴 знаменник не дорівнює кількості обовʼязкових (тут 3): 1 із 3 = 33%");
  assert.equal(coursePercent(ord, new Map([[101, "done"], [102, "done"], [111, "done"]] as const)), 100,
    "🔴 усі обовʼязкові зроблено, а 100% немає — необовʼязковий потрапив у знаменник");

  // 🪞 І необовʼязковий не піднімає відсоток теж — інакше 100% можна було б добрати,
  // не зробивши обовʼязкового.
  assert.equal(coursePercent(ord, new Map([[112, "done" as const]])), 0,
    "🔴 необовʼязковий матеріал зарахувався у прогрес");

  assert.equal(coursePercent([], new Map()), 0,
    "🔴 порожній курс віддав не нуль — «нічого робити не треба» стало б «усе зроблено», і "
    + "курс зарахувався б там, де матеріалів ще не завели");
});
