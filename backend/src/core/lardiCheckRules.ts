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

export interface LardiUser {
  refId: number; name: string; town: string | null; positive: number; negative: number; since: string | null;
  /** Код фірми з профілю Ларді (ЄДРПОУ — 8 цифр, ІПН ФОП — 10). `null` — Ларді не віддав або віддав не код. */
  firmCode: string | null;
}

/**
 * `firmCode` Ларді → код для реєстру. Лише 8 (ЄДРПОУ) або 10 (ІПН ФОП) цифр; решта — `null` ТУТ, один раз (правило 5:
 * сентинел перетворюється на «немає» в парсері, а не в кожного читача). Пробіли й дефіси прибираємо, літери — ні:
 * «АА123456» (паспорт ФОП, що відмовився від ІПН) — не код, за ним реєстр не шукаємо.
 */
export function firmCode(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = String(v).replace(/[\s-]/g, "");
  if (!/^\d+$/.test(t) || !(t.length === 8 || t.length === 10) || /^0+$/.test(t)) return null;
  return t;
}

/** Профіль Ларді (`GET /v2/users/user/{refId}`, структура «Пользователь») → лише код фірми. Не обʼєкт — `null`. */
export function parseLardiProfile(json: unknown): { firmCode: string | null } | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  return { firmCode: firmCode((json as { firmCode?: unknown }).firmCode) };
}

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
      firmCode: firmCode((raw as { firmCode?: unknown }).firmCode),
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

/*
 * 🏛 ВИД ДІЯЛЬНОСТІ З ЄДР (YouControl) ДЛЯ ЗНАЙДЕНОГО НА ЛАРДІ (24.11.2026, Роман: «автоматично … перевіряти тип його
 * діяльності просто і все»). Ларді типу компанії не віддає, зате віддає `firmCode` у профілі (структура «Пользователь»,
 * `GET /v2/users/user/{refId}`, базовий доступ — за документацією api.lardi-trans.com/v2/docs). За цим кодом ЄДР через
 * YouControl (`GET /v1/usr/{код}`, 1 транзакція) дає КВЕДи.
 *
 * 🔴 ВЕРДИКТ НЕ ЧІПАЄМО. Екран показує КВЕД як ФАКТ ЄДР; висновку «це експедиція — не передавати» тут немає: такого
 * правила в словнику немає, і рішення 24.11 — «лише показати вид діяльності». Підсвітка «транспорт» — назва РОЗДІЛУ
 * КВЕД-2010 (секція H), а не наш висновок про компанію.
 *
 * Поля відповіді YouControl — з прикладу у swagger (`economicActivities[] {code, description, isMain}`,
 * `mainEconomicActivity {code, description}`). Схема ФОП у специфікації не описана (посилання на зовнішній документ),
 * тому розбір терпимий до інших назв масиву, а невпізнане — порожній список, НЕ вигадана діяльність.
 */
export interface RegistryActivity {
  code: string; name: string; main: boolean;
  /** Назва транспортного розділу КВЕД (`transportDivision`), якщо код у ньому, інакше `null`. Рахує сервер — фронт не тримає копії. */
  transport: string | null;
  /** Код за старим КВЕД-2005 («NN.NN.N») — екран підписує, бо номери розділів там інші. */
  old: boolean;
}
export interface RegistryInfo {
  code: string; name: string | null; fop: boolean;
  /** Дата реєстрації в ЄДР (YYYY-MM-DD) або `null`, якщо реєстр її не віддав. */
  registered: string | null;
  /** Стан словами ЄДР, як є («Не перебуває в процесі припинення», «припинено»…). */
  status: string | null;
  /** Припиняється / припинена / банкрут — екран показує червоним. */
  closing: boolean;
  /** Основний — першим; далі решта в порядку ЄДР, без повторів. Порожньо — реєстр видів діяльності не віддав. */
  activities: RegistryActivity[];
  /** Дані з архіву YouControl (`showCurrentData=true`), бо ЄДР саме оновлювався. Екран це підписує. */
  archived: boolean;
}

