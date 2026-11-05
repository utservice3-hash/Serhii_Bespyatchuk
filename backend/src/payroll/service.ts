/**
 * 💰 «Зарплата» — представлення й дії (ТЗ §5, контракт api/openapi.yaml пакета). Усі суми й правила — рушій пакета
 * (`engine/zarplata-engine.mjs`): тут лише знімок даних, перевірка прав «хто», запис, історія й сповіщення.
 * Порядок кожної дії: свіжий знімок → перевірка рушієм (статус, ліміт, форма) → запис у транзакції → новий знімок →
 * сповіщення рушія → автозакриття виконаних «потрібна дія». Кеш знімка для читання — 60 с, скидається кожною дією.
 */
import type { Pool, PoolClient } from "pg";
import { writeClientPin } from "../core/clientTransfer.js";
import { effectiveFromFor } from "../core/effectiveManager.js";
import { kyivToday } from "../core/dates.js";
import { createPayroll, nextStatus, nextMonth, prevMonth, lastDay, CLEARANCE_ITEMS, CLEARANCE_ROLES, LEAVE_TYPES, EXTRA_KINDS, DEFAULT_SETTINGS, type Payroll, type PayrollState } from "./engine/zarplata-engine.mjs";
import { createNotifier, OFFER_TITLES } from "./engine/notify.mjs";
import { loadState, kyivNow, kyivIso, monthStart, NAME_SQL, NAME_JOIN } from "./state.js";
import { emitAll, closeDone, type EngineNotification } from "./notifyCenter.js";
import { encryptCard, decryptCard, validateCard, cardHash, cardsAvailable, CardKeyMissing } from "./cards.js";

type Db = Pool | PoolClient;
export class PayrollError extends Error {
  constructor(public status: number, message: string, public field?: string) { super(message); }
}
const fail = (status: number, message: string, field?: string): never => { throw new PayrollError(status, message, field); };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const checkMonth = (mk: unknown): string => (typeof mk === "string" && MONTH.test(mk) ? mk : fail(400, "Місяць — у форматі РРРР-ММ.", "month"));
const money = (x: unknown): number => { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };

export interface Viewer { userId: number; roleKey: string; perms: Set<string> }
export const can = (v: Viewer, p: string) => v.perms.has(p);

// ---------- знімок і рушій ----------
interface Engine { state: PayrollState & { meta: { managerOf: Record<string, number | null> } }; zp: Payroll; nt: ReturnType<typeof createNotifier> }
let cache: { at: number; e: Engine } | null = null;
export function invalidate() { cache = null; }
export async function engine(db: Db, opts: { fresh?: boolean; now?: string } = {}): Promise<Engine> {
  if (!opts.fresh && !opts.now && cache && Date.now() - cache.at < 60_000) return cache.e;
  const state = await loadState(db, { now: opts.now });
  const zp = createPayroll(state);
  const e = { state, zp, nt: createNotifier(zp, state) };
  if (!opts.now) cache = { at: Date.now(), e };
  return e;
}
/** Після дії: свіжий знімок, сповіщення рушія, автозакриття виконаних дій. */
async function after(db: Db, build?: (e: Engine) => EngineNotification[]): Promise<Engine> {
  invalidate();
  const e = await engine(db, { fresh: true });
  if (build) await emitAll(db, build(e));
  await closeDone(db, (n) => e.nt.notificationDoneAt(n));
  return e;
}

