/**
 * 📈 ОФЛАЙН-КОНВЕРСІЇ ДЛЯ GOOGLE ADS (Роман 27.10.2026, формат — шаблон рекламниці «UTS_GoogleAds - Data»).
 *
 * Навіщо: Google Ads вчиться на тих кліках, після яких була заявка й перевезення. CSV будується на кожен запит:
 *  · `CRM Send_form` — кожна рекламна заявка; час = створення угоди; цінність ФІКСОВАНА — `GADS_LEAD_VALUE`;
 *  · `CRM Deal Won` — угода дійшла до «Авто працює» або далі; час = ПЕРШИЙ вхід у цей ланцюг,
 *    сума = `deals.price` («Бюджет», маржа).
 *
 * 🔴 ЧОМУ САМЕ ТАК — рішення Юлі (продажі) і Романа 27.10.2026:
 *  · «Бюджет» на ранніх етапах — не очікувана маржа: менеджер ставить його, коли знайшов перевізника й
 *    погодив ціну; надійно він стоїть з «Авто працює». Вчити Google на ньому раніше = вчити на шумі.
 *  · Тому заявка має фіксовану цінність (середня маржа рекламної угоди, Юля: ~1 900 ₴; замір по дашборду
 *    27.10 — середня 2 168, медіана 1 500 за 6 міс.), а фактична сума — лише на «Авто працює».
 *  · Рекламниця оптимізує на заявку: «Deal Won» для Google нова конверсія, перемикатись на неї одразу не можна.
 *  · СУМА — МАРЖА, а не оплата клієнта (підтвердили власник і фінансистка Таня).
 *
 * 📞 ТЕЛЕФОН у кожному рядку (`Phone Number`, E.164) — для розширених конверсій рекламниці. Рішення Романа
 * 27.10.2026: відкритим номером, не хешем. Тому рекламні заявки з Google БЕЗ gclid (дзвінки — Ringostat
 * gclid не передає) теж ідуть у файл, якщо в угоди є телефон: Google зіставляє їх за номером.
 *
 * Межі Google, які тут тримаються, а не на боці рекламниці:
 *  · конверсія пізніше 90 днів від кліку Google відхиляє — клік не знаємо, тож межа від створення заявки;
 *  · без gclid і без телефону рядок не йде — його нема з чим зіставити;
 *  · дочірня угода (копія з «Кваліфікації» у «Перевозки») бере gclid/телефон/мітку батька через `lead_child_links`.
 *
 * Чистий модуль: SQL віддає сирі рядки, тут — лише правила й формат. Тримає гейт `#2510`.
 */
export const GADS_SEND_FORM = "CRM Send_form";
export const GADS_DEAL_WON = "CRM Deal Won";
export const GADS_CURRENCY = "UAH";
/** Цінність заявки — середня маржа рекламної угоди (Юля, 27.10.2026). Змінюється тут, з викатом. */
export const GADS_LEAD_VALUE = 1900;
/**
 * «Авто працює» і все далі по ланцюгу + «Успішно». Список — копія `CHAIN_INFLIGHT` з `core/money.ts`:
 * імпортувати його не можна (money тягне config і БД, а цей модуль чистий). Що копія не розійшлась
 * з оригіналом, стереже `#2510b` — він читає текст money.ts.
 */
export const GADS_CHAIN_INFLIGHT: readonly number[] = [69716300, 98470988, 69716304, 69716312, 69716460, 10937178, 42639144, 42639147, 25044997, 62940068, 60412544];
export const GADS_DEAL_STAGES: readonly number[] = [...GADS_CHAIN_INFLIGHT, 142];
/** Вікно Google для офлайн-конверсій від кліку. */
export const GADS_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

export interface GadsLeadRow { kommoId: number; gclid: string | null; phone: string | null; createdAt: Date }
export interface GadsWonRow { kommoId: number; gclid: string | null; phone: string | null; leadAt: Date; wonAt: Date; price: number }
export interface GadsConversion {
  gclid: string; name: string; time: Date; value: number; transactionId: number; phone: string;
}

