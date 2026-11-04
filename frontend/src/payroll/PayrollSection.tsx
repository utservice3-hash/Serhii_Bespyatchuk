/**
 * 💰 Розділ «Зарплата» (пакет Сергія 03.11.2026, ТЗ §7.1). Вкладки — за правами людини (ТЗ §2), які сервер віддає разом
 * із кабінетом (`/payroll/me → perms`), а не з JWT: у токені права старі до перелогіну. Межу тримає сервер — тут лише
 * які кнопки показати. Кабінет «Моя зарплата» — вкладка для кожного, хто є в зарплаті (ТЗ §14 ❓ — рішення за замовчуванням).
 * Один чанк (#225): жодних lazy/import().
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { payrollApi, type Obj } from "./api";
import { Loading, Tabs, monthTitle, useLoad, Pill } from "./ui";
import Cabinet from "./cabinet/Cabinet";
import VerifyTab from "./finance/VerifyTab";
import AccrualsTab from "./finance/AccrualsTab";
import AdvancesTab from "./finance/AdvancesTab";
import StatementTab from "./finance/StatementTab";
import ForecastTab from "./system/ForecastTab";
import AnalyticsTab from "./system/AnalyticsTab";
import ClearancesTab from "./system/ClearancesTab";
import ArchiveTab from "./system/ArchiveTab";
import SettingsTab from "./system/SettingsTab";
import OfferTasksTab from "./system/OfferTasksTab";
import "./payroll.css";

export type TabKey = "verify" | "accruals" | "advances" | "statement" | "forecast" | "analytics" | "clearances" | "archive" | "settings" | "tasks" | "cabinet";

/** Спільне для всіх вкладок: хто дивиться і які місяці зараз. */
export interface PayrollCtx {
  me: Obj;
  perms: Set<string>;
  /** Місяць, що йде («орієнтовно»). */
  liveMonth: string;
  /** Закритий місяць, що перевіряється / виплачується (null — немає). */
  closedMonth: string | null;
  reloadMe: () => Promise<void>;
  /** Перейти на вкладку (з посилань сповіщень, «→ Відомість» тощо). */
  go: (tab: TabKey, extra?: Obj) => void;
  /** Що передали при переході (напр. `{ userId }` — відкрити вікно працівника). */
  goExtra: Obj | null;
}

const LABELS: Record<TabKey, string> = {
  verify: "Перевірка", accruals: "Нарахування", advances: "Аванси", statement: "Відомість", forecast: "Прогноз", analytics: "Аналітика",
  clearances: "Обхідні листи", archive: "Архів", settings: "Налаштування", tasks: "Задачі", cabinet: "Мій кабінет",
};

/** Куди відкрити за адресою (посилання зі сповіщень): `?tab=verify&user=12`, `?tab=cabinet&cab=pay&focus=adv`. */
function fromSearch(search: string): { tab: TabKey | null; extra: Obj | null } {
  const q = new URLSearchParams(search);
  const t = q.get("tab");
  const extra: Obj = {};
  if (q.get("user")) extra.userId = q.get("user");
  if (q.get("cab")) extra.cab = q.get("cab");
  if (q.get("focus")) extra.focus = q.get("focus");
  return { tab: t && t in LABELS ? (t as TabKey) : null, extra: Object.keys(extra).length ? extra : null };
}

