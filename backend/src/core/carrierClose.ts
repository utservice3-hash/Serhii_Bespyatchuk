import type { Db } from "./adCallFacts.js";
import { CARRIER_STAGE, carrierBucket, RUBRIC_CARRIER_V1, type CarrierResult } from "./carrierCallRules.js";

/**
 * 🧹 ЗАКРИТТЯ ПЕРЕВІЗНИКІВ У KOMMO (рішення Романа 29.09.2026: «прибирати з рішенням від Gemini»).
 *
 * Kommo угоди не видаляє — угода закривається «Не цільовою» (статус 143) з причиною «Перевізник», так само,
 * як це робить фільтр CRM. Закриваємо ЛИШЕ впевненого перевізника (≥ 0,85 і цитата співрозмовника, кошик
 * `carrier`) і ЛИШЕ угоду, що ДОСІ стоїть на етапі за свіжою відповіддю Kommo цього ж проходу.
 *
 * Режим — змінна `CARRIER_AUTO_CLOSE` на сервері: `live` — пишемо в Kommo; `off` — нічого; будь-що інше,
 * включно з відсутністю, — `dry`: лише журнал «кого закрили б» (рішення Романа: першу добу — лише журнал).
 * Вмикає запис рівно одне значення, тож описка не вмикає запис у CRM.
 *
 * Журнал `carrier_close_log` — рядок на угоду: коли вирішено, коли закрито, коли й ким повернуто. Повернута
 * людиною угода більше НЕ закривається автоматично: рішення людини сильніше за модель.
 */

export type CloseMode = "off" | "dry" | "live";
export function closeModeOf(raw: string | null | undefined): CloseMode {
  const v = (raw ?? "").trim();
  if (v === "live") return "live";
  if (v === "off") return "off";
  return "dry";
}

export const REJECT_FIELD = 2097265;
/** Значення «Перевізник» поля «Причина отказа» — заміряно в Kommo 29.09.2026 (GET /leads/custom_fields/2097265). */
export const REJECT_ENUM_CARRIER = 6343043;
export const LOST_STATUS = 143;
export const CLOSE_BATCH = 50;
export const CLOSE_MAX_PER_TICK = 50;
/** Після невдалого запису до Kommo повтор — не частіше ніж раз на годину: не бомбимо CRM помилками щоп'ять хвилин. */
export const RETRY_AFTER_MIN = 60;

export function closePayload(ids: readonly number[]): unknown[] {
  return ids.map((id) => ({
    id, pipeline_id: CARRIER_STAGE.pipelineId, status_id: LOST_STATUS,
    custom_fields_values: [{ field_id: REJECT_FIELD, values: [{ enum_id: REJECT_ENUM_CARRIER }] }],
  }));
}

export function revertPayload(id: number): unknown[] {
  return [{ id, pipeline_id: CARRIER_STAGE.pipelineId, status_id: CARRIER_STAGE.statusId,
    custom_fields_values: [{ field_id: REJECT_FIELD, values: null }] }];
}

export function closeNoteText(confidence: number, quote: string | null, byHuman = false): string {
  const c = confidence.toFixed(2).replace(".", ",");
  const who = byHuman ? "перевізник — рішення людини після прослуховування" : `перевізник за розмовою (впевненість ${c})`;
  return `Закрито дашбордом: ${who}${quote && !byHuman ? `. Співрозмовник: «${quote}»` : ""}. `
    + "Помилка — поверніть угоду на етап у вкладці «Перевізники за розмовою».";
}

export function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export interface KommoCloser {
  patchLeads: (body: unknown[]) => Promise<unknown>;
  addNotes: (body: unknown[]) => Promise<unknown>;
}

export interface CloseCandidate { kommoId: number; uniqueid: string; confidence: number; quote: string | null; logged: boolean; byHuman: boolean }

/**
 * Хто зараз підлягає закриттю. `onStage` — id угод із ВІДПОВІДІ Kommo цього проходу: угоду, яку фільтр чи
 * менеджер уже зрушили, не чіпаємо навіть за впевненого вердикту.
 */
export async function closeCandidates(db: Db, onStage: ReadonlySet<number>, now: Date): Promise<CloseCandidate[]> {
  const r = await db.query<{ kommo_id: string; u: string; result: CarrierResult; logged: boolean; closed: boolean; reverted: boolean;
    recent_fail: boolean; dec: string | null }>(`
    SELECT d.kommo_id::text, t.uniqueid AS u, a.result,
           (SELECT x.decision FROM carrier_decisions x WHERE x.kommo_id = d.kommo_id ORDER BY x.id DESC LIMIT 1) AS dec,
           l.kommo_id IS NOT NULL AS logged, l.closed_at IS NOT NULL AS closed, l.reverted_at IS NOT NULL AS reverted,
           (l.last_try_at IS NOT NULL AND l.close_error IS NOT NULL AND l.last_try_at > $1::timestamptz - make_interval(mins => $2)) AS recent_fail
      FROM carrier_call_deals d
      LEFT JOIN carrier_call_deals src ON src.kommo_id = d.reused_from
      JOIN call_transcripts t ON t.uniqueid = COALESCE(src.uniqueid, d.uniqueid)
      JOIN call_analyses a ON a.transcript_id = t.id AND a.rubric_version = $3 AND a.status = 'done'
      LEFT JOIN carrier_close_log l ON l.kommo_id = d.kommo_id
     WHERE d.state IN ('own', 'reused')
     ORDER BY d.deal_created_at, d.kommo_id`, [now.toISOString(), RETRY_AFTER_MIN, RUBRIC_CARRIER_V1]);
  // 🙋 Рішення людини сильніше за AI в обидва боки: «Перевізник» закриваємо й без упевненого AI,
  // «Клієнт»/«Інше» не закриваємо ніколи (`carrierDecisions.ts`).
  const wanted = (x: { dec: string | null; result: CarrierResult }) =>
    x.dec != null ? x.dec === "carrier" : carrierBucket(x.result) === "carrier";
  return r.rows
    .filter((x) => onStage.has(Number(x.kommo_id)) && !x.closed && !x.reverted && !x.recent_fail && wanted(x))
    .map((x) => ({ kommoId: Number(x.kommo_id), uniqueid: x.u, confidence: Number(x.result.caller_role_confidence),
      quote: x.result.caller_role_quote || null, logged: x.logged, byHuman: x.dec === "carrier" }));
}

