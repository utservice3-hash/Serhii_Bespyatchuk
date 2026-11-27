/**
 * 💰 «Зарплата» — знімок `State` для рушія (ТЗ §10). Рушій нічого не читає сам: тут збираємо з наших таблиць `payroll_*`
 * і з ядра (угоди «Успішно реалізовано», плани, дзвінки, звернення, ТТН) і віддаємо `createPayroll(state)`.
 *
 * Звідки що (карта — ТЗ §3, звірено з кодом 04.11.2026):
 *  - угоди — `deals` у статусі 142 повного циклу (`FC_PIPELINES`), дата — `closed_at_kommo` за Києвом, маржа — `deals.price`,
 *    менеджер — `deals.manager_id` (так само, як ядро грошей `core/money.ts`); клієнт — `client_name`;
 *  - стан оплати клієнтом — `paid`, якщо 1С бачить оплату по угоді (`onec_deal_payments`), `over` — минула планова дата
 *    оплати (`planned_payment_at`) без оплати, інакше `wait`. ⚠️ Узгоджених днів по угоді в ядрі немає (лише по клієнту),
 *    тому «прострочено» = минула домовлена дата. За замовчуванням (`payMode: success`) на суми не впливає;
 *  - план — `plans` (metric `payment_amount`, перше число місяця) — затверджений план менеджера;
 *  - норма дзвінків — `callsByManagerDay` + `callNormCell` (дні з ≥ норми розмов і спроб, як колонка «Норма» звіту);
 *  - цільові звернення / цільові угоди — `rnkConvAsKommo` (target / won) — те саме, що «Номінації» й КВП;
 *  - ТТН — `payroll_ttn_seen` (коли ТТН вперше зʼявилась; пише джоба з `deals.ttn_files`).
 * Звʼязок людей: payroll_employees.user_id = users.id; угоди, плани й дзвінки — через users.manager_id.
 */
import type { Pool, PoolClient } from "pg";
import { FC_PIPELINES, STAGE_SUCCESS } from "../core/money.js";
import { prevMonth, lastDay } from "./engine/zarplata-engine.mjs";
import type { PayrollState } from "./engine/zarplata-engine.mjs";

type Db = Pool | PoolClient;
const KYIV = "AT TIME ZONE 'Europe/Kyiv'";

export const NAME_SQL = `COALESCE(m.name, e2.full_name, u.full_name, u.email)`;
export const NAME_JOIN = `LEFT JOIN managers m ON m.id = u.manager_id
  LEFT JOIN LATERAL (SELECT full_name FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1) e2 ON true`;

/** «Зараз» за Києвом: 'YYYY-MM-DDTHH:MM' */
export function kyivNow(d: Date = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}
/** Дата-час з БД → 'YYYY-MM-DDTHH:MM' за Києвом (порівнюється з `now` рушія) */
export const kyivIso = (d: Date | null | undefined): string | null => (d ? kyivNow(d) : null);
export const monthStart = (mk: string) => `${mk}-01`;

export interface Responsibles { ba: { id: string; name: string }; acc: { id: string; name: string }; hr: { id: string; name: string }; od: { id: string; name: string }; finance: string[] }