async function nameOf(db: Db, userId: number): Promise<string> {
  return (await db.query<{ name: string }>(`SELECT ${NAME_SQL} AS name FROM users u ${NAME_JOIN} WHERE u.id = $1`, [userId])).rows[0]?.name ?? `#${userId}`;
}
async function history(db: Db, by: number | null, subject: number | null, what: string, note: string | null = null, ref: unknown = null, internal = false) {
  const label = by == null ? "Система" : await nameOf(db, by);
  await db.query(`INSERT INTO payroll_history (by_user, by_label, subject_user, what, note, internal, ref) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [by, label, subject, what, note, internal, ref ? JSON.stringify(ref) : null]);
}
async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { c.release(); }
}

// ---------- що можна віддати людині: без чужих зарплат і внутрішніх коментарів ----------
const nameMap = (e: Engine) => Object.fromEntries(e.zp.employees.map((x: { id: string; name: string }) => [x.id, x.name]));
function birthdaysOut(e: Engine, list: Array<Record<string, unknown>>) {
  const N = nameMap(e);
  return list.map((b) => ({ kind: b.kind, amount: b.amount, date: b.kind === "gift" ? (b.gift as { date: string }).date : b.date,
    who: b.kind === "give" ? { id: b.who, name: N[b.who as string] ?? "" } : null,
    gift: b.kind === "gift" ? { months: (b.gift as Record<string, unknown>).months, young: (b.gift as Record<string, unknown>).young, company: (b.gift as Record<string, unknown>).company,
      givers: ((b.gift as Record<string, unknown>).givers as string[]).length, fromTeam: (b.gift as Record<string, unknown>).fromTeam, fromMonths: (b.gift as Record<string, unknown>).fromMonths } : null }));
}
/** calc() для показу: тім-ліду — маржа й план людей команди, БЕЗ їхніх зарплат; угоди — лише власні. */
export function calcOut(e: Engine, c: Record<string, unknown>, opts: { withMembersPay?: boolean } = {}) {
  const N = nameMap(e);
  const out: Record<string, unknown> = { ...c, birthdays: birthdaysOut(e, c.birthdays as Array<Record<string, unknown>>) };
  if (c.deals) out.deals = (c.deals as Array<Record<string, unknown>>).map((d) => ({ ...d, ttnAt: e.zp.ttnDate(d), counts: e.zp.counts(d) }));
  if (c.held) out.held = (c.held as unknown[]).length;
  if (c.members) out.members = (c.members as Array<Record<string, unknown>>).map((m) => {
    const mc = m.calc as Record<string, unknown>;
    return { empId: m.empId, name: N[m.empId as string] ?? "", margin: m.margin, plan: mc.plan, planDone: mc.planDone, level: mc.level, changed: m.changed,
      ...(opts.withMembersPay ? { now: mc.now, atPlan: mc.atPlan } : {}) };
  });
  return out;
}
function settlementOut(e: Engine, f: Record<string, unknown>, forEmployee: boolean) {
  const calc = calcOut(e, f.calc as Record<string, unknown>, { withMembersPay: !forEmployee });
  const { record: _r, calc: _c, ...rest } = f;
  void _r; void _c;
  return { ...rest, calc };
}
function recordOut(e: Engine, empId: string, mk: string, forEmployee: boolean) {
  const r = e.zp.record(empId, mk); if (!r) return null;
  const f = e.zp.settlement(empId, mk);
  const base = {
    month: mk, status: r.status, reply: r.reply ?? null, payBlocked: e.zp.payBlocked(empId, mk), payNeedsOd: e.zp.payNeedsOd(empId, mk),
    verifiedAt: r.verifiedAt ?? null, agreedAt: r.agreedAt ?? null, paidAt: r.paidAt ?? null,
    dispute: r.dispute ?? null, form: r.form ? { cash: r.form.cash, at: r.form.at, cards: r.form.cards.map((c: Record<string, unknown>) => ({ cardId: c.cardId, last4: String(c.no).slice(-4), holder: c.who, amount: c.amount })) } : null,
    payout: e.zp.payoutLines(empId, mk),
    settlement: r.status === "review" && forEmployee ? null : settlementOut(e, f, forEmployee),
    // премії / утримання рядками — вид і сума зі знаком; коментар фінансиста внутрішній і сюди не йде
    extraLines: r.status === "review" && forEmployee ? [] : ((r.extras ?? []) as Array<{ kind: string; amount: number }>).map((x) => ({ kind: x.kind, label: EXTRA_KINDS[x.kind]?.[0] ?? x.kind, amount: x.amount * (EXTRA_KINDS[x.kind]?.[1] ?? 1) })),
    isFinal: e.zp.isFinal(empId, mk),
  };
  if (forEmployee) return base;
  return { ...base, notes: r.notes ?? {}, overrides: r.overrides ?? {}, extras: [] as unknown[], recordId: r.recordId };
}

// ===================================================================== кабінет
async function cardsOf(db: Db, userId: number) {
  return (await db.query<{ id: string; last4: string; holder: string }>(`SELECT id::text, last4, holder FROM payroll_cards WHERE user_id = $1 AND archived_at IS NULL ORDER BY id`, [userId]))
    .rows.map((c) => ({ id: Number(c.id), last4: c.last4, holder: c.holder }));
}
function ttnOut(e: Engine, p: Record<string, unknown>, mk: string) {
  const t = e.zp.ttnStats(p, mk);
  return { ...t, missing: t.missing.map((d: { id: string; date: string; client: string; margin: number }) => ({ id: d.id, date: d.date, client: d.client, margin: d.margin })) };
}
function clearanceOut(e: Engine, empId: string, viewerId: string | null) {
  const p = e.zp.person(empId); if (!p || !p.leave) return null;
  const st = e.zp.clearanceState(empId); if (!st) return null;
  const c = st.clearance as { createdAt: string; shots: { at: string; n: number } | null; signatures: Record<string, { at: string; by: string; name: string; data: unknown }> };
  const N = nameMap(e);
  return {
    userId: empId, name: p.name, title: p.title, leave: { date: p.leave.date, type: p.leave.type, label: LEAVE_TYPES[p.leave.type as string][0], rule: LEAVE_TYPES[p.leave.type as string][1] },
    createdAt: c.createdAt, shots: c.shots, done: st.done, total: st.total, ok: st.ok, final: !!st.final,
    clients: e.zp.clearanceClients(empId), heirs: e.zp.clearanceHeirs(empId).map((id: string) => ({ id, name: N[id] ?? "" })),
    items: CLEARANCE_ITEMS.map((x, i) => {
      const resp = e.zp.clearanceResponsible(empId, x.role); const sig = c.signatures[x.k] ?? null;
      return { n: i + 1, key: x.k, title: x.t, desc: x.d ?? null, checks: x.checks ?? null, final: !!x.final, role: x.role, roleLabel: CLEARANCE_ROLES[x.role],
        responsible: resp, signature: sig ? { at: sig.at, by: sig.by, name: sig.name, data: sig.data } : null,
        canSign: !!viewerId && !sig && e.zp.clearanceCanSign(empId, x.k, viewerId) };
    }),
  };
}

/** Хто й коли запланував зміну рівня (для «З 1 грудня — „Профі"» у кабінеті): вибір менеджера, рішення керівництва чи автоматично. */
async function levelChangeInfoOf(db: Db, uid: number, live: string) {
  const r = (await db.query<{ mk: string; level: string; reason: string; auto: boolean; at: Date; by: string | null }>(
    `SELECT to_char(t.valid_from, 'YYYY-MM') AS mk, t.level, t.reason, t.auto, t.changed_at AS at, ${NAME_SQL} AS by
       FROM payroll_terms t LEFT JOIN users u ON u.id = t.changed_by ${NAME_JOIN}
      WHERE t.user_id = $1 AND t.level IS NOT NULL AND t.valid_from > $2::date ORDER BY t.changed_at DESC LIMIT 1`, [uid, monthStart(live)])).rows[0];
  return r ? { from: r.mk, level: r.level, reason: r.reason, auto: r.auto, at: kyivIso(r.at), by: r.auto ? null : r.by } : null;
}
export async function cabinet(db: Db, v: Viewer) {
  const e = await engine(db); const id = String(v.userId); const p = e.zp.person(id);
  const perms = [...v.perms];   // які вкладки показати — фронт не чекає перелогіну (у JWT права старі)
  const live = e.zp.liveMonth, closed = e.zp.closedMonth;
  if (!p) return { enrolled: false, perms, liveMonth: live, closedMonth: closed };
  const employed = e.zp.employedIn(p, live);
  const calc = employed ? e.zp.calc(p, live) : null;
  const adv = e.zp.advanceOf(id, live);
  const L = employed ? e.zp.advanceLimit(p, live) : null;
  const paidMonths = (await db.query<{ mk: string; snap: Record<string, unknown>; paid_at: Date }>(
    `SELECT to_char(month, 'YYYY-MM') AS mk, paid_snapshot AS snap, paid_at FROM payroll_records WHERE user_id = $1 AND status = 'paid' ORDER BY month DESC LIMIT 12`, [v.userId])).rows
    .map((r) => ({ month: r.mk, pay: (r.snap as Record<string, unknown>).pay, total: (r.snap as Record<string, unknown>).total, paidAt: r.paid_at.toISOString(), how: (r.snap as Record<string, unknown>).how ?? null }));
  const advances = (await db.query<{ id: string; mk: string; amount: string; status: string; reason: string | null; requested_at: Date; paid_at: Date | null }>(
    `SELECT id::text, to_char(month, 'YYYY-MM') AS mk, amount, status, reason, requested_at, paid_at FROM payroll_advances WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 12`, [v.userId])).rows
    .map((a) => ({ id: Number(a.id), month: a.mk, amount: Number(a.amount), status: a.status, reason: a.reason, requestedAt: a.requested_at.toISOString(), paidAt: a.paid_at?.toISOString() ?? null }));
  const offers = (e.state.tasks as Array<Record<string, unknown>>).filter((t) => t.empId === id).map((t) => ({ title: t.title, level: t.level, from: t.from, createdAt: t.createdAt, signedAt: t.signedAt, voidAt: t.voidAt }));
  const S = e.zp.settings;
  return {
    enrolled: true, perms, liveMonth: live, closedMonth: closed, simple: e.zp.isSimple(p), now: e.zp.now, today: e.zp.today, settings: { verifyByDay: S.verifyByDay, payByDay: S.payByDay, advance: S.advance, ttn: S.ttn, kpi: S.kpi, start: S.start, profi: S.profi, lead: S.lead, birthday: S.birthday, payMode: S.payMode },
    employee: { id, name: p.name, title: p.title, role: p.role, dept: p.dept, deptName: e.state.departments[p.dept]?.name ?? p.dept, team: p.team, teamName: p.team ? e.state.teams[p.team]?.name ?? p.team : null,
      offer: e.zp.offerCode(p), offerName: e.zp.offerOf(p).name, offerInfo: e.zp.offerOf(p), level: e.zp.levelOf(p, live), levelChange: e.zp.levelChangeAfter(p, live), startDate: p.startDate,
      rate: e.zp.rateOf(p, live), pctRule: e.zp.pctRuleOf(p, live), startRate: e.zp.startRateOf(p), hasKpi: e.zp.hasKpi(p), clientSources: p.role === "manager" ? { start: e.zp.clientSources(p, "start"), profi: e.zp.clientSources(p, "profi") } : null,
      leave: p.leave ?? null, isFinance: !!p.isFinance, official: e.zp.officialOf(p, live), lead: p.role === "manager" ? (e.zp.leadOf(p)?.name ?? null) : null },
    live: employed ? {
      month: live, calc: calcOut(e, calc), ttn: p.role === "manager" ? ttnOut(e, p, live) : null,
      ttnPrev: e.zp.ttnPrev(p, live),
      advance: { open: e.zp.advanceWindowOpen(live), fromDay: S.advance.fromDay, limit: L ? { amount: L.amount, byRule: L.byRule, cap: L.cap, capped: L.capped, basis: L.basis, pct: L.pct, base: L.base } : null,
        request: adv ? { ...adv, status: e.zp.advanceStatus(adv) } : null },
      birthdayGift: e.zp.birthdayGift(p, live), autoProfi: p.role === "manager" ? e.zp.marginOfMonth(p, prevMonth(live)) : null,
    } : null,
    closed: closed ? recordOut(e, id, closed, true) : null,
    clearance: clearanceOut(e, id, id),
    cards: await cardsOf(db, v.userId), cardsAvailable: cardsAvailable(), payouts: paidMonths, advances, offers,
    levelChangeInfo: await levelChangeInfoOf(db, v.userId, live),
    // дні народження місяця — лише імена й дати (суми чужих ЗП тут немає); «без збору» — стаж до року
    birthdaysMonth: (e.zp.employees as Array<Record<string, unknown>>).map((x) => ({ x, g: e.zp.birthdayGift(x, live) as { date: string; young: boolean } | null }))
      .filter((r) => r.g).map((r) => ({ id: r.x.id, name: r.x.name, date: r.g!.date, young: r.g!.young, me: r.x.id === id })).sort((a, b) => a.date.localeCompare(b.date)),
    advanceRemind: (await db.query(`SELECT 1 FROM payroll_reminders WHERE user_id = $1 AND month = $2::date AND kind = 'advance' AND sent_at IS NULL`, [v.userId, monthStart(live)])).rowCount! > 0,
  };
}
export async function myDeals(db: Db, v: Viewer, mk: string) {
  const e = await engine(db); const id = String(v.userId);
  if (!e.zp.person(id)) return [];
  return e.zp.allDeals(id, mk).map((d: Record<string, unknown>) => ({ ...d, ttnAt: e.zp.ttnDate(d), counts: e.zp.counts(d) }));
}
export async function myGoal(db: Db, v: Viewer, q: Record<string, unknown>) {
  const e = await engine(db); const id = String(v.userId); const p = e.zp.person(id);
  if (!p) fail(404, "Вас немає в зарплаті — зверніться до фінансиста.");
  if (p.role !== "manager") fail(403, "Калькулятор «Ціль» — лише для менеджерів з продажу.");
  const mk = e.zp.liveMonth, defs = e.zp.goalDefaults(p, mk);
  if (q.target == null) return { defaults: defs, sources: { start: e.zp.clientSources(p, "start"), profi: e.zp.clientSources(p, "profi") }, regularAllowed: { start: e.zp.regularAllowed(p, "start"), profi: e.zp.regularAllowed(p, "profi") } };
  const level = q.level === "profi" ? "profi" : "start";
  const r = e.zp.goalRun(p, mk, { level, target: Number(q.target), conv: Number(q.conv ?? defs.conv), avgCheck: Math.max(1, Number(q.avgCheck ?? defs.avgCheck)), calls: q.calls !== "false" && q.calls !== false, regular: Number(q.regular ?? 0) });
  return r;
}

export async function agree(pool: Pool, v: Viewer, mk: string) {
  const id = String(v.userId);
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); const r = e.zp.record(id, mk);
    if (!r) fail(404, "Розрахункового листа за цей місяць немає.");
    if (!nextStatus(r.status, "agree")) fail(409, "Погодити можна лише перевірений розрахунковий лист.");
    await c.query(`UPDATE payroll_records SET status = 'agreed', agreed_at = now() WHERE month = $1::date AND user_id = $2`, [monthStart(mk), v.userId]);
    await history(c, v.userId, v.userId, `${mk} — погоджено`, null, { month: mk });
  });
  const e = await after(pool);
  return recordOut(e, id, mk, true);
}
export async function dispute(pool: Pool, v: Viewer, mk: string, text: unknown) {
  const id = String(v.userId), t = String(text ?? "").trim();
  if (t.length < 3) fail(422, "Напишіть, з чим не згодні — фінансист побачить ваш текст.", "text");
  let at = "";
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); const r = e.zp.record(id, mk);
    if (!r) fail(404, "Розрахункового листа за цей місяць немає.");
    if (!nextStatus(r.status, "dispute")) fail(409, "Не погодитись можна лише з перевіреним розрахунковим листом.");
    await c.query(`UPDATE payroll_records SET status = 'disputed', dispute_text = $3, dispute_at = now() WHERE month = $1::date AND user_id = $2`, [monthStart(mk), v.userId, t]);
    await history(c, v.userId, v.userId, `${mk} — не погоджується`, t, { month: mk });
    at = kyivNow();
  });
  const e = await after(pool, (e) => e.nt.build.dispute(id, mk, at, t));
  return recordOut(e, id, mk, true);
}

/** Рядки форми / авансу: існуючі карти людини або нові (шифруємо й зберігаємо в «Мої карти»). */
async function resolveLines(c: PoolClient, userId: number, lines: unknown, byUser: number) {
  const out: Array<{ cardId: number; amount: number; last4: string; holder: string; isNew: boolean; no: string }> = [];
  for (const raw of (Array.isArray(lines) ? lines : []) as Array<Record<string, unknown>>) {
    const amount = money(raw.amount);
    if (!(amount > 0)) continue;
    if (raw.newCard && typeof raw.newCard === "object") {
      const nc = raw.newCard as Record<string, unknown>;
      const bad = validateCard(String(nc.number ?? ""), String(nc.holder ?? ""));
      if (bad) fail(422, bad, "card");
      const { enc, last4, hash } = encryptCard(String(nc.number));
      const ex = await c.query<{ id: string }>(`SELECT id::text FROM payroll_cards WHERE user_id = $1 AND number_hash = $2 AND archived_at IS NULL`, [userId, hash]);
      const cardId = ex.rows[0] ? Number(ex.rows[0].id) : Number((await c.query<{ id: string }>(
        `INSERT INTO payroll_cards (user_id, number_enc, last4, number_hash, holder, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`,
        [userId, enc, last4, hash, String(nc.holder).trim(), byUser])).rows[0].id);
      out.push({ cardId, amount, last4, holder: String(nc.holder).trim(), isNew: true, no: `${cardId}-${last4}` });
    } else {
      const card = await c.query<{ id: string; last4: string; holder: string }>(`SELECT id::text, last4, holder FROM payroll_cards WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`, [Number(raw.cardId), userId]);
      if (!card.rows[0]) fail(422, "Карту не знайдено серед ваших карт — оновіть сторінку.", "card");
      out.push({ cardId: Number(card.rows[0].id), amount, last4: card.rows[0].last4, holder: card.rows[0].holder, isNew: false, no: `${card.rows[0].id}-${card.rows[0].last4}` });
    }
  }
  if (new Set(out.map((x) => x.cardId)).size !== out.length) fail(422, "Одна карта двічі — об’єднайте суми в одному рядку.", "card");
  return out;
}
const uahTxt = (n: number) => `${Math.round(n).toLocaleString("uk-UA").replace(/\s/g, " ")} ₴`;

export async function submitForm(pool: Pool, v: Viewer, mk: string, body: Record<string, unknown>) {
  const id = String(v.userId); let at = "";
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); const r = e.zp.record(id, mk);
    if (!r) fail(404, "Розрахункового листа за цей місяць немає.");
    if (!nextStatus(r.status, "submitForm")) fail(409, "Форму на виплату можна подати лише після згоди з розрахунковим листом.");
    if (e.zp.payBlocked(id, mk)) fail(409, "Місяць звільнення: форма на виплату — після підписів усіх пунктів обхідного листа.");
    const cash = money(body.cash ?? 0);
    if (!(cash >= 0)) fail(422, "Готівка — не менше нуля.", "cash");
    const lines = await resolveLines(c, v.userId, body.lines, v.userId);
    const chk = e.zp.checkPayoutForm(id, mk, { cash, cards: lines.map((l) => ({ no: l.no, who: l.holder, amount: l.amount })) });
    if (chk.negative) fail(422, "Суми не можуть бути від’ємними.");
    if (chk.duplicate) fail(422, "Одна карта двічі — об’єднайте суми в одному рядку.");
    if (!chk.ok) fail(422, `Не сходиться на ${uahTxt(Math.abs(chk.rest))}: готівка й карти разом мають дорівнювати ${uahTxt(chk.due)}.`, "amount");
    const rec = (await c.query<{ id: string }>(`SELECT id::text FROM payroll_records WHERE month = $1::date AND user_id = $2 FOR UPDATE`, [monthStart(mk), v.userId])).rows[0];
    const f = await c.query<{ id: string }>(`INSERT INTO payroll_payout_forms (record_id, cash, submitted_by) VALUES ($1,$2,$3) RETURNING id::text`, [Number(rec.id), cash, v.userId]);
    for (const l of lines) await c.query(`INSERT INTO payroll_payout_lines (form_id, card_id, amount) VALUES ($1,$2,$3)`, [Number(f.rows[0].id), l.cardId, l.amount]);
    await c.query(`UPDATE payroll_records SET status = 'submitted' WHERE id = $1`, [Number(rec.id)]);
    await history(c, v.userId, v.userId, `${mk} — форма на виплату ${uahTxt(chk.due)}`, lines.map((l) => `•••• ${l.last4} — ${uahTxt(l.amount)}`).concat(cash ? [`готівка — ${uahTxt(cash)}`] : []).join("; "), { month: mk });
    at = kyivNow();
  });
  const e = await after(pool, (e) => e.nt.build.payoutForm(id, mk, at));
  return recordOut(e, id, mk, true);
}

export async function requestAdvance(pool: Pool, v: Viewer, body: Record<string, unknown>) {
  const id = String(v.userId); let mk = "";
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); const p = e.zp.person(id);
    if (!p) fail(403, "Вас немає в зарплаті — зверніться до фінансиста.");
    mk = e.zp.liveMonth;
    if (!e.zp.advanceWindowOpen(mk)) fail(409, `Заявки на аванс — з ${e.zp.settings.advance.fromDay}-го числа.`);
    const cur = e.zp.advanceOf(id, mk);
    if (cur && e.zp.advanceStatus(cur) !== "rejected") fail(409, "Заявка на аванс цього місяця вже є.");
    const L = e.zp.advanceLimit(p, mk);
    const cash = money(body.cash ?? 0); if (!(cash >= 0)) fail(422, "Готівка — не менше нуля.", "cash");
    const lines = await resolveLines(c, v.userId, body.lines, v.userId);
    const amount = Math.round((cash + lines.reduce((s, l) => s + l.amount, 0)) * 100) / 100;
    if (!(amount > 0)) fail(422, "Вкажіть суму авансу.", "amount");
    if (amount > L.amount) fail(422, `Більше ліміту на сьогодні: можна до ${uahTxt(L.amount)}.`, "amount");
    const a = await c.query<{ id: string }>(`INSERT INTO payroll_advances (month, user_id, amount, cash, limit_at_request) VALUES ($1::date,$2,$3,$4,$5) RETURNING id::text`,
      [monthStart(mk), v.userId, amount, cash, L.amount]);
    for (const l of lines) await c.query(`INSERT INTO payroll_advance_lines (advance_id, card_id, amount) VALUES ($1,$2,$3)`, [Number(a.rows[0].id), l.cardId, l.amount]);
    await history(c, v.userId, v.userId, `${mk} — заявка на аванс ${uahTxt(amount)}`, lines.map((l) => `•••• ${l.last4}`).concat(cash ? ["готівка"] : []).join(", "), { month: mk, advance: Number(a.rows[0].id) });
  });
  await after(pool, (e) => e.nt.build.advanceRequested(id, mk));
  return { ok: true };
}
/** «Нагадати» в кабінеті: сповіщення в день, коли відкриються заявки на аванс (джоба `payrollReminders`). Повторне — скасовує. */
export async function toggleAdvanceReminder(pool: Pool, v: Viewer) {
  const e = await engine(pool); const p = e.zp.person(String(v.userId));
  if (!p) fail(403, "Вас немає в зарплаті — зверніться до фінансиста.");
  const mk = e.zp.liveMonth;
  if (e.zp.advanceWindowOpen(mk)) fail(409, "Заявки на аванс уже відкрито — можна подавати.");
  const del = await pool.query(`DELETE FROM payroll_reminders WHERE user_id = $1 AND month = $2::date AND kind = 'advance' AND sent_at IS NULL`, [v.userId, monthStart(mk)]);
  if (del.rowCount) return { on: false };
  await pool.query(`INSERT INTO payroll_reminders (user_id, month, kind) VALUES ($1, $2::date, 'advance') ON CONFLICT DO NOTHING`, [v.userId, monthStart(mk)]);
  return { on: true, day: e.zp.settings.advance.fromDay };
}
/** Джоба: відкрились заявки на аванс → сповіщення тим, хто просив нагадати (тип adv.open; канали — з правил). */
export async function remindersTick(pool: Pool): Promise<number> {
  const e = await engine(pool, { fresh: true }); const mk = e.zp.liveMonth;
  if (!e.zp.advanceWindowOpen(mk)) return 0;
  const due = (await pool.query<{ id: string; user_id: number }>(`SELECT id::text, user_id FROM payroll_reminders WHERE kind = 'advance' AND month = $1::date AND sent_at IS NULL`, [monthStart(mk)])).rows;
  if (!due.length) return 0;
  const N = nameMap(e);
  await emitAll(pool, due.filter((r) => N[String(r.user_id)] !== undefined).map((r) => {
    const L = e.zp.advanceLimit(String(r.user_id), mk) as { amount: number };
    return { type: "adv.open", to: [String(r.user_id)], act: false, title: "Заявки на аванс відкрито", text: `Можна взяти до ${uahTxt(L.amount)} — подайте заявку в кабінеті «Моя зарплата».`, go: { tab: "cab", mz: { tab: "pay", focus: "#adv" } }, empId: String(r.user_id) };
  }));
  await pool.query(`UPDATE payroll_reminders SET sent_at = now() WHERE id = ANY($1::bigint[])`, [due.map((r) => Number(r.id))]);
  return due.length;
}
export async function cancelAdvance(pool: Pool, v: Viewer, advId: number) {
  const r = await pool.query(`UPDATE payroll_advances SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND user_id = $2 AND status = 'requested'`, [advId, v.userId]);
  if (!r.rowCount) fail(409, "Скасувати можна лише свою заявку, яку ще не виплатили.");
  await history(pool, v.userId, v.userId, "Заявку на аванс скасовано", null, { advance: advId });
  await after(pool);
  return { ok: true };
}
export async function myCards(db: Db, v: Viewer) { return cardsOf(db, v.userId); }
export async function addCard(pool: Pool, v: Viewer, body: Record<string, unknown>) {
  const exists = (await pool.query(`SELECT 1 FROM payroll_employees WHERE user_id = $1`, [v.userId])).rowCount;
  if (!exists) fail(403, "Вас немає в зарплаті — зверніться до фінансиста.");
  const bad = validateCard(String(body.number ?? ""), String(body.holder ?? "")); if (bad) fail(422, bad, "number");
  const hash = cardHash(String(body.number));
  if ((await pool.query(`SELECT 1 FROM payroll_cards WHERE user_id = $1 AND number_hash = $2 AND archived_at IS NULL`, [v.userId, hash])).rowCount) fail(422, "Ця карта вже є у ваших картах.", "number");
  const { enc, last4 } = encryptCard(String(body.number));
  const r = await pool.query<{ id: string }>(`INSERT INTO payroll_cards (user_id, number_enc, last4, number_hash, holder, created_by) VALUES ($1,$2,$3,$4,$5,$1) RETURNING id::text`,
    [v.userId, enc, last4, hash, String(body.holder).trim()]);
  await history(pool, v.userId, v.userId, `Додано карту •••• ${last4}`, String(body.holder).trim());
  return { id: Number(r.rows[0].id), last4, holder: String(body.holder).trim() };
}
export async function archiveCard(pool: Pool, v: Viewer, cardId: number) {
  const r = await pool.query<{ last4: string }>(`UPDATE payroll_cards SET archived_at = now() WHERE id = $1 AND user_id = $2 AND archived_at IS NULL RETURNING last4`, [cardId, v.userId]);
  if (r.rows[0]) await history(pool, v.userId, v.userId, `Прибрано карту •••• ${r.rows[0].last4}`);
}

/** Рівень: «Профі» з наступного місяця (стандартний офер) → умова + офер у документах + задача рекрутеру. */
async function setLevel(c: PoolClient, empId: number, level: "start" | "profi", fromMk: string, reason: string, by: number | null, auto: boolean) {
  await c.query(`INSERT INTO payroll_terms (user_id, valid_from, level, reason, changed_by, auto) VALUES ($1, $2::date, $3, $4, $5, $6)`, [empId, monthStart(fromMk), level, reason, by, auto]);
  await c.query(`UPDATE payroll_offer_docs SET void_at = now() WHERE user_id = $1 AND signed_at IS NULL AND void_at IS NULL`, [empId]);
}
export async function chooseProfi(pool: Pool, v: Viewer) {
  const id = String(v.userId); let task: Record<string, unknown> | null = null;
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); const p = e.zp.person(id);
    if (!p || p.role !== "manager") fail(403, "Рівень обирає лише менеджер з продажу.");
    if (e.zp.offerCode(p) !== "std") fail(409, "Офер команди Лілії: «Профі» — автоматично, коли маржа понад поріг два місяці поспіль.");
    const live = e.zp.liveMonth, nm = nextMonth(live);
    if (e.zp.levelOf(p, live) === "profi") fail(409, "Ви вже на «Профі».");
    if (e.zp.levelChangeAfter(p, live)) fail(409, "Зміну рівня з наступного місяця вже заплановано.");
    await setLevel(c, v.userId, "profi", nm, "вибір менеджера", v.userId, false);
    const d = await c.query<{ id: string }>(`INSERT INTO payroll_offer_docs (user_id, offer_title, level, valid_from, why) VALUES ($1, $2, 'profi', $3::date, 'вибір менеджера') RETURNING id::text`, [v.userId, OFFER_TITLES.profi, monthStart(nm)]);
    await history(c, v.userId, v.userId, `Рівень: «Профі» з ${nm}`, "вибір менеджера");
    task = { id: Number(d.rows[0].id), level: "profi", from: monthStart(nm), due: `${nm}-05`, why: "вибір менеджера", created: kyivNow() };
  });
  await after(pool, (e) => e.nt.build.offerTask(id, task));
  return { ok: true };
}

const MAX_SHOT = 3_000_000;
export async function sendShots(pool: Pool, v: Viewer, body: Record<string, unknown>) {
  const id = String(v.userId); const files = Array.isArray(body.files) ? body.files.map(String) : [];
  if (!files.length) fail(422, "Додайте скріншоти повідомлень клієнтам.", "files");
  if (files.some((f) => !/^data:image\/(png|jpe?g|webp);base64,/.test(f) || f.length > MAX_SHOT)) fail(422, "Скріншоти — зображення PNG / JPG до 2 МБ кожне.", "files");
  let n = 0;
  await tx(pool, async (c) => {
    const cl = (await c.query<{ id: string }>(`SELECT id::text FROM payroll_clearances WHERE user_id = $1 FOR UPDATE`, [v.userId])).rows[0];
    if (!cl) fail(409, "Обхідного листа немає.");
    for (const f of files) await c.query(`INSERT INTO payroll_clearance_files (clearance_id, data_url, uploaded_by) VALUES ($1,$2,$3)`, [Number(cl.id), f, v.userId]);
    n = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM payroll_clearance_files WHERE clearance_id = $1`, [Number(cl.id)])).rows[0].n);
    await c.query(`UPDATE payroll_clearances SET shots_at = now(), shots_n = $2 WHERE id = $1`, [Number(cl.id), n]);
    await history(c, v.userId, v.userId, `Обхідний лист — надіслано скріншоти (${files.length})`, null);
  });
  await after(pool, (e) => e.nt.build.clearanceShots(id, kyivNow(), n));
  return { ok: true, n };
}

