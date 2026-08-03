import { pool } from "../db/pool.js";
import { RECOMPUTE_SQL } from "./clientKeySql.js";

/**
 * 🔑 ПЕРЕРАХУНОК КАНОНІЧНОГО `deals.client_key` із `client_key_raw` + активних аліасів.
 *
 * Модель: `client_key_raw` — те, що порахував синк, і воно НЕ змінюється аліасами
 * ніколи. `client_key` — похідна: `COALESCE(активний аліас, raw)`. Джерело правди —
 * таблиця `client_key_alias`; скасування злиття = `revoked_at` + цей перерахунок,
 * після якого стан відновлюється з `raw`, який нікуди не подівся.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМА ДЖОБА ПІД НАГЛЯДОМ, а не «запустимо руками після правки».
 * Джоба, що мовчки не відпрацювала, лишає аліаси застосованими НАПОЛОВИНУ: частина
 * угод клієнта під канонічним ключем, частина — під старим. Зовні все зелено, а
 * «постійний клієнт» знову розколотий. Це рівно той клас «тихо неправильно», який
 * ми ловимо весь спринт, тож джоба реєструється в `job_runs` і в банері нарівні
 * з синком.
 *
 * ⚙️ Ідемпотентна: `IS DISTINCT FROM` означає, що повторний прогін без змін
 * реєстру не чіпає жодного рядка. Тому її безпечно ганяти за розкладом.
 */
export interface RecomputeResult {
  /** Скільки рядків реально змінили `client_key`. */
  changed: number;
  /** Скільки угод зараз під активними аліасами (очікуване значення `changed` у стійкому стані). */
  underAlias: number;
  /** Скільки угод мають `client_key <> client_key_raw` ПІСЛЯ прогону. */
  divergent: number;
}

export async function recomputeClientKeys(): Promise<RecomputeResult> {
  // Один UPDATE на всю таблицю: і застосування нових аліасів, і ВІДКОТ скасованих
  // (для них `canonical_key` більше не знайдеться, і значення повернеться до `raw`).
  const r = await pool.query(RECOMPUTE_SQL);

  const stats = await pool.query<{ under_alias: string; divergent: string }>(
    `SELECT
       (SELECT COUNT(*) FROM deals d JOIN client_key_alias a
          ON a.alias_key = d.client_key_raw AND a.revoked_at IS NULL) AS under_alias,
       (SELECT COUNT(*) FROM deals WHERE client_key IS DISTINCT FROM client_key_raw) AS divergent`
  );
  const out: RecomputeResult = {
    changed: r.rowCount ?? 0,
    underAlias: Number(stats.rows[0]?.under_alias ?? 0),
    divergent: Number(stats.rows[0]?.divergent ?? 0),
  };
  // 🔴 ІНВАРІАНТ, який ловить неповний перерахунок: угод «канонічний ≠ сирий» має
  // бути РІВНО стільки ж, скільки угод під активними аліасами. Розійшлось — аліаси
  // застосовані наполовину, і мовчати про це не можна: саме так «постійний клієнт»
  // лишився б розколотим при зеленому вигляді.
  if (out.divergent !== out.underAlias) {
    throw new Error(
      `перерахунок неповний: угод із client_key <> raw = ${out.divergent}, `
      + `а під активними аліасами = ${out.underAlias}. Різниця ${out.divergent - out.underAlias}.`);
  }
  console.log(`recomputeClientKeys: змінено ${out.changed}, під аліасами ${out.underAlias}.`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  recomputeClientKeys()
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
