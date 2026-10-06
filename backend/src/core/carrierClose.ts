import type { Db } from "./adCallFacts.js";
import { CARRIER_STAGE, OTHER_TYPE_UA, type OtherType } from "./carrierCallRules.js";
import { carrierDealRows } from "./carrierDeals.js";
import { AUTO_CARRIER_TAG, carrierHistorySql, historyCloseNote, HISTORY_GUARD, readHistoryGate } from "./carrierHistory.js";

/**
 * 🧹 ЗАКРИТТЯ В KOMMO (29.09.2026 — перевізники; ТЗ Романа 30.09.2026 — ще й «Інше»).
 *
 * Kommo угоди не видаляє — угода закривається «Не цільовою» (статус 143) з причиною, як це робить фільтр CRM:
 *   · перевізник (впевнений AI ≥ 0,85 з цитатою співрозмовника АБО рішення людини) → «Перевізник»;
 *   · «Інше» (рішення людини — завжди; впевнений AI — лише коли ввімкнено окремо) → «Нецільове звернення»,
 *     підтип — у примітці угоди й у дашборді (окремого значення в полі немає; Роман 30.09.2026: «взяти наявні»);
 *   · «Клієнт» — не закриваємо ніколи.
 * Категорію дає ОДНЕ правило (`dealCategory` через `carrierDealRows`) — те саме, що рахує вкладки й звіт.
 * Лише угода, що ДОСІ стоїть на етапі за свіжою відповіддю Kommo цього ж проходу.
 *
 * Режими — змінні на сервері: `CARRIER_AUTO_CLOSE` (перевізники й рішення людей) і `CARRIER_AUTO_CLOSE_OTHER`
 * (AI-«Інше»; ТЗ: вмикати лише після тесту точності, показаного Роману). `live` — пишемо в Kommo; `off` — нічого;
 * будь-що інше, включно з відсутністю, — `dry`: лише журнал «кого закрили б». Описка запису в CRM не вмикає.
 * AI-«Інше» закривається, лише коли ввімкнено ОБИДВА: вимкнений основний режим вимикає все.
 *
 * Журнал `carrier_close_log` — рядок на угоду: з чим закрито, коли вирішено, коли закрито, коли й ким повернуто.
 * Повернута людиною угода більше НЕ закривається автоматично: рішення людини сильніше за модель.
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
/** «Нецільове звернення» — для «Інше» (заміряно в Kommo 30.09.2026; Роман: «взяти наявні»). */
export const REJECT_ENUM_NONTARGET = 6340787;
/** «Немає зв'язку» — угода без розмови від 10 с (заміряно в Kommo 30.09.2026; Роман: «Немає зв'язку»). */
export const REJECT_ENUM_NO_TALK = 6343067;
export type CloseReason = "carrier" | "other" | "no_talk";
export const REJECT_ENUM: Readonly<Record<CloseReason, number>> = { carrier: REJECT_ENUM_CARRIER, other: REJECT_ENUM_NONTARGET, no_talk: REJECT_ENUM_NO_TALK };
export const NO_TALK_NOTE = "Закрито дашбордом: розмови від 10 с не було (пропущений або короткий дзвінок), розмову не аналізуємо. "
  + "Помилка — поверніть угоду на етап у вкладці «Перевізники за розмовою».";
export const LOST_STATUS = 143;
export const CLOSE_BATCH = 50;
export const CLOSE_MAX_PER_TICK = 50;
/** Після невдалого запису до Kommo повтор — не частіше ніж раз на годину: не бомбимо CRM помилками щоп'ять хвилин. */
export const RETRY_AFTER_MIN = 60;

/**
 * `tag` — тег, що ДОДАЄТЬСЯ до наявних (`tags_to_add`). 🔴 НЕ `_embedded.tags`: у Kommo це ЗАМІНА всього списку,
 * тобто закриття стерло б теги, які на угоді поставили телефонія чи люди.
 */
export function closePayload(ids: readonly number[], reason: CloseReason = "carrier", tag: string | null = null): unknown[] {
  return ids.map((id) => ({
    id, pipeline_id: CARRIER_STAGE.pipelineId, status_id: LOST_STATUS,
    custom_fields_values: [{ field_id: REJECT_FIELD, values: [{ enum_id: REJECT_ENUM[reason] }] }],
    ...(tag ? { tags_to_add: [{ name: tag }] } : {}),
  }));
}

/** Текст результату задачі Kommo, яку гасимо разом з угодою (Kommo не закриває деякі типи задач без результату). */
export const TASK_RESULT_TEXT = "Автоматично: угоду закрито дашбордом як «не цільову» (перевізник / не клієнт / без розмови).";

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

