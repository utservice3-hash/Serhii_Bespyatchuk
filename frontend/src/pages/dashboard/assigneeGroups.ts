import type { ManagerOption } from "../../api";

/**
 * 👥 ГРУПИ ВИКОНАВЦІВ — МОЯ КОМАНДА ПЕРШОЮ (відгук Шаврової 05.10.2026). Після #423
 * список містить УСІХ активних (47), упорядкованих за назвою команди, тож своя
 * команда тімліда губилась посеред переліку. Склад не змінюється — лише порядок.
 * Чиста функція: гейт `#493` виконує її, а не читає текст.
 */
export function teamGroups(options: ManagerOption[], myTeamId: number | null, skipId?: number | ""): [string, ManagerOption[]][] {
  const byTeam = new Map<string, ManagerOption[]>();
  const keyOf = (m: ManagerOption) =>
    myTeamId != null && m.teamId === myTeamId ? `★ Моя команда · ${m.teamName ?? "#" + myTeamId}` : (m.teamName ?? "Без команди");
  const mineFirst = myTeamId == null ? [] : options.filter((m) => m.teamId === myTeamId);
  const seen = new Set<number>();
  for (const m of [...mineFirst, ...options]) {
    if (seen.has(m.id) || (skipId !== undefined && m.id === skipId)) continue;
    seen.add(m.id);
    const key = keyOf(m);
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key)!.push(m);
  }
  return [...byTeam.entries()];
}
