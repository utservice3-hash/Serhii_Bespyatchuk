/**
 * 🏛 PROZORRO-ЛІДИ — ЧИСТІ ПРАВИЛА (задача #5299, ТЗ «Щоденний збір лідів з Prozorro у Kommo»; прохід 1, 21.10.2026).
 *
 * Без мережі, без пулу, без конфігу: гейти ганяють їх у кожному `npm test`.
 *
 * Рішення Романа 21.10.2026, з якими звірено правила нижче:
 *  · беремо ЛИШЕ ПЕРЕМОЖЦІВ (не учасників), вся Україна;
 *  · поріг — сума виграшу від 500 000 ₴ (`DEFAULT_MIN_AMOUNT`, міняється змінною `PROZORRO_MIN_AMOUNT`);
 *  · БЕЗ прогону за 6 місяців: лише переможці, визначені ПІСЛЯ запуску (`launchAt`);
 *  · без фільтра за кодом ДК021 — код лише показується в картці, як у ТЗ.
 *
 * 📐 Що заміряно до коду (21.10.2026, живий Prozorro):
 *  · пошук `POST /api/search/tenders` НЕ фільтрує за датою (параметри дати мовчки ігноруються) і віддає тендери
 *    впереміш, аж до 2024 року. Тому «нове» визначаємо самі: тендер, якого ще не бачили, і переможець після запуску;
 *  · сторінка пошуку — 20 тендерів; глибше 10 сторінок на слово й старше 60 днів від номера тендера не ходимо —
 *    так проба 21.10 зібрала 14 535 тендерів із переможцем на ~1 300 запитах;
 *  · ~4 запити/с Prozorro вже відповідає 429, тож ліміт — 2/с (`MIN_INTERVAL_MS`), а не 5, як у ТЗ.
 */

export const SEARCH_URL = "https://prozorro.gov.ua/api/search/tenders";
export const summaryUrl = (uaId: string): string => `https://prozorro.gov.ua/api/tenders/${encodeURIComponent(uaId)}/summary`;
export const tenderApiUrl = (hexId: string): string => `https://public-api.prozorro.gov.ua/api/2.5/tenders/${encodeURIComponent(hexId)}`;
/** Посилання для менеджера — людська сторінка тендера. */
export const tenderUrl = (uaId: string): string => `https://prozorro.gov.ua/tender/${uaId}`;

/** Статуси, у яких переможця вже визначено. Учасників не беремо (рішення 21.10), тож ранні статуси не потрібні. */
export const SEARCH_STATUSES = ["active.awarded", "complete"] as const;
export const PAGE_SIZE = 20;
export const MAX_PAGES = 10;
export const ID_FLOOR_DAYS = 60;
export const MIN_INTERVAL_MS = 500;
export const DEFAULT_MIN_AMOUNT = 500_000;
/** ТЗ: «Alert якщо помилок API > 5%». */
export const MAX_ERROR_SHARE = 0.05;
/** ТЗ: «Alert якщо нема нових лідів 2 доби». */
export const QUIET_ALERT_HOURS = 48;
/** Скільки позицій тендера показувати в картці; решта — рядком «… ще N». */
export const CARD_MAX_ITEMS = 15;

// ── Форма даних Prozorro (лише поля, які читаємо; усе необовʼязкове — джерело зовнішнє) ──────────────────────────
export interface PzValue { amount?: number | null; currency?: string | null }
export interface PzSearchItem { tenderID: string; title?: string; status?: string; value?: PzValue | null }
export interface PzAddress { streetAddress?: string; locality?: string; region?: string; postalCode?: string }
export interface PzSupplier {
  name?: string;
  identifier?: { id?: string; legalName?: string; scheme?: string };
  address?: PzAddress;
  contactPoint?: { name?: string; telephone?: string; email?: string };
}
export interface PzAward { status?: string; date?: string; value?: PzValue | null; suppliers?: PzSupplier[] }
export interface PzItem {
  description?: string; quantity?: number | null; unit?: { name?: string } | null;
  classification?: { id?: string; description?: string } | null;
}
export interface PzTender {
  id?: string; tenderID?: string; title?: string; status?: string; dateModified?: string;
  procuringEntity?: { name?: string; identifier?: { legalName?: string }; address?: PzAddress };
  items?: PzItem[]; awards?: PzAward[]; value?: PzValue | null;
}

