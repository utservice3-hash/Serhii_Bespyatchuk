import { checkFreshness, checkAbandonedStages, type FreshnessRow, type AbandonedStageRow } from "../core/reconcile.js";
import type { Alert } from "../health/alerts.js";
import { reportWatch } from "./alertPush.js";

/**
 * Ч.2 — щогодинний вартовий СВІЖОСТІ вотермарків. Застряглий вотермарк ТИХО ламає
 * метрики (напр. `last_event_at` застряг 09.07 → липневі гроші недораховувались, а
 * нічна звірка цього не бачила: поточний місяць виключено з pass/fail). Тому окремий
 * ЧАСТИЙ (щогодини) дешевий чек (лише читання sync_state, БЕЗ Kommo), що БУДИТЬ.
 *
 * Дедуп — У БД, через `reportWatch` (09.10.2026): перше повідомлення, нагадування раз на 6 год, «✅ Відновилось».
 * Доти тут стояв памʼятний `Set`, що порожнів на кожному рестарті, — а їх ~10 на день (145 за 25.09–09.10), тож
 * перша ж справжня аварія приходила б повтором після кожного викату.
 */

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
  // Не вдалося прочитати — «не знаю», а не «добре»: стан епізоду не чіпаємо.
  if (!x || !x.job_ok || !x.state_ok) return;
  const gapMin = Math.round((x.job_ok.getTime() - x.state_ok.getTime()) / 60000);
  const alerts: Alert[] = gapMin < 90 ? [] : [{
    id: "watch:divergence:syncKommo", severity: "critical",
    title: "syncKommo: успіх є, даних немає",
    detail: `job_runs каже «успіх» ${x.job_ok.toISOString()}, а sync_state стоїть на ${x.state_ok.toISOString()} `
      + `— розрив ${gapMin} хв. Остання тривалість: ${x.dur} мс${x.dur === 0 ? " (0 мс = прохід не робив роботи)" : ""}. `
      + `Пропусків поспіль: ${x.skips}. Це підпис аварії 10.08.2026 — джоба виходить рано, а звітує успіхом.`,
    action: "Перевірити job_locks і завислий прохід syncKommo; лог — до моменту, коли sync_state зупинився.",
    since: x.state_ok.toISOString(),
  }];
  await reportWatch("divergence", alerts).catch((e) => console.error("reportWatch(divergence) failed:", e));
  if (alerts.length) console.error(`freshnessWatch: РОЗБІЖНІСТЬ job_runs↔sync_state ${gapMin} хв.`);
}


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
  const line = (f: FreshnessRow) =>
    `${f.label}: ${f.ageMin == null ? "НІКОЛИ" : f.ageMin + " хв тому"} (поріг ${f.thresholdMin} хв)`;
  const alerts: Alert[] = stale.map((f) => ({
    id: `watch:fresh:${f.key}`, severity: f.critical ? "critical" : "warning",
    title: `Несвіжі дані — вотермарк застряг: ${f.label}`,
    detail: `${line(f)}. Застряглий вотермарк ТИХО ламає метрики${f.critical ? " — цей живить core/money.ts (гроші)" : ""}.`,
    action: "Перевірити джобу, що рухає цей вотермарк; свіжість — у /api/health/reconciliation.",
    since: null,
  }));
  const r = await reportWatch("fresh", alerts).catch((e) => { console.error("reportWatch(fresh) failed:", e); return null; });
  console.log(`freshnessWatch: застряглих ${stale.length}` + (r ? ` · нових ${r.sent}, повторів ${r.repeated}, відбоїв ${r.resolved}.` : "."));
}

/**
 * КРОК 6.6 — вартовий «ПОКИНУТИХ СТАДІЙ». Той самий клас, що застряглий вотермарк,
 * але ловить ЗЛАМАНИЙ ПРОЦЕС: стадію перестали проставляти → метрика тихо ~0.
 * Дедуп по епізоду (окремий Set, префікс `abandon:`), як у вотермарків.
 */


export async function abandonedStagesWatch(): Promise<void> {
  let rows: AbandonedStageRow[];
  try {
    rows = await checkAbandonedStages();
  } catch (e) {
    console.error("abandonedStagesWatch: checkAbandonedStages failed:", e);
    return;
  }
  const abandoned = rows.filter((r) => r.abandoned);
  const alerts: Alert[] = abandoned.map((r) => ({
    id: `watch:abandoned:${r.key}`, severity: "warning",
    title: `Покинута стадія — процес зламався, метрика мовчить: ${r.label}`,
    detail: `${r.label}: ${r.month} = ${r.current} (медіана 3 міс ${r.medianPrev3}, −${r.dropPct}%). Обсяг подій стадії, `
      + "що живить метрику, впав >80% від медіани 3 міс — той самий клас, що застряглий вотермарк.",
    action: "Перевірити, чи стадію ще проставляють у CRM. Деталі — /api/health/reconciliation.",
    since: null,
  }));
  const res = await reportWatch("abandoned", alerts).catch((e) => { console.error("reportWatch(abandoned) failed:", e); return null; });
  console.log(`abandonedStagesWatch: покинутих ${abandoned.length}` + (res ? ` · нових ${res.sent}, відбоїв ${res.resolved}.` : "."));
}
