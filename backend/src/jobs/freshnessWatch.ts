import { checkFreshness, type FreshnessRow } from "../core/reconcile.js";
import { sendAdminAlert } from "../bot/notify.js";

/**
 * Ч.2 — щогодинний вартовий СВІЖОСТІ вотермарків. Застряглий вотермарк ТИХО ламає
 * метрики (напр. `last_event_at` застряг 09.07 → липневі гроші недораховувались, а
 * нічна звірка цього не бачила: поточний місяць виключено з pass/fail). Тому окремий
 * ЧАСТИЙ (щогодини) дешевий чек (лише читання sync_state, БЕЗ Kommo), що БУДИТЬ.
 *
 * Дедуп: алертимо ОДИН раз на епізод (ключ додається в `alerted`), повторно — лише
 * коли вотермарк відновився і застряг знову. In-memory (скидається на рестарті —
 * після рестарту повторний алерт по досі-застряглому прийнятний). Так вартовий не
 * спамить щогодини, поки проблема тримається.
 */
const alerted = new Set<string>();

export async function freshnessWatch(): Promise<void> {
  let fresh: FreshnessRow[];
  try {
    fresh = await checkFreshness();
  } catch (e) {
    console.error("freshnessWatch: checkFreshness failed:", e);
    return;
  }
  const stale = fresh.filter((f) => f.stale);
  const staleKeys = new Set(stale.map((f) => f.key));

  // Зняти з «вже алертнутих» ті, що відновились (щоб наступний застій знову розбудив).
  for (const k of [...alerted]) if (!staleKeys.has(k)) alerted.delete(k);

  const fresh_stale = stale.filter((f) => !alerted.has(f.key)); // нові застої цього епізоду
  if (fresh_stale.length === 0) {
    console.log(`freshnessWatch: ok (stale=${stale.length}, вже-алертнуто=${alerted.size}).`);
    return;
  }
  for (const f of fresh_stale) alerted.add(f.key);

  const line = (f: FreshnessRow) =>
    `${f.critical ? "🔴💰 " : "• "}${f.label}: ${f.ageMin == null ? "НІКОЛИ" : f.ageMin + " хв тому"} (поріг ${f.thresholdMin} хв)`;
  await sendAdminAlert(
    `🕰 <b>Несвіжі дані — вотермарк застряг</b>\n` +
      `Застряглий вотермарк ТИХО ламає метрики (💰 = живить core/money.ts):\n` +
      fresh_stale.map(line).join("\n") +
      `\nПеревір джобу; свіжість — у /api/health/reconciliation.`
  ).catch(() => {});
  console.warn(`freshnessWatch: АЛЕРТ по ${fresh_stale.map((f) => f.key).join(", ")}.`);
}
