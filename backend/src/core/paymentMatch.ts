/**
 * 💰 «ГРОШІ ЗАЙШЛИ» — ЗІСТАВЛЕННЯ ВХІДНОГО ПЛАТЕЖУ З РАХУНКОМ ДЕБІТОРКИ.
 *
 * Виписка приходить РАНІШЕ, ніж бухгалтерія рознесе рахунки. Поки рахунок ще
 * висить у дебіторці, ми вміємо сказати «гроші за ним уже прийшли» — і рядок
 * перестає тривожити, доки рознесення не прибере його само.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 ВІДМІТКА НА НЕОПЛАЧЕНОМУ РАХУНКУ ГІРША ЗА ВІДСУТНЮ.
 * Людина перестане дзвонити тому, хто не заплатив. Тому в кожному сумнівному
 * випадку правильна відповідь — НЕ ВІДМІЧАТИ. Але порожнеча зобовʼязана
 * НАЗИВАТИ СЕБЕ: «не зіставлено» — це відповідь, а порожня клітинка — ні.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🔴 ПОХІДНА, А НЕ ЗБЕРЕЖЕНА (рішення власника 28.08.2026). Тут немає таблиці,
 * і це не економія: похідна вміє помилитись ЛИШЕ в безпечний бік — «не
 * відмітили того, хто заплатив», і людина зайвий раз подзвонить. Збережена
 * відмітка вміє пережити власну підставу, тобто збрехати в бік «гроші є» —
 * рівно та поломка, яку ми й лікуємо. Плюс вона гасне САМА і точно тоді, коли
 * треба: рознесли рахунок → він зник із `receivable_invoices` → відмітки немає.
 * ⚠️ Ціна прийнята свідомо: сліду не лишається.
 *
 * ⚠️ ЗАЛЕЖНІСТЬ ВІД ПРОХОДУ ВИПИСКИ, НАЗВАНА ВГОЛОС. Цей модуль читає ВХІДНІ
 * платежі, і сьогодні вони чисті: усі 1116 зіпсованих рядків мають
 * `TRANTYPE='D'`, вхідних зачеплено НУЛЬ (заміряно 28.08.2026). Але
 * структурного барʼєра немає — `privat:REF` не унікальний на рівні items, а
 * `direction` не оновлюється в `ON CONFLICT`, тож майбутня колізія на ВХІДНОМУ
 * рядку дала б чужу суму при старому напрямку, і відмітка збрехала б у бік
 * «гроші є». Лікує це прохід 1 Виписки (ключ `privat:REF#ID`) — він прийнятий
 * і чекає черги. Тут проти цього нічого не будується навмисно.
 */
import { workingDaysBetween } from "./dates.js";

/** Вхідний платіж — рівно те, що привозить `INVOICE_PAYMENTS_SQL`. */
export interface IncomingPayment {
  /** `bank_transactions.id` — serial. 🔴 НЕ `external_tx_id`: прохід Виписки його перепише. */
  txId: number;
  /** Дата зарахування за Києвом, `YYYY-MM-DD`. Стеля рахується від НЕЇ (факт банку). */
  bookedOn: string;
  amount: number;
  purpose: string | null;
  /** ЄДРПОУ платника з `raw_json` (окремої колонки в схемі немає — заміряно). */
  payerEdrpou: string | null;
}

/** Рахунок, до якого прикладаємо платіж. */
export interface OpenInvoice {
  invoiceNo: string;
  /** 🔴 ЗАЛИШОК, а не сума рахунка — див. `PARTIAL_IS_UNKNOWABLE`. */
  amount: number;
  edrpou: string | null;
}

/**
 * Стан рахунка на екрані. 🔴 ЧОТИРИ, І ЖОДЕН НЕ ЗВОДИТЬСЯ ДО ІНШОГО.
 *
 * `ambiguous` існує окремо від `none` за рішенням власника 28.08.2026: людина
 * бачить ПРИЧИНУ («платіж називає кілька рахунків») і розвʼязує це очима за дві
 * секунди, тоді як спільне «не зіставлено» відправило б її шукати наосліп.
 * Той самий клас, що «архів ≠ давно втрачений».
 */