export function closeNoteTextOther(confidence: number | null, otherType: OtherType | null, byHuman: boolean): string {
  const sub = otherType ? OTHER_TYPE_UA[otherType] : "підтип не вказано";
  const who = byHuman ? "рішення людини" : `AI, впевненість ${(confidence ?? 0).toFixed(2).replace(".", ",")}`;
  return `Закрито дашбордом: не клієнт і не перевізник — ${sub} (${who}). `
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
  /**
   * Відкриті задачі угод — щоб погасити їх ДО закриття угоди (урок Espo-фільтра 03.09: при автоматичному переході
   * Kommo не питає «закрити всі задачі?», і задача «передзвоніть» лишалась висіти на закритій угоді).
   * Не задано — задачі не чіпаємо.
   */
  openTaskIds?: (leadIds: readonly number[]) => Promise<number[]>;
  closeTasks?: (taskIds: readonly number[], resultText: string) => Promise<unknown>;
}

export interface CloseCandidate {
  kommoId: number; uniqueid: string | null; confidence: number | null; quote: string | null; logged: boolean; byHuman: boolean;
  reason: CloseReason; otherType: OtherType | null;
  /** AI-«Інше» без рішення людини — окремий перемикач (`CARRIER_AUTO_CLOSE_OTHER`). */
  aiOther: boolean;
  /** Вердикт з історії CRM (блок 1 ТЗ 4373) — окремий перемикач (`CARRIER_HISTORY_CLOSE`); `historyFrom` — угода-джерело. */
  history: boolean;
  historyFrom: number | null;
}

/**
 * Хто зараз підлягає закриттю. `onStage` — id угод із ВІДПОВІДІ Kommo цього проходу: угоду, яку фільтр чи
 * менеджер уже зрушили, не чіпаємо навіть за впевненого вердикту.
 */
export async function closeCandidates(db: Db, onStage: ReadonlySet<number>, now: Date): Promise<CloseCandidate[]> {
  if (!onStage.size) return [];
  const rows = await carrierDealRows(db, { period: null, scope: {}, ids: [...onStage] });
  const log = new Map((await db.query<{ kommo_id: string; reverted: boolean; recent_fail: boolean }>(`
    SELECT kommo_id::text, reverted_at IS NOT NULL AS reverted,
           (last_try_at IS NOT NULL AND close_error IS NOT NULL AND closed_at IS NULL
            AND last_try_at > $2::timestamptz - make_interval(mins => $3)) AS recent_fail
      FROM carrier_close_log WHERE kommo_id = ANY($1::bigint[])`, [[...onStage], now.toISOString(), RETRY_AFTER_MIN])).rows
    .map((x) => [Number(x.kommo_id), x]));
  const out: CloseCandidate[] = [];
  for (const r of [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.kommoId - b.kommoId)) {
    if (r.category !== "carrier" && r.category !== "other" && r.category !== "no_talk") continue;
    const l = log.get(r.kommoId);
    if (r.close?.state === "closed" || l?.reverted || l?.recent_fail) continue;
    const byHuman = r.source === "human";
    out.push({ kommoId: r.kommoId, uniqueid: r.uniqueid, confidence: r.ai.confidence, quote: r.ai.quote, logged: l != null,
      byHuman, reason: r.category, otherType: r.otherType, aiOther: r.category === "other" && !byHuman,
      history: r.source === "crm", historyFrom: r.historyFrom });
  }
  return out;
}

export interface CloseReport { mode: CloseMode; otherMode: CloseMode; historyMode: CloseMode; candidates: number; logged: number; closed: number;
  failed: number; tasksClosed: number; error: string | null;
  /** Угоди «історії CRM», що чекають: синк угод застарів (`readHistoryGate`) — у Kommo не пишемо. */
  historyPaused: number;
  /** Угоди «історії CRM», у яких повторна перевірка знайшла угоду замовника, — не закрито, повернуто в чергу. */
  historyRevoked: number }

/** Чи пише цей кандидат у CRM у ЦЬОМУ проході: основний режим «live» і його власний перемикач «live». */
export const liveFor = (c: Pick<CloseCandidate, "aiOther" | "history">, mode: CloseMode, otherMode: CloseMode, historyMode: CloseMode): boolean =>
  mode === "live" && (!c.aiOther || otherMode === "live") && (!c.history || historyMode === "live");

