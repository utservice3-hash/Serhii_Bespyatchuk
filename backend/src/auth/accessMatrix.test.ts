import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, needsMatrix, API_BASE } from "../testMode.js";
import { ACCESS_MATRIX, ACCESS_ROLES } from "./accessMatrix.js";
import { MOUNTS } from "./routeInventory.js";
import { appPaths, readIndex } from "./routeScan.js";

/**
 * #11 — ЕМПІРИЧНА МАТРИЦЯ ДОСТУПУ (450 пар роль×ендпоінт).
 *
 * 🔴 ЦЕ СТРАХОВКА ПІД РЕФАКТОРИНГ ХАРДКОДУ РОЛЕЙ, а не звіт. Зліпок знято з живого
 * прода ПЕРЕД заміною `role === "admin"` на `roleHasPerm`. Заміна не має права
 * змінити жодну клітинку: змінила — це вже зміна політики, і робиться вона окремо.
 *
 * 🔴 БЕЗПЕКА ПРОБИ. Тест б'є в живий API, тому дотримується тих самих трьох умов,
 * за яких знімався зліпок:
 *   а) гейт — ПЕРШИЙ значущий оператор обробника (перевірено читанням усіх 33 мутацій);
 *   б) ціль НЕІСНУЮЧА + тіло НЕВАЛІДНЕ;
 *   в) для класу `deny-only` пробуються ЛИШЕ ролі, яким гейт відмовляє — дозволені
 *      записали б (напр. POST /dashboard/sync стартує реальний синк).
 * Незапис доведено знімком 70 таблиць до і після: жодного рядка, жодного штампа.
 */

/**
 * Ролі, що проходять admin-гейти (право `admin_scope` у БД). Тримаємо СТАТИЧНО, а не
 * читаємо з БД: #11b має працювати без підключення, як і решта структурних перевірок.
 * Розійдеться з БД — це зловить #5.2, який звіряє підняття ролей по-справжньому.
 */
const ADMIN_LEVEL_ROLES = new Set(["admin", "ceo", "opdir", "kvp", "financier"]);

/**
 * Роути, що ЗАПИСУЮТЬ і де роль адмінського рівня відмовлена ПРАВОМ, а не рівнем.
 * 403 тут — емпіричний факт із прода, тож проба безпечна. Кожен запис називає право,
 * інакше це знову «непробована роль у deny», з якої й почався інцидент.
 */
