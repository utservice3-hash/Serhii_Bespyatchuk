import { pool } from "../db/pool.js";
import { FC_PIPELINES, STAGE_PAID, STAGE_SUCCESS, STAGE_RECEIVED } from "./money.js";
import { dealKlassSql, dealSourceSql } from "./metrics.js";
import { kommoLeadUrl } from "./kommoLinks.js";

/**
 * 🔎 ДРУГИЙ РІВЕНЬ РОЗГОРТКИ ПО ДНЯХ — склад КОЖНОГО числа в рядку дня.
 *
 * 🔴 ОДНЕ ДЖЕРЕЛО НА ВСІ РОЗКРИТТЯ (вимога власника 07.08.2026), а не одинадцять
 * ендпоінтів. Причина не в економії коду: одинадцять місць — це одинадцять шансів,
 * що склад розійдеться з числом, яке він нібито пояснює. Тут кожен `kind` описаний
 * ОДНИМ предикатом, і той самий предикат живить підсумок розкриття.
 *
 * 🧮 ІНВАРІАНТ, ЯКИЙ І Є СЕНСОМ ФІЧІ: **Σ рядків розкриття == число в комірці**.
 * Це перевірка, доступна користувачеві без нас — він складе очима. Тому підсумковий
 * рядок обовʼязковий, а гейт `#60` звіряє Σ із агрегатом на живих даних.
 *
 * ⚠️ ЧОМУ ЦЕ НЕ «ЩЕ ОДИН SQL ПО ГРОШАХ». Кожен грошовий `kind` анкериться там само,
 * де й агрегат, який він розкриває: `success`/`paid`/`received` — по ДАТІ ВХОДУ В
 * ЕТАП (`deal_stage_events`), як `core/money.ts`, і з тим самим дедупом 9∪10.
 * Розійтись вони можуть лише разом, і це ловить `#60`.
 */
export type DayItemKind =
  | "created"            // угоди, заведені того дня (created_at_kommo)
  | "dispatched"         // авто, відправлені того дня (load_at) — КОГОРТА ДНЯ
  | "dispatched_paid"    // з них ті, що ВЖЕ оплачені (стан «зараз»)
  | "dispatched_awaiting"// з них ті, що ще чекають оплати
  | "success"            // угоди, що того дня зайшли в «успішно реалізовано» ①
  | "paid"               // угоди, що того дня зайшли в «оплата отримана» ⑨
  | "received"           // ① ∪ ⑨ з дедупом по угоді ②
  | "avgcheck"           // ті самі угоди ②: щоб було видно і суму, і кількість
  | "calls";             // розмови й спроби: клієнт, тривалість, ЛІНК НА ЗАПИС

export const DAY_ITEM_KINDS: DayItemKind[] = ["created", "dispatched", "dispatched_paid",
  "dispatched_awaiting", "success", "paid", "received", "avgcheck", "calls"];

export const isDayItemKind = (v: string): v is DayItemKind =>
  (DAY_ITEM_KINDS as string[]).includes(v);

export interface DayItem {
  /** Маршрут (назва угоди) або клієнт для дзвінка. */
  name: string;
  /** Угода в Kommo: id і готове посилання на картку. Для дзвінків — `null`. */
  kommoId: number | null;
  url: string | null;
  /**
   * НОВИЗНА клієнта — мітка, а не частина суми. `null` = ядро не змогло визначити.
   * 🔴 ОКРЕМО ВІД ДЖЕРЕЛА (18.08.2026): угода може бути `src:'rep'` і `source:'ad'`
   * водночас — саме це ховала стара перша гілка класифікатора.
   */
  src: "new" | "rep" | null;
  /** ДЖЕРЕЛО угоди — реклама / лідоген / інше; `null` = канал не заповнений. */
  source: "ad" | "leadgen" | "other" | null;
  /**
   * 🔴 СУМА ПОКАЗУЄТЬСЯ ЗАВЖДИ, СТАН — ОКРЕМИМ ПОЛЕМ (рішення власника 07.08.2026).
   * Було `price ? сума : статус` — тобто при нульовому бюджеті замість числа
   * зʼявлявся текст «В роботі», і рядок читався як «суми немає».
   */
  price: number;
  /** Людська назва поточного стану («Виграно», «Очікуємо оплату», …). */
  state: string;
  /** Планова дата оплати або `null` — на екрані «дата оплати не вказана». */
  plannedPayAt: string | null;
  /** Для дзвінків. */
  call?: { phone: string | null; durationSec: number; at: string; answered: boolean; recordUrl: string | null };
}

