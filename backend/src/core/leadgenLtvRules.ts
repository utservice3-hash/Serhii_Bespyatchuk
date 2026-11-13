/**
 * 💎 LTV КЛІЄНТІВ ЛІДОГЕНЕРАЦІЇ — ЧИСТІ ПРАВИЛА (ТЗ «LTV-показники у вкладці Лідогенерація», 28.10.2026, логіку погоджено
 * з директором; Роман 06.11.2026: «роби так, як каже ТЗ»). Без бази: правила звіряють гейти на прикладах по обидва боки.
 *
 *  • КЛІЄНТ ЛІДГЕНА (п. 3.1) — канонічний ключ, у якого ПЕРША успішна угода за всю історію (① ядра, без мінусових) — це
 *    угода менеджера, що виросла з передачі лідгена. Була хоч одна успішна до передачі → не клієнт лідгена (постійний).
 *    Лише програні до передачі → новий. Злитий ключ — один клієнт, перша угода — найраніша по ключу (ядро вже канонічне).
 *  • ЗАКРІПЛЕННЯ (п. 3.2) — за тим, ХТО ПЕРЕДАВ: хто сам перевів угоду Продзвону в «Кваліфіковано» (журнал Kommo
 *    `lead_status_changed`, `created_by`). НЕ поточний відповідальний: на 06.11.2026 вони різняться в 217 з 458 клієнтів.
 *    Змінити закріплення не може ні зміна відповідального, ні повторна передача через іншого лідгена.
 *  • Виключення: КВП позначив постійним (`force_regular`) ДО передачі; клієнт в архіві з причиною «перевізник» (п. 9.6).
 *  • LTV — Σ маржі ① усіх успішних угод клієнта за весь час (мінусові віднімаються, як у ядрі); угод — успішні без
 *    мінусових (сторно — не ще одне перевезення). Повторні — 2+ таких угод.
 */

import { leadgenViewer, type LeadgenAuth } from "./leadgenHandoffRules.js";

/** Етап «Кваліфіковано» воронок Продзвону — вхід у нього і є передача (`core/leadgenStats`). */
export const QUALIFIED_STATUS = 142;
/** ⚠ на когорті: понад 20% передач місяця без угоди менеджера — той самий поріг, що під графіком передач (`LeadgenCharts`). */
export const UNLINKED_WARN_SHARE = 0.2;

export interface StatusChange { entityId: number; createdBy: number; toStatusId: number | null; at: number }

