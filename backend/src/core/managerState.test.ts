import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsBackendEnv } from "../testMode.js";
import { skipReason } from "../db/scratchDb.js";
import {
  stateOf, hasPlan, countsResult, inOwnWorkLists, inNewWorkLists,
  STATE_BADGE, WORK_STATES, hasPlanSql, stateSql, stateJoinSql,
  type WorkState,
} from "./managerState.js";

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

/**
 * 👤 #274–#274d — ТРИ СТАНИ МЕНЕДЖЕРА (рішення власника 01.09.2026).
 *
 * 🔴 ЧОМУ ФІКСТУРА, А НЕ ЖИВІ ДАНІ. Заміряно на проді 01.09.2026: результат нині
 * НЕАКТИВНИХ менеджерів за серпень — **0 ₴, 0 людей** (обидві метрики, ① і ②). Тобто
 * гейт «гроші звільненого лишаються в сумі команди», побудований на живих даних,
 * зеленітиме сам собою й не доводитиме нічого. Кожне твердження нижче перевіряється
 * на множині, де ВСІ ТРИ стани непорожні.
 */

const ST: Record<string, { crmActive: boolean; override: "finishing" | "dismissed" | null }> = {
  активний:   { crmActive: true,  override: null },
  завершує:   { crmActive: true,  override: "finishing" },
  звільнений: { crmActive: false, override: null },
  "звільнений адміном": { crmActive: true, override: "dismissed" },
};

test("#274 ТРИ СТАНИ: план — лише активному, РЕЗУЛЬТАТ — усім трьом", () => {
  assert.equal(stateOf(ST["активний"]), "active");
  assert.equal(stateOf(ST["завершує"]), "finishing");
  assert.equal(stateOf(ST["звільнений"]), "dismissed");
  assert.equal(stateOf(ST["звільнений адміном"]), "dismissed",
    "🔴 рішення адміна «звільнений» не спрацювало — стан живе не там, де його ставлять");

  // 🔴 ГОЛОВНЕ ПРАВИЛО ВЛАСНИКА: результат рахується В УСІХ ТРЬОХ станах.
  for (const s of WORK_STATES) assert.equal(countsResult(s), true,
    `🔴 результат стану «${s}» перестав рахуватись — це і є «гроші зникли з суми команди»`);

  // План — тільки активному. «Завершує» плану не має ВЗАГАЛІ (дослівна вимога).
  assert.equal(hasPlan("active"), true);
  assert.equal(hasPlan("finishing"), false, "🔴 «завершує» отримав план — знаменник поїде");
  assert.equal(hasPlan("dismissed"), false);

  // Позначка є у двох станів і НЕМАЄ в активного: підпис «активний» у кожному рядку — шум.
  assert.equal(STATE_BADGE.active, "");
  assert.equal(STATE_BADGE.finishing, "завершує");
  assert.equal(STATE_BADGE.dismissed, "звільнений");
});

test("#274b 🪞 ДЗЕРКАЛО СПИСКІВ: «завершує» лишається у СВОЇХ, зникає з НОВОЇ роботи", () => {
  /**
   * Власник 01.09.2026, дослівно: «так нового не бере». Межа проходить не по
   * «видно / не видно», а по ПРИЗНАЧЕННЮ НОВОЇ РОБОТИ — і без другої половини цього
   * гейта «завершує» був би просто синонімом звільненого.
   */
  assert.equal(inOwnWorkLists("finishing"), true,
    "🔴 «завершує» зник зі списків СВОЇХ угод — а він саме їх і доводить до кінця");
  assert.equal(inNewWorkLists("finishing"), false,
    "🔴 «завершує» лишився у виборі виконавця НОВОЇ угоди — йому призначать роботу");
  // 🪞 Обидві половини мусять розрізняти стани, інакше їх тримає константа.
  assert.equal(inOwnWorkLists("active"), true);
  assert.equal(inNewWorkLists("active"), true);
  assert.equal(inOwnWorkLists("dismissed"), false,
    "🔴 звільнений лишився в робочих списках");
  assert.equal(inNewWorkLists("dismissed"), false);
  assert.notDeepEqual(
    WORK_STATES.map(inOwnWorkLists), WORK_STATES.map(inNewWorkLists),
    "🔴 два списки поводяться однаково — тоді стан «завершує» не має сенсу взагалі");
});

