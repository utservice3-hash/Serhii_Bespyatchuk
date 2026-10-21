import type { PzResult } from "./prozorroClient.js";
import {
  cardText, emptyTally, idFloor, launchAt as launchOf, MAX_PAGES, pageContinues, qualifies, runVerdict, tenderIdDate, winnersOf,
  type PzSearchItem, type PzTally, type PzTender, type Winner,
} from "./prozorroRules.js";

/**
 * 🏛 PROZORRO-ЛІДИ — ОДИН ПРОХІД (задача #5299, прохід 1: збір і пробний режим, без запису в Kommo).
 *
 *  1. Пошук по кожному ключовому слову ніш: тендери з переможцем, номер не старший за 60 днів, до 10 сторінок.
 *  2. Відсіюємо тендери, які вже бачили (`prozorro_tenders`).
 *  3. ПЕРШИЙ прохід (таблиця порожня) — «точка відліку»: усе знайдене записується баченим БЕЗ деталей і без лідів.
 *     Прогону за минуле немає (рішення 21.10.2026), а тягнути деталі ~14,5 тис. старих тендерів — це ~4 год запитів
 *     заради рядків, які однаково не пройдуть правило «переможець після запуску».
 *  4. Наступні проходи: для кожного нового тендера — повні дані, переможці, відбір (`qualifies`), рядок ліда.
 *     Тендер, деталі якого не прийшли, НЕ записується — наступного дня його спробуємо знову.
 *  5. Вирок (`runVerdict`) — ПІСЛЯ запису й повертається, а не кидається: джоба шле звіт і лише тоді падає.
 *
 * ⚠️ Відома межа: тендер, записаний «баченим», більше не перечитується. Якщо в ньому скасують рішення й оберуть
 * іншого переможця, нового ліда не буде. Для щоденного збору нових переможців це рідкісний випадок — прийнято свідомо.
 */

export interface TenderRow {
  uaId: string; hexId: string | null; title: string | null; status: string | null;
  amount: number | null; currency: string | null; niches: string[]; keywords: string[];
  awardDate: string | null; baseline: boolean; raw: PzTender | null;
}
export interface LeadRow extends Winner {
  uaId: string; role: "winner"; niches: string[]; keywords: string[]; card: string; mode: "dry";
  kommoCompanyExisting: number | null;
}
export interface PzStore {
  knownTenders: (uaIds: string[]) => Promise<Set<string>>;
  firstSeenAt: () => Promise<Date | null>;
  saveTenders: (rows: TenderRow[]) => Promise<void>;
  /** ЄДРПОУ, які вже є серед наших лідів (для «нових компаній»). */
  knownCompanies: (edrpous: string[]) => Promise<Set<string>>;
  /** ЄДРПОУ → id компанії в Kommo (довідник `kommo_companies`). */
  crmCompanies: (edrpous: string[]) => Promise<Map<string, number>>;
  /** Записати ліди; дубль (ЄДРПОУ + тендер + роль) не пишеться. Повертає реально вставлені. */
  saveLeads: (rows: LeadRow[]) => Promise<LeadRow[]>;
}
export interface PzCollectDeps {
  search: (text: string, page: number) => Promise<PzResult<PzSearchItem[]>>;
  tender: (uaId: string) => Promise<PzResult<PzTender>>;
  store: PzStore;
  niches: Readonly<Record<string, readonly string[]>>;
  now: Date;
  minAmount: number;
}

/** Вирок — у результаті, а не винятком: джоба спершу шле звіт, потім падає (зібране й звіт не губляться). */
export interface PzCollectResult { tally: PzTally; launch: Date; leads: LeadRow[]; verdict: ReturnType<typeof runVerdict> }

interface Candidate { title: string | null; status: string | null; amount: number | null; currency: string | null; niches: Set<string>; keywords: Set<string> }