// ===================================================================== фінансист: нарахування, перевірка
function accrualRow(e: Engine, p: Record<string, unknown>, mk: string) {
  const id = p.id as string, a = e.zp.advanceOf(id, mk);
  return { userId: id, name: p.name, title: p.title, role: p.role, team: p.team, teamName: p.team ? e.state.teams[p.team as string]?.name ?? p.team : null, dept: p.dept, isFinance: !!p.isFinance,
    calc: calcOut(e, e.zp.calc(id, mk), { withMembersPay: true }), advance: a ? { ...a, status: e.zp.advanceStatus(a) } : null,
    official: e.zp.officialOf(id, mk), ttn: p.role === "manager" ? e.zp.ttnStats(id, mk) : null, limit: e.zp.isLive(mk) ? e.zp.advanceLimit(id, mk).amount : null,
    record: e.zp.record(id, mk) ? { status: e.zp.record(id, mk).status, total: e.zp.settlement(id, mk).total, pay: e.zp.settlement(id, mk).pay } : null };
}
export async function accruals(db: Db, mk: string) {
  const e = await engine(db);
  if (mk > e.zp.liveMonth) return [];
  return e.zp.employees.filter((p: Record<string, unknown>) => e.zp.employedIn(p, mk)).map((p: Record<string, unknown>) => accrualRow(e, p, mk));
}
export async function queue(db: Db, v: Viewer, mk: string) {
  const e = await engine(db);
  const rows = e.zp.employees.filter((p: { id: string }) => e.zp.record(p.id, mk)).map((p: Record<string, unknown>) => {
    const id = p.id as string, r = e.zp.record(id, mk), f = e.zp.settlement(id, mk);
    const odOnly = !!p.isFinance;
    const mine = id === String(v.userId);
    const group = r.status === "paid" || r.status === "submitted" ? "done" : r.status === "verified" || r.status === "agreed" ? "employee" : odOnly ? "od" : "action";
    return { userId: id, name: p.name, title: p.title, role: p.role, level: e.zp.levelOf(p, mk), status: r.status, total: f.total, pay: f.pay, autoTotal: f.autoTotal, group, odOnly, mine,
      canEdit: can(v, "payroll_edit") && !mine && (!odOnly || can(v, "payroll_final_word")) && !["submitted", "paid"].includes(r.status) };
  });
  const fund = rows.reduce((s: number, r: { total: number }) => s + r.total, 0), autoFund = rows.reduce((s: number, r: { autoTotal: number }) => s + r.autoTotal, 0);
  return { month: mk, verifyBy: `${nextMonth(mk)}-${String(e.zp.settings.verifyByDay).padStart(2, "0")}`, payBy: `${nextMonth(mk)}-${String(e.zp.settings.payByDay).padStart(2, "0")}`, fund, autoFund, rows };
}
export async function recordView(db: Db, v: Viewer, mk: string, uid: number) {
  const e = await engine(db); const id = String(uid), p = e.zp.person(id);
  if (!p) fail(404, "Людини немає в зарплаті.");
  const r = recordOut(e, id, mk, false) as Record<string, unknown> | null;
  const extras = r ? (await db.query<{ id: string; kind: string; amount: string; note: string; created_at: Date; by: string }>(
    `SELECT x.id::text, x.kind, x.amount, x.note, x.created_at, ${NAME_SQL} AS by FROM payroll_record_extras x JOIN payroll_records r ON r.id = x.record_id
       JOIN users u ON u.id = x.created_by ${NAME_JOIN} WHERE r.month = $1::date AND r.user_id = $2 AND x.deleted_at IS NULL ORDER BY x.id`, [monthStart(mk), uid])).rows
    .map((x) => ({ id: Number(x.id), kind: x.kind, label: EXTRA_KINDS[x.kind][0], sign: EXTRA_KINDS[x.kind][1], amount: Number(x.amount), note: x.note, at: x.created_at.toISOString(), by: x.by })) : [];
  const snap = (await db.query<{ auto_snapshot: Record<string, unknown> }>(`SELECT auto_snapshot FROM payroll_records WHERE month = $1::date AND user_id = $2`, [monthStart(mk), uid])).rows[0]?.auto_snapshot ?? null;
  const unsignedOffer = (e.state.tasks as Array<Record<string, unknown>>).some((t) => t.empId === id && !t.signedAt && !t.voidAt);
  return { userId: id, name: p.name, title: p.title, role: p.role, team: p.team, teamName: p.team ? e.state.teams[p.team]?.name ?? p.team : null, isFinance: !!p.isFinance,
    level: e.zp.levelOf(p, mk), offerName: e.zp.offerOf(p).name, unsignedOffer, ...(r ?? { month: mk, status: null }), extras, autoSnapshot: snap,
    live: e.zp.isLive(mk) ? calcOut(e, e.zp.calc(id, mk), { withMembersPay: true }) : null,
    canEdit: can(v, "payroll_edit") && String(v.userId) !== id && (!p.isFinance || can(v, "payroll_final_word")),
    canResolve: can(v, "payroll_final_word"), history: await historyOf(db, uid, true),
    // ТТН за цей місяць — тим самим правилом рушія, що й у кабінеті (не перераховувати на фронті)
    ttn: p.role === "manager" ? ttnOut(e, p, mk) : null };
}
async function historyOf(db: Db, uid: number | null, internal: boolean) {
  return (await db.query<{ id: string; at: Date; by_label: string; what: string; note: string | null; internal: boolean }>(
    `SELECT id::text, at, by_label, what, note, internal FROM payroll_history WHERE ($1::int IS NULL OR subject_user = $1) ${internal ? "" : "AND NOT internal"} ORDER BY at DESC, id DESC LIMIT 200`, [uid])).rows
    .map((h) => ({ id: Number(h.id), at: h.at.toISOString(), by: h.by_label, what: h.what, note: h.note, internal: h.internal }));
}
export async function historyView(db: Db, uid: number | null) { return historyOf(db, uid, true); }

