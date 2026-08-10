import { pool } from "../db/pool.js";
import {
  forEachLeadNotePage, forEachLeadNotePageByIds,
  forEachContactNotePage, forEachContactNotePageByIds, type KommoLeadNote,
} from "../kommo/client.js";
import { processInChunks } from "./chunkWindow.js";
import { buildDealContactLinks } from "./syncKommo.js";
import { FC_PIPELINES } from "../core/money.js";
import { callTargetConds, callCountsAsActivity, CALL_MIN_SEC } from "../core/stuckRule.js";

/**
 * «АКТИВНА FC-УГОДА» — одна форма на всю джобу ($1 = масив пайплайнів).
 * Копій цього предикату тут було чотири: інкремент `last_call_at` і три
 * самолікувальні/бекфільні вибірки. Три останні писались через `JOIN psm ON …`,
 * що для INNER JOIN тотожно кон'юнкції у `WHERE` — але «тотожно» треба було
 * тримати в голові, а тепер тримає код.
 */
const ACTIVE_FC = callTargetConds({ deal: "d", psm: "psm", pipelines: "$1::bigint[]" }).join(" AND ");

// 🔴 FC_PIPELINES БІЛЬШЕ НЕ КОПІЯ. Тут стояв власний масив `[8921932, 155304]` із
// припискою «тримати синхронно з core». Приписка — не механізм: розійдись вони, і
// джоба тихо перестала б писати `last_call_at` частині угод, а екран лишився б
// зеленим. Тепер константа одна, з `core/money.ts`.

/**
 * Note types that count as real work in the deal. Calls and texts (in/out) and
 * manual notes are a manager engaging the client. We additionally require
 * created_by <> 0 so Salesbot / system-generated notes never count — that's the
 * whole point: "stuck" must not be reset by automation.
 */
const HUMAN_NOTE_TYPES = new Set([
  "call_in",
  "call_out",
  "common",
  "sms_in",
  "sms_out",
  "chat_message",
]);

const CALL_TYPES = new Set(["call_in", "call_out"]);

/**
 * 🔴 ДЗВІНОК КОРОТШИЙ ЗА 10 c — НЕ АКТИВНІСТЬ (рішення власника 10.08.2026).
 *
 * Недодзвон скидав годинник застрягання так само, як справжня розмова, — тобто
 * ХОВАВ угоду зі списку тим, що менеджер набрав номер і поклав слухавку. Заміряно
 * на проді: 10 238 із 31 567 дзвінків активних FC-угод тривали 0 c, і вони ховали
 * 83 угоди; поріг 10 c додає ще 14.
 *
 * Поріг живе в `core/stuckRule.ts` — там само, де правило списку. Тут його НЕ
 * повторюємо числом: розійшлись би мовчки, і саме така розбіжність робить колонку
 * порожньою там, де вона потрібна.
 */
function isHumanActivity(n: KommoLeadNote): boolean {
  if (n.createdBy === 0) return false; // Salesbot / system
  if (!HUMAN_NOTE_TYPES.has(n.noteType)) return false;
  return !CALL_TYPES.has(n.noteType) || callCountsAsActivity(n.durationSec);
}

// РОЗМОВА клієнту = call_in/call_out від людини, що тривала ≥ CALL_MIN_SEC.
// Окремо від last_activity_at, бо той змішує розмови з нотатками/sms/чатом.
function isHumanCall(n: KommoLeadNote): boolean {
  if (n.createdBy === 0) return false;
  return CALL_TYPES.has(n.noteType) && callCountsAsActivity(n.durationSec);
}

