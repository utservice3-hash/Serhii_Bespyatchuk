import { useEffect, useState } from "react";
import { HealthBanner } from "./HealthBanner";
import { useNavigate } from "react-router-dom";
import { Logo } from "./Logo";
import { NavIcon } from "./NavIcon";
import { CommandPalette } from "./CommandPalette";
import { heartbeat, trackerSsoUrl } from "../api";
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
      // 🎯 САМОСТІЙНИЙ ЕКРАН на реєстрі бота (рішення власника 04.08.2026).
      // Менеджеру НЕ показуємо: екран про розподіл заявок МІЖ менеджерами,
      // тобто дані колег, а не власна робота. Сервер це теж гейтить (403) —
      // тут лише щоб пункт не світився кнопкою в нікуди.
      { key: "leadgen", label: "Лідогенерація", icon: "🎯", roles: ["admin", "team_lead"] },
    ],
  },
  {
    label: "Робота",
    items: [
      { key: "tasks", label: "Задачник", icon: "📝" },
      { key: "duty", label: "Календар команди", icon: "🗓" },
      { key: "bank", label: "Виписка", icon: "💳" },
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

/**
 * Пункт «Time tracker» — НЕ у NAV_GROUPS, і це не недогляд.
 *
 * `navGroupsForRole` при наявному `screens` віддає лише те, що є в `screen_access` ролі, а
 * `screens` кладеться в токен для КОЖНОЇ ролі. Ключа `tracker` немає в жодному screen_access,
 * тож пункт у NAV_GROUPS не побачив би НІХТО — протилежність тому, що потрібно («видно всім»).
 * Щоб зробити його видимим, довелося б міграцією дописати ключ у кожен рядок таблиці ролей.
 *
 * Плюс NAV_GROUPS живить ще три речі, яким цей ключ зашкодив би: NAV_ITEMS (Ctrl+K і валідація
 * адреси в Dashboard.tsx — ключ без екрана дав би порожню сторінку) і SCREEN_TABS у редакторі
 * ролей (перетворив би пункт на рольовий перемикач, тобто знову на гейт).
 *
 * Взірець — кнопка «Вийти» нижче: теж поза NAV_GROUPS і поза фільтром. Різниця лише в тому, що
 * цей пункт має стояти ВСЕРЕДИНІ групи «Аналітика» — це аналітика по часу.
 */
export const TRACKER_KEY = "tracker";
const TRACKER_GROUP = "Аналітика";

/**
 * Вставити пункт у «Аналітику», створивши групу, якщо фільтр її вичистив.
 *
 * Створення потрібне саме тому, що групи без пунктів відкидаються: кастомна роль, якій не
 * відкрито жодного аналітичного екрана, інакше втратила б і кнопку — хоча свій власний день у
 * трекері їй бачити можна.
 */
function withTracker(groups: { label: string; items: NavItem[] }[]) {
  const item: NavItem = { key: TRACKER_KEY, label: "Time tracker", icon: "" };
  const found = groups.find((g) => g.label === TRACKER_GROUP);
  if (found) {
    return groups.map((g) => (g === found ? { ...g, items: [...g.items, item] } : g));
  }
  return [{ label: TRACKER_GROUP, items: [item] }, ...groups];
}

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
  const navGroups = withTracker(navGroupsForRole(role, screens));
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1"
  );
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") ?? "light");
  const [trackerBusy, setTrackerBusy] = useState(false);
  const [trackerError, setTrackerError] = useState<string | null>(null);

  /**
   * Відкрити трекер уже залогіненим.
   *
   * 🔴 Вкладка відкривається СИНХРОННО, до `await`. Це не стиль, а єдиний спосіб, щоб кнопка
   * працювала: `window.open` після очікування вже поза жестом користувача, і Safari з Chrome
   * ріжуть його як спливне вікно. Помилка була б тихою — у розробника з вимкненим блокувальником
   * усе працює.
   *
   * Через це не можна передати `noopener` рядком опцій (він позбавляє нас посилання на вкладку),
   * тому `opener` знімаємо руками — щоб сторінка трекера не мала доступу до вікна дашборду.
   */
  async function openTracker() {
    if (trackerBusy) return;
    setTrackerBusy(true);
    setTrackerError(null);
    const tab = window.open("", "_blank");
    try {
      const { url } = await trackerSsoUrl();
      if (tab) {
        tab.opener = null;
        tab.location.replace(url);
      } else {
        // Блокувальник не дав відкрити вкладку взагалі — тоді краще піти в поточній, ніж мовчки
        // нічого не зробити.
        window.location.href = url;
      }
    } catch (e) {
      tab?.close();
      setTrackerError(e instanceof Error ? e.message : "Не вдалося відкрити трекер часу.");
    } finally {
      setTrackerBusy(false);
    }
  }

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
          <Logo size={collapsed ? 20 : 26} variant="white" />
          {/* Поруч із плашкою — не повтор «UTS», а що це за застосунок (макет). */}
          {!collapsed && <span className="sidebar-brand-sub">дашборд</span>}
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
                // Зовнішній перехід, а не вкладка застосунку: onSelect тут не годиться, а адреса
                // невідома, доки не відповість сервер, — тому кнопка, а не <a href>.
                if (item.key === TRACKER_KEY) {
                  return (
                    <button
                      key={item.key}
                      className="sidebar-nav-item"
                      onClick={openTracker}
                      disabled={trackerBusy}
                      title="Трекер часу — відкриється вже під вашим акаунтом"
                    >
                      <span className="sidebar-nav-icon"><NavIcon k={TRACKER_KEY} /></span>
                      {!collapsed && (trackerBusy ? "Відкриваємо…" : item.label)}
                    </button>
                  );
                }
                const badge = item.key === "messenger" && messengerUnread > 0 ? messengerUnread : 0;
                return (
                <button
                  key={item.key}
                  className={`sidebar-nav-item ${item.key === active ? "active" : ""}`}
                  onClick={() => onSelect(item.key as NavKey)}
                  title={badge ? `${item.label} — ${badge} непрочитаних` : item.label}
                  style={{ position: "relative" }}
                >
                  <span className="sidebar-nav-icon"><NavIcon k={item.key} /></span>
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
        {trackerError && !collapsed && (
          <div role="status" style={{ padding: "0 16px 8px", fontSize: 11, lineHeight: 1.4, opacity: 0.85 }}>
            {trackerError}
          </div>
        )}
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
            <NavIcon k="dataquality" size={15} /> Пошук <span style={{ opacity: 0.6 }}>Ctrl K</span>
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
            {/* Сонце/місяць лінією — той самий принцип «нуль емодзі», що й у меню:
                емодзі тут ще й міняло ширину кнопки при перемиканні теми. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {theme === "dark"
                ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>
                : <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />}
            </svg>
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
        {/* 🚨 Банер тривог — лише керівництву (scope-compat "admin" = admin/ceo/opdir/kvp).
            Гейт потрібен і тут, і на бекенді: без фронтового менеджер отримав би 403
            і побачив банер «сигналізація недоступна» — шум замість сигналу. */}
        {role === "admin" && <HealthBanner />}
        {children}
      </main>
    </div>
  );
}
