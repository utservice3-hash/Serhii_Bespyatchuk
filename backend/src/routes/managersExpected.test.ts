import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #47 — «ОЧІКУВАННЯ» В РЕЙТИНГУ МЕНЕДЖЕРІВ РЕАЛЬНО ПРИЇЖДЖАЄ.
 *
 * 🔴 ПРИВІД. `ManagersSection` малює `formatAmount(manager.expected)` і в рядку
 * «Разом» додає `+ m.expected`. Типом поле обовʼязкове — але тип описує наміри
 * фронта, а не те, що справді віддає роут. Зникни воно з відповіді, і до правки
 * `formatAmount` падав би ВЕСЬ екран (`undefined.toFixed`), а після правки він
 * тихо намалює «—» у кожному рядку. Обидва результати однаково погані без гейта:
 * перший гучний і незрозумілий, другий тихий і правдоподібний.
 *
 * Тому «—» на екрані — це захист від падіння, а СИГНАЛІЗАЦІЯ живе тут. Різні
 * механізми: підмінити другий першим означало б зробити баг тихим.
 *
 * 🪞 ДЗЕРКАЛО ВСЕРЕДИНІ: наявності поля мало — воно може бути в усіх нулем, і
 * тоді «є» нічого не доводить (нуль виглядає точно так само, як мовчазний
 * фолбек). Тому окремо вимагаємо, щоб хоч в одного менеджера воно було ≠ 0.
 */
test("#47 /dashboard/managers віддає expected у КОЖНОМУ рядку", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const { pool } = await import("../db/pool.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  // ⚠️ Роут ВИМАГАЄ `teamId` (без нього 400), тож ідемо по ВСІХ командах: перевірка
  // «поле є» має триматись усюди, а не в одній вгаданій команді.
  const teams = (await pool.query<{ team_id: number }>(
    `SELECT team_id FROM managers WHERE is_active AND team_id IS NOT NULL
      GROUP BY team_id ORDER BY COUNT(*) DESC`)).rows;
  assert.ok(teams.length > 0, "🔴 нема жодної команди з активними менеджерами — перевіряти нічого");

  const missing: string[] = [];
  let seen = 0, nonZero = 0;
  for (const t of teams) {
    const r = await fetch(`${API_BASE}/api/dashboard/managers?month=${month}&teamId=${t.team_id}`,
      { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200, `🔴 /dashboard/managers (team ${t.team_id}) віддав ${r.status}`);
    const body = await r.json() as { managers?: { id: number; name: string; expected?: number }[] };
    for (const m of body.managers ?? []) {
      seen++;
      if (typeof m.expected !== "number" || !Number.isFinite(m.expected)) {
        missing.push(`${m.name} (id=${m.id}, team ${t.team_id}): ${JSON.stringify(m.expected)}`);
      } else if (m.expected !== 0) nonZero++;
    }
  }
  assert.ok(seen > 0, "🔴 у відповідях нема жодного менеджера — перевіряти нічого");
  assert.deepEqual(missing, [],
    "🔴 у рядку нема числового `expected` — «Рейтинг менеджерів» намалює «—» замість суми, "
    + "і колонка «Очікування» тихо перестане існувати");

  /**
   * 🪞 ДЗЕРКАЛО — ПО ВСІЙ КОМПАНІЇ, А НЕ ПО ОДНІЙ КОМАНДІ, і це не послаблення,
   * а виправлення КАЛІБРУВАННЯ. Перша редакція брала команду з найбільшою
   * кількістю активних менеджерів — нею виявилась РНК-Михальчевської, у якої
   * етап 8 за серпень порожній ЗАКОННО (входи в стадію є лише в Яцика і Дмитрука,
   * 75 469 ₴ на шістьох). Гейт червонів на проді, хоча продукт справний: заміряно
   * `expectedByMgr` по всіх командах окремо. Нуль в ОДНІЙ команді — нормальний
   * стан; нуль У ВСІХ одночасно — ось це вже або мовчазний фолбек, або зламане
   * джерело, і саме його ми й ловимо.
   */
  assert.ok(nonZero > 0,
    `🔴 \`expected\` дорівнює нулю у ВСІХ ${seen} менеджерів усіх ${teams.length} команд — `
    + "перевірка «поле є» нічого не доводить: рівно так само виглядав би мовчазний фолбек на нуль");
});
