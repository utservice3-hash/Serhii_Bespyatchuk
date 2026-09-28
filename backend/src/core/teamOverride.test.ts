import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import {
  effectiveTeamId, overrideLabel, LEVENTOVA_KOMMO_USER_ID, COMMERCIAL_TEAM_NAME,
} from "./teamOverride.js";

const SRC = (p: string) => path.join(import.meta.dirname, "..", "..", "src", p);
const SCHEMA = SRC("db/schema.sql");
const read = (p: string) => readFileSync(SRC(p), "utf8");

/**
 * 🧭 #709–#709d — ПЕРЕВИЗНАЧЕННЯ КОМАНДИ (ТЗ 23.09.2026, п.1: архів групи Ковтонюк,
 * Левентова → «Комерційний відділ»).
 *
 * Клас, що стережеться: рішення, покладене туди, що синк перераховує, живе ≤30 хв
 * (Шевчук 06.08 11:11). Тому перевизначення — окрема таблиця, і синк її ЧИТАЄ.
 */

test("#709 effectiveTeamId: нема рядка → CRM; рядок з командою → команда; рядок з NULL → без команди", () => {
  // По ОБИДВА боки кожної межі (правило 11).
  assert.equal(effectiveTeamId(11, undefined), 11, "🔴 без рядка команда з CRM зникла");
  assert.equal(effectiveTeamId(null, undefined), null);
  assert.equal(effectiveTeamId(11, { teamId: 5, note: null }), 5, "🔴 перевизначення не бʼє групу CRM");
  assert.equal(effectiveTeamId(null, { teamId: 5, note: null }), 5);
  assert.equal(effectiveTeamId(11, { teamId: null, note: "архів" }), null,
    "🔴 рядок із NULL прочитано як «рядка немає» — архів групи не спрацює");
  // Підпис: три стани — три різні тексти.
  const nm = (id: number) => ({ 5: "Яцик" } as Record<number, string>)[id];
  const labels = new Set([overrideLabel(null, nm), overrideLabel({ teamId: null, note: null }, nm), overrideLabel({ teamId: 5, note: null }, nm)]);
  assert.equal(labels.size, 3, "🔴 два стани перевизначення мають однаковий підпис");
});