export interface DayItemsResult {
  kind: DayItemKind;
  day: string;
  items: DayItem[];
  /** Підсумок розкриття — він і є доказом, що число зійшлося. */
  total: { count: number; sum: number };
}

const K = "AT TIME ZONE 'Europe/Kyiv'";

const STATE_LABEL = (s: number): string =>
  s === 142 ? "Успішно реалізовано"
    : STAGE_PAID.includes(s) ? "Оплата отримана"
      : s === 69716312 || s === 25044997 ? "Очікуємо оплату"
        : s === 100274340 ? "Виставлення рахунку"
          : s === 143 ? "Закрито і не реалізовано" : "В роботі";

/**
 * 🔴 МІТКА «НОВИЙ/ПОСТІЙНИЙ» — З ЯДРА, А НЕ ЗІ СКОРОЧЕННЯ (виправлено 07.08.2026).
 *
 * Було: `channel === 'ad' || channel === 'leadgen' ? 'new' : 'rep'` — тобто ДВІ
 * гілки замість шести, історія клієнта не читалась узагалі. Через це розкриття
 * СПЕРЕЧАЛОСЬ із числом, яке пояснює: рядок «створено 3 · 3н · 0п», а чипи —
 * 1 новий / 2 постійні (скріншот власника, 03.08). Розходилось 12.6% угод серпня.
 *
 * ⚠️ Помилка була НЕ в анкері (142 проти оплати) — обидві угоди-порушниці нові за
 * ОБОМА визначеннями. Правило просто не було застосоване: `lead_channel='other'`
 * без історії клієнта — це НОВИЙ, а скорочення робило його постійним.
 *
 * Тепер SQL віддає готовий `klass` через `dealKlassSql()`, тож мітка й лічильник
 * рахуються ОДНИМ виразом. `'undef'` → `null`: «не знаємо» мусить бути видно, а не
 * зʼїжджати в «постійний» (саме таке мовчазне зʼїжджання ми тут і виправляємо).
 */
const srcOf = (klass: string | null): "new" | "rep" | null =>
  klass === "new" ? "new" : klass === "repeat" ? "rep" : null;

/** Джерело з ядра: 'undef' (канал не заповнений) → `null`, як і невизначена новизна. */
const sourceOf = (v: string | null): "ad" | "leadgen" | "other" | null =>
  v === "ad" ? "ad" : v === "leadgen" ? "leadgen" : v === "other" ? "other" : null;

/** SELECT-колонки складу угоди — спільні для всіх `kind`, щоб мітка не розʼїхалась. */
const DEAL_COLS = `d.kommo_id, d.name, d.price, d.status_id,
            to_char((d.planned_payment_at ${K})::date, 'YYYY-MM-DD') AS planned,
            (${dealKlassSql("d")}) AS klass,
            (${dealSourceSql("d")}) AS source`;

interface DealRow {
  kommo_id: string; name: string | null; klass: string | null; source: string | null;
  price: string | null; status_id: number; planned: string | null;
}

