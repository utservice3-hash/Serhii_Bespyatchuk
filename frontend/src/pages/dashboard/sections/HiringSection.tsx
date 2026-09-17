import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fetchHiringMeta, hiringError, type HiringMeta } from "../../../api";
import { LS } from "../hiringView";
import type { Toast } from "./HiringShared";
import { HiringSchedule } from "./HiringSchedule";
import { HiringCandidates } from "./HiringCandidates";
import { HiringDaily } from "./HiringDaily";
import "./hiring.css";

/**
 * 🧑‍💼 «НАЙМ», прохід 1 (17.09.2026) — замість вкладок Google-таблиці «UTS Співробітники УКР»:
 * «Графік Іван» → Графік, «Кандидати UA» → Кандидати, «Щоденний звіт NEW» → Щоденний звіт.
 * Макет затвердив Іван (рекрутер). Доступ вирішує сервер (`access` у /meta):
 *  • edit — рекрутер (HR) і адмін-рівень: усі три вкладки;
 *  • lead — тімлід: лише «Кандидати» своєї команди після співбесіди з ним.
 */
type Tab = "sched" | "base" | "daily";

export function HiringSection() {
  const [meta, setMeta] = useState<HiringMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (LS.get("tab") as Tab) || "sched");
  const [toastState, setToastState] = useState<{ text: string; error?: boolean; action?: { label: string; run: () => void }; key: number } | null>(null);
  const [nonce, setNonce] = useState(0);

  const reloadMeta = useCallback(() => {
    fetchHiringMeta().then(setMeta).catch((e) => setErr(hiringError(e)));
  }, []);
  useEffect(reloadMeta, [reloadMeta, nonce]);

  const toast: Toast = useCallback((text, opts) => {
    const key = Date.now();
    setToastState({ text, ...opts, key });
    window.setTimeout(() => setToastState((t) => (t && t.key === key ? null : t)), opts?.action ? 8000 : 4000);
  }, []);

  if (err) return <div className="chart-card"><b>Розділ «Найм» недоступний.</b> <span className="hr-muted">{err}</span></div>;
  if (!meta) return <p className="loading-text">Завантаження…</p>;
  if (meta.access === "none") return <div className="chart-card"><b>Розділ «Найм» недоступний для вашої ролі.</b></div>;

  const tabs: [Tab, string][] = meta.access === "edit"
    ? [["sched", "Графік"], ["base", "Кандидати"], ["daily", "Щоденний звіт"]]
    : [["base", "Кандидати"]];
  const active = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  const pick = (t: Tab) => { setTab(t); LS.set("tab", t); };

  return (
    <div>
      <h1 className="page-title" style={{ marginBottom: 4 }}>Найм</h1>
      <p className="hr-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        {meta.access === "edit"
          ? "Графік відкривається на сьогодні; клітинки редагуються на місці. Стрілки й смуга тижня ведуть на інші дні."
          : "Кандидати вашої команди після співбесіди з вами: прогрес і рішення «кандидат», «на навчанні», «менеджер»."}
      </p>
      <div className="hr-tabs">
        {tabs.map(([k, l]) => <button key={k} className={active === k ? "on" : ""} onClick={() => pick(k)}>{l}</button>)}
      </div>
      {active === "sched" && <HiringSchedule meta={meta} toast={toast} onMetaStale={() => setNonce((n) => n + 1)} />}
      {active === "base" && <HiringCandidates meta={meta} toast={toast} />}
      {active === "daily" && <HiringDaily toast={toast} />}
      {toastState && createPortal(
        <div className={`hr-toast ${toastState.error ? "err" : ""}`} role="status">
          <span>{toastState.text}</span>
          {toastState.action && <button onClick={() => { toastState.action!.run(); setToastState(null); }}>{toastState.action.label}</button>}
        </div>, document.body)}
    </div>
  );
}
