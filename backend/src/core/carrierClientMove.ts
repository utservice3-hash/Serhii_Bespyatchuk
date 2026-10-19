import type { Db } from "./adCallFacts.js";
import type { CloseMode } from "./carrierClose.js";
import { carrierDealRows } from "./carrierDeals.js";
import { CARRIER_STAGE } from "./carrierCallRules.js";
import { SERVICE_KOMMO_USER_IDS } from "./orphanClients.js";

/**
 * 🚚 КЛІЄНТ → «ЛІД ВЗЯТИЙ У РОБОТУ» + ЗАДАЧА МЕНЕДЖЕРУ (задача 5970; Юля 16.10.2026, п.2 розбору етапу).
 *
 * Угода етапу «Дзвінки на мобільні» з категорією «клієнт» (упевнений вердикт AI — ≥ 85% і фраза-доказ співрозмовника —
 * або рішення людини у «Відсіві») сама переходить на сусідній етап тієї самої воронки «Кваліфікація» — «Лід взятий у
 * роботу», — а відповідальний отримує в Kommo задачу «Взяти в роботу» зі строком сьогодні. Інакше клієнт губиться серед
 * перевізників (16.10: 19 клієнтів висіли на етапі, найстаріший з 30.09).
 *
 * Не чіпаємо: угоди службового акаунта «Операційний директор» (їх спершу віддає черговому 5972 — задачу нема кому
 * ставити); угоди, повернуті людиною («Повернути»), — повторно не переносимо; угоди, що вже пішли з етапу.
 * Режими — як в автозакриття: `dry` — лише журнал, `live` — пише в Kommo.
 */

export const LEAD_TAKEN_STATUS = 69693652;   // «Лід взятий у роботу», воронка «Кваліфікація» (8921928) — та сама, що етап
export const MOVE_RETRY_AFTER_MIN = 60;
export const MOVE_MAX_PER_TICK = 30;
/** Тип задачі Kommo «Зв'язатися» — системний, id 1. */
export const KOMMO_TASK_CALL = 1;

export interface MoveKommo {
  patchLeads: (body: unknown[]) => Promise<unknown>;
  addNotes: (body: unknown[]) => Promise<unknown>;
  /** POST /api/v4/tasks — повертає id створених задач у тому ж порядку. */
  createTasks: (body: unknown[]) => Promise<number[]>;
  closeTasks?: (taskIds: readonly number[], resultText: string) => Promise<unknown>;
}
export interface MoveReport { mode: CloseMode; candidates: number; logged: number; moved: number; failed: number; skippedService: number; error: string | null }

/**
 * Строк задачі «Взяти в роботу»: сьогодні до 18:00 за Києвом; якщо вже після 17:00 — до кінця дня (23:59),
 * щоб строк не минав одразу після постановки. Unix-секунди (формат Kommo).
 */
export function completeTill(now: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  const secOfDay = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  const targetSec = secOfDay < 17 * 3600 ? 18 * 3600 : 23 * 3600 + 59 * 60;
  return Math.floor(now.getTime() / 1000) + (targetSec - secOfDay);
}

export function moveTaskText(summary: string | null, confidence: number | null, byHuman: boolean): string {
  const who = byHuman ? "людина у «Відсіві» визначила клієнта" : `AI визначив клієнта${confidence != null ? ` (упевненість ${String(Math.round(confidence * 100))}%)` : ""}`;
  return `Взяти в роботу: дзвінок на мобільний — ${who}.${summary ? ` Про що розмова: ${summary}` : ""}`.slice(0, 1000);
}
export const MOVE_NOTE = "Перенесено автоматично з «Дзвінки на мобільні» в «Лід взятий у роботу»: розмова — клієнт. Помилка — «Повернути» у «Відсіві» дашборда.";

