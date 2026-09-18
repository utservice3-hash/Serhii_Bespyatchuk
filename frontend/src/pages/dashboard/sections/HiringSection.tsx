import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fetchHiringMeta, fetchSecretsStatus, hiringError, type HiringMeta } from "../../../api";
import { LS } from "../hiringView";
import type { Toast } from "./HiringShared";
import { HiringSchedule } from "./HiringSchedule";
import { HiringCandidates } from "./HiringCandidates";
import { HiringDaily } from "./HiringDaily";
import { HiringVacancies } from "./HiringVacancies";
import { HiringTraining } from "./HiringTraining";
import { HiringSecrets } from "./HiringSecrets";
import { HiringEmployees } from "./HiringEmployees";
import { PlannedTabCard, LiveTabNote, type PlannedTab } from "./HiringRoadmap";
import "./hiring.css";

/**
 * 🧑‍💼 «НАЙМ», прохід 1 (17.09.2026) — замість вкладок Google-таблиці «UTS Співробітники УКР»:
 * «Графік Іван» → Графік, «Кандидати UA» → Кандидати, «Щоденний звіт NEW» → Щоденний звіт.
 * Макет затвердив Іван (рекрутер). Доступ вирішує сервер (`access` у /meta):
 *  • edit — рекрутер (HR) і адмін-рівень: усі три вкладки;
 *  • lead — тімлід: лише «Кандидати» своєї команди після співбесіди з ним.
 */
type Tab = "sched" | "base" | "vac" | "train" | "daily" | "acc" | PlannedTab;

export function HiringSection() {
  const [meta, setMeta] = useState<HiringMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (LS.get("tab") as Tab) || "sched");
  const [toastState, setToastState] = useState<{ text: string; error?: boolean; action?: { label: string; run: () => void }; key: number } | null>(null);
  const [nonce, setNonce] = useState(0);
  // Клік по числу кандидатів вакансії відкриває «Кандидатів» із фільтром (прохід 1a).
  const [vacFilter, setVacFilter] = useState<{ id: number; seq: number } | null>(null);

  const reloadMeta = useCallback(() => {
    fetchHiringMeta().then(setMeta).catch((e) => setErr(hiringError(e)));
  }, []);
  useEffect(reloadMeta, [reloadMeta, nonce]);
  // 🔐 «Доступи» бачить лише той, кому сервер відповідає (право `view_employee_secrets`). Не з токена:
  // право могли видати після входу, а сервер однаково гейтить кожен запит.
  const [canSecrets, setCanSecrets] = useState(false);
  useEffect(() => { fetchSecretsStatus().then(() => setCanSecrets(true)).catch(() => setCanSecrets(false)); }, []);

  const toast: Toast = useCallback((text, opts) => {
    const key = Date.now();
    setToastState({ text, ...opts, key });
    window.setTimeout(() => setToastState((t) => (t && t.key === key ? null : t)), opts?.action ? 8000 : 4000);
  }, []);

  if (err) return <div className="chart-card"><b>Розділ «Найм» недоступний.</b> <span className="hr-muted">{err}</span></div>;
  if (!meta) return <p className="loading-text">Завантаження…</p>;
  if (meta.access === "none") return <div className="chart-card"><b>Розділ «Найм» недоступний для вашої ролі.</b></div>;

  // Усі сім вкладок затвердженого макета. Незроблені відкривають пояснення «що буде і чому ще немає»
  // (прохання Романа 17.09): людина бачить повну картину, а не гадає, чи вкладку забули.
  const tabs: [Tab, string][] = meta.access === "edit"
    ? [["sched", "Графік"], ["base", "Кандидати"], ["vac", "Вакансії"], ["train", "На навчанні"], ["daily", "Щоденний звіт"], ["emp", "Співробітники"], ["churn", "Плинність"], ["exit", "Exit-інтервʼю"], ["sum", "Зведення"]]
    : [["base", "Кандидати"], ["train", "На навчанні"], ["emp", "Співробітники"]];
  if (canSecrets) tabs.splice(tabs.findIndex(([k]) => k === "emp"), 0, ["acc", "Доступи"]);
  // «Співробітники» живі для тих, хто має право сейфу (імпорт кладе паролі туди); решті — пояснення.
  const planned = new Set<Tab>(canSecrets ? ["churn", "exit", "sum"] : ["emp", "churn", "exit", "sum"]);
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
        {tabs.map(([k, l]) => (
          <button key={k} className={active === k ? "on" : ""} onClick={() => pick(k)} title={planned.has(k) ? "Ще не зроблено — усередині пояснення чому" : undefined}>
            {l}{planned.has(k) && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.75 }}>скоро</span>}
          </button>
        ))}
      </div>
      {(active === "sched" || active === "base" || active === "vac" || active === "train" || active === "daily") && <LiveTabNote tab={active} />}
      {planned.has(active) && <PlannedTabCard tab={active as PlannedTab} />}
      {active === "sched" && <HiringSchedule meta={meta} toast={toast} onMetaStale={() => setNonce((n) => n + 1)} />}
      {active === "base" && <HiringCandidates key={vacFilter?.seq ?? 0} meta={meta} toast={toast} initialVacancyId={vacFilter?.id ?? null} onMetaStale={() => setNonce((n) => n + 1)} />}
      {active === "vac" && <HiringVacancies meta={meta} toast={toast} onChanged={() => setNonce((n) => n + 1)}
        onOpenCandidates={(id) => { setVacFilter({ id, seq: Date.now() }); pick("base"); }} />}
      {active === "acc" && <HiringSecrets toast={toast} />}
      {active === "emp" && canSecrets && <HiringEmployees toast={toast} />}
      {active === "train" && <HiringTraining meta={meta} toast={toast} onChanged={() => setNonce((n) => n + 1)} />}
      {active === "daily" && <HiringDaily toast={toast} />}
      {toastState && createPortal(
        <div className={`hr-toast ${toastState.error ? "err" : ""}`} role="status">
          <span>{toastState.text}</span>
          {toastState.action && <button onClick={() => { toastState.action!.run(); setToastState(null); }}>{toastState.action.label}</button>}
        </div>, document.body)}
    </div>
  );
}