export async function runProzorroCollect(d: PzCollectDeps): Promise<PzCollectResult> {
  const t = emptyTally();
  const floor = idFloor(d.now);
  const cand = new Map<string, Candidate>();

  for (const [niche, words] of Object.entries(d.niches)) {
    for (const word of words) {
      t.keywords++;
      for (let page = 1; page <= MAX_PAGES; page++) {
        t.searchRequests++;
        const r = await d.search(word, page);
        if (!r.ok) { t.searchFail++; t.lastFail = `пошук «${word}» стор. ${String(page)}: ${r.error}`; break; }
        t.searchOk++;
        for (const x of r.data) {
          if (!x.tenderID || tenderIdDate(x.tenderID) < floor) continue;
          const c = cand.get(x.tenderID) ?? { title: x.title ?? null, status: x.status ?? null, amount: x.value?.amount ?? null,
            currency: x.value?.currency ?? null, niches: new Set<string>(), keywords: new Set<string>() };
          c.niches.add(niche); c.keywords.add(word);
          cand.set(x.tenderID, c);
        }
        if (!pageContinues(r.data, floor)) break;
      }
    }
  }
  t.candidates = cand.size;

  const ids = [...cand.keys()];
  const known = await d.store.knownTenders(ids);
  const fresh = ids.filter((id) => !known.has(id));
  t.newTenders = fresh.length;
  const first = await d.store.firstSeenAt();
  const launch = launchOf(first, d.now);
  const base = (id: string, c: Candidate): TenderRow => ({ uaId: id, hexId: null, title: c.title, status: c.status, amount: c.amount,
    currency: c.currency, niches: [...c.niches], keywords: [...c.keywords], awardDate: null, baseline: false, raw: null });

  if (first == null) {
    t.baseline = true;
    if (fresh.length) await d.store.saveTenders(fresh.map((id) => ({ ...base(id, cand.get(id)!), baseline: true })));
    return { tally: t, launch, leads: [], verdict: runVerdict(t) };
  }

  const tenders: TenderRow[] = [];
  const pending: { w: Winner; tender: PzTender; c: Candidate; uaId: string }[] = [];
  for (const id of fresh) {
    const r = await d.tender(id);
    if (!r.ok) { t.detailFail++; t.lastFail = `тендер ${id}: ${r.error}`; continue; }
    t.fetched++;
    const c = cand.get(id)!;
    const ws = winnersOf(r.data);
    const latest = ws.map((w) => w.awardDate).filter((x): x is string => !!x).sort().pop() ?? null;
    tenders.push({ ...base(id, c), hexId: r.data.id ?? null, title: r.data.title ?? c.title, status: r.data.status ?? c.status, awardDate: latest, raw: r.data });
    for (const w of ws) {
      t.winners++;
      const q = qualifies(w, d.minAmount, launch);
      if (q !== "ok") { t.skipped[q]++; continue; }
      t.qualified++;
      pending.push({ w, tender: r.data, c, uaId: id });
    }
  }
  if (tenders.length) await d.store.saveTenders(tenders);

  const edrpous = [...new Set(pending.map((p) => p.w.edrpou!))];
  const [knownCo, crm] = edrpous.length
    ? await Promise.all([d.store.knownCompanies(edrpous), d.store.crmCompanies(edrpous)])
    : [new Set<string>(), new Map<string, number>()];
  const rows: LeadRow[] = pending.map(({ w, tender, c, uaId }) => ({
    ...w, uaId, role: "winner", niches: [...c.niches], keywords: [...c.keywords], card: cardText(tender, w, [...c.niches]),
    mode: "dry", kommoCompanyExisting: crm.get(w.edrpou!) ?? null,
  }));
  const inserted = rows.length ? await d.store.saveLeads(rows) : [];
  t.newLeads = inserted.length;
  t.newCompanies = new Set(inserted.map((l) => l.edrpou).filter((e) => e && !knownCo.has(e))).size;
  t.inCrm = inserted.filter((l) => l.kommoCompanyExisting != null).length;
  for (const l of inserted) for (const n of l.niches) t.byNiche[n] = (t.byNiche[n] ?? 0) + 1;

  return { tally: t, launch, leads: inserted, verdict: runVerdict(t) };
}