export interface CloseReport { mode: CloseMode; candidates: number; logged: number; closed: number; failed: number; error: string | null }

export async function runCarrierClose(db: Db, now: Date, mode: CloseMode, onStage: ReadonlySet<number>, kommo: KommoCloser): Promise<CloseReport> {
  const rep: CloseReport = { mode, candidates: 0, logged: 0, closed: 0, failed: 0, error: null };
  if (mode === "off") return rep;
  const cands = await closeCandidates(db, onStage, now);
  rep.candidates = cands.length;
  const fresh = cands.filter((c) => !c.logged);
  if (fresh.length) {
    const ins = await db.query(
      `INSERT INTO carrier_close_log (kommo_id, uniqueid, confidence, quote, decided_at, mode)
       SELECT k, u, c, q, $5::timestamptz, $6 FROM unnest($1::bigint[], $2::text[], $3::numeric[], $4::text[]) AS x(k, u, c, q)
       ON CONFLICT (kommo_id) DO NOTHING`,
      [fresh.map((c) => c.kommoId), fresh.map((c) => c.uniqueid), fresh.map((c) => c.confidence), fresh.map((c) => c.quote),
        now.toISOString(), mode]);
    rep.logged = ins.rowCount ?? 0;
  }
  if (mode !== "live") return rep;

  for (const batch of chunks(cands.slice(0, CLOSE_MAX_PER_TICK), CLOSE_BATCH)) {
    const ids = batch.map((c) => c.kommoId);
    try {
      await kommo.patchLeads(closePayload(ids));
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await db.query(`UPDATE carrier_close_log SET close_error = $2, last_try_at = $3 WHERE kommo_id = ANY($1::bigint[])`,
        [ids, why, now.toISOString()]);
      rep.failed += ids.length;
      rep.error = why;
      continue;
    }
    await db.query(`UPDATE carrier_close_log SET mode = 'live', closed_at = $2, close_error = NULL, last_try_at = $2 WHERE kommo_id = ANY($1::bigint[])`,
      [ids, now.toISOString()]);
    rep.closed += ids.length;
    // Примітка — пояснення для менеджера. Її збій закриття не скасовує: угода вже закрита, а причина стоїть у полі.
    await kommo.addNotes(batch.map((c) => ({ entity_id: c.kommoId, note_type: "common", params: { text: closeNoteText(c.confidence, c.quote, c.byHuman) } })))
      .catch((e: unknown) => db.query(`UPDATE carrier_close_log SET close_error = $2 WHERE kommo_id = ANY($1::bigint[])`,
        [ids, `закрито, але примітку не додано: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`]));
  }
  return rep;
}

/**
 * ↩️ Повернути угоду на етап — дія людини з вкладки. Знімає «Не цільову» й причину, додає примітку, пише
 * в журнал хто й коли. Повернуту угоду автоматика більше не закриває.
 */
export async function revertCarrierClose(db: Db, kommoId: number, userId: number, userLabel: string, now: Date,
  kommo: KommoCloser): Promise<{ ok: true } | { ok: false; code: 404 | 409 | 502; why: string }> {
  const l = (await db.query<{ closed_at: Date | null; reverted_at: Date | null }>(
    "SELECT closed_at, reverted_at FROM carrier_close_log WHERE kommo_id = $1", [kommoId])).rows[0];
  if (!l) return { ok: false, code: 404, why: "цю угоду дашборд не закривав" };
  if (!l.closed_at) return { ok: false, code: 409, why: "угоду не закрито в CRM — повертати нічого (лише запис у журналі)" };
  if (l.reverted_at) return { ok: false, code: 409, why: "угоду вже повернуто" };
  try {
    await kommo.patchLeads(revertPayload(kommoId));
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db.query("UPDATE carrier_close_log SET revert_error = $2 WHERE kommo_id = $1", [kommoId, why]);
    return { ok: false, code: 502, why: `Kommo не прийняв повернення: ${why}` };
  }
  await db.query("UPDATE carrier_close_log SET reverted_at = $2, reverted_by = $3, revert_error = NULL WHERE kommo_id = $1",
    [kommoId, now.toISOString(), userId]);
  await kommo.addNotes([{ entity_id: kommoId, note_type: "common", params: { text: `Повернуто на етап із дашборда (${userLabel}): вердикт «перевізник» помилковий.` } }])
    .catch(() => {});
  return { ok: true };
}
