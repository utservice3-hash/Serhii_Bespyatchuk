/**
 * 🏁 «РЕЗУЛЬТАТ МІСЯЦЯ» (задача Тетяни #5583, зустріч 21.10.2026; Роман 23.10: «давай робити прохід»).
 *
 * Що рахує Тетяна (аркуш «Результати комер.відділу», вкладка за місяць) — заміряно на вересні 2026, 25 із 33 менеджерів
 * до гривні: **кількість успішних угод** і **результат = Σ «Бюджет» Kommo** (маржа з калькулятора угоди) по угодах
 * «Повного циклу», закритих у місяці як «Успішна» (142). Мінусові входять (зменшують результат) і показуються окремо.
 *
 * Що додає екран до її таблиці:
 *  · угода рахується тому, хто був відповідальним У МОМЕНТ ЗАКРИТТЯ (`closerAt` над `deal_responsible_events`), а не
 *    тому, на кому висить зараз (вересень: 19 угод Янчевського перепризначили на Михальчевську після закриття);
 *  · перевірки — що варто глянути Тетяні (`checksOf`): немає рахунку, немає приходу, готівковий розхід без запиту чи
 *    оплачено перевізнику більше за план, валюта; угоди «на перевірці» в результаті ЛИШАЮТЬСЯ (як у її таблиці), але
 *    видно окремим числом — рішення за нею;
 *  · її ручні рішення по угоді (`fin_month_result_overrides`): не рахувати / в інший місяць / свій профіт — з приміткою.
 * Звірка з 1С (рахунок і фактичний розхід) — наступний прохід, коли буде сервіс 1С.
 */
import { FinError, type Db } from "./finance.js";

export const FULL_CYCLE_PIPELINES = [8921932, 155304] as const;

