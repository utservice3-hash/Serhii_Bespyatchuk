import { pool } from "../db/pool.js";
import { runReconcile } from "../core/reconcile.js";
import { sendAdminAlert } from "../bot/notify.js";

/**
 * КРОК 4 (Звірка): нічна регресійна звірка (cron 05:00). Пише в
 * `reconciliation_runs`; при розбіжності >0.5% АБО сиротах цілісності — алерт у
 * Telegram. Стан читається в `/api/health/reconciliation` + індикатор у UI.
 */
let running = false;

export async function reconcileNightly(): Promise<void> {
  if (running) {
    console.warn("reconcileNightly: попередній запуск ще йде — пропускаю.");
    return;
  }
  running = true;
  try {
    const res = await runReconcile(12);
    await pool.query(
      `INSERT INTO reconciliation_runs
         (months, rows_checked, rows_over_threshold, max_delta_pct, integrity_orphans, ok, worst_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        res.months,
        res.rows.length,
        res.rowsOverThreshold.length,
        res.maxDeltaPct,
        res.integrity.orphans,
        res.ok,
        JSON.stringify([...res.rowsOverThreshold].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 20)),
      ]
    );

    if (!res.ok) {
      const lines: string[] = [];
      if (res.integrity.orphans > 0) {
        lines.push(`🕳 Цілісність: <b>${res.integrity.orphans}</b> угод у подіях без запису в deals (та сама дірка, що й КРОК 1.4).`);
      }
      if (res.rowsOverThreshold.length > 0) {
        lines.push(`📉 Наше↔Kommo: <b>${res.rowsOverThreshold.length}</b> рядків >0.5% (max ${(res.maxDeltaPct * 100).toFixed(1)}%):`);
        for (const r of [...res.rowsOverThreshold].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 5)) {
          lines.push(`  • ${r.ym} ${r.name}: наше ${Math.round(r.ourRevenue)} vs Kommo ${Math.round(r.kommoRevenue)}`);
        }
      }
      await sendAdminAlert(`🔴 <b>Звірка дашборду впала</b>\n${lines.join("\n")}`);
    }
    console.log(`reconcileNightly: ok=${res.ok}, over=${res.rowsOverThreshold.length}, orphans=${res.integrity.orphans}, maxΔ=${(res.maxDeltaPct * 100).toFixed(2)}%`);
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
