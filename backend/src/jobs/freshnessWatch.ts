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

/**
 * 🔴 РОЗБІЖНІСТЬ «ДЖОБА КАЖЕ УСПІХ — ДАНІ СТОЯТЬ» (додано 10.08.2026).
 *
 * Аварія показала клас поломки, якого не бачив ЖОДЕН наглядач: `job_runs.syncKommo`
 * бадьоро оновлював `last_success_at` кожні 30 хв, а `sync_state.last_success_at`
 * стояв 15 годин. Обидва наглядачі дивились кожен у своє джерело й обидва бачили
 * норму. Ловить це лише ПОРІВНЯННЯ двох джерел — тому воно тут.
 *
 * Нульова тривалість — другий підпис того самого: реальний прохід триває 26 с.
 * «Успіх за 0 мс» це не швидкість, це відсутність роботи.
 */
async function watchSyncDivergence(): Promise<void> {
  const { pool } = await import("../db/pool.js");
  const r = await pool.query<{ job_ok: Date | null; state_ok: Date | null; dur: number | null; skips: number }>(
    `SELECT jr.last_success_at AS job_ok, ss.last_success_at AS state_ok,
            jr.last_duration_ms AS dur, jr.consecutive_skips AS skips
       FROM job_runs jr, sync_state ss
      WHERE jr.name = 'syncKommo' AND ss.id = 1`
  ).catch(() => null);
  const x = r?.rows[0];
  if (!x || !x.job_ok || !x.state_ok) return;
  const gapMin = Math.round((x.job_ok.getTime() - x.state_ok.getTime()) / 60000);
  if (gapMin < 90) { divergenceAlerted = false; return; }
  if (divergenceAlerted) return;           // один алерт на епізод, як і решта тут
  divergenceAlerted = true;
  await sendAdminAlert(
    `🚨 <b>syncKommo: успіх є, даних немає</b>\n`
    + `job_runs каже «успіх» ${x.job_ok.toISOString()}, а sync_state стоїть на ${x.state_ok.toISOString()} `
    + `— розрив <b>${gapMin} хв</b>.\n`
    + `Остання тривалість: ${x.dur} мс${x.dur === 0 ? " (0 мс = прохід не робив роботи)" : ""}. `
    + `Пропусків поспіль: ${x.skips}.\n`
    + `Це підпис аварії 10.08.2026 — джоба виходить рано, а звітує успіхом.`
  ).catch(() => {});
  console.error(`freshnessWatch: РОЗБІЖНІСТЬ job_runs↔sync_state ${gapMin} хв.`);
}
let divergenceAlerted = false;

export async function freshnessWatch(): Promise<void> {
  await watchSyncDivergence().catch((e) => console.error("watchSyncDivergence failed:", e));
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
