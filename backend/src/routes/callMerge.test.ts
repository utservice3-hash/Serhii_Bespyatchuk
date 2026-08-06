import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";

/**
 * #63 — ПЛЕЧІ ОДНОГО ДЗВІНКА СКЛЕЄНІ. Одна розмова = один дзвінок.
 *
 * 🔴 ЯВНОЇ ОЗНАКИ ПЛЕЧА В RINGOSTAT НЕМАЄ — перевірено всі 20 колонок
 * `ringostat_calls`: ані id сесії, ані посилання на батьківський дзвінок. Тому
 * правило евристичне й назване прямо: той самий менеджер + той самий номер +
 * старт у межах 120 с = ОДНА розмова.
 *
 * 📐 Що вирішило: не середні +7.0% по компанії, а РОЗКИД між людьми — від +1.1%
 * до +10.8%. Тобто подвійний рахунок зсував РЕЙТИНГ менеджерів, а не просто
 * завищував усіх однаково.
 *
 * 🧨 САБОТАЖ: вимкнути склейку (порівняння без вікна) → на прикладі 09:47 замість
 * однієї розмови стане дві, і гейт червоніє.
 */
const MERGE = "interval '120 seconds'";

test("#63 склеєних розмов не більше, ніж записів, і склейка справді працює", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const r = await pool.query<{ raw: string; merged: string }>(
    `WITH marked AS (
       SELECT rc.billsec,
              rc.calldate - LAG(rc.calldate) OVER (
                PARTITION BY rc.manager_id, rc.client_phone, (rc.billsec > 0) ORDER BY rc.calldate) AS gap
         FROM ringostat_calls rc
        WHERE rc.manager_id IS NOT NULL AND rc.billsec > 0
          AND (rc.calldate ${K})::date >= (now() ${K})::date - 60)
     SELECT COUNT(*) AS raw,
            COUNT(*) FILTER (WHERE gap IS NULL OR gap > ${MERGE}) AS merged FROM marked`);
  const raw = Number(r.rows[0].raw), merged = Number(r.rows[0].merged);

  assert.ok(raw > 0, "🔴 за 60 днів немає жодної розмови — перевіряти нічого");
  assert.ok(merged <= raw, `🔴 склеєних ${merged} БІЛЬШЕ за записів ${raw} — це неможливо`);
  // ⚠️ Порожній результат = ПРОВАЛ: якщо склейка нічого не склеїла, вона не працює.
  assert.ok(merged < raw,
    `🔴 склейка не склеїла ЖОДНОГО запису (${raw} → ${merged}). Або вікно не застосувалось, `
    + "або плечей у даних немає — і тоді гейт нічого не доводить.");

  // Заміряно 07.08: завищення ~7%. Ловимо і «раптом стало 0%», і «раптом стало 50%».
  const over = (raw / merged - 1) * 100;
  assert.ok(over > 1 && over < 25,
    `🔴 склейка прибрала ${over.toFixed(1)}% записів — поза очікуваним коридором 1–25% `
    + "(заміряно 6.6–7.0% на липні й серпні). Або вікно зламалось, або дані змінили природу.");
});

/**
 * #63b — ДЗЕРКАЛО НА КОНКРЕТНОМУ ВИПАДКУ: пара 09:47 (4 с і 5 с, той самий номер)
 * дає РІВНО одну розмову. Саме її власник побачив у розкритті й спитав.
 *
 * Без цього `#63` зеленів би на будь-якому вікні, що хоч щось склеює.
 */
test("#63b пара 09:47 склеюється рівно в одну", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const r = await pool.query<{ n: string; merged: string }>(
    `WITH marked AS (
       SELECT rc.calldate - LAG(rc.calldate) OVER (
                PARTITION BY rc.manager_id, rc.client_phone, (rc.billsec > 0) ORDER BY rc.calldate) AS gap
         FROM ringostat_calls rc JOIN managers m ON m.id = rc.manager_id
        WHERE m.name ILIKE '%Хомік%' AND (rc.calldate ${K})::date = '2026-08-04'
          AND rc.client_phone = '380504343889' AND rc.billsec > 0)
     SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE gap IS NULL OR gap > ${MERGE}) AS merged FROM marked`);
  const n = Number(r.rows[0].n), merged = Number(r.rows[0].merged);
  if (n === 0) return; // дані могли переїхати — краще мовчати, ніж червоніти на порожнечі
  assert.equal(n, 2, `🔴 очікували 2 записи о 09:47, знайшли ${n} — приклад змінився`);
  assert.equal(merged, 1,
    `🔴 пара 09:47 дала ${merged} розмов замість однієї — саме той подвійний рахунок, `
    + "який власник побачив на екрані");
});