const ADMIN_DENIED_BY_PERM: Record<string, string> = {
  "PUT /api/one-on-ones/forms/:type": "edit_1x1_forms — СЕО/ОД, HR і КВП (рішення власника 27.08.2026); admin його не має",
  "POST /api/settings/roles": "manage_users — kvp/financier його не мають (рішення власника)",
  "PUT /api/settings/roles/:key": "manage_users — те саме",
  "POST /api/settings/users": "manage_users — те саме",
  "PATCH /api/settings/users/:id": "manage_users — те саме",
  "POST /api/settings/users/:id/reactivate": "manage_users — те саме",
  // 👤 Стан менеджера (активний / завершує / звільнений) — той самий guard
  // `requireManageUsers`, що й решта керування людьми, отже та сама відмова по праву.
  "PATCH /api/settings/managers/:id/work-state": "manage_users — те саме",
  "POST /api/settings/users/:id/reset-password": "reset_passwords — окреме право, лише СЕО/ОД/адмін",
  "POST /api/settings/users/provision": "manage_users — те саме",
  // ФАЗА B. `merge_clients` мають КВП, ОД і admin (зміна політики 03.08.2026).
  // `financier` і `ceo` — теж ролі адмінського рівня, але власник їх НЕ називав,
  // тож для них це справжня відмова по праву, і вона мусить бути названа: інакше
  // #11b не відрізнить політику від зламаної проби. Записів для `admin` тут
  // НЕМАЄ свідомо — після зміни політики вони стали б мертвими, а мертвий запис
  // у реєстрі глушить справжню розбіжність (урок #15e).
  "POST /api/dashboard/client-merge": "merge_clients — право КВП/ОД/admin; financier і ceo його не мають",
  "POST /api/dashboard/client-merge/revoke": "merge_clients — те саме",
  "POST /api/dashboard/client-manager": "merge_clients — те саме",
  // 🔗 Склейка в ДЕБІТОРЦІ — окреме право `merge_receivables` = {admin, ceo, opdir, kvp}
  // (рішення власника 22.08.2026, варіант A). `financier` має `admin_scope`, але
  // склейки в дебіторці власник йому не давав — отже це відмова по ПРАВУ, і вона
  // мусить бути названа, інакше #11b не відрізнить політику від зламаної проби.
  // `ceo` тут НЕМАЄ навмисно: на відміну від `client-merge`, він це право МАЄ,
  // тож запис був би мертвим — а мертвий запис глушить справжню розбіжність (#15e).
  "POST /api/dashboard/receivables/merge": "merge_receivables — право КВП/СЕО/ОД/admin; financier його не має",
  // 🔓 Превʼю розʼєднання гейтиться ТИМ САМИМ правом, що й сама дія: воно показує
  // склад групи, суми й тексти нотаток, тож читання не має бути ширшим за запис.
  "GET /api/dashboard/receivables/unmerge-preview?canonical=смартекс": "merge_receivables — та сама межа, що в самої дії розʼєднання",
  // 🗑 СПИСАННЯ БОРГУ — право `write_off_debt` = РІВНО {ceo, opdir} (рішення
  // власника 25.08.2026). Тут у deny стоять ТРИ ролі адмінського рівня —
  // `admin`, `kvp`, `financier` — і жодна з них не виняток: списання зменшує
  // суму на плитці, тобто це визнання втрати грошей, а не операційна дія.
  //
  // 🔴 АДМІН У ЦЬОМУ РЕЄСТРІ — ПЕРШИЙ ТАКИЙ ЗАПИС, і він живий, а не мертвий
  // (урок `#15e`): у решти рядків адмін право МАЄ, тож запис був би шумом;
  // тут він його справді не має. Проба безпечна за побудовою — гейт стоїть
  // ПЕРШИМ значущим оператором роута, отже 403 приходить ДО будь-якого читання
  // тіла й ДО єдиного запиту в БД (тримає `#156`).
  "POST /api/dashboard/receivables/writeoff": "write_off_debt — рівно СЕО/ОД; admin, kvp і financier його не мають",
  "DELETE /api/dashboard/receivables/writeoff": "write_off_debt — те саме; скасування за тим самим правом",
};

const GHOST = "__zzz_neisnuyucha_cil_9999__";
const BAD_BODY = JSON.stringify({ __probe__: "невалідне тіло", zzz: null });
const fill = (p: string) => p.replace(":clientKey", GHOST).replace(":id", "0").replace(/:\w+/g, GHOST);

const load = async () => ({
  signToken: (await import("./auth.js")).signToken,
  rbac: await import("./rbac.js"),
});

