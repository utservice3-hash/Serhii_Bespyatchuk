/**
 * 📞 РОЗМОВА БІЛЯ ДАТИ ДОМОВЛЕНОСТІ (задача 4631, Юля 09.10.2026; Роман 09.10.2026 «роби»).
 *
 * Дата оплати в колонці «Домовленість» — це обіцянка клієнта. Без розмови вона нічим не підкріплена: її міг
 * поставити будь-хто й будь-коли. Тому біля дати менеджер кладе посилання на запис Ringostat, а екран показує,
 * чи розмова є, з ким вона була і скільки разів дату переносили. Чисте — без БД; SQL-фрагменти теж тут, щоб
 * правило жило в одному файлі.
 *
 * Рішення Юлі 09.10.2026 (три «так»):
 *  · розмова привʼязується до дати ДОМОВЛЕНОСТІ по клієнту (не до рахунку — по рахунку дату не ставлять: 0 змін
 *    за 30 днів проти 90 по клієнту);
 *  · менеджер ставить дату й посилання по СВОЇХ клієнтах;
 *  · дзвінок з номера, якого немає в контактах клієнта, приймається з позначкою «⚠ інший номер».
 * Роман 09.10.2026: дата лише з CRM — сіра «не підтверджено», а не жовта (менеджер її не ставив); слухати —
 * як у першому дотику.
 */

import { RUBRIC_DEBT_V1, debtLine, type DebtResult } from "./receivableCallAi.js";

/**
 * 📐 ФОРМА ПОСИЛАННЯ — ЗАМІРЯНА, А НЕ ВГАДАНА (прод 09.10.2026): у всіх 283 765 записів `recording` має вигляд
 * `https://app.ringostat.com/recordings/<uniqueid>.wav?token=…`, і `<uniqueid>` збігається з `ringostat_calls.uniqueid`
 * у 283 765 із 283 765. Сам `uniqueid` — `ua18_-1791545397.2215926` (489 708 із 489 710; два старі без префікса).
 * Тому з посилання беремо рівно `uniqueid`, а токен не зберігаємо як ключ: запис віддає сервер за `uniqueid`.
 */
