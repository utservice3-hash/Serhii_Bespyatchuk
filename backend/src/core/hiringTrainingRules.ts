/**
 * 🎓 НАЙМ, ПРОХІД 2a — ЧИСТІ ПРАВИЛА ДОСТУПУ КАНДИДАТА (17.09.2026). Без БД і без `config`.
 *
 * Джерело — макет «Найм у дашборді UTS» v12, який Роман прийняв 17.09.2026. Числа нижче —
 * ПРОПОЗИЦІЯ до Сергія, записана в макеті словами «правила на затвердження». Поки він не
 * відповів, вони живуть тут одним обʼєктом: зміна — один рядок, а не пошук по коду.
 */
import { createHash, randomBytes } from "node:crypto";

export const CANDIDATE_ACCESS = {
  /** Посилання-запрошення чинне 72 години. */
  inviteHours: 72,
  /** Жодного входу за 48 годин від створення акаунта — доступ закривається. */
  noLoginHours: 48,
  /** Три календарні дні за Києвом, рахуючи день першого входу. */
  trainingDays: 3,
  /** Понад добу без жодної відмітки в навчанні — «застряг». */
  stuckHours: 24,
} as const;

const HOUR = 3_600_000;

/** Київська північ, що починає день через `days` днів після дня моменту `at`. */
export function kyivMidnightAfter(at: Date, days: number): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const guess = Date.UTC(n("year"), n("month") - 1, n("day") + days);
  // Зсув Києва саме на ту північ (перехід на літній/зимовий час між днями не зсуває межу).
  const off = (ms: number) => {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Kyiv", timeZoneName: "shortOffset" })
      .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")!.value; // "GMT+3"
    const m = name.match(/GMT([+-]\d+)(?::(\d+))?/);
    return m ? (Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] ?? 0)) * 60_000 : 0;
  };
  return new Date(guess - off(guess - off(guess)));
}

export interface AccessInput {
  accountCreatedAt: Date;
  firstLoginAt: Date | null;
  extendedDays: number;
}

/**
 * Коли доступ закривається.
 * • Не заходив: створення акаунта + 48 год (+ по добі за кожне продовження).
 * • Заходив: кінець третього київського дня, рахуючи день першого входу (+ продовження).
 */
export function accessDeadline(p: AccessInput): Date {
  const ext = Math.max(0, Math.floor(p.extendedDays));
  if (!p.firstLoginAt) return new Date(p.accountCreatedAt.getTime() + (CANDIDATE_ACCESS.noLoginHours + 24 * ext) * HOUR);
  return kyivMidnightAfter(p.firstLoginAt, CANDIDATE_ACCESS.trainingDays + ext);
}

export type CloseReason = "no_login" | "expired" | "refused" | "manager";
export const CLOSE_REASON_LABEL: Record<CloseReason, string> = {
  no_login: "не зайшов за 48 год",
  expired: "навчання не завершено вчасно",
  refused: "відмова",
  manager: "став менеджером",
};

/** Що зробити з доступом ЗАРАЗ. `null` — нічого. Закритий доступ джоба не чіпає. */
export function accessToClose(p: AccessInput & { closedAt: Date | null; now: Date }): CloseReason | null {
  if (p.closedAt) return null;
  if (p.now.getTime() < accessDeadline(p).getTime()) return null;
  return p.firstLoginAt ? "expired" : "no_login";
}

/** День навчання «N із M». До першого входу — 0. */
export function trainingDay(p: { firstLoginAt: Date | null; extendedDays: number; now: Date }): number {
  if (!p.firstLoginAt) return 0;
  const total = CANDIDATE_ACCESS.trainingDays + Math.max(0, p.extendedDays);
  for (let d = 1; d <= total; d++) if (p.now.getTime() < kyivMidnightAfter(p.firstLoginAt, d).getTime()) return d;
  return total;
}

export type TrainingHealth = "manager" | "closed" | "done" | "no_login" | "stuck" | "ok";
export const HEALTH_LABEL: Record<TrainingHealth, string> = {
  manager: "став менеджером",
  closed: "доступ закрито",
  done: "усі кроки пройдено",
  no_login: "не заходив(ла)",
  stuck: "застряг",
  ok: "йде за планом",
};

