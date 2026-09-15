import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCESS_MATRIX } from "./accessMatrix.js";
import { PERMISSION_CATALOG } from "./permGrant.js";
import { ROLE_DECLARATIONS } from "../db/roleDeclarations.js";
import { tabsForPath } from "./routeTab.js";

/**
 * 🎓 #410–#412 — КРОК 1 ТЗ «НАВЧАННЯ»: РОЛЬ «КАНДИДАТ» І ПРАВО `manage_training`.
 *
 * 🔴 ЧОМУ ГЕЙТИ ЧИСТІ, А НЕ ЖИВІ. ТЗ пропонувало перевіряти це пробами по HTTP під
 * кандидатом. Такий гейт скіпався б у `npm test` і виконувався лише в прийманні — тобто
 * саме там, де про нього дізнаєшся ПІСЛЯ викату. Усі три твердження нижче можна довести
 * без мережі: джерела (`ROLE_DECLARATIONS`, `PERMISSION_CATALOG`, `ACCESS_MATRIX`,
 * `schema.sql`, `routeTab`) лежать у репозиторії. Жива проба лишається в прийманні як
 * підтвердження, а не як єдиний доказ.
 *
 * ⚠️ Це не робить живу пробу зайвою — і причина названа в `#412`.
 */

const SCHEMA = readFileSync(fileURLToPath(new URL("../db/schema.sql", import.meta.url)), "utf8");
/** Роль, якій власник видав право 14.09.2026 — дослівно: «admin, ceo, opdir, kvp». */
const GRANTED = ["admin", "ceo", "opdir", "kvp"];