test("#11 МАТРИЦЯ ДОСТУПУ: жодна клітинка не змінилась", needsMatrix(), async (t) => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  const tok = (r: string) => signToken({
    userId: 0, role: rbac.scopeCompatRole(r, rbac.getRoleDef(r)), roleKey: r,
    managerId: r === "manager" ? 8 : null, teamId: r === "team_lead" ? 5 : null,
  });

  const drift: string[] = [];
  let checked = 0;
  /** Скільки проб реально впіймали гейт. 0 при непорожньому дрейфі = зламана проба. */
  let seen403 = 0;
  for (const row of ACCESS_MATRIX) {
    // Пробуємо рівно ті ролі, що є у зліпку: для deny-only дозволених там немає.
    const probe = [...row.allow, ...row.deny];
    for (const role of probe) {
      // 🔴 БЕЗ `/api` ПЕРЕД `row.path`. До кроку B1 зліпок зберігав шляхи БЕЗ префікса
      // (`/dashboard/overview`), і префікс дописувався тут. B1 перегенерував зліпок із
      // РАНТАЙМ-обходу роутерів, а той віддає повний шлях (`/api/dashboard/overview`) —
      // тож проба пішла в `/api/api/…` і сервер віддав 404 на ВСЕ. Наслідок був
      // асиметричний і тому підступний: рядки `allow` зеленіли (404 ≠ 403 = «дозволено»),
      // а всі `deny` показали фальшивий дрейф. Формат шляху тепер тримає #11c.
      const res = await fetch(`${API_BASE}${fill(row.path)}`, {
        method: row.method,
        headers: { Authorization: `Bearer ${tok(role)}`, "Content-Type": "application/json" },
        body: row.method === "GET" ? undefined : BAD_BODY,
      });
      checked++;
      if (res.status === 403) seen403++;
      const allowedNow = res.status !== 403;
      const allowedThen = row.allow.includes(role);
      if (allowedNow !== allowedThen) {
        drift.push(`${row.method} ${row.path} · ${role}: було ${allowedThen ? "ДОЗВОЛЕНО" : "403"}, `
          + `стало ${allowedNow ? `${res.status} (ДОЗВОЛЕНО)` : "403"}`);
      }
    }
  }
  t.diagnostic(`перевірено ${checked} пар роль×ендпоінт на ${ACCESS_MATRIX.length} ендпоінтах`);
  // Скільки пар МАЄ бути — рахуємо ЗІ ЗЛІПКА, а не зашитим числом.
  // 🔴 31.07.2026: тут стояло `assert.equal(checked, 450)`. Коли фінансиста прибрали
  // з проби на 14 рядках deny-only (він тепер проходить гейт, і проба була б записом),
  // пар стало 436 — і тест почервонів, хоч ЖОДНА клітинка не змінилась. Зашите число
  // перетворює будь-яку СВІДОМУ зміну складу зліпка на фальшиву тривогу, а фальшива
  // тривога через місяць стає «та ігноруй його».
  // Твердження лишається сильним: цикл мусить обійти РІВНО те, що є у зліпку —
  // жодної пропущеної пари (обірваний цикл) і жодної зайвої.
  const expectedPairs = ACCESS_MATRIX.reduce((n, r) => n + r.allow.length + r.deny.length, 0);
  assert.equal(checked, expectedPairs,
    `обійшли ${checked} пар, а у зліпку ${expectedPairs} — цикл проби неповний`);
  // 🔴 ДІАГНОЗ ПЕРЕД ВИРОКОМ. Якщо ЖОДНА проба не отримала 403, гейт не спрацював
  // ніде — а це не «політику відкрили всім», це зламана проба (не той базовий URL,
  // не той префікс шляху, лежить сервер). Саме так виглядав інцидент 01.08.2026:
  // 274 рядки «дрейфу», а насправді подвійний `/api`. Без цього рядка вивід підказує
  // хибний напрямок і кличе «полагодити» політику, з якою все гаразд.
  if (drift.length > 0 && seen403 === 0) {
    assert.fail(`🔴 ЗЛАМАНА ПРОБА, А НЕ ПОЛІТИКА: обійшли ${checked} пар і не отримали ЖОДНОГО 403. `
      + `Перевір API_BASE (${API_BASE}) і формат шляхів у зліпку — вони мають бути повними `
      + "(`/api/…`) і не дописуватись удруге. Дрейф не оцінюємо, поки проба не б'є в живі роути.");
  }
  assert.deepEqual(drift, [],
    "🔴 ПОВЕДІНКА ДОСТУПУ ЗМІНИЛАСЬ (рефакторинг не має права цього робити):\n  " + drift.join("\n  "));
});

test("#11c ФОРМАТ ШЛЯХІВ: зліпок і проба говорять однією мовою", () => {
  // Ворота проти рівно того класу, що коштував нам прогону: генератор зліпка й пробник
  // розійшлись у тому, чи шлях уже містить `/api`. Мережі не треба — тому перевірка
  // виконується в кожному `npm test`, а не лише в матричному режимі.
  const mounts = [...new Set(MOUNTS.map((m) => m.mount))];
  // 🔴 ДРУГЕ ДЖЕРЕЛО ЖИВИХ АДРЕС — index.ts (додано 02.09.2026). Не всі роути ростуть із
  // app.use: три `/api/health*` оголошені ПРЯМО на `app`, тобто не належать жодному
  // префіксу з MOUNTS. Поки #11c знав лише про MOUNTS, він червонів на цих рядках
  // ХИБНО — стверджував «проба піде в неіснуючий URL», хоча URL живий. Твердження гейта
  // не змінилось (проба мусить бити в живу адресу), змінилось те, звідки він бере
  // перелік живих адрес.
  const onApp = new Set(appPaths(readIndex()));
  const bad = ACCESS_MATRIX
    .filter((r) => !onApp.has(r.path))
    .filter((r) => !mounts.some((m) => r.path === m || r.path.startsWith(m + "/")))
    .map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(bad, [],
    "🔴 у зліпку є шлях, який не починається з жодного змонтованого префікса. Або зліпок "
    + "зберігає шлях БЕЗ `/api`, або зʼявився новий mount, не записаний у MOUNTS. Проба "
    + "піде в неіснуючий URL і поверне 404 — тобто «дозволено» для кожного рядка:\n  "
    + bad.join("\n  "));
});

