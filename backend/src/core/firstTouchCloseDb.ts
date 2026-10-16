import type { Db } from "./adCallFacts.js";
import {
  CLOSE_REASONS, CLOSE_TASK_TEXT, closeAllowed, closeDealPayload, closeNote, closeTarget, LOST, reasonLabel,
  revertDealPayload, revertNote, suggestReason, type DealState,
} from "./firstTouchClose.js";

/**
 * ❌ Запис «Закрити угоду в Kommo» з картки «Першого дотику» (рішення Романа 16.10.2026; правила — `firstTouchClose.ts`).
 * Kommo — параметром (`CloseKommo`): роут дає справжні виклики, гейти — підробку, тож запис у CRM у тестах неможливий.
 */
export interface CloseKommo {
  /** Свіжий стан угоди ПРЯМО з Kommo — на момент кнопки, а не з останнього синку. `null` — угоди немає. */
  leadState: (kommoId: number) => Promise<{ pipelineId: number; statusId: number } | null>;
  patchLeads: (body: unknown[]) => Promise<unknown>;
  addNotes: (body: unknown[]) => Promise<unknown>;
  openTaskIds?: (leadIds: readonly number[]) => Promise<number[]>;
  closeTasks?: (taskIds: readonly number[], resultText: string) => Promise<unknown>;
}

export interface CloseOffer {
  /** Яку угоду закриє кнопка; `null` — у розмови немає угоди повного циклу чи кваліфікації. */
  target: { kommoId: number; allowed: boolean; stage: string | null; why: string | null } | null;
  reasons: readonly { id: number; label: string }[];
  /** Причина, яку підставив AI; `null` — обирає людина. */
  suggestedId: number | null;
  /** Чинне закриття з дашборда (неповернуте) — показуємо «хто й коли» і «Повернути». */
  closed: { kommoId: number; reason: string; byName: string | null; at: string } | null;
}

const dealStates = async (db: Db, ids: readonly number[]): Promise<DealState[]> => {
  if (!ids.length) return [];
  const r = await db.query<{ kommo_id: string; pipeline_id: string | null; status_id: string | null }>(
    "SELECT kommo_id::text, pipeline_id::text, status_id::text FROM deals WHERE kommo_id = ANY($1::bigint[])", [[...ids]]);
  const by = new Map(r.rows.map((x) => [Number(x.kommo_id), x]));
  return ids.map((id) => {
    const x = by.get(id);
    return { kommoId: id, pipelineId: x?.pipeline_id == null ? null : Number(x.pipeline_id), statusId: x?.status_id == null ? null : Number(x.status_id) };
  });
};

const activeClose = async (db: Db, uniqueid: string) => (await db.query<{ id: string; kommo_id: string; reason_label: string;
  closed_by_name: string | null; closed_at: Date; prev_pipeline_id: string; prev_status_id: string }>(
  `SELECT id::text, kommo_id::text, reason_label, closed_by_name, closed_at, prev_pipeline_id::text, prev_status_id::text
     FROM first_touch_closes WHERE uniqueid = $1 AND reverted_at IS NULL ORDER BY closed_at DESC LIMIT 1`, [uniqueid])).rows[0] ?? null;

/** Що показати в картці. Стан угоди — з останнього синку; перед ЗАПИСОМ він звіряється з Kommo наживо. */
export async function closeOffer(db: Db, row: {
  uniqueid: string; kommoIds: readonly number[]; conversationType: string | null;
  objection: { present: boolean; type: string } | null; decision: { value: string } | null;
}): Promise<CloseOffer> {
  const closedRow = await activeClose(db, row.uniqueid);
  const closed = closedRow ? { kommoId: Number(closedRow.kommo_id), reason: closedRow.reason_label, byName: closedRow.closed_by_name,
    at: new Date(closedRow.closed_at).toISOString() } : null;
  const t = closeTarget(await dealStates(db, row.kommoIds));
  const a = t ? closeAllowed(t) : null;
  return {
    target: t && a ? { kommoId: t.kommoId, allowed: a.ok, stage: a.ok ? a.stage : null, why: a.ok ? null : a.why } : null,
    reasons: CLOSE_REASONS,
    suggestedId: suggestReason({ conversationType: row.conversationType, objection: row.objection, decision: row.decision }),
    closed,
  };
}

export type CloseResult = { ok: true; kommoId: number } | { ok: false; code: 400 | 409 | 502; why: string };

