import type { Db } from "./adCallFacts.js";
import { PROZORRO_NICHES } from "./prozorroNiches.js";
import type { PzMode } from "./prozorroPush.js";

/**
 * 🎛 НАЛАШТУВАННЯ PROZORRO-ЛІДІВ — екран «Тендери Prozorro» → «Налаштування» (задача #5299, прохід 2; Роман 23.10.2026:
 * «додай налаштування цього функціоналу, наприклад ліміти»). Змінюють адмін і ОПЕРАЦІЙНИЙ ДИРЕКТОР (`SETTINGS_ROLES`): Роман
 * 23.10.2026 — «щоб Сергій зайшов, нажав бойовий режим, поставив відповідального лідгена»; у Сергія роль `opdir`.
 *
 * Усе керування — в одному рядку `prozorro_settings`, а не в змінних сервера: режим, хто веде, ліміт угод на день,
 * мінімальна сума тендера, вимкнені ніші. Кожна зміна — рядок журналу на поле («хто, коли, було → стало»).
 * Вибрати можна лише АКТИВНОГО лідогена з акаунтом Kommo — той самий критерій команди, що в `jobs/reactivateLeads.ts`.
 */

/** Хто бачить і змінює налаштування. Одне місце для роуту й гейта; фронт дзеркалить (`ProzorroSection.tsx`). */
export const SETTINGS_ROLES: readonly string[] = ["admin", "opdir"];
export const canEditSettings = (roleKey: string | null | undefined): boolean => !!roleKey && SETTINGS_ROLES.includes(roleKey);

export const LEADGEN_TEAM_SQL = `(t.name ILIKE '%лідоген%' OR t.name ILIKE '%лидоген%')`;
export const DAILY_LIMIT_MAX = 500;
export const MIN_AMOUNT_MAX = 100_000_000;
export const NICHE_NAMES: readonly string[] = Object.keys(PROZORRO_NICHES);

export interface PzConfig {
  responsibleManagerId: number | null;
  mode: PzMode;
  /** Скільки нових угод у Kommo за день (= за прохід). null — без ліміту. */
  dailyLimit: number | null;
  minAmount: number;
  nichesOff: string[];
}
export const DEFAULT_CONFIG: Readonly<PzConfig> = Object.freeze({ responsibleManagerId: null, mode: "dry", dailyLimit: null, minAmount: 500_000, nichesOff: [] });

export async function loadConfig(db: Db): Promise<PzConfig> {
  const r = (await db.query<{ m: number | null; mode: string; daily_limit: number | null; min_amount: string; niches_off: string[] | null }>(
    `SELECT responsible_manager_id AS m, mode, daily_limit, min_amount::text, niches_off FROM prozorro_settings WHERE id = 1`)).rows[0];
  if (!r) return { ...DEFAULT_CONFIG, nichesOff: [] };
  return { responsibleManagerId: r.m, mode: r.mode === "off" || r.mode === "live" ? r.mode : "dry", dailyLimit: r.daily_limit,
    minAmount: Number(r.min_amount), nichesOff: r.niches_off ?? [] };
}

/** Ніші, у яких шукаємо: усі з ТЗ мінус вимкнені. */
export function activeNiches(off: readonly string[]): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(PROZORRO_NICHES).filter(([n]) => !off.includes(n)));
}

