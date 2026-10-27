/**
 * 📈 ОФЛАЙН-КОНВЕРСІЇ ДЛЯ GOOGLE ADS (Роман 27.10.2026, формат — шаблон рекламниці «UTS_GoogleAds - Data»).
 *
 * Навіщо: Google Ads вчиться на тих кліках, після яких була заявка й продаж. Щодня віддаємо CSV:
 *  · `CRM Send_form` — кожна заявка з gclid; час = створення угоди; суми НЕМАЄ (у мить заявки її не знати);
 *  · `CRM Deal Won` — успішна угода (142); час = перехід у «Успішно», сума = `deals.price`.
 *
 * 🔴 СУМА — МАРЖА, а не оплата клієнта. `deals.price` («Бюджет» Kommo) у UTS і є маржею — підтвердили
 * власник (schema.sql, «ПОВНА СУМА УГОДИ») і фінансистка Таня 27.10.2026. Рішення Романа: Google вчиться
 * на прибутку, не на обороті (більша частина оплати клієнта — гроші перевізника).
 *
 * Межі Google, які тут тримаються, а не на боці рекламниці:
 *  · продаж пізніше 90 днів від кліку Google відхиляє — клік не знаємо, тож межа від створення заявки;
 *  · угода без gclid (дзвінок, органіка) у файл не йде — без нього Google її не зіставить;
 *  · дочірня угода (копія з «Кваліфікації» у «Перевозки») бере gclid батька через `lead_child_links`.
 *
 * Чистий модуль: SQL віддає сирі рядки, тут — лише правила й формат. Тримає гейт `#2490`.
 */

export const GADS_SEND_FORM = "CRM Send_form";
export const GADS_DEAL_WON = "CRM Deal Won";
export const GADS_CURRENCY = "UAH";
/** Вікно Google для офлайн-конверсій від кліку. */
export const GADS_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

export interface GadsLeadRow { kommoId: number; gclid: string; createdAt: Date }
export interface GadsWonRow { kommoId: number; gclid: string; leadAt: Date; wonAt: Date; price: number }
export interface GadsConversion { gclid: string; name: string; time: Date; value: number | null; transactionId: number }

/** Київський час у форматі шаблону: `YYYY-MM-DD HH:MM:SS` (TimeZone задано рядком Parameters). */
export function kyivTime(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
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
    if (!l.gclid || seenLead.has(l.kommoId) || l.createdAt.getTime() < from) continue;
    seenLead.add(l.kommoId);
    out.push({ gclid: l.gclid, name: GADS_SEND_FORM, time: l.createdAt, value: null, transactionId: l.kommoId });
  }
  const seenWon = new Set<number>();
  for (const w of wins) {
    if (!w.gclid || seenWon.has(w.kommoId) || !(w.price > 0)) continue;
    const lag = w.wonAt.getTime() - w.leadAt.getTime();
    if (lag < 0 || lag > GADS_WINDOW_DAYS * DAY_MS || w.wonAt.getTime() < from) continue;
    seenWon.add(w.kommoId);
    out.push({ gclid: w.gclid, name: GADS_DEAL_WON, time: w.wonAt, value: Math.round(w.price * 100) / 100, transactionId: w.kommoId });
  }
  return out.sort((a, b) => a.time.getTime() - b.time.getTime() || a.transactionId - b.transactionId);
}

function cell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV рівно як у шаблоні: рядок Parameters, заголовок, дані. */
export function conversionsCsv(rows: GadsConversion[]): string {
  const lines = [
    "Parameters:TimeZone=Europe/Kiev",
    "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Transaction ID",
    ...rows.map((r) => [
      cell(r.gclid), cell(r.name), kyivTime(r.time),
      r.value == null ? "" : String(r.value), GADS_CURRENCY, String(r.transactionId),
    ].join(",")),
  ];
  return lines.join("\n") + "\n";
}

/** Сирі рядки з БД. `AS` скрізь — SQL у шаблонному рядку не типізується (db-sql.md). */
export const GADS_LEADS_SQL = `
  SELECT d.kommo_id AS kommo_id, d.gclid AS gclid, d.created_at_kommo AS created_at
    FROM deals d
   WHERE d.gclid IS NOT NULL AND d.created_at_kommo >= now() - INTERVAL '${GADS_WINDOW_DAYS} days'`;

export const GADS_WINS_SQL = `
  SELECT DISTINCT ON (d.kommo_id)
         d.kommo_id AS kommo_id,
         COALESCE(d.gclid, p.gclid) AS gclid,
         COALESCE(p.created_at_kommo, d.created_at_kommo) AS lead_at,
         COALESCE(ev.won_at, d.closed_at_kommo) AS won_at,
         d.price AS price
    FROM deals d
    LEFT JOIN lead_child_links l ON l.child_id = d.kommo_id
    LEFT JOIN deals p ON p.kommo_id = l.parent_id AND p.gclid IS NOT NULL
    LEFT JOIN LATERAL (SELECT max(e.changed_at) AS won_at FROM deal_stage_events e
                        WHERE e.kommo_id = d.kommo_id AND e.status_id = 142) AS ev ON true
   WHERE d.status_id = 142
     AND COALESCE(d.gclid, p.gclid) IS NOT NULL
     AND COALESCE(ev.won_at, d.closed_at_kommo) >= now() - INTERVAL '${GADS_WINDOW_DAYS} days'
   ORDER BY d.kommo_id, (d.gclid IS NOT NULL) DESC, p.created_at_kommo`;

type Q = { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> };

export async function loadConversions(db: Q, now: Date): Promise<GadsConversion[]> {
  const [leads, wins] = await Promise.all([db.query(GADS_LEADS_SQL), db.query(GADS_WINS_SQL)]);
  return buildConversions(
    leads.rows.map((r) => ({ kommoId: Number(r.kommo_id), gclid: String(r.gclid), createdAt: new Date(r.created_at as string) })),
    wins.rows.map((r) => ({
      kommoId: Number(r.kommo_id), gclid: String(r.gclid), leadAt: new Date(r.lead_at as string),
      wonAt: new Date(r.won_at as string), price: Number(r.price),
    })),
    now,
  );
}