/** Київська дата моменту (секунди Unix). */
export function kyivDay(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

/**
 * Хто передав: автор ОСТАННЬОГО входу угоди Продзвону в «Кваліфіковано» того київського дня, у який ядро бачить
 * передачу (скасовані за 15 хв входи ядро вже відкинуло — лишився той, що встояв). Робот (`0`) — не людина: `null`.
 */
export function pickHandoffActor(events: readonly StatusChange[], pzId: number, day: string): number | null {
  const hits = events.filter((e) => e.entityId === pzId && e.toStatusId === QUALIFIED_STATUS && kyivDay(e.at) === day)
    .sort((a, b) => b.at - a.at);
  const who = hits[0]?.createdBy;
  return who && who > 0 ? who : null;
}

export interface HandoffForLtv { pzId: number; dealId: number | null; day: string }
export interface FirstSuccess { dealId: number; day: string }
export interface LtvPick { clientKey: string; pzId: number; dealId: number; handoffDay: string; firstDay: string }

/**
 * Клієнти лідгенів: перша успішна угода клієнта = угода менеджера з передачі. Кілька передач з однією угодою — та, що
 * раніша (вона й «стала першою успішною»). `forcedRegularBefore` — київський день, до якого КВП уже позначив клієнта
 * постійним; `excluded` — архів «перевізник».
 */
export function pickLeadgenClients(
  firstByClient: ReadonlyMap<string, FirstSuccess>, handoffs: readonly HandoffForLtv[],
  excluded: ReadonlySet<string>, forcedRegularBefore: ReadonlyMap<string, string>,
): LtvPick[] {
  const byDeal = new Map<number, HandoffForLtv>();
  for (const h of [...handoffs].sort((a, b) => a.day.localeCompare(b.day) || a.pzId - b.pzId))
    if (h.dealId != null && !byDeal.has(h.dealId)) byDeal.set(h.dealId, h);
  const out: LtvPick[] = [];
  for (const [clientKey, f] of firstByClient) {
    if (excluded.has(clientKey)) continue;
    const h = byDeal.get(f.dealId);
    if (!h) continue;
    const forced = forcedRegularBefore.get(clientKey);
    if (forced && forced < h.day) continue;
    out.push({ clientKey, pzId: h.pzId, dealId: f.dealId, handoffDay: h.day, firstDay: f.day });
  }
  return out.sort((a, b) => a.clientKey.localeCompare(b.clientKey));
}

/** Найраніший успіх клієнта (історія ядра `clientSuccessHistory`, без мінусових). */
export function firstSuccessOf(history: ReadonlyMap<string, readonly { at: number; day: string; dealId?: number }[]>): Map<string, FirstSuccess> {
  const out = new Map<string, FirstSuccess>();
  for (const [k, xs] of history) {
    const f = [...xs].filter((x) => x.dealId != null).sort((a, b) => a.at - b.at || (a.dealId! - b.dealId!))[0];
    if (f) out.set(k, { dealId: f.dealId!, day: f.day });
  }
  return out;
}

export interface LtvRow {
  clientKey: string; ltv: number; deals: number; turnover: number; firstDay: string;
  /** Маржа ① угод клієнта з успіхом у вибраному періоді. */
  growth: number;
  /** Стан клієнта з «Клієнтів» (`clientSegments`): `active` / `sleeping` / `lost`; `null` — невідомо. */
  state?: string | null;
}

/**
 * 🧭 ГРУПА КЛІЄНТА ЛІДГЕНА (задача 8729, Роман 13.11.2026 «роби»): два питання, кожне — НАЯВНИМ правилом, без нового означення.
 *  • «стали постійними» — 2+ успішні угоди (правило 24.09.2026, те саме, що «повторні» і в «Клієнтах»);
 *  • «працюють зараз» — стан клієнта `active` (замовляє у ритмі свого сегмента, `clientSegments`). Невідомий стан — НЕ працює.
 * Чотири групи покривають кожного клієнта рівно раз: Σ = клієнтів (гейт `#3800`).
 */
export type LtvGroup = "rw" | "rs" | "ow" | "os";
export const LTV_GROUPS: readonly LtvGroup[] = ["rw", "rs", "ow", "os"];
export const isRepeatClient = (deals: number): boolean => deals >= 2;
export const isActiveNow = (state: string | null | undefined): boolean => state === "active";
export function ltvGroupOf(deals: number, state: string | null | undefined): LtvGroup {
  const r = isRepeatClient(deals), w = isActiveNow(state);
  return r ? (w ? "rw" : "rs") : (w ? "ow" : "os");
}
export interface LtvAgg {
  clients: number; ltv: number; turnover: number; avg: number | null; repeatPct: number | null; dealsPerClient: number | null;
  growth: number; newClients: number;
  /** Стали постійними (2+ успішні угоди) і працюють зараз (стан `active`) — числом, не відсотком (задача 8729). */
  repeat: number; activeNow: number;
  /** Склад: постійні-працюють / постійні-не замовляють / разові-працюють / разові-не працюють. Σ = `clients`. */
  mix: Record<LtvGroup, number>;
}

/** Підсумок групи клієнтів. `from`/`to` — період «нових» (перша успішна угода в ньому), київські дати включно. */
export function aggLtv(rows: readonly LtvRow[], from: string, to: string): LtvAgg {
  const n = rows.length;
  const ltv = rows.reduce((a, r) => a + r.ltv, 0);
  const deals = rows.reduce((a, r) => a + r.deals, 0);
  return {
    clients: n, ltv: Math.round(ltv), turnover: Math.round(rows.reduce((a, r) => a + r.turnover, 0)),
    avg: n ? Math.round(ltv / n) : null,
    repeatPct: n ? Math.round((rows.filter((r) => isRepeatClient(r.deals)).length / n) * 100) : null,
    dealsPerClient: n ? Math.round((deals / n) * 10) / 10 : null,
    growth: Math.round(rows.reduce((a, r) => a + r.growth, 0)),
    newClients: rows.filter((r) => r.firstDay >= from && r.firstDay <= to).length,
    repeat: rows.filter((r) => isRepeatClient(r.deals)).length,
    activeNow: rows.filter((r) => isActiveNow(r.state)).length,
    mix: mixOf(rows),
  };
}
function mixOf(rows: readonly LtvRow[]): Record<LtvGroup, number> {
  const m: Record<LtvGroup, number> = { rw: 0, rs: 0, ow: 0, os: 0 };
  for (const r of rows) m[ltvGroupOf(r.deals, r.state)]++;
  return m;
}

/** Частка передач без угоди менеджера по місяцях передачі — для ⚠ на когортах. */
export function unlinkedByMonth(handoffs: readonly { day: string; dealId: number | null }[]): Map<string, { handoffs: number; unlinked: number }> {
  const out = new Map<string, { handoffs: number; unlinked: number }>();
  for (const h of handoffs) {
    const m = out.get(h.day.slice(0, 7)) ?? { handoffs: 0, unlinked: 0 };
    m.handoffs++;
    if (h.dealId == null) m.unlinked++;
    out.set(h.day.slice(0, 7), m);
  }
  return out;
}

export interface Cohort extends LtvAgg { ym: string; warn: boolean; unlinkedPct: number | null }
/** Когорти — місяць першої успішної угоди; нові зверху. ⚠ — коли в тому місяці понад 20% передач без угоди менеджера. */
export function cohortsOf(rows: readonly LtvRow[], months: ReadonlyMap<string, { handoffs: number; unlinked: number }>, from: string, to: string): Cohort[] {
  const by = new Map<string, LtvRow[]>();
  for (const r of rows) { const k = r.firstDay.slice(0, 7); by.set(k, [...(by.get(k) ?? []), r]); }
  return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([ym, rs]) => {
    const m = months.get(ym);
    const share = m && m.handoffs ? m.unlinked / m.handoffs : null;
    return { ym, ...aggLtv(rs, from, to), warn: share != null && share > UNLINKED_WARN_SHARE, unlinkedPct: share == null ? null : Math.round(share * 100) };
  });
}

