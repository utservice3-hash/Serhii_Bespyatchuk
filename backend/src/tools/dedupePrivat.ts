/**
 * ЗГОРТАННЯ ДВІЙНИКІВ ВИПИСКИ ПРИВАТУ + ПЕРЕВЕДЕННЯ НА КЛЮЧ `REF#NUM_DOC`.
 *
 * Навіщо — `bankSources/privat.ts` → `privatTxKey`, редакція ③: ключ за `ID` (з 08.09.2026)
 * не збігався у двох формах видачі одного платежу, і 13–14.09 у базу вдруге лягли 109
 * платежів за 09–14.09 (ЮТС 50, Автомув 43, ФОП 10, EUR 5, USD 1). Виписка, Σ і CSV для
 * 1С показували їх двічі.
 *
 * Що робить, ЛИШЕ для рахунків `bank = 'privat'` (у Моно немає ні `REF`, ні `NUM_DOC`:
 * там 308 із 309 рядків злились би в одну групу), по рахунку за рахунком, в одній транзакції:
 *   1. рахує ключ КОЖНОГО рядка тією самою `normalizePrivat` з його `raw_json` — не копією
 *      формули в SQL, інакше інструмент і гейт `#659c` доводили б одне одного, а не код;
 *   2. у групах з однаковим ключем лишає рядок БЕЗ `_online` у `TECHNICAL_TRANSACTION_ID`
 *      (він повніший: у 34 із 109 груп у `_online`-формі бракує `STRUCT_*`/`RECIPIENT_ULTMT_*`),
 *      а якщо такого немає — найстаріший `id`; решту видаляє. 🔴 НЕ «найраніший за часом»:
 *      у ЮТС `_online` здебільшого приходив ПЕРШИМ, і CSV розійшовся б із банком;
 *   3. усім рядкам, чий `external_tx_id` ≠ обчисленому, переписує ключ;
 *   4. ПЕРЕД `COMMIT` перевіряє: рядків стало рівно «було − видалено»; груп `(REF, NUM_DOC)`
 *      з 2+ рядками — 0; рядків із ключем ≠ `normalizePrivat(raw_json)` — 0. Інакше `ROLLBACK`.
 *
 * Видалені рядки ПЕРЕД видаленням пишуться повністю в `backups/privat-dedup-<час>.json`
 * (тека нічної копії). Основний резерв — Neon PITR і нічний gzip-CSV.
 * 🔴 Revert коду видалених рядків не повертає; повернення ключа на `ID` знову задвоїть усе,
 * що банк віддасть повторно.
 *
 * Ідемпотентно: повторний запуск нічого не міняє. Запускати ОДРАЗУ після викату ключа:
 * синк у вікні між ними може завести двійника під новим ключем — цей самий прохід його
 * згорне (обидва без `_online` → лишається старший `id`). Якщо транзакція впала на
 * унікальності через синк, що біг паралельно, — просто запустити ще раз.
 *
 * ⚠️ Без `TEST_SCOPE=prod` (інакше `db/pool.ts` відмовить у записі — і правильно зробить).
 *
 *   node dist/tools/dedupePrivat.js            # звіт, нічого не пише
 *   node dist/tools/dedupePrivat.js --write    # виконати
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";
import { normalizePrivat } from "../bankSources/privat.js";

const WRITE = process.argv.includes("--write");
const __dirname = dirname(fileURLToPath(import.meta.url));
// Та сама тека, що в `jobs/backupDb.ts`: під нічним наглядом і поза докрутом.
const BACKUP_DIR = process.env.BACKUP_DIR ?? resolve(__dirname, "..", "..", "..", "backups");

interface Row {
  id: number; external_tx_id: string; direction: "in" | "out"; amount: string; amount_uah: string | null;
  currency: string; is_bank_fee: boolean | null; created_at: Date; raw_json: Record<string, unknown>;
}
interface Plan { keep: Row; drop: Row[] }

/** Чисте рішення «кого лишити»: без `_online`, серед таких — найменший `id`. */
export function chooseKeeper(rows: Row[]): Plan {
  const isOnline = (r: Row) => String(r.raw_json.TECHNICAL_TRANSACTION_ID ?? "").endsWith("_online");
  const sorted = [...rows].sort((a, b) => Number(isOnline(a)) - Number(isOnline(b)) || a.id - b.id);
  return { keep: sorted[0], drop: sorted.slice(1) };
}

const uah = (rows: Row[]) => Math.round(rows.reduce((s, r) => s + Math.abs(Number(r.amount_uah ?? r.amount)), 0));

