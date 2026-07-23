import { useState } from "react";
import type { Team } from "../../../api";
import { PlansSection } from "./PlansSection";
import { PlanFormationSection } from "./PlanFormationSection";

/**
 * Обгортка розділу «Плани»: перемикач між НОВИМ «Формування плану» (двоетапне
 * погодження, дефолт) і наявним грід-редактором «план/факт/декомпозиція». Обидва
 * інструменти лишаються — новий не знищує старий.
 */
export function PlansTabs({ auth, teams }: {
  auth: { role: string; managerId: number | null; teamId: number | null };
  teams: Team[];
}) {
  const [view, setView] = useState<"formation" | "grid">("formation");
  const tab = (key: "formation" | "grid", label: string) => (
    <button onClick={() => setView(key)}
      style={{ padding: "8px 16px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 600,
        background: view === key ? "var(--card-bg)" : "transparent", color: view === key ? "var(--text)" : "var(--text-muted)",
        boxShadow: view === key ? "0 1px 3px rgba(20,30,50,.1)" : "none" }}>{label}</button>
  );
  return (
    <>
      <div style={{ display: "inline-flex", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 11, marginBottom: 14 }}>
        {tab("formation", "💼 Формування плану")}
        {tab("grid", "📊 Редактор (грід)")}
      </div>
      {view === "formation"
        ? <PlanFormationSection auth={auth} teams={teams} />
        : <PlansSection canPickTeam={auth.role === "admin"} teams={teams} />}
    </>
  );
}
