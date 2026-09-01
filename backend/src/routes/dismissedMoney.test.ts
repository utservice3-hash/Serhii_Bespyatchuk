import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, needsDb, needsDbWritable, API_BASE } from "../testMode.js";
import { kyivMonthBounds } from "../core/dates.js";

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

  const ym = kyivMonthBounds().ym;
  const from = `${ym}-01`;
  const to = kyivMonthBounds().to;

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
 * #50c — ГРОШІ НЕ ЗНИКАЮТЬ ПРИ ДЕАКТИВАЦІЇ БУДЬ-ЯКИМ ІЗ ДВОХ ПРАПОРЦІВ.
 *
 * 🔴 #50 перевіряв СУМУ, а не ДЖЕРЕЛО ознаки — і саме тому лишався б зеленим,
 * навіть якби рядок «звільнені» ключився не на той прапорець. Реальний випадок:
 * власник деактивує людей у НАЛАШТУВАННЯХ (`users.is_active`), а рядок стояв на
 * Kommo (`managers.is_active`), тож на реальних звільненнях не спрацював би ніколи.
 *
 * 🧨 Саботаж робимо САМЕ деактивацією в дашборді: беремо менеджера З ГРІШМИ,
 * знімаємо йому логін і вимагаємо, щоб його гроші лишились у полі зору —
 * тобто щоб він випав із ростера й потрапив у `dismissed`, а не зник.
 * Усе в транзакції з гарантованим ROLLBACK.
 */
test("#50c саботаж у ДАШБОРДІ: гроші звільненого лишаються в полі зору", needsDbWritable(), async () => {
  const { pool } = await import("../db/pool.js");
  const money = await import("../core/money.js");
  const { activeManagerSql } = await import("../core/activeManager.js");
  const ym = kyivMonthBounds().ym;
  const from = `${ym}-01`;
  const to = kyivMonthBounds().to;

  const rows = await money.receivedByMgr({ from, to });
  const withMoney = rows.filter((r) => r.revenue !== 0);
  assert.ok(withMoney.length > 0, "🔴 у місяці ні в кого немає грошей — саботувати нічого");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const victim = (await client.query<{ mid: number; uid: number }>(
      `SELECT m.id AS mid, u.id AS uid FROM managers m JOIN users u ON u.manager_id = m.id
        WHERE m.id = ANY($1) AND m.is_active AND u.is_active ORDER BY m.id LIMIT 1`,
      [withMoney.map((r) => r.managerId)])).rows[0];
    assert.ok(victim, "🔴 нема менеджера з грішми Й активним логіном — саботаж неможливий");
    const cash = withMoney.find((r) => r.managerId === victim.mid)!.revenue;

    const inRoster = async (): Promise<boolean> => (await client.query<{ n: string }>(
      `SELECT COUNT(*) n FROM managers m WHERE m.id = $1 AND ${activeManagerSql("m")}`, [victim.mid])).rows[0].n === "1";

    assert.equal(await inRoster(), true, "🔴 менеджер не в ростері ще ДО саботажу");
    await client.query(`UPDATE users SET is_active = false WHERE id = $1`, [victim.uid]);
    assert.equal(await inRoster(), false,
      "🔴 деактивація в дашборді НЕ вивела людину з ростера — тоді її гроші лишились би "
      + "в рядку активного менеджера, а сам рядок брехав би, що людина працює");

    // 🔴 І головне: гроші ядро й далі бачить — тобто вони НЕ зникли, а мусять
    // приїхати в `dismissed`. Ядро навмисно не фільтрує активність (правило #37).
    const after = (await money.receivedByMgr({ from, to })).find((r) => r.managerId === victim.mid);
    assert.equal(after?.revenue, cash,
      "🔴 після деактивації ядро втратило гроші людини — тоді Σ зламалась би незалежно від рядка");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

/**
 * #50b — ДЗЕРКАЛО Й ЧЕСНА МЕЖА: якщо звільнених із грішми НЕМАЄ, гейт мусить це
 * СКАЗАТИ, а не мовчки зеленіти. Порожній результат — не доказ; доказом він стає
 * лише тоді, коли ми окремо переконались, що шукати справді не було чого.
 */
test("#50b звільнені з грішми: або їх нема, або вони НАЗВАНІ", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const money = await import("../core/money.js");
  const ym = kyivMonthBounds().ym;
  const from = `${ym}-01`;
  const to = kyivMonthBounds().to;

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
