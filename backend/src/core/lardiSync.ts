/**
 * 🛰 ЖИВИЙ СКАН ЛАРДІ ДЛЯ «ХАНТИНГУ» (16.11.2026, ТЗ Івана п.4–6, прохід 3) — ЧИСТІ правила, без пулу й конфігу.
 *
 * ⚠️ ПИСАНО ЗА ДОКУМЕНТАЦІЄЮ, А НЕ ЗА ЖИВОЮ ВІДПОВІДДЮ. Пошук Ларді з 12.11.2026 віддає 403 (не оплачено «Розширений
 * доступ до API»), тож форма відповіді звірена лише з api.lardi-trans.com/v2/docs (структури «Груз», «Владелец заявки»,
 * «Повтор», «Точка загрузки», «Фильтр по грузу»). Перший прохід після оплати — це й є приймання: розбір мусить дати
 * ненульові `refId`/`dateCreate`, інакше `parseProposal` повертає null і `runLardiSync` падає з назвою поля.
 *
 * Що звідки (документація):
 *  · `dateCreate` / `dateRepeat` (мс) — справжній час публікації й підняття, а не час нашого скану. Тому «за годину» й
 *    «години публікації» рахуються лише з живих подій; архів `collectLardi` (раз на 3 год) для цього не годиться;
 *  · `repeat.auto` — Ларді сам каже, що ввімкнено автоповтор; `repeat.countToday` — скільки разів підняли сьогодні;
 *  · `owner.refId` — компанія, `owner.contactId` — менеджер компанії; телефони — `owner.phones[].number`;
 *  · `waypointList*[0].country.sign` — країна (UA ↔ міжнародні), `area.name` — область;
 *  · типу компанії в заявці НЕМАЄ. Є фільтр пошуку `onlyShippers` — ним окремим сканом збираємо `refId` вантажовласників.
 */

export const SYNC_KINDS = ["cargo", "lorry"] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

