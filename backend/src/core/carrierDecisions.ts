import type { Db } from "./adCallFacts.js";
import { CARRIER_STAGE, CARRIER_THRESHOLD, carrierBucket, RUBRIC_CARRIER_V1, type CarrierResult } from "./carrierCallRules.js";

/**
 * 🙋 РІШЕННЯ ЛЮДИНИ ПО НЕВПЕВНЕНИХ (рішення Романа 29.09.2026, макет погоджено).
 *
 * AI не впевнений (нижче 0,85, цитата — слова менеджера, розмову не розібрати) — вирішує людина: «Перевізник»,
 * «Клієнт» або «Інше». Рішення людини СИЛЬНІШЕ за AI в обидва боки:
 *   · «Перевізник» → угода йде тим самим шляхом закриття в CRM, що й упевнені (`carrierClose.ts`);
 *   · «Клієнт» / «Інше» → автоматика цю угоду не закриває НІКОЛИ, хоч би що потім сказав AI.
 * Історія рішень лише дописується (хто, коли, що, що казав AI); чинне — останнє. Змінити можна, доки угоду
 * не закрито в CRM; після закриття — лише «Повернути на етап».
 */

export type HumanDecision = "carrier" | "client" | "other";
export const HUMAN_DECISIONS: readonly HumanDecision[] = ["carrier", "client", "other"];
export const NOTE_MAX = 500;

/** Чому AI не впевнений — коротко, для рядка черги. `null` — упевнений (у черзі не буває). */
export function whyUncertain(r: Pick<CarrierResult, "caller_role" | "caller_role_confidence" | "quote_check">): string | null {
  const b = carrierBucket(r);
  if (b === "unclear") return "не чути";
  if (b !== "low") return null;
  if (r.caller_role_confidence < CARRIER_THRESHOLD) return "невпевнено";
  if (r.quote_check === "manager") return "цитата менеджера";
  return "цитата не знайдена";
}

export interface PendingRow {
  kommoId: number; uniqueid: string; calledAt: string; billsec: number; managerName: string | null;
  role: string; confidence: number; why: string;
}
export interface DecidedRow extends PendingRow { decision: HumanDecision; note: string | null; by: string; at: string }

interface Raw {
  kommo_id: string; u: string; calldate: Date; billsec: number; manager_name: string | null; result: CarrierResult;
  dec: HumanDecision | null; dec_note: string | null; dec_by: string | null; dec_at: Date | null; closed: boolean;
}

/**
 * Черга: угоди, що стоять на етапі (за `deals`, синк раз на 30 хв), з вердиктом «невпевнено/не розібрати»,
 * без рішення людини й не закриті дашбордом. «Вирішені» — останні рішення за `decidedDays`.
 */
export async function decisionQueue(db: Db, now: Date, decidedDays = 30): Promise<{ pending: PendingRow[]; decided: DecidedRow[] }> {
  const r = await db.query<Raw>(`
    SELECT d.kommo_id::text, t.uniqueid AS u, rc.calldate, rc.billsec, m.name AS manager_name, a.result,
           cd.decision AS dec, cd.note AS dec_note, COALESCE(um.name, uu.email) AS dec_by, cd.decided_at AS dec_at,
           (cl.closed_at IS NOT NULL AND cl.reverted_at IS NULL) AS closed
      FROM carrier_call_deals d
      LEFT JOIN carrier_call_deals src ON src.kommo_id = d.reused_from
      JOIN call_transcripts t ON t.uniqueid = COALESCE(src.uniqueid, d.uniqueid)
      JOIN call_analyses a ON a.transcript_id = t.id AND a.rubric_version = $1 AND a.status = 'done'
      JOIN ringostat_calls rc ON rc.uniqueid = t.uniqueid
      LEFT JOIN managers m ON m.id = rc.manager_id
      LEFT JOIN deals dd ON dd.kommo_id = d.kommo_id
      LEFT JOIN LATERAL (SELECT x.decision, x.note, x.decided_by, x.decided_at FROM carrier_decisions x
                          WHERE x.kommo_id = d.kommo_id ORDER BY x.id DESC LIMIT 1) cd ON true
      LEFT JOIN users uu ON uu.id = cd.decided_by
      LEFT JOIN managers um ON um.id = uu.manager_id
      LEFT JOIN carrier_close_log cl ON cl.kommo_id = d.kommo_id
     WHERE d.state IN ('own', 'reused')
       AND (cd.decision IS NOT NULL AND cd.decided_at >= $2::timestamptz - make_interval(days => $3)
            OR cd.decision IS NULL AND dd.status_id = $4)
     ORDER BY rc.calldate DESC, d.kommo_id`,
  [RUBRIC_CARRIER_V1, now.toISOString(), decidedDays, CARRIER_STAGE.statusId]);
  const pending: PendingRow[] = [], decided: DecidedRow[] = [];
  for (const x of r.rows) {
    const why = whyUncertain(x.result);
    const base: PendingRow = { kommoId: Number(x.kommo_id), uniqueid: x.u, calledAt: new Date(x.calldate).toISOString(), billsec: Number(x.billsec),
      managerName: x.manager_name, role: x.result.caller_role, confidence: Number(x.result.caller_role_confidence), why: why ?? "" };
    if (x.dec) decided.push({ ...base, decision: x.dec, note: x.dec_note, by: x.dec_by ?? "невідомо", at: new Date(x.dec_at!).toISOString() });
    else if (why && !x.closed) pending.push(base);
  }
  return { pending, decided };
}

/**
 * Записати рішення. Відмова: невідоме рішення (400), угоди немає серед дзвінків на мобільні (404), угоду вже
 * закрито в CRM — повертати треба кнопкою «Повернути на етап» (409).
 */
export async function recordDecision(db: Db, kommoId: number, decision: string, note: unknown, userId: number, now: Date):
  Promise<{ ok: true } | { ok: false; code: 400 | 404 | 409; why: string }> {
  if (!HUMAN_DECISIONS.includes(decision as HumanDecision)) return { ok: false, code: 400, why: "рішення — «carrier», «client» або «other»" };
  const n = typeof note === "string" ? note.trim().slice(0, NOTE_MAX) : "";
  const d = (await db.query<{ closed: boolean; role: string | null; conf: string | null }>(`
    SELECT (cl.closed_at IS NOT NULL AND cl.reverted_at IS NULL) AS closed,
           a.result->>'caller_role' AS role, a.result->>'caller_role_confidence' AS conf
      FROM carrier_call_deals d
      LEFT JOIN carrier_call_deals src ON src.kommo_id = d.reused_from
      LEFT JOIN call_transcripts t ON t.uniqueid = COALESCE(src.uniqueid, d.uniqueid)
      LEFT JOIN call_analyses a ON a.transcript_id = t.id AND a.rubric_version = $2 AND a.status = 'done'
      LEFT JOIN carrier_close_log cl ON cl.kommo_id = d.kommo_id
     WHERE d.kommo_id = $1 LIMIT 1`, [kommoId, RUBRIC_CARRIER_V1])).rows[0];
  if (!d) return { ok: false, code: 404, why: "угоди немає серед дзвінків на мобільні" };
  if (d.closed) return { ok: false, code: 409, why: "угоду вже закрито в CRM — поверніть її на етап кнопкою «Повернути на етап»" };
  await db.query(`INSERT INTO carrier_decisions (kommo_id, decision, note, decided_by, decided_at, ai_role, ai_confidence)
                  VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [kommoId, decision, n || null, userId, now.toISOString(), d.role, d.conf == null ? null : Number(d.conf)]);
  return { ok: true };
}
