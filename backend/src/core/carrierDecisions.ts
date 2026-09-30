import type { Db } from "./adCallFacts.js";
import { CARRIER_STAGE, isOtherType, whyUncertain, type HumanDecision, type OtherType } from "./carrierCallRules.js";
import { carrierDealRows, type CarrierScope, type DealRow } from "./carrierDeals.js";

export { whyUncertain };
export type { HumanDecision };

/**
 * 🙋 РІШЕННЯ ЛЮДИНИ (29.09.2026 — керівництво по невпевнених; ТЗ Романа 30.09.2026 — менеджер і тімлід).
 *
 * «На перевірці» (невпевнений AI, «не розібрати», угода без розмови від 10 с) і «Помилка» вирішує людина:
 * «Перевізник», «Клієнт» або «Інше» (+ підтип). Хто:
 *   · менеджер — лише угоди, де він відповідальний;
 *   · тімлід — угоди своєї команди; може змінити рішення менеджера;
 *   · керівництво (адмін, CEO, опдир, КВП) — усе; може змінити будь-яке.
 * Змінити рішення СТАРШОГО не можна: тімлідове не перепише менеджер, керівництва — ні тімлід, ні менеджер.
 * Рішення людини сильніше за AI: «Перевізник» і «Інше» закриваються в CRM, «Клієнт» — ніколи (`carrierClose.ts`).
 * Історія лише дописується (хто, яка роль, коли, що казав AI); чинне — останнє. Після закриття в CRM — лише
 * «Повернути на етап».
 */

export const HUMAN_DECISIONS: readonly HumanDecision[] = ["carrier", "client", "other"];
export const NOTE_MAX = 500;

/** Старшинство ролі для «хто може переписати чиє рішення». Невідома роль (старі рядки до 30.09) — керівництво. */
export function decisionRank(roleKey: string | null): number {
  if (roleKey === "manager") return 1;
  if (roleKey === "team_lead") return 2;
  return 3;
}

export type PendingRow = Pick<DealRow, "kommoId" | "uniqueid" | "calledAt" | "billsec" | "managerId" | "managerName" | "teamId" | "teamName"
  | "category" | "why" | "dealState" | "createdAt" | "phone" | "reviewDeadline" | "overdue"> & { role: string | null; confidence: number | null; otherType: OtherType | null; reason: string | null };
export interface DecidedRow extends PendingRow { decision: HumanDecision; decisionOther: OtherType | null; note: string | null; by: string; byRole: string | null; at: string }

const pendingOf = (r: DealRow): PendingRow => ({
  kommoId: r.kommoId, uniqueid: r.uniqueid, calledAt: r.calledAt, billsec: r.billsec, managerId: r.managerId, managerName: r.managerName,
  teamId: r.teamId, teamName: r.teamName, category: r.category, why: r.why, dealState: r.dealState, createdAt: r.createdAt, phone: r.phone,
  reviewDeadline: r.reviewDeadline, overdue: r.overdue,
  role: r.ai.verdict, confidence: r.ai.confidence, otherType: r.ai.otherType, reason: r.ai.reason,
});

/**
 * Черга: «На перевірці» й «Помилка» в межах скоупу, досі на етапі (за `deals`, синк раз на 30 хв; ще не
 * синкнута — теж у черзі) і не закриті дашбордом. «Вирішені» — рішення людей за `decidedDays`.
 */
export async function decisionQueue(db: Db, now: Date, scope: CarrierScope = {}, decidedDays = 30, launchSince: string | null = null):
  Promise<{ pending: PendingRow[]; decided: DecidedRow[] }> {
  const rows = await carrierDealRows(db, { period: null, scope, since: launchSince, now });
  const since = now.getTime() - decidedDays * 86_400_000;
  const pending: PendingRow[] = [], decided: DecidedRow[] = [];
  for (const r of rows) {
    if (r.human) {
      if (new Date(r.human.at).getTime() >= since) decided.push({ ...pendingOf(r), decision: r.human.decision, decisionOther: r.human.otherType,
        note: r.human.note, by: r.human.by, byRole: r.human.role, at: r.human.at });
      continue;
    }
    const onStage = r.crm.statusId == null || r.crm.statusId === CARRIER_STAGE.statusId;
    const closed = r.close?.state === "closed";
    if ((r.category === "review" || r.category === "error") && onStage && !closed) pending.push(pendingOf(r));
  }
  decided.sort((a, b) => b.at.localeCompare(a.at));
  return { pending, decided };
}

export interface Decider { userId: number; roleKey: string | null; scope: CarrierScope }

/**
 * Записати рішення. Відмова: невідоме рішення чи підтип (400); угоди немає серед дзвінків на мобільні АБО вона
 * поза скоупом (404 — чужа угода для менеджера не існує); угоду вже закрито в CRM (409 — повертати кнопкою
 * «Повернути на етап»); чинне рішення ухвалив старший (409).
 */
export async function recordDecision(db: Db, kommoId: number, decision: string, otherType: unknown, note: unknown, who: Decider, now: Date):
  Promise<{ ok: true } | { ok: false; code: 400 | 404 | 409; why: string }> {
  if (!HUMAN_DECISIONS.includes(decision as HumanDecision)) return { ok: false, code: 400, why: "рішення — «carrier», «client» або «other»" };
  let sub: OtherType | null = null;
  if (otherType != null && otherType !== "") {
    if (decision !== "other") return { ok: false, code: 400, why: "підтип буває лише в «Інше»" };
    if (!isOtherType(otherType)) return { ok: false, code: 400, why: "невідомий підтип «Інше»" };
    sub = otherType;
  }
  const n = typeof note === "string" ? note.trim().slice(0, NOTE_MAX) : "";
  const d = (await carrierDealRows(db, { period: null, scope: who.scope, ids: [kommoId] }))[0];
  if (!d) return { ok: false, code: 404, why: "угоди немає серед ваших дзвінків на мобільні" };
  if (d.close?.state === "closed") return { ok: false, code: 409, why: "угоду вже закрито в CRM — поверніть її на етап кнопкою «Повернути на етап»" };
  if (d.human && decisionRank(d.human.role) > decisionRank(who.roleKey)) {
    return { ok: false, code: 409, why: `рішення ухвалив ${d.human.role === "team_lead" ? "тімлід" : "керівник"} (${d.human.by}) — змінити може він або старший` };
  }
  await db.query(`INSERT INTO carrier_decisions (kommo_id, decision, other_type, note, decided_by, decider_role, decided_at, ai_role, ai_confidence)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [kommoId, decision, sub, n || null, who.userId, who.roleKey, now.toISOString(), d.ai.verdict, d.ai.confidence]);
  return { ok: true };
}
