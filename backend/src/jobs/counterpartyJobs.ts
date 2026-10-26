import { pool } from "../db/pool.js";
import { debts, runner, youscore } from "../counterparty/mount.js";
import { migrateLegacyLimits, mirrorToReceivables } from "../counterparty/legacyLimits.js";
import { runPlannedChecks } from "../counterparty/server/plannedChecks.js";
import { runCourtMonitor } from "../counterparty/server/courtMonitor.js";
import { createRunGuard } from "./runGuard.js";

/**
 * 🤝 Джоби пакета Сергія «Реєстри та узгодження + Ліміти клієнтів» (23.10.2026) — у НАШОМУ розкладі (index.ts) замість
 * `setInterval` пакета (ТЗ §2, §7).
 *
 * clientLimitsMirror — раз на 10 хв: спершу одноразовий перенос лімітів дебіторки в «Ліміти клієнтів» (idempotent, за
 *   debtorKey), далі дзеркало «Ліміти клієнтів» → колонки «Активної дебіторки». Без мережі, лише наша БД.
 * cpPlannedChecks / cpCourtMonitor — щодня 06:15 за Києвом (сервер теж у Europe/Kyiv): планова перевірка клієнтів з
 *   лімітом (≤ 10 на день, кожного раз на 91 день) і суди 1-го числа боржникам. ВИТРАЧАЮТЬ ТРАНЗАКЦІЇ YouScore, тому
 *   ввімкнені лише з `CP_BACKGROUND_CHECKS=1` у .env (24.10: на ключі 3 889 із 19 096, хто витратив 15 тис. — не з'ясовано).
 *   Самі функції пакета не дадуть запуститись двічі за період (`cl_monitor_runs.period`, advisory lock).
 */
export const CP_BACKGROUND_ON = () => process.env.CP_BACKGROUND_CHECKS === "1";

const mirrorGuard = createRunGuard("clientLimitsMirror");
export function clientLimitsMirror() {
  return mirrorGuard(async () => {
    const mig = await migrateLegacyLimits(pool);
    const mir = await mirrorToReceivables(pool, debts);
    if (mig.inserted || mir.set || mir.cleared) console.log(`[client-limits] перенесено ${mig.inserted}, дзеркало: оновлено ${mir.set}, знято ${mir.cleared}`);
  });
}

const plannedGuard = createRunGuard("cpPlannedChecks", 60 * 60_000);
export function cpPlannedChecks() {
  return plannedGuard(async () => {
    const r = await runPlannedChecks({ pool, runner });
    if (!r.skipped) console.log(`[counterparty] планова перевірка ${r.day}: перевірено ${r.checked}, невдало ${r.failed}`);
  });
}

const courtGuard = createRunGuard("cpCourtMonitor", 90 * 60_000);
export function cpCourtMonitor() {
  return courtGuard(async () => {
    const r = await runCourtMonitor({ pool, youscore, debts });
    if (!r.skipped) console.log(`[client-limits] суди ${r.period}: юросіб ${r.checked}, транзакцій ${r.tx}, нових справ у ${r.found}`);
  });
}