const mapDeals = (rows: DealRow[]): DayItem[] => rows.map((x) => ({
  name: x.name ?? "—",
  // 🔗 Посилання будує СЕРВЕР з `KOMMO_BASE_URL` — фронт піддомену не знає й не
  // має знати (у нього вже є одна зашита копія, і саме так вони й розходяться).
  kommoId: Number(x.kommo_id),
  url: kommoLeadUrl(Number(x.kommo_id)),
  src: srcOf(x.klass),
  source: sourceOf(x.source),
  price: Math.round(Number(x.price ?? 0)),
  state: STATE_LABEL(Number(x.status_id)),
  plannedPayAt: x.planned,
}));

/**
 * Угоди, що ВВІЙШЛИ у вказані статуси того дня — анкер по `deal_stage_events`,
 * рівно як у `core/money.ts`. DISTINCT по угоді: етапи 9 і 10 — ОДНІ Й ТІ САМІ
 * гроші, і без дедупу `received` подвоївся б (це вже коштувало нам інциденту).
 *
 * 🔴 ФІНАЛЬНИЙ СТАН, А НЕ БУДЬ-ЯКИЙ ВХІД. Реоупени трапляються регулярно, тож
 * угода зараховується, лише якщо ЗАРАЗ стоїть у відповідному статусі — той самий
 * фільтр, що в ядрі. Інакше склад показав би угоди, яких у числі немає.
 */
async function byStageEntry(managerId: number, from: string, to: string, statuses: number[]): Promise<DayItem[]> {
  const r = await pool.query<DealRow>(
    // ⚠️ КЛЮЧ — `kommo_id`, А НЕ `id`. У `deals` немає колонки `id` (PK = `kommo_id`),
    // у `deal_stage_events` немає `deal_id` (там теж `kommo_id`). Перша редакція
    // джойнила `d.id = e.deal_id`: TypeScript цього не бачить, а гейт `#60` без
    // прод-API не біжить — спіймала лише жива база. Той самий клас, що `day` без `AS`.
    `SELECT DISTINCT ON (d.kommo_id) ${DEAL_COLS}
       FROM deal_stage_events e
       JOIN deals d ON d.kommo_id = e.kommo_id
      WHERE d.manager_id = $1 AND d.pipeline_id = ANY($2)
        AND e.status_id = ANY($3) AND d.status_id = ANY($3)
        AND (e.changed_at ${K})::date BETWEEN $4::date AND $5::date
      ORDER BY d.kommo_id, e.changed_at DESC`,
    [managerId, FC_PIPELINES, statuses, from, to]
  );
  return mapDeals(r.rows);
}

/** Когорта дня: авто, ВІДПРАВЛЕНІ того дня (`load_at`) — той самий анкер, що `dispatchedByLoadBucket`. */
async function dispatchedCohort(managerId: number, from: string, to: string, only: "all" | "paid" | "awaiting"): Promise<DayItem[]> {
  const extra = only === "paid" ? `AND d.status_id = ANY($5)`
    : only === "awaiting" ? `AND NOT (d.status_id = ANY($5))` : "";
  const params: unknown[] = [managerId, FC_PIPELINES, from, to];
  if (only !== "all") params.push(STAGE_RECEIVED);
  const r = await pool.query<DealRow>(
    `SELECT ${DEAL_COLS}
       FROM deals d
      WHERE d.manager_id = $1 AND d.pipeline_id = ANY($2)
        AND (d.load_at ${K})::date BETWEEN $3::date AND $4::date ${extra}
      ORDER BY d.price DESC NULLS LAST, d.name`,
    params
  );
  return mapDeals(r.rows);
}

/**
 * 🔴 ДІАПАЗОН, А НЕ ЛИШЕ ДЕНЬ (07.08.2026). Блок «Гроші тижня» розкриває ТІ САМІ
 * множини за тиждень — і робить це ЦИМ механізмом, а не другим. Один день = діапазон
 * із однакових кінців: інакше через місяць у нас було б два визначення «оплачено».
 */
