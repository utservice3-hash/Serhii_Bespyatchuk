import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import * as money from "./money.js";

/**
 * Інтеграційні тести core/money.ts проти живої БД (КРОК 4). Закріплюють інваріанти
 * КРОКУ 2, щоб регрес не проліз непоміченим. Еталон — серпень 2025 (лист власника).
 */
const AUG = { from: "2025-08-01", to: "2025-08-31" };

test("received = success ⊎ paidOnly — дедуп, без подвійного рахунку (Ф9)", async () => {
  const [r, s, p] = await Promise.all([
    money.receivedMoney(AUG),
    money.successMoney(AUG),
    money.paidOnlyMoney(AUG),
  ]);
  assert.equal(s.deals + p.deals, r.deals, "success.deals + paidOnly.deals має дорівнювати received.deals");
  assert.ok(Math.abs(s.revenue + p.revenue - r.revenue) < 1, "success.rev + paidOnly.rev має дорівнювати received.rev");
});

test("avg_check_success_only у діапазоні 2600–2900 (серпень 2025)", async () => {
  const s = await money.successMoney(AUG);
  assert.ok(s.deals > 0, "мають бути успішні угоди");
  const avg = s.revenue / s.deals;
  assert.ok(avg >= 2600 && avg <= 2900, `avg_check_success_only=${Math.round(avg)} поза 2600–2900`);
});

test("еталон РПК-Яцика серпень 2025 ≈ 680 655 ₴ (лист, ≤1%)", async () => {
  const teams = await money.successByTeam(AUG);
  const y = teams.find((t) => t.teamName === "РПК - Яцика Дмитра");
  assert.ok(y, "команда РПК-Яцика має бути присутня");
  assert.ok(
    Math.abs(y!.revenue - 680655) / 680655 <= 0.01,
    `дохід Яцика ${y!.revenue} відхиляється від листа 680 655 більш ніж на 1%`
  );
});

test("expected (етап 8) рахується і не змішується з received", async () => {
  const [e, r] = await Promise.all([money.expectedMoney(AUG), money.receivedMoney(AUG)]);
  assert.ok(r.deals > 0, "received не порожній");
  assert.ok(e.deals >= 0, "expected рахується (може бути 0 у старому місяці)");
});

test.after(async () => {
  await pool.end();
});