/** Переможець — один рядок на постачальника активного рішення (консорціум дає кілька). */
export interface Winner {
  edrpou: string | null;
  companyName: string;
  region: string | null;
  city: string | null;
  address: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  amount: number | null;
  currency: string | null;
  awardDate: string | null; // ISO, як віддає Prozorro
}

export type SkipReason = "no_edrpou" | "before_launch" | "currency" | "below";
export type Qualify = "ok" | SkipReason;

/** Дата з номера тендера: «UA-2026-10-05-000291-a» → «2026-10-05». Невідомий формат → "". */
export function tenderIdDate(uaId: string): string {
  return /^UA-(\d{4}-\d{2}-\d{2})-/.exec(uaId)?.[1] ?? "";
}

/** Найстаріша дата номера тендера, яку ще беремо з пошуку. */
export function idFloor(now: Date, days: number = ID_FLOOR_DAYS): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Чи гортати пошук далі: сторінка повна І на ній ще є свіжі тендери. Порожня/неповна/стара сторінка — стоп. */
export function pageContinues(items: readonly PzSearchItem[], floor: string): boolean {
  return items.length >= PAGE_SIZE && items.some((x) => tenderIdDate(x.tenderID) >= floor);
}

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
};
/** ЄДРПОУ (8 цифр) або ІПН ФОП (10 цифр); інше — не код. */
export function normEdrpou(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length === 8 || d.length === 10 ? d : null;
}

/** Переможці тендера: лише рішення зі статусом `active` (скасовані й відхилені — не переможці). */
export function winnersOf(t: PzTender): Winner[] {
  const out: Winner[] = [];
  for (const a of t.awards ?? []) {
    if (a.status !== "active") continue;
    for (const s of a.suppliers ?? []) {
      const adr = s.address ?? {};
      out.push({
        edrpou: normEdrpou(s.identifier?.id),
        companyName: clean(s.identifier?.legalName) ?? clean(s.name) ?? "без назви",
        region: clean(adr.region),
        city: clean(adr.locality),
        address: clean([adr.postalCode, adr.locality, adr.streetAddress].filter(Boolean).join(", ")),
        contactName: clean(s.contactPoint?.name),
        phone: clean(s.contactPoint?.telephone),
        email: clean(s.contactPoint?.email),
        amount: typeof a.value?.amount === "number" ? a.value.amount : null,
        currency: clean(a.value?.currency),
        awardDate: clean(a.date),
      });
    }
  }
  return out;
}

/**
 * Чи стає переможець лідом. Порядок перевірок — від «це взагалі не компанія» до «замало»:
 * без коду не дедуплікуємо (ТЗ: ключ — ЄДРПОУ), до запуску — не нове, не гривня — поріг не порівнюваний.
 */
export function qualifies(w: Winner, minAmount: number, launchAt: Date): Qualify {
  if (!w.edrpou) return "no_edrpou";
  const at = w.awardDate ? Date.parse(w.awardDate) : NaN;
  if (!Number.isFinite(at) || at < launchAt.getTime()) return "before_launch";
  if (w.currency !== "UAH") return "currency";
  if (w.amount == null || w.amount < minAmount) return "below";
  return "ok";
}

/** Момент запуску: найперша поява тендера в нашій таблиці; таблиця порожня — запуск саме зараз. */
export const launchAt = (firstSeenAt: Date | null, now: Date): Date => firstSeenAt ?? now;

