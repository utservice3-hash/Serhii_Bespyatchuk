import { pool } from "../db/pool.js";
import {
  forEachLeadNotePage, forEachLeadNotePageByIds,
  forEachContactNotePage, forEachContactNotePageByIds, type KommoLeadNote,
} from "../kommo/client.js";
import { processInChunks } from "./chunkWindow.js";
import { buildDealContactLinks } from "./syncKommo.js";

// FC-пайплайни «повний цикл» — тримати синхронно з core/metrics.FC_PIPELINES.
// last_call_at рахуємо ЛИШЕ для активних (відкритих) угод цих воронок.
const FC_PIPELINES = [8921932, 155304];

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

function isHumanActivity(n: KommoLeadNote): boolean {
  if (n.createdBy === 0) return false; // Salesbot / system
  return HUMAN_NOTE_TYPES.has(n.noteType);
}

// Дзвінок клієнту = лише call_in/call_out (людські). Окремо від last_activity_at,
// бо той змішує дзвінки з нотатками/sms/чатом — а нам треба саме РОЗМОВУ.
function isHumanCall(n: KommoLeadNote): boolean {
  if (n.createdBy === 0) return false;
  return n.noteType === "call_in" || n.noteType === "call_out";
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
  // 2) ДЗВІНОК (last_call_at) — ЛИШЕ активні FC-угоди (той самий предикат, що WHERE у
  //    stuckDealsGrouped: FC-пайплайни + mapped status + funnel_stage<>'paid'). Закриті/
  //    won/lost/інші воронки лишаються NULL — позначка там і не показується. Угода без
  //    жодного дзвінка тримає NULL («дзвінка не було»).
  await pool.query(
    `UPDATE deals d
        SET last_call_at = GREATEST(d.last_call_at, v.call)
       FROM (SELECT UNNEST($1::bigint[]) AS kommo_id, UNNEST($2::timestamptz[]) AS call) v,
            pipeline_stage_map psm
      WHERE d.kommo_id = v.kommo_id
        AND v.call IS NOT NULL
        AND psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        AND d.pipeline_id = ANY($3::bigint[])
        AND psm.funnel_stage <> 'paid'`,
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
 * 🩺 САМОЛІКУВАННЯ КОНТАКТНОЇ АКТИВНОСТІ — той самий принцип, що у ФАЗІ 1: інкремент іде
 * лише вперед, тож пропущене вікно не повернеться саме. Звіряємо ПО СУТНОСТЯХ: беремо
 * контакти, привʼязані до АКТИВНИХ FC-угод, і переганяємо їхні нотатки через
 * `applyContactNotes` (монотонний). Вотермарк НЕ рухаємо.
 * Це ж — разовий бекфіл: `--backfill-contacts`.
 */
export async function healContactActivity(): Promise<{ contacts: number; notes: number; batches: number }> {
  const r = await pool.query<{ contact_id: string }>(
    `SELECT DISTINCT dc.contact_id
       FROM deal_contacts dc
       JOIN deals d ON d.kommo_id = dc.deal_kommo_id
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE d.pipeline_id = ANY($1::bigint[]) AND psm.funnel_stage <> 'paid'
      ORDER BY dc.contact_id`,
    [FC_PIPELINES]
  );
  const ids = r.rows.map((x) => Number(x.contact_id));
  const BATCH = 100;
  let notes = 0, batches = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    batches++;
    notes += await forEachContactNotePageByIds(ids.slice(i, i + BATCH), applyContactNotes);
  }
  console.log(`healContactActivity: ${ids.length} контактів активних FC-угод, ${batches} батчів, ${notes} нотаток.`);
  return { contacts: ids.length, notes, batches };
}

/**
 * 🩺 САМОЛІКУВАННЯ АКТИВНОСТІ (ФАЗА 1). Інкрементальний прохід іде ЛИШЕ ВПЕРЕД від
 * вотермарка (`sinceUnix = last_activity_note_at - 300`), тому будь-яке пропущене вікно —
 * IP-бан, падіння, ручний зсув вотермарка — губиться НАЗАВЖДИ: жоден наступний тік туди
 * не повертається. Діагностика 30.07.2026: у ліда 61986895 людська нотатка 18.06 не
 * потрапила в жоден прохід (її `updated_at` = `created_at` = 18.06, фільтр зловив би —
 * просто вікно не сканувалось), через що «застій» показував 111 днів замість 42.
 * Замір по всіх активних FC-угодах: 97 відстають + 192 з NULL при наявних нотатках = 289
 * з 2319 (12.5%), медіана відставання 44 дні, макс 884.
 *
 * Лікування — НЕ ще один вотермарк (він так само може застрягти), а звірка ПО СУТНОСТЯХ:
 * беремо нотатки лише активних FC-угод по їхніх id і переганяємо через той самий
 * `applyNotes`. Він монотонний (GREATEST/LEAST), тож прохід ідемпотентний і ніколи не
 * зсуває анкери назад. Вотермарк НЕ рухаємо — це страховка поверх інкремента, не заміна.
 * Вартість обмежена й передбачувана: ~24 запити на батчі по 100 id (2.3к угод).
 * CLI: `node dist/jobs/syncDealActivity.js --heal-activity`.
 */
export async function healDealActivity(): Promise<{ deals: number; notes: number; batches: number }> {
  const idsRes = await pool.query<{ kommo_id: string }>(
    `SELECT d.kommo_id FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE d.pipeline_id = ANY($1::bigint[]) AND psm.funnel_stage <> 'paid'
      ORDER BY d.kommo_id`,
    [FC_PIPELINES]
  );
  const ids = idsRes.rows.map((r) => Number(r.kommo_id));
  const BATCH = 100; // Kommo обмежує довжину URL (filter[entity_id][] по id)
  let notes = 0, batches = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    batches++;
    notes += await forEachLeadNotePageByIds(ids.slice(i, i + BATCH), applyNotes);
  }
  console.log(`healDealActivity: ${ids.length} активних FC-угод, ${batches} батчів, ${notes} нотаток.`);
  return { deals: ids.length, notes, batches };
}

/**
 * Одноразовий цільовий бекфіл last_call_at для АКТИВНИХ FC-угод (~2.3к). Замість
 * сканувати рік усіх нотаток компанії — тягнемо нотатки лише відкритих FC-угод по їхніх
 * id батчами і беремо останній call_in/call_out. Легкий (нотатки лише цих угод), НЕ рухає
 * вотермарк, ідемпотентний (GREATEST). CLI: `node dist/jobs/syncDealActivity.js --backfill-calls`.
 */
export async function backfillLastCall(): Promise<void> {
  const idsRes = await pool.query<{ kommo_id: string }>(
    `SELECT d.kommo_id FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE d.pipeline_id = ANY($1::bigint[]) AND psm.funnel_stage <> 'paid'`,
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
  if (process.argv.includes("--build-links")) {
    buildDealContactLinks()
      .then(() => pool.end())
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else if (process.argv.includes("--backfill-contacts")) {
    healContactActivity()
      .then(() => pool.end())
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else if (process.argv.includes("--heal-activity")) {
    healDealActivity()
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
