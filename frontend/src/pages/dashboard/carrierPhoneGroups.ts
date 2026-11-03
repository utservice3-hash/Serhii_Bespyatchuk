/**
 * 📵 «ЯКІСТЬ ДАНИХ» · НОМЕРИ КЛІЄНТІВ (задача 7359) — розклад списку «команда → менеджер → клієнти».
 *
 * Чиста функція без імпортів: її виконує гейт напряму. Клієнт потрапляє рівно в одну групу; команди без назви —
 * «Поза командами» (невідоме читається словами, а не порожнім рядком). Порядок: команди й менеджери — за кількістю
 * клієнтів, усередині менеджера — спершу «без номера замовника», потім «є номер перевізника».
 */
export type Verdict = "no_phone" | "only_carrier" | "has_carrier";

export interface GroupItem { clientKey: string; clientName: string; managerId: number; managerName: string;
  teamId: number | null; teamName: string | null; verdict: Verdict }

export interface ManagerGroup<T> { managerId: number; managerName: string; items: T[] }
export interface TeamGroup<T> { teamKey: string; teamName: string; managers: ManagerGroup<T>[]; total: number }

export const NO_TEAM = "Поза командами";

/** «Без номера замовника» = номерів немає зовсім АБО всі перевізницькі. */
export const lacksClientPhone = (v: Verdict): boolean => v === "no_phone" || v === "only_carrier";

export function groupCarrierItems<T extends GroupItem>(items: readonly T[]): TeamGroup<T>[] {
  const teams = new Map<string, TeamGroup<T>>();
  for (const it of items) {
    const teamKey = it.teamId == null ? "none" : String(it.teamId);
    const t = teams.get(teamKey) ?? { teamKey, teamName: it.teamName || (it.teamId == null ? NO_TEAM : `Команда #${String(it.teamId)}`), managers: [], total: 0 };
    let m = t.managers.find((x) => x.managerId === it.managerId);
    if (!m) { m = { managerId: it.managerId, managerName: it.managerName, items: [] }; t.managers.push(m); }
    m.items.push(it);
    t.total++;
    teams.set(teamKey, t);
  }
  const rank = (v: Verdict) => (lacksClientPhone(v) ? 0 : 1);
  const out = [...teams.values()];
  for (const t of out) {
    t.managers.sort((a, b) => b.items.length - a.items.length || a.managerName.localeCompare(b.managerName, "uk"));
    for (const m of t.managers) m.items.sort((a, b) => rank(a.verdict) - rank(b.verdict) || a.clientName.localeCompare(b.clientName, "uk"));
  }
  return out.sort((a, b) => b.total - a.total || a.teamName.localeCompare(b.teamName, "uk"));
}