// export — щоб гейт міг довести монотонність/ідемпотентність без походу в Kommo.
export async function applyNotes(notes: KommoLeadNote[]): Promise<void> {
  // Collapse to the EARLIEST and LATEST human-activity timestamp per lead in this
  // page. last_activity_at → «застряглі» (остання активність); first_activity_at
  // → «час опрацювання» (перший контакт менеджера з лідом).
  const earliest = new Map<number, number>();
  const latest = new Map<number, number>();
  const latestCall = new Map<number, number>(); // останній ДЗВІНОК (call_in/call_out) per lead
  for (const n of notes) {
    if (isHumanCall(n)) {
      const c = latestCall.get(n.entityId) ?? 0;
      if (n.createdAt > c) latestCall.set(n.entityId, n.createdAt);
    }
    if (!isHumanActivity(n)) continue;
    const lo = earliest.get(n.entityId);
    if (lo == null || n.createdAt < lo) earliest.set(n.entityId, n.createdAt);
    const hi = latest.get(n.entityId) ?? 0;
    if (n.createdAt > hi) latest.set(n.entityId, n.createdAt);
  }
  if (latest.size === 0 && latestCall.size === 0) return;

  // Об'єднуємо ключі: угода може мати дзвінок без іншої активності (і навпаки лишень
  // теоретично — дзвінок сам по собі вже activity). NULL у відсутньому анкері не чіпає
  // колонку (GREATEST з COALESCE-нейтралем).
  const allIds = new Set<number>([...latest.keys(), ...latestCall.keys()]);
  const ids: number[] = [];
  const tsHi: (Date | null)[] = [];
  const tsLo: (Date | null)[] = [];
  const tsCall: (Date | null)[] = [];
  for (const id of allIds) {
    ids.push(id);
    const hi = latest.get(id);
    tsHi.push(hi != null ? new Date(hi * 1000) : null);
    tsLo.push(hi != null ? new Date((earliest.get(id) ?? hi) * 1000) : null);
    const call = latestCall.get(id);
    tsCall.push(call != null ? new Date(call * 1000) : null);
  }
  // Postgres GREATEST/LEAST ІГНОРУЮТЬ NULL (результат NULL лише коли всі NULL): last_activity_at
  // рухається лише вперед, first_activity_at лише назад. NULL у порції лишає збережене недоторканим.
  // 1) АКТИВНІСТЬ — scope НЕ чіпаємо: усі угоди (як було).
  await pool.query(
    `UPDATE deals d
        SET last_activity_at  = GREATEST(d.last_activity_at, v.hi),
            first_activity_at = LEAST(d.first_activity_at, v.lo)
       FROM (SELECT UNNEST($1::bigint[]) AS kommo_id, UNNEST($2::timestamptz[]) AS hi, UNNEST($3::timestamptz[]) AS lo) v
      WHERE d.kommo_id = v.kommo_id`,
    [ids, tsHi, tsLo]
  );
  // 2) ДЗВІНОК (last_call_at) — ЛИШЕ активні FC-угоди. Закриті/won/lost/інші воронки
  //    лишаються NULL — позначка там і не показується. Угода без жодного дзвінка
  //    тримає NULL («дзвінка не було»).
  //
  //    🔴 ПРЕДИКАТ БІЛЬШЕ НЕ ПИШЕТЬСЯ ТУТ. Це була ТРЕТЯ копія правила «застряглої
  //    угоди» — і найнебезпечніша: вона не ламає екран, а тихо не записує дані.
  //    Розійшовшись зі списком, вона лишила б колонку «остання розмова» порожньою
  //    саме там, де вона потрібна, без жодного червоного тесту. Тепер форму дає
  //    `core/stuckRule.callTargetConds`, і гейт стереже її збіг зі списком.
  await pool.query(
    `UPDATE deals d
        SET last_call_at = GREATEST(d.last_call_at, v.call)
       FROM (SELECT UNNEST($1::bigint[]) AS kommo_id, UNNEST($2::timestamptz[]) AS call) v,
            pipeline_stage_map psm
      WHERE d.kommo_id = v.kommo_id
        AND v.call IS NOT NULL
        AND ${callTargetConds({ deal: "d", psm: "psm", pipelines: "$3::bigint[]" }).join("\n        AND ")}`,
    [ids, tsCall, FC_PIPELINES]
  );
}