test("#410 КАНДИДАТ: єдиний екран — навчання, і роль оголошена найвужчим обсягом", () => {
  const decl = ROLE_DECLARATIONS.find((r) => r.key === "candidate");
  assert.ok(decl, "🔴 роль `candidate` не оголошена — `#15` почервоніє на першому ж прийманні");
  assert.equal(decl.dataScope, "own",
    "🔴 обсяг кандидата ширший за найвужчий: у нього немає ні менеджера, ні команди, тож "
    + "`team`/`company` відкрили б йому чужі числа в роутах, які скоуп лише ЗВУЖУЮТЬ");
  assert.equal(decl.builtIn, false, "🔴 `candidate` позначений вбудованим — його не можна буде редагувати з інтерфейсу");

  // Сід у схемі мусить давати РІВНО одну вкладку. Порівнюємо з текстом схеми, а не з
  // памʼяттю: саме розбіжність оголошеного з сидом ловить родина `#15`.
  const seed = SCHEMA.match(/VALUES \('candidate'[^;]+/);
  assert.ok(seed, "🔴 сіду ролі `candidate` у schema.sql немає — оголошення без сиду це розбіжність, а не роль");
  assert.match(seed[0], /'\{"training":true\}'::jsonb/,
    "🔴 кандидат отримав не рівно одну вкладку — а ТЗ дає йому єдиний екран");
  assert.match(seed[0], /'\{\}'::jsonb/, "🔴 кандидат отримав права — їх у нього бути не повинно");

  // 🪞 ДЗЕРКАЛО: вкладка `training` справді існує в мапі роутів. Без цієї половини гейт
  // зеленів би й тоді, коли ми дали кандидату вкладку, якої не знає жоден роут.
  assert.deepEqual(tabsForPath("/api/training/tree"), ["training"],
    "🔴 `/api/training` більше не належить вкладці `training` — сід кандидата вказує в порожнечу");
});

test("#411 ПРАВО `manage_training` ІСНУЄ, ЛЕЖИТЬ У КАТАЛОЗІ Й ВИДАНЕ РІВНО ЧОТИРЬОМ", () => {
  assert.ok((PERMISSION_CATALOG as readonly string[]).includes("manage_training"),
    "🔴 права немає в PERMISSION_CATALOG — видати його через Налаштування стане неможливо, "
    + "і `permGrantGate` відхилятиме ключ як невідомий");

  // Видача й зняття — ДВА рядки, і другий не менш важливий за перший: синки ролей
  // копіюють `permissions` адміна цілком, тож без явного зняття право розтеклося б
  // на фінансиста на НАСТУПНОМУ прогоні міграції, вже на чужому викаті.
  const give = SCHEMA.match(/permissions \|\| '\{"manage_training": true\}'::jsonb\s*\n\s*WHERE key IN \(([^)]+)\)/);
  assert.ok(give, "🔴 у schema.sql немає видачі `manage_training` — право оголошене, але нікому не належить");
  const got = give[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  assert.deepEqual(got, [...GRANTED].sort(),
    `🔴 право видано не тим ролям: ${got.join(", ")}. Склад — рішення власника 14.09.2026, `
    + "і міняти його можна лише його ж словом");

  assert.match(SCHEMA, /permissions - 'manage_training'\s*\n\s*WHERE key NOT IN/,
    "🔴 зникло ЯВНЕ зняття права в решти ролей — синк ролей поверне його фінансисту на "
    + "наступному прогоні міграції, і рішення власника скасується тихо");
});

test("#412 🪞 ЗЛІПОК ЗНАЄ ПРО ЗВУЖЕННЯ: фінансист у deny КОЖНОГО роуту запису навчання", () => {
  /* 🔴 ПРОГРЕС СЮДИ НЕ ВХОДИТЬ, І ЦЕ ЗВУЖЕННЯ ТВЕРДЖЕННЯ, А НЕ ПОСЛАБЛЕННЯ (15.09.2026).
     Гейт стереже роути РЕДАГУВАННЯ — ті, що ходять через `manage_training`. Роути
     `/progress/:id/open|done` теж пишуть, але вони відкриті КОЖНОМУ, хто бачить вкладку:
     фінансист має право проходити курс так само, як менеджер. Вимагати його в `deny` там
     означало б стверджувати неправду — а гейт, що стверджує неправду, ми вже двічі
     ловили цього тижня (`#30n`, `#111b`). */
  const write = ACCESS_MATRIX.filter((r) => r.path.startsWith("/api/training")
    && r.method !== "GET" && !r.path.includes("/progress/"));
  assert.ok(write.length >= 7,
    `🔴 у зліпку лише ${write.length} роутів запису навчання — заміряно 7 станом на 14.09.2026; покриття впало`);

  for (const r of write) {
    assert.ok(r.deny.includes("financier"),
      `🔴 ${r.method} ${r.path}: фінансиста немає в deny. До 14.09 він редагування МАВ (через admin_scope), `
      + "і власник його свідомо забрав — мовчазне зникнення з зліпка зробило б це звуження невидимим");
    assert.ok(!r.allow.includes("financier"),
      `🔴 ${r.method} ${r.path}: фінансист лишився в allow — зліпок і код стверджують різне`);
  }

  // 🪞 ДРУГА ПОЛОВИНА: ті, кому право ВИДАНО, не мають опинитись у deny. Без неї гейт
  // зеленів би й на «заборонили всім» — а це зламало б навчання повністю.
  for (const r of write) {
    for (const role of GRANTED) {
      assert.ok(!r.deny.includes(role),
        `🔴 ${r.method} ${r.path}: роль «${role}» має право manage_training, але стоїть у deny`);
    }
  }

  /* ⚠️ ЧОГО ЦЕЙ ГЕЙТ НЕ ДОВОДИТЬ, І ЦЕ ТРЕБА ЗНАТИ. Пʼять із семи роутів мають клас
     `deny-only`, тобто живий `#11` дозволені ролі на них НЕ пробує — проба була б
     записом у прод. Отже зліпок тут стверджує намір, а не поміряну поведінку; що ceo,
     opdir і kvp СПРАВДІ редагують після переходу на право, доводить лише жива проба в
     прийманні. Саме тому вона названа окремим рядком, а не «перевіримо заразом». */
});
