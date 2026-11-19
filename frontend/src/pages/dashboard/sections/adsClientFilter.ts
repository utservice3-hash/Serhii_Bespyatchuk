/**
 * 🔎 ФІЛЬТРИ ТАБЛИЦІ «КЛІЄНТИ З РЕКЛАМИ · ЗА LTV» (TOP Weekly 16.11.2026, Сергій 18:52: «фільтр по кількості угод»;
 * Роман 19.11: «додаємо фільтри», дизайн — варіант А).
 *
 * Чистий модуль без React: його виконує гейт `#3318b` (транспіляцією), а екран (`AdsRegulars.tsx`) лише кличе.
 * Фільтри діють ЛИШЕ на список клієнтів — плитки, кампанії, когорти й склад не рухаються.
 *
 *  • «Угод від N» — за колонкою «Угод» (успішні угоди від першого рекламного ліда). Замір 19.11: від 2 — 153, від 3 — 67,
 *    від 5 — 26, від 10 — 8 з 1 674. ⚠️ Чип «Стали постійними» бере постійного з ядра (2+ успішні за ВСЮ історію), тому
 *    «від 2» і цей чип — різні множини, і так має бути.
 *  • Тип — той, що в колонці: постійний → його сегмент ядра (ВІП / регулярний / епізодичний / ще без типу), інакше «разовий».
 *  • Кампанія — «з міткою» / «без мітки» / конкретна (рядок мітки першого рекламного ліда, як у таблиці кампаній).
 *  • Стан — стан клієнта ядра; «невідомий» — у ядра стану немає.
 *  • Пошук — підрядок назви без регістру, лапки й зайві пробіли не важать.
 */
export type AdsClientType = "vip" | "regular" | "episodic" | "unknown" | "once";
export type AdsClientStateKey = "active" | "sleeping" | "lost" | "none";
export type AdsCampFilter = null | "tagged" | "untagged" | { name: string };

export interface AdsFilterRow {
  name: string; campaign: string | null; qualified: boolean;
  segment: "vip" | "regular" | "episodic" | "unknown"; state: "active" | "sleeping" | "lost" | null;
  deals: number; margin: number; repeatMargin: number;
}
export interface AdsClientFilter {
  minDeals: number; type: AdsClientType | null; camp: AdsCampFilter; state: AdsClientStateKey | null; q: string;
}

export const DEAL_STEPS = [1, 2, 3, 5, 10] as const;
export const EMPTY_FILTER: AdsClientFilter = { minDeals: 1, type: null, camp: null, state: null, q: "" };

export const typeOf = (c: Pick<AdsFilterRow, "qualified" | "segment">): AdsClientType => (c.qualified ? c.segment : "once");
export const stateOf = (c: Pick<AdsFilterRow, "state">): AdsClientStateKey => c.state ?? "none";

const norm = (s: string) => s.toLocaleLowerCase("uk-UA").replace(/["'«»„“”`]/g, "").replace(/\s+/g, " ").trim();

export function matchAdsClient(c: AdsFilterRow, f: AdsClientFilter): boolean {
  if (c.deals < f.minDeals) return false;
  if (f.type !== null && typeOf(c) !== f.type) return false;
  if (f.state !== null && stateOf(c) !== f.state) return false;
  if (f.camp === "tagged" && c.campaign === null) return false;
  if (f.camp === "untagged" && c.campaign !== null) return false;
  if (f.camp !== null && typeof f.camp === "object" && c.campaign !== f.camp.name) return false;
  const q = norm(f.q);
  if (q && !norm(c.name).includes(q)) return false;
  return true;
}

export const filterAdsClients = <T extends AdsFilterRow>(list: readonly T[], f: AdsClientFilter): T[] =>
  list.filter((c) => matchAdsClient(c, f));

/** Підсумок над таблицею — рівно по показаних (відфільтрованих) рядках. */
export function summarizeAdsClients(list: readonly AdsFilterRow[]): { clients: number; margin: number; repeat: number; active: number } {
  let margin = 0, repeat = 0, active = 0;
  for (const c of list) { margin += c.margin; repeat += c.repeatMargin; if (c.state === "active") active += 1; }
  return { clients: list.length, margin, repeat, active };
}

/** Скільки фільтрів увімкнено (без пошуку) — для «Скинути». */
export const activeFilterCount = (f: AdsClientFilter): number =>
  Number(f.minDeals > 1) + Number(f.type !== null) + Number(f.camp !== null) + Number(f.state !== null);