function guardEdit(e: Engine, v: Viewer, id: string, mk: string) {
  const p = e.zp.person(id); if (!p) fail(404, "Людини немає в зарплаті.");
  if (String(v.userId) === id) fail(403, "Свою зарплату перевіряє інший фінансист або ОД.");
  if (p.isFinance && !can(v, "payroll_final_word")) fail(403, "Зарплату фінансиста перевіряє ОД.");
  const r = e.zp.record(id, mk); if (!r) fail(404, "Розрахункового листа за цей місяць немає (місяць ще не закрито).");
  if (["submitted", "paid"].includes(r.status)) fail(409, "Форму вже подано або виплачено — зміни лише корекцією наступного місяця.");
  return { p, r };
}
export async function verify(pool: Pool, v: Viewer, mk: string, uid: number, body: Record<string, unknown>) {
  const id = String(uid); let at = "", reply: string | null = null, wasAgreed = false;
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); const { r } = guardEdit(e, v, id, mk);
    const f = e.zp.settlement(id, mk); const auto = f.auto as Record<string, number>;
    const inO = (body.overrides ?? {}) as Record<string, unknown>, inN = (body.notes ?? {}) as Record<string, unknown>;
    const next: Record<string, number> = { ...(r.overrides ?? {}) }, notes: Record<string, string> = { ...(r.notes ?? {}) };
    const changed: string[] = [];
    for (const k of ["margin", "pct", "rate", "bonus"]) {
      if (!(k in inO)) continue;
      const val = inO[k] === null || inO[k] === "" ? null : money(inO[k]);
      if (val !== null && !Number.isFinite(val)) fail(422, "Число з помилкою.", k);
      const prev = next[k] ?? auto[k];
      if (val === null || val === auto[k]) { if (k in next) { delete next[k]; delete notes[k]; changed.push(k); } continue; }
      if (val === prev) continue;
      const note = String(inN[k] ?? "").trim();
      if (!note) fail(422, "Кожна зміна — з внутрішнім коментарем (працівник його не бачить).", k);
      next[k] = val; notes[k] = note; changed.push(k);
    }
    reply = String(body.reply ?? "").trim() || null;
    if (r.status === "disputed" && !reply) fail(422, "Працівник не погоджується — напишіть відповідь, яку він побачить.", "reply");
    if (!nextStatus(r.status, "verify")) fail(409, "Перевірити зараз не можна.");
    wasAgreed = r.status === "agreed";
    await c.query(`UPDATE payroll_records SET status = 'verified', overrides = $3, notes = $4, verified_at = now(), verified_by = $5, reply = COALESCE($6, reply), agreed_at = NULL
                    WHERE month = $1::date AND user_id = $2`, [monthStart(mk), uid, JSON.stringify(next), JSON.stringify(notes), v.userId, reply]);
    const LABEL: Record<string, string> = { margin: "Маржа", pct: "Відсоток", rate: "Ставка", bonus: "Бонус" };
    for (const k of changed) await history(c, v.userId, uid, `${mk} — ${LABEL[k]}: ${next[k] ?? auto[k]}${next[k] === undefined ? " (повернуто автоматичне)" : ""}`, notes[k] ?? null, { month: mk, field: k }, true);
    if (reply) await history(c, v.userId, uid, `${mk} — відповідь працівнику`, reply, { month: mk });
    await history(c, v.userId, uid, `${mk} — перевірено`, null, { month: mk });
    at = kyivNow();
  });
  await after(pool, (e) => e.nt.build.verificationReady(id, mk, at, reply));
  return { ...(await recordView(pool, v, mk, uid)), reAgree: wasAgreed };
}
export async function addExtra(pool: Pool, v: Viewer, mk: string, uid: number, body: Record<string, unknown>) {
  const id = String(uid);
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); const { p } = guardEdit(e, v, id, mk);
    const kind = String(body.kind); if (!(kind in EXTRA_KINDS)) fail(422, "Невідомий вид рядка.", "kind");
    const amount = money(body.amount); if (!(amount > 0)) fail(422, "Сума — більше нуля.", "amount");
    const note = String(body.note ?? "").trim(); if (!note) fail(422, "Коментар обовʼязковий.", "note");
    if (kind === "tax" && !e.zp.officialOf(p, mk)) fail(422, "«Податки» — лише з офіційною ЗП.", "kind");
    const rec = (await c.query<{ id: string; status: string }>(`SELECT id::text, status FROM payroll_records WHERE month = $1::date AND user_id = $2 FOR UPDATE`, [monthStart(mk), uid])).rows[0];
    await c.query(`INSERT INTO payroll_record_extras (record_id, kind, amount, note, created_by) VALUES ($1,$2,$3,$4,$5)`, [Number(rec.id), kind, amount, note, v.userId]);
    if (rec.status === "agreed") await c.query(`UPDATE payroll_records SET status = 'verified', agreed_at = NULL WHERE id = $1`, [Number(rec.id)]);
    await history(c, v.userId, uid, `${mk} — ${EXTRA_KINDS[kind][0]} ${uahTxt(amount)}`, note, { month: mk }, true);
  });
  await after(pool);
  return recordView(pool, v, mk, uid);
}
export async function deleteExtra(pool: Pool, v: Viewer, mk: string, uid: number, extraId: number) {
  const id = String(uid);
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); guardEdit(e, v, id, mk);
    const r = await c.query<{ kind: string; amount: string }>(`UPDATE payroll_record_extras x SET deleted_at = now(), deleted_by = $3 FROM payroll_records r
      WHERE x.id = $1 AND x.record_id = r.id AND r.user_id = $2 AND r.month = $4::date AND x.deleted_at IS NULL RETURNING x.kind, x.amount`, [extraId, uid, v.userId, monthStart(mk)]);
    if (!r.rows[0]) fail(404, "Рядка немає.");
    await history(c, v.userId, uid, `${mk} — прибрано: ${EXTRA_KINDS[r.rows[0].kind][0]} ${uahTxt(Number(r.rows[0].amount))}`, null, { month: mk }, true);
  });
  await after(pool);
}
export async function resolveDispute(pool: Pool, v: Viewer, mk: string, uid: number, body: Record<string, unknown>) {
  const id = String(uid), decision = body.decision === "auto" ? "auto" : body.decision === "keep" ? "keep" : fail(422, "Рішення — «лишити перевірене» або «повернути орієнтовні».", "decision");
  const reply = String(body.reply ?? "").trim() || (decision === "keep" ? "ОД лишив перевірені суми." : "ОД повернув орієнтовні суми з кабінету.");
  let at = "";
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); const r = e.zp.record(id, mk);
    if (!r || r.status !== "disputed") fail(409, "Рішення ОД — лише по незгоді працівника.");
    await c.query(`UPDATE payroll_records SET status = 'verified', reply = $3, verified_at = now(), verified_by = $4 ${decision === "auto" ? ", overrides = '{}', notes = '{}'" : ""}
                    WHERE month = $1::date AND user_id = $2`, [monthStart(mk), uid, reply, v.userId]);
    await history(c, v.userId, uid, `${mk} — рішення ОД: ${decision === "keep" ? "лишити перевірене" : "повернути орієнтовні"}`, reply, { month: mk });
    at = kyivNow();
  });
  await after(pool, (e) => e.nt.build.verificationReady(id, mk, at, reply));
  return recordView(pool, v, mk, uid);
}

// ===================================================================== відомість
async function statementRows(db: Db, e: Engine, mk: string, full: boolean) {
  const out: Array<Record<string, unknown>> = []; let n = 0;
  const enc = full ? new Map((await db.query<{ id: string; number_enc: Buffer }>(
    `SELECT c.id::text, c.number_enc FROM payroll_cards c JOIN payroll_payout_lines l ON l.card_id = c.id JOIN payroll_payout_forms f ON f.id = l.form_id
       JOIN payroll_records r ON r.id = f.record_id WHERE r.month = $1::date`, [monthStart(mk)])).rows.map((r) => [Number(r.id), r.number_enc])) : new Map<number, Buffer>();
  for (const p of e.zp.employees as Array<Record<string, unknown>>) {
    const id = p.id as string, r = e.zp.record(id, mk);
    if (!r || !["submitted", "paid"].includes(r.status)) continue;
    const f = e.zp.settlement(id, mk), pl = e.zp.payoutLines(id, mk) ?? { cash: 0, cards: [] };
    const off = f.officialDeducted, ttn = f.ttn;
    const base = { userId: id, name: p.name, title: p.title, team: p.team ? e.state.teams[p.team as string]?.name ?? p.team : null, accrued: f.total, advance: f.advance, official: off, ttn, pay: f.pay,
      status: r.status, blocked: e.zp.payBlocked(id, mk), needsOd: e.zp.payNeedsOd(id, mk), paidAt: r.paidAt ?? null };
    n++;
    const lines: Array<Record<string, unknown>> = [];
    if (pl.cash) lines.push({ ...base, n, cash: pl.cash, card: 0, cardId: null, cardLast4: null, cardNo: null, holder: null });
    for (const c of pl.cards as Array<Record<string, unknown>>) {
      const cardId = Number(c.cardId ?? String(c.no).split("-")[0]);
      let cardNo: string | null = null;
      if (full && enc.get(cardId)) { try { cardNo = decryptCard(enc.get(cardId)!); } catch { cardNo = null; } }
      lines.push({ ...base, n, cash: 0, card: c.amount, cardId, cardLast4: String(c.no).slice(-4), cardNo, holder: c.who });
    }
    if (!lines.length) lines.push({ ...base, n, cash: 0, card: 0, cardId: null, cardLast4: null, cardNo: null, holder: null });
    out.push(...lines);
  }
  return out;
}
export async function statement(db: Db, mk: string) { const e = await engine(db); return statementRows(db, e, mk, false); }
const COLS: Record<string, [string, (r: Record<string, unknown>) => string | number | null]> = {
  n: ["№", (r) => r.n as number], name: ["ПІБ", (r) => r.name as string], title: ["Посада", (r) => r.title as string], team: ["Команда", (r) => (r.team as string) ?? ""],
  acc: ["Нараховано", (r) => Math.round(r.accrued as number)], adv: ["Аванс", (r) => Math.round(r.advance as number)], off: ["Офіційна ЗП", (r) => Math.round(r.official as number)],
  ttn: ["ТТН", (r) => Math.round(r.ttn as number)], pay: ["До виплати", (r) => Math.round(r.pay as number)], cash: ["Готівка", (r) => Math.round(r.cash as number)],
  card: ["На карти", (r) => Math.round(r.card as number)], cardNo: ["Карта", (r) => (r.cardNo as string) ?? (r.cardLast4 ? `•••• ${r.cardLast4}` : "")], who: ["Отримувач", (r) => (r.holder as string) ?? ""],
  st: ["Стан", (r) => (r.status === "paid" ? "виплачено" : "форму подано")], sign: ["Підпис", () => ""],
};
export async function statementXlsx(pool: Pool, v: Viewer, mk: string, columns: string[]) {
  const { buildXlsx } = await import("../core/xlsxWrite.js");
  const e = await engine(pool); const rows = await statementRows(pool, e, mk, true);
  const cols = (columns.length ? columns : Object.keys(COLS)).filter((k) => k in COLS);
  await history(pool, v.userId, null, `Відомість ${mk} — вивантажено Excel`, `${rows.length} рядків, колонки: ${cols.join(", ")}`);
  return buildXlsx([{ name: `Відомість ${mk}`, rows: [cols.map((k) => COLS[k][0]), ...rows.map((r) => cols.map((k) => COLS[k][1](r)))] }]);
}
export async function markPaid(pool: Pool, v: Viewer, mk: string, ids: number[]) {
  const paid: string[] = [], skipped: Array<{ userId: string; reason: string }> = [];
  const e0 = await engine(pool, { fresh: true });
  for (const uid of ids) {
    const id = String(uid), r = e0.zp.record(id, mk);
    if (!r || r.status !== "submitted") { skipped.push({ userId: id, reason: "форму ще не подано" }); continue; }
    if (e0.zp.payBlocked(id, mk)) { skipped.push({ userId: id, reason: "обхідний лист не підписано всіма" }); continue; }
    if (e0.zp.payNeedsOd(id, mk)) { skipped.push({ userId: id, reason: "ОД ще не погодив розрахунок (п. 9 обхідного листа)" }); continue; }
    await tx(pool, async (c) => {
      const now = kyivNow();
      const e = await engine(c, { now });   // стан на момент виплати: ТТН «до / після виплати» фіксується тут
      const f = e.zp.settlement(id, mk), pl = e.zp.payoutLines(id, mk);
      const snap = { margin: f.values.margin, total: f.total, advance: f.advance, officialDeducted: f.officialDeducted, ttn: f.ttn, ttnLines: f.ttnLines, pay: f.pay, payout: pl,
        how: pl ? [...(pl.cash ? [`готівка ${Math.round(pl.cash)}`] : []), ...pl.cards.map((x: Record<string, unknown>) => `•••• ${String(x.no).slice(-4)} — ${Math.round(x.amount as number)}`)].join("; ") : null };
      const rec = (await c.query<{ id: string }>(`SELECT id::text FROM payroll_records WHERE month = $1::date AND user_id = $2 AND status = 'submitted' FOR UPDATE`, [monthStart(mk), uid])).rows[0];
      if (!rec) return;
      await c.query(`UPDATE payroll_records SET status = 'paid', paid_at = now(), paid_by = $2, paid_snapshot = $3 WHERE id = $1`, [Number(rec.id), v.userId, JSON.stringify(snap)]);
      if (pl) for (const x of pl.cards as Array<Record<string, unknown>>) await c.query(
        `UPDATE payroll_payout_lines l SET paid_amount = $3 FROM payroll_payout_forms f WHERE f.id = l.form_id AND f.record_id = $1 AND l.card_id = $2`, [Number(rec.id), Number(x.cardId ?? String(x.no).split("-")[0]), x.amount]);
      await history(c, v.userId, uid, `${mk} — виплачено ${uahTxt(f.pay)}`, snap.how, { month: mk });
    });
    paid.push(id);
  }
  if (paid.length) await after(pool, (e) => paid.flatMap((id) => e.nt.build.paid(id, mk, kyivNow())));
  return { paid, skipped };
}

