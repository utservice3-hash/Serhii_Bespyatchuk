/**
 * 🗄 ЗАПИС ФІНАНСОВИХ ПОЛІВ УГОД у `deal_fin_fields` і фільтри Kommo для синку (задача #5583, 26.10.2026). Окремо від
 * джоби `syncDealFinance` (та тримає пул і розклад), щоб правила перевірялись без бази прода.
 */
import type { KommoDeal } from "../kommo/client.js";
import { FULL_CYCLE_PIPELINES } from "./monthResult.js";
import { finFieldsOf, finRow, FIN_COLS } from "./dealFinFields.js";
import type { Db } from "./finance.js";

/** Запас інкременту назад від вотермарки (угода, змінена під час минулого проходу, не загубиться). */
export const OVERLAP_S = 600;
/** Фільтр Kommo: етап «Успішна» (142) обох воронок «Повного циклу». */
export const SUCCESS_FILTER = FULL_CYCLE_PIPELINES.map((p, i) => `filter[statuses][${i}][pipeline_id]=${p}&filter[statuses][${i}][status_id]=142`).join("&");
/** Інкремент: змінені в Kommo від вотермарки (сек) мінус запас. */
export const incrementQuery = (wm: number) => `${SUCCESS_FILTER}&filter[updated_at][from]=${Math.floor(wm - OVERLAP_S)}`;
/** Бекфіл: закриті з дати (за Києвом). */
export const backfillQuery = (from: string) => `${SUCCESS_FILTER}&filter[closed_at][from]=${Math.floor(new Date(`${from}T00:00:00+02:00`).getTime() / 1000)}`;

const cf = (d: KommoDeal, id: number): string | null => {
  const v = d.custom_fields_values?.find((f) => f.field_id === id)?.values?.[0]?.value;
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
};

/** Записує поля угод; старіший знімок не перетирає новіший (за `updated_at` Kommo), без дати — беремо свіже. */
export async function upsertDealFin(db: Db, deals: readonly KommoDeal[]): Promise<number> {
  for (let i = 0; i < deals.length; i += 1000) {
    const rows = deals.slice(i, i + 1000).map((d) => finRow(Number(d.id), d.updated_at ? new Date(d.updated_at * 1000) : null, finFieldsOf((f) => cf(d, f))));
    const col = (k: number) => rows.map((r) => r[k]);
    await db.query(`INSERT INTO deal_fin_fields (${FIN_COLS.join(", ")}, synced_at)
      SELECT *, now() FROM unnest($1::bigint[], $2::text[], $3::bool[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[],
        $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::int[], $14::timestamptz[])
      ON CONFLICT (kommo_id) DO UPDATE SET ${FIN_COLS.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(", ")}, synced_at = now()
      WHERE deal_fin_fields.kommo_updated_at IS NULL OR EXCLUDED.kommo_updated_at IS NULL OR EXCLUDED.kommo_updated_at >= deal_fin_fields.kommo_updated_at`,
    FIN_COLS.map((_, k) => col(k)));
  }
  return deals.length;
}
