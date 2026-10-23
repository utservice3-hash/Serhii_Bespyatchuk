import type { Db } from "./adCallFacts.js";

/**
 * 🎛 ХТО ВЕДЕ PROZORRO-ЛІДИ — «Налаштування» (задача #5299, прохід 2; Роман 22.10.2026: «буде якийсь один лідогенератор,
 * щоб можна було поставити в налаштуваннях»). Лише адмін (роут `settings.ts`).
 *
 * Вибрати можна лише АКТИВНОГО лідогена з акаунтом Kommo — той самий критерій команди, що в `jobs/reactivateLeads.ts`
 * (назва команди містить «лідоген»). Порожньо — дозволено: тоді джоба нічого не пише в Kommo й каже «чекають N».
 * Кожна зміна — у журнал «хто, коли, було → стало».
 */

/** Лідогени, кого можна вибрати. */
export const LEADGEN_TEAM_SQL = `(t.name ILIKE '%лідоген%' OR t.name ILIKE '%лидоген%')`;

export interface LeadgenOption { id: number; name: string; team: string }
export interface ProzorroSettingsView {
  current: { managerId: number; name: string; active: boolean; hasKommo: boolean } | null;
  options: LeadgenOption[];
  queue: { waiting: number; exhausted: number; pushed: number; dryCollected: number };
  history: { oldName: string | null; newName: string | null; setByName: string | null; setAt: string }[];
}

export async function leadgenOptions(db: Db): Promise<LeadgenOption[]> {
  const r = await db.query<{ id: number; name: string; team: string }>(
    `SELECT m.id, m.name, t.name AS team FROM managers m JOIN teams t ON t.id = m.team_id
      WHERE m.is_active AND m.kommo_user_id IS NOT NULL AND ${LEADGEN_TEAM_SQL} ORDER BY m.name`);
  return r.rows;
}

export async function loadProzorroSettings(db: Db, maxAttempts: number): Promise<ProzorroSettingsView> {
  const cur = (await db.query<{ id: number; name: string; is_active: boolean; has_kommo: boolean }>(
    `SELECT m.id, m.name, m.is_active, (m.kommo_user_id IS NOT NULL) AS has_kommo
       FROM prozorro_settings s JOIN managers m ON m.id = s.responsible_manager_id WHERE s.id = 1`)).rows[0];
  const q = (await db.query<{ waiting: number; exhausted: number; pushed: number; dry: number }>(
    `SELECT count(*) FILTER (WHERE mode = 'live' AND kommo_lead_id IS NULL AND push_attempts < $1)::int AS waiting,
            count(*) FILTER (WHERE mode = 'live' AND kommo_lead_id IS NULL AND push_attempts >= $1)::int AS exhausted,
            count(*) FILTER (WHERE kommo_lead_id IS NOT NULL)::int AS pushed,
            count(*) FILTER (WHERE mode = 'dry')::int AS dry
       FROM prozorro_leads`, [maxAttempts])).rows[0];
  const hist = (await db.query<{ old_name: string | null; new_name: string | null; set_by_name: string | null; set_at: Date }>(
    `SELECT mo.name AS old_name, mn.name AS new_name, l.set_by_name, l.set_at
       FROM prozorro_settings_log l LEFT JOIN managers mo ON mo.id = l.old_manager_id LEFT JOIN managers mn ON mn.id = l.new_manager_id
      ORDER BY l.set_at DESC, l.id DESC LIMIT 20`)).rows;
  return {
    current: cur ? { managerId: cur.id, name: cur.name, active: cur.is_active, hasKommo: cur.has_kommo } : null,
    options: await leadgenOptions(db),
    queue: { waiting: q?.waiting ?? 0, exhausted: q?.exhausted ?? 0, pushed: q?.pushed ?? 0, dryCollected: q?.dry ?? 0 },
    history: hist.map((h) => ({ oldName: h.old_name, newName: h.new_name, setByName: h.set_by_name, setAt: new Date(h.set_at).toISOString() })),
  };
}

/** Тіло PUT: `{ managerId: number | null }`. Інше — помилка з людським текстом. */
export function parseProzorroSettings(body: unknown): { ok: true; managerId: number | null } | { ok: false; error: string } {
  const v = (body as { managerId?: unknown } | null)?.managerId;
  if (v === null) return { ok: true, managerId: null };
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return { ok: true, managerId: v };
  return { ok: false, error: "Вкажіть лідогена (managerId) або null, щоб зняти" };
}

/** Зберегти вибір. Не лідоген / неактивний / без Kommo — відмова; без зміни — нічого не пишемо в журнал. */
export async function saveProzorroResponsible(db: Db, managerId: number | null, who: { userId: number | null; name: string | null }):
  Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  if (managerId != null && !(await leadgenOptions(db)).some((o) => o.id === managerId)) {
    return { ok: false, error: "Можна вибрати лише активного лідогена з акаунтом Kommo" };
  }
  const old = (await db.query<{ m: number | null }>(`SELECT responsible_manager_id AS m FROM prozorro_settings WHERE id = 1`)).rows[0]?.m ?? null;
  if (old === managerId) return { ok: true, changed: false };
  await db.query(`INSERT INTO prozorro_settings (id, responsible_manager_id, set_by, set_at) VALUES (1, $1, $2, now())
                  ON CONFLICT (id) DO UPDATE SET responsible_manager_id = EXCLUDED.responsible_manager_id, set_by = EXCLUDED.set_by, set_at = now()`,
    [managerId, who.userId]);
  await db.query(`INSERT INTO prozorro_settings_log (old_manager_id, new_manager_id, set_by, set_by_name) VALUES ($1, $2, $3, $4)`,
    [old, managerId, who.userId, who.name]);
  return { ok: true, changed: true };
}
