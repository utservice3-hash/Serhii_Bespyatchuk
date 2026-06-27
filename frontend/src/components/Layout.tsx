import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "./Logo";
import { CommandPalette } from "./CommandPalette";

export const NAV_ITEMS = [
  { key: "overview", label: "Огляд", icon: "📊" },
  { key: "statistics", label: "Статистика", icon: "📈" },
  { key: "teams", label: "Команди", icon: "👥" },
  { key: "managers", label: "Менеджери", icon: "🧑‍💼" },
  { key: "loyalty", label: "Постійні клієнти", icon: "🔁" },
  { key: "receivables", label: "Дебіторська заборгованість", icon: "💰" },
  { key: "leadgen", label: "Лідогенерація", icon: "🎯" },
  { key: "tasks", label: "Задачник", icon: "📝" },
  { key: "settings", label: "Налаштування", icon: "⚙️" },
] as const;

export type NavKey = (typeof NAV_ITEMS)[number]["key"];

export function Layout({
  children,
  active,
  onSelect,
  onBack,
}: {
  children: React.ReactNode;
  active: NavKey;
  onSelect: (key: NavKey) => void;
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1"
  );
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") ?? "light");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

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
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={`sidebar-nav-item ${item.key === active ? "active" : ""}`}
              onClick={() => onSelect(item.key)}
              title={item.label}
            >
              <span className="sidebar-nav-icon">{item.icon}</span>
              {!collapsed && item.label}
            </button>
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