/**
 * ФАЗА 2 — нотатки КОНТАКТІВ. Kommo вішає телефонію (Ringostat) на контакт, тому
 * `/leads/notes` дзвінків не містить узагалі (доведено на 61986895: 0 у ліда, 5 call_out
 * на контакті). Тут `entityId` — це contact_id, тож перед застосуванням РОЗКИДАЄМО
 * нотатку на всі угоди цього контакта (`deal_contacts`) і далі жену через ТОЙ САМИЙ
 * `applyNotes` — правила (людські типи, created_by≠0, лише call_in/call_out рухають
 * last_call_at, FC + не-paid) лишаються в одному місці, без другої копії логіки.
 */
async function applyContactNotes(notes: KommoLeadNote[]): Promise<void> {
  const contactIds = [...new Set(notes.map((n) => n.entityId))];
  if (!contactIds.length) return;
  const link = await pool.query<{ contact_id: string; deal_kommo_id: string }>(
    `SELECT contact_id, deal_kommo_id FROM deal_contacts WHERE contact_id = ANY($1::bigint[])`,
    [contactIds]
  );
  if (!link.rows.length) return;
  const dealsByContact = new Map<number, number[]>();
  for (const r of link.rows) {
    const c = Number(r.contact_id);
    if (!dealsByContact.has(c)) dealsByContact.set(c, []);
    dealsByContact.get(c)!.push(Number(r.deal_kommo_id));
  }
  const projected: KommoLeadNote[] = [];
  for (const n of notes) {
    for (const dealId of dealsByContact.get(n.entityId) ?? []) projected.push({ ...n, entityId: dealId });
  }
  if (projected.length) await applyNotes(projected);
}

/**
 * Інкрементальний прохід нотаток КОНТАКТІВ. Власний вотермарк (`last_contact_note_at`),
 * щоб збій одного проходу не зсував інший. Порціями ≤24 год, як лідовий.
 * 🔴 РОЗНЕСЕНО В ЧАСІ з лідовим (index.ts: контактний :10, лідовий :40) — навмисно НЕ в
 * один тік: після IP-бану 08.07.2026 головна умова — не давати сплесків паралельних
 * пагінацій. Заміряно 30.07.2026: вікно 3 год = 355 контактних нотаток = 2 запити
 * (лідових за той самий час — 1956 / 8), тобто прохід удвічі-вп'ятеро легший за наявний.
 */
export async function syncContactActivity(opts: { sinceUnix?: number; untilUnix?: number } = {}): Promise<void> {
  if (runningContacts) {
    console.warn("syncContactActivity: previous run still in progress — skipping this tick.");
    return;
  }
  runningContacts = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const isBackfill = opts.sinceUnix != null;
    let sinceUnix = opts.sinceUnix;
    if (sinceUnix == null) {
      const r = await pool.query<{ last_contact_note_at: Date | null }>(
        `SELECT last_contact_note_at FROM sync_state WHERE id = 1`
      );
      const last = r.rows[0]?.last_contact_note_at;
      sinceUnix = last ? Math.floor(last.getTime() / 1000) - 300 : now - 1800;
    }
    const untilUnix = opts.untilUnix ?? now;
    const total = await processInChunks(
      sinceUnix,
      untilUnix,
      (from, to) => forEachContactNotePage(from, to, applyContactNotes),
      isBackfill
        ? null
        : (chunkUntil) =>
            pool.query(`UPDATE sync_state SET last_contact_note_at = $1 WHERE id = 1`, [new Date(chunkUntil * 1000)]).then(() => {})
    );
    console.log(`Contact activity synced: ${total} notes scanned (${sinceUnix}..${untilUnix}).`);
  } finally {
    runningContacts = false;
  }
}

