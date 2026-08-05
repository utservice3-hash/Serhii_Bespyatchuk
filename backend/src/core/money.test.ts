import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb, HAS_DB } from "../testMode.js";

/**
 * ⚠️ Імпорти ЛІНИВІ (`await import` у тілі тесту). `db/pool.js` тягне `config.js`,
 * який кидає на відсутньому DATABASE_URL ЩЕ НА ІМПОРТІ — тобто раніше, ніж node:test
 * встигне застосувати skip. Через статичний імпорт `npm test` без БД падав би замість
 * того, щоб чесно пропустити.
 */
const loadMoney = () => import("./money.js");

/**
 * Інтеграційні тести core/money.ts проти живої БД (КРОК 4). Закріплюють інваріанти
 * КРОКУ 2, щоб регрес не проліз непоміченим. Еталон — серпень 2025 (лист власника).
 */
const AUG = { from: "2025-08-01", to: "2025-08-31" };

test("received = success ⊎ paidOnly — дедуп, без подвійного рахунку (Ф9)", needsDb(), async () => {
  const M = await loadMoney();
  const [r, s, p] = await Promise.all([
    M.receivedMoney(AUG),
    M.successMoney(AUG),
    M.paidOnlyMoney(AUG),
  ]);
  assert.ok(r.deals > 0 && r.revenue !== 0, "received за серпень 2025 порожній — це провал, а не «немає даних»");
  assert.equal(s.deals + p.deals, r.deals, "success.deals + paidOnly.deals має дорівнювати received.deals");
  assert.ok(Math.abs(s.revenue + p.revenue - r.revenue) < 1, "success.rev + paidOnly.rev має дорівнювати received.rev");
});

/**
 * ⚠️ ЕТАЛОН ПЕРЕГЛЯНУТО 31.07.2026 — і саме тому тут ДВА твердження.
 *
 * Смуга 2600–2900 узята з ручного листа власника. Лист **не нетить мінусові угоди**
 * (Калькулятор не вміє відʼємний бюджет, такі угоди позначені словом «мінус» у назві),
 * а `syncKommo` зберігає їх із ВІДʼЄМНИМ price — тож ядро їх віднімає. За серпень 2025
 * це 7 угод на −85 006 ₴, через що чек ядра 2431, а не 2682.
 *
 * Тому нижче перевіряється і фактична цифра ядра, і — головне — що з неї
 * РЕКОНСТРУЮЄТЬСЯ смуга листа. Просто розширити смугу було б підгонкою: тоді тест
 * перестав би ловити реальний зсув чека. Правило проєкту: нормативну цифру не
 * переписуємо, поки не вміємо відтворити стару з нової.
 */
