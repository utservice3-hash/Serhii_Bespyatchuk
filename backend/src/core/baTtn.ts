/**
 * 🗂 БІЗНЕС-АСИСТЕНТ: ТТН-моніторинг.
 *
 * Прохід 2 (29.09.2026) — «угоди, де потрібна ТТН» з CRM за фільтром Даші, «наявні» вручну.
 * 🔁 05.10.2026 (рішення Романа «роби»): «наявні» теж автоматично.
 *  • «угоди» = фільтр Даші в Kommo (правила й константи — `baRules.ts`), з дзеркала CRM;
 *  • «прикріплено» = серед ТИХ САМИХ угод ті, де в полі «ТТН» (2097291) є файл (`deals.ttn_files`,
 *    пише `syncKommo`); NULL — «не синхронізовано», окремим числом, НЕ як 0;
 *  • «наявні» = прикріплено − позначені Дашею «маршрут не збігся» (звірка документа — людина);
 *  • % = наявні ÷ угоди, норма 70%; без угод — «—», а не 0%.
 *  • «Зафіксувати місяць» — знімок трьох чисел (CRM потім зміниться, а перевірка стосувалась тих).
 * Дати — за Києвом, включно з обома кінцями (правило проєкту). Звіряє з фільтром Даші й Kommo #-гейти.
 */
import { BaError, type Db } from "./baClaims.js";
import {
  TTN_PIPELINE_ID, TTN_STATUS_ID, TTN_PAYMENT_TYPES, isYm, monthBounds, shiftYm, ttnPct, kommoTtnFilterUrl,
} from "./baRules.js";

/** Угоди, де потрібна ТТН, — ОДНЕ визначення для всіх запитів нижче (`d` — псевдонім `deals`). */
const TTN_DEALS_WHERE = `d.pipeline_id = $1 AND d.status_id = $2 AND d.payment_type = ANY($3::text[])
  AND d.manager_id IS NOT NULL
  AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $4::date AND $5::date`;
const ttnParams = (from: string, to: string) => [TTN_PIPELINE_ID, TTN_STATUS_ID, [...TTN_PAYMENT_TYPES], from, to];

export interface TtnCounts { needed: number; attached: number; mismatched: number; unsynced: number; present: number }
const counts = (r: { needed: number; attached: number; mismatched: number; unsynced: number }): TtnCounts =>
  ({ needed: r.needed, attached: r.attached, mismatched: r.mismatched, unsynced: r.unsynced, present: r.attached - r.mismatched });

/**
 * Три числа по менеджерах за період (місяць або кілька місяців — тоді з розбивкою по місяцях).
 * «Не збігся» рахується лише серед прикріплених: позначка на угоді без ТТН нічого не віднімає.
 */
async function ttnCountsBy(db: Db, from: string, to: string) {
  const r = await db.query<{ manager_id: number; ym: string; needed: number; attached: number; mismatched: number; unsynced: number }>(
    `SELECT d.manager_id, to_char((d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv'), 'YYYY-MM') AS ym,
            count(*)::int AS needed,
            count(*) FILTER (WHERE d.ttn_files > 0)::int AS attached,
            count(*) FILTER (WHERE d.ttn_files > 0 AND m.kommo_id IS NOT NULL)::int AS mismatched,
            count(*) FILTER (WHERE d.ttn_files IS NULL)::int AS unsynced
       FROM deals d LEFT JOIN ba_ttn_route_mismatch m ON m.kommo_id = d.kommo_id
      WHERE ${TTN_DEALS_WHERE}
      GROUP BY 1, 2`, ttnParams(from, to));
  return r.rows;
}

/** Три числа по менеджерах за місяць. */
export async function ttnDealsByManager(db: Db, ym: string): Promise<Map<number, TtnCounts>> {
  const { from, to } = monthBounds(ym);
  return new Map((await ttnCountsBy(db, from, to)).map((x) => [x.manager_id, counts(x)]));
}

interface SavedRow {
  manager_id: number; deals_needed: number; ttn_present: number; ttn_attached: number | null; route_mismatch: number | null;
  note: string | null; checked_at: string; checked_by_name: string | null;
}

/**
 * Екран місяця: менеджери з угодами за фільтром АБО зі зафіксованим знімком (щоб знімок не зник,
 * якщо CRM потім змінилась), живі числа, знімок і динаміка % за 6 місяців (живих).
 */
