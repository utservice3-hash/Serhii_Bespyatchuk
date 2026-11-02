import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { needsApi, API_BASE } from "../testMode.js";
import { kyivMonthBounds } from "./dates.js";
import { shipWeekOf } from "./shipWeek.js";
import type { DispatchCohortRow } from "./reportCuts.js";

/**
 * 🚚 ЗВІТ КВП, РЕЖИМ «ВІДПРАВЛЕНІ АВТО» (задача 7185, макет затверджено 02.11.2026). Тиждень = авто з «Датою
 * загрузки» в тижні (той самий анкер, що «Поїхали» / режим «Активність»), а смужка — що з ними ЗАРАЗ:
 * оплачено («Успішно» або «Оплата отримана») · без оплати («Закрито і не реалізовано») · чекаємо (решта).
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");

const row = (day: string, o: Partial<DispatchCohortRow>): DispatchCohortRow => ({
  managerId: 1, day, deals: 0, sum: 0, paidDeals: 0, paidSum: 0, awaitDeals: 0, awaitSum: 0,
  awaitDatedSum: 0, awaitNoDateSum: 0, lostDeals: 0, lostSum: 0, ...o,
});

/**
 * #3320 — ТИЖДЕНЬ «ВІДПРАВЛЕНИХ» БЕЗ ЗАЛИШКУ І БЕЗ ЧУЖИХ ДНІВ. Дні когорти складаються в тиждень включно з обома
 * межами (понеділок і неділя тижня), сусідні дні не заходять; «чекаємо» = очікування МІНУС «без оплати», тож
 * оплачено + чекаємо + без оплати == відправлено — і за кількістю, і за сумою.
 * 🧨 Червоніє, якщо «без оплати» лишиться всередині «чекаємо» (машина рахується двічі), якщо межа тижня стане
 * виключною або якщо в тиждень потрапить день сусіднього.
 */
test("#3320 тиждень «Відправлених авто»: оплачено + чекаємо + без оплати == відправлено, межі тижня включно", () => {
  const rows = [
    row("2026-10-11", { deals: 9, sum: 9000, paidDeals: 9, paidSum: 9000 }),                      // неділя ПОПЕРЕДНЬОГО тижня
    row("2026-10-12", { deals: 4, sum: 10000, paidDeals: 1, paidSum: 2000, awaitDeals: 3, awaitSum: 8000, lostDeals: 1, lostSum: 3000 }), // понеділок
    row("2026-10-15", { deals: 2, sum: -500, paidDeals: 1, paidSum: -1500, awaitDeals: 1, awaitSum: 1000 }), // мінусова угода
    row("2026-10-18", { deals: 3, sum: 6000, paidDeals: 0, paidSum: 0, awaitDeals: 3, awaitSum: 6000, lostDeals: 2, lostSum: 4000 }), // неділя
    row("2026-10-19", { deals: 7, sum: 7000, awaitDeals: 7, awaitSum: 7000 }),                     // понеділок НАСТУПНОГО
  ];
  const w = shipWeekOf(rows, "2026-10-12", "2026-10-18");
  assert.deepEqual(w, { deals: 9, sum: 15500, paidDeals: 2, paidSum: 500, waitDeals: 4, waitSum: 8000, lostDeals: 3, lostSum: 7000 });
  assert.equal(w.paidDeals + w.waitDeals + w.lostDeals, w.deals, "частини за кількістю не дають цілого");
  assert.equal(w.paidSum + w.waitSum + w.lostSum, w.sum, "частини за сумою не дають цілого");
  assert.deepEqual(shipWeekOf(rows, "2026-10-01", "2026-10-04"),
    { deals: 0, sum: 0, paidDeals: 0, paidSum: 0, waitDeals: 0, waitSum: 0, lostDeals: 0, lostSum: 0 }, "порожній тиждень — не нулі");
});

