/**
 * 👥 ЛЮДИ ТИЖНЯ ДЛЯ ПРЕЗЕНТАЦІЇ (прохід 2, 04.11.2026, відповіді Даші). Дані слайдів «Події тижня» й «Особливі відзнаки»,
 * яких немає в рейтингу номінацій:
 *  · дні народження й «новий у команді» — з «Найму» (`employees`: дата народження, дата прийому);
 *  · «нова посада» — Даша вносить руками (`nomination_week_texts`, вид `new_position`): історії посад у «Наймі» немає;
 *  · поставлені авто людини від дати прийому — з ядра (`metrics.dispatchedByManager`), свого SQL по угодах тут немає;
 *  · перші успішні угоди з клієнтами — з ядра (`metrics.firstSuccessByManager`).
 * Правила дат — чисті функції `nominationPeopleRules.ts` (гейт #3464). Лише керівництву (роут `/presentation-extras`).
 */
import { pool } from "../db/pool.js";
import * as metrics from "./metrics.js";
import { employeePhotos } from "./people.js";
import { weekOf } from "./nominationRules.js";
import { birthdayInWeek, newcomerDay, isRookie, addMonthClamp } from "./nominationPeopleRules.js";
import { nominationRoster } from "./nominations.js";

export interface PresentationExtras {
  weekFrom: string; weekTo: string;
  birthdays: { employeeId: number; name: string; date: string }[];
  newcomers: { employeeId: number; name: string; day: string; managerId: number | null; cars: number | null }[];
  newPositions: { employeeId: number; name: string; position: string; by: string | null; at: string }[];
  /** Новачки на адаптації (від 14 днів до місяця від прийому) з поставленими авто від дати прийому — для «Новачка тижня». */
  rookies: { employeeId: number; name: string; managerId: number; hiredAt: string; cars: number }[];
  /** Перші успішні угоди з клієнтами за тиждень — для «Нового клієнта»; `unknown` — успішні угоди без визначеного клієнта. */
  newClients: { rows: { managerId: number; first: number }[]; unknown: number };
  /**
   * Менеджери на адаптації (перший місяць від прийому) — у «Прорив тижня» не беруть участі (ревʼю 04.11.2026: план тижня
   * новачка крихітний, і 2664% «прориву» в людини, прийнятої 19.10, — шум, а не результат; у них своя «Новачок тижня»).
   */
  adaptingManagerIds: number[];
  /** Активні співробітники комерційного відділу (ростер тижня) — для вибору людини в «Новій посаді». */
  employees: { id: number; name: string }[];
  /** Фото за id СПІВРОБІТНИКА (а не менеджера Kommo). */
  photos: Record<string, { id: number; v: number }>;
}

/** Поставлені авто менеджера від дати прийому до кінця тижня — ядром, тим самим правилом, що «Авто» Звіту. */
async function carsSince(managerId: number, from: string, to: string): Promise<number> {
  const rows = await metrics.dispatchedByManager({ from, to, managerId });
  return rows.find((r) => r.managerId === managerId)?.deals ?? 0;
}

export async function presentationExtras(weekFromIn: string): Promise<PresentationExtras> {
  const { from: weekFrom, to: weekTo } = weekOf(weekFromIn);
  const [emps, positions, newClients, roster] = await Promise.all([
    pool.query<{ id: number; full_name: string; birth_date: string | null; hired_at: string | null; manager_id: number | null }>(
      `SELECT id, full_name, birth_date::text AS birth_date, hired_at::text AS hired_at, manager_id
         FROM employees WHERE status = 'active' ORDER BY full_name`),
    pool.query<{ employee_id: number; text: string; by_name: string | null; created_at: Date }>(
      `SELECT DISTINCT ON (t.employee_id) t.employee_id, t.text, COALESCE(u.full_name, u.email) AS by_name, t.created_at
         FROM nomination_week_texts t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.week_from = $1 AND t.kind = 'new_position' ORDER BY t.employee_id, t.id DESC`, [weekFrom]),
    metrics.firstSuccessByManager({ from: weekFrom, to: weekTo }),
    nominationRoster(null, weekFrom),
  ]);
  // «Новий у команді» — лише менеджери комерційного відділу (ревʼю 04.11.2026: на слайді була бухгалтерка). Категорію в
  // «Наймі» заповнено у 3 з 65, тож ознака — зіставлення картки з менеджером Kommo з ростеру відділу тижня.
  const sales = new Set(roster.map((r) => r.id));
  const people = emps.rows;
  const nameOf = new Map(people.map((p) => [p.id, p.full_name]));

  const birthdays = people.flatMap((p) => {
    const d = p.birth_date ? birthdayInWeek(p.birth_date, weekFrom, weekTo) : null;
    return d ? [{ employeeId: p.id, name: p.full_name, date: d }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));

  const newcomers = await Promise.all(people.flatMap((p) => {
    const d = p.hired_at && p.manager_id != null && sales.has(p.manager_id) ? newcomerDay(p.hired_at, weekFrom, weekTo) : null;
    return d ? [{ p, d }] : [];
  }).map(async ({ p, d }) => ({
    employeeId: p.id, name: p.full_name, day: d, managerId: p.manager_id,
    cars: p.manager_id != null ? await carsSince(p.manager_id, p.hired_at!, weekTo) : null,
  })));

  const rookies = await Promise.all(people.filter((p) => p.manager_id != null && p.hired_at && isRookie(p.hired_at, weekTo))
    .map(async (p) => ({ employeeId: p.id, name: p.full_name, managerId: p.manager_id!, hiredAt: p.hired_at!, cars: await carsSince(p.manager_id!, p.hired_at!, weekTo) })));

  const newPositions = positions.rows.filter((r) => r.text.trim() && nameOf.has(r.employee_id))
    .map((r) => ({ employeeId: r.employee_id, name: nameOf.get(r.employee_id)!, position: r.text, by: r.by_name, at: r.created_at.toISOString() }));

  const ids = [...new Set([...birthdays, ...newcomers, ...newPositions, ...rookies].map((x) => x.employeeId))];
  return {
    weekFrom, weekTo, birthdays, newcomers, newPositions, rookies, newClients,
    adaptingManagerIds: people.filter((p) => p.manager_id != null && p.hired_at && weekTo < addMonthClamp(p.hired_at)).map((p) => p.manager_id!),
    // Вибір для «Нової посади» — лише комерційний відділ, тим самим ростером, що й «новий у команді» (рішення Романа
    // 09.11.2026: у списку були бухгалтерія, фінанси, CEO — 64 людини замість 46).
    employees: people.filter((p) => p.manager_id != null && sales.has(p.manager_id)).map((p) => ({ id: p.id, name: p.full_name })),
    photos: await employeePhotos(ids),
  };
}