// ===================================================================== аванси (фінансист)
export async function advancesView(db: Db, mk: string) {
  const e = await engine(db);
  const reqs = (await db.query<{ id: string; user_id: number; amount: string; cash: string; status: string; reason: string | null; limit_at_request: string; requested_at: Date; paid_at: Date | null; rejected_at: Date | null;
    lines: Array<{ cardId: number; last4: string; holder: string; amount: string }> | null }>(
    `SELECT a.id::text, a.user_id, a.amount, a.cash, a.status, a.reason, a.limit_at_request, a.requested_at, a.paid_at, a.rejected_at,
            (SELECT json_agg(json_build_object('cardId', l.card_id, 'last4', c.last4, 'holder', c.holder, 'amount', l.amount) ORDER BY l.id)
               FROM payroll_advance_lines l JOIN payroll_cards c ON c.id = l.card_id WHERE l.advance_id = a.id) AS lines
       FROM payroll_advances a WHERE a.month = $1::date AND a.status <> 'cancelled' ORDER BY a.requested_at`, [monthStart(mk)])).rows;
  const N = nameMap(e);
  const requests = reqs.map((a) => ({ id: Number(a.id), userId: String(a.user_id), name: N[String(a.user_id)] ?? "", amount: Number(a.amount), cash: Number(a.cash), status: a.status, reason: a.reason,
    limit: Number(a.limit_at_request), requestedAt: a.requested_at.toISOString(), paidAt: a.paid_at?.toISOString() ?? null, rejectedAt: a.rejected_at?.toISOString() ?? null,
    lines: (a.lines ?? []).map((l) => ({ cardId: l.cardId, last4: l.last4, holder: l.holder, amount: Number(l.amount) })) }));
  const active = new Set(requests.filter((r) => r.status !== "rejected").map((r) => r.userId));
  const notYet = e.zp.isLive(mk) ? (e.zp.employees as Array<Record<string, unknown>>).filter((p) => e.zp.employedIn(p, mk) && !active.has(p.id as string))
    .map((p) => ({ userId: p.id, name: p.name, title: p.title, limit: e.zp.advanceLimit(p, mk).amount })) : [];
  return { month: mk, open: e.zp.advanceWindowOpen(mk), fromDay: e.zp.settings.advance.fromDay, requests, notYet };
}
export async function payAdvance(pool: Pool, v: Viewer, advId: number) {
  const a = (await pool.query<{ user_id: number; mk: string; amount: string }>(
    `UPDATE payroll_advances SET status = 'paid', paid_at = now(), paid_by = $2 WHERE id = $1 AND status = 'requested' RETURNING user_id, to_char(month, 'YYYY-MM') AS mk, amount`, [advId, v.userId])).rows[0];
  if (!a) fail(409, "Виплатити можна лише подану заявку.");
  await history(pool, v.userId, a.user_id, `${a.mk} — аванс виплачено: ${uahTxt(Number(a.amount))}`, null, { advance: advId });
  await after(pool, (e) => e.nt.build.advancePaid(String(a.user_id), a.mk));
  return { ok: true };
}
export async function rejectAdvance(pool: Pool, v: Viewer, advId: number, reason: unknown) {
  const why = String(reason ?? "").trim(); if (why.length < 3) fail(422, "Напишіть причину — працівник її побачить.", "reason");
  const a = (await pool.query<{ user_id: number; mk: string; amount: string }>(
    `UPDATE payroll_advances SET status = 'rejected', rejected_at = now(), rejected_by = $2, reason = $3 WHERE id = $1 AND status = 'requested' RETURNING user_id, to_char(month, 'YYYY-MM') AS mk, amount`, [advId, v.userId, why])).rows[0];
  if (!a) fail(409, "Відхилити можна лише подану заявку.");
  await history(pool, v.userId, a.user_id, `${a.mk} — аванс відхилено: ${uahTxt(Number(a.amount))}`, why, { advance: advId });
  await after(pool, (e) => e.nt.build.advanceRejected(String(a.user_id), a.mk));
  return { ok: true };
}
export async function advancesXlsx(pool: Pool, v: Viewer, mk: string) {
  const { buildXlsx } = await import("../core/xlsxWrite.js");
  const e = await engine(pool); const N = nameMap(e);
  const rows = (await pool.query<{ user_id: number; amount: string; cash: string; status: string; line_amount: string | null; number_enc: Buffer | null; last4: string | null; holder: string | null }>(
    `SELECT a.user_id, a.amount, a.cash, a.status, l.amount AS line_amount, c.number_enc, c.last4, c.holder
       FROM payroll_advances a LEFT JOIN payroll_advance_lines l ON l.advance_id = a.id LEFT JOIN payroll_cards c ON c.id = l.card_id
      WHERE a.month = $1::date AND a.status IN ('requested', 'paid') ORDER BY a.requested_at, l.id`, [monthStart(mk)])).rows;
  const out: (string | number | null)[][] = [["ПІБ", "Сума", "Спосіб", "Номер карти", "Отримувач", "Стан"]];
  const seenCash = new Set<number>();
  for (const r of rows) {
    if (Number(r.cash) > 0 && !seenCash.has(r.user_id)) { seenCash.add(r.user_id); out.push([N[String(r.user_id)] ?? "", Number(r.cash), "готівка", "", "", r.status === "paid" ? "виплачено" : "заявка"]); }
    if (r.line_amount) { let no = ""; try { no = r.number_enc ? decryptCard(r.number_enc) : ""; } catch { no = r.last4 ? `•••• ${r.last4}` : ""; }
      out.push([N[String(r.user_id)] ?? "", Number(r.line_amount), "карта", no, r.holder, r.status === "paid" ? "виплачено" : "заявка"]); }
  }
  await history(pool, v.userId, null, `Аванси ${mk} — вивантажено Excel`, `${out.length - 1} рядків`);
  return buildXlsx([{ name: `Аванси ${mk}`, rows: out }]);
}