async function main(): Promise<void> {
  const accounts = await pool.query<{ id: number; label: string; currency: string }>(
    `SELECT id, label, currency FROM bank_accounts WHERE bank = 'privat' ORDER BY id`);
  let totalDrop = 0, totalRekey = 0;
  for (const acc of accounts.rows) {
    const { rows } = await pool.query<Row>(
      `SELECT id, external_tx_id, direction, amount, amount_uah, currency, is_bank_fee, created_at, raw_json
         FROM bank_transactions WHERE account_id = $1 ORDER BY id`, [acc.id]);
    const byKey = new Map<string, Row[]>();
    const keyOf = new Map<number, string>();
    for (const r of rows) {
      const k = normalizePrivat(r.raw_json as object, r.currency).externalTxId;
      keyOf.set(r.id, k);
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
    const drop: Row[] = [];
    for (const group of byKey.values()) if (group.length > 1) drop.push(...chooseKeeper(group).drop);
    const dropIds = new Set(drop.map((r) => r.id));
    const rekey = rows.filter((r) => !dropIds.has(r.id) && keyOf.get(r.id) !== r.external_tx_id);
    const out = drop.filter((r) => r.direction === "out" && !r.is_bank_fee);
    const inn = drop.filter((r) => r.direction === "in");
    const fee = drop.filter((r) => r.direction === "out" && r.is_bank_fee);
    console.log(`«${acc.label}»: рядків ${rows.length} · груп із двійниками ${[...byKey.values()].filter((g) => g.length > 1).length}`
      + ` · видалити ${drop.length} (вихідних ${out.length} ≈${uah(out)} ₴, вхідних ${inn.length} ≈${uah(inn)} ₴, комісій ${fee.length})`
      + ` · переписати ключ ${rekey.length}`);
    totalDrop += drop.length; totalRekey += rekey.length;
    if (!WRITE) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (drop.length) {
        const { rows: full } = await client.query(`SELECT * FROM bank_transactions WHERE id = ANY($1::int[])`, [[...dropIds]]);
        mkdirSync(BACKUP_DIR, { recursive: true });
        const file = resolve(BACKUP_DIR, `privat-dedup-${new Date().toISOString().replace(/[:.]/g, "-")}-acc${acc.id}.json`);
        writeFileSync(file, JSON.stringify(full, null, 1));
        console.log(`  резерв ${full.length} рядків → ${file}`);
        const del = await client.query(`DELETE FROM bank_transactions WHERE account_id = $1 AND id = ANY($2::int[])`, [acc.id, [...dropIds]]);
        if (del.rowCount !== drop.length) throw new Error(`видалено ${del.rowCount} ≠ план ${drop.length}`);
      }
      if (rekey.length) {
        const upd = await client.query(
          `UPDATE bank_transactions t SET external_tx_id = v.k
             FROM unnest($1::int[], $2::text[]) AS v(id, k)
            WHERE t.id = v.id AND t.account_id = $3`,
          [rekey.map((r) => r.id), rekey.map((r) => keyOf.get(r.id)), acc.id]);
        if (upd.rowCount !== rekey.length) throw new Error(`переписано ${upd.rowCount} ≠ план ${rekey.length}`);
      }
      // Інваріанти ПЕРЕД комітом — окремими запитами, не вірою в rowCount.
      const { rows: [n] } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM bank_transactions WHERE account_id = $1`, [acc.id]);
      if (n.n !== rows.length - drop.length) throw new Error(`після: ${n.n} ≠ ${rows.length} − ${drop.length}`);
      const { rows: [g] } = await client.query<{ dup: number }>(
        `SELECT count(*) FILTER (WHERE c > 1)::int AS dup FROM (SELECT count(*) AS c FROM bank_transactions
           WHERE account_id = $1 GROUP BY raw_json->>'REF', raw_json->>'NUM_DOC') s`, [acc.id]);
      if (g.dup !== 0) throw new Error(`лишилось груп із двійниками: ${g.dup}`);
      const { rows: after } = await client.query<Row>(`SELECT id, external_tx_id, currency, raw_json, direction, amount, amount_uah, is_bank_fee, created_at FROM bank_transactions WHERE account_id = $1`, [acc.id]);
      const wrong = after.filter((r) => normalizePrivat(r.raw_json as object, r.currency).externalTxId !== r.external_tx_id);
      if (wrong.length) throw new Error(`ключ ≠ normalizePrivat(raw_json) у ${wrong.length} рядків, напр. id=${wrong[0].id}`);
      await client.query("COMMIT");
      console.log(`  ✓ видалено ${drop.length}, ключ переписано ${rekey.length}, стало ${n.n}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally { client.release(); }
  }
  console.log(WRITE ? `РАЗОМ: видалено ${totalDrop}, переписано ${totalRekey}` : `СУХИЙ ПРОГІН: видалило б ${totalDrop}, переписало б ${totalRekey} (запис — з --write)`);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(e); process.exit(1); });
