/**
 * 💰↔🧑‍💼 «ЗМІНИ З «НАЙМУ», ЯКІ ЩЕ НЕ ВНЕСЕНІ В «ЗАРПЛАТУ»» (задача 10723, Тетяна 23.11.2026).
 *
 * «Зарплата» веде свій реєстр (`payroll_employees`, `payroll_leaves`, `payroll_terms`), а «Найм» — свій (`employees`,
 * `employee_levels`). Автоматично одне в одне НЕ пишемо: звільнення в «Зарплаті» — лише обхідним листом (тип звільнення
 * міняє фінальний розрахунок), рівень «Старт/Профі» — окреме рішення (чекає Сергія). Тут лише ПОКАЗУЄМО розбіжність,
 * а дію робить людина кнопкою.
 *
 * Чотири види рядка:
 *  - `dismissed` — у «Наймі» звільнений, у «Зарплаті» звільнення немає: рушій і далі рахує ставку й збір на ДН;
 *  - `new`       — у «Наймі» працює, акаунт дашборда активний, у «Зарплаті» немає (його можна «Додати в зарплату»);
 *  - `noAccount` — у «Наймі» працює, у «Зарплаті» немає, і акаунта немає або він вимкнений: додати не можна взагалі
 *                  (`payroll_employees.user_id` → `users`), бо «Додати в зарплату» бере лише активні акаунти;
 *  - `level`     — менеджер з продажу: рівень у «Наймі» ≠ рівень у «Зарплаті» (з урахуванням запланованого переходу);
 *  - `move`      — у «Наймі» людина стоїть в іншому відділі чи команді, ніж у «Зарплаті» (прохід 3, «роби» Романа 25.11):
 *                  блок «Оргструктури» → відділ «Зарплати» за таблицею відповідності, команда — за командою Kommo блоку.
 *                  Сама «Зарплата» не переписується: зміна команди міняє офер і гроші, тож «Перевести» тисне людина.
 * Людина «Найму» ↔ «Зарплати» — за `employees.user_id`; кілька записів «Найму» на акаунт — береться найновіший (як `NAME_JOIN`).
 * Тримають #10870–#10873, переведення — #10930–#10933.
 */
import type { Pool, PoolClient } from "pg";
import { currentLevel, type LevelEntry } from "../core/employeeLevel.js";
import { effectiveCategory } from "../core/employeeCategory.js";

type Db = Pool | PoolClient;
export type Level = "start" | "profi";

/** Людина «Зарплати», як її бачить `employeesView`. */
export interface PayrollPerson { userId: string; name: string; role: string; level: Level | null; levelChange: { level: Level } | null; leave: unknown | null;
  dept?: string | null; team?: string | null; leadsTeam?: string | null }
/** Людина «Найму» (найновіший запис на акаунт або запис без акаунта). */
export interface NaimPerson {
  employeeId: number; userId: string | null; userActive: boolean; candidateRole: boolean; name: string; position: string | null;
  status: string; dismissedAt: string | null; isSalesManager: boolean; level: Level | null;
}
export interface NaimChange {
  kind: "dismissed" | "new" | "noAccount" | "level" | "move"; name: string; position: string | null; userId: string | null; employeeId: number;
  date?: string | null; reason?: "none" | "inactive"; naimLevel?: Level; payrollLevel?: Level;
  /** `move`: куди перевести (відділ і команда «Зарплати» за «Наймом») і де зараз; `unit` — назва блоку «Оргструктури». */
  naimDept?: string; naimTeam?: string | null; payrollDept?: string | null; payrollTeam?: string | null; unit?: string;
}
/** Де людина стоїть у «Наймі» мовою «Зарплати»: відділ (за таблицею відповідності) і команда (за командою Kommo блоку). */
export interface Placement { dept: string | null; team: string | null; unit: string }

