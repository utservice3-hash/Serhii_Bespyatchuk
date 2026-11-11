import type { ClientSegment } from "./reactivationRules.js";

/** 👥 Клієнти з реклами (#8709) — чисті типи й згортка, без бази: їх тримає юніт-гейт `#3316b`. Запит — `adClients.ts`. */
export interface AdClient {
  clientKey: string; name: string; campaign: string | null; firstLead: string;
  segment: ClientSegment; qualified: boolean; deals: number; margin: number;
}
export interface AdClientsCampaign {
  campaign: string | null; clients: number; regular: number; vip: number; regularSeg: number; episodic: number;
  margin: number; regularMargin: number;
}
export interface AdClientsReport {
  from: string; to: string;
  campaigns: AdClientsCampaign[];
  totals: { clients: number; margin: number };
  regulars: AdClient[];
}

/** Чиста згортка клієнтів у рядки кампаній і плитки — окремо, щоб гейт `#3316b` тримав її без бази. */
export function foldAdClients(clients: readonly AdClient[], from: string, to: string): AdClientsReport {
  const byCamp = new Map<string | null, AdClientsCampaign>();
  for (const c of clients) {
    const r = byCamp.get(c.campaign) ?? { campaign: c.campaign, clients: 0, regular: 0, vip: 0, regularSeg: 0, episodic: 0, margin: 0, regularMargin: 0 };
    r.clients += 1; r.margin += c.margin;
    if (c.qualified) {
      r.regular += 1; r.regularMargin += c.margin;
      if (c.segment === "vip") r.vip += 1;
      else if (c.segment === "regular") r.regularSeg += 1;
      else if (c.segment === "episodic") r.episodic += 1;
    }
    byCamp.set(c.campaign, r);
  }
  return {
    from, to,
    campaigns: [...byCamp.values()],
    totals: { clients: clients.length, margin: clients.reduce((s, c) => s + c.margin, 0) },
    regulars: clients.filter((c) => c.qualified),
  };
}
