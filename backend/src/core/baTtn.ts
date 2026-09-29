/**
 * 🗂 БІЗНЕС-АСИСТЕНТ, прохід 2 (29.09.2026): ТТН-моніторинг.
 *
 * Рішення Романа 29.09.2026 за відповіддю Даші:
 *  • «угод, де потрібна ТТН» = фільтр Даші в Kommo (правила й константи — `baRules.ts`), рахується
 *    АВТОМАТИЧНО з дзеркала CRM; поруч посилання на той самий фільтр у Kommo для звірки;
 *  • «наявні ТТН» вносить Даша вручну: відповідність маршруту у вкладенні перевіряє людина;
 *  • % = наявні ÷ угоди, норма 70%; без угод — «—», а не 0%.
 *  • Місяць за замовчуванням — «два тому»: 1 жовтня перевіряють серпень.
 *
 * 🔴 Число угод при збереженні фіксується ЗНІМКОМ (`deals_needed`): CRM потім зміниться, а перевірка
 * стосувалась саме тих угод. Поточне число з CRM показується поруч — розбіжність видно, а не приховано.
 * Дати — за Києвом, включно з обома кінцями (правило проєкту).
 */
import { BaError, type Db } from "./baClaims.js";
import {
  TTN_PIPELINE_ID, TTN_STATUS_ID, TTN_PAYMENT_TYPES, isYm, monthBounds, shiftYm, ttnPct, kommoTtnFilterUrl,
} from "./baRules.js";

/**
 * Угоди, де потрібна ТТН, по менеджерах за місяць — ОДИН SQL, яким користуються і екран, і
 * збереження. Відповідальний = `deals.manager_id`. Звіряє з фільтром Даші гейт #982.
 */
export async function ttnDealsByManager(db: Db, ym: string): Promise<Map<number, number>> {
  const { from, to } = monthBounds(ym);
  const r = await db.query<{ manager_id: number; n: number }>(
    `SELECT d.manager_id, count(*)::int AS n
       FROM deals d
      WHERE d.pipeline_id = $1 AND d.status_id = $2
        AND d.payment_type = ANY($3::text[])
        AND d.manager_id IS NOT NULL
        AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $4::date AND $5::date
      GROUP BY d.manager_id`,
    [TTN_PIPELINE_ID, TTN_STATUS_ID, [...TTN_PAYMENT_TYPES], from, to]);
  return new Map(r.rows.map((x) => [x.manager_id, x.n]));
}

interface SavedRow { manager_id: number; month: string; deals_needed: number; ttn_present: number; note: string | null; checked_at: string; checked_by_name: string | null }

/**
 * Екран місяця: менеджери, у яких є угоди за фільтром АБО збережена перевірка (щоб збережене не
 * зникло, якщо CRM потім змінилась), і динаміка % за 6 місяців по кожному.
 */
export async function ttnMonth(db: Db, ym: string, kommoBase: string) {
  if (!isYm(ym)) throw new BaError(400, "Місяць у форматі РРРР-ММ");
  const live = await ttnDealsByManager(db, ym);
  const firstYm = shiftYm(ym, -5);
  const saved = (await db.query<SavedRow>(
    `SELECT c.manager_id, to_char(c.month, 'YYYY-MM') AS month, c.deals_needed, c.ttn_present, c.note,
            to_char(c.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS checked_at,
            COALESCE(NULLIF(btrim(u.full_name), ''), split_part(u.email, '@', 1)) AS checked_by_name
       FROM ba_ttn_checks c LEFT JOIN users u ON u.id = c.checked_by
      WHERE c.month BETWEEN $1::date AND $2::date`, [`${firstYm}-01`, `${ym}-01`])).rows;
  const ids = new Set<number>([...live.keys(), ...saved.filter((s) => s.month === ym).map((s) => s.manager_id)]);
  const mgrs = ids.size
    ? (await db.query<{ id: number; name: string; kommo_user_id: number | null; is_active: boolean }>(
        `SELECT id, name, kommo_user_id, is_active FROM managers WHERE id = ANY($1::int[])`, [[...ids]])).rows
    : [];
  const months = Array.from({ length: 6 }, (_, i) => shiftYm(ym, i - 5));
  const rows = mgrs.map((m) => {
    const s = saved.find((x) => x.manager_id === m.id && x.month === ym) ?? null;
    const dealsNow = live.get(m.id) ?? 0;
    return {
      managerId: m.id, name: m.name, active: m.is_active, dealsNow,
      kommoUrl: m.kommo_user_id ? kommoTtnFilterUrl(kommoBase, m.kommo_user_id, ym) : null,
      saved: s && {
        dealsNeeded: s.deals_needed, ttnPresent: s.ttn_present, note: s.note ?? "",
        pct: ttnPct(s.ttn_present, s.deals_needed), checkedAt: s.checked_at, checkedBy: s.checked_by_name,
      },
      history: months.map((mm) => {
        const h = saved.find((x) => x.manager_id === m.id && x.month === mm);
        return { month: mm, pct: h ? ttnPct(h.ttn_present, h.deals_needed) : null };
      }),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "uk"));
  return { month: ym, rows };
}

/**
 * Зберегти місяць по менеджеру: «наявні» — з форми, «угоди» — ЗНІМОК з CRM цієї миті. Наявних
 * більше, ніж угод, бути не може (ТТН рахуються серед тих самих угод) — 400.
 */
export async function saveTtnCheck(db: Db, actor: number, ym: string, managerId: number, body: any): Promise<void> {
  if (!isYm(ym)) throw new BaError(400, "Місяць у форматі РРРР-ММ");
  const present = Number(body?.ttnPresent);
  if (!Number.isInteger(present) || present < 0) throw new BaError(400, "Наявні ТТН — ціле невідʼємне число");
  const mgr = (await db.query(`SELECT 1 FROM managers WHERE id = $1`, [managerId])).rows[0];
  if (!mgr) throw new BaError(404, "Менеджера не знайдено");
  const needed = (await ttnDealsByManager(db, ym)).get(managerId) ?? 0;
  if (present > needed) throw new BaError(400, `Наявних ТТН (${present}) більше, ніж угод, де вона потрібна (${needed})`, { dealsNow: needed });
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) || null : null;
  await db.query(
    `INSERT INTO ba_ttn_checks (month, manager_id, deals_needed, ttn_present, note, checked_by)
     VALUES ($1::date, $2, $3, $4, $5, $6)
     ON CONFLICT (month, manager_id) DO UPDATE
       SET deals_needed = EXCLUDED.deals_needed, ttn_present = EXCLUDED.ttn_present, note = EXCLUDED.note,
           checked_by = EXCLUDED.checked_by, checked_at = now()`,
    [`${ym}-01`, managerId, needed, present, note, actor]);
}