/** Ключ дубля з ТЗ: (ЄДРПОУ + тендер + роль). */
export const leadKey = (edrpou: string, uaId: string, role = "winner"): string => `${edrpou}|${uaId}|${role}`;

const fmtQty = (q: number | null | undefined): string => (q == null ? "" : Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000));
export const fmtUah = (n: number): string => `${Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ")} ₴`;
const fmtDate = (iso: string | null): string => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime())
    ? d.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" })
    : "—";
};

/** Позиції як у ТЗ: «1. Генератор дизельний 100 кВт — 10 шт.»; понад `CARD_MAX_ITEMS` — рядок «… ще N позицій». */
export function formatItems(items: readonly PzItem[]): string[] {
  const lines = items.slice(0, CARD_MAX_ITEMS).map((it, i) => {
    const q = fmtQty(it.quantity);
    const unit = clean(it.unit?.name) ?? "шт.";
    return `${String(i + 1)}. ${clean(it.description) ?? "без опису"}${q ? ` — ${q} ${unit}` : ""}`;
  });
  if (items.length > CARD_MAX_ITEMS) lines.push(`… ще ${String(items.length - CARD_MAX_ITEMS)} позицій`);
  return lines;
}

/** Коди ДК021 тендера без повторів: «31120000-3 — Генератори». */
export function dk021Of(items: readonly PzItem[]): string[] {
  const seen = new Map<string, string>();
  for (const it of items) {
    const id = clean(it.classification?.id);
    if (id && !seen.has(id)) seen.set(id, clean(it.classification?.description) ?? "");
  }
  return [...seen].map(([id, d]) => (d ? `${id} — ${d}` : id));
}

/** Текст картки — те, що менеджер читає в угоді (ТЗ, розділ «Що показувати менеджеру»). */
export function cardText(t: PzTender, w: Winner, niches: readonly string[]): string {
  const buyer = clean(t.procuringEntity?.identifier?.legalName) ?? clean(t.procuringEntity?.name) ?? "—";
  const buyerRegion = clean(t.procuringEntity?.address?.region);
  const uaId = t.tenderID ?? "";
  const items = formatItems(t.items ?? []);
  const dk = dk021Of(t.items ?? []);
  return [
    `Тендер: ${clean(t.title) ?? "без назви"}`,
    "Позиції:",
    ...(items.length ? items : ["—"]),
    `ДК021: ${dk.length ? dk.join("; ") : "—"}`,
    `Замовник: ${buyer}${buyerRegion ? `, ${buyerRegion}` : ""}`,
    `Сума: ${w.amount == null ? "—" : w.currency === "UAH" ? fmtUah(w.amount) : `${String(w.amount)} ${w.currency ?? ""}`.trim()}`,
    `Дата рішення: ${fmtDate(w.awardDate)}`,
    "Роль: Переможець",
    `Ніша: ${niches.length ? niches.join(", ") : "—"}`,
    `Посилання: ${tenderUrl(uaId)}`,
  ].join("\n");
}

// ── Прохід: облік і вирок ─────────────────────────────────────────────────────────────────────────────────────────
export interface PzTally {
  keywords: number;
  searchRequests: number;
  searchOk: number;
  searchFail: number;
  candidates: number;
  /** Перший прохід: усе, що знайшли, записано «баченим» без деталей — бо прогону за минуле немає (рішення 21.10). */
  baseline: boolean;
  newTenders: number;
  fetched: number;
  detailFail: number;
  winners: number;
  qualified: number;
  skipped: Record<SkipReason, number>;
  newLeads: number;
  newCompanies: number;
  inCrm: number;
  byNiche: Record<string, number>;
  lastFail: string | null;
}