// ===================================================================== обхідний лист
export async function createLeave(pool: Pool, v: Viewer, uid: number, body: Record<string, unknown>) {
  const id = String(uid);
  const date = String(body.date ?? ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(422, "Дата звільнення — РРРР-ММ-ДД.", "date");
  const type = String(body.type ?? ""); if (!(type in LEAVE_TYPES)) fail(422, "Тип звільнення — за п. 11 оферу.", "type");
  const reason = String(body.reason ?? "").trim(); if (!reason) fail(422, "Вкажіть причину.", "reason");
  await tx(pool, async (c) => {
    if (!(await c.query(`SELECT 1 FROM payroll_employees WHERE user_id = $1`, [uid])).rowCount) fail(404, "Людини немає в зарплаті.");
    if ((await c.query(`SELECT 1 FROM payroll_leaves WHERE user_id = $1`, [uid])).rowCount) fail(409, "Звільнення вже оформлено.");
    await c.query(`INSERT INTO payroll_leaves (user_id, leave_date, leave_type, reason, created_by) VALUES ($1,$2::date,$3,$4,$5)`, [uid, date, type, reason, v.userId]);
    await c.query(`INSERT INTO payroll_clearances (user_id, created_by) VALUES ($1,$2)`, [uid, v.userId]);
    await history(c, v.userId, uid, `Звільнення ${date} — ${LEAVE_TYPES[type][0]}; створено обхідний лист`, reason);
  });
  await after(pool, (e) => e.nt.build.clearanceCreated(id, kyivNow()));
  return { ok: true };
}
const isClearanceViewer = (e: Engine, v: Viewer, empId: string) => {
  if (can(v, "payroll_view_all") || can(v, "payroll_clearance") || String(v.userId) === empId) return true;
  return CLEARANCE_ITEMS.some((x) => e.zp.clearanceResponsible(empId, x.role)?.id === String(v.userId));
};
export async function clearancesList(db: Db, v: Viewer) {
  const e = await engine(db);
  return (e.zp.employees as Array<Record<string, unknown>>).filter((p) => p.leave && isClearanceViewer(e, v, p.id as string))
    .map((p) => clearanceOut(e, p.id as string, String(v.userId))).filter(Boolean);
}
export async function clearanceView(db: Db, v: Viewer, uid: number) {
  const e = await engine(db); const id = String(uid);
  if (!e.zp.person(id) || !isClearanceViewer(e, v, id)) fail(403, "Немає доступу до цього обхідного листа.");
  const out = clearanceOut(e, id, String(v.userId)) ?? fail(404, "Обхідного листа немає.");
  const drafts = (await db.query<{ item_key: string; data: unknown }>(`SELECT d.item_key, d.data FROM payroll_clearance_drafts d JOIN payroll_clearances c ON c.id = d.clearance_id WHERE c.user_id = $1`, [uid])).rows;
  const shots = (await db.query<{ id: string; data_url: string; uploaded_at: Date }>(`SELECT f.id::text, f.data_url, f.uploaded_at FROM payroll_clearance_files f JOIN payroll_clearances c ON c.id = f.clearance_id WHERE c.user_id = $1 ORDER BY f.id`, [uid])).rows;
  const canSeeShots = String(v.userId) === id || e.zp.clearanceResponsible(id, "lead")?.id === String(v.userId) || can(v, "payroll_view_all");
  // п. 9 «Розрахунок та видача ЗП»: ОД погоджує суму — показуємо її тим, хто бачить зарплати (працівнику — у кабінеті)
  let finalPay: Record<string, unknown> | null = null;
  if (can(v, "payroll_view_all") || can(v, "payroll_final_word")) {
    const mk = String(out.leave.date).slice(0, 7), rec = e.zp.record(id, mk);
    if (rec) { const f = e.zp.settlement(id, mk); finalPay = { month: mk, status: rec.status, estimate: false, total: f.total, pay: f.pay }; }
    else if (e.zp.isLive(mk)) { const c = e.zp.calc(id, mk) as Record<string, unknown>; finalPay = { month: mk, status: null, estimate: true, total: c.now, pay: null }; }
  }
  return { ...out, finalPay, drafts: Object.fromEntries(drafts.map((d) => [d.item_key, d.data])), shotsFiles: canSeeShots ? shots.map((s) => ({ id: Number(s.id), url: s.data_url, at: s.uploaded_at.toISOString() })) : [], history: await historyOf(db, uid, false) };
}
export async function draftClearance(pool: Pool, v: Viewer, uid: number, key: string, data: unknown) {
  const e = await engine(pool); const id = String(uid);
  if (!e.zp.clearanceCanSign(id, key, String(v.userId))) fail(403, "Це не ваш пункт обхідного листа.");
  await pool.query(`INSERT INTO payroll_clearance_drafts (clearance_id, item_key, data, updated_by)
                    SELECT c.id, $2, $3, $4 FROM payroll_clearances c WHERE c.user_id = $1
                    ON CONFLICT (clearance_id, item_key) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()`, [uid, key, JSON.stringify(data ?? null), v.userId]);
  return { ok: true };
}
export async function signClearance(pool: Pool, v: Viewer, uid: number, key: string, data: unknown) {
  const id = String(uid); let n = 0; let reassigned = { pinned: 0, receivables: 0 };
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true });
    const x = CLEARANCE_ITEMS.find((i) => i.k === key); if (!x) fail(404, "Такого пункту немає.");
    if (!e.zp.clearanceCanSign(id, key, String(v.userId))) fail(403, "Підписати може лише відповідальний за цей пункт.");
    const st = e.zp.clearanceState(id); if (!st) fail(404, "Обхідного листа немає.");
    if ((st.clearance as { signatures: Record<string, unknown> }).signatures[key]) fail(409, "Пункт уже підписано.");
    if (!e.zp.clearanceReady(id, key, data)) fail(409, x!.final ? "Розрахунок погоджується лише після підписів пп. 1–8." : key === "notify" ? "Підпис — після скріншотів від менеджера по всіх клієнтах." : key === "clients" ? "Кожному клієнту — новий відповідальний." : "Поставте всі позначки пункту.");
    const resp = e.zp.clearanceResponsible(id, x!.role);
    const cl = (await c.query<{ id: string }>(`SELECT id::text FROM payroll_clearances WHERE user_id = $1 FOR UPDATE`, [uid])).rows[0];
    await c.query(`INSERT INTO payroll_clearance_signatures (clearance_id, item_key, signed_by, signer_name, data) VALUES ($1,$2,$3,$4,$5)`, [Number(cl.id), key, v.userId, resp.name, JSON.stringify(data ?? null)]);
    if (key === "clients" && data && typeof data === "object") reassigned = await reassignClients(c, uid, data as Record<string, string>, v.userId, e.zp.person(id).name);
    n = Object.keys((st.clearance as { signatures: Record<string, unknown> }).signatures).filter((k) => k !== "pay").length + (x!.final ? 0 : 1);
    await history(c, v.userId, uid, `Обхідний лист — підписано п. ${CLEARANCE_ITEMS.indexOf(x!) + 1}: ${x!.t}`, key === "clients" ? `клієнтів передано з 1-го наступного місяця: ${reassigned.pinned}; у дебіторці — одразу: ${reassigned.receivables}` : null);
  });
  const now = kyivNow();
  await after(pool, (e) => {
    const out = e.nt.build.clearanceSigned(id, key, now, n);
    if (!CLEARANCE_ITEMS.find((i) => i.k === key)!.final && e.zp.clearanceState(id)?.ok) {
      // усі 8 — задача ОД «погодити розрахунок» (сповіщення з дією clr.sign, done — підпис п. 9)
      out.push({ type: "clr.sign", at: now, to: [e.state.responsibles.od.id], act: true, cta: "Погодити", title: `Погодити розрахунок — ${e.zp.person(id).name}`,
        text: "Усі пункти обхідного листа підписано. Погодьте фінальний розрахунок — після цього фінансист виплатить.", go: { tab: "clr", focus: `#clr-${id}` },
        done: { kind: "clr.final", empId: id }, empId: id });
    }
    return out;
  });
  return clearanceView(pool, v, uid);
}
/** П. 1: «новий відповідальний скрізь у дашборді» — дебіторка (ручне призначення відповідального за клієнтом). */
/**
 * Обхідний лист, п. 1: «скрізь у дашборді в цих клієнтів новий відповідальний» (бланк компанії). Тим самим механізмом,
 * що й передача клієнта на екрані «Клієнти» (`writeClientPin`: закріплення + історія, вид `transfer` — з 1-го числа
 * наступного місяця, правило власника: план і факт поточного місяця не рухаються), плюс відповідальний у дебіторці —
 * одразу (борг збирає вже новий). Ключ клієнта — з угод того, хто звільняється, за назвою з пункту.
 */
async function reassignClients(c: PoolClient, uid: number, map: Record<string, string>, by: number, who: string): Promise<{ pinned: number; receivables: number }> {
  const leaver = (await c.query<{ manager_id: number | null }>(`SELECT manager_id FROM users WHERE id = $1`, [uid])).rows[0]?.manager_id ?? null;
  const effectiveFrom = effectiveFromFor("transfer", kyivToday());
  const reason = `Обхідний лист: ${who} звільняється — новий відповідальний`;
  let pinned = 0, recv = 0;
  for (const [client, heir] of Object.entries(map)) {
    const m = (await c.query<{ manager_id: number | null }>(`SELECT manager_id FROM users WHERE id = $1`, [Number(heir)])).rows[0];
    if (!m?.manager_id) continue;
    const keys = (await c.query<{ client_key: string }>(
      `SELECT DISTINCT client_key FROM deals WHERE client_key IS NOT NULL AND ($2::int IS NULL OR manager_id = $2)
          AND (lower(btrim(client_name)) = lower(btrim($1)) OR (client_name IS NULL AND lower(btrim(name)) = lower(btrim($1))))
       UNION SELECT DISTINCT client_key FROM receivables WHERE lower(btrim(client_name)) = lower(btrim($1))`, [client, leaver])).rows;
    for (const k of keys) {
      await writeClientPin(c, { clientKey: k.client_key, toManagerId: m.manager_id, reason, kind: "transfer", effectiveFrom, userId: by });
      pinned++;
      const r = await c.query(`INSERT INTO receivable_manager_override (client_key, manager_id, note, set_by) SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM receivables WHERE client_key = $1)
                     ON CONFLICT (client_key) DO UPDATE SET manager_id = EXCLUDED.manager_id, note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_at = now()`,
        [k.client_key, m.manager_id, reason, by]);
      recv += r.rowCount ?? 0;
    }
  }
  return { pinned, receivables: recv };
}
export async function clearancePrintHtml(db: Db, v: Viewer, uid: number): Promise<string> {
  const c = await clearanceView(db, v, uid);
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
  const rows = c.items.map((it: Record<string, unknown>) => {
    const sig = it.signature as { at: string; name: string } | null;
    return `<tr><td>${it.n}</td><td>${esc(it.title)}</td><td>${esc((it.responsible as { name: string }).name)}</td><td>${sig ? `${esc(sig.name)}<br><small>${esc(sig.at.replace("T", " "))}</small>` : "—"}</td></tr>`;
  }).join("");
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Обхідний лист — ${esc(c.name)}</title>
<style>body{font:13px/1.45 system-ui,sans-serif;margin:28px;color:#111}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:14px}td,th{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f2f2}.muted{color:#555}@media print{button{display:none}}</style></head>
<body><button onclick="print()">Друк / зберегти PDF</button><h1>Обхідний лист</h1><div>${esc(c.name)} · ${esc(c.title)}</div>
<div class="muted">Звільнення ${esc(c.leave.date)} — ${esc(c.leave.label)}. Створено ${esc(String(c.createdAt).replace("T", " "))}. Підписано ${c.done} з ${c.total}${c.final ? "; розрахунок погоджено ОД" : ""}.</div>
<table><tr><th>№</th><th>Пункт</th><th>Відповідальний</th><th>Підпис</th></tr>${rows}</table>
<h3>Історія</h3><ul>${c.history.map((h: Record<string, unknown>) => `<li>${esc(String(h.at).slice(0, 16).replace("T", " "))} — ${esc(h.by)}: ${esc(h.what)}${h.note ? ` (${esc(h.note)})` : ""}</li>`).join("")}</ul></body></html>`;
}

// ===================================================================== прогноз, аналітика, архів
export async function forecastView(db: Db, mk: string) {
  const e = await engine(db); const f = e.zp.forecast(mk); const N = nameMap(e);
  return { ...f, rows: f.rows.map((r: Record<string, unknown>) => ({ empId: r.empId, name: N[r.empId as string], now: (r.calc as Record<string, Record<string, number>>).now.total, atPlan: (r.calc as Record<string, Record<string, number>>).atPlan.total,
    margin: (r.calc as Record<string, number>).margin, plan: (r.calc as Record<string, number>).plan, advanceStatus: r.advanceStatus, advance: r.advance ? (r.advance as Record<string, number>).amount : null, limit: (r.limit as Record<string, number>).amount, official: r.official })),
    risks: f.risks.map((x: Record<string, unknown>) => ({ ...x, name: N[x.empId as string], kpi: undefined, state: undefined, ttn: x.ttn ? { total: (x.ttn as Record<string, number>).total, done: (x.ttn as Record<string, number>).done, pct: (x.ttn as Record<string, number>).pct } : undefined,
      calls: x.kpi ? { normDays: (x.kpi as Record<string, number>).normDays, need: (x.kpi as Record<string, number>).need, left: (x.kpi as Record<string, number>).left } : undefined,
      clearance: x.state ? { done: (x.state as Record<string, number>).done, total: (x.state as Record<string, number>).total } : undefined })),
    teams: f.teams.map((t: Record<string, unknown>) => ({ ...t, name: e.state.teams[t.team as string]?.name ?? t.team })), dates: { advanceFrom: e.zp.settings.advance.fromDay, payBy: e.zp.settings.payByDay },
    closedPay: closedPayOf(e), disputes: disputesOf(e) };
}
/** Виплата закритого місяця для календаря готівки: скільки людей і грошей у кожному стані (до виплати — після авансу). */
function closedPayOf(e: Engine) {
  const mk = e.zp.closedMonth; if (!mk) return null;
  const recs = (e.state.records as Record<string, Record<string, Record<string, unknown>>>)[mk] ?? {};
  const by: Record<string, { n: number; pay: number }> = {};
  let total = 0, blocked = 0;
  for (const [empId, r] of Object.entries(recs)) {
    const f = e.zp.settlement(empId, mk); const st = String(r.status);
    (by[st] ??= { n: 0, pay: 0 }); by[st].n++; by[st].pay += Number(f.pay) || 0; total += Number(f.pay) || 0;
    if (e.zp.payBlocked(empId, mk) || e.zp.payNeedsOd(empId, mk)) blocked++;
  }
  return { month: mk, total, byStatus: by, blocked, payBy: `${nextMonth(mk)}-${String(e.zp.settings.payByDay).padStart(2, "0")}` };
}
/** Незгоди закритого місяця — ризик для виплати: чекають відповіді фінансиста або рішення ОД. */
function disputesOf(e: Engine) {
  const mk = e.zp.closedMonth; if (!mk) return [];
  const N = nameMap(e);
  const recs = (e.state.records as Record<string, Record<string, Record<string, unknown>>>)[mk] ?? {};
  return Object.entries(recs).filter(([, r]) => r.status === "disputed").map(([empId, r]) => {
    const d = (r.dispute ?? {}) as Record<string, unknown>;
    return { empId, name: N[empId] ?? "", month: mk, text: d.text ?? null, at: d.at ?? null, pay: Number(e.zp.settlement(empId, mk).pay) || 0 };
  }).sort((a, b) => b.pay - a.pay);
}
export async function analyticsView(db: Db, mk: string, plan: boolean) {
  const e = await engine(db); const N = nameMap(e);
  const months = e.zp.analyticsMonths();
  const series = months.map((m: string) => { const s = e.zp.deptStats(m, m === e.zp.liveMonth ? plan : false); return { month: m, pct: s.all.pct, pay: s.all.pay, comp: s.comp }; });
  const cur = e.zp.deptStats(mk, mk === e.zp.liveMonth ? plan : false), prev = e.zp.deptStats(prevMonth(mk), false);
  const usePlan = mk === e.zp.liveMonth ? plan : false;
  const withNames = (xs: Array<Record<string, unknown>>): Array<Record<string, unknown>> => xs.map((x) => ({ ...x, people: (x.people as string[]).map((id) => {
    const po = e.zp.payOfMonth(id, mk, usePlan) as { pay: number; margin: number } | null;
    return { id, name: N[id], pay: po?.pay ?? null, margin: po?.margin ?? null };
  }).sort((a, b) => (b.pay ?? 0) - (a.pay ?? 0)) }));
  // частка ЗП / результат по кожному рядку за ті самі місяці, що й загальна лінія (тренд рядка)
  const rowSeries: { teams: Record<string, Array<{ month: string; pct: number | null }>>; depts: Record<string, Array<{ month: string; pct: number | null }>> } = { teams: {}, depts: {} };
  for (const m of months) {
    const st = e.zp.deptStats(m, m === e.zp.liveMonth ? plan : false);
    for (const t of st.teams as Array<{ k: string; pct: number | null }>) (rowSeries.teams[t.k] ??= []).push({ month: m, pct: t.pct });
    for (const t of st.depts as Array<{ k: string; pct: number | null }>) (rowSeries.depts[t.k] ??= []).push({ month: m, pct: t.pct });
  }
  const leads = Object.fromEntries((e.zp.employees as Array<Record<string, unknown>>).filter((p) => p.role === "lead" && p.leadsTeam).map((p) => [p.leadsTeam as string, N[p.id as string] ?? ""]));
  return { ...cur, teams: withNames(cur.teams).map((t) => ({ ...t, lead: leads[t.k as string] ?? null })), depts: withNames(cur.depts),
    prev: { all: prev.all, teams: prev.teams.map((t: Record<string, unknown>) => ({ k: t.k, pct: t.pct })), depts: prev.depts.map((t: Record<string, unknown>) => ({ k: t.k, pct: t.pct })) }, series, rowSeries };
}
export async function archiveView(db: Db, uid: number | null) {
  const e = await engine(db); const N = nameMap(e);
  const rows = (await db.query<{ user_id: number; mk: string; level: string | null; margin: string; fund: string; source: string }>(
    `SELECT user_id, to_char(month, 'YYYY-MM') AS mk, level, margin, fund, source FROM payroll_archive WHERE ($1::int IS NULL OR user_id = $1)
     UNION ALL
     SELECT r.user_id, to_char(r.month, 'YYYY-MM'), NULL, COALESCE((r.paid_snapshot->>'margin')::numeric, 0), (r.paid_snapshot->>'total')::numeric, 'paid'
       FROM payroll_records r WHERE r.status = 'paid' AND ($1::int IS NULL OR r.user_id = $1) ORDER BY 2, 1`, [uid])).rows;
  return rows.map((r) => ({ userId: String(r.user_id), name: N[String(r.user_id)] ?? `#${r.user_id}`, month: r.mk, level: r.level, margin: Number(r.margin), fund: Number(r.fund), source: r.source }));
}
/** Імпорт старого Excel: колонки «ПІБ» (або «id»), «Місяць» (РРРР-ММ), «Рівень», «Маржа», «Нараховано». */
export async function importArchive(pool: Pool, v: Viewer, fileBase64: unknown) {
  const { parseXlsx } = await import("../core/officeParse.js");
  const buf = Buffer.from(String(fileBase64 ?? "").replace(/^data:.*?;base64,/, ""), "base64");
  if (!buf.length) fail(422, "Додайте файл Excel.", "file");
  let sheets; try { sheets = parseXlsx(buf); } catch { fail(422, "Файл не схожий на Excel (.xlsx).", "file"); }
  const rows = (sheets![0]?.rows ?? []) as unknown[][];
  if (rows.length < 2) fail(422, "У файлі немає рядків.", "file");
  const head = rows[0].map((h) => String(h ?? "").trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h.startsWith(n)));
  const ci = { id: col("id"), name: col("піб", "прізвище", "працівник"), month: col("місяць"), level: col("рівень"), margin: col("маржа"), fund: col("нараховано", "фонд", "зп") };
  if (ci.month < 0 || ci.fund < 0 || (ci.id < 0 && ci.name < 0)) fail(422, "Потрібні колонки: «ПІБ» (або «id»), «Місяць», «Нараховано»; необовʼязкові — «Рівень», «Маржа».", "file");
  const e = await engine(pool, { fresh: true });
  const byName = new Map((e.zp.employees as Array<{ id: string; name: string }>).map((p) => [p.name.trim().toLowerCase(), p.id]));
  let ok = 0; const errors: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const ln = i + 1;
    const uid = ci.id >= 0 && r[ci.id] ? String(Math.round(Number(r[ci.id]))) : byName.get(String(r[ci.name] ?? "").trim().toLowerCase());
    if (!uid || !e.zp.person(uid)) { errors.push(`рядок ${ln}: людину не знайдено в зарплаті`); continue; }
    const mkRaw = r[ci.month]; const mk = typeof mkRaw === "number" ? new Date(Math.round((mkRaw - 25569) * 864e5)).toISOString().slice(0, 7) : String(mkRaw ?? "").trim().slice(0, 7).replace(/^(\d{2})\.(\d{4})$/, "$2-$1");
    if (!MONTH.test(mk)) { errors.push(`рядок ${ln}: місяць «${mkRaw}» — потрібно РРРР-ММ`); continue; }
    const fund = money(r[ci.fund]); if (!Number.isFinite(fund)) { errors.push(`рядок ${ln}: «Нараховано» не число`); continue; }
    const lvRaw = ci.level >= 0 ? String(r[ci.level] ?? "").toLowerCase() : ""; const level = lvRaw.includes("проф") || lvRaw.includes("prof") ? "profi" : lvRaw.includes("старт") || lvRaw.includes("start") ? "start" : null;
    const margin = ci.margin >= 0 ? money(r[ci.margin]) || 0 : 0;
    await pool.query(`INSERT INTO payroll_archive (user_id, month, level, margin, fund, imported_by) VALUES ($1,$2::date,$3,$4,$5,$6)
                      ON CONFLICT (user_id, month) DO UPDATE SET level = EXCLUDED.level, margin = EXCLUDED.margin, fund = EXCLUDED.fund, imported_at = now(), imported_by = EXCLUDED.imported_by`,
      [Number(uid), monthStart(mk), level, margin, fund, v.userId]);
    ok++;
  }
  await history(pool, v.userId, null, `Архів: імпорт Excel — ${ok} рядків`, errors.length ? `помилок: ${errors.length}` : null);
  invalidate();
  return { imported: ok, errors };
}

