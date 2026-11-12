/**
 * 🚦 ФАКТИ ДЛЯ ЕКРАНА ТІМЛІДА «з ким з постійних говорити» (задача 7360) — пакетно по ключах клієнтів.
 * Правило — `clientLeadRules.ts` (чисте); тут лише читання. Грошей тут немає: дати й лічильники подій, тож ядро
 * `money.ts` не обходиться.
 *
 * Усі дати — київські `YYYY-MM-DD`. Кожен запит — один на весь список (стеля роуту 20 с), по індексах:
 * `idx_rc_client_key`, `uniq_deal_stage_event`, `call_transcripts(uniqueid, …)`.
 */
import { REACT_STATUS_ID } from "./clientKommoTaskRules.js";
import { notCarrierCallSql } from "./carrierPhones.js";
import { TALK_MIN_SEC } from "./clientLeadRules.js";

export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
}

export interface LeadFacts {
  /** Остання розмова від 10 с (не з номером перевізника). */
  talk10: string | null;
  /** Суть останньої розмови, яку розібрав AI: дата розмови й короткий підсумок. */
  summary: { at: string; text: string } | null;
  /** Остання зміна етапу будь-якої угоди клієнта в Kommo. */
  stage: string | null;
  /** Остання НОВА угода клієнта (дата створення в Kommo), будь-який етап — задача 8333. */
  dealNew: string | null;
  /** Дата другої оплаченої угоди (коли клієнт став постійним) і канал першої. */
  secondPaid: string | null;
  firstPaidChannel: string | null;
  /** Клієнт у реєстрі LTV лідгенів (прийшов через передачу лідогенерації). */
  leadgen: boolean;
}

const KYIV_DAY = (col: string) => `to_char(${col} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD')`;

export async function leadFactsFor(db: Db, keys: string[], stageSinceDays = 200): Promise<Map<string, LeadFacts>> {
  const out = new Map<string, LeadFacts>();
  if (!keys.length) return out;
  const [talk, summ, stage, paid, lg, fresh] = await Promise.all([
    db.query<{ client_key: string; d: string }>(
      `SELECT DISTINCT ON (rc.client_key) rc.client_key, ${KYIV_DAY("rc.calldate")} AS d
         FROM ringostat_calls rc
        WHERE rc.client_key = ANY($1) AND rc.billsec >= $2 AND ${notCarrierCallSql("rc")}
        ORDER BY rc.client_key, rc.calldate DESC`, [keys, TALK_MIN_SEC]),
    db.query<{ client_key: string; d: string; text: string }>(
      `SELECT DISTINCT ON (rc.client_key) rc.client_key, ${KYIV_DAY("rc.calldate")} AS d, ca.result->>'summary' AS text
         FROM ringostat_calls rc
         JOIN call_transcripts ct ON ct.uniqueid = rc.uniqueid
         JOIN call_analyses ca ON ca.transcript_id = ct.id AND ca.status = 'done'
        WHERE rc.client_key = ANY($1) AND rc.billsec >= $2 AND ${notCarrierCallSql("rc")}
          AND COALESCE(btrim(ca.result->>'summary'), '') <> ''
        ORDER BY rc.client_key, rc.calldate DESC, ca.id DESC`, [keys, TALK_MIN_SEC]),
    db.query<{ client_key: string; d: string }>(
      `SELECT d.client_key, ${KYIV_DAY("max(e.changed_at)")} AS d
         FROM deal_stage_events e JOIN deals d ON d.kommo_id = e.kommo_id
        WHERE d.client_key = ANY($1) AND e.changed_at >= now() - make_interval(days => $2)
          AND e.status_id <> ${String(REACT_STATUS_ID)}
        GROUP BY d.client_key`, [keys, stageSinceDays]),
    db.query<{ client_key: string; rn: string; d: string; ch: string | null }>(
      `SELECT client_key, rn, d, ch FROM (
         SELECT d.client_key, ${KYIV_DAY("d.closed_at_kommo")} AS d, d.lead_channel AS ch,
                ROW_NUMBER() OVER (PARTITION BY d.client_key ORDER BY d.closed_at_kommo, d.kommo_id) AS rn
           FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
          WHERE psm.funnel_stage = 'paid' AND d.client_key = ANY($1) AND d.closed_at_kommo IS NOT NULL) z
        WHERE rn <= 2`, [keys]),
    db.query<{ client_key: string }>(`SELECT DISTINCT client_key FROM leadgen_ltv_clients WHERE client_key = ANY($1)`, [keys]),
    db.query<{ client_key: string; d: string }>(
      `SELECT d.client_key, ${KYIV_DAY("max(d.created_at_kommo)")} AS d FROM deals d
        WHERE d.client_key = ANY($1) AND d.created_at_kommo >= now() - make_interval(days => $2)
          AND NOT EXISTS (SELECT 1 FROM client_next_steps ns WHERE ns.kommo_lead_id = d.kommo_id AND ns.kommo_lead_created)
        GROUP BY d.client_key`, [keys, stageSinceDays]),
  ]);
  const get = (k: string): LeadFacts => {
    let f = out.get(k);
    if (!f) { f = { talk10: null, summary: null, stage: null, dealNew: null, secondPaid: null, firstPaidChannel: null, leadgen: false }; out.set(k, f); }
    return f;
  };
  for (const r of talk.rows) get(r.client_key).talk10 = r.d;
  for (const r of summ.rows) get(r.client_key).summary = { at: r.d, text: r.text.trim() };
  for (const r of stage.rows) get(r.client_key).stage = r.d;
  for (const r of paid.rows) {
    if (Number(r.rn) === 1) get(r.client_key).firstPaidChannel = r.ch;
    else get(r.client_key).secondPaid = r.d;
  }
  for (const r of lg.rows) get(r.client_key).leadgen = true;
  for (const r of fresh.rows) get(r.client_key).dealNew = r.d;
  return out;
}

/** Дата постановки відкритих задач на дзвінок (`reactivation_client`) — для правила «передати іншому». */
export async function taskCreatedFor(db: Db, taskIds: number[]): Promise<Map<number, string>> {
  if (!taskIds.length) return new Map();
  const r = await db.query<{ id: number; d: string }>(
    `SELECT id, ${KYIV_DAY("created_at")} AS d FROM tasks WHERE id = ANY($1::int[])`, [taskIds]);
  return new Map(r.rows.map((x) => [Number(x.id), x.d]));
}