/** Місяці нічного проходу `syncDealResponsible`: поточний і минулий за Києвом (YYYY-MM-01; анкер на 1-ше — без переповнення дня). */
export function monthsToCheck(now: Date): string[] {
  const ym = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
  const d = new Date(`${ym}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  return [d.toISOString().slice(0, 7) + "-01", `${ym}-01`];
}
const CASH = /налич|готів/i;
const FX = /валют/i;

/** Подія зміни відповідального угоди. */
export interface RespEvent { at: number; from: number | null; to: number | null }
/**
 * Хто був відповідальним у мить закриття: найраніша зміна ПІСЛЯ закриття каже, з кого забрали (`from`); змін після
 * закриття немає — той, хто зараз. `from` невідомий — теж той, хто зараз (не вгадуємо).
 */
export function closerAt(current: number | null, closedAtMs: number, events: readonly RespEvent[]): number | null {
  const after = events.filter((e) => e.at > closedAtMs).sort((a, b) => a.at - b.at)[0];
  return after?.from ?? current;
}

export interface CheckInput {
  price: number; isMinus: boolean; paymentType: string | null;
  orderNo: string | null; paid1c: boolean; bankPaid: boolean;
  cashExpense: number | null; requestsPaid: number; requestsOpen: number;
}
/** Що варто перевірити Тетяні (слова — для екрана). Мінусова — окремим списком, не «перевірка». */
export function checksOf(x: CheckInput): string[] {
  const out: string[] = [];
  const cashIn = CASH.test(x.paymentType ?? ""), fx = FX.test(x.paymentType ?? "");
  if (fx) out.push("валютна угода — перевірити суму в гривні");
  if (!cashIn) {
    if (!x.orderNo) out.push("немає рахунку («Номер заказа» порожній)");
    if (!x.paid1c && !x.bankPaid) out.push("немає фактичного приходу (ні галочки «Оплачено из 1с», ні платежу у «Виписці»)");
  }
  if (x.cashExpense != null && x.cashExpense > 0) {
    if (x.requestsPaid > x.cashExpense + 1) out.push(`оплачено перевізнику більше за план: ${fmt(x.requestsPaid)} проти ${fmt(x.cashExpense)}`);
    else if (x.requestsPaid + x.requestsOpen === 0) out.push(`готівковий розхід ${fmt(x.cashExpense)}, а запиту на оплату немає`);
  }
  return out;
}
const fmt = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ");

export type OverrideAction = "exclude" | "move" | "profit";
export interface Override { kommoId: number; action: OverrideAction; targetMonth: string | null; profit: number | null; note: string; setBy: string | null; setAt: string }

export interface MRDeal {
  id: number; name: string; client: string | null; closedAt: string; closedMonth: string; price: number; isMinus: boolean; paymentType: string | null;
  closer: number | null; current: number | null; reassigned: boolean;
  checks: string[]; override: Override | null; included: boolean; profit: number;
}
/** Угода в цьому місяці після рішень Тетяни: перенесена ЗВІДСИ — немає, перенесена СЮДИ — є; «не рахувати» — є, але не входить. */
export function placeInMonth(d: Pick<MRDeal, "closedMonth" | "price">, ov: Override | null, month: string): { inMonth: boolean; included: boolean; profit: number } {
  const target = ov?.action === "move" ? ov.targetMonth! : d.closedMonth;
  const inMonth = target === month;
  return { inMonth, included: inMonth && ov?.action !== "exclude", profit: ov?.action === "profit" ? ov.profit! : d.price };
}

export interface MRManager { kommoUserId: number | null; name: string; active: boolean; deals: number; result: number; review: { n: number; sum: number }; minus: { n: number; sum: number }; overrides: number }
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Зведення по тих, хто закривав: кількість і результат — лише враховані угоди; перевірки й мінусові — серед врахованих. */
export function summarize(deals: readonly MRDeal[], names: ReadonlyMap<number, { name: string; active: boolean }>): MRManager[] {
  const by = new Map<string, MRManager>();
  for (const d of deals) {
    const key = String(d.closer ?? "—");
    const m = by.get(key) ?? { kommoUserId: d.closer, name: d.closer != null ? names.get(d.closer)?.name ?? `ID ${d.closer}` : "відповідальний невідомий",
      active: d.closer != null ? names.get(d.closer)?.active ?? false : false, deals: 0, result: 0, review: { n: 0, sum: 0 }, minus: { n: 0, sum: 0 }, overrides: 0 };
    if (d.override) m.overrides++;
    if (d.included) {
      m.deals++; m.result = r2(m.result + d.profit);
      if (d.checks.length) { m.review.n++; m.review.sum = r2(m.review.sum + d.profit); }
      if (d.isMinus || d.profit < 0) { m.minus.n++; m.minus.sum = r2(m.minus.sum + d.profit); }
    }
    by.set(key, m);
  }
  return [...by.values()].sort((a, b) => b.result - a.result);
}

export interface MonthResult {
  month: string; computedAt: string; kommoBase: string; eventsSince: string | null;
  managers: MRManager[]; deals: MRDeal[];
  totals: { deals: number; result: number; review: { n: number; sum: number }; minus: { n: number; sum: number } };
}

/** Kommo-поля угоди, потрібні перевіркам (читаються наживо — у базі їх немає). */
export interface LiveFields { orderNo: string | null; paid1c: boolean; income: number | null; cashExpense: number | null }

/** Результат місяця з бази + живих полів Kommo (`live`) + платежів «Виписки» (`bankPaid`). */
export async function loadMonthResult(db: Db, month: string, deps: {
  live: (ids: number[]) => Promise<Map<number, LiveFields>>;
  bankPaid: (deals: { id: number; orderNo: string | null; income: number | null; client: string | null }[]) => Promise<Set<number>>;
  kommoBase: string; now?: Date;
}): Promise<MonthResult> {
  const m = `${month.slice(0, 7)}-01`;
  const ov = new Map(((await db.query(`SELECT o.kommo_id::text AS id, o.action, o.target_month::text AS tm, o.profit::text AS profit, o.note, o.set_at,
      COALESCE(NULLIF(btrim(u.full_name), ''), mm.name, u.email) AS by FROM fin_month_result_overrides o LEFT JOIN users u ON u.id = o.set_by LEFT JOIN managers mm ON mm.id = u.manager_id`)).rows as any[])
    .map((x) => [Number(x.id), { kommoId: Number(x.id), action: x.action, targetMonth: x.tm, profit: x.profit == null ? null : Number(x.profit), note: x.note, setBy: x.by ?? null, setAt: new Date(x.set_at).toISOString() } as Override]));
  const movedIn = [...ov.values()].filter((o) => o.action === "move" && o.targetMonth === m).map((o) => o.kommoId);
  const rows = (await db.query(`SELECT d.kommo_id::text AS id, d.name, d.client_name, d.price::float8 AS price, d.is_minus, d.payment_type, d.closed_at_kommo AS closed,
        to_char(date_trunc('month', d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv'), 'YYYY-MM-DD') AS cm, mg.kommo_user_id::text AS cur
      FROM deals d LEFT JOIN managers mg ON mg.id = d.manager_id
     WHERE d.status_id = 142 AND d.pipeline_id = ANY($3) AND d.closed_at_kommo IS NOT NULL
       AND ((d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND ($1::date + interval '1 month' - interval '1 day')::date OR d.kommo_id = ANY($2))`,
  [m, movedIn, [...FULL_CYCLE_PIPELINES]])).rows as any[];
  const ids = rows.map((x) => Number(x.id));
  const ev = new Map<number, RespEvent[]>();
  for (const e of (await db.query(`SELECT kommo_id::text AS id, changed_at, from_user_id::text AS f, to_user_id::text AS t FROM deal_responsible_events WHERE kommo_id = ANY($1)`, [ids])).rows as any[])
    ev.set(Number(e.id), [...(ev.get(Number(e.id)) ?? []), { at: new Date(e.changed_at).getTime(), from: e.f == null ? null : Number(e.f), to: e.t == null ? null : Number(e.t) }]);
  const req = new Map<number, { paid: number; open: number }>();
  for (const x of (await db.query(`SELECT source_deal_id::text AS id, COALESCE(sum(carrier_pay_amount) FILTER (WHERE status_id = 142), 0)::float8 AS paid,
        COALESCE(sum(carrier_pay_amount) FILTER (WHERE status_id NOT IN (142, 143)), 0)::float8 AS open
      FROM deals WHERE pipeline_id = 7341740 AND source_deal_id = ANY($1) AND carrier_pay_type ILIKE 'готів%' GROUP BY 1`, [ids])).rows as any[])
    req.set(Number(x.id), { paid: Number(x.paid), open: Number(x.open) });
  const live = ids.length ? await deps.live(ids) : new Map<number, LiveFields>();
  const paidBank = await deps.bankPaid(rows.map((x) => ({ id: Number(x.id), orderNo: live.get(Number(x.id))?.orderNo ?? null, income: live.get(Number(x.id))?.income ?? null, client: x.client_name })));
  const names = new Map(((await db.query(`SELECT DISTINCT ON (kommo_user_id) kommo_user_id::text AS id, name, is_active FROM managers WHERE kommo_user_id IS NOT NULL ORDER BY kommo_user_id, is_active DESC, id`)).rows as any[])
    .map((x) => [Number(x.id), { name: String(x.name).trim(), active: !!x.is_active }]));
  const deals: MRDeal[] = [];
  for (const x of rows) {
    const id = Number(x.id), o = ov.get(id) ?? null, cur = x.cur == null ? null : Number(x.cur);
    const closer = closerAt(cur, new Date(x.closed).getTime(), ev.get(id) ?? []);
    const p = placeInMonth({ closedMonth: x.cm, price: Number(x.price ?? 0) }, o, m);
    if (!p.inMonth) continue;
    const lf = live.get(id), rq = req.get(id) ?? { paid: 0, open: 0 };
    deals.push({ id, name: x.name ?? "", client: x.client_name, closedAt: new Date(x.closed).toISOString(), closedMonth: x.cm, price: Number(x.price ?? 0), isMinus: !!x.is_minus,
      paymentType: x.payment_type, closer, current: cur, reassigned: closer !== cur,
      checks: checksOf({ price: Number(x.price ?? 0), isMinus: !!x.is_minus, paymentType: x.payment_type, orderNo: lf?.orderNo ?? null, paid1c: lf?.paid1c ?? false,
        bankPaid: paidBank.has(id), cashExpense: lf?.cashExpense ?? null, requestsPaid: rq.paid, requestsOpen: rq.open }),
      override: o, included: p.included, profit: p.profit });
  }
  deals.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
  const managers = summarize(deals, names);
  const sum = (f: (x: MRManager) => number) => r2(managers.reduce((s, x) => s + f(x), 0));
  const wm = (await db.query(`SELECT watermark FROM deal_responsible_state WHERE id = 1`)).rows[0]?.watermark;
  return { month: m, computedAt: (deps.now ?? new Date()).toISOString(), kommoBase: deps.kommoBase, eventsSince: wm ? new Date(wm).toISOString() : null, managers, deals,
    totals: { deals: sum((x) => x.deals), result: sum((x) => x.result), review: { n: sum((x) => x.review.n), sum: sum((x) => x.review.sum) }, minus: { n: sum((x) => x.minus.n), sum: sum((x) => x.minus.sum) } } };
}

/** Рішення Тетяни по угоді: не рахувати / в інший місяць / свій профіт — примітка обовʼязкова; `action = null` — «Повернути». */
export async function setOverride(db: Db, actor: number, body: any): Promise<{ ok: true; months: string[] }> {
  const id = Number(body?.kommoId);
  if (!Number.isInteger(id) || id <= 0) throw new FinError(400, "Некоректна угода");
  const prev = (await db.query(`SELECT action, target_month::text AS tm FROM fin_month_result_overrides WHERE kommo_id = $1`, [id])).rows[0];
  const d = (await db.query(`SELECT to_char(date_trunc('month', closed_at_kommo AT TIME ZONE 'Europe/Kyiv'), 'YYYY-MM-DD') AS cm FROM deals
     WHERE kommo_id = $1 AND status_id = 142 AND pipeline_id = ANY($2)`, [id, [...FULL_CYCLE_PIPELINES]])).rows[0];
  if (!d) throw new FinError(404, "Угоду не знайдено серед успішних «Повного циклу»");
  const months = new Set<string>([d.cm, ...(prev?.tm ? [prev.tm] : [])]);
  if (body?.action == null) {
    await db.query(`DELETE FROM fin_month_result_overrides WHERE kommo_id = $1`, [id]);
    return { ok: true, months: [...months] };
  }
  const action = body.action as OverrideAction;
  if (!["exclude", "move", "profit"].includes(action)) throw new FinError(400, "Дія — не рахувати, інший місяць або свій профіт");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) throw new FinError(400, "Напишіть, чому — примітка обовʼязкова");
  let tm: string | null = null, profit: number | null = null;
  if (action === "move") {
    const t = typeof body.targetMonth === "string" && /^\d{4}-\d{2}/.test(body.targetMonth) ? `${body.targetMonth.slice(0, 7)}-01` : null;
    if (!t || t === d.cm) throw new FinError(400, "Вкажіть інший місяць, ніж місяць закриття");
    tm = t; months.add(t);
  }
  if (action === "profit") {
    const n = Number(String(body.profit ?? "").replace(/[\s ]/g, "").replace(",", "."));
    if (String(body.profit ?? "").trim() === "" || !Number.isFinite(n)) throw new FinError(400, "Профіт — число (мінус можна)");
    profit = Math.round(n * 100) / 100;
  }
  await db.query(`INSERT INTO fin_month_result_overrides (kommo_id, action, target_month, profit, note, set_by, set_at) VALUES ($1, $2, $3, $4, $5, $6, now())
    ON CONFLICT (kommo_id) DO UPDATE SET action = EXCLUDED.action, target_month = EXCLUDED.target_month, profit = EXCLUDED.profit, note = EXCLUDED.note,
      set_by = EXCLUDED.set_by, set_at = now()`, [id, action, tm, profit, note, actor]);
  return { ok: true, months: [...months] };
}
