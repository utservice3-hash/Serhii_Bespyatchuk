import { pool } from "../db/pool.js";
import { runReconcile } from "../core/reconcile.js";
import { healDealsByIds } from "./backfillMissingDeals.js";
import { reclassifyAdChannel } from "./syncKommo.js";
import { backfillClientKey } from "./backfillClientKey.js";
import { withHeavyJobLock } from "./jobLock.js";
import { sendAdminAlert } from "../bot/notify.js";
import { checkProjectionAccuracy, PROJECTION_ALERT_PCT } from "../core/projectionCheck.js";

/**
 * КРОК 4 (Звірка) + AUTO-HEAL. Дві точки виклику (див. `index.ts`):
 *   • ЩОНОЧІ 05:00 — `reconcileNightly(2)`: останні 2 місяці. Швидко/дешево,
 *     ловить СВІЖУ дормантність (угода не встигне «застаріти» непоміченою).
 *   • РАЗ НА МІСЯЦЬ (1-го, вночі) — `reconcileNightly(12)`: страховка на випадок,
 *     якщо нічна кілька разів не спрацювала. ⚠️ Читає Kommo API по 12 міс (важко для
 *     Kommo, легко для Neon — самі SELECT-и; важкі upsert-и лише при дормантних, а
 *     їх сплеск сам алертиться). Правило Neon-квоти — в `CLAUDE.md`.
 * Дірка на 35к (КРОК 1.4) була РАЗОВИМ артефактом (синк стартував пізно), не течею:
 * прямий підрахунок дав 1 дормантну за 12 міс. Тому 12-міс скан щоночі — надлишковий.
 *
 * Потік:
 *   1) runReconcile(months) — три рівні + перелік ДОРМАНТНИХ угод (виграні в Kommo,
 *      яких немає в `deals` — протік синк по updated_at, той самий клас, що дірка 35к).
 *   2) Якщо дормантні знайдено — САМА їх дотягує (`healDealsByIds` = fetchLeadsByIds +
 *      upsertDeal), потім reclassifyAdChannel + backfillClientKey (лише коли є що).
 *   3) ПЕРЕЗАПУСКАЄ звірку — підтвердити, що дірку закрито (використовуємо цей
 *      «after»-результат для стану/персистенції).
 *   4) Пише в `reconciliation_runs` (+ `healed_count`).
 *
 * Алерти в Telegram:
 *   • завжди, коли фінальна звірка НЕ ok (цілісність / дашборд / синк);
 *   • ОКРЕМО, коли вилікувано >10 угод за ніч — «тихе самолікування великої діри
 *     гірше за червону звірку»: якщо синк тече десятками, це поломка, а не крапельниця.
 *
 * ⚠️ БЕЗ логування `healed_count` авто-хіл ховав би сам себе (звірка завжди зелена).
 * Тому лічильник — обов'язковий і окремо алертиться на сплеск.
 */
let running = false;

const HEAL_ALERT_THRESHOLD = 10; // >10 за ніч → алерт (поломка синку, не крапельниця)

