import { backfillWeekPlans } from "../core/weekPlan.js";
import { managerPlan } from "../core/plans.js";
import { monthsInRange } from "../core/dates.js";

/**
 * 🧊 РЕТРОСПЕКТИВНИЙ БЕКФІЛ ЗНІМКІВ ТИЖНЕВОГО ПЛАНУ.
 *
 * За тижні, що минули ДО впровадження заморожування, знімків немає — і без них
 * ці тижні показували б ЖИВИЙ перерахунок, тобто цифру, якої тоді ніхто не бачив.
 *
 * 🔴 ЧЕСНА МЕЖА, ЯКА МУСИТЬ ЛИШИТИСЬ ВИДИМОЮ: відновлені знімки позначаються
 * `source='backfill'`, і UI показує їх як реконструкцію. Факт «на початок тижня»
 * тут рахується з ПОТОЧНОГО стану подій, тож якщо угода відтоді переїхала між
 * стадіями, відновлене число відрізняється від того, що людина бачила тоді.
 * Приховати цю різницю означало б тихо збрехати про історію — рівно те, від чого
 * нас береже правило «невідоме має читатись як невідоме».
 *
 * ⚠️ Ідемпотентно: запис іде через `ON CONFLICT DO NOTHING`, тож повторний прогін
 * НЕ перезаписує вже наявні знімки (ані live, ані backfill). Це і є сенс
 * заморожування — інакше таблиця була б просто кешем.
 *
 * Виклик: `node dist/jobs/backfillWeekPlans.js [--months=N]` (дефолт — поточний місяць).
 */
export async function run(monthsBack = 0): Promise<{ month: string; inserted: number; weeks: number }[]> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const cur = today.slice(0, 7) + "-01";
  const [y, m] = cur.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1 - monthsBack, 1)).toISOString().slice(0, 10);
  const out: { month: string; inserted: number; weeks: number }[] = [];
  for (const month of monthsInRange(from, cur)) {
    const mp = await managerPlan({ month });
    const planByMgr = new Map(mp.rows.map((r) => [r.managerId, r.plan]));
    if (!planByMgr.size) { console.log(`backfillWeekPlans ${month}: планів немає — пропуск`); continue; }
    const r = await backfillWeekPlans(month, planByMgr);
    // 🟢 ЗЕЛЕНА ДЖОБА ≠ ДАНІ ЙДУТЬ: друкуємо ОБСЯГ, а не «відпрацювала».
    console.log(`backfillWeekPlans ${month}: відновлено ${r.inserted} знімків за ${r.weeks} тижн. (менеджерів ${planByMgr.size})`);
    out.push({ month, ...r });
  }
  return out;
}

if (process.argv[1]?.endsWith("backfillWeekPlans.js")) {
  const arg = process.argv.find((a) => a.startsWith("--months="));
  const n = arg ? Number(arg.split("=")[1]) : 0;
  run(Number.isFinite(n) ? n : 0)
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
