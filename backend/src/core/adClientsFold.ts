import type { ClientSegment, ClientState } from "./reactivationRules.js";

/**
 * 👥 Клієнти з реклами (#8709, #8704) — чисті типи й згортка, без бази: їх тримають юніт-гейти `#3316b`, `#3317b`.
 * Запит — `adClients.ts`.
 *
 * 🔁 ПОВТОРНІ ЗАМОВЛЕННЯ (#8704, зустріч 12.11.2026 — Сергій: «скільки постійних дали повторних замовлень, скільки
 * ми з них заробляємо далі — як історія з лідгенами»; Олександр: «скільки разів у середньому замовляє постійний»).
 * `firstMargin` — маржа ПЕРШОЇ оплаченої угоди після першого рекламного ліда; усе, що після неї, — `repeatMargin`.
 * Групи й назви — ті самі, що в блоці «LTV клієнтів лідогенерації»: постійний (2+ оплати, `qualified` ядра) × працює
 * зараз (стан `active` ядра).
 */
export type AdClientGroup = "rw" | "rs" | "ow" | "os";
export const adClientGroupOf = (c: { qualified: boolean; state: ClientState | null }): AdClientGroup =>
  c.qualified ? (c.state === "active" ? "rw" : "rs") : (c.state === "active" ? "ow" : "os");

export interface AdClient {
  clientKey: string; name: string; campaign: string | null; firstLead: string;
  segment: ClientSegment; state: ClientState | null; qualified: boolean;
  deals: number; margin: number; firstMargin: number;
}
/** Агрегат групи клієнтів — однаковий для кампанії, когорти й підсумку. */
export interface AdClientsAgg {
  clients: number; regular: number; active: number; vip: number; regularSeg: number; episodic: number;
  margin: number; regularMargin: number; repeatMargin: number; deals: number; regularDeals: number;
  mix: Record<AdClientGroup, number>;
}
export interface AdClientsCampaign extends AdClientsAgg { campaign: string | null }
export interface AdClientsCohort extends AdClientsAgg { ym: string }
export interface AdClientsReport {
  from: string; to: string;
  campaigns: AdClientsCampaign[];
  cohorts: AdClientsCohort[];
  totals: AdClientsAgg;
  clients: (AdClient & { repeatMargin: number; group: AdClientGroup })[];
}

export const emptyAgg = (): AdClientsAgg => ({
  clients: 0, regular: 0, active: 0, vip: 0, regularSeg: 0, episodic: 0,
  margin: 0, regularMargin: 0, repeatMargin: 0, deals: 0, regularDeals: 0, mix: { rw: 0, rs: 0, ow: 0, os: 0 },
});

function add(a: AdClientsAgg, c: AdClient): void {
  const repeat = c.margin - c.firstMargin;
  a.clients += 1; a.margin += c.margin; a.repeatMargin += repeat; a.deals += c.deals;
  if (c.state === "active") a.active += 1;
  a.mix[adClientGroupOf(c)] += 1;
  if (c.qualified) {
    a.regular += 1; a.regularMargin += c.margin; a.regularDeals += c.deals;
    if (c.segment === "vip") a.vip += 1;
    else if (c.segment === "regular") a.regularSeg += 1;
    else if (c.segment === "episodic") a.episodic += 1;
  }
}

/** Чиста згортка клієнтів у кампанії, когорти (місяць першого ліда) і підсумок. */
export function foldAdClients(clients: readonly AdClient[], from: string, to: string): AdClientsReport {
  const byCamp = new Map<string | null, AdClientsCampaign>();
  const byYm = new Map<string, AdClientsCohort>();
  const totals = emptyAgg();
  for (const c of clients) {
    const camp = byCamp.get(c.campaign) ?? { campaign: c.campaign, ...emptyAgg() };
    const ym = c.firstLead.slice(0, 7);
    const coh = byYm.get(ym) ?? { ym, ...emptyAgg() };
    add(camp, c); add(coh, c); add(totals, c);
    byCamp.set(c.campaign, camp); byYm.set(ym, coh);
  }
  return {
    from, to,
    campaigns: [...byCamp.values()],
    cohorts: [...byYm.values()].sort((a, b) => a.ym.localeCompare(b.ym)),
    totals,
    clients: clients.map((c) => ({ ...c, repeatMargin: c.margin - c.firstMargin, group: adClientGroupOf(c) })),
  };
}