/**
 * 🔐 МЕЖА LTV (ТЗ п. 6, «як зараз для інших цифр вкладки», на сервері): лідген — ЛИШЕ свої клієнти (і свій LTV, без
 * підсумку відділу); тімлід — своя команда; керівництво / адмін / КВП — увесь відділ. Менеджер поза командою — 403.
 * Вибір конкретного лідгена (`pick`) лідгену дозволено лише собі. Та сама `leadgenViewer`, що в решті вкладки.
 */
export type LtvAccess =
  | { ok: true; scope: { kind: "all" } | { kind: "own"; managerId: number } | { kind: "team"; teamId: number }; pick: number | null }
  | { ok: false; status: 403; error: string };
export function ltvAccess(auth: LeadgenAuth, pick: number | null): LtvAccess {
  const v = leadgenViewer(auth);
  if (v.kind === "deny") return { ok: false, status: 403, error: v.error };
  if (v.kind === "own") {
    if (pick != null && pick !== v.selfId) return { ok: false, status: 403, error: "Лідген бачить лише своїх клієнтів" };
    return { ok: true, scope: { kind: "own", managerId: v.selfId }, pick: null };
  }
  if (auth.role === "team_lead") return { ok: true, scope: { kind: "team", teamId: auth.teamId ?? -1 }, pick };
  return { ok: true, scope: { kind: "all" }, pick };
}
