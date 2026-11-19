/**
 * 👥 ХТО В 1×1 — З «НАЙМ → СПІВРОБІТНИКИ» (Сергій 19.11.2026: «це вікно живе окреме життя. Підв'яжи його до найму»;
 * відповіді Романа 19.11: 1-А, 2-так, 3-сірими зараз).
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ НА ПРОДІ 19.11. Досі 1×1 брав людей із `managers` (Kommo): у «Тімлід→Менеджер» стояли
 * бухгалтер, фінансист, операційний директор, IT і самі тімліди (усі 56), а 8 працюючих у Найм без Kommo не було ніде.
 *
 * ✅ ПРАВИЛО (одне місце для списку, збереження, задач і аналітики):
 *  - людина є в 1×1, якщо в Найм вона ПРАЦЮЄ (`active` або `finishing`); ім'я — ПІБ із Найму;
 *  - тип — за категорією в Найм (ручна або за посадою, `effectiveCategory`): «Тімлід→Менеджер» — менеджери й
 *    лідогенерація; «КВП→Тімлід» — тім-ліди; «HR→Всі» — усі працюючі;
 *  - запис 1×1 досі тримається на менеджері Kommo (ключ `one_on_ones`), тож людина без пари в Kommo показується
 *    СІРОЮ «немає Kommo — 1×1 не зберегти». Прив'язка записів до Найму — наступний прохід (міграція).
 *  - стан менеджера в дашборді (звільнений накладкою адміна) лишається другим запобіжником (`#3420`): Найм міг
 *    не встигнути, а звільненого назад у список ми не повертаємо.
 *
 * Чиста функція — її доводить саботаж без бази (`#9994`); SQL-половину — scratch-база (`#9995`).
 */
import { effectiveCategory, type EmpCategory } from "../core/employeeCategory.js";
import { inOwnWorkListsSql } from "../core/managerState.js";
import { activeManagerSql } from "../core/activeManager.js";

/** Стан менеджера в дашборді, з яким 1×1 жив досі (`#3420`, задача 8249): звільнений накладкою або вимкнений — ні. */
export const SUBJECT_WORKS = inOwnWorkListsSql("m", activeManagerSql("m"));

/**
 * Працюючі в Найм + їхня пара в Kommo (напряму `e.manager_id` або через акаунт `users.manager_id` — той самий
 * зв'язок, що в реєстрі). Одним запитом на кожен виклик: людей ~70, а список мусить бути свіжим одразу після правки
 * в Найм, тож кешу тут немає.
 */
export const ROSTER_SQL = `SELECT e.id AS employee_id, e.full_name, e.category, e.position,
         m.id AS manager_id, m.team_id, (m.id IS NOT NULL AND ${SUBJECT_WORKS}) AS works
    FROM employees e
    LEFT JOIN users eu ON eu.id = e.user_id
    LEFT JOIN managers m ON m.id = COALESCE(e.manager_id, eu.manager_id)
   WHERE e.status IN ('active','finishing')
   ORDER BY e.id`;

export type O2OType = "A" | "B" | "V";

/** Які типи 1×1 належать людині цієї категорії. Без категорії — лише «HR→Всі»: вгадувати посаду не беремось. */
export function o2oTypesOf(cat: EmpCategory | null): O2OType[] {
  if (cat === "manager" || cat === "leadgen") return ["A", "V"];
  if (cat === "teamlead") return ["B", "V"];
  return ["V"];
}

/** Рядок працюючого співробітника Найму з парою в Kommo (якщо вона є). */
export interface RosterCandidate {
  employee_id: number;
  full_name: string;
  category: string | null;
  position: string | null;
  /** Менеджер Kommo (напряму або через акаунт). */
  manager_id: number | null;
  team_id: number | null;
  /** Стан менеджера в дашборді дозволяє його показувати (не звільнений накладкою, не вимкнений). */
  works: boolean;
}

export interface RosterSubject { managerId: number; employeeId: number; fullName: string; teamId: number | null; category: EmpCategory | null }
export interface RosterUnlinked { employeeId: number; fullName: string; position: string | null; reason: "no_kommo" | "kommo_off" }

/** Список людей типу: хто доступний для 1×1 і хто працює в Найм, але зберегти запис неможливо. */
export function rosterOf(rows: readonly RosterCandidate[], type: O2OType): { subjects: RosterSubject[]; unlinked: RosterUnlinked[] } {
  const subjects = new Map<number, RosterSubject>();
  const unlinked: RosterUnlinked[] = [];
  for (const r of [...rows].sort((a, b) => a.employee_id - b.employee_id)) {
    const category = effectiveCategory(r.category, r.position);
    if (!o2oTypesOf(category).includes(type)) continue;
    if (r.manager_id === null) { unlinked.push({ employeeId: r.employee_id, fullName: r.full_name, position: r.position, reason: "no_kommo" }); continue; }
    if (!r.works) { unlinked.push({ employeeId: r.employee_id, fullName: r.full_name, position: r.position, reason: "kommo_off" }); continue; }
    // Дві працюючі картки на одного менеджера (дубль у Найм) — береться перша, людина в списку один раз.
    if (!subjects.has(r.manager_id)) {
      subjects.set(r.manager_id, { managerId: r.manager_id, employeeId: r.employee_id, fullName: r.full_name, teamId: r.team_id, category });
    }
  }
  return { subjects: [...subjects.values()], unlinked };
}