export default function PayrollSection() {
  const { data: me, err, reload } = useLoad(() => payrollApi.me(), []);
  const { data: clrList } = useLoad(() => payrollApi.clearances().catch(() => []), []);
  const perms = useMemo(() => new Set<string>((me?.perms as string[] | undefined) ?? []), [me]);
  const can = (p: string) => perms.has(p);
  const tabs = useMemo(() => {
    if (!me) return [] as TabKey[];
    const t: TabKey[] = [];
    if (can("payroll_view_all")) t.push("verify", "accruals", "advances", "statement", "forecast", "analytics");
    // обхідні: фінанси й керівництво, бухгалтерія / БА — усі листи; відповідальні (тім-лід, HR) — коли є що підписати
    if (can("payroll_view_all") || can("payroll_clearance") || (clrList?.length ?? 0) > 0) t.push("clearances");
    if (can("payroll_view_all")) t.push("archive");
    if (can("payroll_settings") || can("payroll_view_all") || can("notify_rules")) t.push("settings");
    if (can("payroll_offer_tasks") || can("payroll_final_word")) t.push("tasks");
    if (me.enrolled) t.push("cabinet");
    return t;
  }, [me, perms, clrList]); // eslint-disable-line react-hooks/exhaustive-deps

  const location = useLocation();
  const [tab, setTab] = useState<TabKey | null>(() => fromSearch(location.search).tab);
  const [goExtra, setGoExtra] = useState<Obj | null>(() => fromSearch(location.search).extra);
  // дзвіночок веде сюди ж іншою адресою, поки розділ відкритий — підхоплюємо
  useEffect(() => {
    const f = fromSearch(location.search);
    if (f.extra) { setGoExtra(f.extra); if (f.tab) setTab(f.tab); }
  }, [location.search]);
  useEffect(() => {
    if (!tabs.length) return;
    if (!tab || !tabs.includes(tab)) setTab(tabs.includes("cabinet") && !can("payroll_view_all") ? "cabinet" : tabs[0]);
  }, [tabs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!tab) return;
    const u = new URL(window.location.href);
    if (u.searchParams.get("tab") === tab && !u.searchParams.get("user") && !u.searchParams.get("cab")) return;
    u.searchParams.set("tab", tab); ["user", "cab", "focus"].forEach((k) => u.searchParams.delete(k));
    window.history.replaceState(window.history.state, "", u.toString());
  }, [tab]);

  if (!me) return <div className="zp"><Loading err={err} onRetry={reload} /></div>;

  const ctx: PayrollCtx = {
    me, perms, liveMonth: me.liveMonth, closedMonth: me.closedMonth ?? null,
    reloadMe: reload, go: (t, extra) => { setGoExtra(extra ?? null); setTab(t); }, goExtra,
  };

  // людина не в зарплаті й без прав — пояснюємо словами, а не порожнім екраном
  if (!tabs.length) {
    return (
      <div className="zp">
        <div className="zp-head"><h1>Зарплата</h1></div>
        <div className="zp-empty">Вас ще немає в зарплаті. Кабінет «Моя зарплата» зʼявиться, щойно фінансист внесе ваші умови.</div>
      </div>
    );
  }

  const active = tab && tabs.includes(tab) ? tab : tabs[0];
  return (
    <div className="zp">
      <div className="zp-head">
        <div>
          <h1>{active === "cabinet" ? "Моя зарплата" : "Зарплата"}</h1>
          {active === "cabinet" && me.employee && <div className="zp-head__sub">{[me.employee.name, me.employee.title, me.employee.teamName].filter(Boolean).join(" · ")}</div>}
        </div>
        <div className="zp-row">
          {ctx.closedMonth && can("payroll_view_all") && <span className="zp-month">{monthTitle(ctx.closedMonth)} <Pill tone="warn">закрито · перевірка</Pill></span>}
          <span className="zp-month">{monthTitle(ctx.liveMonth)} <Pill tone="warn">іде · орієнтовно</Pill></span>
        </div>
      </div>
      {tabs.length > 1 && <Tabs items={tabs.map((k) => ({ key: k, label: LABELS[k] }))} value={active} onChange={(k) => { setGoExtra(null); setTab(k); }} />}
      {active === "cabinet" && <Cabinet ctx={ctx} />}
      {active === "verify" && <VerifyTab ctx={ctx} />}
      {active === "accruals" && <AccrualsTab ctx={ctx} />}
      {active === "advances" && <AdvancesTab ctx={ctx} />}
      {active === "statement" && <StatementTab ctx={ctx} />}
      {active === "forecast" && <ForecastTab ctx={ctx} />}
      {active === "analytics" && <AnalyticsTab ctx={ctx} />}
      {active === "clearances" && <ClearancesTab ctx={ctx} />}
      {active === "archive" && <ArchiveTab ctx={ctx} />}
      {active === "settings" && <SettingsTab ctx={ctx} />}
      {active === "tasks" && <OfferTasksTab ctx={ctx} />}
    </div>
  );
}
