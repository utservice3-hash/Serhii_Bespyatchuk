import type { Db } from "./adCallFacts.js";
import { normalizePhone } from "../utils/phone.js";
import { OUTBOUND_TYPES } from "./missedCallsRules.js";
import { LEADGEN_CALL_MIN_SEC } from "./leadgenRules.js";
import { PZ_OPR, PZ_QUALIFIED } from "./leadgenStages.js";
import { PZ_TENDER_STATUS } from "./prozorroPush.js";
import { handoffDealStates } from "./money.js";
import { kommoLeadUrl } from "./kommoLinks.js";
import { pzDealState, summarizeDeals, type PzDealRow, type PzDealsSummary } from "./prozorroDealRules.js";

/**
 * 📋 «ТЕНДЕРИ PROZORRO» → «Угоди» і детальна статистика (TOP Weekly 12.11.2026, макет 13.11.2026). Угоди, які бот ЗАПИСАВ у Kommo
 * за період (`pushed_at` за Києвом, обидва кінці), зі станом ЗАРАЗ. Правила стану й підсумків — чисті, `core/prozorroDealRules.ts`;
 * стан угоди менеджера (авто / оплата) — лише з грошового ядра (`money.handoffDealStates`), розмова — та сама, що автозакриття
 * задачі «звʼязатися»: вихідний дзвінок на номер контакту, розмова довше 8 с, не раніше за створення угоди.
 */
const kyivDay = (d: Date): string => d.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

export async function prozorroDeals(db: Db, from: string, to: string, now: Date = new Date()): Promise<{ rows: PzDealRow[]; summary: PzDealsSummary }> {
  const base = (await db.query<{ lead: string; pushed_at: Date; company: string; amount: string | null; niche: string | null; phone: string | null;
    status_id: string | null; reason: string | null; manager: string | null; team: string | null; child: string | null }>(`
    SELECT l.kommo_lead_id::text AS lead, l.pushed_at, l.company_name AS company, l.amount::text AS amount, l.niches[1] AS niche, l.phone,
           d.status_id::text AS status_id, d.reject_reason AS reason, m.name AS manager, t.name AS team,
           (SELECT k.child_id::text FROM lead_child_links k WHERE k.parent_id = l.kommo_lead_id ORDER BY k.created_at, k.child_id LIMIT 1) AS child
      FROM prozorro_leads l
      LEFT JOIN deals d ON d.kommo_id = l.kommo_lead_id
      LEFT JOIN managers m ON m.id = d.manager_id
      LEFT JOIN teams t ON t.id = m.team_id
     WHERE l.kommo_lead_id IS NOT NULL AND (l.pushed_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date
     ORDER BY l.pushed_at DESC, l.id DESC`, [from, to])).rows;
  const states = await handoffDealStates(base.flatMap((r) => (r.child ? [Number(r.child)] : [])));
  const phones = [...new Set(base.map((r) => normalizePhone(r.phone)).filter((p): p is string => !!p))];
  const minPushed = base.reduce<Date | null>((a, r) => (a == null || r.pushed_at < a ? r.pushed_at : a), null);
  const calls = phones.length && minPushed ? (await db.query<{ client_phone: string; calldate: Date }>(
    `SELECT client_phone, calldate FROM ringostat_calls
      WHERE client_phone = ANY($1::text[]) AND calldate >= $2 AND call_type = ANY($3::text[]) AND billsec > $4`,
    [phones, minPushed, [...OUTBOUND_TYPES], LEADGEN_CALL_MIN_SEC])).rows : [];
  const talkAt = new Map<string, number[]>();
  for (const c of calls) { const xs = talkAt.get(c.client_phone) ?? []; xs.push(new Date(c.calldate).getTime()); talkAt.set(c.client_phone, xs); }
  const ids = { tender: PZ_TENDER_STATUS, opr: PZ_OPR, qualified: PZ_QUALIFIED, lost: 143 };
  const rows: PzDealRow[] = base.map((r) => {
    const st = r.child ? states.get(Number(r.child)) : undefined;
    const state = pzDealState(Number(r.status_id ?? 0), st ? { cls: st.cls, autoDay: st.autoDay ?? null } : null, ids);
    const pushed = new Date(r.pushed_at).getTime(), phone = normalizePhone(r.phone);
    return {
      leadId: Number(r.lead), url: kommoLeadUrl(Number(r.lead)), day: kyivDay(new Date(r.pushed_at)), company: r.company, amount: r.amount == null ? null : Number(r.amount),
      niche: r.niche, manager: r.manager, team: r.team, state, reason: state === "closed" ? r.reason : null,
      talk: !!phone && (talkAt.get(phone) ?? []).some((t) => t >= pushed),
      ageDays: Math.floor((now.getTime() - pushed) / 86_400_000),
    };
  });
  return { rows, summary: summarizeDeals(rows) };
}