/** Тіло PUT — повний конфіг. Межі: ліміт 1..500 або null; сума 0..100 млн; ніші — лише з ТЗ. */
export function parseConfig(body: unknown): { ok: true; value: PzConfig } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const rid = b.responsibleManagerId;
  if (!(rid === null || (typeof rid === "number" && Number.isInteger(rid) && rid > 0))) return { ok: false, error: "Лідоген: виберіть зі списку або «не вибрано»" };
  if (b.mode !== "off" && b.mode !== "dry" && b.mode !== "live") return { ok: false, error: "Режим: вимкнено, пробний або бойовий" };
  const dl = b.dailyLimit;
  if (!(dl === null || (typeof dl === "number" && Number.isInteger(dl) && dl >= 1 && dl <= DAILY_LIMIT_MAX))) {
    return { ok: false, error: `Ліміт на день: ціле від 1 до ${String(DAILY_LIMIT_MAX)} або порожньо (без ліміту)` };
  }
  const ma = b.minAmount;
  if (!(typeof ma === "number" && Number.isFinite(ma) && ma >= 0 && ma <= MIN_AMOUNT_MAX)) return { ok: false, error: "Мінімальна сума: від 0 до 100 000 000 ₴" };
  const no = b.nichesOff;
  if (!Array.isArray(no) || no.some((n) => typeof n !== "string" || !NICHE_NAMES.includes(n))) return { ok: false, error: "Ніші: лише з переліку ТЗ" };
  if (no.length >= NICHE_NAMES.length) return { ok: false, error: "Ніші: залиште хоча б одну — інакше шукати нічого" };
  return { ok: true, value: { responsibleManagerId: rid, mode: b.mode, dailyLimit: dl, minAmount: Math.round(ma), nichesOff: [...new Set(no as string[])].sort() } };
}

export interface LeadgenOption { id: number; name: string; team: string }
export async function leadgenOptions(db: Db): Promise<LeadgenOption[]> {
  const r = await db.query<{ id: number; name: string; team: string }>(
    `SELECT m.id, m.name, t.name AS team FROM managers m JOIN teams t ON t.id = m.team_id
      WHERE m.is_active AND m.kommo_user_id IS NOT NULL AND ${LEADGEN_TEAM_SQL} ORDER BY m.name`);
  return r.rows;
}

const MODE_UA: Record<PzMode, string> = { off: "вимкнено", dry: "пробний", live: "бойовий" };
/** Людські значення для журналу: те, що прочитає людина в історії, а не id. */
export function describeChanges(prev: PzConfig, next: PzConfig, names: ReadonlyMap<number, string>): { field: string; old: string; neu: string }[] {
  const who = (id: number | null) => (id == null ? "не вибрано" : names.get(id) ?? `#${String(id)}`);
  const lim = (n: number | null) => (n == null ? "без ліміту" : String(n));
  const uah = (n: number) => `${Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ")} ₴`;
  const nic = (xs: readonly string[]) => (xs.length ? `вимкнено: ${xs.join(", ")}` : "усі");
  const out: { field: string; old: string; neu: string }[] = [];
  if (prev.mode !== next.mode) out.push({ field: "режим", old: MODE_UA[prev.mode], neu: MODE_UA[next.mode] });
  if (prev.responsibleManagerId !== next.responsibleManagerId) out.push({ field: "лідоген", old: who(prev.responsibleManagerId), neu: who(next.responsibleManagerId) });
  if (prev.dailyLimit !== next.dailyLimit) out.push({ field: "ліміт на день", old: lim(prev.dailyLimit), neu: lim(next.dailyLimit) });
  if (prev.minAmount !== next.minAmount) out.push({ field: "мінімальна сума", old: uah(prev.minAmount), neu: uah(next.minAmount) });
  if ([...prev.nichesOff].sort().join("|") !== [...next.nichesOff].sort().join("|")) out.push({ field: "ніші", old: nic(prev.nichesOff), neu: nic(next.nichesOff) });
  return out;
}