/** Хто відповідає за пункти обхідного листа й хто фінансисти — за ролями дашборда (ТЗ §10 `responsibles`). ОД — PAYROLL_OD_USER_ID або id 1. */
export async function loadResponsibles(db: Db): Promise<Responsibles> {
  const q = await db.query<{ id: number; key: string; name: string }>(
    `SELECT u.id, COALESCE(u.role_override, u.role) AS key, ${NAME_SQL} AS name
       FROM users u ${NAME_JOIN}
      WHERE u.is_active AND COALESCE(u.role_override, u.role) IN ('business_assistant', '____________', 'hr', 'financier', 'opdir')
      ORDER BY u.id`);
  // Поіменно (`payroll_responsibles`, Роман 27.11.2026: «бізнес асистент це даря протас») — сильніше за пошук за роллю.
  const named = new Map((await db.query<{ role_key: string; id: number; name: string }>(
    `SELECT r.role_key, u.id, ${NAME_SQL} AS name FROM payroll_responsibles r JOIN users u ON u.id = r.user_id ${NAME_JOIN} WHERE u.is_active`)).rows
    .map((r) => [r.role_key, { id: String(r.id), name: r.name }] as const));
  const ROLE_OF: Record<string, string> = { business_assistant: "ba", "____________": "acc", hr: "hr" };
  const first = (k: string, label: string) => {
    const n = named.get(ROLE_OF[k]); if (n) return n;
    const r = q.rows.find((x) => x.key === k); return r ? { id: String(r.id), name: r.name } : { id: "", name: label };
  };
  const odId = String(process.env.PAYROLL_OD_USER_ID || "1");
  const od = await db.query<{ name: string }>(`SELECT ${NAME_SQL} AS name FROM users u ${NAME_JOIN} WHERE u.id = $1`, [Number(odId)]);
  return {
    ba: first("business_assistant", "Бізнес-асистент"), acc: first("____________", "Бухгалтерія"), hr: first("hr", "HR"),
    od: { id: odId, name: od.rows[0]?.name ?? "ОД" },
    finance: q.rows.filter((x) => x.key === "financier").map((x) => String(x.id)),
  };
}

/** `norm` — норма дзвінків на день для «Зарплати»; не задано — загальна норма з «Планів» дашборда. */
export interface KpiSource { (from: string, to: string, managerIds: number[], today: string, norm?: number | null): Promise<Map<number, { normDays: number; leads: number; targetDeals: number; successCalls: number }>> }

/**
 * 📄 УМОВИ ОФЕРУ ДЛЯ БОНУСУ ЗА КОНВЕРСІЮ (13.11.2026, Роман: «офер — джерело правди», «застосовуємо зараз»).
 * З листопада 2026: 50 дзвінків щодня без пропусків · ≥990 успішних (> 10 с) за місяць · конверсія від 50 цільових лідів ·
 * без «маржа від 50 000 — без дзвінків» · бонус у «зараз» — лише коли КПІ виконано. Конверсія — за фільтрами Даші в Kommo
 * (`rnkConvAsKommo`, затверджено 13.11). Норма 50 — лише зарплатна: у «Звіті» й КВП лишається норма з «Планів» (45).
 */
export const OFFER_KPI = { offerFrom: "2026-11", normCalls: 50, minSuccessCalls: 990, minLeads: 50 } as const;

/**
 * 🎂 НОВЕ ПРАВИЛО ДНІВ НАРОДЖЕННЯ (задача 10723: ТЗ Тетяни 23.11.2026, затвердив Сергій 24.11, Роман: «з сьогодні» → з листопада
 * 2026). Іменинникові — 100 ₴ × повні місяці стажу (не більше 12, тобто від року 1 200) + від компанії 400 / тім-ліду 600; з кожного
 * працюючого — 100 ₴ щомісяця «Фонд днів народження», незалежно від кількості іменинників (Тетяна 24.11: «з усіх, незважаючи ні
 * на що»). Місяці до листопада рахуються, як раніше. Це правило, а не налаштування: версія з БД його не перекриває. Тримає #10880.
 */
export const BIRTHDAY_V2_FROM = "2026-11";

/** КПІ з ядра: дні з нормою дзвінків + цільові звернення / цільові угоди (лінива загрузка ядра — без пулу на імпорті). */
export const coreKpi: KpiSource = async (from, to, managerIds, today, normOverride) => {
  const out = new Map<number, { normDays: number; leads: number; targetDeals: number; successCalls: number }>();
  if (!managerIds.length) return out;
  const [{ callsByManagerDay }, { callNormCell }, { callsNormFor }, { rnkConvAsKommo }] = await Promise.all([
    import("../core/reportCuts.js"), import("../core/callNorm.js"), import("../core/callsNormPlan.js"), import("../core/metrics.js")]);
  const [calls, planNorm, conv] = await Promise.all([callsByManagerDay(from, to, {}), callsNormFor(from), rnkConvAsKommo({ from, to }, managerIds)]);
  const norm = normOverride ?? planNorm;
  const byM = new Map<number, typeof calls>();
  for (const c of calls) { const a = byM.get(c.managerId) ?? []; a.push(c); byM.set(c.managerId, a); }
  for (const id of managerIds) {
    const cell = callNormCell(byM.get(id) ?? [], norm, from, to, today);
    const cv = conv.rows.find((r) => r.managerId === id);
    const successCalls = (byM.get(id) ?? []).filter((d) => d.day >= from && d.day <= to).reduce((a, d) => a + d.long, 0);
    out.set(id, { normDays: cell.daysWithNorm ?? 0, leads: cv?.target ?? 0, targetDeals: cv?.won ?? 0, successCalls });
  }
  return out;
};

