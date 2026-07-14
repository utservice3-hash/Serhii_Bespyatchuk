import { pool } from "../db/pool.js";
import { runReconcile } from "../core/reconcile.js";

/**
 * CLI регресійна звірка: НАШЕ (`core/money.ts`) ↔ Kommo API напряму, 12 міс ×
 * команди × менеджери, + інваріант цілісності. Exit 1 при будь-якій дельті >0.5%
 * або сиротах у цілісності.
 *   node dist/scripts/reconcile.js            # 12 міс
 *   node dist/scripts/reconcile.js --months=6
 */
async function main() {
  const months = Number(process.argv.find((a) => a.startsWith("--months="))?.split("=")[1]) || 12;
  const res = await runReconcile(months);

  console.log(`\nЗвірка НАШЕ↔Kommo за ${months} міс — метрика: успішно реалізовано (етап 142)`);
  console.log(`Рядків перевірено: ${res.rows.length} · понад поріг 0.5%: ${res.rowsOverThreshold.length} · max Δ: ${(res.maxDeltaPct * 100).toFixed(2)}%`);
  console.log(`Інваріант цілісності deal_stage_events↔deals: ${res.integrity.orphans} сиріт${res.integrity.orphans ? " [" + res.integrity.sample.join(",") + "…]" : " ✓"}`);

  if (res.rowsOverThreshold.length) {
    console.log("\n🔴 РОЗБІЖНОСТІ >0.5% (топ 40):");
    for (const r of [...res.rowsOverThreshold].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 40)) {
      console.log(
        `  ${r.ym} ${r.scope.padEnd(7)} ${r.name.slice(0, 24).padEnd(24)} наше=${Math.round(r.ourRevenue)} kommo=${Math.round(r.kommoRevenue)} Δ=${(r.deltaPct * 100).toFixed(2)}% (угоди ${r.ourDeals}/${r.kommoDeals})`
      );
    }
  }
  console.log(res.ok ? "\n✅ ЗЕЛЕНО — наше збігається з Kommo, цілісність ціла." : "\n🔴 Є розбіжності — див. вище (НЕ підганяти поріг).");
  return res.ok;
}

main()
  .then((ok) => pool.end().then(() => process.exit(ok ? 0 : 1)))
  .catch((err) => {
    console.error(err);
    pool.end().then(() => process.exit(2));
  });
