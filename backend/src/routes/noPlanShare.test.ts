import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";
import { kyivMonthBounds } from "../core/dates.js";

interface Row { name: string; plan: number; fact: number }
interface Body {
  glance: { fact: number; plan: number; factNoPlan: number };
  managers: Row[];
  dismissed?: { name: string; fact: number }[];
}

async function load(): Promise<Body> {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const ym = kyivMonthBounds().ym;
  const from = `${ym}-01`;
  const to = kyivMonthBounds().to;
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  return await r.json() as Body;
}

/**
 * #53 — СКЛАДОВА «ВІД МЕНЕДЖЕРІВ БЕЗ ПЛАНУ» ВІДДАЄТЬСЯ ОКРЕМИМ ПОЛЕМ.
 *
 * 🔴 ПРИВІД І ЙОГО ВЕЛИЧИНА. План команди рахується як **Σ планів її менеджерів**,
 * тож гроші людини, якій цілі не ставили, потрапляють у ЧИСЕЛЬНИК, не потрапивши
 * у ЗНАМЕННИК. Заміряно на проді 06.08.2026: у РПК-Яцика **+8.3 п.п.** (24.9%
 * замість 16.5%), по компанії **+2.6 п.п.**, і 22.5% усього факту компанії
 * приходить від безпланових.
 *
 * ⚠️ І ЦЕ НЕ ТИМЧАСОВО. Симуляція деактивації в транзакції з ROLLBACK: факт
 * команди 217 873 → 217 873, план 865 000 → 865 000, % 25.2% → 25.2%. Гроші лише
 * переїжджають із рядка активного в рядок «звільнені», ОБИДВА з яких входять у
 * суму команди. Тому поле потрібне назавжди, а не до найближчого звільнення.
 */
test("#53 factNoPlan == Σ факту менеджерів без плану + звільнених", needsApi(), async () => {
  const b = await load();
  assert.ok(b.managers.length > 0, "🔴 у звіті нема жодного менеджера — перевіряти нічого");

  const expected = b.managers.filter((m) => m.plan <= 0).reduce((s, m) => s + m.fact, 0)
    + (b.dismissed ?? []).reduce((s, m) => s + m.fact, 0);
  assert.equal(b.glance.factNoPlan, expected,
    "🔴 factNoPlan не дорівнює сумі рядків без плану — підпис на екрані показував би "
    + "не ту величину, яку насправді дають ці люди");

  // Складова не може перевищувати сам факт — інакше десь подвійний рахунок.
  assert.ok(b.glance.factNoPlan <= b.glance.fact + 1,
    `🔴 factNoPlan ${b.glance.factNoPlan} > fact ${b.glance.fact}`);
});

/**
 * #53b — 🧨 САБОТАЖ, ЯКИЙ ПРОСИВ ВЛАСНИК: обнулити поле при ЖИВОМУ безплановому
 * має червоніти. Без цього #53 зеленів би на `factNoPlan = 0` тоді, коли
 * безпланових просто немає, — тобто в найтихішому й найнебезпечнішому випадку.
 *
 * 🪞 І ДЗЕРКАЛО: якщо безпланових із грішми НЕМАЄ, поле ЗОБОВʼЯЗАНЕ бути нулем.
 * Інакше воно вигадувало б величину там, де її нема.
 */
test("#53b саботаж: нуль при живому безплановому — це поломка", needsApi(), async () => {
  const b = await load();
  const noPlanWithMoney = b.managers.filter((m) => m.plan <= 0 && m.fact !== 0);
  const dismissedWithMoney = (b.dismissed ?? []).filter((m) => m.fact !== 0);
  const anyone = noPlanWithMoney.length + dismissedWithMoney.length;

  // Замір видимий у виводі — щоб «нуль» завжди можна було відрізнити від «не шукали».
  console.log(`#53b безпланових із грішми: ${noPlanWithMoney.length}`
    + (noPlanWithMoney.length ? ` (${noPlanWithMoney.map((m) => `${m.name} ${Math.round(m.fact)}₴`).join(", ")})` : "")
    + ` · звільнених із грішми: ${dismissedWithMoney.length} · factNoPlan=${b.glance.factNoPlan}`);

  if (anyone > 0) {
    assert.notEqual(b.glance.factNoPlan, 0,
      "🔴 БЕЗПЛАНОВІ З ГРІШМИ Є, а factNoPlan = 0 — підпис «у т.ч. … від менеджерів без плану» "
      + "зник би з екрана саме тоді, коли він потрібен");
    const min = Math.min(...[...noPlanWithMoney, ...dismissedWithMoney].map((m) => Math.abs(m.fact)));
    assert.ok(Math.abs(b.glance.factNoPlan) >= min - 1,
      `🔴 factNoPlan ${b.glance.factNoPlan} менший за внесок НАЙМЕНШОГО безпланового (${min}) — поле недорахувало`);
  } else {
    assert.equal(b.glance.factNoPlan, 0,
      "🔴 безпланових із грішми НЕМА, а поле ненульове — воно вигадує величину");
  }
});
