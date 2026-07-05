import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "./Logo";
import { CommandPalette } from "./CommandPalette";
import { heartbeat } from "../api";
// NAV_GROUPS drives the grouped sidebar; NAV_ITEMS (flattened) is used elsewhere.

export const NAV_GROUPS = [
  {
    label: "Аналітика",
    items: [
      { key: "overview", label: "Огляд", icon: "📊" },
      { key: "report", label: "Звіт", icon: "🧾" },
      { key: "kvp", label: "Звіт КВП", icon: "🏆", roles: ["admin"] },
      { key: "plans", label: "Плани", icon: "💵", roles: ["admin", "team_lead"] },
      { key: "statistics", label: "Статистика", icon: "📈" },
      { key: "teams", label: "Команди", icon: "👥" },
      { key: "managers", label: "Менеджери", icon: "🧑‍💼" },
    ],
  },
  {
    label: "Клієнти",
    items: [
      { key: "loyalty", label: "Постійні клієнти", icon: "🔁" },
      { key: "receivables", label: "Дебіторська заборгованість", icon: "💰" },
      { key: "leadgen", label: "Лідогенерація", icon: "🎯" },
    ],
  },
  {
    label: "Робота",
    items: [
      { key: "tasks", label: "Задачник", icon: "📝" },
      { key: "messenger", label: "Месенджер", icon: "💬" },
      { key: "news", label: "Новини", icon: "📰" },
      { key: "training", label: "Навчання", icon: "📚" },
    ],
  },
  {
    label: "Система",
    items: [
      { key: "feedback", label: "Зворотний звʼязок", icon: "🐞", roles: ["admin", "team_lead"] },
      { key: "aiwork", label: "Робота з АІ", icon: "🤖", roles: ["admin"] },
      { key: "settings", label: "Налаштування", icon: "⚙️", roles: ["admin"] },
    ],
  },
] as const;

type NavItem = { key: string; label: string; icon: string; roles?: readonly string[] };
export type NavKey = (typeof NAV_GROUPS)[number]["items"][number]["key"];

/** Nav items visible to a given role (items without `roles` are visible to all). */
export function navGroupsForRole(role: string | undefined) {
  return NAV_GROUPS
    .map((g) => ({
      label: g.label,
      items: (g.items as readonly NavItem[]).filter((it) => !it.roles || (role != null && it.roles.includes(role))),
    }))
    .filter((g) => g.items.length > 0);
}

export const NAV_ITEMS: { key: NavKey; label: string; icon: string }[] = NAV_GROUPS.flatMap(
  (g) => g.items as readonly { key: NavKey; label: string; icon: string }[]
);

export function Layout({
  children,
  active,
  onSelect,
  onBack,
  role,
}: {
  children: React.ReactNode;
  active: NavKey;
  onSelect: (key: NavKey) => void;
  onBack?: () => void;
  role?: string;
}) {
  const navigate = useNavigate();
  const navGroups = navGroupsForRole(role);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1"
  );
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") ?? "light");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Presence: ping a heartbeat so others see us as online.
  useEffect(() => {
    heartbeat();
    const t = setInterval(heartbeat, 30000);
    return () => clearInterval(t);
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem("sidebarCollapsed", c ? "0" : "1");
      return !c;
    });
  }

  function logout() {
    localStorage.removeItem("token");
    navigate("/login");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" style={collapsed ? { width: 64, minWidth: 64 } : undefined}>
        <div className="sidebar-brand" style={{ justifyContent: collapsed ? "center" : undefined }}>
          <Logo size={28} />
          {!collapsed && <span>UTS</span>}
        </div>
        <button
          className="sidebar-nav-item"
          onClick={toggleCollapsed}
          title={collapsed ? "Розгорнути меню" : "Згорнути меню"}
          style={{ opacity: 0.7 }}
        >
          <span className="sidebar-nav-icon">{collapsed ? "»" : "«"}</span>
          {!collapsed && "Згорнути"}
        </button>
        <nav className="sidebar-nav">
          {navGroups.map((group) => (
            <div key={group.label} style={{ marginBottom: 8 }}>
              {!collapsed && (
                <div
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    opacity: 0.45,
                    padding: "10px 16px 4px",
                  }}
                >
                  {group.label}
                </div>
              )}
              {collapsed && <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", margin: "6px 12px" }} />}
              {group.items.map((item) => (
                <button
                  key={item.key}
                  className={`sidebar-nav-item ${item.key === active ? "active" : ""}`}
                  onClick={() => onSelect(item.key as NavKey)}
                  title={item.label}
                >
                  <span className="sidebar-nav-icon">{item.icon}</span>
                  {!collapsed && item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <button className="sidebar-logout" onClick={logout} title="Вийти">
          {collapsed ? "⎋" : "Вийти"}
        </button>
      </aside>
      <main className="main-content">
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <button
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", ctrlKey: true })
              )
            }
            title="Пошук (Ctrl+K)"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 12px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--card-bg)",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            🔍 Пошук <span style={{ opacity: 0.6 }}>Ctrl K</span>
          </button>
          <button
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title="Змінити тему"
            style={{
              padding: "6px 10px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--card-bg)",
              color: "var(--text)",
              fontSize: 15,
            }}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
        <CommandPalette onSelect={onSelect} />
        {onBack && (
          <button
            className="back-button"
            onClick={onBack}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 12,
              padding: "6px 12px",
              border: "1px solid #d0d5dd",
              borderRadius: 8,
              background: "#fff",
              cursor: "pointer",
              fontSize: 14,
              color: "#344054",
            }}
          >
            ← Назад
          </button>
        )}
        {children}
      </main>
    </div>
  );
}