/**
 * #3321 — 🪞 КОГОРТА НА СПРАВЖНІЙ СХЕМІ (scratch-БД): «без оплати» — рівно «Закрито і не реалізовано» (143) і лише
 * всередині «чекає»; оплачено — «Успішно» і «Оплата отримана»; день — київський (загрузка в неділю 23:30 за Києвом —
 * це неділя, а не понеділок за UTC і не субота); неактивний менеджер і чужа воронка не заходять; «чекає» без
 * змін для розгортки дня (`await` усе ще містить 143).
 * 🧨 Червоніє, якщо «без оплати» почне ловити інший статус, якщо день рахуватиметься за UTC, або якщо 143 випаде з `await`.
 */
test("#3321 🪞 когорта «Відправлених»: без оплати = лише 143 всередині «чекає», оплачено = 142 і етап оплати, день за Києвом", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(SRC("db/schema.sql"));
    await c.query(`INSERT INTO teams (id, name) VALUES (1, 'Команда') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id, is_active) VALUES (10, 'Активна', 1, true), (11, 'Звільнений', 1, false)`);
    // Неділя 18.10.2026 23:30 за Києвом = 20:30 UTC (до 25.10 Київ UTC+3). Понеділок 19.10 00:30 Київ = 18.10 21:30 UTC.
    await c.query(`INSERT INTO deals (kommo_id, manager_id, pipeline_id, status_id, price, load_at) VALUES
      (1, 10, 8921932, 142,       1000, '2026-10-18T20:30:00Z'),
      (2, 10, 8921932, 69716460,  2000, '2026-10-18T09:00:00Z'),
      (3, 10, 8921932, 143,       4000, '2026-10-18T09:00:00Z'),
      (4, 10, 8921932, 69716312,  8000, '2026-10-18T09:00:00Z'),
      (5, 10, 155304,  60412544,   300, '2026-10-18T09:00:00Z'),
      (6, 10, 8921932, 143,      16000, '2026-10-18T21:30:00Z'),
      (7, 11, 8921932, 143,      32000, '2026-10-18T09:00:00Z'),
      (8, 10, 8921928, 143,      64000, '2026-10-18T09:00:00Z')`);
    const { dispatchCohortByManagerDay } = await import("./reportCuts.js");
    const rows = await dispatchCohortByManagerDay("2026-10-12", "2026-10-25", {});
    const sun = rows.find((r) => r.day === "2026-10-18"), mon = rows.find((r) => r.day === "2026-10-19");
    assert.ok(sun, "неділі 18.10 немає в когорті");
    assert.deepEqual({ deals: sun.deals, sum: sun.sum, paidDeals: sun.paidDeals, paidSum: sun.paidSum, awaitDeals: sun.awaitDeals, awaitSum: sun.awaitSum, lostDeals: sun.lostDeals, lostSum: sun.lostSum },
      { deals: 5, sum: 15300, paidDeals: 3, paidSum: 3300, awaitDeals: 2, awaitSum: 12000, lostDeals: 1, lostSum: 4000 },
      "неділя: оплачено = 142 + обидва етапи оплати; без оплати — лише 143 і всередині «чекає»; звільнений і чужа воронка — поза");
    assert.ok(mon, "понеділок 19.10 00:30 за Києвом випав — день рахується не за Києвом");
    assert.deepEqual({ deals: mon.deals, lostDeals: mon.lostDeals, lostSum: mon.lostSum, awaitDeals: mon.awaitDeals }, { deals: 1, lostDeals: 1, lostSum: 16000, awaitDeals: 1 });
    assert.equal(rows.length, 2, "у когорті зайвий день — " + rows.map((r) => r.day).join(", "));
  } finally {
    await c.end().catch(() => {});
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => {});
  }
});

type ShipW = { deals: number; sum: number; paidDeals: number; paidSum: number; waitDeals: number; waitSum: number; lostDeals: number; lostSum: number };
type Wk = { idx: number; auto: number; autoRevenue: number; isFuture: boolean; ship: ShipW };