test("#11b ЗЛІПОК ЦІЛИЙ: усі ролі відомі, класи проби коректні", () => {
  assert.ok(ACCESS_MATRIX.length > 0, "зліпок порожній — тест нічого не доводить");
  // Зліпок не має тихо схуднути й лишитись «зеленим»: менше рядків = менше перевірок,
  // а вивід виглядає так само. Пороги стоять САМЕ ТУТ, а не в #11: #11 ходить у мережу
  // й без `TEST_SCOPE=prod` пропускається — тобто в звичайному `npm test` ці твердження
  // не виконувались би зовсім. Зростати вільно; зменшувати — свідомою правкою порога.
  assert.ok(ACCESS_MATRIX.length >= 65,
    `🔴 зліпок схуд до ${ACCESS_MATRIX.length} ендпоінтів (було 65) — зникло покриття`);
  const pairs = ACCESS_MATRIX.reduce((n, r) => n + r.allow.length + r.deny.length, 0);
  assert.ok(pairs >= 400,
    `🔴 у зліпку лише ${pairs} пар — покриття впало, тест майже нічого не перевіряє`);
  const known = new Set<string>(ACCESS_ROLES);
  for (const r of ACCESS_MATRIX) {
    for (const role of [...r.allow, ...r.deny]) {
      assert.ok(known.has(role), `${r.path}: невідома роль «${role}»`);
    }
    assert.equal(new Set([...r.allow, ...r.deny]).size, r.allow.length + r.deny.length,
      `${r.path}: роль потрапила і в allow, і в deny`);
    // deny-only не має містити дозволених: інакше тест почав би писати в прод.
    if (r.cls === "deny-only") {
      assert.deepEqual(r.allow, [],
        `🔴 ${r.method} ${r.path} має клас deny-only, але у зліпку є дозволені ролі — `
        + "проба таких ролей записала б дані");
      // 🔴 31.07.2026, реальний інцидент: перегенерація зліпка зсипала НЕПРОБОВАНІ ролі
      // (admin/ceo/opdir/kvp) у `deny`. Структурно це легально — `allow` лишався порожнім,
      // і перевірка вище пройшла. Наступний прогін #11 узяв ці ролі в пробу й виконав
      // POST /dashboard/sync, PUT /settings/, POST /news/ АДМІНСЬКИМ токеном проти прода.
      //
      // ⚠️ УТОЧНЕНО 01.08.2026 (крок B1). Твердження «адмін-рівня в deny не буває» надто
      // грубе: є роути, де адмін відмовлений ПРАВОМ, а не рівнем ролі — напр.
      // `PUT /one-on-ones/forms/:type` за `edit_1x1_forms`, якого в admin немає взагалі.
      // Там 403 — емпіричний факт із прода, і проба такої ролі безпечна за побудовою.
      // Тому вимога тепер конкретніша: такий випадок треба НАЗВАТИ в реєстрі нижче.
      for (const role of r.deny) {
        if (!ADMIN_LEVEL_ROLES.has(role)) continue;
        const key = `${r.method} ${r.path}`;
        const known = ADMIN_DENIED_BY_PERM[key];
        assert.ok(known,
          `🔴 ${key}: роль «${role}» адмінського рівня стоїть у deny рядка, що ЗАПИСУЄ. `
          + "Якщо це справжня відмова по ПРАВУ — назви право в ADMIN_DENIED_BY_PERM. "
          + "Якщо ні — роль пройде гейт, і проба виконає мутацію проти прода.");
      }
    }
  }
});