/**
 * 🩺 ПЕРЕРАХУНОК АКТИВНОСТІ ПО СУТНОСТЯХ — ОДИН ЗВІРЯЛЬНИК ЗАМІСТЬ ДВОХ.
 *
 * Було два монотонні проходи: `healDealActivity` (нотатки угод) і
 * `healContactActivity` (нотатки контактів, куди Kommo вішає телефонію). Обидва
 * лише ПІДТЯГУВАЛИ анкер уперед — і поки правило звучало «будь-яка людська нотатка
 * = активність», цього вистачало.
 *
 * 🔴 З ПОРОГОМ 10 c ЦЬОГО СТАЛО МАЛО. Уже записані анкери походять із дзвінків на
 * 0 c, а `GREATEST` їх не знижує НІКОЛИ — тобто зміна правила застосувалась би лише
 * до майбутніх нотаток, а 83 угоди й далі ховались би за недодзвонами. Виправляє це
 * тільки перерахунок, що вміє рухати анкер НАЗАД.
 *
 * 🔒 ЧОМУ ЦЕ БЕЗПЕЧНО САМЕ ТУТ, і чому інкремент лишається монотонним: цей прохід
 * бере нотатки ПО id сутностей — тобто бачить УСЮ історію угоди, а не вікно. Знизити
 * анкер за повною історією коректно; зробити те саме в інкременті означало б скидати
 * анкер щоразу, коли в порцію не потрапила остання нотатка.
 *
 * 🔴 ОБИДВА ДЖЕРЕЛА В ОДНОМУ ПРОХОДІ — НЕ ОПТИМІЗАЦІЯ, А УМОВА КОРЕКТНОСТІ. Точний
 * перерахунок лише за нотатками угоди стер би активність, що прийшла з КОНТАКТА
 * (там живуть дзвінки Ringostat). Тому розділити ці два проходи, як було, більше не
 * можна: кожен окремо «знає» неповну правду.
 *
 * Вартість та сама, що в двох старих: ~47 запитів на добу (24 лідові + 23 контактні).
 * CLI: `node dist/jobs/syncDealActivity.js --recompute-activity`.
 */
