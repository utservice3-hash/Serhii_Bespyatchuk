import { pool } from "../db/pool.js";
import { runReconcile } from "../core/reconcile.js";
import { healDealsByIds } from "./backfillMissingDeals.js";
import { reclassifyAdChannel } from "./syncKommo.js";
import { backfillClientKey } from "./backfillClientKey.js";
import { sendAdminAlert } from "../bot/notify.js";

/**
 * КРОК 4 (Звірка) + AUTO-HEAL: нічна регресійна звірка (cron 05:00).
 *
 * Потік:
 *   1) runReconcile(12) — три рівні + перелік ДОРМАНТНИХ угод (виграні в Kommo,
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

export async function reconcileNightly(): Promise<void> {
  if (running) {
    console.warn("reconcileNightly: попередній запуск ще йде — пропускаю.");
    return;
  }
  running = true;
  try {
    // 1) Звірка + виявлення дормантних.
    const before = await runReconcile(12);

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
    const res = healed > 0 ? await runReconcile(12) : before;
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
  } catch (e) {
    console.error("reconcileNightly failed:", e);
    await pool
      .query(`INSERT INTO reconciliation_runs (months, ok, error) VALUES (12, false, $1)`, [String(e).slice(0, 500)])
      .catch(() => {});
    await sendAdminAlert(`🔴 Звірка дашборду впала з помилкою: ${String(e).slice(0, 200)}`).catch(() => {});
  } finally {
    running = false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reconcileNightly()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