export async function reconcileNightly(months = 2): Promise<void> {
  if (running) {
    console.warn("reconcileNightly: попередній запуск ще йде — пропускаю.");
    return;
  }
  running = true;
  try {
    // Замок job_locks на весь прохід (heartbeat) → syncKommo пропускає свої тіки,
    // поки звірка+хіл тягнуть Kommo (щоб потоки не наклались і не пробили ліміт).
    await withHeavyJobLock("reconcile", async () => {
    // 1) Звірка + виявлення дормантних.
    const before = await runReconcile(months);

    // 2) AUTO-HEAL — дотягнути виграні угоди, яких немає в `deals`.
    let healed = 0;
    if (before.missingWonIds.length > 0) {
      console.log(`reconcileNightly: дормантних угод ${before.missingWonIds.length} → дотягую…`);
      healed = await healDealsByIds(before.missingWonIds);
      if (healed > 0) {
        // Канал по «останньому дотику» + канонізація ключа — інакше дотягнуті угоди
        // матимуть грубий канал і зламані сегменти (нові/постійні/лідоген).
        await reclassifyAdChannel();
        await backfillClientKey();
      }
      console.log(`reconcileNightly: дотягнуто ${healed} угод.`);
    }

    // 3) Перезапуск звірки — підтвердити, що дірку закрито.
    const res = healed > 0 ? await runReconcile(months) : before;
    const stillMissing = res.missingWonIds.length;

    // 4) Персистенція (стан = фінальна звірка + скільки вилікувано).
    await pool.query(
      `INSERT INTO reconciliation_runs
         (months, rows_checked, rows_over_threshold, max_delta_pct, integrity_orphans, ok, worst_json, dashboard_over, dashboard_max_delta, healed_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        res.months,
        res.rows.length,
        res.rowsOverThreshold.length,
        res.maxDeltaPct,
        res.integrity.orphans,
        res.ok,
        JSON.stringify({
          sync: [...res.rowsOverThreshold].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 15),
          dashboard: [...res.dashboardOver].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 15),
          healedByMonth: before.missingWonByMonth.map((m) => ({ ym: m.ym, n: m.ids.length })),
          stillMissing,
          freshness: res.freshness, // Ч.2
          currentMonthWarnings: res.currentMonthWarnings.slice(0, 15), // Ч.3
        }),
        res.dashboardOver.length,
        res.dashboardMaxDelta,
        healed,
      ]
    );

    // Алерт: сплеск самолікування (окремо від !ok — щоб не сховалось у зеленому).
    if (healed > HEAL_ALERT_THRESHOLD) {
      const byMonth = before.missingWonByMonth
        .filter((m) => m.ids.length)
        .map((m) => `${m.ym}: ${m.ids.length}`)
        .join(", ");
      await sendAdminAlert(
        `🩹 <b>Авто-хіл дотягнув ${healed} угод за ніч</b> (поріг ${HEAL_ALERT_THRESHOLD}).\n` +
          `Це НЕ крапельниця — синк тече десятками. Той самий клас, що дірка 35к.\n` +
          `По місяцях: ${byMonth}\n` +
          (stillMissing ? `⚠️ Після хілу лишилось ${stillMissing} недотягнутих.` : `Після хілу — 0 дормантних ✓`)
      ).catch(() => {});
    }

    // Ч.3: ПОТОЧНИЙ місяць ПОПЕРЕДЖАЄ (не фейлить ok). Раніше він мовчки випадав із
    // pass/fail — саме там застряглий вотермарк проявився б дельтою й лишився невидимим.
    if (res.currentMonthWarnings.length > 0) {
      const w = [...res.currentMonthWarnings].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 6);
      await sendAdminAlert(
        `⚠️ <b>Поточний місяць — розбіжності</b> (warning, НЕ фейл; місяць неповний):\n` +
          w.map((r) => `• ${r.ym} ${r.scope} ${r.name}: наше ${Math.round(r.ourRevenue)} vs ${Math.round(r.kommoRevenue)} (Δ ${(r.deltaPct * 100).toFixed(1)}%, ${r.ourDeals}/${r.kommoDeals})`).join("\n")
      ).catch(() => {});
    }

    if (!res.ok) {
      const lines: string[] = [];
      if (res.integrity.orphans > 0) {
        lines.push(`🕳 <b>Цілісність</b>: ${res.integrity.orphans} угод у подіях без запису в deals (та сама дірка, що й КРОК 1.4).`);
      }
      if (res.dashboardOver.length > 0) {
        lines.push(`🖥 <b>Дашборд</b> (money.ts↔deals): ${res.dashboardOver.length} рядків >2% (max ${(res.dashboardMaxDelta * 100).toFixed(1)}%) — БАГ У ЛОГІЦІ money.ts:`);
        for (const r of [...res.dashboardOver].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 5))
          lines.push(`  • ${r.ym} ${r.name}: money ${Math.round(r.ourRevenue)} vs deals ${Math.round(r.kommoRevenue)}`);
      }
      if (res.rowsOverThreshold.length > 0) {
        lines.push(`📉 <b>Синк</b> (deals↔Kommo): ${res.rowsOverThreshold.length} рядків >0.5% (max ${(res.maxDeltaPct * 100).toFixed(1)}%):`);
        for (const r of [...res.rowsOverThreshold].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 5))
          lines.push(`  • ${r.ym} ${r.name}: deals ${Math.round(r.ourRevenue)} vs Kommo ${Math.round(r.kommoRevenue)}`);
      }
      if (healed > 0) lines.push(`ℹ️ Цієї ночі авто-хіл дотягнув ${healed} угод (лишилось ${stillMissing}).`);
      await sendAdminAlert(`🔴 <b>Звірка дашборду впала</b>\n${lines.join("\n")}`);
    }
    console.log(
      `reconcileNightly: ok=${res.ok}, healed=${healed}, integrity=${res.integrity.orphans}, sync_over=${res.rowsOverThreshold.length}, dash_over=${res.dashboardOver.length}, stillMissing=${stillMissing}`
    );
    });

    // Ч.4: 🔁 самоперевірка Формули A прогнозу (стоп-критерій формули). Щоночі,
    // але фактично РАЗ на місяць (PK ym → ідемпотентно): першої ночі нового місяця
    // логуємо «прогноз@17 vs реальний фінал» щойно завершеного місяця в
    // projection_backtest; |зміщення| > PROJECTION_ALERT_PCT → алерт (формула
    // поплила — ребектест, не мовчазна віра). БЕЗ Kommo (тільки БД) — поза замком.
    try {
      const pc = await checkProjectionAccuracy();
      if (pc?.isNew) {
        console.log(
          `projectionCheck: ${pc.ym} forecast@17=${pc.forecast} (fact ${pc.factAt17} + zone ${pc.zoneAt17} + dobir ${pc.dobir}) vs final=${pc.final} → err=${pc.errorPct}%`
        );
        if (pc.errorPct != null && Math.abs(pc.errorPct) > PROJECTION_ALERT_PCT) {
          await sendAdminAlert(
            `📐 <b>Прогноз (Формула A) поплив за ${pc.ym}</b>: зміщення ${pc.errorPct > 0 ? "+" : ""}${pc.errorPct}% (поріг ±${PROJECTION_ALERT_PCT}%).\n` +
              `прогноз@17 = ${Math.round(pc.forecast).toLocaleString("uk-UA")} (факт ${Math.round(pc.factAt17).toLocaleString("uk-UA")} + зона ${Math.round(pc.zoneAt17).toLocaleString("uk-UA")} + добір ${Math.round(pc.dobir).toLocaleString("uk-UA")})\n` +
              `реальний фінал = ${Math.round(pc.final).toLocaleString("uk-UA")}\n` +
              `Бектест давав MAE 4.6% — формулу треба ребектестити, а не ігнорувати.`
          ).catch(() => {});
        }
      }
    } catch (e) {
      console.error("projectionCheck failed:", e);
    }
  } catch (e) {
    console.error("reconcileNightly failed:", e);
    await pool
      .query(`INSERT INTO reconciliation_runs (months, ok, error) VALUES ($1, false, $2)`, [months, String(e).slice(0, 500)])
      .catch(() => {});
    await sendAdminAlert(`🔴 Звірка дашборду впала з помилкою: ${String(e).slice(0, 200)}`).catch(() => {});
  } finally {
    running = false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // node dist/jobs/reconcileNightly.js [--months=N]  (дефолт 2, як щонічний)
  const months = Number(process.argv.find((a) => a.startsWith("--months="))?.split("=")[1]) || 2;
  reconcileNightly(months)
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