// ===================================================================== налаштування, люди
export async function settingsView(db: Db, mk: string) {
  const versions = (await db.query<{ id: string; mk: string; settings: Record<string, unknown>; reason: string; changed_at: Date; by: string | null }>(
    `SELECT v.id::text, to_char(v.valid_from, 'YYYY-MM') AS mk, v.settings, v.reason, v.changed_at, (SELECT ${NAME_SQL} FROM users u ${NAME_JOIN} WHERE u.id = v.changed_by) AS by
       FROM payroll_settings_versions v ORDER BY v.valid_from DESC`)).rows;
  const cur = versions.find((x) => x.mk <= mk);
  const merged = mergeDeep(DEFAULT_SETTINGS, cur?.settings ?? {});
  return { month: mk, settings: merged, defaults: DEFAULT_SETTINGS, versions: versions.map((x) => ({ id: Number(x.id), validFrom: x.mk, reason: x.reason, at: x.changed_at.toISOString(), by: x.by, settings: x.settings })),
    departments: (await db.query(`SELECT code, name, is_sales AS "isSales" FROM payroll_departments ORDER BY is_sales DESC, name`)).rows,
    teams: (await db.query(`SELECT p.code, p.name, p.dept_code AS "dept", p.offer_code AS "offer", p.kommo_team_id AS "kommoTeamId" FROM payroll_teams p ORDER BY p.name`)).rows };
}
function mergeDeep(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...a };
  for (const k of Object.keys(b ?? {})) o[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object" ? mergeDeep(a[k] as Record<string, unknown>, b[k] as Record<string, unknown>) : b[k];
  return o;
}
export async function saveSettings(pool: Pool, v: Viewer, body: Record<string, unknown>) {
  const e = await engine(pool);
  const validFrom = checkMonth(body.validFrom);
  if (validFrom <= e.zp.liveMonth) fail(422, `Нова версія — лише з 1-го наступного місяця (${nextMonth(e.zp.liveMonth)}) або пізніше.`, "validFrom");
  const reason = String(body.reason ?? "").trim(); if (reason.length < 3) fail(422, "Вкажіть причину зміни.", "reason");
  const s = body.settings; if (!s || typeof s !== "object" || Array.isArray(s)) fail(422, "Налаштування — обʼєкт.", "settings");
  const st = s as Record<string, unknown>;
  if (st.payMode && !["success", "paid", "overdue"].includes(String(st.payMode))) fail(422, "«Коли маржа йде в ЗП» — success / paid / overdue.", "payMode");
  await pool.query(`INSERT INTO payroll_settings_versions (valid_from, settings, reason, changed_by) VALUES ($1::date, $2, $3, $4)
                    ON CONFLICT (valid_from) DO UPDATE SET settings = EXCLUDED.settings, reason = EXCLUDED.reason, changed_by = EXCLUDED.changed_by, changed_at = now()`,
    [monthStart(validFrom), JSON.stringify(st), reason, v.userId]);
  await history(pool, v.userId, null, `Налаштування з ${validFrom}`, reason);
  invalidate();
  return { ok: true };
}
function offerDocOf(e: Engine, empId: string) {
  const t = (e.state.tasks as Array<Record<string, unknown>>).filter((x) => x.empId === empId && !x.voidAt).pop();
  return t ? { id: t.id, title: t.title, level: t.level, from: t.from, signedAt: t.signedAt ?? null, due: t.due ?? null } : null;
}
export async function employeesView(db: Db) {
  const e = await engine(db); const live = e.zp.liveMonth;
  const people = (e.zp.employees as Array<Record<string, unknown>>).map((p) => ({ userId: p.id, name: p.name, title: p.title, role: p.role, dept: p.dept, team: p.team, leadsTeam: p.leadsTeam,
    offer: e.zp.offerCode(p), level: e.zp.levelOf(p, live), levelChange: e.zp.levelChangeAfter(p, live), rate: e.zp.rateOf(p, live), pctRule: e.zp.pctRuleOf(p, live),
    official: e.zp.officialOf(p, live), startDate: p.startDate, birthday: p.birthday, isFinance: p.isFinance, leave: p.leave, simple: e.zp.isSimple(p), terms: p.terms,
    // останній чинний документ оферу: підписано / чекає підпису (анульовані — не показуємо)
    offerDoc: offerDocOf(e, p.id as string) }));
  const candidates = (await db.query<{ id: number; name: string; role: string; hired_at: string | null; birth: string | null; position: string | null; team_id: number | null; level: string | null }>(
    `SELECT u.id, ${NAME_SQL} AS name, COALESCE(u.role_override, u.role) AS role, to_char(e.hired_at, 'YYYY-MM-DD') AS hired_at, to_char(e.birth_date, 'MM-DD') AS birth, e.position, m.team_id,
            (SELECT el.level FROM employee_levels el WHERE el.employee_id = e.id ORDER BY el.from_month DESC LIMIT 1) AS level
       FROM users u ${NAME_JOIN} LEFT JOIN LATERAL (SELECT * FROM employees x WHERE x.user_id = u.id ORDER BY x.id DESC LIMIT 1) e ON true
      WHERE u.is_active AND COALESCE(u.role_override, u.role) <> 'candidate' AND NOT EXISTS (SELECT 1 FROM payroll_employees pe WHERE pe.user_id = u.id)
      ORDER BY 2`)).rows;
  const teams = (await db.query<{ code: string; kommo_team_id: number | null }>(`SELECT code, kommo_team_id FROM payroll_teams`)).rows;
  return { month: live, people, candidates: candidates.map((c) => ({ userId: String(c.id), name: c.name, roleKey: c.role, startDate: c.hired_at, birthday: c.birth,
    title: c.position, team: teams.find((t) => t.kommo_team_id === c.team_id)?.code ?? null, level: c.level === "pro" ? "profi" : c.level === "start" ? "start" : null,
    role: c.role === "team_lead" ? "lead" : c.role === "manager" ? "manager" : "staff" })) };
}
export async function addEmployee(pool: Pool, v: Viewer, body: Record<string, unknown>) {
  const uid = Number(body.userId); if (!Number.isInteger(uid)) fail(422, "Оберіть людину.", "userId");
  const role = String(body.role); if (!["manager", "lead", "staff"].includes(role)) fail(422, "Як платимо: менеджер / тім-лід / ставка.", "role");
  const start = String(body.startDate ?? ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) fail(422, "Дата виходу — РРРР-ММ-ДД.", "startDate");
  const bday = body.birthday ? String(body.birthday) : null; if (bday && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(bday)) fail(422, "День народження — ММ-ДД.", "birthday");
  const e = await engine(pool);
  await tx(pool, async (c) => {
    await c.query(`INSERT INTO payroll_employees (user_id, role, title, dept_code, team_code, leads_team_code, offer_code, start_date, birthday_md, is_finance)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10)`,
      [uid, role, String(body.title ?? "").trim() || "—", String(body.dept ?? "sales"), body.team ? String(body.team) : null, role === "lead" ? String(body.leadsTeam ?? body.team ?? "") || null : null,
        body.offer ? String(body.offer) : null, start, bday, !!body.isFinance]).catch((err: { code?: string; message: string }) => {
        if (err.code === "23505") fail(409, err.message.includes("one_lead") ? "У цієї команди вже є тім-лід." : "Людина вже в зарплаті.");
        if (err.code === "23514" || err.code === "23503") fail(422, "Перевірте відділ і команду: менеджеру потрібна команда, тім-ліду — команда, яку веде.");
        throw err;
      });
    const from = String(body.from ?? e.zp.liveMonth);
    const level = role === "manager" ? (body.level === "profi" ? "profi" : "start") : null;
    const rate = body.rate != null && body.rate !== "" ? money(body.rate) : null;
    const pct = body.pct && typeof body.pct === "object" ? body.pct as Record<string, unknown> : null;
    if (level || rate != null || pct) await c.query(`INSERT INTO payroll_terms (user_id, valid_from, level, rate, pct_base, pct_value, reason, changed_by) VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8)`,
      [uid, monthStart(checkMonth(from)), level, rate, pct ? "company" : null, pct ? Number(pct.value) : null, "умови при додаванні в зарплату", v.userId]);
    if (body.official && typeof body.official === "object") {
      const o = body.official as Record<string, unknown>;
      if (money(o.amount) > 0) await c.query(`INSERT INTO payroll_official (user_id, valid_from, amount, deduct, changed_by) VALUES ($1,$2::date,$3,$4,$5)`, [uid, monthStart(checkMonth(from)), money(o.amount), !!o.deduct, v.userId]);
    }
    await history(c, v.userId, uid, "Додано в зарплату", `${role}; вихід ${start}`);
  });
  await after(pool);
  return { ok: true };
}
export async function updateEmployee(pool: Pool, v: Viewer, uid: number, body: Record<string, unknown>) {
  const id = String(uid); let task: Record<string, unknown> | null = null;
  const reason = String(body.reason ?? "").trim(); if (reason.length < 3) fail(422, "Вкажіть причину зміни.", "reason");
  await tx(pool, async (c) => {
    const e = await engine(c, { fresh: true }); const p = e.zp.person(id); if (!p) fail(404, "Людини немає в зарплаті.");
    const fromMk = body.from === "next" ? nextMonth(e.zp.liveMonth) : e.zp.liveMonth;
    // профіль (без дат «з місяця»)
    const prof: Array<[string, unknown]> = [];
    for (const [k, col] of [["title", "title"], ["dept", "dept_code"], ["team", "team_code"], ["leadsTeam", "leads_team_code"], ["offer", "offer_code"], ["startDate", "start_date"], ["birthday", "birthday_md"], ["isFinance", "is_finance"], ["role", "role"]] as const)
      if (k in body) prof.push([col, body[k] === "" ? null : body[k]]);
    if (prof.length) {
      await c.query(`UPDATE payroll_employees SET ${prof.map(([col], i) => `${col} = $${i + 2}`).join(", ")} WHERE user_id = $1`, [uid, ...prof.map(([, val]) => val)]).catch((err: { code?: string }) => {
        if (err.code === "23505") fail(409, "У цієї команди вже є тім-лід."); if (err.code === "23514" || err.code === "23503" || err.code === "22007") fail(422, "Перевірте поля: відділ, команду, дати."); throw err; });
      await history(c, v.userId, uid, `Профіль: ${prof.map(([col]) => col).join(", ")}`, reason);
    }
    const lvl = body.level === "start" || body.level === "profi" ? body.level as "start" | "profi" : null;
    const rate = "rate" in body && body.rate !== null && body.rate !== "" ? money(body.rate) : null;
    const pctIn = "pct" in body ? body.pct : undefined;
    if (lvl || rate != null || pctIn !== undefined) {
      if (rate != null && !(rate >= 0)) fail(422, "Ставка — не менше нуля.", "rate");
      const pct = pctIn && typeof pctIn === "object" ? Number((pctIn as Record<string, unknown>).value) : null;
      if (pct != null && !(pct > 0 && pct <= 100)) fail(422, "Відсоток — від 0 до 100.", "pct");
      await c.query(`INSERT INTO payroll_terms (user_id, valid_from, level, rate, pct_base, pct_value, pct_clear, reason, changed_by) VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9)`,
        [uid, monthStart(fromMk), lvl, rate, pct != null ? "company" : null, pct, pctIn === null, reason, v.userId]);
      await history(c, v.userId, uid, `Умови з ${fromMk}:${lvl ? ` рівень ${lvl === "profi" ? "«Профі»" : "«Старт»"}` : ""}${rate != null ? ` ставка ${rate}` : ""}${pct != null ? ` ${pct} % маржі компанії` : pctIn === null ? " без відсотка" : ""}`, reason);
      if (lvl && p.role === "manager" && e.zp.offerCode(p) === "std" && lvl !== e.zp.levelOf(p, fromMk)) {
        await c.query(`UPDATE payroll_offer_docs SET void_at = now() WHERE user_id = $1 AND signed_at IS NULL AND void_at IS NULL`, [uid]);
        const d = await c.query<{ id: string }>(`INSERT INTO payroll_offer_docs (user_id, offer_title, level, valid_from, why) VALUES ($1,$2,$3,$4::date,'рішення керівництва') RETURNING id::text`, [uid, OFFER_TITLES[lvl], lvl, monthStart(fromMk)]);
        task = { id: Number(d.rows[0].id), level: lvl, from: monthStart(fromMk), due: `${fromMk}-05`, why: "рішення керівництва", created: kyivNow() };
      }
    }
    if (body.official && typeof body.official === "object") {
      const o = body.official as Record<string, unknown>; const amount = money(o.amount);
      if (!(amount >= 0)) fail(422, "Офіційна ЗП — не менше нуля (0 — більше немає).", "official");
      await c.query(`INSERT INTO payroll_official (user_id, valid_from, amount, deduct, note, changed_by) VALUES ($1,$2::date,$3,$4,$5,$6)`, [uid, monthStart(fromMk), amount, !!o.deduct, reason, v.userId]);
      await history(c, v.userId, uid, `Офіційна ЗП з ${fromMk}: ${amount} (${o.deduct ? "вираховується" : "окремо"})`, reason);
    }
  });
  await after(pool, task ? (e) => e.nt.build.offerTask(id, task) : undefined);
  return { ok: true };
}
export async function saveDepartment(pool: Pool, v: Viewer, body: Record<string, unknown>) {
  const code = String(body.code ?? "").trim(); if (!/^[a-z0-9_]{1,30}$/.test(code)) fail(422, "Код — латиниця, цифри, _.", "code");
  const name = String(body.name ?? "").trim(); if (!name) fail(422, "Назва відділу.", "name");
  await pool.query(`INSERT INTO payroll_departments (code, name, is_sales) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_sales = EXCLUDED.is_sales`, [code, name, !!body.isSales]);
  await history(pool, v.userId, null, `Відділ «${name}»: ${body.isSales ? "продає" : "не продає (простий кабінет)"}`);
  invalidate(); return { ok: true };
}
export async function saveTeam(pool: Pool, v: Viewer, body: Record<string, unknown>) {
  const code = String(body.code ?? "").trim(); if (!/^[a-z0-9_]{1,30}$/.test(code)) fail(422, "Код — латиниця, цифри, _.", "code");
  const offer = String(body.offer ?? "std"); if (!["std", "ls"].includes(offer)) fail(422, "Офер — std або ls.", "offer");
  await pool.query(`INSERT INTO payroll_teams (code, name, dept_code, offer_code, kommo_team_id) VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, dept_code = EXCLUDED.dept_code, offer_code = EXCLUDED.offer_code, kommo_team_id = EXCLUDED.kommo_team_id`,
    [code, String(body.name ?? code), String(body.dept ?? "sales"), offer, body.kommoTeamId ? Number(body.kommoTeamId) : null]).catch(() => fail(422, "Перевірте відділ команди."));
  await history(pool, v.userId, null, `Команда «${body.name ?? code}»: офер ${offer}`);
  invalidate(); return { ok: true };
}
export async function offerTasks(db: Db) {
  const e = await engine(db); const N = nameMap(e);
  return (e.state.tasks as Array<Record<string, unknown>>).filter((t) => !t.voidAt).map((t) => ({ ...t, name: N[t.empId as string] ?? "" }));
}
export async function offerTaskDone(pool: Pool, v: Viewer, id: number) {
  const r = (await pool.query<{ user_id: number; level: string; from: string }>(`UPDATE payroll_offer_docs SET signed_at = now(), signed_by = $2 WHERE id = $1 AND signed_at IS NULL AND void_at IS NULL RETURNING user_id, level, to_char(valid_from, 'YYYY-MM-DD') AS from`, [id, v.userId])).rows[0];
  if (!r) fail(409, "Задачу вже закрито.");
  await history(pool, v.userId, r.user_id, "Новий офер підписано", null, { offer: id });
  await after(pool, (e) => e.nt.build.offerSigned(String(r.user_id), { level: r.level, from: r.from }, kyivNow()));
  return { ok: true };
}