export interface StateOptions { now?: string; kpi?: KpiSource; withKpi?: boolean }

/** Знімок для рушія станом на `now` (за Києвом). */
export async function loadState(db: Db, opts: StateOptions = {}): Promise<PayrollState & { meta: { managerOf: Record<string, number | null> } }> {
  const now = opts.now ?? kyivNow();
  const today = now.slice(0, 10), live = today.slice(0, 7);
  const monthsBack: string[] = []; for (let m = live, i = 0; i < 5; i++, m = prevMonth(m)) monthsBack.unshift(m);   // 4 попередні + поточний
  const fromMonth = monthsBack[0];

  // ---------- налаштування, місяці ----------
  const setQ = await db.query<{ settings: Record<string, unknown> }>(
    `SELECT settings FROM payroll_settings_versions WHERE valid_from <= $1::date ORDER BY valid_from DESC LIMIT 1`, [monthStart(live)]);
  // місяць — рядком із SQL: pg віддає DATE як локальну північ, і toISOString() у Києві зсуває його на місяць назад
  const monthsQ = await db.query<{ mk: string; status: string; open: boolean }>(
    `SELECT to_char(pm.month, 'YYYY-MM') AS mk, pm.status, EXISTS (SELECT 1 FROM payroll_records r WHERE r.month = pm.month AND r.status <> 'paid') AS open
       FROM payroll_months pm WHERE pm.status = 'closed' ORDER BY pm.month DESC LIMIT 3`);
  const closedRow = monthsQ.rows.find((r) => r.mk >= prevMonth(live) || r.open);
  const closedMonth = closedRow ? closedRow.mk : null;

  // ---------- люди, умови, офіційна ЗП, звільнення ----------
  const empQ = await db.query<{
    user_id: number; role: string; title: string; dept_code: string; team_code: string | null; leads_team_code: string | null; offer_code: string | null;
    start_date: Date; birthday_md: string | null; is_finance: boolean; name: string; manager_id: number | null;
    leave_date: Date | null; leave_type: string | null; naim_dismissed: string | null;
  }>(`SELECT pe.*, ${NAME_SQL} AS name, u.manager_id, l.leave_date, l.leave_type,
             (SELECT CASE WHEN x.status = 'dismissed' THEN to_char(x.dismissed_at, 'YYYY-MM-DD') END FROM employees x WHERE x.user_id = pe.user_id
               ORDER BY x.id DESC LIMIT 1) AS naim_dismissed
        FROM payroll_employees pe JOIN users u ON u.id = pe.user_id ${NAME_JOIN}
        LEFT JOIN payroll_leaves l ON l.user_id = pe.user_id ORDER BY pe.user_id`);
  const termsQ = await db.query<{ user_id: number; valid_from: Date; level: string | null; rate: string | null; pct_base: string | null; pct_value: string | null; pct_clear: boolean }>(
    `SELECT user_id, valid_from, level, rate, pct_base, pct_value, pct_clear FROM payroll_terms ORDER BY user_id, valid_from, id`);
  // окремий відсоток за своїми клієнтами менеджера (знято — не діє; `valid_from` — з якого місяця)
  const crQ = await db.query<{ id: string; user_id: number; client_key: string; client_name: string; pct: string; mk: string }>(
    `SELECT id::text, user_id, client_key, client_name, pct, to_char(valid_from, 'YYYY-MM') AS mk FROM payroll_client_rates WHERE removed_at IS NULL ORDER BY user_id, id`);
  // постійний бонус / корекція на період (задача 10723): зняте не діє; `to` NULL — безстроково
  const adjQ = await db.query<{ id: string; user_id: number; kind: string; amount: string; note: string; f: string; t: string | null }>(
    `SELECT id::text, user_id, kind, amount, note, to_char(from_month, 'YYYY-MM') AS f, to_char(to_month, 'YYYY-MM') AS t
       FROM payroll_adjustments WHERE removed_at IS NULL ORDER BY user_id, from_month, id`);
  const offQ = await db.query<{ user_id: number; valid_from: Date; amount: string; deduct: boolean }>(
    `SELECT user_id, valid_from, amount, deduct FROM payroll_official ORDER BY user_id, valid_from, id`);
  const dateOnly = (d: Date) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  const managerOf: Record<string, number | null> = {};
  const employees = empQ.rows.map((r) => {
    const id = String(r.user_id); managerOf[id] = r.manager_id;
    const terms = termsQ.rows.filter((t) => t.user_id === r.user_id).map((t) => {
      const x: Record<string, unknown> = { from: dateOnly(t.valid_from).slice(0, 7) };
      if (t.level) x.level = t.level;
      if (t.rate != null) x.rate = Number(t.rate);
      if (t.pct_clear) x.pct = null; else if (t.pct_base) x.pct = { base: t.pct_base, value: Number(t.pct_value) };
      return x;
    });
    const official = offQ.rows.filter((o) => o.user_id === r.user_id).map((o) => ({ from: dateOnly(o.valid_from).slice(0, 7), amount: Number(o.amount), deduct: o.deduct }));
    return {
      id, name: r.name, role: r.role, title: r.title, dept: r.dept_code, team: r.team_code, leadsTeam: r.leads_team_code,
      ...(r.offer_code ? { offer: r.offer_code } : {}),
      startDate: dateOnly(r.start_date), birthday: r.birthday_md, terms, official,
      clientRates: crQ.rows.filter((c) => c.user_id === r.user_id).map((c) => ({ id: Number(c.id), client: c.client_key, name: c.client_name, pct: Number(c.pct), from: c.mk })),
      adjustments: adjQ.rows.filter((x) => x.user_id === r.user_id).map((x) => ({ id: Number(x.id), kind: x.kind, amount: Number(x.amount), note: x.note, from: x.f, to: x.t })),
      // звільнення: оформлене в «Зарплаті» (обхідний, тип за п. 11) — інакше дата з «Найму» з типом `naim` (без ставки й бонусу)
      // (задача 10723, Тетяна 25.11, «роби» Романа 27.11). Найновіший запис «Найму» на акаунт, як `NAME_JOIN`; у БД нічого не пишемо.
      leave: r.leave_date ? { date: dateOnly(r.leave_date), type: r.leave_type }
        : r.naim_dismissed && r.naim_dismissed >= dateOnly(r.start_date) ? { date: r.naim_dismissed, type: "naim" } : null, isFinance: r.is_finance,
    };
  });
  const byManager = new Map<number, string>();
  for (const e of employees) { const m = managerOf[e.id]; if (m != null && e.role === "manager") byManager.set(m, e.id); }
  const managerIds = [...byManager.keys()];
  // Тімліди з акаунтом Kommo: їхні ВЛАСНІ угоди потрібні лише для ліміту авансу (правка 25.11: «тім-лід аванс за свій результат 15%»).
  // Їдуть окремим полем `ownDeals`, а НЕ в `deals`: інакше їх побачили б маржа компанії, ТТН, обхідний і авто-«Профі». Тримає #10965.
  const byLead = new Map<number, string>();
  for (const e of employees) { const m = managerOf[e.id]; if (m != null && e.role === "lead") byLead.set(m, e.id); }
  const dealManagerIds = [...managerIds, ...byLead.keys()];

  // ---------- відділи, команди ----------
  const depQ = await db.query<{ code: string; name: string; is_sales: boolean }>(`SELECT code, name, is_sales FROM payroll_departments`);
  const teamQ = await db.query<{ code: string; name: string; offer_code: string }>(`SELECT code, name, offer_code FROM payroll_teams`);
  const departments = Object.fromEntries(depQ.rows.map((d) => [d.code, { name: d.name, sales: d.is_sales }]));
  const teams = Object.fromEntries(teamQ.rows.map((t) => [t.code, { name: t.name }]));
  const teamOffers = Object.fromEntries(teamQ.rows.filter((t) => t.offer_code !== "std").map((t) => [t.code, t.offer_code]));

  // ---------- плани ----------
  const plans: Record<string, Record<string, number>> = {};
  if (managerIds.length) {
    const pq = await db.query<{ manager_id: number; mk: string; v: string }>(
      `SELECT manager_id, to_char(plan_date, 'YYYY-MM') AS mk, planned_value AS v FROM plans
        WHERE metric = 'payment_amount' AND manager_id = ANY($1) AND plan_date BETWEEN $2::date AND $3::date`,
      [managerIds, monthStart(fromMonth), monthStart(live)]);
    for (const r of pq.rows) { const e = byManager.get(r.manager_id); if (e) (plans[r.mk] ??= {})[e] = Number(r.v); }
  }

  // ---------- угоди «Успішно реалізовано» ----------
  const deals: Record<string, Record<string, unknown[]>> = {};
  const ownDeals: Record<string, Record<string, unknown[]>> = {};
  const ttnAt: Record<string, string | null> = {};
  if (dealManagerIds.length) {
    const dq = await db.query<{ kommo_id: string; manager_id: number; day: string; mk: string; client: string | null; ck: string | null; name: string | null; price: string; paid: boolean; over: boolean; seen_at: Date | null }>(
      `SELECT d.kommo_id::text, d.manager_id, to_char((d.closed_at_kommo ${KYIV})::date, 'YYYY-MM-DD') AS day,
              to_char((d.closed_at_kommo ${KYIV})::date, 'YYYY-MM') AS mk, d.client_name AS client, d.client_key AS ck, d.name, d.price,
              EXISTS (SELECT 1 FROM onec_deal_payments p WHERE p.deal_id = d.kommo_id) AS paid,
              (d.planned_payment_at IS NOT NULL AND (d.planned_payment_at ${KYIV})::date < $4::date) AS over,
              ts.seen_at
         FROM deals d LEFT JOIN payroll_ttn_seen ts ON ts.deal_id = d.kommo_id
        WHERE d.status_id = ANY($5) AND d.pipeline_id = ANY($6) AND d.closed_at_kommo IS NOT NULL AND d.manager_id = ANY($1)
          AND (d.closed_at_kommo ${KYIV})::date BETWEEN $2::date AND $3::date
        ORDER BY d.closed_at_kommo, d.kommo_id`,
      [dealManagerIds, monthStart(fromMonth), `${live}-${lastDay(live)}`, today, STAGE_SUCCESS, FC_PIPELINES]);
    for (const r of dq.rows) {
      const d = { id: r.kommo_id, date: r.day, client: r.client || r.name || `угода ${r.kommo_id}`, ck: r.ck, margin: Number(r.price), pay: r.paid ? "paid" : r.over ? "over" : "wait" };
      const e = byManager.get(r.manager_id);   // менеджер — першим: його угоди рухатись не можуть
      if (!e) { const lead = byLead.get(r.manager_id); if (lead) ((ownDeals[lead] ??= {})[r.mk] ??= []).push(d); continue; }
      ((deals[e] ??= {})[r.mk] ??= []).push(d);
      ttnAt[r.kommo_id] = kyivIso(r.seen_at);
    }
  }

  // ---------- КПІ: поточний, закритий і попередній (калькулятор) ----------
  const kpi: Record<string, Record<string, unknown>> = {};
  if (opts.withKpi !== false && managerIds.length) {
    const src = opts.kpi ?? coreKpi;
    const ms = [...new Set([live, prevMonth(live), closedMonth].filter(Boolean) as string[])];
    for (const mk of ms) {
      const to = `${mk}-${lastDay(mk)}`;
      const k = await src(monthStart(mk), to, managerIds, today, mk >= OFFER_KPI.offerFrom ? OFFER_KPI.normCalls : null);
      for (const [m, v] of k) { const e = byManager.get(m); if (e) (kpi[e] ??= {})[mk] = v; }
    }
  }

  // ---------- закриття: записи, премії, форми ----------
  const records: Record<string, Record<string, unknown>> = {};
  const recQ = await db.query<{ id: string; mk: string; user_id: number; status: string; overrides: Record<string, number>; notes: Record<string, string>;
    verified_at: Date | null; verified_by: number | null; agreed_at: Date | null; dispute_text: string | null; dispute_at: Date | null; reply: string | null; paid_at: Date | null; paid_by: number | null }>(
    `SELECT id::text, to_char(month, 'YYYY-MM') AS mk, user_id, status, overrides, notes, verified_at, verified_by, agreed_at, dispute_text, dispute_at, reply, paid_at, paid_by
       FROM payroll_records WHERE month >= $1::date`, [monthStart(fromMonth)]);
  const recIds = recQ.rows.map((r) => r.id);
  const exQ = recIds.length ? await db.query<{ record_id: string; kind: string; amount: string; note: string }>(
    `SELECT record_id::text, kind, amount, note FROM payroll_record_extras WHERE record_id = ANY($1::bigint[]) AND deleted_at IS NULL ORDER BY id`, [recIds]) : { rows: [] };
  const fmQ = recIds.length ? await db.query<{ record_id: string; cash: string; submitted_at: Date; card_id: string | null; last4: string | null; holder: string | null; bank: string | null; amount: string | null }>(
    `SELECT f.record_id::text, f.cash, f.submitted_at, l.card_id::text, c.last4, c.holder, c.bank, l.amount
       FROM payroll_payout_forms f LEFT JOIN payroll_payout_lines l ON l.form_id = f.id LEFT JOIN payroll_cards c ON c.id = l.card_id
      WHERE f.record_id = ANY($1::bigint[]) ORDER BY l.id`, [recIds]) : { rows: [] };
  for (const r of recQ.rows) {
    const fl = fmQ.rows.filter((f) => f.record_id === r.id);
    const rec: Record<string, unknown> = {
      status: r.status, overrides: r.overrides ?? {}, notes: r.notes ?? {},
      extras: exQ.rows.filter((x) => x.record_id === r.id).map((x) => ({ kind: x.kind, amount: Number(x.amount), note: x.note })),
      ...(r.verified_at ? { verifiedAt: kyivIso(r.verified_at), verifiedBy: String(r.verified_by) } : {}),
      ...(r.agreed_at ? { agreedAt: kyivIso(r.agreed_at) } : {}),
      ...(r.dispute_text ? { dispute: { text: r.dispute_text, at: kyivIso(r.dispute_at) } } : {}),
      ...(r.reply ? { reply: r.reply } : {}),
      ...(fl.length ? { form: { cash: Number(fl[0].cash), at: kyivIso(fl[0].submitted_at), cards: fl.filter((f) => f.card_id).map((f) => ({ no: `${f.card_id}-${f.last4}`, cardId: Number(f.card_id), who: f.holder, bank: f.bank, amount: Number(f.amount) })) } } : {}),
      ...(r.paid_at ? { paidAt: kyivIso(r.paid_at), paidBy: String(r.paid_by) } : {}),
      recordId: Number(r.id),
    };
    (records[r.mk] ??= {})[String(r.user_id)] = rec;
  }

  // ---------- аванси: на місяць — остання не скасована заявка ----------
  const advances: Record<string, Record<string, unknown>> = {};
  const advQ = await db.query<{ id: string; mk: string; user_id: number; amount: string; cash: string; status: string; requested_at: Date; paid_at: Date | null; paid_by: number | null;
    rejected_at: Date | null; rejected_by: number | null; reason: string | null; cancelled_at: Date | null; kind: string; note: string | null; approved_at: Date | null; approved_by: number | null; lines: Array<{ cardId: number; last4: string; holder: string; bank: string | null; amount: string }> | null }>(
    `SELECT a.id::text, to_char(a.month, 'YYYY-MM') AS mk, a.user_id, a.amount, a.cash, a.status, a.requested_at, a.paid_at, a.paid_by, a.rejected_at, a.rejected_by, a.reason, a.cancelled_at, a.kind, a.note, a.approved_at, a.approved_by,
            (SELECT json_agg(json_build_object('cardId', l.card_id, 'last4', c.last4, 'holder', c.holder, 'bank', c.bank, 'amount', l.amount) ORDER BY l.id)
               FROM payroll_advance_lines l JOIN payroll_cards c ON c.id = l.card_id WHERE l.advance_id = a.id) AS lines
       FROM payroll_advances a WHERE a.month >= $1::date AND a.status <> 'cancelled' ORDER BY a.requested_at, a.id`, [monthStart(fromMonth)]);
  // «Аванс форс-мажор» (задача 10723): кілька на місяць — окремим масивом, щоб `advances` лишився «один звичайний на місяць»
  const fmAdvances: Record<string, Record<string, unknown[]>> = {};
  for (const a of advQ.rows) {
    if (a.kind === "fm") {
      ((fmAdvances[a.mk] ??= {})[String(a.user_id)] ??= []).push({
        id: Number(a.id), amount: Number(a.amount), cash: Number(a.cash), note: a.note,
        cards: (a.lines ?? []).map((l) => ({ no: `${l.cardId}-${l.last4}`, cardId: l.cardId, who: l.holder, bank: l.bank, amount: Number(l.amount) })),
        requestedAt: kyivIso(a.requested_at),
        ...(a.approved_at ? { approvedAt: kyivIso(a.approved_at), approvedBy: String(a.approved_by) } : {}),
        ...(a.paid_at ? { paidAt: kyivIso(a.paid_at), paidBy: String(a.paid_by) } : {}),
        ...(a.rejected_at ? { rejectedAt: kyivIso(a.rejected_at), rejectedBy: String(a.rejected_by), reason: a.reason } : {}),
      });
      continue;
    }
    (advances[a.mk] ??= {})[String(a.user_id)] = {
      id: Number(a.id), amount: Number(a.amount), cash: Number(a.cash),
      cards: (a.lines ?? []).map((l) => ({ no: `${l.cardId}-${l.last4}`, cardId: l.cardId, who: l.holder, bank: l.bank, amount: Number(l.amount) })),
      requestedAt: kyivIso(a.requested_at),
      ...(a.paid_at ? { paidAt: kyivIso(a.paid_at), paidBy: String(a.paid_by) } : {}),
      ...(a.rejected_at ? { rejectedAt: kyivIso(a.rejected_at), rejectedBy: String(a.rejected_by), reason: a.reason } : {}),
    };
  }

  // ---------- ТТН до запуску, архів ----------
  const ttnLegacy: Record<string, Record<string, unknown>> = {};
  for (const r of (await db.query<{ user_id: number; mk: string; total: number; done: number; held: boolean; fixed_at: Date | null; fixed_n: number | null }>(
    `SELECT user_id, to_char(month, 'YYYY-MM') AS mk, total, done, held, fixed_at, fixed_n FROM payroll_ttn_legacy`)).rows)
    (ttnLegacy[String(r.user_id)] ??= {})[r.mk] = { total: r.total, done: r.done, held: r.held, ...(r.fixed_at ? { fix: { at: kyivIso(r.fixed_at), n: r.fixed_n ?? 0 } } : {}) };
  const archive: Record<string, unknown[]> = {};
  for (const r of (await db.query<{ user_id: number; mk: string; level: string | null; margin: string; fund: string }>(
    `SELECT user_id, to_char(month, 'YYYY-MM') AS mk, level, margin, fund FROM payroll_archive ORDER BY month`)).rows)
    (archive[String(r.user_id)] ??= []).push({ month: r.mk, level: r.level, margin: Number(r.margin), fund: Number(r.fund) });

  // ---------- обхідні листи ----------
  const clearances: Record<string, unknown> = {};
  const clrQ = await db.query<{ id: string; user_id: number; created_at: Date; created_by: number; shots_at: Date | null; shots_n: number | null }>(
    `SELECT id::text, user_id, created_at, created_by, shots_at, shots_n FROM payroll_clearances`);
  if (clrQ.rows.length) {
    const sigQ = await db.query<{ clearance_id: string; item_key: string; signed_at: Date; signed_by: number; signer_name: string; data: unknown }>(
      `SELECT clearance_id::text, item_key, signed_at, signed_by, signer_name, data FROM payroll_clearance_signatures`);
    for (const c of clrQ.rows)
      clearances[String(c.user_id)] = {
        id: Number(c.id), createdAt: kyivIso(c.created_at), createdBy: String(c.created_by),
        shots: c.shots_at ? { at: kyivIso(c.shots_at), n: c.shots_n ?? 0 } : null,
        signatures: Object.fromEntries(sigQ.rows.filter((s) => s.clearance_id === c.id).map((s) => [s.item_key, { at: kyivIso(s.signed_at), by: String(s.signed_by), name: s.signer_name, data: s.data }])),
      };
  }
  // ---------- задачі рекрутеру «перепідписати офер» ----------
  const tasks = (await db.query<{ id: string; user_id: number; offer_title: string; level: string | null; valid_from: Date; why: string | null; created_at: Date; signed_at: Date | null; void_at: Date | null }>(
    `SELECT id::text, user_id, offer_title, level, valid_from, why, created_at, signed_at, void_at FROM payroll_offer_docs ORDER BY id`)).rows
    .map((t) => { const from = dateOnly(t.valid_from);
      // строк підпису — 5-те число місяця, з якого діє офер (як у задачі, що створює service)
      return { id: Number(t.id), empId: String(t.user_id), title: t.offer_title, level: t.level, from, due: `${from.slice(0, 7)}-05`, why: t.why, createdAt: kyivIso(t.created_at), signedAt: kyivIso(t.signed_at), doneAt: kyivIso(t.signed_at), voidAt: kyivIso(t.void_at) }; });

  // ---------- заявки менеджерів на «Профі» (задача 10723, В1, «роби» Романа 27.11): остання заявка людини; хто погоджує ----------
  const levelRequests: Record<string, unknown> = {};
  for (const r of (await db.query<{ id: string; user_id: number; level: string; from_month: string; requested_at: Date; decided_at: Date | null; decision: string | null; note: string | null; employee_id: number | null }>(
    `SELECT DISTINCT ON (q.user_id) q.id::text, q.user_id, q.level, to_char(q.from_month, 'YYYY-MM') AS from_month, q.requested_at, q.decided_at, q.decision, q.note,
            (SELECT max(e.id) FROM employees e WHERE e.user_id = q.user_id) AS employee_id
       FROM payroll_level_requests q ORDER BY q.user_id, q.id DESC`)).rows)
    levelRequests[String(r.user_id)] = { id: Number(r.id), level: r.level, from: r.from_month, requestedAt: kyivIso(r.requested_at), decidedAt: kyivIso(r.decided_at), decision: r.decision, note: r.note,
      employeeId: r.employee_id };
  const levelApprovers = (await db.query<{ id: number }>(
    `SELECT u.id FROM users u JOIN roles r ON r.key = COALESCE(u.role_override, u.role)
      WHERE u.is_active AND (r.permissions ->> 'payroll_level_approve') = 'true' ORDER BY u.id`)).rows.map((r) => String(r.id));
  // хто погоджує «Аванс форс-мажор» — право `payroll_fm_approve` (Роман 27.11: «Тільки Сергій погоджує» — роль ОД)
  const fmApprovers = (await db.query<{ id: number }>(
    `SELECT u.id FROM users u JOIN roles r ON r.key = COALESCE(u.role_override, u.role)
      WHERE u.is_active AND (r.permissions ->> 'payroll_fm_approve') = 'true' ORDER BY u.id`)).rows.map((r) => String(r.id));

  const settings = { ...(setQ.rows[0]?.settings ?? {}) } as Record<string, unknown>;
  settings.kpi = { ...(settings.kpi as object ?? {}), ...OFFER_KPI };   // умови оферу — не налаштування: їх не перекриває версія з БД
  settings.birthday = { ...(settings.birthday as object ?? {}), v2From: BIRTHDAY_V2_FROM };   // правило ДН з листопада — теж не налаштування
  if (Object.keys(teamOffers).length) settings.teamOffers = { ...(settings.teamOffers as object ?? {}), ...teamOffers };
  return {
    now, liveMonth: live, closedMonth, settings, employees, departments, teams, plans, deals, ownDeals, kpi, ttnAt, payWording: "approved", ttnLegacy, dismissZero: true,
    records, advances, fmAdvances, archive, clientHistory: {}, clearances, responsibles: await loadResponsibles(db), tasks, holidays: [],
    levelRequests, levelApprovers, fmApprovers, meta: { managerOf },
  };
}

