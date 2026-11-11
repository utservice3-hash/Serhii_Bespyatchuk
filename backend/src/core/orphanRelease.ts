/**
 * 🧭 «В НІЧИЙНІ» → ПУЛ ЛІДГЕНІВ (задачі 8135 + 8349; ТЗ Юлі 06.11 і 09.11.2026 у 8850; Роман 11.11.2026).
 *
 * Постійні — зона менеджера і тімліда. Не спрацювались — менеджер віддає клієнта в «Нічийні» з ОБОВʼЯЗКОВИМ
 * коментарем, усім менеджерам іде сповіщення, хто хоче — бере собі. Ніхто не взяв за 1 РОБОЧИЙ день — клієнт іде
 * в пул лідгенів (`client_react_cycles`, `pool_reason = 'orphan'`). Поки клієнт у нічийних або в пулі — у списку й
 * лічильниках менеджера його немає (8349: «передані лідгенам не висять у менеджера і не псують його цифри»).
 *
 * Рішення Романа 11.11.2026 (відповіді на план): групу «Віддали менеджери» бачать і беруть собі ВСІ менеджери;
 * «1 день» = робочий (пт ввечері → пн ввечері); коментар обовʼязковий; старий пул (545) закрито `pool_off`.
 *
 * 🔴 KOMMO НЕ ЧІПАЄМО. Відповідальний у CRM лишається тим самим; «нічийні» й пул живуть лише в дашборді, рівно як
 * наявні «Нічийні» (`loyalty_overrides.pinned_manager_id`) і старий пул лідгенів.
 *
 * Чисті правила — вгорі (гейти ганяють їх без БД); запити — нижче, з явним `db` (як `reactCycle.ts`).
 */
import { emitAll } from "../payroll/notifyCenter.js";

export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Найкоротший коментар «чому віддаю» — менше вже не пояснює нічого (Роман 11.11: «обовʼязково»). */
export const RELEASE_NOTE_MIN = 5;
export const RELEASE_NOTE_MAX = 1000;
/** Тип сповіщення в центрі сповіщень (`notify_rules`). */
export const NOTIFY_TYPE = "client.orphan";

/** Коментар із тіла запиту: обрізаний; коротший за `RELEASE_NOTE_MIN` — `null` (роут відповість 400). */
export function cleanReleaseNote(x: unknown): string | null {
  const s = typeof x === "string" ? x.trim().slice(0, RELEASE_NOTE_MAX) : "";
  return s.length >= RELEASE_NOTE_MIN ? s : null;
}

/** День тижня за Києвом (0 — неділя … 6 — субота). */
function kyivWeekday(ms: number): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Kyiv", weekday: "short" }).format(new Date(ms));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/**
 * 🗓 ДО КОЛИ КЛІЄНТ ЧЕКАЄ В НІЧИЙНИХ — 1 РОБОЧИЙ ДЕНЬ (Роман 11.11.2026). Та сама година наступного дня; якщо той
 * день — субота чи неділя, строк їде на понеділок тієї ж години. Пт 17:00 → пн 17:00; сб 10:00 → пн 10:00.
 * ⚠️ Свята (`company_holidays`) тут НЕ враховані — той самий борг №2 «свята в календарі робочих днів», що й у
 * плані тижня; заводити тут третій календар означало б розійтись із двома наявними.
 */
export function releaseDeadline(releasedAtIso: string): string {
  const DAY = 86_400_000;
  let t = Date.parse(releasedAtIso) + DAY;
  for (let i = 0; i < 3 && (kyivWeekday(t) === 0 || kyivWeekday(t) === 6); i++) t += DAY;
  return new Date(t).toISOString();
}

/** Чи минув строк — пора в пул лідгенів. */
export function releaseDue(releasedAtIso: string, nowIso: string): boolean {
  return Date.parse(nowIso) >= Date.parse(releaseDeadline(releasedAtIso));
}

/**
 * Клієнт ожив, поки чекав у нічийних: зʼявився рахунок ПІЗНІШЕ за день, коли його віддали. Тоді він не нічийний —
 * з ним працюють, і він повертається до свого менеджера (позначка знімається, лідгенам не йде).
 */
export function releaseRevived(releasedDay: string, lastInvoice: string | null): boolean {
  return lastInvoice != null && lastInvoice > releasedDay;
}

