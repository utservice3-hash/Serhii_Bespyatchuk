/**
 * 💸 Оплати з 1С → угода Kommo (заміна події Genesis «Оплата заказа», 943 за 30 днів).
 *
 * Джерела — те, що дашборд уже тягне з 1С: `onec_deal_payments` (`paydata`, щогодини о :45) і `onec_unpaid_invoices`
 * (неоплачені рахунки 2026 року, щогодини о :15). Джоба йде о :50 — одразу після свіжих оплат.
 *
 * Правило (підтвердив власник 27.10.2026):
 *   «Оплачено 1с»     = сума всіх оплат клієнта по угоді (одна валюта — числом, кілька — «1800 EUR + 500 UAH»);
 *   «Оплачено из 1с»  = за угодою є хоч одна оплата І немає жодного неоплаченого рахунку;
 *   етап              = за повної оплати угода, що стоїть ПЕРЕД «Оплата отримана», переходить у неї. З «Успішна»,
 *                       «Закрито», самої «Оплата отримана» та з інших воронок — ніколи (у Genesis так само заборонено
 *                       зворотний рух).
 *
 * ⚠️ Поки працює Genesis (`ZAKAZ1C_FIELDS_MODE=off`), у Kommo НЕ пишемо нічого: лише план у `zakaz_onec_pay_plan`
 * разом із тим, що записав Genesis (`deal_fin_fields.paid1c`, де він є), — щоб до перемикання бачити, наскільки наше
 * правило збігається з його подіями. У `live` пишемо лише те, що змінилось проти записаного нами минулого разу.
 * Відставання від Genesis — до години: він отримує оплату в момент запису в 1С, ми — щогодинним синком.
 */
import type { Pool } from "pg";
import { zakaz1cFieldsMode } from "./env.js";
import { KOMMO_FIELDS, patchLeads, type LeadPatch } from "./kommoApi.js";

/** «Оплата отримана» у воронках «Повного циклу» (docs/CRM_SCHEMA.md). */
export const PAID_STAGE: Record<number, number> = { 8921932: 69716460, 155304: 60412544 };

/** Етапи ПЕРЕД «Оплата отримана» — лише з них переводимо (порядок воронки, docs/CRM_SCHEMA.md). */
export const BEFORE_PAID: Record<number, ReadonlySet<number>> = {
  8921932: new Set([69693664, 108361876, 69693668, 69693672, 69716252, 69693676, 69716256, 69716260, 100274340, 69716300,
    98470988, 69716304, 69716312]),
  155304: new Set([26010520, 11804491, 10847806, 10869081, 69500840, 10883250, 62940064, 10937178, 42639144, 42639147,
    25044997, 62940068]),
};

export interface DealPayInput {
  dealId: number;
  pipelineId: number | null;
  statusId: number | null;
  payments: { sum: number; currency: string }[];
  unpaidInvoices: number;
}

