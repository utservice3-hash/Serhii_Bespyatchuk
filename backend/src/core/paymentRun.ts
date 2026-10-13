/**
 * 💸 РОЗБІР ЗАПИТІВ НА ОПЛАТУ ПЕРЕВІЗНИКАМ (ГОТІВКА) — ЧИСТИЙ МОДУЛЬ, БЕЗ БД І БЕЗ МЕРЕЖІ.
 *
 * Зустріч Романа з Тетяною 13.10.2026: щодня до 17:00 вона вручну перевіряє кожен запит зі свого фільтра Kommo
 * і переносить придатні у файл на оплату («Обработка выгрузки»). Тут — ті самі перевірки, щоб файл формувався сам,
 * а їй лишались лише запити з причиною.
 *
 * 🔴 НІЧОГО НЕ ПИШЕМО В KOMMO. Перший тиждень система йде ПАРАЛЕЛЬНО з Тетяною (вона звіряє свій файл із нашим),
 * тож запити не закриваються ні «Оплачено», ні «Відмовлено». Тримає гейт.
 *
 * 🔴 НЕДОВЕДЕНЕ — У «ПЕРЕВІРИТИ», А НЕ В ОПЛАТУ. Хибне «до оплати» коштує грошей перевізнику без оплати клієнта;
 * хибне «перевірити» — хвилини Тетяни. Тому кожна перевірка, якій бракує даних, дає причину, а не мовчання.
 *
 * Фільтр — рівно Танин (посилання з чату 13.10.2026, звірено з живим Kommo): воронка «Оплата перевізникам»,
 * етапи «Нерозібране» / «Заявка на оплату» / «Прийнято до оплати», відповідальна Шнайдер Тетяна, терміновість
 * «Стандартная». Поля — з живих угод того ж дня.
 */
import { FM_EXPENSE_FIELDS } from "./fmSums.js";

export const PAY_PIPELINE = 7341740;
export const PAY_STATUSES = [60434920, 60434924, 60436036] as const;
/** Шнайдер Тетяна в Kommo (`/api/v4/users/10081384`, 13.10.2026). */
export const PAY_RESPONSIBLE = 10081384;
export const PAY_URGENCY = "Стандартная";

/** Поля запиту (угода у воронці «Оплата перевізникам»). */
export const REQ_FIELDS = {
  type: 2097495, urgency: 2097397, category: 2097399,
  phone: 2097391, card: 2097393, bank: 2098455, recipient: 2097395, cash: 2097483,
  sourceDeal: 2097401, ttn: 2097291,
} as const;
/** Поля основної угоди: «синя галочка» бухгалтерії і «Рахунок виставлено». */
export const MAIN_FIELDS = { paid1c: 2096325, invoiceIssued: 2099711 } as const;
/** Тип розходу, що означає готівку (у Kommo пишуть і «Наличные», і «Готівка»). */
export const CASH_EXPENSE_TYPE = /налич|готів/i;
/** Призначення для запитів із CRM — завжди це (інструкція Тетяни). */
export const PAY_CATEGORY = "Транспортні послуги";
/** Запит, що висить у черзі довше, — з позначкою «висить N дн.» (не причина, а підказка). */
export const STALE_DAYS = 3;

export interface PayRequest {
  id: number; createdAt: Date; type: string | null; urgency: string | null;
  phone: string | null; card: string | null; bank: string | null; recipient: string | null;
  cash: number | null; sourceDealId: number | null; ttnFiles: number;
}
export interface MainDeal {
  id: number;
  /** Σ «Расход N» з готівковим типом; `null` — готівкового розходу в угоді немає. */
  cashExpense: number | null;
  paid1c: boolean; invoiceIssued: boolean;
}
export interface PayContext {
  /** Інші запити (не «Відмовлено») на ту саму угоду з тією самою сумою готівки. */
  dupOf: number[];
  /** Σ уже ОПЛАЧЕНИХ готівкових запитів по цій угоді (інших). */
  paidBefore: number;
  /** Неоплачені рахунки 1С цієї угоди (за посиланням рахунка на угоду). */
  openInvoices: string[];
  /** Платіж клієнта у «Виписці» за рахунком цієї угоди (модуль «Гроші зайшли»). */
  bankSeen: { invoiceNo: string; bookedOn: string } | null;
  /** Узгоджений ліміт клієнта; `null` — ліміту немає взагалі. */
  limit: { days: number; amount: number | null } | null;
  /** Поточний борг клієнта і вік найстарішого боргу. */
  debt: { amount: number; ageDays: number | null } | null;
  /** Клієнти С. Беспʼятчука: для оплати в межах ліміту ТТН не вимагається (інструкція Тетяни). */
  ttnExempt: boolean;
}
export type PaidBy = "1С" | "Виписка" | "ліміт";
export interface Verdict { ok: boolean; reasons: string[]; notes: string[]; paidBy: PaidBy | null }

const money = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ");
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Номер картки у форматі файлу: `0000 0000 0000 0000`; не 16 цифр — `null`. */
export function cardOf(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length === 16 ? d.replace(/(\d{4})(?=\d)/g, "$1 ") : null;
}

/** «Власник карти» у файлі: ПІБ, банк і телефон — так, як вніс менеджер (інструкція: «не міняємо, не виправляємо»). */
export function ownerLine(r: Pick<PayRequest, "recipient" | "bank" | "phone">): string {
  return [clean(r.recipient), clean(r.bank).replace(/[,.;]+$/g, ""), clean(r.phone)].filter(Boolean).join(" ");
}