/** Чисте правило: що в «Наймі» розходиться із «Зарплатою». Порядок — звільнені, нові, без акаунта, рівень; усередині — за імʼям. */
export function naimChanges(payroll: PayrollPerson[], naim: NaimPerson[], place: Map<number, Placement> = new Map()): NaimChange[] {
  const byUser = new Map(payroll.map((p) => [p.userId, p]));
  const out: NaimChange[] = [];
  for (const n of naim) {
    const p = n.userId ? byUser.get(n.userId) : undefined;
    const base = { name: n.name, position: n.position, userId: n.userId, employeeId: n.employeeId };
    if (n.status === "dismissed") {
      if (p && !p.leave) out.push({ ...base, kind: "dismissed", date: n.dismissedAt });
      continue;
    }
    if (n.status !== "active") continue;
    if (!p) {
      if (n.userId && n.userActive && !n.candidateRole) out.push({ ...base, kind: "new" });
      else if (!n.candidateRole) out.push({ ...base, kind: "noAccount", reason: n.userId ? "inactive" : "none" });
      continue;
    }
    if (p.leave) continue;
    // відділ / команда: порівнюємо лише те, що «Найм» каже напевно (блок зіставлено, у блоку є команда «Зарплати»)
    const pl = place.get(n.employeeId);
    if (pl) {
      const curTeam = (p.role === "lead" ? p.leadsTeam ?? p.team : p.team) ?? null;
      const dDept = !!pl.dept && pl.dept !== (p.dept ?? null), dTeam = !!pl.team && pl.team !== curTeam;
      if (dDept || dTeam) out.push({ ...base, kind: "move", naimDept: pl.dept ?? p.dept ?? "", naimTeam: pl.team ?? curTeam, payrollDept: p.dept ?? null, payrollTeam: curTeam, unit: pl.unit });
    }
    if (p.role !== "manager" || !n.isSalesManager || !n.level) continue;
    const zp: Level = p.levelChange?.level ?? p.level ?? "start";
    if (zp !== n.level) out.push({ ...base, kind: "level", naimLevel: n.level, payrollLevel: zp });
  }
  const order = { dismissed: 0, new: 1, noAccount: 2, level: 3, move: 4 } as const;
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, "uk"));
}

/** «Найм» для порівняння: найновіший запис на акаунт + усі записи без акаунта; рівень — лише менеджерам з продажу. */
export async function loadNaim(db: Db): Promise<NaimPerson[]> {
  const rows = (await db.query<{ id: number; user_id: number | null; full_name: string; position: string | null; category: string | null; status: string;
    dismissed_at: string | null; user_active: boolean | null; role: string | null }>(
    `SELECT e.id, e.user_id, e.full_name, e.position, e.category, e.status, to_char(e.dismissed_at, 'YYYY-MM-DD') AS dismissed_at,
            u.is_active AS user_active, COALESCE(u.role_override, u.role) AS role
       FROM employees e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.user_id IS NULL OR e.id = (SELECT max(x.id) FROM employees x WHERE x.user_id = e.user_id)
      ORDER BY e.id`)).rows;
  const lv = (await db.query<LevelEntry & { employee_id: number }>(
    `SELECT id, employee_id, level, from_month::text AS from_month, (cancelled_at IS NOT NULL) AS cancelled FROM employee_levels`)).rows;
  const byEmp = new Map<number, LevelEntry[]>();
  for (const l of lv) byEmp.set(l.employee_id, [...(byEmp.get(l.employee_id) ?? []), l]);
  return rows.map((r) => {
    const sales = effectiveCategory(r.category, r.position) === "manager";
    return {
      employeeId: r.id, userId: r.user_id == null ? null : String(r.user_id), userActive: !!r.user_active, candidateRole: r.role === "candidate",
      name: r.full_name, position: r.position, status: r.status, dismissedAt: r.dismissed_at, isSalesManager: sales,
      level: sales ? (currentLevel(byEmp.get(r.id) ?? []).level === "pro" ? "profi" : "start") : null,
    };
  });
}

/**
 * Команди для картки «Офери менеджерів» (Тетяна 23.11.2026: «підсовувати вниз і помічати, що вже не актуальна, бо 0 людей»).
 * Люди — без звільнення в «Зарплаті». Порядок: спершу команди з людьми, потім порожні (`stale`); усередині — за назвою.
 * Порожню команду НЕ ховаємо: вона лишається в «Оргструктурі», і прибрати її — рішення людини. Тримає #10873.
 */