export async function runCarrierClose(db: Db, now: Date, mode: CloseMode, onStage: ReadonlySet<number>, kommo: KommoCloser,
  otherMode: CloseMode = "dry", historyMode: CloseMode = "dry", historySyncMaxMin: number = HISTORY_GUARD.defaultMaxAgeMin): Promise<CloseReport> {
  const rep: CloseReport = { mode, otherMode, historyMode, candidates: 0, logged: 0, closed: 0, failed: 0, tasksClosed: 0, error: null,
    historyPaused: 0, historyRevoked: 0 };
  if (mode === "off") return rep;
  let cands = (await closeCandidates(db, onStage, now))
    .filter((c) => !(c.aiOther && otherMode === "off") && !(c.history && historyMode === "off"));
  // 🛡 Історія CRM (`carrierHistory.ts`, рішення 05.10.2026). Вердикт ставився раніше й з тих пір НЕ перевірявся, а між
  // ним і закриттям по номеру могла зʼявитись угода замовника. Тому: синк угод застарів — чекаємо (у CRM не пишемо);
  // свіжий — перевіряємо виняток ЩЕ РАЗ, і угода, що стала клієнтською, повертається в чергу «Відсіву», а не закривається.
  let historyOpen = true;
  const hist = cands.filter((c) => c.history);
  if (hist.length) {
    historyOpen = (await readHistoryGate(db, now, historySyncMaxMin)).open;
    if (!historyOpen) rep.historyPaused = hist.length;
    else {
      const revoked = (await db.query<{ k: string }>(
        `SELECT cd.kommo_id::text AS k FROM carrier_call_deals cd
          WHERE cd.kommo_id = ANY($1::bigint[]) AND ${carrierHistorySql("cd.phone", "cd.kommo_id")} IS NULL`,
        [hist.map((c) => c.kommoId)])).rows.map((r) => Number(r.k));
      if (revoked.length) {
        await db.query(`UPDATE carrier_call_deals SET state = 'waiting', history_from = NULL, updated_at = $2
                         WHERE kommo_id = ANY($1::bigint[]) AND state = 'history'`, [revoked, now.toISOString()]);
        const gone = new Set(revoked);
        cands = cands.filter((c) => !gone.has(c.kommoId));
        rep.historyRevoked = revoked.length;
      }
    }
  }
  /** Пише в CRM у цьому проході: власні перемикачі «live» і, для історії, свіжий синк угод. */
  const writes = (c: CloseCandidate) => liveFor(c, mode, otherMode, historyMode) && (!c.history || historyOpen);
  rep.candidates = cands.length;
  const fresh = cands.filter((c) => !c.logged);
  if (fresh.length) {
    const ins = await db.query(
      `INSERT INTO carrier_close_log (kommo_id, uniqueid, confidence, quote, decided_at, mode, reason, other_type)
       SELECT k, u, c, q, $5::timestamptz, m, r, o
         FROM unnest($1::bigint[], $2::text[], $3::numeric[], $4::text[], $6::text[], $7::text[], $8::text[]) AS x(k, u, c, q, m, r, o)
       ON CONFLICT (kommo_id) DO NOTHING`,
      [fresh.map((c) => c.kommoId), fresh.map((c) => c.uniqueid), fresh.map((c) => c.confidence), fresh.map((c) => c.quote),
        now.toISOString(), fresh.map((c) => (writes(c) ? mode : "dry")),
        fresh.map((c) => c.reason), fresh.map((c) => c.otherType)]);
    rep.logged = ins.rowCount ?? 0;
  }
  // Причину й підтип тримаємо свіжими: людина могла змінити «Інше» на «Перевізник» до закриття.
  if (cands.length) {
    await db.query(`UPDATE carrier_close_log l SET reason = x.r, other_type = x.o
                      FROM unnest($1::bigint[], $2::text[], $3::text[]) AS x(k, r, o)
                     WHERE l.kommo_id = x.k AND l.closed_at IS NULL AND (l.reason <> x.r OR l.other_type IS DISTINCT FROM x.o)`,
    [cands.map((c) => c.kommoId), cands.map((c) => c.reason), cands.map((c) => c.otherType)]);
  }
  if (mode !== "live") return rep;

  const live = cands.filter(writes).slice(0, CLOSE_MAX_PER_TICK);
  const groups: { reason: CloseReason; history: boolean }[] = [
    { reason: "carrier", history: false }, { reason: "carrier", history: true }, { reason: "other", history: false }, { reason: "no_talk", history: false }];
  for (const g of groups) {
    const reason = g.reason;
    for (const batch of chunks(live.filter((c) => c.reason === reason && c.history === g.history), CLOSE_BATCH)) {
      const ids = batch.map((c) => c.kommoId);
      // Задачі угоди — ПЕРШИМИ: якщо закриття угоди впаде, задачі вже погашені, а угода лишиться на етапі й
      // наступний прохід її добере. Зворотний порядок лишив би задачу на угоді, що вже пішла з етапу.
      if (kommo.openTaskIds && kommo.closeTasks) {
        try {
          const tids = await kommo.openTaskIds(ids);
          if (tids.length) { await kommo.closeTasks(tids, TASK_RESULT_TEXT); rep.tasksClosed += tids.length; }
        } catch (e) {
          rep.error = `задачі Kommo не закрито: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
        }
      }
      try {
        await kommo.patchLeads(closePayload(ids, reason, g.history ? AUTO_CARRIER_TAG : null));
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
      const text = (c: CloseCandidate) => c.history ? historyCloseNote(c.historyFrom ?? "?")
        : reason === "carrier" ? closeNoteText(c.confidence ?? 0, c.quote, c.byHuman)
        : reason === "no_talk" ? NO_TALK_NOTE : closeNoteTextOther(c.confidence, c.otherType, c.byHuman);
      await kommo.addNotes(batch.map((c) => ({ entity_id: c.kommoId, note_type: "common", params: { text: text(c) } })))
        .catch((e: unknown) => db.query(`UPDATE carrier_close_log SET close_error = $2 WHERE kommo_id = ANY($1::bigint[])`,
          [ids, `закрито, але примітку не додано: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`]));
    }
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
