import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { missedSummarySql, missedByManagerSql, missedListSql } from "./missedCallsRules.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");

/**
 * #3396 🪞 — ОДИН ДЗВІНОК КЛІЄНТА = ОДИН ПРОПУЩЕНИЙ (задача 7368), на порожньому кластері, екран І задачі.
 * Фікстура — живі форми зі звірки Юлі за 27.10: дзвінок на «Чергування» трьома плечима; узятий дзвінок, поруч з яким
 * паралельне плече «не відповів»; дзвінок не черговому у час чергування; дзвінок, що не дійшов ні до кого; межа 1 хв
 * з обох боків (59 с — одне, 62 с — два); дзвінок через північ.
 * Червоніє, якщо: склеювати лише в межах менеджера (як було — 180 замість 136); рахувати плече «не відповів» узятого
 * дзвінка; не чергувати двох чергових; ставити чергового на дзвінок, що до нього не йшов; різати дзвінок на межі доби;
 * або якщо задачі «Передзвонити» підуть не тим, кого бачить екран.
 */
test("#3396 🪞 ПРОПУЩЕНІ · ОДИН ДЗВІНОК: плечі склеєні через менеджерів, узятий — не пропущений, черговий по черзі; екран == задачі", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { signalGroupsSql } = await import("./missedCallSignal.js");
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (13,'Реклама') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES
      (101,'Черговий А',13,true),(102,'Черговий Б',13,true),(103,'Не черговий',13,true) ON CONFLICT DO NOTHING`);
    // Двоє вечірніх чергових 27.10 (як того дня в проді); А поставлено першим.
    await c.query(`INSERT INTO duty_schedule(id,duty_date,manager_id,team_id,shift) VALUES
      (1,'2026-10-27',101,13,'evening'),(2,'2026-10-27',102,13,'evening')`);
    let seq = 0;
    const call = (at: string, type: string, disp: string, sec: number, mgr: number | null, phone: string) =>
      c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,manager_id,client_phone)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`, [`ua_${String(++seq).padStart(3, "0")}`, at, type, disp, sec, mgr, phone]);
    const P = (n: number) => `38000000000${String(n)}`;
    const D = "2026-10-27";  // після переходу на зимовий час: +02

    // P1 · «Чергування» трьома плечима: вхід без менеджера + обидва чергові → ОДИН, першому черговому в черзі
    await call(`${D} 19:18:01+02`, "in", "NO ANSWER", 0, null, P(1));
    await call(`${D} 19:18:13+02`, "transitin", "BUSY", 0, 101, P(1));
    await call(`${D} 19:18:13+02`, "transitin", "NO ANSWER", 0, 102, P(1));
    // P2 · такий самий другий дзвінок того вечора → другому черговому (по черзі)
    await call(`${D} 19:30:00+02`, "in", "NO ANSWER", 0, null, P(2));
    await call(`${D} 19:30:10+02`, "transitin", "NO ANSWER", 0, 101, P(2));
    await call(`${D} 19:30:10+02`, "transitin", "NO ANSWER", 0, 102, P(2));
    // P3 · узятий: 103 говорив 64 с, паралельне плече черговому А «не відповів» → НЕ пропущений
    await call(`${D} 19:35:00+02`, "in", "REPEATED", 64, 103, P(3));
    await call(`${D} 19:35:11+02`, "transitin", "NO ANSWER", 0, 101, P(3));
    // P4 · у час чергування, але дзвонило лише 103 → відповідальний 103, а не черговий
    await call(`${D} 19:40:00+02`, "transitin", "NO ANSWER", 0, 103, P(4));
    // P5 · не дійшов ні до кого → «без відповідального»
    await call(`${D} 11:00:00+02`, "in", "NO ANSWER", 0, null, P(5));
    // P6 · межа 1 хв: 59 с — те саме, 62 с — новий дзвінок; поза чергуванням → перший, кому дзвонило
    await call(`${D} 12:00:00+02`, "transitin", "NO ANSWER", 0, 103, P(6));
    await call(`${D} 12:00:59+02`, "transitin", "NO ANSWER", 0, 101, P(6));
    await call(`${D} 12:02:01+02`, "transitin", "NO ANSWER", 0, 103, P(6));
    // P7 · через північ: 23:59:40 і 00:00:10 — один дзвінок, день його початку
    await call(`${D} 23:59:40+02`, "in", "NO ANSWER", 0, null, P(7));
    await call(`2026-10-28 00:00:10+02`, "transitin", "NO ANSWER", 0, 103, P(7));

    const run = async (q: { sql: string; params: unknown[] }) => (await c.query(q.sql, q.params)).rows as Record<string, unknown>[];

    const sum = (await run(missedSummarySql(D, D, {})))[0];
    assert.equal(sum.missed, 7, `🔴 пропущених ${String(sum.missed)}, а дзвінків 7 (P1, P2, P4, P5, P6×2, P7)`);
    assert.equal(sum.ownerless, 1, "🔴 «без відповідального» ≠ 1 (лише P5 не дійшов ні до кого)");

    const by = new Map((await run(missedByManagerSql(D, D, {}))).map((r) => [r.manager_id ?? "none", r.missed]));
    assert.deepEqual(Object.fromEntries(by), { 101: 1, 102: 1, 103: 4, none: 1 },
      "🔴 відповідальні розійшлись: А — P1, Б — P2 (по черзі), 103 — P4, P6×2, P7; без відповідального — P5");

    const list = await run(missedListSql(D, {}));
    const phonesOf = (m: number | null) => list.filter((r) => (r.manager_id ?? null) === m).map((r) => r.client_phone).sort();
    assert.deepEqual(phonesOf(101), [P(1)], "🔴 перший дзвінок двом черговим не пішов першому в черзі");
    assert.deepEqual(phonesOf(102), [P(2)], "🔴 другий дзвінок двом черговим не пішов другому — черги немає");
    assert.ok(!list.some((r) => r.client_phone === P(3)), "🔴 узятий дзвінок (64 с розмови) лишився пропущеним");
    assert.equal(list.length, sum.missed, "🔴 список дня розійшовся з числом");

    // Дзвінок через північ — у день початку, і ЛИШЕ там.
    assert.equal((await run(missedSummarySql("2026-10-28", "2026-10-28", {})))[0].missed, 0, "🔴 дзвінок через північ розрізано на два дні");
    assert.equal((await run(missedSummarySql(D, "2026-10-28", {})))[0].missed, 7, "🔴 за два дні дзвінок через північ полічено двічі");

    // Скоуп звужує відповідь, а не розрахунок: зріз менеджера Б бачить РІВНО свій дзвінок, черга та сама.
    assert.equal((await run(missedSummarySql(D, D, { managerId: 102 })))[0].missed, 1, "🔴 зріз менеджера переставив чергу чергових");

    // ── ЗАДАЧІ «Передзвонити» на тих самих даних (о 20:00: вікно 17:00–19:55) — ті самі люди, що на екрані.
    const groups = (await c.query<{ manager_id: number; client_phone: string; missed_total: number }>(
      signalGroupsSql(new Date("2026-10-27T20:00:00+02:00")).sql, [new Date("2026-10-27T20:00:00+02:00")])).rows
      .map((g) => `${String(g.manager_id)}:${g.client_phone}:${String(g.missed_total)}`).sort();
    assert.deepEqual(groups, [`101:${P(1)}:1`, `102:${P(2)}:1`, `103:${P(4)}:1`],
      "🔴 задачі «Передзвонити» пішли не тим, кого бачить екран (або по узятому дзвінку P3)");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #3397 — ПРОВОДКА: екран і задачі беруть дзвінки з ОДНОГО правила (`callUnitsCte`), а склейка в межах менеджера
 * з основи пропущених прибрана. Наступник `#432` (знятий: його твердження «LAG у межах менеджера» — саме те, що
 * дублювало дзвінок на схему). Плечі звужуються до вхідних ДО склейки (вихідний недодзвін не злипається з вхідним),
 * ключ склейки — номер клієнта, не менеджер.
 * Червоніє, якщо екран чи задачі повернуться до власної склейки, або LAG побіжить по сирій таблиці.
 */