type Any = Record<string, unknown>;
const obj = (v: unknown): Any => (v && typeof v === "object" && !Array.isArray(v) ? (v as Any) : {});
const arr = (v: unknown): Any[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as Any[] : []);
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };
const txt = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** Мітка часу Ларді — мілісекунди; секунди (10 цифр) теж приймаємо, щоб не отримати 1970 рік. */
export function lardiTime(v: unknown): string | null {
  const n = num(v);
  if (!n || n < 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface Proposal {
  kind: SyncKind; id: number; refId: number; contactId: number | null;
  company: string | null; face: string | null; phones: { n: string; m: unknown[] }[];
  fromTown: string | null; fromArea: string | null; fromCountry: string | null;
  toTown: string | null; toArea: string | null; toCountry: string | null;
  price: number | null; currency: string | null; autoRepeat: boolean; repeatsToday: number;
  createdAt: string; repeatedAt: string | null;
}

function point(list: unknown) {
  const p = obj(arr(list)[0]);
  return { town: txt(obj(p.town).name) ?? txt(obj(p.area).name), area: txt(obj(p.area).name), country: txt(obj(p.country).sign)?.toUpperCase() ?? null };
}

/** Одна заявка зі структури Ларді. null — якщо бракує того, без чого подію не порахувати (id, власник, дата створення). */
export function parseProposal(kind: SyncKind, it: unknown): Proposal | null {
  const o = obj(it);
  const id = num(o.id), owner = obj(o.owner), refId = num(owner.refId), createdAt = lardiTime(o.dateCreate);
  if (!id || !refId || !createdAt) return null;
  const f = point(o.waypointListSource), t = point(o.waypointListTarget);
  const pay = obj(o.payment), rep = obj(o.repeat);
  const phones = arr(owner.phones).map((p) => ({ n: String(p.number ?? "").trim(), m: Array.isArray(p.messengers) ? p.messengers : [] })).filter((p) => p.n);
  const repeatedAt = lardiTime(o.dateRepeat);
  return {
    kind, id, refId, contactId: num(owner.contactId), company: txt(owner.name), face: txt(owner.face), phones,
    fromTown: f.town, fromArea: f.area, fromCountry: f.country, toTown: t.town, toArea: t.area, toCountry: t.country,
    price: num(pay.value), currency: txt(obj(pay.currency).name), autoRepeat: rep.auto === true,
    repeatsToday: Math.max(0, Math.trunc(Number(rep.countToday) || 0)),
    // «Повтор» раніше створення — це не підняття, а та сама публікація.
    createdAt, repeatedAt: repeatedAt && repeatedAt > createdAt ? repeatedAt : null,
  };
}

/**
 * Які події дає заявка проти того, що ми вже знаємо (ТЗ п.4 «Upsert»):
 *  · не бачили — подія `new` на `dateCreate`, і якщо вже піднята — ще `repeat` на `dateRepeat`;
 *  · бачили — `repeat`, лише якщо `dateRepeat` зрушив ВПЕРЕД. Та сама дата підняття двічі — одна подія.
 */
export function eventsFor(p: Proposal, knownRepeatAt: string | null | undefined): { type: "new" | "repeat"; at: string }[] {
  const out: { type: "new" | "repeat"; at: string }[] = [];
  if (knownRepeatAt === undefined) out.push({ type: "new", at: p.createdAt });
  const last = knownRepeatAt ?? p.createdAt;
  if (p.repeatedAt && p.repeatedAt > last) out.push({ type: "repeat", at: p.repeatedAt });
  return out;
}

/**
 * «Схоже на автоповтор» (ТЗ п.6): Ларді сам каже `repeat.auto`, АБО за будь-які 10 хв понад 20 подій, АБО інтервали
 * між подіями майже однакові (≥ 6 інтервалів, розкид < 10% від середнього). Рядки не прибираємо — лише позначаємо.
 */
export const BOT_BURST = 20;
export const BOT_WINDOW_MS = 10 * 60_000;
export function botLike(times: string[], autoFlag: boolean): boolean {
  if (autoFlag) return true;
  const ts = times.map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
  for (let i = 0, j = 0; j < ts.length; j++) {
    while (ts[j] - ts[i] > BOT_WINDOW_MS) i++;
    if (j - i + 1 > BOT_BURST) return true;
  }
  const gaps = ts.slice(1).map((t, k) => t - ts[k]).filter((g) => g > 0);
  if (gaps.length < 6) return false;
  const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return sd / mean < 0.1;
}

/** «Зазвичай публікує з … до …» (ТЗ п.6): години Києва, що разом покривають ≥ 80% подій, від першої до останньої. */
export function typicalHours(times: string[]): { from: number; to: number; n: number } | null {
  const hours = times.map((t) => Number(new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Kyiv" }).format(new Date(t))))
    .filter(Number.isFinite);
  if (hours.length < 3) return null;
  const by = new Array<number>(24).fill(0);
  for (const h of hours) by[h]++;
  const ranked = by.map((n, h) => ({ h, n })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.h - b.h);
  const keep: number[] = [];
  let acc = 0;
  for (const x of ranked) { keep.push(x.h); acc += x.n; if (acc >= hours.length * 0.8) break; }
  return { from: Math.min(...keep), to: Math.max(...keep) + 1, n: hours.length };
}

/**
 * Що скануємо (ТЗ п.4 «Фільтри сканування»; відкрите питання ТЗ «лише UA→UA чи ще міжнародку» — беремо ОБИДВА, як у
 * переліку фільтрів ТЗ). `directionFrom` у Ларді обовʼязковий, тож міжнародку «в Україну» скануємо від сусідів.
 */
export const INBOUND_COUNTRIES = ["PL", "MD", "RO", "HU", "SK", "LT", "DE", "CZ"] as const;
export interface ScanSpec { label: string; filter: Any; shippers?: boolean }
export function scanPlan(): ScanSpec[] {
  const dir = (sign: string) => ({ directionRows: [{ countrySign: sign }] });
  return [
    { label: "з України", filter: { directionFrom: dir("UA") } },
    ...INBOUND_COUNTRIES.map((c) => ({ label: `${c} → Україна`, filter: { directionFrom: dir(c), directionTo: dir("UA") } })),
    // Вантажовласники: окремий скан з фільтром Ларді `onlyShippers` — лише щоб дізнатись їхні `refId`.
    { label: "вантажовласники з України", filter: { directionFrom: dir("UA"), onlyShippers: true }, shippers: true },
  ];
}

export const DENIED = [401, 402, 403];
export const PAGE_SIZE = 100;
export const MAX_PAGES = 20;
export const BACKOFF_MS = [30_000, 60_000, 120_000];

export interface PageAnswer { code: number; items: unknown[] | null; pages: number | null; detail: string }
export interface SyncDeps {
  search: (kind: SyncKind, filter: Any, page: number) => Promise<PageAnswer>;
  /** Записати сторінку; повертає, скільки заявок на ній ми бачили вперше. */
  record: (items: Proposal[]) => Promise<{ fresh: number; events: number }>;
  shippers: (refIds: number[]) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}
export interface SyncTally { requests: number; ok: number; seen: number; fresh: number; events: number; unparsed: number; shippers: number; retries: number }

/** Текст відмови Ларді — `message` з JSON, інакше початок сирого тексту. */
export function lardiReason(detail: string): string {
  try { const j = JSON.parse(detail) as { message?: unknown }; if (typeof j.message === "string" && j.message.trim()) return j.message.trim(); } catch { /* не JSON */ }
  return detail.trim().slice(0, 200) || "без тексту";
}

/**
 * Один прохід. Сторінки йдуть, поки на сторінці є хоч одна нова або піднята заявка (ТЗ: «до заявок, які вже бачили»), але не далі
 * `MAX_PAGES`. 401/402/403 — про обліковий запис, тож зупиняємось на першій і падаємо з текстом Ларді (→ «АВАРІЯ»).
 * 429 — пауза 30/60/120 с і повтор; після третьої — падіння. Жодної 200 за прохід — теж падіння: нуль тут аварія.
 * Заявки, які не вдалось розібрати, рахуються окремо: якщо розібрано НУЛЬ із ненульової сторінки — падіння з назвою
 * полів (форма відповіді розійшлась із документацією — перше, що треба побачити після оплати пакета).
 */
export async function runLardiSync(deps: SyncDeps, plan: ScanSpec[] = scanPlan()): Promise<SyncTally> {
  const t: SyncTally = { requests: 0, ok: 0, seen: 0, fresh: 0, events: 0, unparsed: 0, shippers: 0, retries: 0 };
  for (const spec of plan) {
    for (const kind of spec.shippers ? (["cargo"] as const) : SYNC_KINDS) {
      for (let page = 1; page <= (spec.shippers ? 5 : MAX_PAGES); page++) {
        let r: PageAnswer;
        for (let attempt = 0; ; attempt++) {
          t.requests++;
          r = await deps.search(kind, spec.filter, page);
          if (r.code !== 429) break;
          if (attempt >= BACKOFF_MS.length) throw new Error(`Ларді 429: ліміт запитів не відпустив після ${String(BACKOFF_MS.length)} пауз (${spec.label})`);
          t.retries++;
          await deps.sleep(BACKOFF_MS[attempt]);
        }
        if (DENIED.includes(r.code)) throw new Error(`Ларді ${String(r.code)}: ${lardiReason(r.detail)}`);
        if (r.code !== 200 || !r.items) break; // поодинокий збій — наступний скан
        t.ok++;
        const parsed = r.items.map((it) => parseProposal(kind, it));
        const good = parsed.filter((p): p is Proposal => p !== null);
        t.unparsed += parsed.length - good.length;
        if (r.items.length && !good.length) {
          const keys = Object.keys(obj(r.items[0])).slice(0, 12).join(", ");
          throw new Error(`Ларді: жодної заявки не розібрано (${spec.label}, ${kind}) — бракує id / owner.refId / dateCreate. Поля першої: ${keys}`);
        }
        t.seen += good.length;
        if (spec.shippers) {
          const ids = [...new Set(good.map((p) => p.refId))];
          await deps.shippers(ids);
          t.shippers += ids.length;
        } else {
          const w = await deps.record(good);
          t.fresh += w.fresh; t.events += w.events;
          if (w.fresh === 0 && w.events === 0) break; // на сторінці ні нових, ні піднятих — далі лише вже бачені
        }
        if (!good.length || (r.pages != null && page >= r.pages)) break;
        await deps.sleep(1000);
      }
    }
  }
  if (t.requests > 0 && t.ok === 0) throw new Error(`Ларді не відповів жодного разу: ${String(t.requests)} запитів`);
  return t;
}
