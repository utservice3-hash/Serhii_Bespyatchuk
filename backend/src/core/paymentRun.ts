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
  sourceDeal: 2097401,
} as const;
/**
 * Поля основної угоди: «синя галочка» бухгалтерії; «Номер заказа» — НОМЕР РАХУНКУ 1С (`000008452` = рах. №8452;
 * його пише інтеграція «Генезис: 1С», вкладка «Заказ 1С»; заповнено у 332 з 347 угод за 30 днів, усі у 9 цифр,
 * замір 13.10.2026); «Рахунок виставлено»; приходи — для звірки суми платежу.
 */
export const MAIN_FIELDS = { paid1c: 2096325, orderNo: 2096315, invoiceIssued: 2099711 } as const;
/** Скільки днів «Виписки» шукаємо оплату за номером рахунку. */
export const PAY_LOOKBACK_DAYS = 30;
/** Тип розходу, що означає готівку (у Kommo пишуть і «Наличные», і «Готівка»). */
export const CASH_EXPENSE_TYPE = /налич|готів/i;
/** Призначення для запитів із CRM — завжди це (інструкція Тетяни). */
export const PAY_CATEGORY = "Транспортні послуги";
/** Запит, що висить у черзі довше, — з позначкою «висить N дн.» (не причина, а підказка). */
export const STALE_DAYS = 3;

export interface PayRequest {
  id: number; createdAt: Date; type: string | null; urgency: string | null;
  phone: string | null; card: string | null; bank: string | null; recipient: string | null;
  cash: number | null; sourceDealId: number | null;
}
export interface MainDeal {
  id: number;
  /** Σ «Расход N» з готівковим типом; `null` — готівкового розходу в угоді немає. */
  cashExpense: number | null;
  paid1c: boolean; invoiceIssued: boolean;
  /** Номер рахунку 1С без нулів попереду («Номер заказа»); `null` — не заповнено. */
  orderNo: string | null;
  /** Σ «Приход N» угоди — для звірки суми платежу клієнта. */
  income: number | null;
  /** Клієнт угоди (назва / ПІБ) — для звірки платника. */
  clientName: string | null;
}
/** Вхідний платіж «Виписки» (без Сейфу й карток). */
export interface BankIn { bookedOn: string; amount: number; purpose: string; payer: string }
export interface PayContext {
  /** Інші запити (не «Відмовлено») на ту саму угоду з тією самою сумою готівки. */
  dupOf: number[];
  /** Σ уже ОПЛАЧЕНИХ готівкових запитів по цій угоді (інших). */
  paidBefore: number;
  /** Платіж клієнта у «Виписці» за номером рахунку цієї угоди (`findBankPayment`). */
  bankSeen: { invoiceNo: string; bookedOn: string } | null;
  /** В угоді прикріплено файл «Квитанція…» (клієнт надіслав підтвердження). Не оплата — підказка Тетяні. */
  receipt: boolean;
  /** Узгоджений ліміт клієнта; `null` — ліміту немає взагалі. */
  limit: { days: number; amount: number | null } | null;
  /** Поточний борг клієнта і вік найстарішого боргу. */
  debt: { amount: number; ageDays: number | null } | null;
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
 * (галочка 1С або платіж у «Виписці») → інакше ліміт у межах → реквізити. Причин може бути кілька: Тетяна
 * бачить усі одразу, а не по одній за прогін.
 * ТТН НЕ ПЕРЕВІРЯЄТЬСЯ (Тетяна 14.10.2026: «наявність ТТН не беремо до уваги») — хоча в її старій письмовій інструкції
 * «за лімітом — лише зі скрінами ТТН + заявки» стояло; перший день прогону зупинив на цьому 5 запитів із 10.
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
  // Порожній «Номер заказа» — НЕ «рахунку немає»: у всіх 15 таких угод із 347 стоїть «Рахунок виставлено» (замір
  // 13.10.2026), частина — готівкові клієнти. Тому — на перевірку Тетяні, а не відмова.
  if (!m.paid1c && !m.orderNo) reasons.push("номер рахунку 1С («Номер заказа») не заповнено — перевірити, чи є рахунок");
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
    }
  }
  if (!paidBy && ctx.receipt) notes.push("в угоді є квитанція клієнта — глянути");
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

