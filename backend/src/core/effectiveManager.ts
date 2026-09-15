/**
 * 👤 ХТО ВЕДЕ КЛІЄНТА НА МІСЯЦЬ M — одне правило замість пʼяти копій `COALESCE(pinned, primary)`.
 *
 * Закріплений менеджер (`loyalty_overrides.pinned_manager_id`) діє з місяця
 * `pinned_from_month`; до нього клієнта веде основний за оплатами (`primary_mgr`).
 * Закріплення без дати (записи до 15.09.2026) чинні одразу.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМИЙ МОДУЛЬ (15.09.2026). Дата `pinned_from_month` писалась із 05.09, але її
 * не читав НІХТО: список, реактивація, правила планів і межа команди брали закріпленого
 * одразу. Наслідок, спійманий тімлідом 15.09: він бачив клієнта під новим менеджером, а
 * список «свої» нового менеджера фільтрувався за ОСНОВНИМ по оплатах — клієнт зник для обох.
 * Правило власника «поточний місяць за старим, новий з наступного» жило лише в підписі.
 *
 * Два види зміни (рішення Романа 15.09.2026):
 *   · `fix`      — виправлення привʼязки: клієнт від початку висів не на тому; діє з 1-го
 *                  числа ПОТОЧНОГО місяця;
 *   · `transfer` — передача: вів один, вестиме інший; діє з 1-го числа НАСТУПНОГО місяця.
 */
export type TransferKind = "fix" | "transfer";
export const TRANSFER_KINDS: readonly TransferKind[] = ["fix", "transfer"] as const;

/** 1-ше число поточного місяця по-київськи. */
export const KYIV_MONTH_SQL = "date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv'))::date";

/**
 * SQL-вираз ефективного менеджера. `lo` — alias `loyalty_overrides`, `pm` — alias джерела
 * основного менеджера з колонкою `manager_id`, `monthSql` — вираз дати 1-го числа місяця M.
 */
export function effectiveManagerSql(lo: string, pm: string, monthSql: string = KYIV_MONTH_SQL): string {
  return `CASE WHEN ${lo}.pinned_manager_id IS NOT NULL
               AND COALESCE(${lo}.pinned_from_month, DATE '1970-01-01') <= ${monthSql}
          THEN ${lo}.pinned_manager_id ELSE ${pm}.manager_id END`;
}

/** Літерал місяця для вставки в SQL: приймає лише `YYYY-MM`, інакше кидає. */
export function monthLiteralSql(ym: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error(`monthLiteralSql: не місяць: ${ym}`);
  return `DATE '${ym}-01'`;
}

/** Чиста функція того самого правила — для гейтів і для JS-читачів. */
export function effectiveManager(
  pinned: number | null, pinnedFrom: string | null, primary: number | null, month: string,
): number | null {
  if (pinned == null) return primary;
  if (pinnedFrom == null) return pinned;
  return pinnedFrom.slice(0, 7) <= month ? pinned : primary;
}

/** З якого місяця діє зміна виду `kind`, якщо сьогодні `todayYmd` (Київ). */
export function effectiveFromFor(kind: TransferKind, todayYmd: string): string {
  const d = new Date(`${todayYmd.slice(0, 8)}01T00:00:00Z`);
  if (kind === "transfer") d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