/** Зберегти. Лідоген — лише з активних лідогенів (або «не вибрано»). Без змін — нічого не пишемо. */
export async function saveConfig(db: Db, next: PzConfig, who: { userId: number | null; name: string | null }):
  Promise<{ ok: true; changed: number } | { ok: false; error: string }> {
  const opts = await leadgenOptions(db);
  const prev = await loadConfig(db);
  // Уже вибраного, але згодом деактивованого лідогена дозволено лишити (зберегти інші поля) — змінити НА неактивного не можна.
  if (next.responsibleManagerId != null && next.responsibleManagerId !== prev.responsibleManagerId && !opts.some((o) => o.id === next.responsibleManagerId)) {
    return { ok: false, error: "Можна вибрати лише активного лідогена з акаунтом Kommo" };
  }
  const ids = [prev.responsibleManagerId, next.responsibleManagerId].filter((x): x is number => x != null);
  const names = new Map((ids.length ? (await db.query<{ id: number; name: string }>(`SELECT id, name FROM managers WHERE id = ANY($1::int[])`, [ids])).rows : [])
    .map((r) => [r.id, r.name] as [number, string]));
  const diff = describeChanges(prev, next, names);
  if (!diff.length) return { ok: true, changed: 0 };
  await db.query(`INSERT INTO prozorro_settings (id, responsible_manager_id, mode, daily_limit, min_amount, niches_off, set_by, set_at)
                  VALUES (1, $1, $2, $3, $4, $5::text[], $6, now())
                  ON CONFLICT (id) DO UPDATE SET responsible_manager_id = EXCLUDED.responsible_manager_id, mode = EXCLUDED.mode,
                    daily_limit = EXCLUDED.daily_limit, min_amount = EXCLUDED.min_amount, niches_off = EXCLUDED.niches_off,
                    set_by = EXCLUDED.set_by, set_at = now()`,
    [next.responsibleManagerId, next.mode, next.dailyLimit, next.minAmount, next.nichesOff, who.userId]);
  for (const d of diff) {
    await db.query(`INSERT INTO prozorro_settings_log (field, old_value, new_value, set_by, set_by_name) VALUES ($1, $2, $3, $4, $5)`,
      [d.field, d.old, d.neu, who.userId, who.name]);
  }
  return { ok: true, changed: diff.length };
}

export interface ProzorroSettingsView {
  config: PzConfig;
  responsible: { name: string; active: boolean; hasKommo: boolean } | null;
  options: LeadgenOption[];
  niches: { name: string; words: number; on: boolean; leads30d: number }[];
  queue: { waiting: number; exhausted: number; pushed: number; dryCollected: number };
  history: { field: string; oldValue: string | null; newValue: string | null; setByName: string | null; setAt: string }[];
}

export async function loadSettingsView(db: Db, maxAttempts: number): Promise<ProzorroSettingsView> {
  const config = await loadConfig(db);
  const cur = config.responsibleManagerId == null ? null : (await db.query<{ name: string; is_active: boolean; has_kommo: boolean }>(
    `SELECT name, is_active, (kommo_user_id IS NOT NULL) AS has_kommo FROM managers WHERE id = $1`, [config.responsibleManagerId])).rows[0] ?? null;
  const q = (await db.query<{ waiting: number; exhausted: number; pushed: number; dry: number }>(
    `SELECT count(*) FILTER (WHERE mode = 'live' AND kommo_lead_id IS NULL AND push_attempts < $1)::int AS waiting,
            count(*) FILTER (WHERE mode = 'live' AND kommo_lead_id IS NULL AND push_attempts >= $1)::int AS exhausted,
            count(*) FILTER (WHERE kommo_lead_id IS NOT NULL)::int AS pushed,
            count(*) FILTER (WHERE mode = 'dry')::int AS dry
       FROM prozorro_leads`, [maxAttempts])).rows[0];
  const per = new Map((await db.query<{ niche: string; n: number }>(
    `SELECT unnest(niches) AS niche, count(*)::int AS n FROM prozorro_leads WHERE created_at > now() - interval '30 days' GROUP BY 1`)).rows
    .map((r) => [r.niche, r.n] as [string, number]));
  const hist = (await db.query<{ field: string; old_value: string | null; new_value: string | null; set_by_name: string | null; set_at: Date }>(
    `SELECT field, old_value, new_value, set_by_name, set_at FROM prozorro_settings_log ORDER BY set_at DESC, id DESC LIMIT 30`)).rows;
  return {
    config,
    responsible: cur ? { name: cur.name, active: cur.is_active, hasKommo: cur.has_kommo } : null,
    options: await leadgenOptions(db),
    niches: Object.entries(PROZORRO_NICHES).map(([name, words]) => ({ name, words: words.length, on: !config.nichesOff.includes(name), leads30d: per.get(name) ?? 0 })),
    queue: { waiting: q?.waiting ?? 0, exhausted: q?.exhausted ?? 0, pushed: q?.pushed ?? 0, dryCollected: q?.dry ?? 0 },
    history: hist.map((h) => ({ field: h.field, oldValue: h.old_value, newValue: h.new_value, setByName: h.set_by_name, setAt: new Date(h.set_at).toISOString() })),
  };
}