/**
 * Стан для дошки. «Застряг» — понад добу без жодної відмітки, рахуючи від останньої дії
 * або першого входу. Пройдений курс не «застрягає»: він чекає рішення тімліда.
 */
export function trainingHealth(p: {
  closedReason: CloseReason | null; firstLoginAt: Date | null; lastActivityAt: Date | null;
  done: number; total: number; now: Date;
}): TrainingHealth {
  if (p.closedReason === "manager") return "manager";
  if (p.closedReason) return "closed";
  if (p.total > 0 && p.done >= p.total) return "done";
  if (!p.firstLoginAt) return "no_login";
  const last = p.lastActivityAt && p.lastActivityAt > p.firstLoginAt ? p.lastActivityAt : p.firstLoginAt;
  return p.now.getTime() - last.getTime() >= CANDIDATE_ACCESS.stuckHours * HOUR ? "stuck" : "ok";
}

/** Рішення «менеджер / відмова» і відповідь на питання — тімлід своєї команди або адмін-рівень (макет). */
export const canDecideTraining = (a: { roleKey: string; adminScope: boolean }): boolean =>
  a.adminScope || a.roleKey === "team_lead";

/**
 * «Перевести в менеджери». До екзамену (прохід 2c) умова — усі обовʼязкові кроки пройдено.
 * Порожній курс — НЕ «усе пройдено»: 0 із 0 означає, що рахувати нема з чого.
 */
export function promoteVerdict(p: { status: string; closedReason: CloseReason | null; done: number; total: number }):
  { ok: true } | { ok: false; reason: string } {
  if (p.closedReason === "manager") return { ok: false, reason: "Кандидат уже менеджер" };
  if (p.closedReason) return { ok: false, reason: "Доступ закрито — спершу «Відновити доступ»" };
  if (p.status !== "training") return { ok: false, reason: "Переводити в менеджери можна зі статусу «на навчанні»" };
  if (p.total === 0) return { ok: false, reason: "У навчанні немає курсу для кандидатів — завершення нема з чого рахувати" };
  if (p.done < p.total) return { ok: false, reason: `Пройдено ${p.done} із ${p.total} кроків — спершу все навчання` };
  return { ok: true };
}

export type InviteState = "valid" | "used" | "expired" | "revoked";
export function inviteState(p: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null; now: Date }): InviteState {
  if (p.usedAt) return "used";
  if (p.revokedAt) return "revoked";
  return p.now.getTime() >= p.expiresAt.getTime() ? "expired" : "valid";
}
export const INVITE_STATE_TEXT: Record<Exclude<InviteState, "valid">, string> = {
  used: "Посилання вже використано. Увійдіть з паролем, який ви встановили",
  expired: "Посилання прострочене. Попросіть рекрутера надіслати нове",
  revoked: "Посилання замінено новим. Відкрийте останнє, яке вам надіслали",
};

/** 256 біт випадковості; у базі лише SHA-256 — витік таблиці не дає входу. */
export const newInviteToken = (): string => randomBytes(32).toString("base64url");
export const hashInviteToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
export const looksLikeInviteToken = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);

/** Логін кандидата: його пошта, якщо вона вільна серед користувачів, інакше службова адреса. */
export function candidateLogin(p: { email: string | null; candidateId: number; emailTaken: boolean }): string {
  const e = p.email?.trim().toLowerCase();
  return e && !p.emailTaken ? e : `candidate-${p.candidateId}@hiring.uts.local`;
}

/**
 * Пароль кандидата, що показується Івану один раз. 12 символів base64url (72 біти) — та сама
 * форма, що в `db/userProvisioning.generatePassword`. Звідти не імпортуємо навмисно: той модуль
 * тягне `db/pool`, а ядро найму мусить жити без БД (гейти ганяють його на власному клієнті).
 */
export const newCandidatePassword = (): string => randomBytes(9).toString("base64url");

export const MIN_PASSWORD = 8;
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) return `Пароль — щонайменше ${MIN_PASSWORD} символів`;
  if (pw.length > 200) return "Пароль задовгий";
  if (!/\D/.test(pw) || !/\d/.test(pw)) return "Пароль має містити і літери, і цифри";
  return null;
}
