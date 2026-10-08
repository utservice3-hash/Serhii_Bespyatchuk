import type { Db } from "./adCallFacts.js";

/**
 * 🏁 «УСПІХ УГОДИ» ПЕРШОГО ДОТИКУ (ТЗ «фінальні доробки після показу 08.10», критерій 5). Не AI, а статус угоди в Kommo
 * ЗАРАЗ — синк угод іде щопівгодини, тож окремого поля й годинного перерахунку не треба: стан читається на льоту.
 *
 *   успіх   — угода ЗАРАЗ в етапі «Успішно реалізовано» (`142`) — визначення зі словника метрик («результат менеджера =
 *             виключно 142», §0①);
 *   відмова — ЗАРАЗ «Не реалізовано» (`143`), з причиною відмови з CRM;
 *   у роботі — решта.
 *
 * 🔴 ВОРОНКА КВАЛІФІКАЦІЇ (`8921928`, `7336928`): там `142` означає «Кваліфіковано», а не продаж. Успіх такої угоди —
 * стан її ДОЧІРНЬОЇ угоди (звʼязок Kommo `lead_child_links`). Без дочірньої: `143` — відмова, решта — у роботі
 * (кваліфікована, але угоду продажу ще не створено — це не успіх).
 */

export type OutcomeState = "success" | "lost" | "open";
export interface DealOutcome { state: OutcomeState; lossReason: string | null }

export const QUALIFICATION_PIPELINES: ReadonlySet<number> = new Set([8921928, 7336928]);
const WON = 142, LOST = 143;

export interface OutcomeDeal { kommoId: number; pipelineId: number | null; statusId: number | null; rejectReason: string | null }

/** Стан однієї угоди; `children` — її дочірні угоди (лише для кваліфікації). */
export function outcomeOfDeal(d: OutcomeDeal, children: readonly OutcomeDeal[]): DealOutcome {
  const plain = (x: OutcomeDeal): DealOutcome => x.statusId === WON ? { state: "success", lossReason: null }
    : x.statusId === LOST ? { state: "lost", lossReason: x.rejectReason } : { state: "open", lossReason: null };
  if (d.pipelineId == null || !QUALIFICATION_PIPELINES.has(d.pipelineId)) return plain(d);
  if (children.length) return outcomeOfCall(children.map(plain));
  return d.statusId === LOST ? { state: "lost", lossReason: d.rejectReason } : { state: "open", lossReason: null };
}

/** Розмова буває першою для кількох угод: успіх, якщо успішна хоч одна; відмова — лише коли відмовили всі. */
export function outcomeOfCall(xs: readonly DealOutcome[]): DealOutcome {
  if (!xs.length) return { state: "open", lossReason: null };
  if (xs.some((x) => x.state === "success")) return { state: "success", lossReason: null };
  if (xs.every((x) => x.state === "lost")) return { state: "lost", lossReason: xs.find((x) => x.lossReason)?.lossReason ?? null };
  return { state: "open", lossReason: null };
}

/** Стан для кожної угоди зі списку — один запит на угоди й один на дочірні. */
export async function dealOutcomes(db: Db, kommoIds: readonly number[]): Promise<Map<number, DealOutcome>> {
  const out = new Map<number, DealOutcome>();
  if (!kommoIds.length) return out;
  const toDeal = (x: { kommo_id: string | number; pipeline_id: string | number | null; status_id: string | number | null; reject_reason: string | null }): OutcomeDeal =>
    ({ kommoId: Number(x.kommo_id), pipelineId: x.pipeline_id == null ? null : Number(x.pipeline_id),
      statusId: x.status_id == null ? null : Number(x.status_id), rejectReason: x.reject_reason });
  const deals = (await db.query<{ kommo_id: string; pipeline_id: string | null; status_id: string | null; reject_reason: string | null }>(
    `SELECT kommo_id, pipeline_id, status_id, reject_reason FROM deals WHERE kommo_id = ANY($1::bigint[])`, [[...kommoIds]])).rows.map(toDeal);
  const qual = deals.filter((d) => d.pipelineId != null && QUALIFICATION_PIPELINES.has(d.pipelineId)).map((d) => d.kommoId);
  const kids = new Map<number, OutcomeDeal[]>();
  if (qual.length) {
    const r = await db.query<{ parent_id: string; kommo_id: string; pipeline_id: string | null; status_id: string | null; reject_reason: string | null }>(
      `SELECT l.parent_id, d.kommo_id, d.pipeline_id, d.status_id, d.reject_reason
         FROM lead_child_links l JOIN deals d ON d.kommo_id = l.child_id WHERE l.parent_id = ANY($1::bigint[])`, [qual]);
    for (const x of r.rows) kids.set(Number(x.parent_id), [...(kids.get(Number(x.parent_id)) ?? []), toDeal(x)]);
  }
  for (const d of deals) out.set(d.kommoId, outcomeOfDeal(d, kids.get(d.kommoId) ?? []));
  return out;
}

/** Підписи для екрана. */
export const OUTCOME_UA: Record<OutcomeState, string> = { success: "успіх", lost: "відмова", open: "у роботі" };