/** Розділи секції H «Транспорт, складське господарство…» КВЕД-2010 — офіційні назви. */
export const TRANSPORT_DIVISIONS: Readonly<Record<string, string>> = {
  "49": "Наземний і трубопровідний транспорт",
  "50": "Водний транспорт",
  "51": "Авіаційний транспорт",
  "52": "Складське господарство та допоміжна діяльність у сфері транспорту",
};
/**
 * 🔴 СТАРИЙ КЛАСИФІКАТОР КВЕД-2005 — ІНШІ НОМЕРИ РОЗДІЛІВ. Заміряно на проді 24.11.2026: архівна картка YouControl
 * (`showCurrentData=true`) юрособи віддала коди «51.47.9», «60.24.0», «52.48.9» — три рівні, КВЕД-2005. У ньому 51/52 —
 * ТОРГІВЛЯ, а транспорт — секція I, розділи 60-63. Звіряти «51.47.9» з таблицею 2010 означало б назвати оптову торгівлю
 * авіаційним транспортом. Формат розрізняє їх однозначно: «NN.NN» — 2010, «NN.NN.N» — 2005.
 */
export const TRANSPORT_DIVISIONS_2005: Readonly<Record<string, string>> = {
  "60": "Діяльність сухопутного транспорту",
  "61": "Діяльність водного транспорту",
  "62": "Діяльність авіаційного транспорту",
  "63": "Допоміжна та додаткова транспортна діяльність",
};
const KVED_2010 = /^(\d{2})\.\d{1,2}$/;
const KVED_2005 = /^(\d{2})\.\d{2}\.\d$/;
/** Код КВЕД («NN.NN» — 2010 або «NN.NN.N» — 2005) → назва транспортного розділу свого класифікатора, інакше `null`. */
export function transportDivision(code: string): string | null {
  const t = code.trim();
  const m10 = KVED_2010.exec(t);
  if (m10) return TRANSPORT_DIVISIONS[m10[1]] ?? null;
  const m05 = KVED_2005.exec(t);
  return m05 ? TRANSPORT_DIVISIONS_2005[m05[1]] ?? null : null;
}
/** «ОПТОВА ТОРГІВЛЯ …» (так ЄДР віддає старі записи) → «Оптова торгівля …». Звичайний регістр не чіпаємо. */
export function readableName(name: string): string {
  const t = name.trim().replace(/\s+/g, " ");
  if (!/\p{L}/u.test(t) || t !== t.toUpperCase()) return t;
  const low = t.toLowerCase();
  return low.charAt(0).toUpperCase() + low.slice(1);
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
function activity(raw: unknown, main: boolean): RegistryActivity | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const code = s(a.code ?? a.kved ?? a.kvedCode);
  const old = KVED_2005.test(code);
  if (!old && !KVED_2010.test(code)) return null;
  const name = readableName(s(a.description ?? a.name ?? a.title));
  return { code, name, main: main || a.isMain === true || a.isPrimary === true || a.main === true, transport: transportDivision(code), old };
}
function ymd(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : (/^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : d.toISOString().slice(0, 10));
}

/** Відповідь `/v1/usr/{код}` → що показує лідгену. Не обʼєкт — `null` (це не «компанія без діяльності»). */
export function parseRegistry(code: string, usr: unknown): RegistryInfo | null {
  if (!usr || typeof usr !== "object" || Array.isArray(usr)) return null;
  const u = usr as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const fop = code.length === 10 || /ФОП|фізична особа-підприєм/i.test(s(u.contractorType)) || typeof u.name === "string";
  const name = typeof u.name === "string" ? s(u.name) : s(u.name?.shortName) || s(u.name?.fullName) || s(u.legalPersonName);
  const list: RegistryActivity[] = [];
  const push = (a: RegistryActivity | null) => {
    if (!a) return;
    const at = list.findIndex((x) => x.code === a.code);
    if (at < 0) list.push(a);
    else if (a.main) list[at] = { ...list[at], main: true, name: list[at].name || a.name };
  };
  push(activity(u.mainEconomicActivity, true));
  for (const key of ["economicActivities", "activities", "activityKinds", "kveds"]) {
    if (Array.isArray(u[key])) for (const a of u[key]) push(activity(a, false));
  }
  // Основний — рівно один і першим: якщо реєстр позначив кілька, перший позначений лишається основним.
  const mainAt = list.findIndex((a) => a.main);
  const activities = list.map((a, i) => ({ ...a, main: i === mainAt }));
  if (mainAt > 0) activities.unshift(...activities.splice(mainAt, 1));
  const status = s(u.status) || null;
  const closing = !!(s(u.registrationOfTermination?.status) || s(u.terminationStatus?.status) || u.bankruptcyStatus
    || (status && /припинен/i.test(status) && !/не перебуває/i.test(status)));
  return {
    code, name: name || null, fop, status, closing, activities, archived: false,
    registered: ymd(u.registrationAfterLaw?.entryDate) ?? ymd(u.registrationBeforeLaw?.date) ?? ymd(u.registrationDate),
  };
}