/** Київський час у форматі шаблону: `YYYY-MM-DD HH:MM:SS` (TimeZone задано рядком Parameters). */
export function kyivTime(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

/** Номер для Google — E.164. У базі він уже нормалізований до цифр (`utils/phone.ts`): `380…` → `+380…`. */
export function e164(phone: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? `+${digits}` : "";
}

/**
 * Правила відбору. `now` — параметром, щоб гейт не залежав від календаря.
 * Заявки — за останні 90 днів. Продажі — з додатною маржею, не раніше заявки й не пізніше 90 днів від неї.
 */
export function buildConversions(leads: GadsLeadRow[], wins: GadsWonRow[], now: Date): GadsConversion[] {
  const from = now.getTime() - GADS_WINDOW_DAYS * DAY_MS;
  const out: GadsConversion[] = [];
  const seenLead = new Set<number>();
  for (const l of leads) {
    const gclid = l.gclid ?? "";
    const phone = e164(l.phone);
    if ((!gclid && !phone) || seenLead.has(l.kommoId) || l.createdAt.getTime() < from) continue;
    seenLead.add(l.kommoId);
    out.push({ gclid, name: GADS_SEND_FORM, time: l.createdAt, value: GADS_LEAD_VALUE, transactionId: l.kommoId, phone });
  }
  const seenWon = new Set<number>();
  for (const w of wins) {
    const gclid = w.gclid ?? "";
    const phone = e164(w.phone);
    if ((!gclid && !phone) || seenWon.has(w.kommoId) || !(w.price > 0)) continue;
    const lag = w.wonAt.getTime() - w.leadAt.getTime();
    if (lag < 0 || lag > GADS_WINDOW_DAYS * DAY_MS || w.wonAt.getTime() < from) continue;
    seenWon.add(w.kommoId);
    out.push({
      gclid, name: GADS_DEAL_WON, time: w.wonAt, value: Math.round(w.price * 100) / 100,
      transactionId: w.kommoId, phone,
    });
  }
  return out.sort((a, b) => a.time.getTime() - b.time.getTime() || a.transactionId - b.transactionId);
}

function cell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV як у шаблоні рекламниці (рядок Parameters, заголовок, дані) + стовпець телефону для розширених конверсій. */
export function conversionsCsv(rows: GadsConversion[]): string {
  const lines = [
    "Parameters:TimeZone=Europe/Kiev",
    "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Transaction ID,Phone Number",
    ...rows.map((r) => [
      cell(r.gclid), cell(r.name), kyivTime(r.time), String(r.value), GADS_CURRENCY, String(r.transactionId), cell(r.phone),
    ].join(",")),
  ];
  return lines.join("\n") + "\n";
}

/** Головний телефон угоди: основний контакт → основний номер. */
const PHONE_OF = (alias: string) => `
    LEFT JOIN LATERAL (SELECT cp.phone AS phone
                         FROM deal_contacts dc JOIN contact_phones cp ON cp.contact_id = dc.contact_id
                        WHERE dc.deal_kommo_id = ${alias}.kommo_id
                        ORDER BY dc.is_main DESC, cp.is_main DESC, cp.phone
                        LIMIT 1) AS ph_${alias} ON true`;

/** Рекламна заявка з Google: є gclid, або мітка google і телефон (дзвінок з реклами). */
const IS_GOOGLE_LEAD = (gclid: string, utm: string, phone: string) =>
  `(${gclid} IS NOT NULL OR (lower(coalesce(${utm}, '')) LIKE 'google%' AND ${phone} IS NOT NULL))`;

/** Сирі рядки з БД. `AS` скрізь — SQL у шаблонному рядку не типізується (db-sql.md). */
export const GADS_LEADS_SQL = `
  SELECT d.kommo_id AS kommo_id, d.gclid AS gclid, ph_d.phone AS phone, d.created_at_kommo AS created_at
    FROM deals d${PHONE_OF("d")}
   WHERE d.created_at_kommo >= now() - INTERVAL '${GADS_WINDOW_DAYS} days'
     AND ${IS_GOOGLE_LEAD("d.gclid", "d.utm_source", "ph_d.phone")}
     -- Копія з «Кваліфікації» у «Перевозки» несе ті самі мітки: без цього одна людина — дві заявки.
     AND NOT EXISTS (SELECT 1 FROM lead_child_links AS lc WHERE lc.child_id = d.kommo_id)`;

export const GADS_WINS_SQL = `
  SELECT DISTINCT ON (d.kommo_id)
         d.kommo_id AS kommo_id,
         COALESCE(d.gclid, p.gclid) AS gclid,
         COALESCE(ph_d.phone, ph_p.phone) AS phone,
         COALESCE(p.created_at_kommo, d.created_at_kommo) AS lead_at,
         COALESCE(ev.reached_at, d.closed_at_kommo) AS won_at,
         d.price AS price
    FROM deals d
    LEFT JOIN lead_child_links l ON l.child_id = d.kommo_id
    LEFT JOIN deals p ON p.kommo_id = l.parent_id${PHONE_OF("d")}${PHONE_OF("p")}
    LEFT JOIN LATERAL (SELECT min(e.changed_at) AS reached_at FROM deal_stage_events e
                        WHERE e.kommo_id = d.kommo_id AND e.status_id = ANY(ARRAY[${GADS_DEAL_STAGES.join(",")}]::bigint[])) AS ev ON true
   WHERE (d.status_id = ANY(ARRAY[${GADS_DEAL_STAGES.join(",")}]::bigint[]) OR ev.reached_at IS NOT NULL)
     AND COALESCE(ev.reached_at, d.closed_at_kommo) >= now() - INTERVAL '${GADS_WINDOW_DAYS} days'
     AND ${IS_GOOGLE_LEAD("COALESCE(d.gclid, p.gclid)", "COALESCE(d.utm_source, p.utm_source)", "COALESCE(ph_d.phone, ph_p.phone)")}
   ORDER BY d.kommo_id, (COALESCE(d.gclid, p.gclid) IS NOT NULL) DESC, p.created_at_kommo`;

type Q = { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> };

export async function loadConversions(db: Q, now: Date): Promise<GadsConversion[]> {
  const [leads, wins] = await Promise.all([db.query(GADS_LEADS_SQL), db.query(GADS_WINS_SQL)]);
  const s = (v: unknown) => (v == null || v === "" ? null : String(v));
  return buildConversions(
    leads.rows.map((r) => ({ kommoId: Number(r.kommo_id), gclid: s(r.gclid), phone: s(r.phone), createdAt: new Date(r.created_at as string) })),
    wins.rows.map((r) => ({
      kommoId: Number(r.kommo_id), gclid: s(r.gclid), phone: s(r.phone), leadAt: new Date(r.lead_at as string),
      wonAt: new Date(r.won_at as string), price: Number(r.price),
    })),
    now,
  );
}
