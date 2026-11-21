import { useState } from "react";
import type { Team } from "../../../api";
import { PlansSection } from "./PlansSection";
import { PlanFormationSection } from "./PlanFormationSection";
import { CallsNormCard } from "./CallsNormCard";
import { KvpPlansTab } from "./KvpPlansTab";

/**
 * Обгортка розділу «Плани»: перемикач між НОВИМ «Формування плану» (двоетапне
 * погодження, дефолт) і наявним грід-редактором «план/факт/декомпозиція». Обидва
 * інструменти лишаються — новий не знищує старий.
 *
 * 🎯 Третя вкладка «Плани КВП» (правки зустрічі 17.11.2026) — колишня «Повна таблиця» Звіту КВП. Видна лише тим,
 * у кого є екран «Звіт КВП» (`canKvp`): саме по ньому сервер гейтить `/kvp-plan` і `/kvp-report`.
 */
export function PlansTabs({ auth, teams, canKvp = false }: {
  auth: { role: string; managerId: number | null; teamId: number | null };
  teams: Team[];
  canKvp?: boolean;
}) {
  const [view, setView] = useState<"formation" | "grid" | "kvp">("formation");
  const tab = (key: "formation" | "grid" | "kvp", label: string) => (
    <button onClick={() => setView(key)}
      style={{ padding: "8px 16px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 600,
        background: view === key ? "var(--card-bg)" : "transparent", color: view === key ? "var(--text)" : "var(--text-muted)",
        boxShadow: view === key ? "0 1px 3px rgba(20,30,50,.1)" : "none" }}>{label}</button>
  );
  return (
    <>
      {/* 📞 Норма дзвінків (4632): одна на всіх менеджерів, ставить КВП, діє до наступної зміни. */}
      <CallsNormCard />
      <div style={{ display: "inline-flex", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 11, marginBottom: 14 }}>
        {tab("formation", "💼 Формування плану")}
        {tab("grid", "📊 Редактор (грід)")}
        {canKvp && tab("kvp", "🎯 Плани КВП")}
      </div>
      {view === "kvp" && canKvp ? <KvpPlansTab /> : view === "formation"
        ? <PlanFormationSection auth={auth} teams={teams} />
        : <PlansSection canPickTeam={auth.role === "admin"} canEdit={auth.role === "admin"} teams={teams} />}
    </>
  );
}
