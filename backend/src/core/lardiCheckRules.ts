/**
 * 🔎 «ПЕРЕВІРИТИ НОМЕР НА ЛАРДІ» (задача 8136, ТЗ Юлі; регламент лідогенерації 04.11.2026) — чисті правила.
 *
 * Навіщо: лідгени передавали менеджерам прорахунки від експедицій, чиї вантажі вже висять на Ларді з ціною. Акаунта
 * Ларді в лідгенів немає, тож номер перевіряє дашборд і показує, що про нього відомо.
 *
 * 🔴 ЩО ЛАРДІ ВІДДАЄ, А ЩО НІ (заміряно живими запитами 13.11.2026):
 *  · `GET /v2/users/search?query=<номер>` працює в базовому API — назва, місто, відгуки, дата реєстрації;
 *  · поля «тип компанії» (вантажовідправник / експедиція / перевізник) в API НЕМАЄ — ні в пошуку, ні в «розширених
 *    даних користувача». Тому тип тут НЕ стверджується: вердикт каже лише те, що видно, — «розміщує вантажі»,
 *    «розміщує машини», «заявок не бачимо», «не знайдено»;
 *  · заявки компанії (`/v2/proposals/search/*` з `companyRefId`) і ознака «лише відправники» (`onlyShippers`) — тільки з
 *    пакетом «Розширений доступ до API». 13.11.2026 пакет не діяв (403), тож заявки беремо з ВЛАСНОГО архіву
 *    `lardi_offers` — він збирає лише маршрути, які шукали в калькуляторі ставок, і це НЕ весь Ларді. Про це чесно
 *    каже підпис на екрані: «немає в архіві» не означає «немає на Ларді».
 */

/** Вікно архіву: заявка старша вже не «висить на Ларді». */
export const LARDI_CHECK_DAYS = 30;
/** Скільки останніх заявок показуємо в списку (число «усього» рахується окремо). */
export const LARDI_CHECK_LIST = 12;

/**
 * Останні 9 цифр номера — ключ звірки (Ларді пише «+380…», люди вводять «067…», «380…», з дужками й пробілами).
 * Менше 9 цифр — не номер: шукати за уривком означало б показати чужу компанію.
 */
export function phone9(input: unknown): string | null {
  const digits = String(input ?? "").replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 13 ? digits.slice(-9) : null;
}

export interface LardiUser { refId: number; name: string; town: string | null; positive: number; negative: number; since: string | null }

/** Відповідь `/v2/users/search` → наш вигляд. Чуже поле, якого не чекали, відкидається; не масив — порожньо. */
export function parseLardiUsers(json: unknown): LardiUser[] {
  if (!Array.isArray(json)) return [];
  const out: LardiUser[] = [];
  for (const raw of json) {
    const u = raw as { refId?: unknown; name?: unknown; address?: { town?: { name?: unknown } }; createDate?: unknown;
      rating?: { positiveCommentCount?: unknown; negativeCommentCount?: unknown } };
    const refId = Number(u?.refId);
    const name = typeof u?.name === "string" ? u.name.trim() : "";
    if (!Number.isFinite(refId) || refId <= 0 || !name) continue;
    const ms = Number(u.createDate);
    out.push({
      refId, name,
      town: typeof u.address?.town?.name === "string" && u.address.town.name ? u.address.town.name : null,
      positive: Math.max(0, Number(u.rating?.positiveCommentCount) || 0),
      negative: Math.max(0, Number(u.rating?.negativeCommentCount) || 0),
      since: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null,
    });
  }
  return out;
}

export type LardiCheckKind = "cargo" | "carrier" | "known" | "none";
export interface LardiVerdict { kind: LardiCheckKind; title: string; advice: string; pass: boolean | null }

/**
 * Вердикт — від того, що ВИДНО, у порядку сили доказу:
 *  1) є заявки ВАНТАЖУ — вантаж уже на Ларді (саме те, від чого захищає задача) → не передавати;
 *  2) лише заявки МАШИН — перевізник → не передавати;
 *  3) знайдений на Ларді, заявок у нашому архіві немає — тип невідомий, рішення за лідгеном (`pass: null`);
 *  4) не знайдено ніде → схоже на вантажовідправника, можна передавати.
 * `liveOk=false` (Ларді не відповів) при порожньому архіві — НЕ «не знайдено»: відповіді просто немає (`pass: null`).
 */
export function lardiVerdict(x: { users: number; cargo: number; lorry: number; liveOk: boolean }): LardiVerdict {
  if (x.cargo > 0) {
    return { kind: "cargo", pass: false,
      title: x.lorry > 0 ? "Розміщує на Ларді і вантажі, і машини" : "Розміщує вантажі на Ларді",
      advice: "Вантаж цієї компанії вже висить на Ларді — менеджеру не передавати." };
  }
  if (x.lorry > 0) return { kind: "carrier", pass: false, title: "Перевізник: розміщує на Ларді машини", advice: "Це перевізник, а не замовник — не передавати." };
  if (x.users > 0) {
    return { kind: "known", pass: null, title: "Зареєстрований на Ларді, заявок у нашому архіві немає",
      advice: "Тип компанії Ларді не віддає. Подивіться на назву: «транс», «логістик», «експедиція» — ознака посередника." };
  }
  if (!x.liveOk) {
    return { kind: "none", pass: null, title: "Ларді зараз не відповів, в архіві номера немає",
      advice: "Перевірте ще раз за кілька хвилин — відповіді від Ларді немає, тож висновку теж." };
  }
  return { kind: "none", pass: true, title: "На Ларді не знайдено", advice: "Схоже на вантажовідправника — можна передавати." };
}

export interface ArchiveOffer {
  side: "cargo" | "lorry"; offerId: string; company: string | null; face: string | null;
  from: string | null; to: string | null; cargo: string | null; mass: number | null;
  total: number | null; currency: string | null; negotiable: boolean; seenAt: string;
}

/** Підсумок архіву: числа — по ВСІХ заявках вікна, список — останні `LARDI_CHECK_LIST` вантажів (ціна — головне для лідгена). */
export function archiveSummary(offers: readonly ArchiveOffer[]) {
  const cargo = offers.filter((o) => o.side === "cargo"), lorry = offers.filter((o) => o.side === "lorry");
  const routes = new Set(cargo.map((o) => `${o.from ?? ""}→${o.to ?? ""}`)).size;
  const byDate = (a: ArchiveOffer, b: ArchiveOffer) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0);
  const names = [...new Set(offers.map((o) => o.company).filter((s): s is string => !!s))];
  return {
    cargo: cargo.length, lorry: lorry.length, routes,
    withPrice: cargo.filter((o) => o.total != null && o.total > 0).length,
    companies: names.slice(0, 5),
    last: [...cargo].sort(byDate).slice(0, LARDI_CHECK_LIST),
    lastLorry: [...lorry].sort(byDate).slice(0, 5),
  };
}
