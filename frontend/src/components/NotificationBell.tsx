/**
 * 🔔 Центр сповіщень у шапці (ТЗ «Зарплата» §6) — спільний для всього дашборда; «Зарплата» — перший модуль, що в нього пише.
 * Фільтри «Усі / Потрібна дія / Непрочитані»; групи «Сьогодні / Учора / Цього тижня / Раніше»; «потрібна ваша дія · чекає N днів»
 * (з 2 днів), після виконання — «виконано 03.12». Кнопка веде на місце дії (`link` = `go` рушія). Лише свої — сервер.
 * Число на дзвіночку — «потрібна дія» (не закрита), інакше — непрочитані.
 */
import { useEffect, useRef, useState } from "react";
import { notificationsApi, type NotificationT } from "../payroll/api";
import { usePolling } from "../hooks/usePolling";
import { useToast } from "./Toasts";
import "../payroll/payroll.css";

type Filter = "all" | "act" | "unread";
const FILTERS: Array<[Filter, string]> = [["all", "Усі"], ["act", "Потрібна дія"], ["unread", "Непрочитані"]];

const kyivDay = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
function groupOf(iso: string): string {
  const d = new Date(iso), now = new Date();
  const day = kyivDay(d), today = kyivDay(now), yest = kyivDay(new Date(now.getTime() - 864e5));
  if (day === today) return "Сьогодні";
  if (day === yest) return "Учора";
  if (now.getTime() - d.getTime() < 7 * 864e5) return "Цього тижня";
  return "Раніше";
}
const hm = (iso: string) => new Date(iso).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
const ddmm = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit" });
const days = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "дні" : "днів"}`;

/** `go` рушія → розділ дашборда + адреса. Вкладки «Зарплати»: ver/acc/adv/stmt/clr/tasks/cab. */
const ZP_TABS: Record<string, string> = { ver: "verify", acc: "accruals", adv: "advances", stmt: "statement", clr: "clearances", tasks: "tasks", cab: "cabinet" };
export function linkTarget(n: Pick<NotificationT, "module" | "link">): { section: string; query: string } | { toast: string } | null {
  const go = n.link as Record<string, unknown> | null;
  if (!go) return null;
  if (typeof go.toast === "string") return { toast: go.toast };
  // 🧭 Загальна адреса «розділ + запит» (перший — «Клієнти» → «Нічийні», задача 8135); вкладки «Зарплати» — нижче.
  if (typeof go.section === "string") return { section: go.section, query: typeof go.query === "string" ? go.query : "" };
  const tab = ZP_TABS[String(go.tab)];
  if (!tab) return null;
  const q = new URLSearchParams({ tab });
  if (go.ver) q.set("user", String(go.ver));
  if (typeof go.focus === "string") { const m = /^#clr-(\d+)$/.exec(go.focus); if (m) q.set("user", m[1]); }
  const mz = go.mz as Record<string, unknown> | undefined;
  if (mz?.tab) q.set("cab", String(mz.tab));
  if (typeof mz?.focus === "string") q.set("focus", String(mz.focus).replace(/^#/, ""));
  return { section: "payroll", query: `?${q.toString()}` };
}

export function NotificationBell({ onGo }: { onGo: (section: string, query?: string) => void }) {
  const [badge, setBadge] = useState({ unread: 0, needAction: 0 });
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<NotificationT[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const loadBadge = () => { notificationsApi.badge().then(setBadge).catch(() => undefined); };
  usePolling(loadBadge, 60_000, { immediate: true });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setItems(null); setErr(null);
    notificationsApi.list(filter).then((x) => { if (alive) setItems(x); }).catch(() => { if (alive) setErr("Не вдалося завантажити сповіщення."); });
    return () => { alive = false; };
  }, [open, filter]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (panel.current && !panel.current.contains(e.target as Node) && !(e.target as HTMLElement).closest(".nc-bell")) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  async function markRead(ids: number[] | "all") {
    try {
      await notificationsApi.read(ids);
      const now = new Date().toISOString();
      setItems((xs) => xs?.map((x) => (ids === "all" || ids.includes(x.id) ? { ...x, readAt: x.readAt ?? now } : x)) ?? null);
      loadBadge();
    } catch { toast("Не вдалося позначити прочитаним.", { error: true }); }
  }
  function follow(n: NotificationT) {
    if (!n.readAt) void markRead([n.id]);
    const t = linkTarget(n);
    if (!t) return;
    if ("toast" in t) { toast(t.toast); return; }
    setOpen(false);
    onGo(t.section, t.query);
  }

  const count = badge.needAction || badge.unread;
  const groups: Array<[string, NotificationT[]]> = [];
  for (const n of items ?? []) {
    const g = groupOf(n.createdAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(n); else groups.push([g, [n]]);
  }

  return (
    <>
      <button className="nc-bell" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={badge.needAction ? `Сповіщення — потрібна ваша дія: ${badge.needAction}` : badge.unread ? `Сповіщення — непрочитаних: ${badge.unread}` : "Сповіщення"}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 && <span className="nc-bell__badge">{count > 99 ? "99+" : count}</span>}
      </button>
      {open && (
        <div className="nc-panel" ref={panel} role="dialog" aria-label="Сповіщення">
          <div className="nc-panel__head">
            <h3>Сповіщення</h3>
            {badge.unread > 0 && <button className="zp-btn zp-btn--ghost zp-btn--sm" onClick={() => void markRead("all")}>Прочитати всі</button>}
          </div>
          <div className="nc-panel__filters">
            {FILTERS.map(([k, l]) => (
              <button key={k} className={`zp-tab ${filter === k ? "is-active" : ""}`} style={{ padding: "4px 10px", fontSize: 13, borderRadius: 8 }} onClick={() => setFilter(k)}>
                {l}{k === "act" && badge.needAction ? ` · ${badge.needAction}` : k === "unread" && badge.unread ? ` · ${badge.unread}` : ""}
              </button>
            ))}
          </div>
          <div className="nc-list">
            {err && <div className="zp-error" style={{ margin: 12 }}>{err}</div>}
            {!err && !items && <div className="zp-loading">Завантаження…</div>}
            {items && !items.length && (
              <div className="zp-empty" style={{ margin: 12 }}>
                {filter === "act" ? "Нічого не чекає вашої дії." : filter === "unread" ? "Усе прочитано." : "Сповіщень ще немає."}
              </div>
            )}
            {groups.map(([g, list]) => (
              <div key={g}>
                <div className="nc-group">{g}</div>
                {list.map((n) => {
                  const t = linkTarget(n);
                  return (
                    <div key={n.id} className={`nc-item ${n.readAt ? "" : "is-unread"}`} onClick={() => { if (!n.readAt) void markRead([n.id]); }}>
                      <div className="nc-item__top"><span>{n.module}</span><span>{g === "Сьогодні" || g === "Учора" ? hm(n.createdAt) : ddmm(n.createdAt)}</span></div>
                      <div className="nc-item__title">{n.title}</div>
                      <div className="nc-item__text">{n.text}</div>
                      <div className="nc-item__foot">
                        {n.act && !n.doneAt && <span className="nc-act">потрібна ваша дія{n.waitingDays >= 2 ? ` · чекає ${days(n.waitingDays)}` : ""}</span>}
                        {n.act && n.doneAt && <span className="nc-act nc-act--done">виконано {ddmm(n.doneAt)}</span>}
                        {t && (
                          <button className={`zp-btn zp-btn--sm ${n.act && !n.doneAt ? "zp-btn--dark" : ""}`} onClick={(e) => { e.stopPropagation(); follow(n); }}>
                            {n.cta ?? "Відкрити"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
