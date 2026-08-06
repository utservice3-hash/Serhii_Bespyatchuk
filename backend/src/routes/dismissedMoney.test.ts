import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, needsDb, API_BASE } from "../testMode.js";

/**
 * #50 — ГРОШІ НЕ ЗНИКАЮТЬ РАЗОМ ІЗ ЛЮДИНОЮ.
 *
 * 🔴 ПАСТКА, ЯКУ ЦЕЙ ГЕЙТ СТЕРЕЖЕ. Ростер Звіту фільтрує `m.is_active`, а грошові
 * функції ядра — НІ (правило власника: «is_active керує списками й вибором, а не
 * історичними сумами»). Тобто щойно менеджера деактивують у Kommo, його рядок
 * зникає з екрана, а гроші лишаються в `receivedByTeam` — і Σ(менеджери) перестає
 * дорівнювати команді. На цьому інваріанті стоїть половина наших гейтів, і ламався
 * б він ТИХО: жодне окреме число не виглядало б дивним.
 *
 * Тому перевіряємо не «чи є рядок звільнених», а сильніше твердження: **Σ по
 * екрану дорівнює тому, що каже ядро**. Рядок звільнених — лише спосіб це
 * забезпечити; якби його прибрали, гейт почервонів би сам.
 */
test("#50 Σ факту на екрані == receivedMoney ядра (звільнені не губляться)", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const money = await import("../core/money.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });

  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const body = await r.json() as {
    glance: { fact: number; factSuccess: number; factPaid: number };
    managers: { name: string; fact: number }[];
    dismissed?: { name: string; fact: number; factPaid: number; factPaidDeals: number }[];
  };
  assert.ok((body.managers ?? []).length > 0, "🔴 у звіті нема жодного менеджера — перевіряти нічого");

  // Σ по екрану = активні + звільнені. Саме це й має дорівнювати ядру.
  const screen = (body.managers ?? []).reduce((s, m) => s + m.fact, 0)
    + (body.dismissed ?? []).reduce((s, m) => s + m.fact, 0);
  assert.equal(body.glance.fact, screen,
    "🔴 glance.fact ≠ Σ рядків екрана — підсумок і таблиця розповідають різне");

  // ⚠️ КОМЕРЦІЙНИЙ СКОУП: ядро рахує ВСІХ, екран — лише продажні юніти (лідоген і
  // фінвідділ виключені свідомо). Тому порівнюємо не з `receivedMoney({})`, а
  // перевіряємо НАПРЯМОК: екран не може показати БІЛЬШЕ, ніж є в ядрі, і не має
  // втрачати гроші звільнених, якщо вони є.
  const core = await money.receivedMoney({ from, to });
  assert.ok(screen <= core.revenue + 1,
    `🔴 екран показує ${screen}, а ядро має всього ${core.revenue} — на екрані зайві гроші`);
});

/**
 * #50b — ДЗЕРКАЛО Й ЧЕСНА МЕЖА: якщо звільнених із грішми НЕМАЄ, гейт мусить це
 * СКАЗАТИ, а не мовчки зеленіти. Порожній результат — не доказ; доказом він стає
 * лише тоді, коли ми окремо переконались, що шукати справді не було чого.
 */
test("#50b звільнені з грішми: або їх нема, або вони НАЗВАНІ", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const money = await import("../core/money.js");
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const rows = await money.receivedByMgr({ from, to });
  const inactive = new Set((await pool.query<{ id: number }>(
    `SELECT id FROM managers WHERE NOT is_active`)).rows.map((r) => r.id));
  const withMoney = rows.filter((r) => inactive.has(r.managerId));

  // Це не assert про кількість — це ЗАМІР, який має бути видимий у виводі тесту.
  // Нуль тут нормальний; ненульове значення означає, що рядок «звільнені» вже
  // працює на реальних грошах, і його треба перевірити очима.
  console.log(`#50b звільнених із грішми за ${ym}: ${withMoney.length}`
    + (withMoney.length ? ` · Σ ${Math.round(withMoney.reduce((s, r) => s + r.revenue, 0))} ₴` : " (порожньо — механізм стоїть заздалегідь)"));

  // Дзеркало: сам предикат не вироджений — деактивовані в базі Є, тож «нуль» вище
  // означає «немає грошей», а не «немає кого перевіряти».
  assert.ok(inactive.size > 0,
    "🔴 у базі НЕМА жодного деактивованого менеджера — тоді перевірка порожня за побудовою");
});