/** Рядок вкладки «До оплати» — рівно колонки Таниного файлу: ID | Номер карти | Власник карти | Сума | Категорії. */
export function payRow(r: PayRequest, main: MainDeal): [number, string, string, number, string] {
  return [main.id, cardOf(r.card) ?? "", ownerLine(r), r.cash ?? 0, PAY_CATEGORY];
}

/** Σ готівкових «Расход N» угоди за типом оплати слота. Жодного готівкового слота — `null`. */
export function cashExpenseOf(get: (fieldId: number) => string | null | undefined): number | null {
  let sum = 0, any = false;
  for (const [amount, type] of FM_EXPENSE_FIELDS) {
    if (!CASH_EXPENSE_TYPE.test(get(type) ?? "")) continue;
    const n = Number(String(get(amount) ?? "").replace(/[\s ]/g, "").replace(",", "."));
    if (Number.isFinite(n) && n > 0) { sum += n; any = true; }
  }
  return any ? Math.round(sum * 100) / 100 : null;
}

/** Повних днів між моментами (для «висить N дн.»). */
export const ageDays = (from: Date, now: Date) => Math.floor((now.getTime() - from.getTime()) / 86_400_000);

/**
 * Перевірки одного запиту — послідовність Тетяни: дубль → сума ≤ готівкового розходу → рахунок 1С → оплата клієнта
 * (галочка 1С або платіж у «Виписці») → інакше ліміт у межах (+ ТТН) → реквізити. Причин може бути кілька: Тетяна
 * бачить усі одразу, а не по одній за прогін.
 */
export function judgeRequest(r: PayRequest, m: MainDeal | null, ctx: PayContext, now: Date): Verdict {
  const reasons: string[] = [], notes: string[] = [];
  let paidBy: PaidBy | null = null;
  if (clean(r.type) !== "Готівка") reasons.push(`тип оплати «${clean(r.type) || "не вказано"}», а не «Готівка»`);
  if (r.cash == null || r.cash <= 0) reasons.push("у запиті немає суми готівки");
  if (!cardOf(r.card)) reasons.push("номер картки — не 16 цифр");
  if (!clean(r.recipient)) reasons.push("немає ПІБ отримувача");
  if (!clean(r.bank)) reasons.push("не вказано банк отримувача");
  if (ctx.dupOf.length) reasons.push(`можливий дубль: запит ${ctx.dupOf.map((x) => `#${x}`).join(", ")} на ту саму угоду й суму`);
  if (!m) {
    reasons.push(r.sourceDealId ? `основну угоду #${r.sourceDealId} не знайдено` : "у запиті немає ID основної угоди");
    return { ok: false, reasons, notes, paidBy };
  }
  if (m.cashExpense == null) reasons.push("в угоді немає готівкового розходу");
  else if (r.cash != null && r.cash + ctx.paidBefore > m.cashExpense + 0.5)
    reasons.push(`сума ${money(r.cash)}${ctx.paidBefore ? ` (+ уже оплачено ${money(ctx.paidBefore)})` : ""} більша за готівковий розхід угоди ${money(m.cashExpense)}`);
  if (!m.invoiceIssued && !m.paid1c && !ctx.openInvoices.length) reasons.push("рахунок клієнту не виставлено — не платимо");
  if (m.paid1c) paidBy = "1С";
  else if (ctx.bankSeen) { paidBy = "Виписка"; notes.push(`оплата у Виписці за рах. №${ctx.bankSeen.invoiceNo} (${ctx.bankSeen.bookedOn})`); }
  else if (!ctx.limit) reasons.push("оплати від клієнта немає, і ліміту немає");
  else if (ctx.limit.days <= 0) reasons.push("оплати від клієнта немає, ліміт не надано (0 днів)");
  else {
    const age = ctx.debt?.ageDays ?? 0, debt = ctx.debt?.amount ?? 0;
    const overDays = age > ctx.limit.days, overSum = ctx.limit.amount != null && debt > ctx.limit.amount;
    if (overDays || overSum) reasons.push(`оплати немає, ліміт перевищено: ${[overDays ? `борг ${age} дн. при ліміті ${ctx.limit.days}` : "", overSum ? `борг ${money(debt)} при ліміті ${money(ctx.limit.amount!)}` : ""].filter(Boolean).join(", ")}`);
    else {
      paidBy = "ліміт";
      notes.push(`оплати ще немає — у межах ліміту (${ctx.limit.days} дн.${ctx.limit.amount != null ? ` / ${money(ctx.limit.amount)}` : ""}; борг ${money(debt)}, ${age} дн.)`);
      if (!ctx.ttnExempt && r.ttnFiles <= 0) reasons.push("оплата за лімітом, але ТТН не прикріплено");
    }
  }
  const age = ageDays(r.createdAt, now);
  if (age >= STALE_DAYS) notes.push(`висить ${age} дн.`);
  return { ok: reasons.length === 0, reasons, notes, paidBy };
}

/**
 * Обрив зʼєднання з Kommo — повторюємо один раз (13.10.2026 сухий прогін упав на «other side closed» посеред
 * відповіді; повтор пройшов). Відмова з кодом (401/403/429…) — не мережа: її не повторюємо, там своя логіка
 * в `kommoRequest`.
 */
export const isNetworkDrop = (e: unknown): boolean =>
  /UND_ERR|terminated|ECONNRESET|ETIMEDOUT|socket|other side closed/i.test(`${(e as { cause?: { code?: string } })?.cause?.code ?? ""} ${(e as Error)?.message ?? ""}`);
