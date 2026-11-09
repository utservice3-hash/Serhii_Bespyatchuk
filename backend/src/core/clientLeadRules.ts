/**
 * 🚦 «З КИМ З ПОСТІЙНИХ ГОВОРИТИ» — ЧИСТЕ ПРАВИЛО ЕКРАНА ТІМЛІДА (ТЗ Юлі 28.10.2026, етап 2; задача 7360).
 * Без БД і без імпортів, що тягнуть зʼєднання: гейти бігають скрізь.
 *
 * Що вирішено (Роман 06.11.2026 — відповіді на питання до ТЗ):
 *  • КОЛІР — ЛИШЕ ВІД ЗАМОВЛЕННЯ. Зелений замовляє у своєму ритмі; жовтий мав замовити за ритмом сегмента, але не
 *    замовив (ВІП 14, регулярний 30, епізодичний і без історії 60 днів); червоний — 180 днів без замовлення.
 *    Пороги — ТІ САМІ, що стан клієнта (`SEGMENT_SLEEPING_DAYS`, `LOST_DAYS`), другої копії немає.
 *    «Замовлення» = свіжіше з рахунку («Виставлення рахунку» і далі) та оплати: ТЗ вимагає, щоб СМАР ТЕКС із рахунком
 *    20.10 був зеленим, а стан клієнта рахується від оплати — тому колір бере обидві дати.
 *  • «ПРАЦЮЄ З КЛІЄНТОМ» — ПОЗНАЧКА, А НЕ КОЛІР («підходить» на варіант «лишається жовтим з позначкою»). Робота за
 *    вікно сегмента (14 / 30 / 60 днів): розмова від 10 с, рух угоди в Kommo (будь-яка зміна етапу), коментар
 *    менеджера, ручний контакт із датою, оплата у Виписці («так, у виписці теж»). Недодзвон і розмова до 10 с — спроба.
 *  • «ПЕРЕДАТИ ІНШОМУ МЕНЕДЖЕРУ» (правило Сергія): жовтий або червоний, задача на дзвінок відкрита, її дедлайн минув,
 *    а розмови від 10 с після постановки задачі не було. Передає тімлід — тут лише позначка.
 *  • НОВИЙ ПОСТІЙНИЙ МІСЯЦЯ = друга оплачена угода припала на цей місяць (постійний = 2+ оплати, правило «Клієнтів»).
 *    Звідки — лідогенерація (клієнт у реєстрі LTV лідгенів), реклама (перша оплачена угода з каналу «реклама»),
 *    решта — менеджер.
 *  • ВТРАТИЛИ ЗА МІСЯЦЬ = клієнт став червоним цього місяця: 180-й день без замовлення припав на цей місяць.
 */
import { SEGMENT_SLEEPING_DAYS, LOST_DAYS, stateOf, type ClientSegment } from "./reactivationRules.js";

export type LeadColor = "green" | "yellow" | "red";
export type WorkBy = "talk" | "stage" | "comment" | "contact" | "payment" | "order" | "deal";
export type RepeatSource = "leadgen" | "ad" | "manager";

/** Мінімальна тривалість розмови, що вважається роботою (ТЗ: «розмова від 10 с»). */
export const TALK_MIN_SEC = 10;

const dayMs = 86_400_000;
const toMs = (ymd: string) => Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
/** Днів між двома київськими датами `YYYY-MM-DD` (b − a). */
export const daysBetween = (a: string, b: string): number => Math.round((toMs(b) - toMs(a)) / dayMs);
const addDays = (ymd: string, n: number): string => new Date(toMs(ymd) + n * dayMs).toISOString().slice(0, 10);