export type SeenKind =
  | "seen"        // гроші зайшли, рознесення ще не було
  | "stale"       // зайшли давно, а рознесення так і не сталося — каже про себе
  | "ambiguous"   // платіж називає кілька ЖИВИХ рахунків — не вгадуємо
  | "none";       // не зіставлено

export interface PaymentSeen {
  kind: SeenKind;
  /** Дата платежу, `YYYY-MM-DD`; `null` для `none`. */
  bookedOn: string | null;
  amount: number | null;
  txId: number | null;
  /** Робочих днів від платежу до `today` — лише для `seen`/`stale`. */
  workdays: number | null;
}

/**
 * 🕰 СТЕЛЯ — ДВА РОБОЧІ ДНІ, І ВІД `booked_at` (рішення власника 28.08.2026).
 *
 * Власник каже, рознесення буває «наступного дня в обід». Два робочі дні дають
 * запас і не червоніють у понеділок через пʼятничний платіж — саме тому дні
 * РОБОЧІ, а не години.
 *
 * ⚠️ ЦЕ ОЦІНКА ЗІ СЛІВ ВЛАСНИКА, А НЕ ЗАМІР, і перевірити її нема на чому:
 * `receivable_invoices` TRUNCATE-иться щочверть години, тож історії «скільки
 * рахунок жив після оплати» не існує в принципі. Перевіряється лише
 * спостереженням уперед.
 *
 * 🔴 Після стелі відмітка НЕ ЗНИКАЄ, а каже про себе. Мовчазне зникнення
 * забрало б єдиний слід того, що гроші прийшли не за цим рахунком.
 */
export const SEEN_MAX_WORKDAYS = 2;

/** Календар свят тут НЕ враховується — той самий календар, що `workingDaysBetween`
 *  під «треба ₴/день» і планом тижня. Заводити ТРЕТІЙ означення робочого дня
 *  заради двох діб ми не будемо (борг про два календарі записаний у CLAUDE.md). */

/**
 * 🔴 ЧОМУ «ВИТЯГТИ ЧИСЛА» І «ЛИШИТИ ТІ, ЩО Є СЕРЕД ВІДКРИТИХ» — РІЗНІ КРОКИ,
 * І ДРУГИЙ ОБОВʼЯЗКОВИЙ.
 *
 * Наївний розбір «розпізнати номер рахунка» витягує НЕ ТІЛЬКИ рахунки. Заміряно
 * на 855 живих призначеннях:
 *   «по Договору №10012022»      → 10012022  (договір)
 *   «зг. Договору № 04-20/12-25» → 4
 *   «рах. б/н від 06.08.2026»    → 6
 *   «рахунку №20/08/26 від 20.08»→ 20
 * Сьогодні жоден не влучив — живі номери чотиризначні (5000-7000). Але простори
 * номерів перетинаються, і колізія договору з рахунком — питання часу.
 *
 * Тому функція повертає САМІ КАНДИДАТИ, а рішення ухвалює `matchPayment`, який
 * лишає ті, що Є серед відкритих рахунків, і додатково звіряє ЄДРПОУ платника.
 * Два барʼєри на одну поломку навмисно: перший не дає взяти чуже число, другий
 * ловить випадок, коли чуже число ЗБІГЛОСЬ із живим рахунком.
 */
export function invoiceNoCandidates(purpose: string | null | undefined): string[] {
  const s = String(purpose ?? "");
  const out = new Set<string>();
  // Після «№» і після слова про рахунок — дві форми, якими це пишуть у 1С і банку.
  for (const m of s.matchAll(/№\s*\.?\s*(\d{2,11})/g)) out.add(stripLeadingZeros(m[1]));
  for (const m of s.matchAll(/(?:рах|рахунк|рахунок|счет|сч|invoice)[^0-9]{0,25}(\d{2,11})/gi)) {
    out.add(stripLeadingZeros(m[1]));
  }
  return [...out].filter(Boolean);
}

/**
 * 🔑 НОМЕРИ НЕ ЗБІГАЮТЬСЯ БУКВАЛЬНО, І БЕЗ ЦЬОГО ЗБІГІВ БУЛО Б РІВНО НУЛЬ.
 * У дебіторці `000006708` (8-11 символів із нулями), у призначенні `№6708`.
 * Порівнюємо обрізані з обох боків.
 */