export interface PayPlan { dealId: number; paidText: string; fullyPaid: boolean; moveTo: number | null }

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Чисте правило. `null` — оплат немає, писати нічого. */
export function planPayment(d: DealPayInput): PayPlan | null {
  const byCur = new Map<string, number>();
  for (const p of d.payments) if (p.sum > 0) byCur.set(p.currency || "UAH", (byCur.get(p.currency || "UAH") ?? 0) + p.sum);
  if (byCur.size === 0) return null;
  const parts = [...byCur.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const paidText = parts.length === 1 ? fmt(Math.round(parts[0][1] * 100) / 100)
    : parts.map(([c, s]) => `${fmt(Math.round(s * 100) / 100)} ${c}`).join(" + ");
  const fullyPaid = d.unpaidInvoices === 0;
  const before = d.pipelineId != null ? BEFORE_PAID[d.pipelineId] : undefined;
  const moveTo = fullyPaid && before && d.statusId != null && before.has(d.statusId) ? PAID_STAGE[d.pipelineId!] : null;
  return { dealId: d.dealId, paidText, fullyPaid, moveTo };
}

/** Що піде в Kommo для одного плану. Галочку лише СТАВИМО: зняту назад не пишемо, щоб не блимала між синками. */
export function patchOf(p: PayPlan, pipelineId: number | null): LeadPatch {
  const cf: NonNullable<LeadPatch["custom_fields_values"]> = [{ field_id: KOMMO_FIELDS.leadPaid1c, values: [{ value: p.paidText }] }];
  if (p.fullyPaid) cf.push({ field_id: KOMMO_FIELDS.leadPaidFrom1c, values: [{ value: true }] });
  return { id: p.dealId, custom_fields_values: cf, ...(p.moveTo && pipelineId ? { status_id: p.moveTo, pipeline_id: pipelineId } : {}) };
}

/** Кандидати — угоди з оплатою за останні 90 днів; суму рахуємо по ВСІХ оплатах угоди, не лише за вікно. */
const CANDIDATES_SQL = `
  WITH c AS (SELECT DISTINCT deal_id FROM onec_deal_payments WHERE paid_on >= (now() AT TIME ZONE 'Europe/Kyiv')::date - 90)
  SELECT c.deal_id::text AS deal_id, d.pipeline_id::int AS pipeline_id, d.status_id::int AS status_id, -- BIGINT pg віддає рядком: Set.has("…") мовчки false
         COALESCE((SELECT json_agg(json_build_object('sum', p.sum, 'currency', p.currency)) FROM onec_deal_payments p
                    WHERE p.deal_id = c.deal_id), '[]'::json) AS pays,
         (SELECT count(*) FROM onec_unpaid_invoices u WHERE u.deal_id = c.deal_id)::int AS unpaid,
         f.paid1c AS genesis_paid1c
    FROM c LEFT JOIN deals d ON d.kommo_id = c.deal_id LEFT JOIN deal_fin_fields f ON f.kommo_id = c.deal_id`;

export async function runPayments(pool: Pool): Promise<{ deals: number; fullyPaid: number; moves: number; written: number; mode: string;
  genesisKnown: number; genesisAgree: number }> {
  const mode = zakaz1cFieldsMode();
  const q = await pool.query<{ deal_id: string; pipeline_id: number | null; status_id: number | null; pays: { sum: string | number; currency: string }[];
    unpaid: number; genesis_paid1c: boolean | null }>(CANDIDATES_SQL);
  const plans: { plan: PayPlan; pipelineId: number | null; statusId: number | null; genesis: boolean | null }[] = [];
  for (const r of q.rows) {
    const plan = planPayment({ dealId: Number(r.deal_id), pipelineId: r.pipeline_id, statusId: r.status_id,
      payments: (r.pays ?? []).map((p) => ({ sum: Number(p.sum) || 0, currency: String(p.currency ?? "") })), unpaidInvoices: r.unpaid });
    if (plan) plans.push({ plan, pipelineId: r.pipeline_id, statusId: r.status_id, genesis: r.genesis_paid1c });
  }

  // Що вже записано нами — щоб у live писати лише зміни.
  const prev = new Map((await pool.query<{ deal_id: string; written_text: string | null; written_paid: boolean | null; written_status: number | null }>(
    `SELECT deal_id::text AS deal_id, written_text, written_paid, written_status FROM zakaz_onec_pay_plan`)).rows.map((r) => [Number(r.deal_id), r]));

  const toWrite = mode === "live" ? plans.filter(({ plan }) => {
    const w = prev.get(plan.dealId);
    return !w || w.written_text !== plan.paidText || (plan.fullyPaid && w.written_paid !== true) || (plan.moveTo != null && w.written_status !== plan.moveTo);
  }) : [];
  let writeError: string | null = null;
  if (toWrite.length) {
    try { await patchLeads(toWrite.map(({ plan, pipelineId }) => patchOf(plan, pipelineId))); } catch (e) { writeError = (e as Error).message.slice(0, 300); }
  }
  const written = new Set(writeError ? [] : toWrite.map(({ plan }) => plan.dealId));

  // Одним запитом на пачку: план годинний, угод — тисячі, а кожен окремий запит до Neon — десятки мс.
  const tried = new Set(toWrite.map((t) => t.plan.dealId));
  for (let i = 0; i < plans.length; i += 1000) {
    const part = plans.slice(i, i + 1000);
    await pool.query(
      `INSERT INTO zakaz_onec_pay_plan AS t (deal_id, paid_text, fully_paid, move_to, current_status, genesis_paid1c, computed_at,
         written_text, written_paid, written_status, written_at, write_error)
       SELECT x.deal_id, x.paid_text, x.fully_paid, x.move_to, x.current_status, x.genesis_paid1c, now(),
              CASE WHEN x.w THEN x.paid_text END, CASE WHEN x.w THEN x.fully_paid END, CASE WHEN x.w THEN x.move_to END,
              CASE WHEN x.w THEN now() END, x.err
         FROM unnest($1::bigint[], $2::text[], $3::boolean[], $4::bigint[], $5::bigint[], $6::boolean[], $7::boolean[], $8::text[])
           AS x(deal_id, paid_text, fully_paid, move_to, current_status, genesis_paid1c, w, err)
       ON CONFLICT (deal_id) DO UPDATE SET paid_text = EXCLUDED.paid_text, fully_paid = EXCLUDED.fully_paid, move_to = EXCLUDED.move_to,
         current_status = EXCLUDED.current_status, genesis_paid1c = EXCLUDED.genesis_paid1c, computed_at = now(),
         written_text = COALESCE(EXCLUDED.written_text, t.written_text), written_paid = COALESCE(EXCLUDED.written_paid, t.written_paid),
         written_status = COALESCE(EXCLUDED.written_status, t.written_status), written_at = COALESCE(EXCLUDED.written_at, t.written_at),
         write_error = EXCLUDED.write_error`,
      [part.map((p) => p.plan.dealId), part.map((p) => p.plan.paidText), part.map((p) => p.plan.fullyPaid), part.map((p) => p.plan.moveTo),
        part.map((p) => p.statusId), part.map((p) => p.genesis), part.map((p) => written.has(p.plan.dealId)),
        part.map((p) => (tried.has(p.plan.dealId) ? writeError : null))],
    );
  }
  if (writeError) throw new Error(`оплати в Kommo не записались: ${writeError}`);
  const known = plans.filter((p) => p.genesis !== null);
  return {
    deals: plans.length, fullyPaid: plans.filter((p) => p.plan.fullyPaid).length, moves: plans.filter((p) => p.plan.moveTo).length,
    written: written.size, mode, genesisKnown: known.length, genesisAgree: known.filter((p) => p.genesis === p.plan.fullyPaid).length,
  };
}
