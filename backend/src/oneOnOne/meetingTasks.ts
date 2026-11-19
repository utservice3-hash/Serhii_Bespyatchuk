/**
 * ➕ ЗАДАЧІ, ПОСТАВЛЕНІ НА ЦІЙ ЗУСТРІЧІ 1×1 (Сергій 19.11.2026: «відповідь, яка фіксується і записується, після
 * перезавантаження не має зникати»).
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ У КОДІ. «➕ Поставити задачу» пише задачу в Задачник, а на формі лише очищає поле. Блок задач
 * угорі форми навмисно показує задачі з МИНУЛИХ зустрічей (`?before=дата`), тож після перезавантаження на зустрічі
 * не лишалось жодного сліду того, що на ній поставили.
 *
 * ✅ ЧОМУ ЧИСТА ФУНКЦІЯ. SQL бере задачі людини й типу; що з них належить САМЕ ЦІЙ зустрічі й кому їх показати,
 * вирішує ця функція — її можна довести саботажем без бази (гейт `#9991`).
 *
 * 🔒 ХТО БАЧИТЬ. Ті самі межі, що в історії 1×1: наскрізний перегляд (`view_all_1x1`) — усі задачі зустрічі;
 * інакше — лише поставлені МНОЮ. Тімлід, що відкрив порожній шаблон чужої людини, чужих задач не отримає.
 */

/** Рядок із `tasks` (task_type='oneonone') по людині й типу — сирий, до відбору. */
export interface O2OTaskRow {
  id: number;
  title: string;
  deadline: string | null;
  status: string;
  o2o_resolution: string | null;
  created_by: number | null;
  /** Дата зустрічі, на якій поставили (YYYY-MM-DD). */
  meeting_date: string | null;
}

export interface MeetingTask {
  id: number;
  title: string;
  deadline: string | null;
  status: string;
  resolution: string | null;
}

/** Задачі, поставлені на зустрічі `date`, які дозволено показати глядачу. Порядок — як поставили (id). */
export function tasksSetAtMeeting(
  rows: readonly O2OTaskRow[],
  opts: { date: string; viewerId: number; crossview: boolean },
): MeetingTask[] {
  return rows
    .filter((r) => r.meeting_date === opts.date)
    .filter((r) => opts.crossview || r.created_by === opts.viewerId)
    .sort((a, b) => a.id - b.id)
    .map((r) => ({ id: r.id, title: r.title, deadline: r.deadline, status: r.status, resolution: r.o2o_resolution }));
}
