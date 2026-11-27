/**
 * 💰 «Нарахування»: групи рядків (макет 27.11.2026, «роби» Романа). Команда тімліда (за `leadsTeam`) або менеджера (за `team`),
 * тімлід першим, далі менеджери за імʼям; решта (ставка, без команди) — «Поза командами продажу» внизу. Кожен рядок — рівно в
 * одній групі. Чистий модуль (лише імпорт типу): гейт `#11331` виконує його, а не читає.
 */
import type { Obj } from "../api";
export type AccrualGroup = { key: string; kind: "team" | "other"; name: string; lead: Obj | null; rows: Obj[] };
/** Групи «Нарахувань»: команда тімліда (за `leadsTeam`) або менеджера (за `team`); решта — «Поза командами продажу» внизу. */
export function accrualGroups(list: Obj[]): AccrualGroup[] {
  const by = new Map<string, AccrualGroup>(), other: Obj[] = [];
  for (const x of list) {
    const key = x.role === "lead" ? x.leadsTeam : x.role === "manager" ? x.team : null;
    if (!key) { other.push(x); continue; }
    const g = by.get(key) ?? { key: String(key), kind: "team" as const, name: String((x.role === "lead" ? x.leadsTeamName : x.teamName) ?? key), lead: null, rows: [] };
    if (x.role === "lead") { g.lead = x; g.name = String(x.leadsTeamName ?? g.name); }
    g.rows.push(x); by.set(key, g);
  }
  const teams = [...by.values()].map((g) => ({ ...g, rows: g.rows.slice().sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead") || String(a.name).localeCompare(String(b.name), "uk")) }))
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
  return other.length ? [...teams, { key: "__other", kind: "other", name: "Поза командами продажу", lead: null, rows: other }] : teams;
}