/** Номер рахунку з «Номер заказа»: цифри без нулів попереду; порожньо чи нуль — `null`. */
export const orderNoOf = (raw: string | null | undefined): string | null => (raw ?? "").replace(/\D/g, "").replace(/^0+/, "") || null;

/** Ядро назви для звірки платника: вміст лапок, інакше назва без правової форми; лише літери й цифри, нижній регістр. */
export function nameCore(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();
  const q = s.match(/["«“„']([^"»”']{3,})["»”']/);
  const base = q ? q[1] : s.replace(/товариство з обмеженою відповідальністю|приватне підприємство|фізична особа[- ]підприємець|\b(тов|пп|фоп|фо-п|ооо|тзов|ат|прат|пат)\b/g, " ");
  return base.replace(/[^a-zа-яіїєґ0-9]/g, "");
}
/** Платник — той самий клієнт: одне ядро містить інше (≥4 знаки). */
export function samePayer(payer: string, client: string | null): boolean {
  const a = nameCore(payer), b = nameCore(client);
  return a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
}

/**
 * Оплата клієнта у «Виписці» за номером рахунку угоди: у призначенні — цей номер окремим числом (нулі попереду
 * дозволені), і платіж належить цьому клієнту — платник той самий АБО сума = приходу угоди (± 1 грн). Друга умова
 * потрібна, бо номер — лише 4 цифри, і в чужому призначенні він трапляється (рахунки, ТТН, договори). Найсвіжіший.
 */
export function findBankPayment(m: Pick<MainDeal, "orderNo" | "income" | "clientName">, payments: readonly BankIn[]): { invoiceNo: string; bookedOn: string } | null {
  if (!m.orderNo) return null;
  const re = new RegExp(`(^|\\D)0*${m.orderNo}(\\D|$)`);
  const hit = payments
    .filter((p) => re.test(p.purpose) && (samePayer(p.payer, m.clientName) || (m.income != null && Math.abs(p.amount - m.income) <= 1)))
    .sort((a, b) => b.bookedOn.localeCompare(a.bookedOn))[0];
  return hit ? { invoiceNo: m.orderNo, bookedOn: hit.bookedOn } : null;
}

/** Зсув Києва від UTC у хвилинах на мить `d` (літній +180, зимовий +120). */
const kyivOffsetMin = (d: Date) => (Date.parse(d.toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" }).replace(" ", "T") + "Z") - d.getTime()) / 60000;
/** Київський час `day HH:MM` як мить UTC. */
export function kyivAt(day: string, hhmm: string): Date {
  const naive = new Date(`${day}T${hhmm}:00Z`);
  return new Date(naive.getTime() - kyivOffsetMin(naive) * 60000);
}
const shiftDay = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/**
 * Вікно файлу — як у Тетяни: «запити, створені вчора після 17:00 і сьогодні до 17:00». Після 17:00 прогін уже
 * збирає ЗАВТРАШНІЙ файл. `day` — явний день (звірка заднім числом).
 */
export function payWindow(now: Date, day?: string): { day: string; from: Date; to: Date } {
  const today = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const d = day ?? (now.getTime() >= kyivAt(today, "17:00").getTime() ? shiftDay(today, 1) : today);
  return { day: d, from: kyivAt(shiftDay(d, -1), "17:00"), to: kyivAt(d, "17:00") };
}

/** Інший запит на ту саму угоду (з бази + картка з Kommo, якщо відома). */
export interface Sibling { id: number; amount: number | null; status: number; card: string | null }
/**
 * Дубль = та сама сума І та сама картка. Лише сума — замало: 13.10.2026 на угоді 62761137 було два запити по 2 500
 * РІЗНИМ отримувачам (дві машини), і обидва законно оплачені. Картки сусіда не знаємо (не встигли прочитати) —
 * лишається правило «та сама сума», тобто безпечний бік: на перевірку.
 */
export function dupsOf(r: Pick<PayRequest, "cash" | "card">, siblings: readonly Sibling[]): number[] {
  const mine = (r.card ?? "").replace(/\D/g, "");
  return siblings.filter((s) => r.cash != null && s.amount != null && Math.abs(s.amount - r.cash) < 0.5
    && (!s.card || !mine || s.card.replace(/\D/g, "") === mine)).map((s) => s.id);
}
