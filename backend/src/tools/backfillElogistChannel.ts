/**
 * 🟣 РАЗОВИЙ БЕКФІЛ КАНАЛУ eLogist ДЛЯ ІСТОРИЧНИХ ЛІДІВ КВАЛІФІКАЦІЇ (рішення власника 27.10.2026).
 *
 * ЧОМУ ПОТРІБЕН. Канал ліда Кваліфікації пише апсерт синку (`extractLeadSource`) — а синк чіпає
 * лише угоди, що ЗМІНИЛИСЬ у Kommo. `reclassifyAdChannel` перераховує лише Повний цикл. Тож старі
 * ліди «eLogist — +380…» (серпень–жовтень 2026), яких ніхто не рухав, лишились би з `ad`/`other`,
 * і кожен екран, що читає `lead_channel` по Кваліфікації, бачив би їх рекламою. Угоди Повного
 * циклу перемітить сама наступна `reclassifyAdChannel` (щосинку) — цей скрипт їх НЕ чіпає.
 *
 * ЩО РОБИТЬ. Рівно `core/elogist.elogistBackfillSql()`: ліди Кваліфікації з ознакою eLogist
 * (поле / назва / етап — єдине означення), окрім лідогену, → `lead_channel = 'elogist'`.
 * Ідемпотентно: повтор знаходить 0 рядків. Обсяг — сотні рядків, не масовий апдейт; але `deals`
 * пише синк, тож запис іде під `job_locks` (той самий замок, що важкі Kommo-джоби) — синк цей
 * прохід пропустить, дедлоку з ним не буде (правило `jobs-sync.md`).
 *
 * ⚠️ ВІДКАТ КОДУ НЕ ВІДКОЧУЄ ДАНІ. Повернути як було — лише разом із кодом, що пише `ad`
 * (повний синк по цих угодах або ручний UPDATE назад за тим самим предикатом).
 *
 * Запуск (на сервері, з прод-чекауту, `.env` поруч; ПІСЛЯ викату коду з каналом eLogist):
 *   node dist/tools/backfillElogistChannel.js           — сухий прогін: скільки й з якого каналу
 *   node dist/tools/backfillElogistChannel.js --write   — записати
 */
import { pool } from "../db/pool.js";
import { elogistBackfillSql, elogistBackfillWhere, elogistLeadSql } from "../core/elogist.js";
import { withHeavyJobLock } from "../jobs/jobLock.js";

const write = process.argv.includes("--write");

async function main(): Promise<void> {
  // Розклад УСІХ лідів з ознакою за поточним каналом: видно і кандидатів, і тих, кого UPDATE свідомо
  // не чіпає («вже elogist», «лідоген»). Умова запису — лише `elogistBackfillWhere`, без копії тут.
  const before = (await pool.query<{ ch: string | null; lg: boolean; n: string }>(
    `SELECT d.lead_channel AS ch, (d.lead_generator IS NOT NULL OR d.lead_channel = 'leadgen') AS lg, COUNT(*)::int AS n
       FROM deals d WHERE ${elogistLeadSql("d")}
      GROUP BY 1, 2 ORDER BY 3 DESC`)).rows;
  const total = before.reduce((a, r) => a + Number(r.n), 0);
  console.log(`${write ? "ЗАПИС" : "СУХИЙ ПРОГІН"}: лідів Кваліфікації з ознакою eLogist — ${total}`);
  for (const r of before) console.log(`  канал ${r.ch ?? "NULL"}${r.lg ? " (лідоген — НЕ чіпаємо)" : ""}: ${r.n}`);
  // 🔴 Порожньо — це не «все гаразд», а питання: ліди «eLogist — …» існують із серпня 2026.
  if (total === 0) console.log("  ⚠️ НУЛЬ кандидатів — перевірте, що синк приніс поле name/client_source, перш ніж вважати бекфіл непотрібним");
  if (!write) return;
  const n = await withHeavyJobLock("backfillElogistChannel", async () => (await pool.query(elogistBackfillSql())).rowCount ?? 0);
  console.log(`записано: ${n}`);
  const left = (await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM deals d WHERE ${elogistBackfillWhere("d")}`)).rows[0]?.n;
  console.log(`лишилось не переміченими (має бути 0): ${left}`);
}
main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