/**
 * Закрити. Порядок: причина з довідника → угода-ціль → СВІЖИЙ стан з Kommo (зрушили — відмова без запису) → задачі угоди
 * ПЕРШИМИ (як у «Перевізниках»: інакше задача лишилась би на закритій угоді) → угода → журнал → примітка (її збій закриття
 * не скасовує: причина вже в полі, людина — в журналі).
 */
export async function closeDeal(db: Db, kommo: CloseKommo, x: {
  uniqueid: string; kommoIds: readonly number[]; calledAt: string; reasonId: number; suggestedId: number | null;
  user: { id: number | null; name: string }; now: Date;
}): Promise<CloseResult> {
  const reason = reasonLabel(x.reasonId);
  if (!reason) return { ok: false, code: 400, why: "причина не з довідника Kommo" };
  if (await activeClose(db, x.uniqueid)) return { ok: false, code: 409, why: "угоду цієї розмови вже закрито з дашборда — спершу «Повернути»" };
  const t = closeTarget(await dealStates(db, x.kommoIds));
  if (!t) return { ok: false, code: 409, why: "у розмови немає угоди повного циклу чи кваліфікації" };
  let fresh: { pipelineId: number; statusId: number } | null;
  try { fresh = await kommo.leadState(t.kommoId); } catch (e) {
    return { ok: false, code: 502, why: `Kommo не відповів: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
  if (!fresh) return { ok: false, code: 409, why: "угоди немає в Kommo" };
  const allowed = closeAllowed({ kommoId: t.kommoId, ...fresh });
  if (!allowed.ok) return { ok: false, code: 409, why: `у Kommo ${allowed.why}` };
  if (kommo.openTaskIds && kommo.closeTasks) {
    try { const ids = await kommo.openTaskIds([t.kommoId]); if (ids.length) await kommo.closeTasks(ids, CLOSE_TASK_TEXT); } catch { /* задачі — не привід не закрити угоду */ }
  }
  try { await kommo.patchLeads(closeDealPayload({ kommoId: t.kommoId, pipelineId: fresh.pipelineId }, x.reasonId)); } catch (e) {
    return { ok: false, code: 502, why: `Kommo не закрив угоду: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` };
  }
  await db.query(`INSERT INTO first_touch_closes (kommo_id, uniqueid, reason_id, reason_label, suggested_id, prev_pipeline_id, prev_status_id,
                    closed_by, closed_by_name, closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [t.kommoId, x.uniqueid, x.reasonId, reason, x.suggestedId, fresh.pipelineId, fresh.statusId, x.user.id, x.user.name, x.now.toISOString()]);
  await kommo.addNotes([{ entity_id: t.kommoId, note_type: "common", params: { text: closeNote(x.user.name, reason, x.calledAt) } }]).catch(() => undefined);
  return { ok: true, kommoId: t.kommoId };
}

/** Повернути на попередні воронку й етап. Лише поки угода в Kommo ДОСІ закрита: її могли вже змінити руками. */
export async function revertDeal(db: Db, kommo: CloseKommo, x: { uniqueid: string; user: { id: number | null; name: string }; now: Date }): Promise<CloseResult> {
  const c = await activeClose(db, x.uniqueid);
  if (!c) return { ok: false, code: 409, why: "угоду цієї розмови з дашборда не закривали (або вже повернули)" };
  const id = Number(c.kommo_id);
  let fresh: { pipelineId: number; statusId: number } | null;
  try { fresh = await kommo.leadState(id); } catch (e) {
    return { ok: false, code: 502, why: `Kommo не відповів: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
  if (!fresh || fresh.statusId !== LOST) return { ok: false, code: 409, why: "угоду в Kommo вже змінили після закриття — повертайте в CRM" };
  try { await kommo.patchLeads(revertDealPayload({ kommoId: id, prevPipelineId: Number(c.prev_pipeline_id), prevStatusId: Number(c.prev_status_id) })); } catch (e) {
    return { ok: false, code: 502, why: `Kommo не повернув угоду: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` };
  }
  await db.query("UPDATE first_touch_closes SET reverted_by = $2, reverted_by_name = $3, reverted_at = $4 WHERE id = $1",
    [c.id, x.user.id, x.user.name, x.now.toISOString()]);
  await kommo.addNotes([{ entity_id: id, note_type: "common", params: { text: revertNote(x.user.name) } }]).catch(() => undefined);
  return { ok: true, kommoId: id };
}