export async function recomputeActivity(): Promise<{ deals: number; notes: number; changed: number }> {
  const idsRes = await pool.query<{ kommo_id: string }>(
    `SELECT d.kommo_id FROM deals d, pipeline_stage_map psm
      WHERE ${ACTIVE_FC} ORDER BY d.kommo_id`,
    [FC_PIPELINES]
  );
  const dealIds = idsRes.rows.map((r) => Number(r.kommo_id));
  if (!dealIds.length) throw new Error("recomputeActivity: активних FC-угод НУЛЬ — це провал, не порожня база");

  const link = await pool.query<{ contact_id: string; deal_kommo_id: string }>(
    `SELECT contact_id, deal_kommo_id FROM deal_contacts WHERE deal_kommo_id = ANY($1::bigint[])`,
    [dealIds]
  );
  const dealsByContact = new Map<number, number[]>();
  for (const r of link.rows) {
    const c = Number(r.contact_id);
    if (!dealsByContact.has(c)) dealsByContact.set(c, []);
    dealsByContact.get(c)!.push(Number(r.deal_kommo_id));
  }

  const known = new Set(dealIds);
  const hi = new Map<number, number>(), lo = new Map<number, number>(), call = new Map<number, number>();
  const take = (dealId: number, n: KommoLeadNote): void => {
    if (!known.has(dealId)) return;
    if (isHumanCall(n)) { if (n.createdAt > (call.get(dealId) ?? 0)) call.set(dealId, n.createdAt); }
    if (!isHumanActivity(n)) return;
    if (n.createdAt > (hi.get(dealId) ?? 0)) hi.set(dealId, n.createdAt);
    const l = lo.get(dealId);
    if (l == null || n.createdAt < l) lo.set(dealId, n.createdAt);
  };

  const BATCH = 100; // Kommo обмежує довжину URL (filter[entity_id][] по id)
  let notes = 0;
  for (let i = 0; i < dealIds.length; i += BATCH)
    notes += await forEachLeadNotePageByIds(dealIds.slice(i, i + BATCH), async (ns) => {
      for (const n of ns) take(n.entityId, n);
    });
  const contactIds = [...dealsByContact.keys()];
  for (let i = 0; i < contactIds.length; i += BATCH)
    notes += await forEachContactNotePageByIds(contactIds.slice(i, i + BATCH), async (ns) => {
      for (const n of ns) for (const d of dealsByContact.get(n.entityId) ?? []) take(d, n);
    });

  // ⚠️ ПРИСВОЄННЯ, а не GREATEST — у цьому весь сенс проходу. Угода без ЖОДНОЇ
  // кваліфікованої нотатки отримує NULL: «її не вели» — і це правда, а не втрата даних.
  const at = (m: Map<number, number>, id: number) => { const v = m.get(id); return v == null ? null : new Date(v * 1000); };
  const upd = await pool.query(
    `UPDATE deals d
        SET last_activity_at = v.hi, first_activity_at = v.lo, last_call_at = v.call
       FROM (SELECT UNNEST($1::bigint[]) AS kommo_id, UNNEST($2::timestamptz[]) AS hi,
                    UNNEST($3::timestamptz[]) AS lo, UNNEST($4::timestamptz[]) AS call) v
      WHERE d.kommo_id = v.kommo_id
        AND (d.last_activity_at IS DISTINCT FROM v.hi
          OR d.first_activity_at IS DISTINCT FROM v.lo
          OR d.last_call_at      IS DISTINCT FROM v.call)`,
    [dealIds, dealIds.map((i) => at(hi, i)), dealIds.map((i) => at(lo, i)), dealIds.map((i) => at(call, i))]
  );
  console.log(`recomputeActivity: ${dealIds.length} активних FC-угод, ${contactIds.length} контактів, `
    + `${notes} нотаток, змінено ${upd.rowCount} угод.`);
  return { deals: dealIds.length, notes, changed: upd.rowCount ?? 0 };
}

/**
 * Одноразовий цільовий бекфіл last_call_at для АКТИВНИХ FC-угод (~2.3к). Замість
 * сканувати рік усіх нотаток компанії — тягнемо нотатки лише відкритих FC-угод по їхніх
 * id батчами і беремо останній call_in/call_out. Легкий (нотатки лише цих угод), НЕ рухає
 * вотермарк, ідемпотентний (GREATEST). CLI: `node dist/jobs/syncDealActivity.js --backfill-calls`.
 */
export async function backfillLastCall(): Promise<void> {
  const idsRes = await pool.query<{ kommo_id: string }>(
    `SELECT d.kommo_id FROM deals d, pipeline_stage_map psm
      WHERE ${ACTIVE_FC}`,
    [FC_PIPELINES]
  );
  const allIds = idsRes.rows.map((r) => Number(r.kommo_id));
  const BATCH = 100;
  const batches = Math.ceil(allIds.length / BATCH);
  console.log(`backfillLastCall: ${allIds.length} активних FC-угод, ${batches} батчів по ${BATCH}`);
  let scanned = 0, updatedDeals = 0;
  for (let i = 0; i < allIds.length; i += BATCH) {
    const batch = allIds.slice(i, i + BATCH);
    const latestCall = new Map<number, number>();
    scanned += await forEachLeadNotePageByIds(batch, async (notes) => {
      for (const n of notes) {
        if (!isHumanCall(n)) continue;
        const c = latestCall.get(n.entityId) ?? 0;
        if (n.createdAt > c) latestCall.set(n.entityId, n.createdAt);
      }
    });
    if (latestCall.size) {
      const ids: number[] = [], ts: Date[] = [];
      for (const [id, c] of latestCall) { ids.push(id); ts.push(new Date(c * 1000)); }
      const u = await pool.query(
        `UPDATE deals d SET last_call_at = GREATEST(d.last_call_at, v.call)
           FROM (SELECT UNNEST($1::bigint[]) AS kommo_id, UNNEST($2::timestamptz[]) AS call) v
          WHERE d.kommo_id = v.kommo_id`,
        [ids, ts]
      );
      updatedDeals += u.rowCount ?? 0;
    }
    if ((i / BATCH + 1) % 5 === 0 || i + BATCH >= allIds.length)
      console.log(`  батч ${i / BATCH + 1}/${batches}: усього оновлено ${updatedDeals} угод, проскановано ${scanned} нотаток`);
  }
  console.log(`backfillLastCall done: ${updatedDeals} угод з last_call_at, ${scanned} нотаток проскановано.`);
}

