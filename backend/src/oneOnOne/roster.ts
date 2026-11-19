/**
 * 👥 ХТО В 1×1 — З «НАЙМ → СПІВРОБІТНИКИ» (Сергій 19.11.2026: «це вікно живе окреме життя. Підв'яжи його до найму»;
 * відповіді Романа 19.11: 1-А, 2-так; «роби» на план «1×1 для людей без Kommo»).
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ НА ПРОДІ 19.11. Досі 1×1 брав людей із `managers` (Kommo): у «Тімлід→Менеджер» стояли
 * бухгалтер, фінансист, операційний директор, IT і самі тімліди (усі 56), а 8 працюючих у Найм без Kommo не було ніде.
 *
 * ✅ ПРАВИЛО (одне місце для списку, збереження, задач і аналітики):
 *  - людина є в 1×1, якщо в Найм вона ПРАЦЮЄ (`active` або `finishing`); ім'я — ПІБ із Найму;
 *  - тип — за категорією в Найм (ручна або за посадою, `effectiveCategory`): «Тімлід→Менеджер» — менеджери й
 *    лідогенерація; «КВП→Тімлід» — тім-ліди; «HR→Всі» — усі працюючі;
 *  - запис 1×1 і задача з 1×1 тримаються на КАРТЦІ Найму (`one_on_ones.subject_employee_id`, `tasks.o2o_employee_id`);
 *    менеджер Kommo — лише довідково, де пара є. Людина без Kommo — звичайний рядок;
 *  - звільнений НАКЛАДКОЮ дашборду (`manager_work_state = dismissed`, задача 8249) лишається другим запобіжником:
 *    Найм міг не встигнути, а звільненого назад у список ми не повертаємо. Прапорець Kommo «неактивний» більше
 *    нічого не вирішує — працює людина чи ні, каже Найм.
 *
 * Чиста функція — її доводить саботаж без бази (`#9994`); SQL-половину — scratch-база (`#9995`).
 */
import { effectiveCategory, type EmpCategory } from "../core/employeeCategory.js";

/** Звільнений накладкою адміна в дашборді (`#3420`, задача 8249) — у 1×1 його немає, хай що каже Найм. */
export const DASHBOARD_DISMISSED = `EXISTS (SELECT 1 FROM manager_work_state w WHERE w.manager_id = m.id AND w.state = 'dismissed')`;

/**
 * Працюючі в Найм + їхня пара в Kommo (напряму `e.manager_id` або через акаунт `users.manager_id` — той самий
 * зв'язок, що в реєстрі) + акаунт дашборду (на нього йде задача з 1×1, коли Kommo немає). Команда — Kommo-пари,
 * інакше команда з картки Найму. Одним запитом на кожен виклик: людей ~70, а список мусить бути свіжим одразу після
 * правки в Найм, тож кешу тут немає.
 */
export const ROSTER_SQL = `SELECT e.id AS employee_id, e.full_name, e.category, e.position, e.status,
         m.id AS manager_id, eu.id AS user_id, (eu.id IS NOT NULL AND eu.is_active) AS account_active,
         COALESCE(m.team_id, e.team_id) AS team_id, COALESCE(t.name, dt.name) AS team_name,
         (m.id IS NOT NULL AND ${DASHBOARD_DISMISSED}) AS dismissed
    FROM employees e
    LEFT JOIN users eu ON eu.id = e.user_id
    LEFT JOIN managers m ON m.id = COALESCE(e.manager_id, eu.manager_id)
    LEFT JOIN teams t ON t.id = COALESCE(m.team_id, e.team_id)
    LEFT JOIN dashboard_teams dt ON dt.id = e.dashboard_team_id
   WHERE e.status IN ('active','finishing')
   ORDER BY e.id`;

export type O2OType = "A" | "B" | "V";

/** Які типи 1×1 належать людині цієї категорії. Без категорії — лише «HR→Всі»: вгадувати посаду не беремось. */
export function o2oTypesOf(cat: EmpCategory | null): O2OType[] {
  if (cat === "manager" || cat === "leadgen") return ["A", "V"];
  if (cat === "teamlead") return ["B", "V"];
  return ["V"];
}

/** Рядок працюючого співробітника Найму з парою в Kommo й акаунтом (якщо вони є). */
export interface RosterCandidate {
  employee_id: number;
  full_name: string;
  category: string | null;
  position: string | null;
  status: string;
  manager_id: number | null;
  user_id: number | null;
  account_active: boolean;
  team_id: number | null;
  team_name: string | null;
  /** Звільнений накладкою дашборду (лише для тих, у кого є пара в Kommo). */
  dismissed: boolean;
}

export interface RosterSubject {
  employeeId: number;
  fullName: string;
  position: string | null;
  status: string;
  category: EmpCategory | null;
  managerId: number | null;
  /** Акаунт, на який піде задача з 1×1, коли пари в Kommo немає. `null` — задачу поставити нікому. */
  taskUserId: number | null;
  teamId: number | null;
  teamName: string | null;
}

/** Список людей типу (кожна картка Найму — один раз). */
export function rosterOf(rows: readonly RosterCandidate[], type: O2OType): RosterSubject[] {
  const out: RosterSubject[] = [];
  for (const r of [...rows].sort((a, b) => a.employee_id - b.employee_id)) {
    const category = effectiveCategory(r.category, r.position);
    if (!o2oTypesOf(category).includes(type)) continue;
    if (r.dismissed) continue;
    out.push({
      employeeId: r.employee_id, fullName: r.full_name, position: r.position, status: r.status, category,
      managerId: r.manager_id, taskUserId: r.manager_id === null && r.account_active ? r.user_id : null,
      teamId: r.team_id, teamName: r.team_name,
    });
  }
  return out;
}

/** Чи можна поставити задачу з 1×1: є менеджер Kommo (задача йде йому) або активний акаунт дашборду. */
export const canTakeTask = (s: RosterSubject): boolean => s.managerId !== null || s.taskUserId !== null;