test("#274c ЗНАМЕННИК ДВОБІЧНИЙ: «завершує» поза ним, активний — у ньому", () => {
  /**
   * 🔴 Двобічність тут не формальність. Односторонній гейт «завершує не в знаменнику»
   * зеленіє й тоді, коли знаменник порожній ЗОВСІМ — тобто коли планів позбавили всіх.
   */
  const denom = (rows: { crmActive: boolean; override: "finishing" | "dismissed" | null }[]) =>
    rows.filter((r) => hasPlan(stateOf(r))).length;
  const all = [ST["активний"], ST["активний"], ST["завершує"], ST["звільнений"], ST["звільнений адміном"]];
  assert.equal(denom(all), 2, "🔴 у знаменнику не рівно активні");
  assert.equal(denom([ST["завершує"]]), 0, "⬅ «завершує» потрапив у знаменник");
  assert.equal(denom([ST["активний"]]), 1, "➡ активного викинули зі знаменника — план нема кому ставити");

  // SQL-дзеркало чистої функції: обидві форми мусять казати одне.
  const sql = hasPlanSql("m", "m.is_active");
  assert.ok(sql.includes("= 'active'"), "🔴 предикат плану більше не звіряється зі станом");
  /**
   * 🔴 ПЕРЕВІРКА НА ПРИСУТНІСТЬ СЛОВА «finishing» У ВИРАЗІ — БЕЗЗУБА, і я на цьому
   * спіймався саботажем: `WHEN false THEN 'finishing'` лишає слово на місці, а стан
   * читати перестає. Тому твердження — про те, скільки гілок СПРАВДІ читають таблицю
   * стану: обидві (dismissed і finishing). Одна = стан наполовину загублений.
   */
  const branches = (stateSql("m").match(/mws\.state\s*=/g) ?? []).length;
  assert.equal(branches, 2,
    `🔴 гілок, що читають таблицю стану, ${branches} замість 2 — стан, який не читають, ` +
    "не існує, хоч би що стояло в THEN");
  assert.ok(stateSql("m").includes("'dismissed'") && stateSql("m").includes("'finishing'"),
    "🔴 SQL-вираз стану не знає всіх станів — на екрані зʼявиться стан, якого немає в БД");
  assert.ok(stateJoinSql("m").includes("manager_work_state"),
    "🔴 join більше не читає таблицю стану — стан мовчки стане завжди 'active'");
});

/**
 * #274d — 🔴 ГОЛОВНИЙ ГЕЙТ ПРОХОДУ: СТАН ПЕРЕЖИВАЄ ТІК СИНКУ.
 *
 * Не «ми впевнені, що синк туди не пише», а ПОВЕДІНКА: кладемо стан, проганяємо
 * справжній `syncManagers()`, дивимось, чи він на місці. Усе — в транзакції з
 * гарантованим ROLLBACK, той самий прийом, що `#51c`/`#50c`.
 *
 * 🧨 САБОТАЖ: покласти стан у `managers.is_active` замість окремої таблиці — тік
 * затирає його зашитим `is_active = true`, і гейт червоніє.
 */
/**
 * #274d — 🔴 ГОЛОВНИЙ ГЕЙТ ПРОХОДУ: СТАН ПЕРЕЖИВАЄ ТІК СИНКУ.
 *
 * Не «ми впевнені, що синк туди не пише», а ПОВЕДІНКА: кладемо стан, проганяємо той
 * самий UPSERT, що робить `syncKommo.syncManagers`, дивимось, чи стан на місці.
 *
 * 🔴 ЧОМУ SCRATCH-КЛАСТЕР, А НЕ ТРАНЗАКЦІЯ ПРОТИ ПРОДА. Проти прода набір ходить
 * read-only (роль `test_readonly`), тож там гейт МІГ БИ лише скіпнутись — тобто
 * головний гейт проходу не виконувався б ніде. На порожній базі він біжить завжди,
 * де є бінарі PostgreSQL, і нічого бойового не торкається.
 *
 * 🧨 САБОТАЖ: покласти стан у `managers.is_active` замість окремої таблиці — тік
 * затирає його зашитим `is_active = true`, і гейт червоніє. Саме це й сталось із
 * деактивацією Шевчука 06.08 11:11.
 */
