import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #54 — ЧОТИРИ СТАНИ ЛЮДЕЙ — ЦЕ РОЗБИТТЯ, А НЕ ЧОТИРИ ЛІЧИЛЬНИКИ.
 *
 * 🔴 ПРИВІД — І ЙОГО ЗНАЙШОВ НЕ ТЕСТ, А ПОГЛЯД НА ЕКРАН. Плитка «Люди» підписана
 * «31 менеджер(ів)», а чипи під нею давали **37**: 6 «гроші є · не закрито» + 21
 * «зрив» + 4 «відстає» + 6 «у нормі». Причина — `collectedNotClosed` лічився
 * ОКРЕМО, а ті самі люди лишались і в `r/a/g`, тобто рахувались двічі.
 *
 * Жоден наявний гейт цього не бачив: `#50` звіряє ГРОШІ, `#46` — вкладеність
 * періодів, матриця — доступи. **Підпис плитки з сумою чипів під нею не звіряв
 * ніхто** — рівно той клас, що «текст у списку не перевіряє жоден гейт».
 *
 * Тому перевіряємо не окремі лічильники, а ІНВАРІАНТ РОЗБИТТЯ:
 * `collectedNotClosed + r + a + g == к-сть менеджерів`.
 */
test("#54 Σ чотирьох станів == к-сті менеджерів на екрані", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const b = await r.json() as {
    glance: { collectedNotClosed: number; statusCounts: { g: number; a: number; r: number } };
    managers: { name: string; factSuccess: number; factPaid: number; status: string }[];
  };
  const n = b.managers.length;
  assert.ok(n > 0, "🔴 у звіті нема жодного менеджера — перевіряти нічого");

  const sc = b.glance.statusCounts;
  const sum = b.glance.collectedNotClosed + sc.r + sc.a + sc.g;
  assert.equal(sum, n,
    `🔴 Σ станів ${sum} ≠ ${n} менеджерів — плитка підписана однією цифрою, а чипи під нею дають іншу `
    + `(гроші є ${b.glance.collectedNotClosed} · зрив ${sc.r} · відстає ${sc.a} · норма ${sc.g})`);

  // 🪞 ДЗЕРКАЛО: розбиття не має бути вироджене. Якщо ВСІ в одному стані, рівність
  // зійшлась би тривіально й нічого не доводила.
  const nonEmpty = [b.glance.collectedNotClosed, sc.r, sc.a, sc.g].filter((x) => x > 0).length;
  assert.ok(nonEmpty >= 2,
    `🔴 усі ${n} менеджерів в одному стані — рівність тривіальна, перевірка порожня`);

  // І сам стан «гроші є · не закрито» рахується за тим самим правилом, що на екрані.
  const expected = b.managers.filter((m) => m.factSuccess === 0 && m.factPaid > 0).length;
  assert.equal(b.glance.collectedNotClosed, expected,
    "🔴 `collectedNotClosed` не збігається з рядками, що підпадають під це правило");
});