test("avg_check_success_only: ядро 2431 ± і реконструкція смуги листа 2600–2900", needsDb(), async () => {
  const M = await loadMoney();
  const s = await M.successMoney(AUG);
  assert.ok(s.deals > 0, "серпень 2025 не може бути порожнім — це закритий місяць із даними");
  const avg = s.revenue / s.deals;
  assert.ok(avg >= 2350 && avg <= 2550, `чек ядра ${Math.round(avg)} поза 2350–2550 (очікували ~2431)`);

  const { pool } = await import("../db/pool.js");
  const neg = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(price),0) s FROM deals
      WHERE status_id = 142 AND pipeline_id = ANY($1) AND price < 0
        AND (closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2 AND $3`,
    [[8921932, 155304], AUG.from, AUG.to]
  );
  const negSum = Number(neg.rows[0]?.s ?? 0);
  assert.ok(negSum < 0, "мінусові угоди в серпні 2025 мають бути — на них і тримається дельта до листа");
  const asSheet = (s.revenue - 2 * negSum) / s.deals; // лист рахує мінуси ПЛЮСОМ
  assert.ok(asSheet >= 2600 && asSheet <= 2900,
    `без нетування мінусів чек ${Math.round(asSheet)} — смуга листа 2600–2900 НЕ реконструюється, отже причина не в мінусах`);
});

/**
 * ⚠️ ЕТАЛОН ПЕРЕГЛЯНУТО 31.07.2026. Було «≈680 655 (лист), наше 681 356, Δ0.1%».
 * Стало 594 296 — і розрив 86 359 ₴ зведено до нуля НАШИМИ Ж правилами:
 *   лист 680 655
 *   − 83 020  нетування 3 мінусових угод (2 × 41 510; лист рахує їх плюсом)
 *   −  4 040  1 угода перезакрилась в іншому місяці (правило «фінальний стан»)
 *   =  593 595   ·   ядро 594 296   →   залишок −701 ₴ = 0.10%
 * 0.10% — рівно та похибка листа, що була задокументована з самого початку.
 *
 * 🔴 ЕТАЛОН ЗСУНУВСЯ 05.08.2026: 594 296 → **651 729**. Це НЕ регресія і не дрейф
 * даних, а наслідок рішення власника «Самостійні розформовано: Шевчук Назар
 * переходить під РПК-Яцика ПОВНІСТЮ і ЗАДНІМ ЧИСЛОМ» (`TEAM_OVERRIDES` у
 * `syncKommo`). Командний розріз рахується за ПОТОЧНОЮ прив'язкою (варіант A),
 * тож серпень 2025 перерахувався сам — саме так, як і планувалось.
 *
 * ДОВЕДЕНО АРИФМЕТИКОЮ, а не «схоже на правду» (замір на проді 05.08.2026):
 *   команда Яцика ЗАРАЗ         651 729 ₴ · 302 угоди
 *   з них внесок Шевчука          57 433 ₴ ·  60 угод
 *   594 296 + 57 433 = 651 729   ← сходиться до гривні
 *
 * ⚠️ ЩО РОБИТИ, ЯКЩО ЦЕЙ ТЕСТ ВПАДЕ ЗНОВУ. Спершу перевір, чи не змінювався
 * СКЛАД КОМАНДИ (оверрайд знято, менеджера перевели в CRM, хтось деактивований):
 * тоді еталон треба переставити з новою арифметикою в цьому коментарі. І лише
 * якщо склад той самий — це справжня регресія ядра грошей.
 */
test("еталон РПК-Яцика серпень 2025: ядро 651 729 ₴ і реконструкція листа 680 655", needsDb(), async () => {
  const M = await loadMoney();
  const teams = await M.successByTeam(AUG);
  assert.ok(teams.length > 0, "розріз по командах не може бути порожнім");
  const y = teams.find((t) => t.teamName === "РПК - Яцика Дмитра");
  assert.ok(y, "команда РПК-Яцика має бути присутня");
  assert.ok(y!.deals > 0, "у команди мають бути угоди в серпні 2025");
  assert.ok(Math.abs(y!.revenue - 651729) / 651729 <= 0.01,
    `дохід Яцика ${y!.revenue} відхиляється від еталона ядра 651 729 більш ніж на 1% `
    + "(якщо змінювався склад команди — див. арифметику в коментарі над тестом)");

  const { pool } = await import("../db/pool.js");
  const r = await pool.query<{ neg: string; entered: string }>(
    `WITH ent AS (SELECT DISTINCT e.kommo_id FROM deal_stage_events e
                   WHERE e.status_id = 142 AND e.pipeline_id = ANY($1)
                     AND (e.changed_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2 AND $3)
     SELECT COALESCE(SUM(d.price) FILTER (WHERE d.price < 0 AND d.status_id = 142
              AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2 AND $3), 0) AS neg,
            COALESCE(SUM(d.price), 0) AS entered
       FROM ent JOIN deals d ON d.kommo_id = ent.kommo_id
       JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
      WHERE t.name = 'РПК - Яцика Дмитра'`,
    [[8921932, 155304], AUG.from, AUG.to]
  );
  const negSum = Number(r.rows[0].neg), entered = Number(r.rows[0].entered);
  const reopen = entered - y!.revenue;                 // перезакриті в інший місяць
  const asSheet = y!.revenue - 2 * negSum + reopen;    // назад до логіки листа
  assert.ok(Math.abs(asSheet - 680655) / 680655 <= 0.015,
    `реконструкція листа дала ${Math.round(asSheet)} замість 680 655 — розрив пояснюється НЕ мінусами й не реоупенами, шукати причину`);
});

test("expected (етап 8) рахується і не змішується з received", needsDb(), async () => {
  const M = await loadMoney();
  const [e, r] = await Promise.all([M.expectedMoney(AUG), M.receivedMoney(AUG)]);
  assert.ok(r.deals > 0, "received за серпень 2025 порожній — провал");
  assert.ok(e.deals >= 0, "expected рахується (0 у старому місяці — норма, етап 8 уже пройдено)");
});

test.after(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("../db/pool.js");
  await pool.end();
});