// ===================================================================== фонові задачі
/** Закриття місяця (ТЗ §5.6): records 'review' зі знімком, утримання ТТН, автоперехід «Профі», сповіщення. Idempotent. */
export async function closeMonth(pool: Pool, mk: string): Promise<{ closed: boolean; records: number }> {
  let created = 0, already = false; const now = kyivNow();
  const auto: Array<{ id: string; change: Record<string, unknown> }> = [];
  await tx(pool, async (c) => {
    const ex = (await c.query<{ status: string }>(`SELECT status FROM payroll_months WHERE month = $1::date FOR UPDATE`, [monthStart(mk)])).rows[0];
    if (ex?.status === "closed") { already = true; return; }
    await c.query(`INSERT INTO payroll_months (month, status, closed_at) VALUES ($1::date, 'closed', now()) ON CONFLICT (month) DO UPDATE SET status = 'closed', closed_at = now()`, [monthStart(mk)]);
    const e = await engine(c, { fresh: true, now });
    for (const p of e.zp.employees as Array<Record<string, unknown>>) {
      if (!e.zp.employedIn(p, mk)) continue;
      const cc = e.zp.calc(p, mk);
      const snap = { margin: cc.margin, plan: cc.plan, level: cc.level ?? null, now: cc.now, atPlan: cc.atPlan, kpi: cc.kpi ? { bonusNow: cc.kpi.bonusNow, conv: cc.kpi.conv, normDays: cc.kpi.normDays } : null };
      const r = await c.query(`INSERT INTO payroll_records (month, user_id, auto_snapshot) VALUES ($1::date, $2, $3) ON CONFLICT (month, user_id) DO NOTHING`, [monthStart(mk), Number(p.id), JSON.stringify(snap)]);
      created += r.rowCount ?? 0;
      const ap = e.zp.autoProfi(p, mk);
      if (ap) { await setLevel(c, Number(p.id), "profi", ap.from, `маржа понад поріг два місяці поспіль: ${Math.round(ap.m1)} і ${Math.round(ap.m2)}`, null, true); auto.push({ id: p.id as string, change: ap }); }
    }
    await history(c, null, null, `${mk} — місяць закрито`, `записів: ${created}`);
  });
  if (already) return { closed: false, records: 0 };
  await after(pool, (e) => {
    const out: EngineNotification[] = [...e.nt.build.monthClosed(mk, now)];
    for (const p of e.zp.employees as Array<Record<string, unknown>>) if (p.role === "manager" && e.zp.record(p.id, mk) && e.zp.ttnLines(p, mk).some((l: { kind: string }) => l.kind === "hold")) out.push(...e.nt.build.ttnHold(p.id as string, mk, now));
    for (const a of auto) out.push(...e.nt.build.levelAuto(a.id, now, a.change));
    return out;
  });
  return { closed: true, records: created };
}
/** Кожні 15 хв: коли вперше зʼявилась ТТН по угоді «Успішно реалізовано»; утримання, що закрилось, — сповіщення ttn.fix. */
export async function ttnTick(pool: Pool): Promise<number> {
  const ins = await pool.query(`INSERT INTO payroll_ttn_seen (deal_id)
      SELECT d.kommo_id FROM deals d WHERE d.status_id = 142 AND d.ttn_files > 0 AND d.closed_at_kommo > now() - interval '180 days'
      ON CONFLICT (deal_id) DO NOTHING`);
  if (!ins.rowCount) return 0;
  const open = (await pool.query<{ subject_user: number; mk: string }>(
    `SELECT n.subject_user, n.done_rule->>'month' AS mk FROM notifications n WHERE n.type = 'ttn.hold' AND n.act AND n.done_at IS NULL`)).rows;
  invalidate();
  const e = await engine(pool, { fresh: true });
  const fixed = open.filter((o) => e.zp.person(String(o.subject_user)) && e.zp.ttnOk(e.zp.ttnStats(String(o.subject_user), o.mk)));
  if (fixed.length) await after(pool, (e) => fixed.flatMap((o) => { const r = e.zp.record(String(o.subject_user), o.mk); return e.nt.build.ttnFixed(String(o.subject_user), o.mk, kyivNow(), !!(r && r.status === "paid")); }));
  return ins.rowCount ?? 0;
}
/** 1-го о 08:00: дні народження місяця — іменинникам і фінансистам. */
export async function birthdaysTick(pool: Pool, mk: string) {
  const sent = await pool.query(`SELECT 1 FROM notifications WHERE type = 'bday' AND created_at >= $1::date AND created_at < ($1::date + interval '1 month') LIMIT 1`, [monthStart(mk)]);
  if (sent.rowCount) return 0;
  const e = await engine(pool, { fresh: true });
  const list = e.nt.build.birthdays(mk, kyivNow());
  await emitAll(pool, list);
  return list.length;
}
export const _forTests = { lastDay, statementRows, COLS };