/**
 * #3322 — 🪞 ЖИВИЙ ЗВІТ КВП: КЛІТИНКА «ВІДПРАВЛЕНІ АВТО» == КЛІТИНКА «АКТИВНІСТЬ», А КОМАНДА І ВІДДІЛ == Σ. Два режими
 * одного тижня рахують ТІ САМІ машини двома запитами — кількість і сума мусять збігтися в кожного менеджера; частини
 * смужки дають ціле; команда = Σ менеджерів, відділ = Σ команд. Перевіряє лише тижні з авто — `0 == 0` не доводить нічого.
 * 🧨 Червоніє, якщо режим візьме іншу дату (не «Дату загрузки»), загубить менеджера в сумі команди чи частину смужки.
 */
test("#3322 🪞 Звіт КВП: «Відправлені авто» == «Активність» по кожному менеджеру й тижню; команда і відділ — Σ", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const H = { Authorization: `Bearer ${signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null })}` };
  const ym = kyivMonthBounds().ym;
  const r = await fetch(`${API_BASE}/api/dashboard/kvp-report?preset=month&date=${ym}-01`, { headers: H });
  assert.equal(r.status, 200, `kvp-report → ${r.status}`);
  const rep = await r.json() as { teams: { name: string; weeks: Wk[]; managers: { name: string; weeks: Wk[] }[] }[]; deptWeeks: Wk[] };
  const problems: string[] = [];
  let checked = 0;
  const keys: (keyof ShipW)[] = ["deals", "sum", "paidDeals", "paidSum", "waitDeals", "waitSum", "lostDeals", "lostSum"];
  const parts = (who: string, w: Wk) => {
    if (w.ship.paidDeals + w.ship.waitDeals + w.ship.lostDeals !== w.ship.deals) problems.push(`${who} Т${w.idx}: частини ≠ ${w.ship.deals} авто`);
    if (Math.abs(w.ship.paidSum + w.ship.waitSum + w.ship.lostSum - w.ship.sum) > 1) problems.push(`${who} Т${w.idx}: частини ≠ ${w.ship.sum} ₴`);
  };
  for (const t of rep.teams) {
    for (const tw of t.weeks) {
      const ms = t.managers.map((m) => m.weeks.find((x) => x.idx === tw.idx)).filter(Boolean) as Wk[];
      for (const k of keys) {
        const s = ms.reduce((a, x) => a + x.ship[k], 0);
        if (Math.abs(s - tw.ship[k]) > 1) problems.push(`${t.name} Т${tw.idx} ${k}: команда ${tw.ship[k]} ≠ Σ менеджерів ${s}`);
      }
      parts(t.name, tw);
    }
    for (const m of t.managers) for (const w of m.weeks) {
      if (w.ship.deals === 0 && w.auto === 0) continue;
      checked++;
      if (w.ship.deals !== w.auto) problems.push(`${m.name} Т${w.idx}: «Відправлені» ${w.ship.deals} авто ≠ «Активність» ${w.auto}`);
      if (Math.abs(w.ship.sum - w.autoRevenue) > 1) problems.push(`${m.name} Т${w.idx}: «Відправлені» ${w.ship.sum} ₴ ≠ «Активність» ${w.autoRevenue} ₴`);
      parts(m.name, w);
    }
  }
  for (const dw of rep.deptWeeks) for (const k of keys) {
    const s = rep.teams.reduce((a, t) => a + (t.weeks.find((x) => x.idx === dw.idx)?.ship[k] ?? 0), 0);
    if (Math.abs(s - dw.ship[k]) > 1) problems.push(`Відділ Т${dw.idx} ${k}: ${dw.ship[k]} ≠ Σ команд ${s}`);
  }
  assert.ok(checked > 0, "🔴 у жодного менеджера немає тижня з відправленими авто — режим нема на чому перевірити");
  assert.deepEqual(problems, [], "🔴 «ВІДПРАВЛЕНІ АВТО» РОЗІЙШЛИСЬ:\n  " + problems.join("\n  "));
});