export const emptyTally = (): PzTally => ({
  keywords: 0, searchRequests: 0, searchOk: 0, searchFail: 0, candidates: 0, baseline: false, newTenders: 0, fetched: 0,
  detailFail: 0, winners: 0, qualified: 0, skipped: { no_edrpou: 0, before_launch: 0, currency: 0, below: 0 },
  newLeads: 0, newCompanies: 0, inCrm: 0, byNiche: {}, lastFail: null,
});

export const errorShare = (t: PzTally): number => {
  const req = t.searchRequests + t.fetched + t.detailFail;
  return req ? (t.searchFail + t.detailFail) / req : 0;
};

/**
 * Вирок проходу. Падіння джоби = тривога (джоба під наглядом), тож тут тільки те, що справді аварія:
 *  · пошук не відповів ЖОДНОГО разу — «нуль лідів» тут не вимір, а збій (клас «успіх із нулем», jobs-sync.md);
 *  · помилок API понад 5% (ТЗ) — дані неповні, і про це треба знати.
 */
export function runVerdict(t: PzTally): { ok: true } | { ok: false; error: string } {
  if (t.searchRequests > 0 && t.searchOk === 0) {
    return { ok: false, error: `Prozorro не відповів жодного разу: ${String(t.searchFail)} з ${String(t.searchRequests)} запитів пошуку невдалі`
      + (t.lastFail ? ` (остання помилка: ${t.lastFail})` : "") };
  }
  const share = errorShare(t);
  if (share > MAX_ERROR_SHARE) {
    return { ok: false, error: `Prozorro: помилок API ${String(Math.round(share * 1000) / 10)}% (поріг ${String(MAX_ERROR_SHARE * 100)}%)`
      + (t.lastFail ? `, остання: ${t.lastFail}` : "") };
  }
  return { ok: true };
}

/** «Нема нових лідів 2 доби» — лише коли збір уже працює довше за 2 доби (одразу після запуску тиша — норма). */
export function quietTooLong(lastLeadAt: Date | null, launch: Date, now: Date, hours: number = QUIET_ALERT_HOURS): boolean {
  const ms = hours * 3_600_000;
  if (now.getTime() - launch.getTime() < ms) return false;
  return lastLeadAt == null || now.getTime() - lastLeadAt.getTime() >= ms;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Ранковий звіт власнику в Telegram (HTML), за формою з ТЗ. */
export function reportText(t: PzTally, opts: { mode: "dry" | "live"; minAmount: number; quiet: boolean }): string {
  const top = Object.entries(t.byNiche).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([n, c]) => `${esc(n)} ${String(c)}`).join(", ");
  const lines = [
    "📊 <b>Prozorro сьогодні</b>",
    t.baseline
      ? `Перший прохід: ${String(t.candidates)} тендерів із переможцем записано як уже бачені. Ліди — з наступного дня, лише нові переможці.`
      : `Тендерів переглянуто: ${String(t.candidates)} · нових: ${String(t.newTenders)}`,
  ];
  if (!t.baseline) {
    lines.push(`Переможців від ${esc(fmtUah(opts.minAmount))}: ${String(t.newLeads)} · нових компаній: ${String(t.newCompanies)} · уже в CRM: ${String(t.inCrm)}`);
    if (top) lines.push(`Топ ніші: ${top}`);
    lines.push(`Не пройшли: менше порогу ${String(t.skipped.below)}, не гривня ${String(t.skipped.currency)}, без ЄДРПОУ ${String(t.skipped.no_edrpou)}, рішення до запуску ${String(t.skipped.before_launch)}`);
  }
  const share = errorShare(t);
  lines.push(`Помилок API: ${String(t.searchFail + t.detailFail)}${share ? ` (${String(Math.round(share * 1000) / 10)}%)` : ""}`);
  if (opts.quiet) lines.push("⚠️ Нових лідів немає вже 2 доби — перевірте, чи працює пошук.");
  lines.push(opts.mode === "dry" ? "Режим: пробний — у Kommo нічого не записано." : "Режим: бойовий.");
  return lines.join("\n");
}