/** Що робити з клієнтом у нічийних зараз — одна відповідь на рядок, щоб джоба й гейт не розійшлись. */
export function releaseAction(r: { releasedAt: string; releasedDay: string; lastInvoice: string | null }, nowIso: string):
  "revived" | "to_leadgen" | "wait" {
  if (releaseRevived(r.releasedDay, r.lastInvoice)) return "revived";
  return releaseDue(r.releasedAt, nowIso) ? "to_leadgen" : "wait";
}

// ─────────────────────────────── запити ───────────────────────────────

export interface ReleasedRow {
  clientKey: string;
  /** ISO-час, коли віддали. */
  releasedAt: string;
  /** Той самий момент — день за Києвом `YYYY-MM-DD`. */
  releasedDay: string;
  releasedBy: number;
  releasedByName: string | null;
  note: string;
  fromManagerId: number | null;
  fromManagerName: string | null;
}

/** Усі, хто зараз у нічийних «від менеджера». */
export async function releasedRows(db: Db, keys?: string[]): Promise<ReleasedRow[]> {
  const r = await db.query<{ client_key: string; at: string; day: string; by: number; by_name: string | null;
    note: string; from_id: number | null; from_name: string | null }>(
    `SELECT lo.client_key, to_char(lo.released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
            to_char(lo.released_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day,
            lo.released_by AS by, COALESCE(um.name, u.full_name, u.email) AS by_name, lo.released_note AS note,
            lo.released_from_manager_id AS from_id, fm.name AS from_name
       FROM loyalty_overrides lo
       LEFT JOIN users u ON u.id = lo.released_by
       LEFT JOIN managers um ON um.id = u.manager_id
       LEFT JOIN managers fm ON fm.id = lo.released_from_manager_id
      WHERE lo.released_at IS NOT NULL ${keys ? "AND lo.client_key = ANY($1)" : ""}
      ORDER BY lo.released_at, lo.client_key`, keys ? [keys] : []);
  return r.rows.map((x) => ({ clientKey: x.client_key, releasedAt: x.at, releasedDay: x.day, releasedBy: x.by,
    releasedByName: x.by_name, note: x.note, fromManagerId: x.from_id, fromManagerName: x.from_name }));
}

/**
 * 🚪 8349 — КОГО НЕМАЄ В СПИСКУ МЕНЕДЖЕРА: у нічийних «від менеджера» АБО у відкритому рядку пулу лідгенів.
 * Одна множина на всі читачі (список «Клієнти та реактивація», картка), щоб «зник у менеджера» і «є в нічийних /
 * у пулі» не розійшлись між екранами.
 */
export const HANDED_OFF_SQL = `
  SELECT client_key FROM loyalty_overrides WHERE released_at IS NOT NULL
  UNION
  SELECT client_key FROM client_react_cycles WHERE pooled_at IS NOT NULL AND closed_at IS NULL`;

export async function handedOffKeys(db: Db): Promise<Set<string>> {
  const r = await db.query<{ client_key: string }>(HANDED_OFF_SQL);
  return new Set(r.rows.map((x) => x.client_key));
}

/** Стан клієнта для картки: у нічийних (і до коли), у пулі лідгенів — чи ні. */
export async function handoffState(db: Db, clientKey: string): Promise<{
  released: { at: string; deadline: string; note: string; byName: string | null; fromManagerName: string | null } | null;
  inLeadgenPool: { pooledDay: string; reason: string } | null;
}> {
  const [rel, pool] = await Promise.all([
    releasedRows(db, [clientKey]),
    db.query<{ day: string; reason: string }>(
      `SELECT to_char(pooled_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day, pool_reason AS reason
         FROM client_react_cycles WHERE client_key = $1 AND pooled_at IS NOT NULL AND closed_at IS NULL`, [clientKey]),
  ]);
  const r = rel[0];
  return {
    released: r ? { at: r.releasedAt, deadline: releaseDeadline(r.releasedAt), note: r.note, byName: r.releasedByName,
      fromManagerName: r.fromManagerName } : null,
    inLeadgenPool: pool.rows[0] ? { pooledDay: pool.rows[0].day, reason: pool.rows[0].reason } : null,
  };
}

/**
 * Віддати в нічийні. Позначка, автор, коментар і «від кого» — ОДНИМ запитом (CHECK крос-колонковий).
 * Повторно не віддається: уже в нічийних → `false` (роут відповість 409, а не тихо перепише коментар і строк).
 */
