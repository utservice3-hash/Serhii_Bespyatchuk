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

  // ⚠️ Роут ВИМАГАЄ `teamId` (без нього 400) — беремо реальну команду з активними
  // менеджерами, а не вгадану константу: вгадана поламала б гейт при зміні довідника,
  // і падіння читалось би як регресія метрики.
  const team = (await pool.query<{ team_id: number }>(
    `SELECT team_id FROM managers WHERE is_active AND team_id IS NOT NULL
      GROUP BY team_id ORDER BY COUNT(*) DESC LIMIT 1`)).rows[0];
  assert.ok(team, "🔴 нема жодної команди з активними менеджерами — перевіряти нічого");

  const r = await fetch(`${API_BASE}/api/dashboard/managers?month=${month}&teamId=${team.team_id}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /dashboard/managers віддав ${r.status}`);
  const body = await r.json() as { managers?: { id: number; name: string; expected?: number }[] };
  const mgrs = body.managers ?? [];
  assert.ok(mgrs.length > 0, "🔴 у відповіді нема жодного менеджера — перевіряти нічого");

  const missing = mgrs
    .filter((m) => typeof m.expected !== "number" || !Number.isFinite(m.expected))
    .map((m) => `${m.name} (id=${m.id}): ${JSON.stringify(m.expected)}`);
  assert.deepEqual(missing, [],
    "🔴 у рядку нема числового `expected` — «Рейтинг менеджерів» намалює «—» замість суми, "
    + "і колонка «Очікування» тихо перестане існувати");

  assert.ok(mgrs.some((m) => (m.expected ?? 0) !== 0),
    "🔴 `expected` у ВСІХ нуль — перевірка «поле є» нічого не доводить: рівно так само "
    + "виглядав би мовчазний фолбек на нуль");
});
