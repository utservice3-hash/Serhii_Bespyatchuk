import { useNavigate } from "react-router-dom";
import { Logo } from "./Logo";

const NAV_ITEMS = [
  { key: "overview", label: "Огляд", icon: "📊" },
  { key: "teams", label: "Команди", icon: "👥" },
  { key: "managers", label: "Менеджери", icon: "🧑‍💼" },
];

export function Layout({ children }: { children: React.ReactNode }) {
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
          {NAV_ITEMS.map((item, i) => (
            <button key={item.key} className={`sidebar-nav-item ${i === 0 ? "active" : ""}`}>
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