test("#709b синк читає таблицю, а не хардкод; хардкод Шевчука переїхав у сид, а не зник", () => {
  const sync = read("jobs/syncKommo.ts");
  assert.doesNotMatch(sync, /const TEAM_OVERRIDES\s*[:=]/, "🔴 хардкод TEAM_OVERRIDES повернувся в синк");
  assert.match(sync, /FROM manager_team_overrides/, "🔴 синк не читає manager_team_overrides — правка адміна помре за тік");
  assert.match(sync, /effectiveTeamId\(/, "🔴 синк не застосовує effectiveTeamId — таблицю читає, але не використовує");
  const schema = readFileSync(SCHEMA, "utf8");
  // 🪞 Дзеркало: перенесення ≠ втрата. Шевчук (7181916 → група 335511) має бути в сиді.
  assert.match(schema, /manager_team_overrides[\s\S]*7181916[\s\S]*335511/, "🔴 рішення 05.08 (Шевчук → Яцик) загубилось при переїзді з коду в сид");
  assert.match(schema, new RegExp(LEVENTOVA_KOMMO_USER_ID), "🔴 сид Левентової відсутній");
  assert.match(schema, new RegExp(COMMERCIAL_TEAM_NAME), "🔴 команди «Комерційний відділ» у сиді немає");
});

test("#709c роут застосовує перевизначення ОДРАЗУ й пише історію; матриця знає всі три роути", () => {
  const routes = read("routes/settings.ts");
  const put = routes.slice(routes.indexOf('settingsRouter.put("/team-overrides/'), routes.indexOf('settingsRouter.post("/teams"'));
  assert.match(put, /UPDATE managers SET team_id/, "🔴 роут лише пише таблицю — на екрані нічого не зміниться до тіка синку");
  assert.match(put, /INSERT INTO manager_team_history/, "🔴 зміна команди без рядка історії — розріз по командах не дізнається");
  assert.match(put, /DELETE FROM manager_team_overrides/, "🔴 «з CRM» не знімає рядок — дія стала незворотною через інтерфейс");
  const matrix = read("auth/accessMatrix.ts");
  for (const p of ["/api/settings/team-overrides\"", "/api/settings/team-overrides/:kommoUserId", "/api/settings/teams\""]) {
    assert.ok(matrix.includes(p), `🔴 роуту ${p} немає в матриці — «зелено там, куди не дивились»`);
  }
});

/**
 * #709d — ЖИВИЙ SQL на порожньому кластері: сиди створюють рядки, повторний прогін
 * схеми НЕ затирає правку адміна, і форма UPSERT синку з effectiveTeamId справді
 * виводить людину з групи (архів) і садить у команду без Kommo-групи (Левентова).
 */
test("#709d ЖИВИЙ SQL: сиди ідемпотентні, правка адміна переживає схему, синк застосовує перевизначення", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    const schema = readFileSync(SCHEMA, "utf8");
    await c.query(schema);
    // Команди з CRM, як на проді: Яцик (335511) і група Ковтонюк (578664).
    await c.query(`INSERT INTO teams (id,name,kommo_group_id) VALUES (5,'РПК - Яцика',335511),(11,'Ковтонюк (лідоген)',578664) ON CONFLICT DO NOTHING`);
    // Без команди Яцика сид НЕ сіє нікого (щоб не покласти неправду) — контроль обох боків.
    assert.equal((await c.query(`SELECT COUNT(*) n FROM manager_team_overrides`)).rows[0].n, "0",
      "🔴 сид поклав рядки, коли цільової команди ще не існувало");
    await c.query(schema); // другий прогін — команди є, сиди мають що вставляти
    const ov = await c.query<{ k: string; team_id: number | null }>(`SELECT kommo_user_id::text k, team_id FROM manager_team_overrides ORDER BY 1`);
    const byK = new Map(ov.rows.map((r) => [r.k, r.team_id]));
    assert.equal(byK.get("7181916"), 5, "🔴 сид Шевчука не знайшов команду Яцика за kommo_group_id");
    const commercial = await c.query<{ id: number; kommo_group_id: string | null }>(`SELECT id, kommo_group_id FROM teams WHERE name = $1`, [COMMERCIAL_TEAM_NAME]);
    assert.equal(commercial.rows.length, 1, "🔴 «Комерційний відділ» не створено або створено двічі");
    assert.equal(commercial.rows[0].kommo_group_id, null, "🔴 команда лише дашборда отримала Kommo-групу");
    assert.equal(byK.get(LEVENTOVA_KOMMO_USER_ID), commercial.rows[0].id, "🔴 Левентова не в «Комерційному відділі»");
    for (const k of ["12812476", "13369800", "13656180", "14731552"]) {
      assert.ok(byK.has(k) && byK.get(k) === null, `🔴 лідген ${k} групи Ковтонюк не виведений «без команди»`);
    }

    // ⬅ Правка адміна переживає повторний прогін схеми (сиди під NOT EXISTS).
    await c.query(`UPDATE manager_team_overrides SET team_id = 5 WHERE kommo_user_id = 13369800`);
    await c.query(`DELETE FROM manager_team_overrides WHERE kommo_user_id = 13656180`);
    await c.query(schema);
    const again = await c.query<{ k: string; team_id: number | null }>(`SELECT kommo_user_id::text k, team_id FROM manager_team_overrides WHERE kommo_user_id IN (13369800, 13656180)`);
    assert.deepEqual(again.rows.map((r) => [r.k, r.team_id]), [["13369800", 5]],
      "🔴 повторний прогін схеми затер правку адміна або воскресив знятий рядок");
    assert.equal((await c.query(`SELECT COUNT(*) n FROM teams WHERE name=$1`, [COMMERCIAL_TEAM_NAME])).rows[0].n, "1", "🔴 команда дублюється на кожному прогоні");

    // ➡ Синк: ДОСЛІВНА форма UPSERT + effectiveTeamId. Сердюк у CRM у групі 578664.
    const crmTeam = 11;
    const rows = await c.query<{ k: string; team_id: number | null }>(`SELECT kommo_user_id::text k, team_id FROM manager_team_overrides`);
    const overrides = new Map(rows.rows.map((r) => [r.k, { teamId: r.team_id, note: null }]));
    const tick = async (name: string, kommoId: string) => c.query(
      `INSERT INTO managers (name, kommo_user_id, team_id, is_team_lead, is_active, email)
       VALUES ($1,$2,$3,false,true,NULL)
       ON CONFLICT (kommo_user_id) DO UPDATE SET team_id = EXCLUDED.team_id, is_active = true`,
      [name, kommoId, effectiveTeamId(crmTeam, overrides.get(kommoId))]);
    await tick("Сердюк", "12812476");
    await tick("Левентова", LEVENTOVA_KOMMO_USER_ID);
    await tick("Хтось без перевизначення", "999001");
    const m = await c.query<{ k: string; team_id: number | null }>(`SELECT kommo_user_id::text k, team_id FROM managers ORDER BY 1`);
    const mk = new Map(m.rows.map((r) => [r.k, r.team_id]));
    assert.equal(mk.get("12812476"), null, "🔴 тік синку повернув лідгена в архівовану групу");
    assert.equal(mk.get(LEVENTOVA_KOMMO_USER_ID), commercial.rows[0].id, "🔴 тік синку вибив Левентову з «Комерційного відділу»");
    assert.equal(mk.get("999001"), crmTeam, "🔴 без перевизначення людина втратила групу з CRM — предикат ріже всіх підряд");
    // Порожня команда зникає зі списку — той самий предикат, що в routes/teams.ts.
    const shown = await c.query<{ id: number }>(`SELECT id FROM teams t WHERE EXISTS (SELECT 1 FROM managers m WHERE m.team_id = t.id AND m.is_active) ORDER BY id`);
    assert.equal(shown.rows.some((r) => r.id === 11), true, "контроль: у фікстурі група 11 має «Хтось» — вона ще видна (правило 15)");
    await c.query(`UPDATE managers SET team_id = NULL WHERE kommo_user_id = 999001`);
    const shown2 = await c.query<{ id: number }>(`SELECT id FROM teams t WHERE EXISTS (SELECT 1 FROM managers m WHERE m.team_id = t.id AND m.is_active)`);
    assert.equal(shown2.rows.some((r) => r.id === 11), false, "🔴 команда без активних не сховалась — архів не спрацював у списках");
  } finally {
    await c.end();
    scratch.dispose();
  }
});
