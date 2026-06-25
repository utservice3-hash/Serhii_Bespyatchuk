import { useNavigate } from "react-router-dom";
import { Logo } from "./Logo";

export const NAV_ITEMS = [
  { key: "overview", label: "Огляд", icon: "📊" },
  { key: "teams", label: "Команди", icon: "👥" },
  { key: "managers", label: "Менеджери", icon: "🧑‍💼" },
  { key: "loyalty", label: "Постійні клієнти", icon: "🔁" },
  { key: "tasks", label: "Задачник", icon: "📝" },
] as const;

export type NavKey = (typeof NAV_ITEMS)[number]["key"];

export function Layout({
  children,
  active,
  onSelect,
}: {
  children: React.ReactNode;
  active: NavKey;
  onSelect: (key: NavKey) => void;
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
      <main className="main-content">{children}</main>
    </div>
  );
}