export async function runClientMove(db: Db, now: Date, mode: CloseMode, onStage: ReadonlySet<number>, kommo: MoveKommo | null): Promise<MoveReport> {
  const rep: MoveReport = { mode, candidates: 0, logged: 0, moved: 0, failed: 0, skippedService: 0, error: null };
  if (mode === "off" || !onStage.size) return rep;
  const rows = (await carrierDealRows(db, { period: null, scope: {}, ids: [...onStage], now })).filter((r) => r.category === "client");
  if (!rows.length) return rep;
  const resp = new Map((await db.query<{ kommo_id: string; u: string | null }>(
    "SELECT kommo_id::text, responsible_user_id::text AS u FROM carrier_call_deals WHERE kommo_id = ANY($1::bigint[])", [rows.map((r) => r.kommoId)])).rows
    .map((x) => [Number(x.kommo_id), x.u]));
  const log = new Map((await db.query<{ kommo_id: string; moved: boolean; reverted: boolean; recent_fail: boolean }>(`
    SELECT kommo_id::text, moved_at IS NOT NULL AS moved, reverted_at IS NOT NULL AS reverted,
           (move_error IS NOT NULL AND moved_at IS NULL AND last_try_at > $2::timestamptz - make_interval(mins => $3)) AS recent_fail
      FROM carrier_client_moves WHERE kommo_id = ANY($1::bigint[])`, [rows.map((r) => r.kommoId), now.toISOString(), MOVE_RETRY_AFTER_MIN])).rows
    .map((x) => [Number(x.kommo_id), x]));
  const at = now.toISOString();
  const cands = [];
  for (const r of rows) {
    const u = resp.get(r.kommoId) ?? null;
    if (u == null || SERVICE_KOMMO_USER_IDS.includes(u)) { rep.skippedService++; continue; }
    const l = log.get(r.kommoId);
    if (l && (l.moved || l.reverted || l.recent_fail)) continue;
    cands.push({ r, u: Number(u), logged: !!l });
  }
  rep.candidates = cands.length;
  for (const c of cands) {
    await db.query(`INSERT INTO carrier_client_moves (kommo_id, kommo_user_id, decided_at, mode) VALUES ($1, $2, $3, $4)
                    ON CONFLICT (kommo_id) DO UPDATE SET kommo_user_id = EXCLUDED.kommo_user_id, mode = EXCLUDED.mode
                    WHERE carrier_client_moves.moved_at IS NULL`, [c.r.kommoId, c.u, at, mode === "live" ? "live" : "dry"]);
    if (!c.logged) rep.logged++;
  }
  if (mode !== "live" || !kommo) return rep;
  for (const c of cands.slice(0, MOVE_MAX_PER_TICK)) {
    const id = c.r.kommoId;
    try {
      await kommo.patchLeads([{ id, pipeline_id: CARRIER_STAGE.pipelineId, status_id: LEAD_TAKEN_STATUS }]);
    } catch (e) {
      rep.failed++; rep.error = e instanceof Error ? e.message : String(e);
      await db.query("UPDATE carrier_client_moves SET move_error = $2, last_try_at = $3 WHERE kommo_id = $1", [id, rep.error, at]);
      continue;
    }
    // Етап уже змінено — фіксуємо ЦЕ одразу: збій задачі не має повторно переносити угоду.
    await db.query("UPDATE carrier_client_moves SET moved_at = $2, move_error = NULL, last_try_at = $2 WHERE kommo_id = $1", [id, at]);
    rep.moved++;
    try {
      const [taskId] = await kommo.createTasks([{ entity_id: id, entity_type: "leads", responsible_user_id: c.u, task_type_id: KOMMO_TASK_CALL,
        text: moveTaskText(c.r.ai.summary, c.r.ai.confidence, c.r.source === "human"), complete_till: completeTill(now) }]);
      if (taskId) await db.query("UPDATE carrier_client_moves SET kommo_task_id = $2 WHERE kommo_id = $1", [id, taskId]);
    } catch (e) {
      rep.error = `перенесено, але задачу не поставлено: ${e instanceof Error ? e.message : String(e)}`;
      await db.query("UPDATE carrier_client_moves SET move_error = $2 WHERE kommo_id = $1", [id, rep.error]);
    }
    await kommo.addNotes([{ entity_id: id, note_type: "common", params: { text: MOVE_NOTE } }]).catch(() => { /* примітка — не головне */ });
  }
  return rep;
}

/** «Повернути»: угода — назад на «Дзвінки на мобільні», задача «Взяти в роботу» закривається; повторно не переноситься. */
export async function revertClientMove(db: Db, kommoId: number, userId: number | null, userLabel: string, now: Date, kommo: MoveKommo):
  Promise<{ ok: true } | { ok: false; code: 404 | 409 | 502; why: string }> {
  const l = (await db.query<{ moved_at: Date | null; reverted_at: Date | null; kommo_task_id: string | null }>(
    "SELECT moved_at, reverted_at, kommo_task_id::text FROM carrier_client_moves WHERE kommo_id = $1", [kommoId])).rows[0];
  if (!l) return { ok: false, code: 404, why: "Цю угоду автоматика не переносила" };
  if (!l.moved_at) return { ok: false, code: 409, why: "Угоду ще не перенесено в Kommo" };
  if (l.reverted_at) return { ok: false, code: 409, why: "Угоду вже повернуто" };
  try {
    await kommo.patchLeads([{ id: kommoId, pipeline_id: CARRIER_STAGE.pipelineId, status_id: CARRIER_STAGE.statusId }]);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await db.query("UPDATE carrier_client_moves SET revert_error = $2 WHERE kommo_id = $1", [kommoId, why]);
    return { ok: false, code: 502, why: `Kommo не прийняв повернення: ${why}` };
  }
  await db.query("UPDATE carrier_client_moves SET reverted_at = $2, reverted_by = $3, revert_error = NULL WHERE kommo_id = $1", [kommoId, now.toISOString(), userId]);
  if (l.kommo_task_id && kommo.closeTasks) await kommo.closeTasks([Number(l.kommo_task_id)], "Скасовано: угоду повернуто на «Дзвінки на мобільні» — AI помилився.").catch(() => { /* задача — не головне */ });
  await kommo.addNotes([{ entity_id: kommoId, note_type: "common", params: { text: `Повернуто на «Дзвінки на мобільні» з дашборда (${userLabel}): «клієнт» помилковий.` } }]).catch(() => { /* примітка */ });
  return { ok: true };
}

