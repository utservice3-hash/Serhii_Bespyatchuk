import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, needsMatrix, API_BASE } from "../testMode.js";
import { ACCESS_MATRIX, ACCESS_ROLES } from "./accessMatrix.js";

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
  "PUT /api/one-on-ones/forms/:type": "edit_1x1_forms — право СЕО/ОД та HR; admin його не має",
  "POST /api/settings/roles": "manage_users — kvp/financier його не мають (рішення власника)",
  "PUT /api/settings/roles/:key": "manage_users — те саме",
  "POST /api/settings/users": "manage_users — те саме",
  "PATCH /api/settings/users/:id": "manage_users — те саме",
  "POST /api/settings/users/:id/reactivate": "manage_users — те саме",
  "POST /api/settings/users/:id/reset-password": "reset_passwords — окреме право, лише СЕО/ОД/адмін",
  "POST /api/settings/users/provision": "manage_users — те саме",
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
  for (const row of ACCESS_MATRIX) {
    // Пробуємо рівно ті ролі, що є у зліпку: для deny-only дозволених там немає.
    const probe = [...row.allow, ...row.deny];
    for (const role of probe) {
      const res = await fetch(`${API_BASE}/api${fill(row.path)}`, {
        method: row.method,
        headers: { Authorization: `Bearer ${tok(role)}`, "Content-Type": "application/json" },
        body: row.method === "GET" ? undefined : BAD_BODY,
      });
      checked++;
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
  assert.deepEqual(drift, [],
    "🔴 ПОВЕДІНКА ДОСТУПУ ЗМІНИЛАСЬ (рефакторинг не має права цього робити):\n  " + drift.join("\n  "));
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