test("#3397 ПРОПУЩЕНІ · ПРОВОДКА: екран і задачі — одне правило дзвінка; склейка по номеру після звуження до вхідних", () => {
  const units = SRC("core/missedCallUnits.ts");
  for (const f of ["core/missedCallsRules.ts", "core/missedCallSignal.ts"]) {
    assert.match(SRC(f), /\$\{callUnitsCte\(/, `🔴 ${f} рахує пропущені не з правила «один дзвінок»`);
  }
  const base = missedSummarySql("2026-10-27", "2026-10-27", {}).sql;
  assert.match(base, /FROM call_units rc/, "🔴 основа екрана пропущених — не дзвінки, а плечі");
  assert.doesNotMatch(base, /PARTITION BY b\.manager_id/, "🔴 повернулась склейка в межах менеджера — дзвінок на схему знову дасть 3 пропущені");
  assert.match(units, /PARTITION BY l\.ckey ORDER BY l\.calldate, l\.uniqueid/, "🔴 ключ склейки — не номер клієнта");
  assert.match(units, /FROM ringostat_calls rc\s+WHERE rc\.call_type IN \(/, "🔴 плечі не звужені до вхідних до склейки");
  assert.doesNotMatch(units, /LAG\(rc\./, "🔴 склейка побігла по сирій таблиці");
});