export async function dayItems(kind: DayItemKind, managerId: number, from: string, to: string = from): Promise<DayItemsResult> {
  let items: DayItem[];
  switch (kind) {
    case "created": {
      const r = await pool.query<DealRow>(
        `SELECT ${DEAL_COLS}
           FROM deals d
          WHERE d.manager_id = $1 AND d.pipeline_id = ANY($2)
            AND (d.created_at_kommo ${K})::date BETWEEN $3::date AND $4::date
          ORDER BY d.price DESC NULLS LAST, d.created_at_kommo`,
        [managerId, FC_PIPELINES, from, to]
      );
      items = mapDeals(r.rows);
      break;
    }
    case "dispatched": items = await dispatchedCohort(managerId, from, to, "all"); break;
    case "dispatched_paid": items = await dispatchedCohort(managerId, from, to, "paid"); break;
    case "dispatched_awaiting": items = await dispatchedCohort(managerId, from, to, "awaiting"); break;
    case "success": items = await byStageEntry(managerId, from, to, STAGE_SUCCESS); break;
    case "paid": items = await byStageEntry(managerId, from, to, STAGE_PAID); break;
    // ② = ① ∪ ⑨. Дедуп по угоді робить сам `byStageEntry` (DISTINCT ON), а обʼєднання
    // статусів в ОДНОМУ запиті не дає угоді потрапити двічі при вході в обидва етапи.
    case "received":
    case "avgcheck": items = await byStageEntry(managerId, from, to, STAGE_RECEIVED); break;
    case "calls": {
      const r = await pool.query<{ name: string | null; phone: string | null; billsec: number;
        at: string; recording: string | null }>(
        // 🔗 ТА САМА СКЛЕЙКА, ЩО В АГРЕГАТІ (`callsByManagerDay`): плече, що почалось
        // у межах 120 с від попереднього до того самого номера, — це продовження
        // ТОГО САМОГО дзвінка, а не новий. Якби список склеювали інакше, ніж число
        // над ним, розкриття перестало б пояснювати своє ж число.
        `SELECT COALESCE(d.name, rc.client_key) AS name, rc.client_phone AS phone,
                rc.billsec, to_char((rc.calldate ${K}), 'YYYY-MM-DD HH24:MI') AS at, rc.recording
           FROM ringostat_calls rc
           LEFT JOIN LATERAL (
             SELECT dd.name FROM deals dd
              WHERE dd.client_key = rc.client_key AND rc.client_key IS NOT NULL
              ORDER BY dd.created_at_kommo DESC LIMIT 1) d ON true
          WHERE rc.manager_id = $1 AND (rc.calldate ${K})::date BETWEEN $2::date AND $3::date
            AND NOT EXISTS (
              SELECT 1 FROM ringostat_calls p
               WHERE p.manager_id = rc.manager_id AND p.client_phone IS NOT DISTINCT FROM rc.client_phone
                 AND (p.billsec > 0) = (rc.billsec > 0)
                 AND p.calldate < rc.calldate
                 AND rc.calldate - p.calldate <= interval '120 seconds')
          ORDER BY rc.calldate`,
        [managerId, from, to]
      );
      items = r.rows.map((x) => ({
        name: x.name ?? x.phone ?? "невідомий",
        // Дзвінок не є угодою: ані новизни, ані джерела, ані картки в CRM.
        kommoId: null, url: null, src: null, source: null, price: 0, state: x.billsec > 0 ? "розмова" : "спроба", plannedPayAt: null,
        // 🎧 ПРЯМИЙ ЛІНК НА ЗАПИС, без проксі — рішення власника 05.08.2026,
        // нового рішення не потрібно (закриває задачу «плеєр дзвінків» із черги).
        call: { phone: x.phone, durationSec: x.billsec, at: x.at,
          answered: x.billsec > 0, recordUrl: x.recording },
      }));
      break;
    }
  }
  // Для дзвінків «сума» безглузда — підсумком є КІЛЬКІСТЬ. Не показуємо 0 ₴ як суму.
  const sum = kind === "calls" ? 0 : items.reduce((s, x) => s + x.price, 0);
  return { kind, day: from, items, total: { count: items.length, sum } };
}
