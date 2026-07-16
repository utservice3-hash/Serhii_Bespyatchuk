import { checkFreshness, checkAbandonedStages, type FreshnessRow, type AbandonedStageRow } from "../core/reconcile.js";
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

/**
 * КРОК 6.6 — вартовий «ПОКИНУТИХ СТАДІЙ». Той самий клас, що застряглий вотермарк,
 * але ловить ЗЛАМАНИЙ ПРОЦЕС: стадію перестали проставляти → метрика тихо ~0.
 * Дедуп по епізоду (окремий Set, префікс `abandon:`), як у вотермарків.
 */
const abandonAlerted = new Set<string>();

export async function abandonedStagesWatch(): Promise<void> {
  let rows: AbandonedStageRow[];
  try {
    rows = await checkAbandonedStages();
  } catch (e) {
    console.error("abandonedStagesWatch: checkAbandonedStages failed:", e);
    return;
  }
  const abandoned = rows.filter((r) => r.abandoned);
  const keys = new Set(abandoned.map((r) => r.key));
  for (const k of [...abandonAlerted]) if (!keys.has(k)) abandonAlerted.delete(k); // відновилось → скинути
  const fresh = abandoned.filter((r) => !abandonAlerted.has(r.key));
  if (fresh.length === 0) {
    console.log(`abandonedStagesWatch: ok (abandoned=${abandoned.length}, вже-алертнуто=${abandonAlerted.size}).`);
    return;
  }
  for (const r of fresh) abandonAlerted.add(r.key);
  const line = (r: AbandonedStageRow) =>
    `• ${r.label}: ${r.month} = ${r.current} (медіана 3 міс ${r.medianPrev3}, −${r.dropPct}%)`;
  await sendAdminAlert(
    `📉 <b>Покинута стадія — процес зламався, метрика мовчить</b>\n` +
      `Обсяг подій стадії, що живить метрику, впав >80% від медіани 3 міс — це той самий клас, що застряглий вотермарк:\n` +
      fresh.map(line).join("\n") +
      `\nПеревір, чи стадію ще проставляють у CRM. Деталі — /api/health/reconciliation.`
  ).catch(() => {});
  console.warn(`abandonedStagesWatch: АЛЕРТ по ${fresh.map((r) => r.key).join(", ")}.`);
}