export interface OfferTeam { code: string; name: string; offer: string; people: number; stale: boolean }
export function offerTeams(teams: Array<{ code: string; name: string; offer?: string | null }>, people: Array<{ team?: unknown; leadsTeam?: unknown; leave?: unknown }>): OfferTeam[] {
  const n = new Map<string, number>();
  for (const p of people) {
    if (p.leave) continue;
    const ts = new Set([p.team, p.leadsTeam].filter((x): x is string => typeof x === "string" && !!x));
    for (const t of ts) n.set(t, (n.get(t) ?? 0) + 1);
  }
  return teams.map((t) => ({ code: t.code, name: t.name, offer: t.offer ?? "std", people: n.get(t.code) ?? 0, stale: !(n.get(t.code) ?? 0) }))
    .sort((a, b) => Number(a.stale) - Number(b.stale) || a.name.localeCompare(b.name, "uk"));
}

/* ───────────── відділи й команди «Найму» → «Зарплати» (прохід 3, план §Д) ───────────── */

/**
 * Відділ «Зарплати» за замовчуванням для відділу блоку «Оргструктури» (`org_units.dept`). Свій рядок у `payroll_dept_map` перекриває:
 * код відділу — зіставити так, `NULL` — не зіставляти зовсім. IT у «Зарплаті» свого відділу не має — за замовчуванням не зіставляємо.
 */
export const ORG_DEPT_DEFAULT: Record<string, string | null> = { top: "mgmt", hr: "hr", fin: "fin", sales: "sales", it: null };
export interface PlaceUnit { id: number; parentId: number | null; name: string; dept: string; teamKey: string | null }
/** Свій рядок таблиці (навіть `null`) — головний; інакше — за відділом блоку. Відділ, якого в «Зарплаті» немає, — не зіставляємо. */
export function unitDept(u: PlaceUnit, map: ReadonlyMap<number, string | null>, known: ReadonlySet<string>): string | null {
  const d = map.has(u.id) ? map.get(u.id)! : ORG_DEPT_DEFAULT[u.dept] ?? null;
  return d && known.has(d) ? d : null;
}
/** Чисте правило: кожна людина «Найму» з блоком → відділ і команда «Зарплати». Без блоку — немає рядка (нічого не пропонуємо). */
export function naimPlacement(units: readonly PlaceUnit[], people: ReadonlyArray<{ id: number; unitId: number | null }>,
  map: ReadonlyMap<number, string | null>, teams: ReadonlyArray<{ code: string; kommoTeamId: number | null }>, known: ReadonlySet<string>): Map<number, Placement> {
  const byId = new Map(units.map((u) => [u.id, u]));
  const byKommo = new Map(teams.filter((t) => t.kommoTeamId != null).map((t) => [`k:${t.kommoTeamId}`, t.code]));
  const out = new Map<number, Placement>();
  for (const p of people) {
    const u = p.unitId != null ? byId.get(p.unitId) : undefined; if (!u) continue;
    out.set(p.id, { dept: unitDept(u, map, known), team: u.teamKey ? byKommo.get(u.teamKey) ?? null : null, unit: u.name });
  }
  return out;
}
/** Блоки для таблиці відповідності: шлях від кореня, свій рядок і що виходить. */
export function deptMapRows(units: readonly PlaceUnit[], map: ReadonlyMap<number, string | null>, known: ReadonlySet<string>) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const path = (u: PlaceUnit): string[] => { const xs: string[] = []; let x: PlaceUnit | undefined = u; const seen = new Set<number>();
    while (x && !seen.has(x.id)) { seen.add(x.id); xs.unshift(x.name); x = x.parentId != null ? byId.get(x.parentId) : undefined; } return xs; };
  return units.map((u) => ({ unitId: u.id, name: u.name, path: path(u).join(" → "), orgDept: u.dept, own: map.has(u.id), ownDept: map.get(u.id) ?? null,
    defaultDept: ORG_DEPT_DEFAULT[u.dept] ?? null, dept: unitDept(u, map, known) }));
}
