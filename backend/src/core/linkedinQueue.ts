import type { Db } from "./adCallFacts.js";
import type { CloseMode } from "./carrierClose.js";
import { isWorkTime, kyivAt, kyivParts, WORK_END_HOUR, WORK_START_HOUR } from "./leadTakeRules.js";

/**
 * 🔗 ЧЕРГА LINKEDIN (задача 7361; рішення Юлі 03.11.2026, дослівно по пунктах).
 *
 *  • Угода на етапі «LinkedIn» Кваліфікації йде менеджерам ПО КОЛУ: «кожна нова заявка йде наступному за
 *    списком», «рандом не робимо». Одночасно — лише в одного менеджера.
 *  • 15 хв на «Взяти», рахуємо ЛИШЕ робочий час пн–пт 8:00–18:00 (той самий, що «Час опрацювання заявки»,
 *    `leadTakeRules`). Після 18:00 заявка чекає ранку, у вихідні черга закрита.
 *  • «Хто проігнорував, пропускає свою чергу»: пропозиція сама рухає коло, хоч би її і не взяли.
 *  • «Якщо двоє підряд не взяли, заявка йде Даші». Угода при цьому лишається на службовому «Операційному директорі»,
 *    як черга лідгенів, і Даша призначає вручну (Юля 04.11.2026) — бот у Kommo нічого не міняє.
 *  • «Перед відправкою перевіряємо, чи клієнт уже не в іншого менеджера. Якщо так — Даші, в чергу не потрапляє».
 *    Чий клієнт — те саме правило, що в реактивації (`clientOwner.ts`); тут його лише кличуть (`ownerOf`).
 *  • Відпустка, вихідний, лікарняний за «Календарем команди» — пропускаємо автоматично.
 *  • У пул не «профі», а менеджери від 1 місяця (зустріч 28.10); сам список веде Юля в Налаштуваннях.
 *
 * Режими — як у «чергового» (5972): `dry` лише пише журнал («кому віддав би») і нічого не міняє в Kommo й не
 * надсилає; `live` — бот «UTS Заявки» шле менеджеру повідомлення з кнопкою «Взяти», кнопка гасне, коли заявка йде
 * далі; натиск — `takeOffer` (відповідальний у Kommo). Менеджеру без підключеного бота в бойовому режимі нічого не
 * даємо — коло його пропускає (Роман 04.11.2026). `live` без Telegram-залежностей поводиться як `dry`.
 */

export const LINKEDIN_STAGE = { pipelineId: 8921928, statusId: 113486296 } as const;
/** Хвилин робочого часу на «Взяти». */
export const OFFER_WORK_MIN = 15;
/** Скільки менеджерів підряд можуть не взяти, перш ніж заявка йде відповідальній. */
export const MAX_MISSES = 2;
/** Початок причини «клієнт уже в іншого менеджера» — за ним статистика відрізняє дублі від «ніхто не взяв». */
export const DUP_REASON_PREFIX = "клієнт уже в ";

const DAY_MS = 86_400_000;

/** Найближча мить робочого часу: зараз, якщо робочий; інакше 08:00 найближчого буднього дня. */
export function nextWorkStart(ms: number): number {
  if (isWorkTime(ms)) return ms;
  const p = kyivParts(ms);
  let day = Date.UTC(p.y, p.mo - 1, p.d);
  let dow = p.dow;
  if (!(dow >= 1 && dow <= 5 && p.h < WORK_START_HOUR)) { day += DAY_MS; dow = (dow + 1) % 7; }
  while (dow === 0 || dow === 6) { day += DAY_MS; dow = (dow + 1) % 7; }
  const d = new Date(day);
  return kyivAt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), WORK_START_HOUR, 0);
}

/** `minutes` робочого часу від `startMs`: о 17:55 + 15 хв = 08:10 наступного робочого дня. */
export function addWorkMinutes(startMs: number, minutes: number): number {
  let t = nextWorkStart(startMs);
  let left = minutes * 60_000;
  for (;;) {
    const p = kyivParts(t);
    const end = kyivAt(p.y, p.mo, p.d, WORK_END_HOUR, 0);
    if (t + left <= end) return t + left;
    left -= end - t;
    t = nextWorkStart(end);
  }
}

/**
 * Наступний у колі після `lastId`, кому можна віддати. Порядок — список Юлі; `lastId`, якого в списку вже немає,
 * починає коло з першого. Один повний оберт: нікого — `null` (тоді заявка йде відповідальній).
 */