const UNIQUEID = /^[a-z]+\d*_-?\d+\.\d+$/i;
const RECORDING = /^https?:\/\/app\.ringostat\.com\/recordings\/([^/?#]+?)\.(?:wav|mp3|ogg)(?:[?#].*)?$/i;
export const CALL_URL_MAX = 2000;

export type ParsedLink = { ok: true; uniqueid: string } | { ok: false; error: string };

/** Посилання з Ringostat (або голий номер дзвінка) → `uniqueid`. Будь-що інше — відмова з поясненням. */
export function parseRingostatLink(raw: string): ParsedLink {
  const s = raw.trim();
  if (!s) return { ok: false, error: "Посилання порожнє" };
  if (s.length > CALL_URL_MAX) return { ok: false, error: "Посилання задовге" };
  const m = RECORDING.exec(s);
  const id = m ? decodeURIComponent(m[1]) : s;
  if (UNIQUEID.test(id)) return { ok: true, uniqueid: id };
  return {
    ok: false,
    error: m || /ringostat/i.test(s)
      ? "Це посилання Ringostat, але не на запис дзвінка. Потрібне посилання на запис: app.ringostat.com/recordings/…"
      : "Потрібне посилання на запис дзвінка в Ringostat (app.ringostat.com/recordings/…)",
  };
}

/** Перенесення — коли була дата і стала ІНША. Перша дата, зняття дати чи нова угода переносом не є. */
export function isReschedule(oldDate: string | null, newDate: string | null): boolean {
  return oldDate != null && newDate != null && oldDate !== newDate;
}

/** Те саме правило в SQL — для лічильника в рядку списку. `l` — алиас `receivable_date_log`. */
export const reschedulePred = (l = "l"): string =>
  `(${l}.old_date IS NOT NULL AND ${l}.new_date IS NOT NULL AND ${l}.new_date <> ${l}.old_date)`;

/**
 * Скільки разів переносили дату поточної домовленості. Рахуємо по угоді запису: перенесення попередньої угоди
 * (вже оплаченої) — історія іншого боргу. Старий запис без угоди — по клієнту.
 */
export const rescheduleCountSql = (n = "n"): string =>
  `(SELECT count(*)::int FROM receivable_date_log l
     WHERE l.client_key = ${n}.client_key
       AND (${n}.deal_id IS NULL OR l.deal_id = ${n}.deal_id)
       AND ${reschedulePred("l")})`;

/**
 * Факти про прикріплений дзвінок — для `LEFT JOIN LATERAL (…) cf ON true`. `owner` — алиас рядка з колонкою
 * `call_uniqueid`; `canon` — SQL-вираз канонічного ключа клієнта.
 *
 * «Номер клієнта» — дзвінок звʼязаний із цим клієнтом (`ringostat_calls.client_key`), АБО номер є серед телефонів
 * контактів його угод. Друга гілка потрібна, бо `client_key` дзвінка ставиться за найсвіжішою угодою номера: спільний
 * номер двох фірм звʼязується лише з однією, і дзвінок другій читався б як «інший номер» без жодної причини.
 */
export const callFactsLateral = (owner: string, canon: string): string =>
  `SELECT rc.uniqueid AS call_found,
          to_char(rc.calldate AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS call_at,
          rc.billsec AS call_billsec,
          COALESCE(m.name, rc.employee_fio) AS call_manager,
          COALESCE(rc.client_key = ${canon}, false) OR EXISTS (
            SELECT 1 FROM contact_phones cp
              JOIN deal_contacts dc ON dc.contact_id = cp.contact_id
              JOIN deals d ON d.kommo_id = dc.deal_kommo_id
             WHERE cp.phone = rc.client_phone AND d.client_key = ${canon}) AS call_same_client,
          -- 💬 прохід 2: розбір розмови рубрикою боргу і стан розпізнавання
          (SELECT a.result FROM call_transcripts t
             JOIN call_analyses a ON a.transcript_id = t.id AND a.rubric_version = '${RUBRIC_DEBT_V1}' AND a.status = 'done'
            WHERE t.uniqueid = rc.uniqueid ORDER BY a.id DESC LIMIT 1) AS call_ai,
          (SELECT t.status FROM call_transcripts t WHERE t.uniqueid = rc.uniqueid ORDER BY t.id DESC LIMIT 1) AS call_stt
     FROM ringostat_calls rc
     LEFT JOIN managers m ON m.id = rc.manager_id
    WHERE rc.uniqueid = ${owner}.call_uniqueid`;

export interface CallFacts {
  calledAt: string;
  billsec: number;
  managerName: string | null;
  sameClient: boolean;
  /** 💬 Розбір розмови: короткий рядок для списку й підсумок. `null` — розбору ще немає. */
  ai: { line: string; summary: string } | null;
  /** Розмову розбирають: розпізнавання або розбір ще в черзі. Коротка розмова (<15 с) не розбирається — `false`. */
  aiPending: boolean;
}

/** Рядок `callFactsLateral` → факти; дзвінка в базі немає — `null`. */
export function toCallFacts(r: {
  call_found: string | null; call_at: string | null; call_billsec: number | string | null;
  call_manager: string | null; call_same_client: boolean | null;
  call_ai?: DebtResult | null; call_stt?: string | null;
}): CallFacts | null {
  if (!r.call_found || !r.call_at) return null;
  const ai = r.call_ai ? { line: debtLine(r.call_ai), summary: r.call_ai.summary } : null;
  const pending = !ai && (r.call_stt === "queued" || r.call_stt === "working" || r.call_stt === "done");
  return { calledAt: r.call_at, billsec: Number(r.call_billsec ?? 0), managerName: r.call_manager, sameClient: r.call_same_client === true,
    ai, aiPending: pending };
}

/**
 * Стан колонки «Домовленість» щодо розмови. Одне правило для рядка, фільтра й лічильника на чипі.
 *  · `none`         — дати немає ніде;
 *  · `crm`          — дата лише з CRM (запису в дашборді немає або він з попередньої угоди) — сірий «не підтверджено»;
 *  · `no_call`      — дату поставили в дашборді, розмови немає — жовтий рядок;
 *  · `pending`      — посилання є, а дзвінка в нашій базі ще немає (синк дзвінків іде із запізненням);
 *  · `no_talk`      — прикріплений дзвінок без розмови (0 с);
 *  · `other_number` — розмова з номером, якого немає в контактах клієнта;
 *  · `ok`           — розмова з номером клієнта.
 * ⚠️ «Звідки дата» — те саме правило, що `agreementView` на фронті (`source`): запис актуальний і має дату → дашборд;
 * інакше дата з CRM. Збіг стереже `#1530e`.
 */
export type CallLinkState = "none" | "crm" | "no_call" | "pending" | "no_talk" | "other_number" | "ok";

export function callLinkState(p: {
  noteActual: boolean;
  noteDue: string | null;
  crmDue: string | null;
  callUniqueid: string | null;
  call: CallFacts | null;
}): CallLinkState {
  const own = p.noteActual && !!p.noteDue;
  if (!own) return p.crmDue ? "crm" : "none";
  if (!p.callUniqueid) return "no_call";
  if (!p.call) return "pending";
  if (p.call.billsec <= 0) return "no_talk";
  return p.call.sameClient ? "ok" : "other_number";
}

export interface CallRef { uniqueid: string; url: string | null }

/**
 * Що зберегти і що дописати в журнал при записі домовленості.
 *
 * `call`: `undefined` — поле не прислали; `null` — прибрати; обʼєкт — нове посилання.
 * 🔴 НОВА ДАТА — НОВА РОЗМОВА. Не прислали посилання, а дата змінилась (або запис переїхав на іншу угоду) —
 * старе посилання знімається: розмова, що підкріплювала 07.10, не підкріплює 14.10. Дата та сама — лишається.
 * Журнал дописується, коли змінилась дата або розмова; запис без дати й без розмови до і після — ні.
 */
export function planAgreementChange(prev: {
  exists: boolean; dealId: number | null; dueDate: string | null; call: CallRef | null;
}, next: {
  dealId: number | null; dueDate: string | null; call: CallRef | null | undefined;
}): { call: CallRef | null; log: { oldDate: string | null; newDate: string | null; callUniqueid: string | null } | null } {
  const sameDeal = prev.exists && prev.dealId === next.dealId;
  const oldDate = sameDeal ? prev.dueDate : null;
  const oldCall = sameDeal ? prev.call : null;
  const dateChanged = oldDate !== next.dueDate;
  const call = next.call !== undefined ? next.call : (dateChanged ? null : oldCall);
  const callChanged = (call?.uniqueid ?? null) !== (oldCall?.uniqueid ?? null);
  const touched = dateChanged || callChanged;
  const meaningful = oldDate != null || next.dueDate != null || call != null;
  return { call, log: touched && meaningful ? { oldDate, newDate: next.dueDate, callUniqueid: call?.uniqueid ?? null } : null };
}
