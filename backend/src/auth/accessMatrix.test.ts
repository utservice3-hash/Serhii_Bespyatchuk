import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";
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

const GHOST = "__zzz_neisnuyucha_cil_9999__";
const BAD_BODY = JSON.stringify({ __probe__: "невалідне тіло", zzz: null });
const fill = (p: string) => p.replace(":clientKey", GHOST).replace(":id", "0").replace(/:\w+/g, GHOST);

const load = async () => ({
  signToken: (await import("./auth.js")).signToken,
  rbac: await import("./rbac.js"),
});

test("#11 МАТРИЦЯ ДОСТУПУ: жодна клітинка не змінилась", needsApi(), async (t) => {
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
  assert.equal(checked, 450, `очікували 450 пар, зробили ${checked} — зліпок неповний`);
  assert.deepEqual(drift, [],
    "🔴 ПОВЕДІНКА ДОСТУПУ ЗМІНИЛАСЬ (рефакторинг не має права цього робити):\n  " + drift.join("\n  "));
});

test("#11b ЗЛІПОК ЦІЛИЙ: усі ролі відомі, класи проби коректні", () => {
  assert.ok(ACCESS_MATRIX.length > 0, "зліпок порожній — тест нічого не доводить");
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
      // і перевірка вище пройшла. Але наступний прогін #11 узяв ці ролі в пробу й
      // виконав POST /dashboard/sync, PUT /settings/, POST /news/ АДМІНСЬКИМ токеном
      // проти прода. Врятувало лише невалідне тіло (умова «б»).
      // Тому окреме твердження: у deny-only рядку не сміє бути ролі АДМІНСЬКОГО РІВНЯ —
      // вона за визначенням проходить admin-гейти, отже пробувати її = писати.
      for (const role of r.deny) {
        assert.ok(!ADMIN_LEVEL_ROLES.has(role),
          `🔴 ${r.method} ${r.path}: роль «${role}» адмінського рівня стоїть у deny рядка, `
          + "що ЗАПИСУЄ. Вона пройде гейт, і проба виконає справжню мутацію проти прода. "
          + "Дозволені ролі в deny-only рядках не перелічуються ВЗАГАЛІ — ні в allow, ні в deny.");
      }
    }
  }
});