export async function ttnMonth(db: Db, ym: string, kommoBase: string) {
  if (!isYm(ym)) throw new BaError(400, "Місяць у форматі РРРР-ММ");
  const firstYm = shiftYm(ym, -5);
  const all = await ttnCountsBy(db, monthBounds(firstYm).from, monthBounds(ym).to);
  const live = new Map(all.filter((x) => x.ym === ym).map((x) => [x.manager_id, counts(x)]));
  const saved = (await db.query<SavedRow>(
    `SELECT c.manager_id, c.deals_needed, c.ttn_present, c.ttn_attached, c.route_mismatch, c.note,
            to_char(c.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS checked_at,
            COALESCE(NULLIF(btrim(u.full_name), ''), split_part(u.email, '@', 1)) AS checked_by_name
       FROM ba_ttn_checks c LEFT JOIN users u ON u.id = c.checked_by
      WHERE c.month = $1::date`, [`${ym}-01`])).rows;
  const ids = new Set<number>([...live.keys(), ...saved.map((s) => s.manager_id)]);
  const mgrs = ids.size
    ? (await db.query<{ id: number; name: string; kommo_user_id: number | null; is_active: boolean }>(
        `SELECT id, name, kommo_user_id, is_active FROM managers WHERE id = ANY($1::int[])`, [[...ids]])).rows
    : [];
  const months = Array.from({ length: 6 }, (_, i) => shiftYm(ym, i - 5));
  const zero: TtnCounts = { needed: 0, attached: 0, mismatched: 0, unsynced: 0, present: 0 };
  const rows = mgrs.map((m) => {
    const now = live.get(m.id) ?? zero;
    const s = saved.find((x) => x.manager_id === m.id) ?? null;
    return {
      managerId: m.id, name: m.name, active: m.is_active,
      live: { ...now, pct: ttnPct(now.present, now.needed) },
      kommoUrl: m.kommo_user_id ? kommoTtnFilterUrl(kommoBase, m.kommo_user_id, ym) : null,
      saved: s && {
        dealsNeeded: s.deals_needed, ttnAttached: s.ttn_attached, routeMismatch: s.route_mismatch, ttnPresent: s.ttn_present,
        note: s.note ?? "", pct: ttnPct(s.ttn_present, s.deals_needed), checkedAt: s.checked_at, checkedBy: s.checked_by_name,
      },
      history: months.map((mm) => {
        const h = all.find((x) => x.manager_id === m.id && x.ym === mm);
        return { month: mm, pct: h ? ttnPct(h.attached - h.mismatched, h.needed) : null };
      }),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "uk"));
  return { month: ym, rows };
}

/** Угоди менеджера за місяць — щоб Даша бачила, де ТТН немає, і позначала невідповідність маршруту. */
export async function ttnDealsOf(db: Db, ym: string, managerId: number, kommoBase: string) {
  if (!isYm(ym)) throw new BaError(400, "Місяць у форматі РРРР-ММ");
  const { from, to } = monthBounds(ym);
  const r = await db.query<{ kommo_id: string; name: string | null; client_name: string | null; closed_on: string; ttn_files: number | null; note: string | null; marked: boolean }>(
    `SELECT d.kommo_id, d.name, d.client_name, to_char((d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv'), 'YYYY-MM-DD') AS closed_on,
            d.ttn_files, m.note, (m.kommo_id IS NOT NULL) AS marked
       FROM deals d LEFT JOIN ba_ttn_route_mismatch m ON m.kommo_id = d.kommo_id
      WHERE ${TTN_DEALS_WHERE} AND d.manager_id = $6
      ORDER BY (d.ttn_files > 0) NULLS FIRST, d.closed_at_kommo DESC`, [...ttnParams(from, to), managerId]);
  const base = kommoBase.replace(/\/+$/, "").replace(/\/api(\/v4)?$/, "");
  return r.rows.map((x) => ({
    kommoId: Number(x.kommo_id), name: x.name ?? "", client: x.client_name ?? "", closedOn: x.closed_on,
    ttnFiles: x.ttn_files, mismatch: x.marked ? { note: x.note ?? "" } : null,
    url: `${base}/leads/detail/${x.kommo_id}`,
  }));
}

/** «Маршрут не збігся» — лише на угоді, де ТТН ПРИКРІПЛЕНО: на угоді без ТТН відмічати нічого. */
export async function setRouteMismatch(db: Db, actor: number, kommoId: number, body: any): Promise<void> {
  const d = (await db.query<{ ttn_files: number | null }>(`SELECT ttn_files FROM deals WHERE kommo_id = $1`, [kommoId])).rows[0];
  if (!d) throw new BaError(404, "Угоду не знайдено");
  if (!(d.ttn_files && d.ttn_files > 0)) throw new BaError(409, "До угоди не прикріплено ТТН — позначати невідповідність маршруту нічого");
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 1000) || null : null;
  await db.query(
    `INSERT INTO ba_ttn_route_mismatch (kommo_id, note, marked_by) VALUES ($1, $2, $3)
     ON CONFLICT (kommo_id) DO UPDATE SET note = EXCLUDED.note, marked_by = EXCLUDED.marked_by, marked_at = now()`,
    [kommoId, note, actor]);
}
export async function clearRouteMismatch(db: Db, kommoId: number): Promise<void> {
  await db.query(`DELETE FROM ba_ttn_route_mismatch WHERE kommo_id = $1`, [kommoId]);
}

/**
 * Зафіксувати місяць по менеджеру: знімок трьох чисел цієї миті + хто й коли. Повторна фіксація
 * перезаписує знімок (перевірку переробили), а не дублює.
 */
export async function saveTtnCheck(db: Db, actor: number, ym: string, managerId: number, body: any): Promise<void> {
  if (!isYm(ym)) throw new BaError(400, "Місяць у форматі РРРР-ММ");
  const mgr = (await db.query(`SELECT 1 FROM managers WHERE id = $1`, [managerId])).rows[0];
  if (!mgr) throw new BaError(404, "Менеджера не знайдено");
  const c = (await ttnDealsByManager(db, ym)).get(managerId);
  if (!c || !c.needed) throw new BaError(409, "У цьому місяці в менеджера немає угод, де потрібна ТТН — фіксувати нічого");
  if (c.unsynced > 0) throw new BaError(409, `Ще не синхронізовано ТТН у ${c.unsynced} угод(и) — зачекайте синку або запустіть дотягування`);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) || null : null;
  await db.query(
    `INSERT INTO ba_ttn_checks (month, manager_id, deals_needed, ttn_attached, route_mismatch, ttn_present, note, checked_by)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (month, manager_id) DO UPDATE
       SET deals_needed = EXCLUDED.deals_needed, ttn_attached = EXCLUDED.ttn_attached, route_mismatch = EXCLUDED.route_mismatch,
           ttn_present = EXCLUDED.ttn_present, note = EXCLUDED.note, checked_by = EXCLUDED.checked_by, checked_at = now()`,
    [`${ym}-01`, managerId, c.needed, c.attached, c.mismatched, c.present, note, actor]);
}