test("#274d СТАН ПЕРЕЖИВАЄ ТІК СИНКУ (порожній кластер, справжній UPSERT синку)", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (5,'РПК-Яцика') ON CONFLICT DO NOTHING`);
    await c.query(
      `INSERT INTO managers (id,name,team_id,is_active,kommo_user_id)
       VALUES (33,'Шевчук Назар',5,true,'7181916') ON CONFLICT DO NOTHING`);
    await c.query(
      `INSERT INTO manager_work_state (manager_id, state, note) VALUES (33,'finishing','гейт #274d')`);

    /**
     * ДОСЛІВНА форма з `syncKommo.syncManagers` (рядки 142-149), включно із ЗАШИТИМ
     * `is_active = true` — саме воно й затирає будь-яке рішення, покладене в прапорець.
     */
    const syncTick = async () => c.query(
      `INSERT INTO managers (name, kommo_user_id, team_id, is_team_lead, is_active, email)
       VALUES ('Шевчук Назар','7181916',5,false,true,NULL)
       ON CONFLICT (kommo_user_id) DO UPDATE SET
         name = EXCLUDED.name, team_id = EXCLUDED.team_id,
         is_team_lead = EXCLUDED.is_team_lead, is_active = true,
         email = COALESCE(EXCLUDED.email, managers.email)`);

    // ⬅ КОНТРОЛЬ: спершу переконуємось, що тік справді ЩОСЬ робить із прапорцем.
    //    Без цього «стан вижив» означало б лише «тік не виконався» (правило 15).
    await c.query(`UPDATE managers SET is_active = false WHERE id = 33`);
    await syncTick();
    const flag = await c.query<{ is_active: boolean }>(`SELECT is_active FROM managers WHERE id=33`);
    assert.equal(flag.rows[0].is_active, true,
      "🔴 тік НЕ повернув `is_active` у true — отже саботажу не було що затирати, " +
      "і «стан вижив» нижче нічого не доводить");

    // ➡ І ГОЛОВНЕ: стан у своїй таблиці той самий тік НЕ ЧІПАЄ.
    const after = await c.query<{ state: string; note: string }>(
      `SELECT state, note FROM manager_work_state WHERE manager_id = 33`);
    assert.equal(after.rows[0]?.state, "finishing",
      "🔴 ТІК СИНКУ ЗАТЕР СТАН. Саме так зникла деактивація Шевчука 06.08 11:11: " +
      "рішення, покладене в прапорець, який синк перераховує, живе щонайбільше 30 хвилин");

    // 🪞 І стан справді доходить до знаменника — на тій самій базі, тим самим предикатом.
    const denom = await c.query<{ n: string }>(
      `SELECT COUNT(*) n FROM managers m ${stateJoinSql("m")} WHERE ${hasPlanSql("m", "m.is_active")}`);
    assert.equal(Number(denom.rows[0].n), 0,
      "🔴 «завершує» лишився у знаменнику «менеджерів із планом» — предикат стану не діє в SQL");
    await c.query(`DELETE FROM manager_work_state WHERE manager_id = 33`);
    const denom2 = await c.query<{ n: string }>(
      `SELECT COUNT(*) n FROM managers m ${stateJoinSql("m")} WHERE ${hasPlanSql("m", "m.is_active")}`);
    assert.equal(Number(denom2.rows[0].n), 1,
      "🔴 без рішення про стан людина ТЕЖ поза знаменником — предикат ріже всіх підряд");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #274e — ЖИВЕ ЯДРО: стан доходить до знаменника «менеджерів із планом».
 * Мовчить, поки жодного рішення не поставлено (сьогодні саме так — таблиця порожня),
 * і саме тому властивість тримає фікстура `#274c`, яка не скіпається ніколи.
 */
test("#274e ЖИВА БД: у знаменнику немає нікого зі станом, і Σ команди його не втрачає", needsBackendEnv(), async (t) => {
  const { pool } = await import("../db/pool.js");
  const st = await pool.query<{ state: string; n: string }>(
    `SELECT state, COUNT(*) n FROM manager_work_state GROUP BY state`);
  const { emptyPeriodSkip } = await import("../testMode.js");
  const total = st.rows.reduce((a, r) => a + Number(r.n), 0);
  const skip = emptyPeriodSkip("менеджерів із поставленим станом", total, "manager_work_state");
  if (skip) return t.skip(skip);

  const bad = await pool.query<{ id: number; name: string; state: string }>(
    `SELECT m.id, m.name, mws.state
       FROM plans p JOIN managers m ON m.id = p.manager_id
       ${stateJoinSql("m")}
      WHERE p.metric='payment_amount'
        AND date_trunc('month',p.plan_date) = date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv')
        AND NOT (${hasPlanSql("m", "m.is_active")})
      GROUP BY 1,2,3`);
  assert.deepEqual(bad.rows.map((r) => `${r.name} (${r.state})`), [],
    "🔴 людина зі станом «завершує»/«звільнений» досі має план поточного місяця — " +
    "знаменник «менеджерів із планом» завищений рівно на цих людей");
});
