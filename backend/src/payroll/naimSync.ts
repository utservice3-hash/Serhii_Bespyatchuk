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
 *  - `level`     — менеджер з продажу: рівень у «Наймі» ≠ рівень у «Зарплаті» (з урахуванням запланованого переходу).
 * Людина «Найму» ↔ «Зарплати» — за `employees.user_id`; кілька записів «Найму» на акаунт — береться найновіший (як `NAME_JOIN`).
 * Тримають #10870–#10873.
 */
import type { Pool, PoolClient } from "pg";
import { currentLevel, type LevelEntry } from "../core/employeeLevel.js";
import { effectiveCategory } from "../core/employeeCategory.js";

type Db = Pool | PoolClient;
export type Level = "start" | "profi";

/** Людина «Зарплати», як її бачить `employeesView`. */
export interface PayrollPerson { userId: string; name: string; role: string; level: Level | null; levelChange: { level: Level } | null; leave: unknown | null }
/** Людина «Найму» (найновіший запис на акаунт або запис без акаунта). */
export interface NaimPerson {
  employeeId: number; userId: string | null; userActive: boolean; candidateRole: boolean; name: string; position: string | null;
  status: string; dismissedAt: string | null; isSalesManager: boolean; level: Level | null;
}
export interface NaimChange {
  kind: "dismissed" | "new" | "noAccount" | "level"; name: string; position: string | null; userId: string | null; employeeId: number;
  date?: string | null; reason?: "none" | "inactive"; naimLevel?: Level; payrollLevel?: Level;
}

/** Чисте правило: що в «Наймі» розходиться із «Зарплатою». Порядок — звільнені, нові, без акаунта, рівень; усередині — за імʼям. */
export function naimChanges(payroll: PayrollPerson[], naim: NaimPerson[]): NaimChange[] {
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
    if (p.leave || p.role !== "manager" || !n.isSalesManager || !n.level) continue;
    const zp: Level = p.levelChange?.level ?? p.level ?? "start";
    if (zp !== n.level) out.push({ ...base, kind: "level", naimLevel: n.level, payrollLevel: zp });
  }
  const order = { dismissed: 0, new: 1, noAccount: 2, level: 3 } as const;
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