/** Дата останнього замовлення = свіжіша з дати останньої оплати й останнього рахунку. `null` — немає жодної. */
export function lastOrderDate(lastPaid: string | null, lastInvoice: string | null): string | null {
  const a = lastPaid?.slice(0, 10) ?? null, b = lastInvoice?.slice(0, 10) ?? null;
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Колір за днями без замовлення й сегментом — тим самим `stateOf`, що стан клієнта. Без замовлень — червоний. */
export function colorOf(segment: ClientSegment, orderDays: number | null): LeadColor {
  if (orderDays == null) return "red";
  const st = stateOf(orderDays, segment);
  return st === "active" ? "green" : st === "sleeping" ? "yellow" : "red";
}

/** Вікно, за яке шукаємо роботу з клієнтом, — ритм його сегмента. */
export const workWindowDays = (segment: ClientSegment): number => SEGMENT_SLEEPING_DAYS[segment];

/** Факти роботи — київські дати `YYYY-MM-DD` останньої події кожного виду (або null). */
export interface WorkFacts {
  talk10: string | null; stage: string | null; comment: string | null; contact: string | null; payment: string | null;
  /**
   * 🧾 Задача 8333 (Юля 06.11, Роман 09.11 «так, роби»): замовлення (рахунок або оплата — свіжіше) і НОВА угода
   * будь-якого етапу теж підтверджують роботу. Саме `order` гарантує, що «Активний» і «Немає роботи» не збігаються:
   * активний = замовив у межах ритму, а вікно роботи — той самий ритм.
   */
  order?: string | null; dealNew?: string | null;
}

/**
 * Чи працюють із клієнтом за вікно сегмента. Повертає НАЙСВІЖІШИЙ доказ (вид і дату), щоб тімлід бачив, ЧИМ
 * підтверджено, а не голе «так». Подія рівно на межі вікна — у вікні.
 */
export function workVerdict(f: WorkFacts, segment: ClientSegment, today: string): { yes: boolean; by: WorkBy | null; at: string | null; windowDays: number } {
  const windowDays = workWindowDays(segment);
  const from = addDays(today, -windowDays);
  let by: WorkBy | null = null, at: string | null = null;
  for (const k of ["talk10", "stage", "comment", "contact", "payment", "order", "dealNew"] as const) {
    const d = f[k]?.slice(0, 10) ?? null;
    if (!d || d < from || d > today) continue;
    if (at == null || d > at) { at = d; by = k === "talk10" ? "talk" : k === "dealNew" ? "deal" : k; }
  }
  return { yes: by != null, by, at, windowDays };
}

/**
 * Правило Сергія: жовтий/червоний, відкрита задача на дзвінок із минулим дедлайном і без розмови від 10 с після
 * постановки задачі → «передати іншому менеджеру». Без задачі позначки немає: дедлайну, до якого мали подзвонити, нема.
 */
export function handOverDue(a: {
  color: LeadColor; taskOpen: boolean; taskDeadline: string | null; taskCreated: string | null; talk10: string | null; today: string;
}): boolean {
  if (a.color === "green" || !a.taskOpen || !a.taskDeadline) return false;
  if (a.taskDeadline.slice(0, 10) >= a.today) return false;
  const since = a.taskCreated?.slice(0, 10) ?? null;
  const talked = a.talk10 != null && (since == null || a.talk10.slice(0, 10) >= since);
  return !talked;
}

/** Новий постійний місяця `YYYY-MM`: друга оплачена угода припала на цей місяць. */
export const becameRepeatIn = (secondPaid: string | null, ym: string): boolean => secondPaid != null && secondPaid.slice(0, 7) === ym;

/** Втрачений за місяць `YYYY-MM`: 180-й день без замовлення (день, коли клієнт став червоним) — у цьому місяці. */
export function lostIn(lastOrder: string | null, ym: string): boolean {
  if (!lastOrder) return false;
  return addDays(lastOrder, LOST_DAYS).slice(0, 7) === ym;
}

/** Звідки постійний: лідогенерація важить першою (у реєстрі LTV лідгенів), далі канал першої оплаченої угоди. */
export function repeatSource(inLeadgenRegistry: boolean, firstPaidChannel: string | null): RepeatSource {
  if (inLeadgenRegistry) return "leadgen";
  return firstPaidChannel === "ad" ? "ad" : "manager";
}