export function nextInRing(order: readonly number[], lastId: number | null, ok: (id: number) => boolean): number | null {
  if (!order.length) return null;
  const at = lastId == null ? -1 : order.indexOf(lastId);
  for (let k = 1; k <= order.length; k++) {
    const id = order[(at + k + order.length) % order.length];
    if (ok(id)) return id;
  }
  return null;
}

/** «Від 1 місяця» (зустріч 28.10): дата виходу не пізніше, ніж місяць тому. Невідома дата — не підказуємо. */
export function workedMonth(hiredAt: string | null, today: string): boolean {
  if (!hiredAt) return false;
  const t = new Date(`${today}T12:00:00Z`);
  t.setUTCMonth(t.getUTCMonth() - 1);
  return hiredAt.slice(0, 10) <= t.toISOString().slice(0, 10);
}

export interface StageLead { id: number; name: string; createdAt: number; responsibleUserId: number | null }
export interface QueueOwner { managerId: number; managerName: string | null }

export type QueueButton = { text: string; callback_data: string };
/** Бойовий режим: Telegram і дані для повідомлення. Немає — бойовий поводиться як пробний (лише журнал). */
export interface QueueLive {
  send: (chatId: string, html: string, buttons: QueueButton[]) => Promise<number | null>;
  edit: (chatId: string, messageId: number, html: string) => Promise<boolean>;
  /** Контакт і телефон із Kommo — лише для тексту повідомлення; збій не зупиняє пропозицію. */
  leadCard: (kommoId: number) => Promise<{ contact: string | null; phone: string | null }>;
  leadUrl: (kommoId: number) => string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
const ddmm = (ms: number) => new Date(ms).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit" });
export const TAKE_PREFIX = "lq:take:";

/** Текст пропозиції менеджеру (HTML). «До» — з датою, якщо 15 хв переходять на інший день (17:55 → 08:10). */
export function offerText(p: { dealName: string | null; contact: string | null; phone: string | null; url: string; deadlineMs: number; nowMs: number }): string {
  const sameDay = ddmm(p.deadlineMs) === ddmm(p.nowMs);
  return [
    "🔗 <b>Заявка з LinkedIn</b>",
    `<b>${esc(p.dealName ?? "без назви")}</b>`,
    [p.contact ? `👤 ${esc(p.contact)}` : null, p.phone ? `📞 ${esc(p.phone)}` : null].filter(Boolean).join(" · ") || null,
    `⏱ Взяти до <b>${sameDay ? "" : `${ddmm(p.deadlineMs)} `}${hhmm(p.deadlineMs)}</b> — потім заявка піде наступному`,
    `<a href="${p.url}">Відкрити в Kommo</a>`,
  ].filter(Boolean).join("\n");
}
export const expiredText = (dealName: string | null) => `⏱ Час минув — заявку «${esc(dealName ?? "без назви")}» передано далі.`;
export const goneText = (dealName: string | null) => `Заявку «${esc(dealName ?? "без назви")}» уже розподілено.`;
export const takenText = (dealName: string | null, url: string) => `✅ Ви взяли заявку «${esc(dealName ?? "без назви")}».\n<a href="${url}">Відкрити в Kommo</a> — подзвоніть сьогодні, ціну — в першій розмові.`;

export interface QueueDeps {
  live?: QueueLive;
  db: Db;
  mode: CloseMode;
  now: () => Date;
  /** Угоди, що ЗАРАЗ на етапі «LinkedIn» (один запит до Kommo на тік). */
  stageLeads: () => Promise<StageLead[]>;
  /** Чий клієнт (правило реактивації); `null` — нічий. */
  ownerOf: (clientKey: string) => Promise<QueueOwner | null>;
}

export interface QueueReport {
  mode: CloseMode; onStage: number; seen: number; offered: number; ignored: number;
  dispatcher: number; gone: number; waitingSync: number; offHours: boolean; paused: boolean;
}

interface ItemRow {
  kommo_id: string; state: "waiting" | "offered"; manager_id: number | null; offered_ids: number[];
  deadline_at: Date | null; misses: number; seen_responsible: string | null;
  deal_name: string | null; offer_chat_id: string | null; offer_message_id: string | null;
}

/** Один тік черги. Уся логіка — тут, джоба лише дає пул, Kommo й режим. */
export async function runLinkedinQueueTick(d: QueueDeps): Promise<QueueReport> {
  const rep: QueueReport = { mode: d.mode, onStage: 0, seen: 0, offered: 0, ignored: 0, dispatcher: 0, gone: 0, waitingSync: 0, offHours: false, paused: false };
  if (d.mode === "off") return rep;
  const live = d.mode === "live" && d.live ? d.live : null;
  const logMode = live ? "live" : "dry";
  const now = d.now();
  const nowMs = now.getTime();

  await d.db.query(`INSERT INTO linkedin_queue_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING`);
  // Точка відліку: угоди, що вже були на етапі до запуску, у чергу не йдуть (їх розібрали вручну).
  await d.db.query(`UPDATE linkedin_queue_settings SET launched_at = $1 WHERE id AND launched_at IS NULL`, [now]);
  const st = (await d.db.query<{ launched_at: Date; last_manager_id: number | null; paused: boolean }>(
    `SELECT launched_at, last_manager_id, paused FROM linkedin_queue_settings WHERE id`)).rows[0];
  // ⏸ Зупинено кнопкою: нічого не читаємо з Kommo, нікому не пропонуємо, 15 хв не спливають (див. `resumeQueue`).
  if (st.paused) { rep.paused = true; return rep; }
  let cursor = st.last_manager_id;
  const launchedMs = new Date(st.launched_at).getTime();

  const leads = await d.stageLeads();
  rep.onStage = leads.length;
  const onStage = new Map(leads.map((l) => [l.id, l]));
  const log = (kommoId: number | string, kind: string, managerId: number | null, note: string | null) =>
    d.db.query(`INSERT INTO linkedin_queue_log (kommo_id, kind, manager_id, note, mode, at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [kommoId, kind, managerId, note, logMode, now]);

  for (const l of leads) {
    if (l.createdAt < launchedMs) continue;
    const ins = await d.db.query(
      `INSERT INTO linkedin_queue_items (kommo_id, deal_name, created_at_kommo, seen_at, seen_responsible, updated_at)
       VALUES ($1, $2, $3, $4, $5, $4) ON CONFLICT (kommo_id) DO NOTHING`,
      [l.id, l.name, new Date(l.createdAt), now, l.responsibleUserId]);
    if (ins.rowCount) { rep.seen++; await log(l.id, "seen", null, null); }
  }

  const items = (await d.db.query<ItemRow>(
    `SELECT kommo_id::text, state, manager_id, offered_ids, deadline_at, misses, seen_responsible::text,
            deal_name, offer_chat_id::text, offer_message_id::text
       FROM linkedin_queue_items WHERE state IN ('waiting', 'offered') ORDER BY seen_at, kommo_id`)).rows;
  if (!items.length) return rep;

  const working = isWorkTime(nowMs);
  rep.offHours = !working;
  const today = new Date(nowMs).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const order = (await d.db.query<{ manager_id: number }>(
    `SELECT q.manager_id FROM linkedin_queue_members q JOIN managers m ON m.id = q.manager_id
      WHERE m.is_active ORDER BY q.position, q.manager_id`)).rows.map((r) => r.manager_id);
  const absent = new Set((await d.db.query<{ manager_id: number }>(
    `SELECT DISTINCT manager_id FROM team_calendar_absences
      WHERE status = 'approved' AND kind IN ('day_off', 'vacation', 'sick') AND $1::date BETWEEN start_date AND end_date`,
    [today])).rows.map((r) => r.manager_id));
  // Бойовий режим: лише менеджери з підключеним ботом (без нього — «нічого не даємо»).
  const chatOf = new Map(live ? (await d.db.query<{ manager_id: number; chat: string }>(
    `SELECT u.manager_id, u.leads_bot_chat_id::text AS chat FROM users u
      WHERE u.is_active AND u.leads_bot_chat_id IS NOT NULL AND u.manager_id = ANY($1::int[])`, [order])).rows.map((r) => [r.manager_id, r.chat]) : []);

  /** Погасити кнопку в того, кому пропонували, — заявка пішла далі або з черги. */
  const retire = async (it: ItemRow, html: string) => {
    if (!live || !it.offer_chat_id || !it.offer_message_id) return;
    await live.edit(it.offer_chat_id, Number(it.offer_message_id), html).catch(() => false);
    await d.db.query(`UPDATE linkedin_queue_items SET offer_chat_id = NULL, offer_message_id = NULL WHERE kommo_id = $1`, [it.kommo_id]);
    it.offer_chat_id = null; it.offer_message_id = null;
  };
  const close = async (it: ItemRow, state: "dispatcher" | "gone", kind: "dispatcher" | "gone", reason: string) => {
    await retire(it, state === "gone" ? goneText(it.deal_name) : expiredText(it.deal_name));
    await d.db.query(`UPDATE linkedin_queue_items SET state = $2, reason = $3, deadline_at = NULL, updated_at = $4 WHERE kommo_id = $1`,
      [it.kommo_id, state, reason, now]);
    await log(it.kommo_id, kind, null, reason);
    if (state === "dispatcher") rep.dispatcher++; else rep.gone++;
  };
  const offerNext = async (it: ItemRow) => {
    const tried = new Set(it.offered_ids);
    const pick = nextInRing(order, cursor, (id) => !absent.has(id) && !tried.has(id) && (!live || chatOf.has(id)));
    if (pick == null) { await close(it, "dispatcher", "dispatcher", "у черзі немає доступного менеджера"); return; }
    const deadline = new Date(addWorkMinutes(nowMs, OFFER_WORK_MIN));
    await d.db.query(
      `UPDATE linkedin_queue_items SET state = 'offered', manager_id = $2, offered_ids = array_append(offered_ids, $2),
              offered_at = $3, deadline_at = $4, reason = NULL, updated_at = $3 WHERE kommo_id = $1`,
      [it.kommo_id, pick, now, deadline]);
    cursor = pick;
    await d.db.query(`UPDATE linkedin_queue_settings SET last_manager_id = $1 WHERE id`, [pick]);
    let note: string | null = null;
    if (live) {
      const chat = chatOf.get(pick)!;
      const card = await live.leadCard(Number(it.kommo_id)).catch(() => ({ contact: null, phone: null }));
      const msgId = await live.send(chat, offerText({ dealName: it.deal_name, ...card, url: live.leadUrl(Number(it.kommo_id)), deadlineMs: deadline.getTime(), nowMs }),
        [{ text: "✅ Взяти", callback_data: `${TAKE_PREFIX}${it.kommo_id}` }]).catch(() => null);
      if (msgId == null) note = "не вдалося надіслати в Telegram";
      else {
        await d.db.query(`UPDATE linkedin_queue_items SET offer_chat_id = $2, offer_message_id = $3 WHERE kommo_id = $1`, [it.kommo_id, chat, msgId]);
        it.offer_chat_id = chat; it.offer_message_id = String(msgId);
      }
    }
    await log(it.kommo_id, "offer", pick, note);
    rep.offered++;
  };

  for (const it of items) {
    const lead = onStage.get(Number(it.kommo_id));
    if (!lead) { await close(it, "gone", "gone", "угода пішла з етапу «LinkedIn»"); continue; }
    if (String(lead.responsibleUserId ?? "") !== String(it.seen_responsible ?? "")) {
      await close(it, "gone", "gone", "відповідального змінили поза ботом"); continue;
    }
    if (!working) continue;
    if (it.state === "offered") {
      if (!it.deadline_at || new Date(it.deadline_at).getTime() > nowMs) continue;
      await log(it.kommo_id, "ignored", it.manager_id, null);
      rep.ignored++;
      await retire(it, expiredText(it.deal_name));
      const misses = it.misses + 1;
      await d.db.query(`UPDATE linkedin_queue_items SET misses = $2, updated_at = $3 WHERE kommo_id = $1`, [it.kommo_id, misses, now]);
      if (misses >= MAX_MISSES) { await close(it, "dispatcher", "dispatcher", `${String(MAX_MISSES)} менеджери підряд не взяли`); continue; }
      await offerNext(it);
      continue;
    }
    // waiting — спершу перевірка, чи клієнт уже не в іншого менеджера (потрібен client_key з синку угод).
    const key = (await d.db.query<{ client_key: string | null }>(
      `SELECT client_key FROM deals WHERE kommo_id = $1`, [it.kommo_id])).rows[0]?.client_key ?? null;
    if (!key) {
      rep.waitingSync++;
      await d.db.query(`UPDATE linkedin_queue_items SET reason = $2, updated_at = $3 WHERE kommo_id = $1`,
        [it.kommo_id, "чекаю синк угоди, щоб перевірити, чи клієнт уже не в іншого менеджера", now]);
      continue;
    }
    const owner = await d.ownerOf(key);
    if (owner) { await close(it, "dispatcher", "dispatcher", `${DUP_REASON_PREFIX}${owner.managerName ?? `менеджера #${String(owner.managerId)}`}`); continue; }
    await offerNext(it);
  }
  return rep;
}

/**
 * ⏸ / ▶ «Зупинити бота» (Роман 03.11.2026). Запуск дає поточним пропозиціям свіжі 15 хв робочого часу: пауза — рішення
 * керівника, а не мовчання менеджера, тож у «проігнорував» вона потрапити не може.
 */
export async function setQueuePaused(db: Db, paused: boolean, userId: number, now = new Date()): Promise<void> {
  await db.query(`INSERT INTO linkedin_queue_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING`);
  await db.query(`UPDATE linkedin_queue_settings SET paused = $1, paused_by = $2, paused_at = $3, updated_by = $2, updated_at = $3 WHERE id`,
    [paused, userId, now]);
  if (!paused) {
    await db.query(`UPDATE linkedin_queue_items SET deadline_at = $1, updated_at = $2 WHERE state = 'offered'`,
      [new Date(addWorkMinutes(now.getTime(), OFFER_WORK_MIN)), now]);
  }
}

export type TakeResult =
  | { ok: true; dealName: string | null }
  | { ok: false; why: "not_linked" | "not_yours" | "expired" | "kommo_failed" };

/**
 * ✅ «Взяти» з бота. Спершу АТОМАРНО забираємо заявку собі (лише якщо вона зараз запропонована саме цьому менеджеру
 * і 15 хв ще не минули — або бот на паузі, тоді час заморожено), потім міняємо відповідального в Kommo. Kommo не
 * прийняв — повертаємо пропозицію, як була: краще «спробуйте ще раз», ніж угода, взята в дашборді й нічия в CRM.
 */
export async function takeOffer(db: Db, p: { kommoId: number; chatId: number | string; now: Date;
  assign: (kommoId: number, kommoUserId: number, managerName: string) => Promise<void> }): Promise<TakeResult> {
  const me = (await db.query<{ manager_id: number; kommo_user_id: string | null; name: string }>(
    `SELECT m.id AS manager_id, m.kommo_user_id::text, m.name FROM users u JOIN managers m ON m.id = u.manager_id
      WHERE u.leads_bot_chat_id = $1 AND u.is_active AND m.is_active`, [String(p.chatId)])).rows[0];
  if (!me?.kommo_user_id) return { ok: false, why: "not_linked" };
  const claimed = (await db.query<{ deal_name: string | null }>(
    `UPDATE linkedin_queue_items SET state = 'taken', updated_at = $3
      WHERE kommo_id = $1 AND state = 'offered' AND manager_id = $2
        AND (deadline_at > $3 OR (SELECT paused FROM linkedin_queue_settings WHERE id))
      RETURNING deal_name`, [p.kommoId, me.manager_id, p.now])).rows[0];
  if (!claimed) {
    const cur = (await db.query<{ state: string; manager_id: number | null }>(
      `SELECT state, manager_id FROM linkedin_queue_items WHERE kommo_id = $1`, [p.kommoId])).rows[0];
    return { ok: false, why: cur?.state === "offered" && cur.manager_id === me.manager_id ? "expired" : "not_yours" };
  }
  try { await p.assign(p.kommoId, Number(me.kommo_user_id), me.name); }
  catch (e) {
    await db.query(`UPDATE linkedin_queue_items SET state = 'offered', updated_at = $2 WHERE kommo_id = $1 AND state = 'taken'`, [p.kommoId, p.now]);
    console.error("linkedinQueue take: Kommo не прийняв:", (e as Error).message);
    return { ok: false, why: "kommo_failed" };
  }
  await db.query(`UPDATE linkedin_queue_items SET deadline_at = NULL, offer_chat_id = NULL, offer_message_id = NULL WHERE kommo_id = $1`, [p.kommoId]);
  await db.query(`INSERT INTO linkedin_queue_log (kommo_id, kind, manager_id, note, mode, at) VALUES ($1, 'taken', $2, NULL, 'live', $3)`,
    [p.kommoId, me.manager_id, p.now]);
  return { ok: true, dealName: claimed.deal_name };
}