let running = false;
let runningContacts = false; // окремий guard: контактний і лідовий проходи незалежні

/**
 * Pulls Kommo lead notes and records the latest human-made activity per deal in
 * deals.last_activity_at. Incremental from a watermark (with overlap); a
 * historical backfill is done with an explicit sinceUnix and does NOT advance
 * the watermark.
 */
export async function syncDealActivity(opts: { sinceUnix?: number; untilUnix?: number } = {}): Promise<void> {
  if (running) {
    console.warn("syncDealActivity: previous run still in progress — skipping this tick.");
    return;
  }
  running = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const isBackfill = opts.sinceUnix != null;
    let sinceUnix = opts.sinceUnix;
    if (sinceUnix == null) {
      const r = await pool.query<{ last_activity_note_at: Date | null }>(
        `SELECT last_activity_note_at FROM sync_state WHERE id = 1`
      );
      const last = r.rows[0]?.last_activity_note_at;
      sinceUnix = last ? Math.floor(last.getTime() / 1000) - 300 : now - 1800;
    }
    const untilUnix = opts.untilUnix ?? now;

    // Порції ≤24 год + інкрементальний вотермарк (той самий фікс, що syncStageEvents):
    // раніше «все або нічого» → last_activity_note_at застряг з IP-бану 08.07.
    const total = await processInChunks(
      sinceUnix,
      untilUnix,
      (from, to) => forEachLeadNotePage(from, to, applyNotes),
      isBackfill
        ? null
        : (chunkUntil) =>
            pool.query(`UPDATE sync_state SET last_activity_note_at = $1 WHERE id = 1`, [new Date(chunkUntil * 1000)]).then(() => {})
    );
    console.log(`Deal activity synced: ${total} notes scanned (${sinceUnix}..${untilUnix}).`);
  } finally {
    running = false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI:
  //   `node dist/jobs/syncDealActivity.js --months=6`      → backfill активності за N міс (як було)
  //   `node dist/jobs/syncDealActivity.js --backfill-calls` → цільовий бекфіл last_call_at (активні FC)
  //   `node dist/jobs/syncDealActivity.js --recompute-activity` → ТОЧНИЙ перерахунок анкерів
  //      (єдиний прохід, що вміє знизити анкер — саме він застосовує поріг 10 c до історії)
  if (process.argv.includes("--build-links")) {
    buildDealContactLinks()
      .then(() => pool.end())
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else if (process.argv.includes("--recompute-activity")) {
    recomputeActivity()
      .then(() => pool.end())
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else if (process.argv.includes("--backfill-calls")) {
    backfillLastCall()
      .then(() => pool.end())
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else {
    const monthsArg = process.argv.find((a) => a.startsWith("--months="));
    const months = monthsArg ? Number(monthsArg.split("=")[1]) : null;
    const opts = months
      ? { sinceUnix: Math.floor(Date.now() / 1000) - months * 30 * 24 * 60 * 60 }
      : {};
    syncDealActivity(opts)
      .then(() => pool.end())
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  }
}