export async function release(db: Db, a: { clientKey: string; userId: number; fromManagerId: number | null; note: string }): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO loyalty_overrides (client_key, released_at, released_by, released_note, released_from_manager_id, updated_by, updated_at)
     VALUES ($1, now(), $2, $3, $4, $2, now())
     ON CONFLICT (client_key) DO UPDATE SET released_at = EXCLUDED.released_at, released_by = EXCLUDED.released_by,
       released_note = EXCLUDED.released_note, released_from_manager_id = EXCLUDED.released_from_manager_id,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     WHERE loyalty_overrides.released_at IS NULL`,
    [a.clientKey, a.userId, a.note, a.fromManagerId]);
  return (r.rowCount ?? 0) > 0;
}

/** Зняти позначку (відкликали, взяли, ожив, пішов лідгенам). Усі чотири поля — разом. */
export async function clearRelease(db: Db, clientKey: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE loyalty_overrides SET released_at = NULL, released_by = NULL, released_note = NULL,
            released_from_manager_id = NULL, updated_at = now()
      WHERE client_key = $1 AND released_at IS NOT NULL`, [clientKey]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 🔔 Сповіщення «візьміть, якщо ваш» — усім менеджерам відділу продажів: активний акаунт, привʼязаний до активного
 * менеджера з командою, роль менеджер або тімлід. БЕЗ того, хто віддав, і без лідгенів (до них клієнт прийде сам
 * через робочий день). Без `done`: закриваємо самі (`closeReleaseNotices`) — правило рушія «Зарплати» про
 * наші події нічого не знає.
 */
export async function notifyReleased(db: Db, a: {
  clientKey: string; clientName: string; fromName: string | null; note: string; releaserUserId: number;
  leadgenTeamId: number; deadline: string;
}): Promise<number> {
  const to = await db.query<{ id: number }>(
    `SELECT u.id FROM users u JOIN managers m ON m.id = u.manager_id
      WHERE u.is_active AND m.is_active AND m.team_id IS NOT NULL AND m.team_id <> $1
        AND COALESCE(u.role_override, u.role) IN ('manager', 'team_lead') AND u.id <> $2`,
    [a.leadgenTeamId, a.releaserUserId]);
  const until = new Date(a.deadline).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit" });
  const ids = await emitAll(db as never, [{
    type: NOTIFY_TYPE, act: true, cta: "Взяти в роботу",
    to: to.rows.map((x) => String(x.id)),
    title: `Клієнт у нічийних: ${a.clientName}`,
    text: `${a.fromName ?? "Менеджер"} віддав клієнта: «${a.note}». Візьміть, якщо ваш — до ${until}; далі клієнт іде лідгенам.`,
    go: { section: "loyalty", query: "?tab=pool", clientKey: a.clientKey },
  }]);
  return ids.length;
}

/** Закрити «потрібна дія» по клієнту — його взяли, відкликали, він ожив або пішов лідгенам. */
export async function closeReleaseNotices(db: Db, clientKey: string): Promise<number> {
  const r = await db.query(
    `UPDATE notifications SET done_at = now()
      WHERE type = $1 AND act AND done_at IS NULL AND link->>'clientKey' = $2`, [NOTIFY_TYPE, clientKey]);
  return r.rowCount ?? 0;
}

/**
 * Перевести в пул лідгенів (викликати В ТРАНЗАКЦІЇ): рядок пулу `orphan` поточного місяця + зняти позначку.
 * Рядок цього місяця вже є (наприклад, «реактивую сам» або старий закритий) — перевідкриваємо його як `orphan`.
 * Уже лежить у пулі іншим рядком — лише знімаємо позначку (у пулі клієнт буває один раз за раз).
 */
export async function moveToLeadgen(db: Db, a: { clientKey: string; fromManagerId: number | null; monthYm: string }): Promise<boolean> {
  const open = await db.query(
    `SELECT 1 FROM client_react_cycles WHERE client_key = $1 AND pooled_at IS NOT NULL AND closed_at IS NULL`, [a.clientKey]);
  let moved = false;
  if (!open.rowCount) {
    const r = await db.query(
      `INSERT INTO client_react_cycles (client_key, cycle_month, pooled_at, pool_reason, from_manager_id)
       VALUES ($1, ($2 || '-01')::date, now(), 'orphan', $3)
       ON CONFLICT (client_key, cycle_month) DO UPDATE
          SET pooled_at = now(), pool_reason = 'orphan', from_manager_id = EXCLUDED.from_manager_id,
              closed_at = NULL, close_reason = NULL, taken_by_manager_id = NULL, taken_at = NULL`,
      [a.clientKey, a.monthYm, a.fromManagerId]);
    moved = (r.rowCount ?? 0) > 0;
  }
  await clearRelease(db, a.clientKey);
  return moved;
}
