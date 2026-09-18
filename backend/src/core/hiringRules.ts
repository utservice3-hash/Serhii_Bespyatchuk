/**
 * 🧑‍💼 НАЙМ — ЧИСТІ ПРАВИЛА (прохід 1, 17.09.2026).
 *
 * Тут НЕМАЄ жодного імпорту з БД чи `config`: гейти мусять виконуватись у звичайному
 * `npm test`, а не лише проти прода (той самий клас, що `routeTab.ts`).
 *
 * Джерело правил — макет, який затвердив Іван (рекрутер) 16.09.2026, і рішення власника
 * 17.09.2026: Іван працює з роллю HR; «призначено» — заплановані співбесіди; «проведено» —
 * позначка «прийшов», рахується в день, коли її поставили, а не в день співбесіди.
 */

export const HIRING_STATUSES = [
  "new", "contacted", "planned", "done", "noshow", "noanswer", "lead",
  "candidate", "training", "manager", "refused", "black",
] as const;
export type HiringStatus = (typeof HIRING_STATUSES)[number];

export const STATUS_LABEL: Record<HiringStatus, string> = {
  new: "новий",
  contacted: "перше повідомлення",
  planned: "заплановано",
  done: "проведено",
  noshow: "не прийшов",
  noanswer: "недозвон",
  lead: "співбесіда з тімлідом",
  candidate: "кандидат + команда",
  training: "на навчанні",
  manager: "менеджер",
  refused: "відмова",
  black: "чорний список",
};

export const isHiringStatus = (s: unknown): s is HiringStatus =>
  typeof s === "string" && (HIRING_STATUSES as readonly string[]).includes(s);

/**
 * Наступні статуси (прохід 1a, 17.09.2026: макет затвердив Роман, шлях — за записом Хурми Івана).
 * «Відмова» й «чорний список» у цій мапі — лише як ЦІЛЬ дії з причиною (`REFUSAL_TARGETS`):
 * загальна зміна статусу в них не веде, інакше відмова лишилась би без причини (#520).
 * Старі `declined` і `nofit` злиті в «відмову» з причиною — одноразовою міграцією в схемі (#522).
 */
export const TRANSITIONS: Record<HiringStatus, HiringStatus[]> = {
  new: ["contacted", "planned", "noanswer", "refused", "black"],
  contacted: ["planned", "noanswer", "refused"],
  planned: ["done", "noshow", "noanswer", "refused"],
  done: ["lead", "refused"],
  noshow: ["planned", "refused"],
  noanswer: ["contacted", "planned", "refused"],
  lead: ["candidate", "refused"],
  candidate: ["training", "refused"],
  training: ["manager", "refused"],
  refused: ["contacted", "planned"],
  manager: [],
  black: [],
};

/** Тімлід працює лише з кандидатами після співбесіди з ним — свої етапи й відмова. */
export const LEAD_TRANSITIONS: Partial<Record<HiringStatus, HiringStatus[]>> = {
  lead: ["candidate", "refused"],
  candidate: ["training", "refused"],
  training: ["manager", "refused"],
};

/** Статуси, у які веде ЛИШЕ дія «відмовити» з причиною. */
export const REFUSAL_TARGETS: readonly HiringStatus[] = ["refused", "black"];

export const REFUSAL_SIDES = ["candidate", "company"] as const;
export type RefusalSide = (typeof REFUSAL_SIDES)[number];
export const REFUSAL_SIDE_LABEL: Record<RefusalSide, string> = { candidate: "відмова кандидата", company: "відмова компанії" };

export type RefusalVerdict = { ok: true; status: "refused" | "black" } | { ok: false; reason: string };

/**
 * Відмова як дія: причина обовʼязкова й мусить належати тій самій стороні; «чорний список» —
 * лише відмова компанії (кандидат сам себе в чорний список не вносить).
 */
export function refusalVerdict(p: {
  from: HiringStatus; access: HiringAccess; reasonSide: RefusalSide | null; blacklist: boolean;
}): RefusalVerdict {
  if (p.access === "none") return { ok: false, reason: "Немає доступу до найму" };
  if (!p.reasonSide) return { ok: false, reason: "Оберіть причину відмови — без неї відмова не зберігається" };
  const map = p.access === "lead" ? LEAD_TRANSITIONS : TRANSITIONS;
  if (!(map[p.from] ?? []).includes("refused"))
    return { ok: false, reason: `Зі статусу «${STATUS_LABEL[p.from]}» відмовити не можна` };
  if (p.blacklist && p.reasonSide !== "company")
    return { ok: false, reason: "У чорний список — лише при відмові компанії" };
  if (p.blacklist && p.access !== "edit") return { ok: false, reason: "Чорний список веде рекрутер" };
  return { ok: true, status: p.blacklist ? "black" : "refused" };
}

