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

  console.log(`\nЗвірка за ${months} міс (метрика: успішно реалізовано, 142). Три рівні:\n`);

  // 1. Цілісність
  console.log(`1) ЦІЛІСНІСТЬ  deal_stage_events↔deals: ${res.integrity.orphans} сиріт${res.integrity.orphans ? " [" + res.integrity.sample.join(",") + "…] 🔴" : " ✓"}`);

  // 2. Синк: deals ↔ Kommo (0.5% + матеріальність)
  console.log(`2) СИНК        deals↔Kommo (0.5% + >2 угод/>20к₴): матеріальних ${res.rowsOverThreshold.length}${res.rowsOverThreshold.length ? " 🔴" : " ✓"} · дрібних ${res.syncMinor.length} ℹ️ · max Δ ${(res.maxDeltaPct * 100).toFixed(2)}%`);
  for (const r of [...res.rowsOverThreshold].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 20))
    console.log(`   🔴 ${r.ym} ${r.scope.padEnd(7)} ${r.name.slice(0, 22).padEnd(22)} deals=${Math.round(r.ourRevenue)} kommo=${Math.round(r.kommoRevenue)} Δ=${(r.deltaPct * 100).toFixed(2)}% (${r.ourDeals}/${r.kommoDeals})`);
  for (const r of [...res.syncMinor].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 20))
    console.log(`   ℹ️ ${r.ym} ${r.scope.padEnd(7)} ${r.name.slice(0, 22).padEnd(22)} deals=${Math.round(r.ourRevenue)} kommo=${Math.round(r.kommoRevenue)} Δ=${(r.deltaPct * 100).toFixed(2)}% (${r.ourDeals}/${r.kommoDeals}) [дрібне]`);

  // 3. Дашборд: money.ts ↔ deals (2% + матеріальність)
  console.log(`3) ДАШБОРД     money.ts↔deals (2% + >2 угод/>20к₴): матеріальних ${res.dashboardOver.length}${res.dashboardOver.length ? " 🔴" : " ✓"} · дрібних ${res.dashMinor.length} ℹ️ · max Δ ${(res.dashboardMaxDelta * 100).toFixed(2)}%`);
  for (const r of [...res.dashboardOver].sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 20))
    console.log(`   🔴 ${r.ym} ${r.scope.padEnd(7)} ${r.name.slice(0, 22).padEnd(22)} money=${Math.round(r.ourRevenue)} deals=${Math.round(r.kommoRevenue)} Δ=${(r.deltaPct * 100).toFixed(2)}% (${r.ourDeals}/${r.kommoDeals})`);

  // Дормантні: виграні в Kommo, яких немає в deals (ціль авто-хілу вночі).
  console.log(`\nДОРМАНТНІ (Kommo 142, немає в deals): ${res.missingWonIds.length}${res.missingWonIds.length ? " 🩹" : " ✓"}`);
  for (const m of res.missingWonByMonth) console.log(`   ${m.ym}: ${m.ids.length} [${m.ids.slice(0, 10).join(",")}${m.ids.length > 10 ? "…" : ""}]`);

  console.log(res.ok ? "\n✅ ЗЕЛЕНО — усі три рівні збігаються." : "\n🔴 Є розбіжності — див. вище (НЕ підганяти поріг).");
  return res.ok;
}

main()
  .then((ok) => pool.end().then(() => process.exit(ok ? 0 : 1)))
  .catch((err) => {
    console.error(err);
    pool.end().then(() => process.exit(2));
  });