export function stripLeadingZeros(no: string | null | undefined): string {
  return String(no ?? "").replace(/^0+/, "");
}

/** ЄДРПОУ до порівнюваного вигляду: лише цифри, без ведучих нулів. */
export function normalizeEdrpou(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * 🔴 ЧОМУ НЕПОВНУ ОПЛАТУ НЕМОЖЛИВО ВІДРІЗНИТИ — і чому ми навіть не пробуємо.
 *
 * `receivable_invoices.amount` — це ЗАЛИШОК, а не сума рахунка. Доказ із живих
 * даних 28.08.2026: платник САМ пише «часткова оплата за Рахунок № 4488»,
 * платячи 200 000 ₴ проти залишку 41 145 ₴ — тобто одним платежем закриває
 * кілька рахунків, назвавши один. Отже «менше рахунка» НЕ означає «часткова
 * оплата», а «більше» НЕ означає «переплата».
 *
 * Наслідок для правил: сума НЕ бере участі в рішенні «за номером» узагалі. Вона
 * лише показується поруч, щоб людина бачила, що саме прийшло.
 */
export const PARTIAL_IS_UNKNOWABLE = true;

const NONE: PaymentSeen = { kind: "none", bookedOn: null, amount: null, txId: null, workdays: null };

/**
 * Скільки ЖИВИХ рахунків називає цей платіж. Ключ до стану `ambiguous`.
 *
 * 📐 Заміряно 28.08.2026: 28 із 855 призначень називають більше одного номера
 * («зг. рах. № 6683, № 6459»); живих серед них зараз нуль. Тобто зона порожня —
 * але вона ІСНУЄ, і саме тут «за номером» перестає бути однозначним.
 */
export function livesNamedBy(p: IncomingPayment, openByNo: ReadonlyMap<string, OpenInvoice>): string[] {
  return invoiceNoCandidates(p.purpose).filter((n) => openByNo.has(n));
}

/**
 * Рішення по ОДНОМУ рахунку.
 *
 * Правила, дослівно за власником:
 *   · названо номер → беремо ЙОГО;
 *   · номера немає, але сума збігається РІВНО з одним рахунком → беремо за сумою;
 *   · сума неповна І номера немає → не відмічаємо нічого.
 *
 * 🔴 ПІДБІР ЗА СУМОЮ НЕ ЧІПАЄ ВИПАДКІВ, ДЕ НОМЕР НАЗВАНО — і це найдорожча
 * помилка, яку фіча могла зробити. Заміряно: «СМАР ТЕКС» платить за рахунком
 * 6704, той уже закритий, а 42 000 ₴ випадково збігається з ЧУЖИМ відкритим
 * 6829. Провал у підбір за сумою приписав би гроші не тому рахунку з повною
 * впевненістю. Платник уже сказав, за що платить — не знайшли його рахунок
 * серед відкритих означає «рознесли», а не «пошукаймо схоже».
 */
export function matchPayment(
  invoice: OpenInvoice,
  payments: readonly IncomingPayment[],
  openByNo: ReadonlyMap<string, OpenInvoice>,
  today: string,
): PaymentSeen {
  const no = stripLeadingZeros(invoice.invoiceNo);
  if (!no) return NONE;

  // ① НАЗВАНО НОМЕР.
  const named = payments.filter((p) => livesNamedBy(p, openByNo).includes(no));
  if (named.length) {
    // Платіж, що називає КІЛЬКА живих рахунків, не відмічає жодного.
    const clean = named.filter((p) => livesNamedBy(p, openByNo).length === 1);
    if (!clean.length) return { ...NONE, kind: "ambiguous" };
    const ok = clean.filter((p) => edrpouAgrees(p, invoice));
    // 🔴 ДРУГИЙ БАРʼЄР: ЄДРПОУ платника мусить збігатися з клієнтом рахунка.
    // Він ловить те, чого не ловить перший: чуже число, що ЗБІГЛОСЬ із живим
    // рахунком. Розбіжність = не відмічаємо (заміряно: розбіжностей 0 із 31).
    if (!ok.length) return { ...NONE, kind: "ambiguous" };
    return seenOf(newest(ok), today);
  }

  // ② НОМЕРА НЕМАЄ — підбір за сумою, і лише коли він ОДНОЗНАЧНИЙ.
  const numberless = payments.filter((p) => invoiceNoCandidates(p.purpose).length === 0);
  const byAmount = numberless.filter((p) => edrpouAgrees(p, invoice)
    && Math.abs(Math.abs(p.amount) - invoice.amount) < 0.01);
  if (byAmount.length > 1) return { ...NONE, kind: "ambiguous" };
  if (byAmount.length === 1) {
    /**
     * 🔴 НЕОДНОЗНАЧНІСТЬ ТУТ — ВЛАСТИВІСТЬ ПЛАТЕЖУ, А НЕ РАХУНКА, і побачити її
     * з одного рахунка неможливо. Спіймано власним гейтом `#24g`: два відкриті
     * рахунки по 5 000 ₴, платіж на 5 000 ₴ без номера — з погляду КОЖНОГО
     * рахунка збіг рівно один, і обидва впевнено відмічались.
     *
     * «Рівно один рахунок із такою сумою» означає ОДИН СЕРЕД УСІХ ВІДКРИТИХ,
     * а не «цьому рахунку підійшло».
     */
    const rivals = [...openByNo.values()].filter((o) =>
      Math.abs(o.amount - Math.abs(byAmount[0].amount)) < 0.01
      && normalizeEdrpou(o.edrpou) === normalizeEdrpou(byAmount[0].payerEdrpou));
    if (rivals.length > 1) return { ...NONE, kind: "ambiguous" };
    return seenOf(byAmount[0], today);
  }

  // ③ Сума неповна і номера немає → нічого. Чекаємо рознесення.
  return NONE;
}

/** ЄДРПОУ невідомий з БУДЬ-ЯКОГО боку → вважаємо, що НЕ збігається. Fail-closed:
 *  «не знаємо» тут мусить читатись як «не відмічаємо», а не «мабуть, той самий». */
function edrpouAgrees(p: IncomingPayment, inv: OpenInvoice): boolean {
  const a = normalizeEdrpou(p.payerEdrpou), b = normalizeEdrpou(inv.edrpou);
  return a !== "" && b !== "" && a === b;
}

/** Найсвіжіший платіж: якщо їх кілька, рахунок закрив останній. */
function newest(ps: readonly IncomingPayment[]): IncomingPayment {
  return ps.reduce((a, b) => (b.bookedOn > a.bookedOn ? b : a));
}

function seenOf(p: IncomingPayment, today: string): PaymentSeen {
  // `workingDaysBetween` рахує ВКЛЮЧНО обидва кінці, тож день платежу = 1.
  const wd = Math.max(0, workingDaysBetween(p.bookedOn, today) - 1);
  return {
    kind: wd > SEEN_MAX_WORKDAYS ? "stale" : "seen",
    bookedOn: p.bookedOn, amount: Math.abs(p.amount), txId: p.txId, workdays: wd,
  };
}

/**
 * 📥 СИРІ ПЛАТЕЖІ — SQL БЕЗ ЖОДНОГО БІЗНЕС-ПРАВИЛА.
 *
 * Тут лише вікно й напрямок; усе, що вирішує, живе у функціях вище. Правило,
 * записане в SQL, неможливо ані просаботувати гейтом, ані переюзати — саме так
 * у нас двічі народжувалась друга копія правила.
 *
 * ⚠️ `is_bank_fee` виключаємо: комісія — наш власний платіж банку, а не гроші
 * клієнта. Класифікація комісій перевірена окремо й правильна (1131 із 1131).
 *
 * $1 — скільки днів назад дивитись.
 */
/**
 * 🔴 ФУНКЦІЯ ВІД НОМЕРА ПАРАМЕТРА, А НЕ КОНСТАНТА — і це не педантизм.
 *
 * Той самий текст потрібен у ДВОХ місцях: окремим запитом у розкритті/реєстрі і
 * ПІДЗАПИТОМ усередині `/receivables` (де стеля `#158` — чотири походи, і
 * пʼятий заборонено). Скопіювати текст означало б завести другу копію правила
 * «які платежі ми взагалі дивимось»; переномерувати `$1` руками на місці — те,
 * на чому такі копії й розходяться. Тому джерело одне, а номер параметра
 * приходить аргументом.
 */
export function invoicePaymentsSql(paramIdx: number): string {
  return `
  SELECT t.id,
         to_char(t.booked_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS booked_on,
         t.amount, t.purpose,
         COALESCE(t.raw_json->>'AUT_CNTR_CRF', t.raw_json->>'counterEdrpou') AS payer_edrpou
    FROM bank_transactions t
   WHERE t.direction = 'in' AND NOT t.is_bank_fee
     AND t.booked_at >= now() - ($${paramIdx} || ' days')::interval
   ORDER BY t.booked_at DESC`;
}

/** Рядок, як його віддає SQL. Числа приходять рядками — приводимо в одному місці. */
export interface RawPaymentRow {
  id: number | string; booked_on: string | null; amount: string | number;
  purpose: string | null; payer_edrpou: string | null;
}

export function toPayments(rows: readonly RawPaymentRow[]): IncomingPayment[] {
  return rows
    .filter((r) => r.booked_on != null)
    .map((r) => ({
      txId: Number(r.id), bookedOn: String(r.booked_on), amount: Number(r.amount),
      purpose: r.purpose, payerEdrpou: r.payer_edrpou,
    }));
}

/**
 * Зіставлення ВСІХ відкритих рахунків за один прохід.
 *
 * 🔴 ЗІСТАВЛЯЄМО ПАКЕТОМ, А НЕ ПО ОДНОМУ, бо стан `ambiguous` неможливо
 * побачити з одного рахунка: він означає «цей ПЛАТІЖ називає кілька живих
 * рахунків», тобто питання про платіж, а не про рахунок. Мапа відкритих
 * будується РАЗ і передається в кожне рішення.
 */
export function matchAll(
  invoices: readonly OpenInvoice[], payments: readonly IncomingPayment[], today: string,
): Map<string, PaymentSeen> {
  const openByNo = new Map<string, OpenInvoice>();
  for (const i of invoices) {
    const k = stripLeadingZeros(i.invoiceNo);
    if (k) openByNo.set(k, i);
  }
  const out = new Map<string, PaymentSeen>();
  for (const i of invoices) out.set(i.invoiceNo, matchPayment(i, payments, openByNo, today));
  return out;
}

/**
 * Скільки днів виписки тягнемо. Рознесення штатно відбувається наступного дня,
 * стеля — два робочі дні; 14 дає запас на свята й довгі вихідні, лишаючись
 * дешевим (заміряно: 855 вхідних UAH за 30 днів, тобто ~400 за 14).
 */
export const PAYMENT_LOOKBACK_DAYS = 14;

/** Скільки рахунків клієнта в якому стані — для рядка списку. */
export interface SeenRoll { seen: number; stale: number; ambiguous: number; total: number }

/**
 * 🔴 ЗГОРТКА ЖИВЕ В ЯДРІ, А НЕ В РОУТІ, і причина не в охайності: рядок клієнта
 * і бейджі в розкритті МУСЯТЬ казати одне й те саме. Щойно згортка порахується
 * окремим виразом у роуті — вона розійдеться з бейджами мовчки, і кожне число
 * поодинці лишиться правильним. Рівно так «Команда за місяць 12%» жила поруч
 * із плиткою «11.8%».
 *
 * `stale` НЕ входить у `seen`: це різні відповіді. Перше — «гроші є, все йде
 * як має»; друге — «гроші є вже давно, а рознесення не сталося», тобто привід
 * подивитись, а не заспокоїтись.
 */
export function rollUp(states: readonly PaymentSeen[]): SeenRoll {
  const r: SeenRoll = { seen: 0, stale: 0, ambiguous: 0, total: states.length };
  for (const s of states) {
    if (s.kind === "seen") r.seen++;
    else if (s.kind === "stale") r.stale++;
    else if (s.kind === "ambiguous") r.ambiguous++;
  }
  return r;
}