export const VACANCY_STATUSES = ["open", "in_work", "paused", "closed", "cancelled"] as const;
export type VacancyStatus = (typeof VACANCY_STATUSES)[number];
export const VACANCY_STATUS_LABEL: Record<VacancyStatus, string> = {
  open: "відкрита", in_work: "в роботі", paused: "на паузі", closed: "закрита", cancelled: "скасована",
};
export const VACANCY_RESULTS = ["Успішно закрита", "Скасував замовник", "Скасована"] as const;
/** Закриття вакансії: результат обовʼязковий і вирішує, «закрита» це чи «скасована». */
export function vacancyCloseStatus(result: unknown): VacancyStatus | null {
  if (result === "Успішно закрита") return "closed";
  if (result === "Скасував замовник" || result === "Скасована") return "cancelled";
  return null;
}

/** Файли-докази: скриншоти й PDF, до 5 МБ, до 20 на кандидата. */
export const HIRING_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const HIRING_FILES_PER_CANDIDATE = 20;
export const HIRING_FILE_MIMES = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;

/**
 * Тип файлу — за ПЕРШИМИ БАЙТАМИ, а не за словом клієнта: підписати `.exe` як `image/png`
 * нічого не коштує. Повертає справжній mime з білого списку або null.
 */
export function sniffFileMime(buf: Uint8Array): (typeof HIRING_FILE_MIMES)[number] | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => buf[i + k] === b);
  if (buf.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (buf.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (buf.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  if (buf.length >= 5 && at(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
}

/**
 * Імʼя файлу на диску. Файли-докази лежать у КОРЕНІ теки документів із префіксом `hiring-`:
 * нічний бекап (`jobs/backupDocuments.ts`) копіює лише файли кореня, без підтек (#524).
 */
export const hiringStoredName = (uuid: string, mime: (typeof HIRING_FILE_MIMES)[number]): string =>
  `hiring-${uuid}${{ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf" }[mime]}`;

/**
 * Посилання «написати» з картки. Telegram — за ніком, якщо він є (`@нік` чи `t.me/нік`), інакше за
 * номером; Viber і WhatsApp — лише за номером. Номер — через ту саму `normalizePhone`, що й ключ
 * дублів, тож «066 …» і «+380…» дають однакові посилання (#525).
 */
export function messengerLinks(phone: unknown, telegram: unknown): { telegram: string | null; viber: string | null; whatsapp: string | null } {
  const n = normalizePhone(phone);
  const intl = n && n.length >= 11 ? n : null;
  let tgUser: string | null = null;
  if (typeof telegram === "string") {
    const t = telegram.trim();
    const m = /^@([A-Za-z0-9_]{4,32})$/.exec(t) ?? /t\.me\/([A-Za-z0-9_]{4,32})\/?$/.exec(t) ?? /^([A-Za-z0-9_]{5,32})$/.exec(t);
    if (m) tgUser = m[1];
  }
  return {
    telegram: tgUser ? `https://t.me/${tgUser}` : intl ? `https://t.me/+${intl}` : null,
    viber: intl ? `viber://chat?number=%2B${intl}` : null,
    whatsapp: intl ? `https://wa.me/${intl}` : null,
  };
}

/** Перехід у ці статуси вимагає команди: до кого йде кандидат. */
export const NEEDS_TEAM: readonly HiringStatus[] = ["lead", "candidate"];

export type HiringAccess = "edit" | "lead" | "none";

/**
 * Хто що може в розділі. Вкладку `hiring` відкриває tab-гейт; ЦЕ — друга межа, всередині.
 * • edit — рекрутер (роль HR) і адмін-рівень: графік, база, звіт, будь-які переходи.
 * • lead — тімлід: лише кандидати своєї команди від етапу «з тімлідом».
 * • none — усі інші, навіть якщо адмін відкрив їм вкладку тумблером у Налаштуваннях
 *   (fail-closed: тумблер дає пункт меню, а не право бачити телефони кандидатів).
 */
export function hiringAccess(a: { roleKey: string; adminScope: boolean }): HiringAccess {
  if (a.adminScope || a.roleKey === "hr") return "edit";
  if (a.roleKey === "team_lead") return "lead";
  return "none";
}

export type TransitionVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Чи дозволений перехід.
 *
 * 🔁 СКАСОВНІСТЬ (правило власника 06.08.2026: дія в інтерфейсі мусить скасовуватись тим
 * самим інтерфейсом). Строга мапа переходів робить «чорний список» чи «менеджер» кінцевими —
 * помилковий клік без цього виправити було б нічим. Тому повернення РІВНО в статус, з якого
 * прийшла ОСТАННЯ зміна (`lastFrom`), дозволене завжди тому, хто може цю зміну зробити.
 */
export function canTransition(
  from: HiringStatus, to: HiringStatus, access: HiringAccess, lastFrom: HiringStatus | null,
): TransitionVerdict {
  if (access === "none") return { ok: false, reason: "Немає доступу до найму" };
  if (from === to) return { ok: false, reason: "Статус не змінився" };
  const map = access === "lead" ? LEAD_TRANSITIONS : TRANSITIONS;
  const leadScope = (s: HiringStatus) => ["lead", "candidate", "training", "manager", "refused"].includes(s);
  if (lastFrom === to && (access === "edit" || (leadScope(from) && leadScope(to))))
    return { ok: true };
  if (REFUSAL_TARGETS.includes(to) && lastFrom !== to)
    return { ok: false, reason: "Відмова — через дію «Відмовити» з причиною" };
  if ((map[from] ?? []).includes(to)) return { ok: true };
  return {
    ok: false,
    reason: access === "lead"
      ? `Тімлід не може перевести «${STATUS_LABEL[from]}» → «${STATUS_LABEL[to]}»`
      : `Перехід «${STATUS_LABEL[from]}» → «${STATUS_LABEL[to]}» не передбачено`,
  };
}

/**
 * Телефон → ключ дублів. Лише цифри, український номер зводиться до 380XXXXXXXXX,
 * тож «066 166 97 04», «+38 (066) 166-97-04» і «380661669704» — одна людина.
 * Закордонний номер лишається своїми цифрами. Менше 9 цифр — не ключ (null).
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) d = "38" + d;
  else if (d.length === 9) d = "380" + d;
  else if (d.length === 11 && d.startsWith("80")) d = "3" + d;
  return d.length >= 9 ? d : null;
}

export const isIsoDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"))
  && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;

export const isTime = (s: unknown): s is string =>
  typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/**
 * Посилання (резюме, запис співбесіди). Лише http/https: `javascript:` у клітинці, яку
 * відкриє інша людина, — це виконання чужого коду в її сесії.
 */
export function cleanUrl(raw: unknown): string | null | undefined {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : undefined;
  } catch { return undefined; }
}

/** Рядок дня звіту, як його віддає SQL. */
export interface DailyRow {
  day: string;
  planned: number;     // співбесід, запланованих на цей день
  booked: number;      // рядків графіка, записаних цього дня (дата призначення)
  done: number;        // позначок «прийшов», поставлених цього дня
  noshow: number;      // позначок «не прийшов», поставлених цього дня
  toLead: number;      // переходів у «співбесіда з тімлідом»
  toCandidate: number; // переходів у «кандидат + команда»
  toTraining: number;  // переходів у «на навчанні»
  toManager: number;   // переходів у «менеджер»
  resumes: number;     // вручну
  coldSearch: number;  // вручну
}

export const ADDITIVE_KEYS = [
  "planned", "booked", "done", "noshow", "toLead", "toCandidate", "toTraining", "toManager", "resumes", "coldSearch",
] as const;

/**
 * Разом за період. Лічильники складаються; ЯВКА — ні: вона рахується з сум
 * (Σ прийшли ÷ Σ заплановано), бо середнє відсотків дає неправду на днях різної ваги.
 * Нульовий знаменник — `null` («нема з чого рахувати»), а не 0 %.
 */
export function dailyTotals(rows: DailyRow[]): Omit<DailyRow, "day"> & { attendancePct: number | null } {
  const t = Object.fromEntries(ADDITIVE_KEYS.map((k) => [k, rows.reduce((s, r) => s + (r[k] ?? 0), 0)])) as Omit<DailyRow, "day">;
  return { ...t, attendancePct: attendancePct(t.done, t.planned) };
}

export const attendancePct = (done: number, planned: number): number | null =>
  planned > 0 ? Math.round((done / planned) * 100) : null;

/** Межа запиту звіту: не більше 400 днів, from ≤ to. */
export function validRange(from: unknown, to: unknown): { from: string; to: string } | null {
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return null;
  const days = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000;
  return days <= 400 ? { from, to } : null;
}
