import { useNavigate } from "react-router-dom";
import { Logo } from "./Logo";

export const NAV_ITEMS = [
  { key: "overview", label: "Огляд", icon: "📊" },
  { key: "teams", label: "Команди", icon: "👥" },
  { key: "managers", label: "Менеджери", icon: "🧑‍💼" },
  { key: "loyalty", label: "Постійні клієнти", icon: "🔁" },
  { key: "receivables", label: "Дебіторська заборгованість", icon: "💰" },
  { key: "leadgen", label: "Лідогенерація", icon: "🎯" },
  { key: "tasks", label: "Задачник", icon: "📝" },
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

  function logout() {
    localStorage.removeItem("token");
    navigate("/login");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo size={28} />
          <span>UTS</span>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={`sidebar-nav-item ${item.key === active ? "active" : ""}`}
              onClick={() => onSelect(item.key)}
            >
              <span className="sidebar-nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <button className="sidebar-logout" onClick={logout}>
          Вийти
        </button>
      </aside>
      <main className="main-content">
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
