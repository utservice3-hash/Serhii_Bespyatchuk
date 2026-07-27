import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "./Logo";
import { CommandPalette } from "./CommandPalette";
import { heartbeat } from "../api";
import { usePolling } from "../hooks/usePolling";
// NAV_GROUPS drives the grouped sidebar; NAV_ITEMS (flattened) is used elsewhere.

export const NAV_GROUPS = [
  {
    label: "Аналітика",
    items: [
      { key: "overview", label: "Огляд", icon: "📊" },
      { key: "report", label: "Звіт", icon: "🧾" },
      { key: "manager-report", label: "Звіт 2.0", icon: "🧭" },
      { key: "kvp", label: "Звіт КВП", icon: "🏆", roles: ["admin"] },
      { key: "plans", label: "Плани", icon: "💵", roles: ["admin", "team_lead"] },
      { key: "statistics", label: "Статистики", icon: "📊" },
      { key: "depstats", label: "Статистики (відділи)", icon: "🗂️" },
      { key: "teams", label: "Команди", icon: "👥", roles: ["admin", "team_lead"] },
      { key: "managers", label: "Менеджери", icon: "🧑‍💼", roles: ["admin", "team_lead"] },
      { key: "reports", label: "Мої звіти", icon: "📌" },
    ],
  },
  {
    label: "Клієнти",
    items: [
      { key: "loyalty", label: "Клієнти та реактивація", icon: "🔁" },
      { key: "receivables", label: "Дебіторська заборгованість", icon: "💰" },
      { key: "bank", label: "Виписка", icon: "💳" },
      { key: "leadgen", label: "Лідогенерація", icon: "🎯" },
    ],
  },
  {
    label: "Робота",
    items: [
      { key: "tasks", label: "Задачник", icon: "📝" },
      { key: "duty", label: "Графік чергування", icon: "🗓" },
      { key: "oneonone", label: "Ван-ту-ван", icon: "🤝", roles: ["admin", "team_lead"] },
      { key: "rates", label: "Калькулятор ставок", icon: "🧮" },
      { key: "goals", label: "Місячні цілі", icon: "🎯", roles: ["admin", "team_lead"] },
      { key: "messenger", label: "Месенджер", icon: "💬" },
      { key: "news", label: "Новини", icon: "📰" },
      { key: "documents", label: "Регламенти та документи", icon: "📁" },
      { key: "training", label: "Навчання", icon: "📚" },
    ],
  },
  {
    label: "Система",
    items: [
      { key: "dataquality", label: "Якість даних", icon: "🔍", roles: ["admin", "team_lead"] },
      { key: "feedback", label: "Зворотний звʼязок", icon: "🐞" },
      { key: "aiwork", label: "Робота з АІ", icon: "🤖", roles: ["admin"] },
      { key: "settings", label: "Налаштування", icon: "⚙️", roles: ["admin"] },
    ],
  },
] as const;

type NavItem = { key: string; label: string; icon: string; roles?: readonly string[] };
export type NavKey = (typeof NAV_GROUPS)[number]["items"][number]["key"];

// Вкладки, ПРИБРАНІ з навігації (меню/таби/командна панель) за рішенням власника —
// «Огляд», «Звіт 2.0», а також «Статистики (відділи)», «Команди», «Менеджери», «Мої звіти».
// Код компонентів і ексклюзивні ендпоінти ЛИШАЮТЬСЯ в репо; прямий захід на ці роути
// редіректиться на «Звіт» (Dashboard). NAV_GROUPS свідомо НЕ чіпаємо (щоб зберегти тип
// NavKey і блоки рендера) — ховаємо тут, при вибірці.
export const HIDDEN_NAV: ReadonlySet<string> = new Set<string>([
  "overview", "manager-report", "depstats", "teams", "managers", "reports",
]);

/** Nav items visible to a given role. Якщо переданий `screens` (screen_access ефективної
 *  ролі — є в токені для всіх, включно з кастомними) — він АВТОРИТЕТНИЙ (косметика, сервер
 *  гейтить незалежно). Інакше — фолбек на built-in `roles`-гейт (старі токени без screens). */
export function navGroupsForRole(role: string | undefined, screens?: string[]) {
  const allowed = (it: NavItem) =>
    screens ? screens.includes(it.key) : (!it.roles || (role != null && it.roles.includes(role)));
  return NAV_GROUPS
    .map((g) => ({
      label: g.label,
      items: (g.items as readonly NavItem[]).filter((it) => !HIDDEN_NAV.has(it.key) && allowed(it)),
    }))
    .filter((g) => g.items.length > 0);
}

// Прибрані вкладки виключені й тут → командна панель і валідація роуту їх не бачать.
export const NAV_ITEMS: { key: NavKey; label: string; icon: string }[] = NAV_GROUPS
  .flatMap((g) => g.items as readonly { key: NavKey; label: string; icon: string }[])
  .filter((it) => !HIDDEN_NAV.has(it.key));

export function Layout({
  children,
  active,
  onSelect,
  onBack,
  role,
  screens,
  messengerUnread = 0,
}: {
  children: React.ReactNode;
  active: NavKey;
  onSelect: (key: NavKey) => void;
  onBack?: () => void;
  role?: string;
  screens?: string[];
  messengerUnread?: number;
}) {
  const navigate = useNavigate();
  const navGroups = navGroupsForRole(role, screens);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1"
  );
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") ?? "light");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Presence: ping a heartbeat so others see us as online. Пауза на фоні + джитер.
  usePolling(heartbeat, 30000, { immediate: true });

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
              {group.items.map((item) => {
                const badge = item.key === "messenger" && messengerUnread > 0 ? messengerUnread : 0;
                return (
                <button
                  key={item.key}
                  className={`sidebar-nav-item ${item.key === active ? "active" : ""}`}
                  onClick={() => onSelect(item.key as NavKey)}
                  title={badge ? `${item.label} — ${badge} непрочитаних` : item.label}
                  style={{ position: "relative" }}
                >
                  <span className="sidebar-nav-icon">{item.icon}</span>
                  {!collapsed && item.label}
                  {badge > 0 && (
                    <span
                      style={{
                        position: collapsed ? "absolute" : "static",
                        top: collapsed ? 4 : undefined,
                        right: collapsed ? 8 : undefined,
                        marginLeft: collapsed ? 0 : "auto",
                        minWidth: 18,
                        height: 18,
                        padding: "0 5px",
                        borderRadius: 9,
                        background: "#c8102e",
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 700,
                        lineHeight: "18px",
                        textAlign: "center",
                      }}
                    >
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </button>
                );
              })}
            </div>
          ))}
        </nav>
        {/* 🔒 «Вийти» — дія АКАУНТА, не «екран». НАВМИСНО поза <nav>/NAV_GROUPS і поза
            фільтром screens[] — рендериться ЗАВЖДИ, для будь-якої ролі (вбудованої чи
            кастомної), незалежно від screen_access/permissions. НЕ переносити в NAV_GROUP. */}
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
