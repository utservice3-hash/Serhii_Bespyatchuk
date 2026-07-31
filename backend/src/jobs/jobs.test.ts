import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";

/**
 * ТЕСТ #9 — ДЖОБИ НЕ ПАДАЮТЬ МОВЧКИ.
 *
 * 🔴 Головна ідея: доказом здоров'я є **успіх останнього прогону і свіжість даних**,
 * а НЕ відсутність винятку. Джоба, яка тихо нічого не зробила, з погляду «немає
 * помилок» виглядає ідеально — і саме так `last_event_at` застряг на 09.07, через що
 * липневі гроші недорахувались на 62 315 ₴, а звірка цього не бачила.
 *
 * Тому перевіряємо ВОТЕРМАРКИ: відставання > 2× частоти джоби = поломка.
 */

const load = async () => ({ pool: (await import("../db/pool.js")).pool });

/** Частоти з `jobs/index.ts`. Поріг = 2× частоти, як у `checkFreshness`. */
const WATERMARKS: { col: string; everyMin: number; why: string }[] = [
  { col: "last_event_at", everyMin: 30, why: "money-критичний: живить core/money.ts (анкери по стадіях)" },
  { col: "last_success_at", everyMin: 30, why: "основний синк угод" },
  { col: "last_activity_note_at", everyMin: 180, why: "живить «застряглі угоди»" },
  { col: "last_transfer_at", everyMin: 1440, why: "передані заявки лідогену" },
];

test("#9.1 СИНК: останній прохід УСПІШНИЙ, а не просто «без винятку»", needsDb(), async () => {
  const { pool } = await load();
  const r = await pool.query<{ last_success_at: Date | null; consecutive_failures: number; last_error: string | null }>(
    `SELECT last_success_at, consecutive_failures, last_error FROM sync_state WHERE id = 1`);
  const row = r.rows[0];
  assert.ok(row, "sync_state порожній — синк жодного разу не звітував (порожній результат = провал)");
  assert.ok(row.last_success_at, "last_success_at порожній: успішного проходу НЕ БУЛО жодного разу");
  assert.equal(Number(row.consecutive_failures), 0,
    `синк падає поспіль ${row.consecutive_failures} разів, остання помилка: ${row.last_error ?? "—"}`);
  const ageMin = (Date.now() - new Date(row.last_success_at).getTime()) / 60000;
  assert.ok(ageMin <= 60,
    `останній успішний синк ${Math.round(ageMin)} хв тому (норма ≤60 при частоті 30 хв) — джоба стоїть`);
});

test("#9.2 🔴 ВОТЕРМАРКИ: жоден не застряг (застряглий тихо ламає метрики)", needsDb(), async () => {
  const { pool } = await load();
  const cols = (await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'sync_state'`)).rows.map((r) => r.column_name);
  const present = WATERMARKS.filter((w) => cols.includes(w.col));
  assert.ok(present.length > 0, "у sync_state немає жодного відомого вотермарка — перевіряти нічого");

  const row = (await pool.query<Record<string, Date | null>>(
    `SELECT ${present.map((w) => w.col).join(", ")} FROM sync_state WHERE id = 1`)).rows[0];
  assert.ok(row, "sync_state порожній");

  const stale: string[] = [];
  for (const w of present) {
    const v = row[w.col];
    if (!v) { stale.push(`${w.col}: NULL — джоба не рухала вотермарк ЖОДНОГО разу (${w.why})`); continue; }
    const ageMin = (Date.now() - new Date(v).getTime()) / 60000;
    if (ageMin > w.everyMin * 2) {
      stale.push(`${w.col}: відстає ${Math.round(ageMin)} хв при частоті ${w.everyMin} хв (${w.why})`);
    }
  }
  assert.deepEqual(stale, [],
    "🔴 застряглі вотермарки — метрики ламаються ТИХО:\n  " + stale.join("\n  "));
});

test("#9.3 KOMMO-ЗАМОК не залипнув (інакше синк вічно пропускає прохід)", needsDb(), async () => {
  const { pool } = await load();
  const has = (await pool.query(`SELECT to_regclass('public.job_locks') t`)).rows[0].t;
  if (!has) return; // таблиці немає — нічого перевіряти
  // Колонка називається `name` (не `job`) — перевірено на схемі прода 31.07.2026.
  const rows = (await pool.query<{ name: string; heartbeat_at: Date }>(
    `SELECT name, heartbeat_at FROM job_locks`)).rows;
  const stuck = rows.filter((r) => (Date.now() - new Date(r.heartbeat_at).getTime()) / 60000 > 120);
  assert.deepEqual(stuck.map((r) => r.name), [],
    "замок висить >2 год: syncKommo пропускатиме проходи, а health лишатиметься зеленим");
});

test("#9.4 СВІЖІСТЬ ДАНИХ: у БД є угоди за сьогодні або вчора", needsDb(), async () => {
  const { pool } = await load();
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) n FROM deals
      WHERE (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= (CURRENT_DATE - INTERVAL '2 days')`);
  assert.ok(Number(r.rows[0].n) > 0,
    "за останні 2 дні жодної нової угоди — або синк стоїть, або CRM порожня; мовчазний нуль тут неприпустимий");
});

test.after(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db/pool.js");
  await pool.end();
});
